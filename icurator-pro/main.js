const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = __dirname;
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const ASSETS_DIR = path.join(PROJECT_ROOT, 'dist-assets');
const CONFIG_PATH = path.join(DATA_DIR, 'project-config.json');

const DEFAULT_CONFIG = {
  brand: {
    title: 'iCurator Pro',
    logo: null,
    colors: {
      sidebar: '#111827',
      background: '#f8fafc',
      buttons: '#2563eb'
    }
  },
  marketing: {
    leads: {
      enabled: false,
      heading: 'Insira o seu email para aceder ao conteúdo',
      formHtml: ''
    },
    banner: {
      enabled: false,
      image: null,
      url: '',
      position: 'bottom' // 'top' | 'bottom'
    }
  }
};

let builderWindow = null;

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
  // Keep any extra keys the override may carry.
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

/* -------- Window -------- */

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

  builderWindow.on('closed', () => {
    builderWindow = null;
  });
}

/* -------- IPC: config + brand -------- */

ipcMain.handle('config:load', () => readConfig());

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
        ? payload.title.trim()
        : DEFAULT_CONFIG.brand.title,
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

ipcMain.handle('asset:resolve', (_event, relativePath) => {
  if (!relativePath) return null;
  return path.join(PROJECT_ROOT, relativePath);
});

/* -------- IPC: marketing (Leads + Banner) -------- */

ipcMain.handle('marketing:saveLeads', (_event, payload) => {
  const current = readConfig();
  const updated = {
    ...current,
    marketing: {
      ...current.marketing,
      leads: {
        enabled: !!(payload && payload.enabled),
        heading: (payload && typeof payload.heading === 'string')
          ? payload.heading.trim()
          : current.marketing.leads.heading,
        formHtml: (payload && typeof payload.formHtml === 'string')
          ? payload.formHtml
          : current.marketing.leads.formHtml
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

  const positionRaw = payload && payload.position;
  const position = positionRaw === 'top' ? 'top' : 'bottom';

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
