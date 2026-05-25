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
  }
};

let builderWindow = null;

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });
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
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      brand: {
        ...DEFAULT_CONFIG.brand,
        ...(parsed.brand || {}),
        colors: {
          ...DEFAULT_CONFIG.brand.colors,
          ...((parsed.brand && parsed.brand.colors) || {})
        }
      }
    };
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
  const stamp = Date.now();
  const finalName = `${prefix}-${stamp}-${base}${ext}`;
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

/* -------- IPC -------- */

ipcMain.handle('config:load', () => {
  return readConfig();
});

ipcMain.handle('brand:save', (_event, payload) => {
  const current = readConfig();

  let logoRelative = current.brand.logo || null;

  if (payload && payload.logoSourcePath) {
    // New logo selected — copy it into dist-assets/ and replace any previous one.
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

/* -------- App lifecycle -------- */

app.whenReady().then(() => {
  ensureDirs();
  // Make sure a config file always exists from the first launch.
  readConfig();
  createBuilderWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createBuilderWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
