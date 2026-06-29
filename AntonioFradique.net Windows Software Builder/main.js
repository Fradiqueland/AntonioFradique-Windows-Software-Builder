const { app, BrowserWindow, ipcMain, shell, dialog, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

/* =========================================================
 * APP MODE: Builder vs Viewer (SFX-stamped)
 * =========================================================
 *
 * Distribution model is now "single self-extracting .exe per course":
 *
 *   - Builder (.exe) — the creator's tool. Edits project-config.json and
 *     copies assets into dist-assets/. On "Export" it stamps the current
 *     project into a copy of the Viewer template, compresses everything
 *     with 7-Zip and concatenates the 7-Zip SFX module to produce a single
 *     self-extracting .exe — e.g. "Curso de Photoshop.exe".
 *
 *   - Viewer (Electron app) — the player. NEVER distributed standalone.
 *     It is built once by the developer (`npm run build:viewer-template`)
 *     into `src/builder/templates/viewer-core/win-unpacked/` and shipped
 *     INSIDE the Builder install as an extraResource. The Builder uses it
 *     as a template for every course export.
 *
 *     When the student double-clicks Curso.exe the SFX module extracts the
 *     whole payload to a fresh `%TEMP%\7zXXXX\` folder and launches the
 *     stamped Viewer from there. The course's project-config.json and
 *     dist-assets/ live next to the Viewer's app.asar (under resources/),
 *     so the Viewer just reads them from `process.resourcesPath`.
 *
 * Mode is decided by `app-mode.json`, injected as an extraResource by each
 * build config. In dev we default to Builder; set LAUNCHBOX_MODE=viewer to
 * preview the Viewer flow from a dev project tree.
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

// Per-mode app naming + cache location.
//
// Builder packaged → standalone install → userData in %AppData%\LaunchBox Builder.
// Viewer packaged → SFX-extracted to %TEMP% → redirect userData INTO the
//   same temp folder so all Electron cache (Cache, Cookies, GPUCache, …)
//   disappears with the SFX cleanup when the student closes the course.
if (isViewer) {
  app.setName('LaunchBox Viewer');
  if (app.isPackaged) {
    const exeDir = path.dirname(app.getPath('exe'));
    app.setPath('userData', path.join(exeDir, '.electron-cache'));
  }
} else {
  app.setName('LaunchBox Builder');
}

/* =========================================================
 * PATHS
 *
 * Builder dev      → PROJECT_ROOT (next to main.js)
 * Builder packaged → app.getPath('userData') (writable AppData)
 * Viewer dev       → PROJECT_ROOT (lets the Builder's "Preview" reuse it)
 * Viewer packaged  → process.resourcesPath (the SFX-extracted resources
 *                    folder, sibling of app.asar — read & write OK because
 *                    it's a fresh %TEMP% extraction every launch)
 * ========================================================= */
const PROJECT_ROOT = __dirname;
const WRITE_BASE = (() => {
  if (!app.isPackaged) return PROJECT_ROOT;
  if (isViewer) return process.resourcesPath;
  return app.getPath('userData');
})();

const DATA_DIR = path.join(WRITE_BASE, 'data');
const ASSETS_DIR = path.join(WRITE_BASE, 'dist-assets');
const CONFIG_PATH = path.join(DATA_DIR, 'project-config.json');
const ICON_DEST_PATH = path.join(DATA_DIR, 'icon.ico');

const SINGLE_FILE_TYPES = new Set(['pdf', 'launch', 'local-video', 'local-audio', 'download-vault']);
const GALLERY_TYPES = new Set(['image-gallery']);
const ALL_TYPES = new Set([
  'youtube', 'html', 'pdf', 'webview', 'external', 'launch',
  'local-video', 'local-audio', 'download-vault', 'image-gallery',
  'article-reader', 'community-link', 'smart-embed'
]);

const LOCALES_DIR = path.join(__dirname, 'locales');
const ALLOWED_LANGS = new Set(['pt', 'en', 'es', 'fr', 'hi', 'ar', 'zh', 'bn', 'ru', 'id']);

/* SFX export resources (Builder packaged only).
 * In dev: bin/template lives under the project tree.
 * In prod: shipped as extraResources of the Builder install. */
function getSfxBinDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'sfx');
  return path.join(PROJECT_ROOT, 'src', 'builder', 'bin');
}
function getViewerTemplateDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'viewer-template');
  // electron-builder's dir target writes into <output>/win-unpacked/
  return path.join(PROJECT_ROOT, 'src', 'builder', 'templates', 'viewer-core', 'win-unpacked');
}

const DEFAULT_CONFIG = {
  language: 'pt',
  brand: {
    title: 'O Meu Software',
    logo: null,
    colors: { sidebar: '#111827', background: '#f8fafc', buttons: '#2563eb' }
  },
  marketing: {
    leads: { enabled: false, heading: 'Insira o seu email para aceder ao conteúdo', formHtml: '' },
    banners: {
      top: { enabled: false, image: null, url: '' },
      bottom: { enabled: false, image: null, url: '' }
    }
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
  // CRÍTICO: typeof null === 'object', por isso um default null (ex.: brand.logo,
  // banner.image, icon) caía neste ramo e rebentava em Object.keys(null) quando
  // o config já tinha um valor real — o try/catch do readConfig devolvia então o
  // DEFAULT_CONFIG, apagando logo/banner/módulos no 2.º Save. Tratar null (e
  // arrays/primitivos) como "o override ganha".
  if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) return override;
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

/* Back-compat: o modelo antigo guardava um único marketing.banner
 * {enabled,image,url,position}. O novo modelo usa marketing.banners com dois
 * slots independentes (top e bottom). Migra o banner antigo para o slot da
 * sua posição, para que projetos já gravados não percam o banner. */
function migrateConfig(cfg) {
  if (cfg && cfg.marketing && cfg.marketing.banner && typeof cfg.marketing.banner === 'object') {
    const old = cfg.marketing.banner;
    if (!cfg.marketing.banners || typeof cfg.marketing.banners !== 'object') {
      cfg.marketing.banners = {
        top: { enabled: false, image: null, url: '' },
        bottom: { enabled: false, image: null, url: '' }
      };
    }
    if (old.image || old.enabled) {
      const slot = old.position === 'top' ? 'top' : 'bottom';
      cfg.marketing.banners[slot] = {
        enabled: !!old.enabled,
        image: old.image || null,
        url: typeof old.url === 'string' ? old.url : ''
      };
    }
    delete cfg.marketing.banner;
  }
  return cfg;
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    // Viewer in SFX mode should ALWAYS have a stamped-in project; if it
    // doesn't, something went wrong with the export — surface defaults
    // rather than throw, so the window still opens with the corners.
    if (isViewer) return structuredClone(DEFAULT_CONFIG);
    ensureDirs();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
    return structuredClone(DEFAULT_CONFIG);
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return migrateConfig(deepMerge(DEFAULT_CONFIG, JSON.parse(raw)));
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
  return String(name || '').replace(/[^a-zA-Z0-9._ -]/g, '_').trim() || 'curso';
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

/* Extrai o ID (11 caracteres) de qualquer variante de link do YouTube:
 * watch?v=ID, youtu.be/ID, shorts/ID, embed/ID, live/ID, /v/ID, /e/ID,
 * m./music./www., com ou sem parâmetros extra, ou um ID isolado. */
function extractYoutubeId(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  let m;
  m = raw.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = raw.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = raw.match(/youtube(?:-nocookie)?\.com\/(?:embed|shorts|live|v|e)\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = raw.match(/(?:^|[/=])([A-Za-z0-9_-]{11})(?:[?&/]|$)/);
  if (m) return m[1];
  return null;
}

/* Converte qualquer link/ID de YouTube para o formato de embed obrigatório
 * (https://www.youtube.com/embed/ID). Links normais (watch?v=, youtu.be/,
 * shorts/) injetados diretamente no src disparam o Erro 153. */
function toYoutubeEmbed(input) {
  if (!input) return '';
  const id = extractYoutubeId(input);
  if (id) return 'https://www.youtube.com/embed/' + id;
  return String(input).trim();
}

function isInsideAssetsDir(abs) {
  if (!abs) return false;
  const real = path.resolve(abs);
  const root = path.resolve(ASSETS_DIR) + path.sep;
  return real.startsWith(root);
}

function deleteAssetIfInside(relativePath) {
  if (!relativePath) return;
  const abs = path.join(WRITE_BASE, relativePath);
  if (isInsideAssetsDir(abs) && fs.existsSync(abs)) {
    try { fs.unlinkSync(abs); } catch (err) { console.warn('Failed to delete old asset:', err); }
  }
}

function resolveRelativeAsset(relativePath) {
  if (!relativePath) return null;
  return path.join(WRITE_BASE, relativePath);
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function concatFilesToTarget(sources, target) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(target);
    out.on('error', reject);
    out.on('finish', resolve);
    let i = 0;
    function next() {
      if (i >= sources.length) { out.end(); return; }
      const inp = fs.createReadStream(sources[i++]);
      inp.on('error', reject);
      inp.on('end', next);
      inp.pipe(out, { end: false });
    }
    next();
  });
}

/* -------- Windows -------- */

function createBuilderWindow() {
  builderWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 1024, minHeight: 680,
    title: 'AntonioFradique.net Windows Software Builder',
    icon: path.join(__dirname, 'src', 'builder', 'app-icon.png'),
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
  attachContextMenu(builderWindow.webContents);
  builderWindow.loadFile(path.join(__dirname, 'src', 'builder', 'index.html'));
  builderWindow.on('closed', () => { builderWindow = null; });
}

/* Menu de contexto nativo (botão direito) para Cortar/Copiar/Colar nos
 * campos de texto e áreas de HTML do Construtor. Mostra apenas as ações
 * relevantes ao contexto: edição quando há campo editável, e Copiar quando
 * há texto selecionado. */
function attachContextMenu(webContents) {
  webContents.on('context-menu', (_event, params) => {
    const items = [];
    const hasText = !!(params.selectionText && params.selectionText.trim());
    if (params.isEditable) {
      items.push({ role: 'cut', label: 'Cortar', enabled: hasText });
      items.push({ role: 'copy', label: 'Copiar', enabled: hasText });
      items.push({ role: 'paste', label: 'Colar' });
      items.push({ type: 'separator' });
      items.push({ role: 'selectAll', label: 'Selecionar Tudo' });
    } else if (hasText) {
      items.push({ role: 'copy', label: 'Copiar' });
    }
    if (items.length === 0) return;
    Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(webContents) });
  });
}

/* Converte um .png/.jpg em .ico multi-resolução. Usa o nativeImage do Electron
 * para descodificar (suporta png/jpg) e o png-to-ico para empacotar. Um .ico é
 * usado tal e qual. */
async function buildIcoFromSource(sourceAbs, outIcoPath) {
  const ext = path.extname(sourceAbs).toLowerCase();
  if (ext === '.ico') { fs.copyFileSync(sourceAbs, outIcoPath); return outIcoPath; }
  const img = nativeImage.createFromPath(sourceAbs);
  if (img.isEmpty()) throw new Error('Imagem de ícone inválida: ' + sourceAbs);
  const pngToIco = require('png-to-ico');
  const sizes = [256, 128, 64, 48, 32, 16];
  const buffers = sizes
    .map((s) => img.resize({ width: s, height: s, quality: 'best' }).toPNG())
    .filter((b) => b && b.length);
  if (buffers.length === 0) throw new Error('Falha a gerar PNGs do ícone.');
  const icoBuf = await pngToIco(buffers);
  fs.writeFileSync(outIcoPath, icoBuf);
  return outIcoPath;
}

/* Aplica o ícone personalizado ao stub SFX (cópia temporária) com o rcedit.
 * O ícone do .exe final do curso vem do stub 7-Zip, NÃO de win.icon (o curso
 * não é empacotado pelo electron-builder, é uma concatenação SFX). Em caso de
 * falha (deps por instalar, etc.) devolve o stub original e avisa — a
 * exportação nunca falha por causa do ícone. */
async function stampSfxIcon(stubPath, iconSourceAbs, tmpDir, send) {
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const icoPath = path.join(tmpDir, 'course-icon.ico');
    await buildIcoFromSource(iconSourceAbs, icoPath);
    const stampedStub = path.join(tmpDir, 'sfx-stub-stamped.exe');
    fs.copyFileSync(stubPath, stampedStub);
    const rcedit = require('rcedit');
    await rcedit(stampedStub, { icon: icoPath });
    send('Ícone personalizado aplicado ao executável final.', 'success');
    return stampedStub;
  } catch (err) {
    send('ERRO: não foi possível aplicar o ícone personalizado ao .exe (' +
      (err && err.message ? err.message : err) +
      '). As ferramentas de ícone (png-to-ico / rcedit) podem não estar instaladas — corra "npm install" e reconstrua. O curso foi criado com o ícone predefinido do 7-Zip.', 'error');
    return stubPath;
  }
}

function createViewerWindow({ standalone = false } = {}) {
  if (viewerWindow && !viewerWindow.isDestroyed()) {
    // Recarrega para reler o project-config.json atualizado (módulos novos,
    // logo, banner). Sem isto, reabrir a pré-visualização mostrava o estado
    // antigo (ecrã "Bem-vindo" vazio) em vez do conteúdo já gravado.
    viewerWindow.webContents.reload();
    viewerWindow.focus();
    return viewerWindow;
  }
  const config = readConfig();
  const title = (config.brand && config.brand.title) || 'LaunchBox Viewer';
  const bgColor = (config.brand && config.brand.colors && config.brand.colors.background) || '#f8fafc';

  viewerWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
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

  /* YouTube Erro 153: numa página file:// o referrer é file://, que o YouTube
   * rejeita. Forçamos um Referer/Origin válido de youtube.com nos pedidos para
   * os domínios do YouTube — cobre tanto <webview> como <iframe>. Aplica-se à
   * pré-visualização do Construtor e ao Viewer exportado (ambos passam aqui). */
  viewerWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.youtube.com/*', '*://*.ytimg.com/*', '*://*.googlevideo.com/*', '*://*.youtube-nocookie.com/*'] },
    (details, callback) => {
      details.requestHeaders['Referer'] = 'https://www.youtube.com/';
      details.requestHeaders['Origin'] = 'https://www.youtube.com';
      callback({ requestHeaders: details.requestHeaders });
    }
  );

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
    if (!fs.existsSync(payload.logoSourcePath)) throw new Error('Ficheiro de logo não encontrado: ' + payload.logoSourcePath);
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
        heading: (payload && typeof payload.heading === 'string') ? payload.heading.trim() : current.marketing.leads.heading,
        formHtml: (payload && typeof payload.formHtml === 'string') ? payload.formHtml : current.marketing.leads.formHtml
      }
    }
  };
  writeConfig(updated);
  return updated;
});

ipcMain.handle('marketing:saveBanners', (_event, payload) => {
  assertBuilder();
  const current = readConfig();
  const curBanners = (current.marketing && current.marketing.banners) || {};

  // Cada slot (top/bottom) é independente: copia a imagem nova, remove a
  // existente, ou mantém a atual conforme o payload do slot.
  const saveSlot = (slotName) => {
    const cur = curBanners[slotName] || { enabled: false, image: null, url: '' };
    const p = (payload && payload[slotName]) || {};
    let image = cur.image || null;
    if (p.imageSourcePath) {
      if (!fs.existsSync(p.imageSourcePath)) throw new Error('Ficheiro de banner não encontrado: ' + p.imageSourcePath);
      deleteAssetIfInside(image);
      image = copyAssetToProject(p.imageSourcePath, 'banner-' + slotName);
    } else if (p.removeImage) {
      deleteAssetIfInside(image);
      image = null;
    }
    return {
      enabled: !!p.enabled,
      image,
      url: (typeof p.url === 'string') ? p.url.trim() : (cur.url || '')
    };
  };

  const updated = {
    ...current,
    marketing: {
      ...current.marketing,
      banners: { top: saveSlot('top'), bottom: saveSlot('bottom') }
    }
  };
  if (updated.marketing.banner) delete updated.marketing.banner;
  writeConfig(updated);
  return updated;
});

/* -------- IPC: content (Builder only) -------- */

function sanitizeModule(mod) {
  if (!mod || typeof mod !== 'object') return null;
  const type = ALL_TYPES.has(mod.type) ? mod.type : null;
  if (!type) return null;
  const id = (typeof mod.id === 'string' && mod.id.trim()) ? mod.id.trim() : crypto.randomUUID();
  const title = (typeof mod.title === 'string' && mod.title.trim()) ? mod.title.trim() : 'Sem título';
  const data = (mod.data && typeof mod.data === 'object') ? { ...mod.data } : {};
  const password = (typeof mod.password === 'string') ? mod.password.trim() : '';
  return { id, title, type, data, password };
}

function findModuleById(list, id) {
  return list.find((m) => m && m.id === id) || null;
}

/* Lista de caminhos (relativos) de assets usados por um módulo — cobre os
 * tipos de ficheiro único e a galeria (array de imagens). Usado para a
 * recolha de lixo (apagar ficheiros órfãos) ao guardar. */
function moduleAssetFiles(mod) {
  const out = [];
  if (!mod || !mod.data) return out;
  if (SINGLE_FILE_TYPES.has(mod.type) && mod.data.file) out.push(mod.data.file);
  if (GALLERY_TYPES.has(mod.type) && Array.isArray(mod.data.images)) {
    for (const img of mod.data.images) { if (img && img.file) out.push(img.file); }
  }
  return out;
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
    const d = mod.data || {};
    if (SINGLE_FILE_TYPES.has(mod.type)) {
      const sourcePath = typeof d.sourcePath === 'string' ? d.sourcePath : null;
      let file, fileName;
      if (sourcePath) {
        if (!fs.existsSync(sourcePath)) throw new Error('Ficheiro não encontrado: ' + sourcePath);
        if (prev && prev.data && prev.data.file) deleteAssetIfInside(prev.data.file);
        const prefix = mod.type === 'pdf' ? 'pdf'
          : mod.type === 'local-video' ? 'video'
          : mod.type === 'local-audio' ? 'audio'
          : mod.type === 'download-vault' ? 'download' : 'file';
        file = copyAssetToProject(sourcePath, prefix);
        fileName = path.basename(sourcePath);
      } else {
        file = (prev && prev.data && prev.data.file) || null;
        fileName = (prev && prev.data && prev.data.fileName) || null;
      }
      const out = { file, fileName };
      if (mod.type === 'download-vault') {
        out.buttonLabel = typeof d.buttonLabel === 'string' ? d.buttonLabel.trim() : '';
      }
      mod.data = out;
    } else if (GALLERY_TYPES.has(mod.type)) {
      // Aceita tanto a lista de edição (`items`, com sourcePath p/ novas) como
      // o estado já persistido (`images`) — evita apagar a galeria num re-save
      // (ex.: reordenar módulos), à imagem do cuidado com o duplo-save.
      let items = Array.isArray(d.items) ? d.items : null;
      if (!items && Array.isArray(d.images)) {
        items = d.images.map((i) => ({ file: i.file, fileName: i.fileName }));
      }
      items = items || [];
      const images = [];
      for (const it of items) {
        if (!it) continue;
        if (typeof it.sourcePath === 'string' && it.sourcePath) {
          if (!fs.existsSync(it.sourcePath)) continue;
          const rel = copyAssetToProject(it.sourcePath, 'img');
          images.push({ file: rel, fileName: path.basename(it.sourcePath) });
        } else if (typeof it.file === 'string' && it.file) {
          images.push({ file: it.file, fileName: it.fileName || path.basename(it.file) });
        }
      }
      mod.data = { images };
    } else if (mod.type === 'youtube') {
      mod.data = { url: toYoutubeEmbed(typeof d.url === 'string' ? d.url.trim() : '') };
    } else if (mod.type === 'webview' || mod.type === 'external' || mod.type === 'smart-embed') {
      mod.data = { url: typeof d.url === 'string' ? d.url.trim() : '' };
    } else if (mod.type === 'community-link') {
      mod.data = {
        url: typeof d.url === 'string' ? d.url.trim() : '',
        buttonLabel: typeof d.buttonLabel === 'string' ? d.buttonLabel.trim() : '',
        platform: typeof d.platform === 'string' ? d.platform.trim() : 'generic'
      };
    } else if (mod.type === 'html') {
      mod.data = { html: typeof d.html === 'string' ? d.html : '' };
    } else if (mod.type === 'article-reader') {
      mod.data = { text: typeof d.text === 'string' ? d.text : '' };
    } else {
      mod.data = {};
    }
    nextModules.push(mod);
  }
  // GC de assets órfãos em todos os tipos com ficheiros (único + galeria).
  const kept = new Set();
  for (const m of nextModules) for (const f of moduleAssetFiles(m)) kept.add(f);
  for (const prev of previous) {
    for (const f of moduleAssetFiles(prev)) { if (!kept.has(f)) deleteAssetIfInside(f); }
  }
  const updated = { ...current, content: nextModules };
  writeConfig(updated);
  return updated;
});

/* -------- IPC: file picker (Builder only) --------
 * Em Electron moderno, File.path foi removido do renderer por segurança, por
 * isso <input type="file"> deixou de expor o caminho real do ficheiro. Para
 * copiar ficheiros para dist-assets/ usamos o diálogo nativo no processo
 * principal e devolvemos o caminho absoluto ao renderer. */
const PICK_FILTERS = {
  image: [{ name: 'Imagens', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'] }],
  icon: [{ name: 'Ícone / Imagem', extensions: ['ico', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
  pdf: [{ name: 'PDF', extensions: ['pdf'] }],
  video: [{ name: 'Vídeo', extensions: ['mp4', 'webm', 'mov', 'm4v', 'ogv'] }],
  audio: [{ name: 'Áudio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] }],
  download: [{
    name: 'Ficheiros',
    extensions: ['zip', 'rar', '7z', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
      'txt', 'csv', 'epub', 'mobi', 'mp3', 'mp4', 'png', 'jpg']
  }],
  launch: [{
    name: 'Ficheiros',
    extensions: ['exe', 'zip', 'rar', '7z', 'msi', 'pdf', 'jpg', 'jpeg', 'png', 'gif',
      'mp4', 'mov', 'mp3', 'wav', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt']
  }]
};

function pickFilters(category) {
  return (PICK_FILTERS[category] || []).concat([{ name: 'Todos os ficheiros', extensions: ['*'] }]);
}

ipcMain.handle('dialog:pickFile', async (_event, category) => {
  assertBuilder();
  const result = await dialog.showOpenDialog(builderWindow, {
    properties: ['openFile'],
    filters: pickFilters(category)
  });
  if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  return { path: filePath, name: path.basename(filePath) };
});

ipcMain.handle('dialog:pickFiles', async (_event, category) => {
  assertBuilder();
  const result = await dialog.showOpenDialog(builderWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: pickFilters(category)
  });
  if (result.canceled || !Array.isArray(result.filePaths)) return [];
  return result.filePaths.map((p) => ({ path: p, name: path.basename(p) }));
});

/* Viewer: "Guardar como" para o módulo Cofre de Downloads. Copia o ficheiro
 * (que vive em dist-assets/) para o local escolhido pelo aluno. */
ipcMain.handle('dialog:saveFileAs', async (_event, payload) => {
  const rel = payload && typeof payload.file === 'string' ? payload.file : null;
  const suggested = (payload && typeof payload.fileName === 'string' && payload.fileName) || 'ficheiro';
  if (!rel) throw new Error('Ficheiro inválido.');
  const abs = resolveRelativeAsset(rel);
  // Validação de fronteira canónica (resolve + separador) — evita bypass por
  // confusão de prefixo (ex.: ../dist-assets-evil/x começa por "dist-assets").
  const real = abs ? path.resolve(abs) : null;
  const root = path.resolve(ASSETS_DIR) + path.sep;
  if (!real || !real.startsWith(root)) throw new Error('Caminho não permitido: ' + rel);
  if (!fs.existsSync(real)) throw new Error('Ficheiro não existe: ' + real);
  const win = BrowserWindow.getFocusedWindow() || viewerWindow || builderWindow;
  const result = await dialog.showSaveDialog(win, { defaultPath: suggested });
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
  fs.copyFileSync(real, result.filePath);
  return { ok: true, path: result.filePath };
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
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('URL inválido (apenas http/https): ' + trimmed);
  await shell.openExternal(trimmed);
  return true;
});

ipcMain.handle('shell:launchFile', async (_event, relativePath) => {
  if (typeof relativePath !== 'string' || !relativePath) throw new Error('Caminho de ficheiro vazio.');
  const abs = path.join(WRITE_BASE, relativePath);
  if (!isInsideAssetsDir(abs)) throw new Error('Caminho não permitido: ' + relativePath);
  if (!fs.existsSync(abs)) throw new Error('Ficheiro não existe: ' + abs);
  const errMsg = await shell.openPath(abs);
  if (errMsg) throw new Error(errMsg);
  return true;
});

/* -------- IPC: export (Builder only) — SFX pipeline -------- */

const ICON_ALLOWED_EXTS = ['.ico', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
const ICON_SOURCE_NAMES = ICON_ALLOWED_EXTS.map((e) => 'icon-source' + e);

function clearStoredIcons() {
  // Remove qualquer ícone-fonte anterior (qualquer extensão) e o legado icon.ico.
  for (const f of ICON_SOURCE_NAMES) {
    const p = path.join(DATA_DIR, f);
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (_) { /* ignore */ } }
  }
  if (fs.existsSync(ICON_DEST_PATH)) { try { fs.unlinkSync(ICON_DEST_PATH); } catch (_) { /* ignore */ } }
}

ipcMain.handle('export:saveIcon', (_event, payload) => {
  assertBuilder();
  ensureDirs();

  // Remover o ícone personalizado (volta ao predefinido).
  if (payload && payload.removeIcon) {
    clearStoredIcons();
    const current = readConfig();
    const updated = { ...current, export: { ...(current.export || {}), iconPath: null } };
    writeConfig(updated);
    return updated;
  }

  if (!payload || !payload.sourcePath) throw new Error('Caminho do ícone em falta.');
  if (!fs.existsSync(payload.sourcePath)) throw new Error('Ficheiro de ícone não encontrado.');
  const ext = path.extname(payload.sourcePath).toLowerCase();
  if (!ICON_ALLOWED_EXTS.includes(ext)) {
    throw new Error('O ícone tem de ser .ico, .png, .jpg, .gif, .webp ou .bmp');
  }
  clearStoredIcons();
  const destName = 'icon-source' + ext;
  fs.copyFileSync(payload.sourcePath, path.join(DATA_DIR, destName));
  const current = readConfig();
  const updated = { ...current, export: { ...(current.export || {}), iconPath: 'data/' + destName } };
  writeConfig(updated);
  return updated;
});

// Guard against re-entrant export invocations from a double-click.
let exportBusy = false;

ipcMain.handle('export:buildExe', async (event, payload) => {
  assertBuilder();
  // True re-entrancy guard: claim the lock BEFORE any async work (including
  // the save dialog), so two rapid clicks can't both pass the check and
  // open concurrent dialogs / interleaved exports.
  if (exportBusy) throw new Error('Já existe uma exportação em curso.');
  exportBusy = true;

  const send = (msg, kind = 'info') => {
    try { event.sender.send('export:log', { msg, kind }); } catch (_) { /* window closed */ }
  };

  const stamp = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const stagingRoot = path.join(os.tmpdir(), 'lbpro-stage-' + stamp);
  const archivePath = path.join(os.tmpdir(), 'lbpro-payload-' + stamp + '.7z');
  const sfxCfgPath = path.join(os.tmpdir(), 'lbpro-sfx-' + stamp + '.txt');
  const iconTmpDir = path.join(os.tmpdir(), 'lbpro-icon-' + stamp);

  try {
    // Platform guard: 7za.exe is a Windows binary, the SFX header is for PE
    // (Windows executable) format — running this on macOS/Linux can produce
    // bytes but the resulting "exe" won't run on Windows reliably either.
    if (process.platform !== 'win32') {
      throw new Error('A exportação SFX só funciona em Windows. Execute o Construtor num PC Windows.');
    }

    if (!hasProject()) {
      throw new Error('Sem projeto para exportar. Guarde primeiro pelo menos uma definição no Construtor.');
    }

    const sfxBinDir = getSfxBinDir();
    const sevenZipExe = path.join(sfxBinDir, '7za.exe');
    const sfxStub = path.join(sfxBinDir, '7zsd_All_x64.sfx');
    const templateDir = getViewerTemplateDir();
    const templateExe = path.join(templateDir, 'LaunchBox Viewer.exe');

    // Pre-flight checks with very specific error messages — these are the
    // most common reasons exports fail on a fresh dev setup.
    if (!fs.existsSync(sevenZipExe)) {
      throw new Error('Binário 7za.exe em falta em ' + sfxBinDir + '. Verifique src/builder/bin/ — os binários SFX são commitados no repositório (ver src/builder/bin/README.md).');
    }
    if (!fs.existsSync(sfxStub)) {
      throw new Error('SFX 7zsd_All_x64.sfx em falta em ' + sfxBinDir + '. Siga as instruções em src/builder/bin/README.md');
    }
    if (!fs.existsSync(templateExe)) {
      throw new Error('Template do Viewer em falta em ' + templateDir + '. Execute primeiro: npm run build:viewer-template');
    }
    // O código do Viewer vive em resources/app.asar.bin (renomeado pelo prune
    // para sobreviver ao electron-builder). Aceitamos também app.asar legado.
    if (!fs.existsSync(path.join(templateDir, 'resources', 'app.asar.bin'))
      && !fs.existsSync(path.join(templateDir, 'resources', 'app.asar'))) {
      throw new Error('Template do Viewer incompleto: falta resources/app.asar(.bin) em ' + templateDir + '. Reconstrua: npm run build:viewer-template');
    }

    const defaultName = sanitizeFilename((payload && payload.defaultName) || 'meu-curso');
    const result = await dialog.showSaveDialog(builderWindow, {
      title: 'Guardar Curso (.exe)',
      defaultPath: defaultName + '.exe',
      filters: [{ name: 'Curso (.exe)', extensions: ['exe'] }]
    });
    if (result.canceled || !result.filePath) {
      send('Operação cancelada.', 'info');
      return { ok: false, cancelled: true };
    }
    let target = result.filePath;
    if (!target.toLowerCase().endsWith('.exe')) target += '.exe';

    /* 1. Stage = copy Viewer template (LaunchBox Viewer.exe + DLLs + asar). */
    send('A copiar template do Viewer…');
    fs.mkdirSync(stagingRoot, { recursive: true });
    copyDirRecursive(templateDir, stagingRoot);

    /* O template guarda o código do Viewer como resources/app.asar.bin (ver
     * scripts/prune-viewer-template.js — contorna o electron-builder, que
     * descarta ficheiros app.asar ao copiar via extraResources). Repor o nome
     * real para o Electron do curso o carregar no arranque. */
    const stagedAsarBin = path.join(stagingRoot, 'resources', 'app.asar.bin');
    const stagedAsar = path.join(stagingRoot, 'resources', 'app.asar');
    if (fs.existsSync(stagedAsarBin)) {
      if (fs.existsSync(stagedAsar)) fs.rmSync(stagedAsar, { force: true });
      fs.renameSync(stagedAsarBin, stagedAsar);
    } else if (!fs.existsSync(stagedAsar)) {
      throw new Error('Template do Viewer sem app.asar após a cópia. Reconstrua: npm run build:viewer-template');
    }

    /* 2. Inject the current project under <stage>/resources/ so the Viewer
     *    finds it at process.resourcesPath/data/* exactly like in dev. */
    send('A injectar configuração do curso…');
    const stageResources = path.join(stagingRoot, 'resources');
    if (!fs.existsSync(stageResources)) fs.mkdirSync(stageResources, { recursive: true });
    const stageData = path.join(stageResources, 'data');
    const stageAssets = path.join(stageResources, 'dist-assets');
    fs.mkdirSync(stageData, { recursive: true });
    fs.mkdirSync(stageAssets, { recursive: true });
    fs.copyFileSync(CONFIG_PATH, path.join(stageData, 'project-config.json'));
    if (fs.existsSync(ASSETS_DIR)) {
      for (const name of fs.readdirSync(ASSETS_DIR)) {
        const src = path.join(ASSETS_DIR, name);
        try {
          if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(stageAssets, name));
        } catch (_) { /* skip unreadable */ }
      }
    }

    /* 3. Compress the staging tree into a .7z payload. Compressão ultra
     *    LZMA2 (-mx=9 -md=64m -mfb=64) para minimizar o tamanho do .exe
     *    final do curso (~60-70 MB típico) e reduzir o tempo de extracção
     *    em %TEMP% no PC do aluno. -mmt=on usa múltiplos núcleos. */
    send('A comprimir conteúdos com compressão máxima (pode demorar)…');
    await execFileP(sevenZipExe, [
      'a', '-t7z',
      '-m0=lzma2', '-mx=9', '-md=64m', '-mfb=64',
      '-mmt=on', '-bsp0', '-bso0',
      archivePath, stagingRoot + path.sep + '*'
    ], { maxBuffer: 1024 * 1024 * 64, windowsHide: true });

    /* 4. Build the SFX config. These directives target the chrislake/
     *    7zsfxmm fork (7zsd_All_x64.sfx). %%T = the per-run temp folder
     *    chosen by the SFX (auto-cleaned on RunProgram exit). GUIMode=2
     *    suppresses the extraction UI. The quoted RunProgram path lets
     *    the Viewer exe name contain a space ("LaunchBox Viewer.exe"). */
    send('A construir o executável SFX…');
    const sfxConfig =
      ';!@Install@!UTF-8!\r\n' +
      'GUIMode="2"\r\n' +
      'OverwriteMode="2"\r\n' +
      'RunProgram="\\"%%T\\\\LaunchBox Viewer.exe\\""\r\n' +
      ';!@InstallEnd@!\r\n';
    fs.writeFileSync(sfxCfgPath, sfxConfig, { encoding: 'utf-8' });

    /* 5. Ícone personalizado: aplica-o a uma cópia temporária do stub SFX
     *    ANTES da concatenação. O ícone do .exe final vem do stub, não de
     *    win.icon. Sem ícone definido (ou em caso de falha) usa-se o stub
     *    original. */
    let stubToUse = sfxStub;
    const cfgForIcon = readConfig();
    const iconRel = cfgForIcon.export && cfgForIcon.export.iconPath;
    if (iconRel) {
      const iconAbs = path.join(WRITE_BASE, iconRel);
      if (fs.existsSync(iconAbs)) {
        send('A aplicar o ícone personalizado ao executável…');
        stubToUse = await stampSfxIcon(sfxStub, iconAbs, iconTmpDir, send);
      }
    }

    /* 6. The single-file magic: SFX stub + config + 7z payload, concatenated
     *    in that order, IS a valid Windows .exe that auto-extracts + runs. */
    await concatFilesToTarget([stubToUse, sfxCfgPath, archivePath], target);

    send('Curso guardado: ' + target, 'success');
    return { ok: true, path: target };
  } catch (err) {
    send('Erro: ' + (err && err.message ? err.message : err), 'error');
    throw err;
  } finally {
    exportBusy = false;
    try { if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch (_) {}
    try { if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath); } catch (_) {}
    try { if (fs.existsSync(sfxCfgPath)) fs.unlinkSync(sfxCfgPath); } catch (_) {}
    try { if (fs.existsSync(iconTmpDir)) fs.rmSync(iconTmpDir, { recursive: true, force: true }); } catch (_) {}
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
  if (!fs.existsSync(filePath)) throw new Error('Ficheiro de tradução em falta: ' + safeLang);
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
