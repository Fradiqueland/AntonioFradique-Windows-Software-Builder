const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/* -------- Paths: dev vs packaged --------
 *
 * When packaged (.exe), the app reads its config and assets from
 * `process.resourcesPath` because electron-builder copies them there via
 * the `extraResources` setting in build-config.json.
 * In development, everything lives next to main.js as usual.
 */
const PROJECT_ROOT = __dirname;
const BASE_PATH = app.isPackaged ? process.resourcesPath : PROJECT_ROOT;
const DATA_DIR = path.join(BASE_PATH, 'data');
const ASSETS_DIR = path.join(BASE_PATH, 'dist-assets');
const CONFIG_PATH = path.join(DATA_DIR, 'project-config.json');
// Flag-file that distinguishes a "course .exe" (Viewer-only) from the
// "Master App" (Builder). If this file is present in data/, the app boots
// into Viewer mode regardless of app.isPackaged.
const COURSE_FLAG_PATH = path.join(DATA_DIR, 'course-mode.flag');

// Build outputs always live next to package.json (dev-only operation).
const BUILD_CONFIG_PATH = path.join(PROJECT_ROOT, 'build-config.json');
const ICON_DEST_PATH = path.join(PROJECT_ROOT, 'data', 'icon.ico');

const FILE_TYPES = new Set(['pdf', 'launch']);
const ALL_TYPES = new Set(['youtube', 'html', 'pdf', 'webview', 'external', 'launch']);

const DEFAULT_CONFIG = {
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
  export: { iconPath: null } // 'data/icon.ico' when set
};

let builderWindow = null;
let viewerWindow = null;

/* -------- FS helpers -------- */

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });
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
  ensureDirs();
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
    return structuredClone(DEFAULT_CONFIG);
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return deepMerge(DEFAULT_CONFIG, parsed);
  } catch (err) {
    console.error('Failed to read config, returning defaults:', err);
    return structuredClone(DEFAULT_CONFIG);
  }
}

function writeConfig(config) {
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
  const abs = path.join(BASE_PATH, relativePath);
  if (abs.startsWith(ASSETS_DIR) && fs.existsSync(abs)) {
    try { fs.unlinkSync(abs); } catch (err) { console.warn('Failed to delete old asset:', err); }
  }
}

function resolveRelativeAsset(relativePath) {
  if (!relativePath) return null;
  return path.join(BASE_PATH, relativePath);
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

  const config = readConfig();
  const title = (config.brand && config.brand.title) ? config.brand.title : 'LaunchBox Pro';
  const bgColor = (config.brand && config.brand.colors && config.brand.colors.background) || '#f8fafc';

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

/* -------- IPC: brand -------- */

ipcMain.handle('brand:save', (_event, payload) => {
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

/* -------- IPC: marketing -------- */

ipcMain.handle('marketing:saveLeads', (_event, payload) => {
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

/* -------- IPC: content -------- */

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
  const abs = path.join(BASE_PATH, relativePath);
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

/* -------- IPC: export (Passo 6) -------- */

ipcMain.handle('export:saveIcon', (_event, payload) => {
  if (!payload || !payload.sourcePath) {
    throw new Error('Caminho do ícone em falta.');
  }
  if (!fs.existsSync(payload.sourcePath)) {
    throw new Error('Ficheiro de ícone não encontrado.');
  }
  if (path.extname(payload.sourcePath).toLowerCase() !== '.ico') {
    throw new Error('O ícone tem de ser um ficheiro .ico');
  }
  if (!fs.existsSync(path.dirname(ICON_DEST_PATH))) {
    fs.mkdirSync(path.dirname(ICON_DEST_PATH), { recursive: true });
  }
  fs.copyFileSync(payload.sourcePath, ICON_DEST_PATH);

  const current = readConfig();
  const updated = { ...current, export: { ...(current.export || {}), iconPath: 'data/icon.ico' } };
  writeConfig(updated);
  return updated;
});

function generateBuildConfig(config) {
  const productName = (config.brand && config.brand.title)
    ? config.brand.title.trim()
    : 'LaunchBox Pro';
  const hasIcon = !!(config.export && config.export.iconPath) && fs.existsSync(ICON_DEST_PATH);

  return {
    appId: 'com.launchbox.product',
    productName,
    directories: { output: 'release' },
    files: ['main.js', 'preload.js', 'preload-viewer.js', 'src/**/*'],
    extraResources: [
      // Whole data/ dir so the course-mode.flag travels into the .exe alongside
      // project-config.json and the icon.
      { from: 'data', to: 'data' },
      { from: 'dist-assets', to: 'dist-assets' }
    ],
    win: {
      target: 'nsis',
      ...(hasIcon ? { icon: 'data/icon.ico' } : {})
    },
    nsis: {
      oneClick: false,
      allowToChangeInstallationDirectory: true
    }
  };
}

ipcMain.handle('export:build', async (event) => {
  if (app.isPackaged) {
    throw new Error('A compilação só pode ser feita em modo desenvolvimento.');
  }

  const send = (msg, kind = 'info') => {
    event.sender.send('export:log', { msg, kind });
  };

  send('A preparar configuração de build…');
  const config = readConfig();
  const buildConfig = generateBuildConfig(config);

  fs.writeFileSync(BUILD_CONFIG_PATH, JSON.stringify(buildConfig, null, 2), 'utf-8');
  send('build-config.json criado em ' + BUILD_CONFIG_PATH);
  send('A garantir que data/project-config.json e dist-assets/ existem para extraResources…');
  ensureDirs();

  send('A iniciar electron-builder. Este passo pode demorar 1-3 minutos…');

  let builder;
  try {
    builder = require('electron-builder');
  } catch (err) {
    throw new Error('electron-builder não está instalado. Corra: npm install');
  }

  // Drop the course-mode flag so it gets bundled via extraResources. This is
  // ALWAYS removed in the finally block, so the dev Construtor never gets
  // accidentally locked into Viewer mode.
  try {
    fs.writeFileSync(COURSE_FLAG_PATH, '', 'utf-8');
    send('Flag de curso criada (data/course-mode.flag) — será embutida no .exe.');
  } catch (err) {
    throw new Error('Não foi possível criar a flag de curso: ' + err.message);
  }

  try {
    const outFiles = await builder.build({
      targets: builder.Platform.WINDOWS.createTarget(),
      config: buildConfig
    });
    send('Build concluído com sucesso.', 'success');
    (outFiles || []).forEach((f) => send('Gerado: ' + f, 'success'));
    send('Abra a pasta "release/" na raiz do projeto para encontrar o instalador.', 'success');
    return { ok: true, files: outFiles || [] };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    send('Erro durante o build: ' + msg, 'error');
    throw err;
  } finally {
    // CRÍTICO: remover a flag para que o Construtor não fique "trancado" em
    // modo curso no próximo arranque.
    try {
      if (fs.existsSync(COURSE_FLAG_PATH)) {
        fs.unlinkSync(COURSE_FLAG_PATH);
        send('Flag de curso removida do Construtor (limpeza pós-build).');
      }
    } catch (cleanupErr) {
      send('Aviso: não foi possível remover course-mode.flag: ' + cleanupErr.message, 'error');
    }
  }
});

ipcMain.handle('export:openReleaseFolder', () => {
  const dir = path.join(PROJECT_ROOT, 'release');
  if (fs.existsSync(dir)) shell.openPath(dir);
  return true;
});

/* -------- App lifecycle -------- */

function isCourseMode() {
  // Não depende de app.isPackaged. O que decide é a flag.
  return fs.existsSync(COURSE_FLAG_PATH);
}

app.whenReady().then(() => {
  ensureDirs();
  readConfig();

  if (isCourseMode()) {
    // Curso exportado: arranca direto no Viewer maximizado, sem Construtor.
    createViewerWindow({ standalone: true });
  } else {
    // Master App (Construtor) — dev OU .exe distribuído ao próprio criador.
    createBuilderWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (isCourseMode()) createViewerWindow({ standalone: true });
      else createBuilderWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
