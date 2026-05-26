const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

/* =========================================================
 * APP MODE: Builder vs Viewer
 * =========================================================
 *
 * Two separate Windows .exe builds share this codebase:
 *
 *   - Builder (.exe) — the creator's tool. Edits project-config.json and
 *     copies assets into dist-assets/. Exports the whole project as a
 *     single .lbpro file (ZIP) that the creator emails / uploads to clients.
 *
 *   - Viewer  (.exe) — a universal player. Ships empty. On first launch it
 *     asks the user to pick a .lbpro file, extracts it into userData, then
 *     plays the course. Same .exe can be re-used for any course.
 *
 * Mode is decided by `app-mode.json`, injected as an extraResource by each
 * build config (build-configs/builder.json vs build-configs/viewer.json).
 * In dev we default to Builder; set LAUNCHBOX_MODE=viewer to test the
 * Viewer welcome flow in dev.
 */
function detectMode() {
  if (app.isPackaged) {
    const flagPath = path.join(process.resourcesPath, 'app-mode.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(flagPath, 'utf-8'));
      return parsed && parsed.mode === 'viewer' ? 'viewer' : 'builder';
    } catch (err) {
      return 'builder';
    }
  }
  return process.env.LAUNCHBOX_MODE === 'viewer' ? 'viewer' : 'builder';
}

const APP_MODE = detectMode();
const isViewer = APP_MODE === 'viewer';

// Give each mode its own userData directory so the Builder and the Viewer
// installed side-by-side never share/overwrite each other's state. MUST be
// called before any app.getPath('userData') access.
app.setName(isViewer ? 'LaunchBox Viewer' : 'LaunchBox Builder');

/* =========================================================
 * PATHS — always writable.
 *
 * Packaged: app.getPath('userData') (per-mode, see app.setName above) —
 *           e.g. %AppData%\LaunchBox Builder vs %AppData%\LaunchBox Viewer.
 * Dev:      next to main.js, as before.
 *
 * The Viewer extracts a .lbpro into WRITE_BASE; the Builder edits and packs
 * from WRITE_BASE. No more read-only resource paths involved — the EPERM
 * class of bug from earlier is gone for both modes.
 * ========================================================= */
const PROJECT_ROOT = __dirname;
const WRITE_BASE = app.isPackaged ? app.getPath('userData') : PROJECT_ROOT;

const DATA_DIR = path.join(WRITE_BASE, 'data');
const ASSETS_DIR = path.join(WRITE_BASE, 'dist-assets');
const CONFIG_PATH = path.join(DATA_DIR, 'project-config.json');
const ICON_DEST_PATH = path.join(DATA_DIR, 'icon.ico');

const FILE_TYPES = new Set(['pdf', 'launch']);
const ALL_TYPES = new Set(['youtube', 'html', 'pdf', 'webview', 'external', 'launch']);

const LOCALES_DIR = path.join(__dirname, 'locales');
const ALLOWED_LANGS = new Set(['pt', 'en', 'es', 'fr']);

const DEFAULT_CONFIG = {
  language: 'pt',
  brand: {
    title: 'LaunchBox Pro',
    logo: null,
    colors: { sidebar: '#111827', background: '#f8fafc', buttons: '#2563eb' }
  },
  marketing: {
    leads: { enabled: false, heading: 'Insira o seu email para aceder ao conteúdo', formHtml: '' },
    banner: { enabled: false, image: null, url: '', position: 'bottom' }
  },
  content: [],
  export: { iconPath: null }
};

let builderWindow = null;
let viewerWindow = null;

/* -------- FS helpers -------- */

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });
}

function hasProject() {
  return fs.existsSync(CONFIG_PATH);
}

function deepMerge(defaults, override) {
  if (override === null || override === undefined) return structuredClone(defaults);
  if (typeof defaults !== 'object' || Array.isArray(defaults)) return override;
  const out = {};
  for (const key of Object.keys(defaults)) {
    if (override && Object.prototype.hasOwnProperty.call(override, key)) {
      out[key] = deepMerge(defaults[key], override[key]);
    } else {
      out[key] = structuredClone(defaults[key]);
    }
  }
  if (override && typeof override === 'object') {
    for (const key of Object.keys(override)) {
      if (!(key in out)) out[key] = override[key];
    }
  }
  return out;
}

function readConfig() {
  // In Viewer mode, NEVER auto-create defaults — that would mask the "no
  // project loaded" state. Return defaults in-memory only.
  if (!fs.existsSync(CONFIG_PATH)) {
    if (isViewer) return structuredClone(DEFAULT_CONFIG);
    ensureDirs();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
    return structuredClone(DEFAULT_CONFIG);
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
  } catch (err) {
    console.error('Failed to read config, returning defaults:', err);
    return structuredClone(DEFAULT_CONFIG);
  }
}

function writeConfig(config) {
  if (isViewer) throw new Error('Viewer não pode escrever configuração.');
  ensureDirs();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function copyAssetToProject(sourcePath, prefix = 'asset') {
  ensureDirs();
  const ext = path.extname(sourcePath) || '';
  const base = sanitizeFilename(path.basename(sourcePath, ext)) || prefix;
  const finalName = `${prefix}-${Date.now()}-${base}${ext}`;
  const destAbs = path.join(ASSETS_DIR, finalName);
  fs.copyFileSync(sourcePath, destAbs);
  return path.posix.join('dist-assets', finalName);
}

function deleteAssetIfInside(relativePath) {
  if (!relativePath) return;
  const abs = path.join(WRITE_BASE, relativePath);
  if (abs.startsWith(ASSETS_DIR) && fs.existsSync(abs)) {
    try { fs.unlinkSync(abs); } catch (err) { console.warn('Failed to delete old asset:', err); }
  }
}

function resolveRelativeAsset(relativePath) {
  if (!relativePath) return null;
  return path.join(WRITE_BASE, relativePath);
}

/* -------- Windows -------- */

function createBuilderWindow() {
  builderWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    title: 'LaunchBox Pro — Construtor',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false
    }
  });
  builderWindow.setMenuBarVisibility(false);
  builderWindow.loadFile(path.join(__dirname, 'src', 'builder', 'index.html'));
  builderWindow.on('closed', () => { builderWindow = null; });
}

function createViewerWindow({ standalone = false } = {}) {
  if (viewerWindow && !viewerWindow.isDestroyed()) {
    viewerWindow.focus();
    return viewerWindow;
  }

  const projectExists = hasProject();
  const config = projectExists ? readConfig() : null;
  const title = (config && config.brand && config.brand.title) || 'LaunchBox Viewer';
  const bgColor = (config && config.brand && config.brand.colors && config.brand.colors.background) || '#f8fafc';

  viewerWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: standalone ? title : (title + ' — Pré-visualização'),
    backgroundColor: bgColor,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-viewer.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false,
      devTools: !app.isPackaged
    }
  });

  viewerWindow.setMenuBarVisibility(false);
  viewerWindow.loadFile(path.join(__dirname, 'src', 'viewer', 'index.html'));
  viewerWindow.once('ready-to-show', () => {
    if (standalone) viewerWindow.maximize();
    viewerWindow.show();
  });
  viewerWindow.on('closed', () => { viewerWindow = null; });
  return viewerWindow;
}

/* -------- IPC: shared -------- */

ipcMain.handle('config:load', () => readConfig());
ipcMain.handle('asset:resolve', (_event, relativePath) => resolveRelativeAsset(relativePath));

/* -------- IPC: brand (Builder only) -------- */

function assertBuilder() {
  if (isViewer) throw new Error('Operação não disponível no Viewer.');
}

ipcMain.handle('brand:save', (_event, payload) => {
  assertBuilder();
  const current = readConfig();
  let logoRelative = current.brand.logo || null;

  if (payload && payload.logoSourcePath) {
    if (!fs.existsSync(payload.logoSourcePath)) {
      throw new Error('Ficheiro de logo não encontrado: ' + payload.logoSourcePath);
    }
    deleteAssetIfInside(logoRelative);
    logoRelative = copyAssetToProject(payload.logoSourcePath, 'logo');
  } else if (payload && payload.removeLogo) {
    deleteAssetIfInside(logoRelative);
    logoRelative = null;
  }

  const updated = {
    ...current,
    brand: {
      title: (payload && typeof payload.title === 'string' && payload.title.trim())
        ? payload.title.trim() : DEFAULT_CONFIG.brand.title,
      logo: logoRelative,
      colors: {
        sidebar: (payload && payload.colors && payload.colors.sidebar) || current.brand.colors.sidebar,
        background: (payload && payload.colors && payload.colors.background) || current.brand.colors.background,
        buttons: (payload && payload.colors && payload.colors.buttons) || current.brand.colors.buttons
      }
    }
  };
  writeConfig(updated);
  return updated;
});

/* -------- IPC: marketing (Builder only) -------- */

ipcMain.handle('marketing:saveLeads', (_event, payload) => {
  assertBuilder();
  const current = readConfig();
  const updated = {
    ...current,
    marketing: {
      ...current.marketing,
      leads: {
        enabled: !!(payload && payload.enabled),
        heading: (payload && typeof payload.heading === 'string')
          ? payload.heading.trim() : current.marketing.leads.heading,
        formHtml: (payload && typeof payload.formHtml === 'string')
          ? payload.formHtml : current.marketing.leads.formHtml
      }
    }
  };
  writeConfig(updated);
  return updated;
});

ipcMain.handle('marketing:saveBanners', (_event, payload) => {
  assertBuilder();
  const current = readConfig();
  let bannerRelative = current.marketing.banner.image || null;

  if (payload && payload.imageSourcePath) {
    if (!fs.existsSync(payload.imageSourcePath)) {
      throw new Error('Ficheiro de banner não encontrado: ' + payload.imageSourcePath);
    }
    deleteAssetIfInside(bannerRelative);
    bannerRelative = copyAssetToProject(payload.imageSourcePath, 'banner');
  } else if (payload && payload.removeImage) {
    deleteAssetIfInside(bannerRelative);
    bannerRelative = null;
  }

  const position = (payload && payload.position) === 'top' ? 'top' : 'bottom';
  const updated = {
    ...current,
    marketing: {
      ...current.marketing,
      banner: {
        enabled: !!(payload && payload.enabled),
        image: bannerRelative,
        url: (payload && typeof payload.url === 'string') ? payload.url.trim() : current.marketing.banner.url,
        position
      }
    }
  };
  writeConfig(updated);
  return updated;
});

/* -------- IPC: content (Builder only) -------- */

function sanitizeModule(mod) {
  if (!mod || typeof mod !== 'object') return null;
  const type = ALL_TYPES.has(mod.type) ? mod.type : null;
  if (!type) return null;
  const id = (typeof mod.id === 'string' && mod.id.trim())
    ? mod.id.trim() : crypto.randomUUID();
  const title = (typeof mod.title === 'string' && mod.title.trim()) ? mod.title.trim() : 'Sem título';
  const data = (mod.data && typeof mod.data === 'object') ? { ...mod.data } : {};
  return { id, title, type, data };
}

function findModuleById(list, id) {
  return list.find((m) => m && m.id === id) || null;
}

ipcMain.handle('content:save', (_event, payload) => {
  assertBuilder();
  const current = readConfig();
  const previous = Array.isArray(current.content) ? current.content : [];
  const incoming = Array.isArray(payload && payload.modules) ? payload.modules : [];

  const nextModules = [];
  for (const raw of incoming) {
    const mod = sanitizeModule(raw);
    if (!mod) continue;
    const prev = findModuleById(previous, mod.id);

    if (FILE_TYPES.has(mod.type)) {
      const sourcePath = mod.data && typeof mod.data.sourcePath === 'string' ? mod.data.sourcePath : null;
      if (sourcePath) {
        if (!fs.existsSync(sourcePath)) throw new Error('Ficheiro não encontrado: ' + sourcePath);
        if (prev && prev.data && prev.data.file) deleteAssetIfInside(prev.data.file);
        const prefix = mod.type === 'pdf' ? 'pdf' : 'file';
        const relative = copyAssetToProject(sourcePath, prefix);
        mod.data = { file: relative, fileName: path.basename(sourcePath) };
      } else {
        const prevFile = (prev && prev.data && prev.data.file) || null;
        const prevName = (prev && prev.data && prev.data.fileName) || null;
        mod.data = { file: prevFile, fileName: prevName };
      }
    } else {
      const d = mod.data || {};
      if (mod.type === 'youtube' || mod.type === 'webview' || mod.type === 'external') {
        mod.data = { url: typeof d.url === 'string' ? d.url.trim() : '' };
      } else if (mod.type === 'html') {
        mod.data = { html: typeof d.html === 'string' ? d.html : '' };
      }
    }
    nextModules.push(mod);
  }

  const keptFiles = new Set(
    nextModules
      .filter((m) => FILE_TYPES.has(m.type) && m.data && m.data.file)
      .map((m) => m.data.file)
  );
  for (const prev of previous) {
    if (!prev || !FILE_TYPES.has(prev.type)) continue;
    const prevFile = prev.data && prev.data.file;
    if (prevFile && !keptFiles.has(prevFile)) deleteAssetIfInside(prevFile);
  }

  const updated = { ...current, content: nextModules };
  writeConfig(updated);
  return updated;
});

/* -------- IPC: viewer + shell -------- */

ipcMain.handle('viewer:open', () => {
  assertBuilder();
  createViewerWindow({ standalone: false });
  return true;
});

ipcMain.handle('shell:openExternal', async (_event, url) => {
  if (typeof url !== 'string' || !url.trim()) return false;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('URL inválido (apenas http/https): ' + trimmed);
  }
  await shell.openExternal(trimmed);
  return true;
});

ipcMain.handle('shell:launchFile', async (_event, relativePath) => {
  if (typeof relativePath !== 'string' || !relativePath) {
    throw new Error('Caminho de ficheiro vazio.');
  }
  const abs = path.join(WRITE_BASE, relativePath);
  if (!abs.startsWith(ASSETS_DIR)) {
    throw new Error('Caminho não permitido: ' + relativePath);
  }
  if (!fs.existsSync(abs)) {
    throw new Error('Ficheiro não existe: ' + abs);
  }
  const errMsg = await shell.openPath(abs);
  if (errMsg) throw new Error(errMsg);
  return true;
});

/* -------- IPC: viewer-only project loading -------- */

ipcMain.handle('viewer:hasProject', () => hasProject());

ipcMain.handle('viewer:locale', () => {
  // Best-effort: if a project is already loaded, use its language. Otherwise
  // try the OS locale and fall back to English (most universal welcome).
  if (hasProject()) {
    try {
      const cfg = readConfig();
      if (cfg && ALLOWED_LANGS.has(cfg.language)) return cfg.language;
    } catch (_) { /* ignore */ }
  }
  const osLang = (app.getLocale() || 'en').slice(0, 2).toLowerCase();
  return ALLOWED_LANGS.has(osLang) ? osLang : 'en';
});

function extractLbpro(lbproPath) {
  // Transactional extraction: unpack to a temp staging dir, validate the
  // resulting project-config.json, and ONLY then swap it into place. If
  // anything fails (corrupt zip, invalid JSON, IO error) the previous loaded
  // project is left untouched — no data loss for the end user.
  if (!fs.existsSync(lbproPath)) {
    throw new Error('Ficheiro não encontrado: ' + lbproPath);
  }

  const zip = new AdmZip(lbproPath);
  const entries = zip.getEntries();
  const hasConfig = entries.some((e) =>
    e.entryName === 'data/project-config.json' || e.entryName === 'project-config.json'
  );
  if (!hasConfig) {
    throw new Error('Pacote inválido: project-config.json em falta.');
  }

  const stagingRoot = path.join(WRITE_BASE, '.lbpro-staging-' + Date.now());
  const stagingData = path.join(stagingRoot, 'data');
  const stagingAssets = path.join(stagingRoot, 'dist-assets');

  try {
    fs.mkdirSync(stagingData, { recursive: true });
    fs.mkdirSync(stagingAssets, { recursive: true });

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const name = entry.entryName.replace(/\\/g, '/');
      let destRel = null;

      if (name === 'project-config.json' || name === 'data/project-config.json') {
        destRel = path.join('data', 'project-config.json');
      } else if (name === 'icon.ico' || name === 'data/icon.ico') {
        destRel = path.join('data', 'icon.ico');
      } else if (name.startsWith('dist-assets/') && !name.includes('..') && !name.includes('\0')) {
        destRel = name.split('/').join(path.sep);
      } else {
        // Unknown entry — skip for safety (zip-slip / unexpected files).
        continue;
      }

      const destAbs = path.join(stagingRoot, destRel);
      const resolved = path.resolve(destAbs);
      // Zip-slip belt + suspenders: ensure resolved path stays inside staging.
      if (!resolved.startsWith(path.resolve(stagingRoot) + path.sep)) continue;
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.writeFileSync(destAbs, entry.getData());
    }

    // Validate: project-config.json must exist AND parse as JSON.
    const stagedConfigPath = path.join(stagingData, 'project-config.json');
    if (!fs.existsSync(stagedConfigPath)) {
      throw new Error('Pacote inválido: project-config.json em falta após extração.');
    }
    try {
      JSON.parse(fs.readFileSync(stagedConfigPath, 'utf-8'));
    } catch (parseErr) {
      throw new Error('Pacote inválido: project-config.json corrompido (' + parseErr.message + ').');
    }

    // All good — swap in. Only AFTER successful validation do we touch the
    // currently-loaded project. Order: remove old, then rename staging dirs
    // into place. Brief window between the two renames is unavoidable, but
    // there's no other process competing for these paths.
    if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });
    if (fs.existsSync(ASSETS_DIR)) fs.rmSync(ASSETS_DIR, { recursive: true, force: true });
    fs.renameSync(stagingData, DATA_DIR);
    fs.renameSync(stagingAssets, ASSETS_DIR);
  } finally {
    // Best-effort cleanup of the staging root regardless of outcome.
    try {
      if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
  }
}

// Guard against re-entrant viewer:loadProject invocations. A double-click on
// the welcome button (or two windows somehow) would otherwise interleave
// staging/rename operations on the same paths.
let loadProjectBusy = false;

ipcMain.handle('viewer:loadProject', async () => {
  if (loadProjectBusy) {
    throw new Error('Já existe uma operação de carregamento em curso.');
  }
  loadProjectBusy = true;
  try {
    const owner = viewerWindow || builderWindow || null;
    const result = await dialog.showOpenDialog(owner, {
      title: 'Selecionar ficheiro de projeto (.lbpro)',
      properties: ['openFile'],
      filters: [{ name: 'LaunchBox Project', extensions: ['lbpro'] }]
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { ok: false, cancelled: true };
    }
    const filePath = result.filePaths[0];
    try {
      extractLbpro(filePath);
      return { ok: true, path: filePath };
    } catch (err) {
      throw new Error((err && err.message) ? err.message : String(err));
    }
  } finally {
    loadProjectBusy = false;
  }
});

/* -------- IPC: export (Builder only) -------- */

ipcMain.handle('export:saveIcon', (_event, payload) => {
  assertBuilder();
  if (!payload || !payload.sourcePath) {
    throw new Error('Caminho do ícone em falta.');
  }
  if (!fs.existsSync(payload.sourcePath)) {
    throw new Error('Ficheiro de ícone não encontrado.');
  }
  if (path.extname(payload.sourcePath).toLowerCase() !== '.ico') {
    throw new Error('O ícone tem de ser um ficheiro .ico');
  }
  ensureDirs();
  fs.copyFileSync(payload.sourcePath, ICON_DEST_PATH);

  const current = readConfig();
  const updated = { ...current, export: { ...(current.export || {}), iconPath: 'data/icon.ico' } };
  writeConfig(updated);
  return updated;
});

ipcMain.handle('export:packLbpro', async (event, payload) => {
  assertBuilder();
  const send = (msg, kind = 'info') => {
    event.sender.send('export:log', { msg, kind });
  };

  send('A preparar pacote .lbpro…');

  if (!hasProject()) {
    throw new Error('Sem projeto para exportar. Guarde primeiro pelo menos uma definição no Construtor.');
  }

  const defaultName = (payload && typeof payload.defaultName === 'string' && payload.defaultName.trim())
    ? payload.defaultName.trim()
    : 'meu-curso';

  const result = await dialog.showSaveDialog(builderWindow, {
    title: (payload && payload.dialogTitle) || 'Guardar ficheiro de projeto',
    defaultPath: sanitizeFilename(defaultName) + '.lbpro',
    filters: [{ name: 'LaunchBox Project', extensions: ['lbpro'] }]
  });
  if (result.canceled || !result.filePath) {
    send('Operação cancelada.', 'info');
    return { ok: false, cancelled: true };
  }

  let target = result.filePath;
  if (!target.toLowerCase().endsWith('.lbpro')) target += '.lbpro';

  send('A comprimir ficheiros…');
  try {
    const zip = new AdmZip();
    // 1. Project config (mandatory)
    zip.addLocalFile(CONFIG_PATH, 'data');
    // 2. Optional icon
    if (fs.existsSync(ICON_DEST_PATH)) zip.addLocalFile(ICON_DEST_PATH, 'data');
    // 3. All assets (PDFs, images, launch files, logo, banner…)
    if (fs.existsSync(ASSETS_DIR)) {
      const entries = fs.readdirSync(ASSETS_DIR);
      for (const name of entries) {
        const full = path.join(ASSETS_DIR, name);
        try {
          if (fs.statSync(full).isFile()) {
            zip.addLocalFile(full, 'dist-assets');
          }
        } catch (_) { /* skip unreadable entries */ }
      }
    }
    zip.writeZip(target);
    send('Pacote guardado: ' + target, 'success');
    return { ok: true, path: target };
  } catch (err) {
    send('Erro: ' + (err && err.message ? err.message : err), 'error');
    throw err;
  }
});

ipcMain.handle('export:revealInFolder', (_event, p) => {
  if (typeof p === 'string' && p && fs.existsSync(p)) {
    shell.showItemInFolder(p);
    return true;
  }
  return false;
});

/* -------- IPC: i18n -------- */

ipcMain.handle('i18n:loadLocale', (_event, lang) => {
  const safeLang = ALLOWED_LANGS.has(lang) ? lang : 'pt';
  const filePath = path.join(LOCALES_DIR, safeLang + '.json');
  if (!fs.existsSync(filePath)) {
    throw new Error('Ficheiro de tradução em falta: ' + safeLang);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  return { lang: safeLang, dict: JSON.parse(raw) };
});

ipcMain.handle('language:save', (_event, lang) => {
  assertBuilder();
  const safeLang = ALLOWED_LANGS.has(lang) ? lang : 'pt';
  const current = readConfig();
  const updated = { ...current, language: safeLang };
  writeConfig(updated);
  return updated;
});

/* -------- App lifecycle -------- */

app.whenReady().then(() => {
  if (isViewer) {
    // Universal Viewer: do NOT bootstrap a default config. The renderer asks
    // viewer:hasProject and shows the welcome / load screen if empty.
    createViewerWindow({ standalone: true });
  } else {
    ensureDirs();
    readConfig();
    createBuilderWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (isViewer) createViewerWindow({ standalone: true });
      else createBuilderWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
