const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PROJECT_ROOT = __dirname;
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const ASSETS_DIR = path.join(PROJECT_ROOT, 'dist-assets');
const CONFIG_PATH = path.join(DATA_DIR, 'project-config.json');

const FILE_TYPES = new Set(['pdf', 'launch']);
const ALL_TYPES = new Set(['youtube', 'html', 'pdf', 'webview', 'external', 'launch']);

const DEFAULT_CONFIG = {
  brand: {
    title: 'iCurator Pro',
    logo: null,
    colors: { sidebar: '#111827', background: '#f8fafc', buttons: '#2563eb' }
  },
  marketing: {
    leads: { enabled: false, heading: 'Insira o seu email para aceder ao conteúdo', formHtml: '' },
    banner: { enabled: false, image: null, url: '', position: 'bottom' }
  },
  content: []
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
  const abs = path.join(PROJECT_ROOT, relativePath);
  if (abs.startsWith(ASSETS_DIR) && fs.existsSync(abs)) {
    try { fs.unlinkSync(abs); } catch (err) { console.warn('Failed to delete old asset:', err); }
  }
}

function resolveRelativeAsset(relativePath) {
  if (!relativePath) return null;
  return path.join(PROJECT_ROOT, relativePath);
}

/* -------- Windows -------- */

function createBuilderWindow() {
  builderWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    title: 'iCurator Pro — Construtor',
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

function createViewerWindow() {
  if (viewerWindow && !viewerWindow.isDestroyed()) {
    viewerWindow.focus();
    return viewerWindow;
  }

  const config = readConfig();
  const title = (config.brand && config.brand.title) ? config.brand.title : 'iCurator Pro';
  const bgColor = (config.brand && config.brand.colors && config.brand.colors.background) || '#f8fafc';

  viewerWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: title + ' — Pré-visualização',
    backgroundColor: bgColor,
    webPreferences: {
      preload: path.join(__dirname, 'preload-viewer.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false
    }
  });

  viewerWindow.setMenuBarVisibility(false);
  viewerWindow.loadFile(path.join(__dirname, 'src', 'viewer', 'index.html'));
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

/* -------- IPC: content / menus -------- */

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

/* -------- IPC: viewer + shell (Passo 5) -------- */

ipcMain.handle('viewer:open', () => {
  createViewerWindow();
  return true;
});

ipcMain.handle('shell:openExternal', async (_event, url) => {
  if (typeof url !== 'string' || !url.trim()) return false;
  const trimmed = url.trim();
  // Allow only http/https for external browser to keep this safe.
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
  // Only allow launching files that live inside dist-assets/
  const abs = path.join(PROJECT_ROOT, relativePath);
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

/* -------- App lifecycle -------- */

app.whenReady().then(() => {
  ensureDirs();
  readConfig();
  createBuilderWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createBuilderWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
