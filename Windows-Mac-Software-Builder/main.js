const { app, BrowserWindow, ipcMain, shell, dialog, Menu, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const iptvCipher = require('./src/shared/iptv-cipher');
const localWeb = require('./src/shared/local-web');
const projectExport = require('./src/shared/project-export');
const projectArchive = require('./src/shared/project-archive');
const portableApps = require('./src/shared/portable-app');
const portableRuntime = require('./src/shared/portable-runtime');
const androidRuntime = require('./src/shared/android-runtime');
const { isTrustedFrame, lockGuestPreferences, configureGuestNavigation } = require('./src/shared/electron-security');
const { fileURLToPath } = require('url');

// Only our own top-level UI may call privileged IPC. Embedded pages have no bridge.
const VIEWER_CHANNELS = new Set([
  'config:load', 'asset:resolve', 'shell:openExternal', 'shell:launchFile',
  'portable:launch', 'portable:configureWine', 'android:status',
  'dialog:saveFileAs', 'i18n:loadLocale', 'youtube:hostUrl', 'iptv:hosts',
  'iptv:hasFfmpeg', 'iptv:proxyUrl', 'iptv:proxyStatus', 'iptv:proxyStop',
  'favs:load', 'favs:save', 'state:load', 'state:save', 'web:open', 'web:close'
]);
function handleTrustedIpc(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    const fromBuilder = isTrustedFrame(event, builderWindow, path.join(__dirname, 'src/builder/index.html'));
    const fromViewer = VIEWER_CHANNELS.has(channel)
      && isTrustedFrame(event, viewerWindow, path.join(__dirname, 'src/viewer/index.html'));
    if (!fromBuilder && !fromViewer) throw new Error('Origem IPC não autorizada.');
    return handler(event, ...args);
  });
}


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
    // macOS app bundles must remain immutable: writing caches inside a signed
    // .app invalidates it and fails in read-only/Applications locations.
    const cacheDir = process.platform === 'darwin'
      ? path.join(app.getPath('appData'), 'LaunchBox Viewer', crypto.createHash('sha256').update(exeDir).digest('hex').slice(0, 20))
      : path.join(exeDir, '.electron-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    app.setPath('userData', cacheDir);
  }
} else {
  app.setName('LaunchBox Builder');
}

/* O User-Agent predefinido do Electron inclui "LaunchBox Viewer/1.x" e
 * "Electron/32". O YouTube (e outros serviços Google) servem um leitor
 * degradado ou recusam a reprodução a agentes desconhecidos — uma das causas
 * do vídeo do YouTube não abrir. Apresentamo-nos como o Chrome equivalente
 * (mesma versão de motor), tanto na janela como nos <webview>. */
app.userAgentFallback = 'Mozilla/5.0 (' + (process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'Windows NT 10.0; Win64; x64') + ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/'
  + process.versions.chrome + ' Safari/537.36';

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
function macProjectDirectory(resourcesPath) {
  const bundle = path.resolve(resourcesPath, '..', '..');
  const name = path.basename(bundle).replace(/\.app$/i, '');
  return path.join(path.dirname(bundle), name + '.data');
}
let WRITE_BASE = (() => {
  if (!app.isPackaged) return PROJECT_ROOT;
  if (isViewer && process.platform === 'darwin') return macProjectDirectory(process.resourcesPath);
  if (isViewer) return process.resourcesPath;
  return app.getPath('userData');
})();

/* Estes quatro apontam para o PROJETO ATIVO.
 * No Viewer ficam sempre no layout "plano" (WRITE_BASE/data, WRITE_BASE/dist-assets),
 * exatamente como o SFX injeta o curso. No Builder são recalculados por
 * applyActiveProjectPaths() para projects/<id>/… (ver secção PROJETOS). */
let DATA_DIR = path.join(WRITE_BASE, 'data');
let ASSETS_DIR = path.join(WRITE_BASE, 'dist-assets');
let CONFIG_PATH = path.join(DATA_DIR, 'project-config.json');
let ICON_DEST_PATH = path.join(DATA_DIR, 'icon.ico');

/* =========================================================
 * FAVORITOS IPTV DO ALUNO (persistentes)
 *
 * O Viewer exportado corre a partir de uma pasta %TEMP% descartável e o seu
 * userData (localStorage incluído) é apagado quando o aluno fecha o curso —
 * é por isso que os favoritos guardados só em localStorage desapareciam.
 * Os favoritos são a única coisa que tem de sobreviver, por isso ficam FORA
 * dessa pasta, num JSON por curso+módulo:
 *   Viewer exportado → %AppData%\LaunchBox Viewer\favorites\<slug>-<hash>.json
 *   Builder / dev    → <userData>\viewer-favorites\<slug>-<hash>.json
 * ========================================================= */
const FAVS_DIR = (isViewer && app.isPackaged)
  ? path.join(app.getPath('appData'), app.getName(), 'favorites')
  : path.join(app.getPath('userData'), 'viewer-favorites');

function favsFilePath(key) {
  const raw = (typeof key === 'string') ? key.slice(0, 512) : '';
  if (!raw) throw new Error('Chave de favoritos inválida.');
  // O nome legível é só para inspeção humana; a unicidade vem do hash da
  // chave completa (títulos com acentos/outros alfabetos não colidem).
  const slug = raw.replace(/^lbxIptvFav::/, '').replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 60) || 'favs';
  const hash = crypto.createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 12);
  return path.join(FAVS_DIR, slug + '-' + hash + '.json');
}

function sanitizeFavs(data) {
  const folders = (data && Array.isArray(data.folders)) ? data.folders : [];
  const out = [];
  for (const f of folders.slice(0, 500)) {
    if (!f || typeof f !== 'object') continue;
    const id = (typeof f.id === 'string') ? f.id.slice(0, 64) : '';
    const name = (typeof f.name === 'string') ? f.name.slice(0, 200) : '';
    if (!id || !name) continue;
    const keys = Array.isArray(f.keys)
      ? Array.from(new Set(f.keys.filter((k) => typeof k === 'string' && k))).slice(0, 5000)
      : [];
    out.push({ id, name, keys, _open: f._open === true });
  }
  return { folders: out };
}

handleTrustedIpc('favs:load', (_event, key) => {
  try {
    const file = favsFilePath(key);
    if (!fs.existsSync(file)) return null;
    return sanitizeFavs(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch (_) {
    return null; // ficheiro corrompido/ilegível → o Viewer começa sem favoritos
  }
});

handleTrustedIpc('favs:save', (_event, payload) => {
  const file = favsFilePath(payload && payload.key);
  const clean = sanitizeFavs(payload && payload.data);
  fs.mkdirSync(FAVS_DIR, { recursive: true });
  // Escrita atómica (tmp + rename): um fecho abrupto nunca deixa o ficheiro
  // meio-escrito, que depois falharia no JSON.parse e "perderia" tudo.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean), 'utf-8');
  fs.renameSync(tmp, file);
  return true;
});

/* Estado leve do aluno por curso (último módulo aberto). Mesmo diretório e
 * mesma escrita atómica dos favoritos; só se guardam campos conhecidos. */
function sanitizeViewerState(data) {
  const out = {};
  if (data && typeof data.lastModuleId === 'string') out.lastModuleId = data.lastModuleId.slice(0, 64);
  return out;
}
handleTrustedIpc('state:load', (_event, key) => {
  try {
    const file = favsFilePath(key);
    if (!fs.existsSync(file)) return null;
    return sanitizeViewerState(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch (_) { return null; }
});
handleTrustedIpc('state:save', (_event, payload) => {
  const file = favsFilePath(payload && payload.key);
  let current = {};
  try { if (fs.existsSync(file)) current = sanitizeViewerState(JSON.parse(fs.readFileSync(file, 'utf-8'))); } catch (_) { current = {}; }
  const clean = sanitizeViewerState(Object.assign({}, current, payload && payload.data));
  fs.mkdirSync(FAVS_DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean), 'utf-8');
  fs.renameSync(tmp, file);
  return true;
});

/* Multi-projeto (apenas Builder). Cada projeto tem a sua própria pasta
 * projects/<id>/{data,dist-assets}; o índice guarda nomes e o projeto ativo. */
const PROJECTS_ROOT = path.join(WRITE_BASE, 'projects');
const PROJECTS_INDEX = path.join(WRITE_BASE, 'projects.json');

function runtimeDirectory(runtime) {
  if (app.isPackaged) {
    // Optional runtimes live beside the immutable signed Mac Viewer. This
    // lets either OS export only the components its project actually uses.
    if (isViewer && process.platform === 'darwin') {
      const companion = path.join(WRITE_BASE, runtime);
      if (fs.existsSync(companion)) return companion;
    }
    return path.join(process.resourcesPath, runtime);
  }
  const target = process.platform === 'darwin' ? 'mac-universal' : 'windows-x64';
  const specific = path.join(PROJECT_ROOT, 'vendor', runtime, target);
  return fs.existsSync(specific) ? specific : path.join(PROJECT_ROOT, 'vendor', runtime);
}
const webRuntime = localWeb.createWebRuntime({
  getPhpPath: () => path.join(runtimeDirectory('php'), process.platform === 'win32' ? 'php.exe' : 'php')
});
const stopWebModules = () => webRuntime.closeAll().catch((err) => console.warn('Web cleanup:', err.message));

handleTrustedIpc('android:status', (_event, payload) => androidRuntime.getAndroidRuntimeStatus({
  audience: isViewer ? 'viewer' : 'creator',
  locale: payload && typeof payload.locale === 'string' ? payload.locale.slice(0, 8) : 'pt'
}));


const SINGLE_FILE_TYPES = new Set(['pdf', 'launch', 'local-video', 'local-audio', 'download-vault', 'archive-download']);
const GALLERY_TYPES = new Set(['image-gallery']);
const ALL_TYPES = new Set([
  'youtube', 'html', 'pdf', 'webview', 'external', 'launch',
  'local-video', 'local-audio', 'download-vault', 'archive-download', 'image-gallery',
  'article-reader', 'smart-embed', 'iptv', 'local-web', 'portable'
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
  return path.join(PROJECT_ROOT, 'src', 'builder', 'templates', 'viewer-core', 'win-unpacked');
}
function getExportTemplatePath(target) {
  const root = app.isPackaged ? process.resourcesPath : path.join(PROJECT_ROOT, 'dist');
  return path.join(root, 'export-templates', target === 'mac' ? 'mac-universal.zip' : 'windows-x64.zip');
}
function exportTargets() {
  const windowsTemplate = fs.existsSync(getExportTemplatePath('windows'));
  const legacy = fs.existsSync(path.join(getViewerTemplateDir(), 'LaunchBox Viewer.exe'));
  const sfx = process.platform === 'win32' && fs.existsSync(path.join(getSfxBinDir(), '7za.exe'))
    && fs.existsSync(path.join(getSfxBinDir(), '7zsd_All_x64.sfx'));
  // A mixed portable folder may contain Mac framework symlinks. ZIP preserves
  // them; the Windows SFX extractor cannot reliably recreate those links.
  let portableLinks = false;
  try {
    portableLinks = (readConfig().content || []).some((mod) => mod.type === 'portable'
      && portableApps.validatePortableProject({ data: mod.data, assetsDir: ASSETS_DIR }).hasSymlinks);
  } catch (_) { /* The export itself reports the invalid project precisely. */ }
  return { hostPlatform: process.platform, targets: [
    { id: 'windows', available: windowsTemplate || (sfx && legacy && !portableLinks), format: sfx && !portableLinks ? 'exe' : 'zip',
      reason: windowsTemplate || (sfx && legacy && !portableLinks) ? '' : 'Template Windows em falta. Reinstale o construtor ou prepare export-templates/windows-x64.zip.' },
    { id: 'mac', available: fs.existsSync(getExportTemplatePath('mac')), format: 'zip',
      reason: fs.existsSync(getExportTemplatePath('mac')) ? '' : 'Template Mac em falta. Reinstale o construtor ou prepare export-templates/mac-universal.zip.' }
  ] };
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
    },
    social: {
      site: '', instagram: '', facebook: '', x: '', tiktok: '',
      pinterest: '', linkedin: '', spotify: '', whatsapp: '', telegram: ''
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

/* =========================================================
 * PROJETOS (apenas Builder)
 *
 * Índice em WRITE_BASE/projects.json:
 *   { activeId, projects: [ { id, name, createdAt, updatedAt } ] }
 * Cada projeto vive em projects/<id>/{data,dist-assets}. As constantes
 * DATA_DIR/ASSETS_DIR/CONFIG_PATH/ICON_DEST_PATH são reapontadas para o
 * projeto ativo por applyActiveProjectPaths(). O Viewer nunca passa por aqui.
 * ========================================================= */
function genProjectId() {
  return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function projectDir(id) {
  return path.join(PROJECTS_ROOT, id);
}

function sanitizeProjectName(name) {
  const s = String(name || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
  return s || 'Projeto sem nome';
}

function applyActiveProjectPaths(id) {
  stopWebModules();
  const dir = projectDir(id);
  DATA_DIR = path.join(dir, 'data');
  ASSETS_DIR = path.join(dir, 'dist-assets');
  CONFIG_PATH = path.join(DATA_DIR, 'project-config.json');
  ICON_DEST_PATH = path.join(DATA_DIR, 'icon.ico');
}

function createProjectFolder(id) {
  fs.mkdirSync(path.join(projectDir(id), 'data'), { recursive: true });
  fs.mkdirSync(path.join(projectDir(id), 'dist-assets'), { recursive: true });
}

function readProjectsIndex() {
  try {
    if (!fs.existsSync(PROJECTS_INDEX)) return { activeId: null, projects: [] };
    const idx = JSON.parse(fs.readFileSync(PROJECTS_INDEX, 'utf-8'));
    const ids = new Set();
    if (!idx || typeof idx !== 'object' || !Array.isArray(idx.projects) ||
        (idx.activeId !== null && typeof idx.activeId !== 'string')) throw new Error('Formato do índice inválido.');
    for (const project of idx.projects) {
      if (!project || typeof project.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(project.id) ||
          ids.has(project.id) || typeof project.name !== 'string') throw new Error('Projeto inválido no índice.');
      ids.add(project.id);
    }
    return idx;
  } catch (err) {
    throw new Error(`Não foi possível ler ${PROJECTS_INDEX}. O ficheiro foi preservado; corrija-o ou restaure uma cópia de segurança. ${err.message}`);
  }
}

function writeProjectsIndex(idx) {
  fs.mkdirSync(WRITE_BASE, { recursive: true });
  const temp = PROJECTS_INDEX + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(idx, null, 2), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temp, PROJECTS_INDEX);
  } finally { try { fs.unlinkSync(temp); } catch (_) {} }
}

/* Move o conteúdo de srcDir para destDir (usado só na migração inicial do
 * layout antigo de projeto único). Tolerante a cross-device. */
function moveDirContents(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    const from = path.join(srcDir, name);
    const to = path.join(destDir, name);
    try {
      fs.renameSync(from, to);
    } catch (_) {
      try {
        const st = fs.statSync(from);
        if (st.isDirectory()) { copyDirRecursive(from, to); fs.rmSync(from, { recursive: true, force: true }); }
        else { fs.copyFileSync(from, to); fs.unlinkSync(from); }
      } catch (err2) { console.warn('Falha a migrar', from, err2); }
    }
  }
  try { fs.rmdirSync(srcDir); } catch (_) { /* pode não estar vazia — ignora */ }
}

function projectsState() {
  const idx = readProjectsIndex();
  const projects = idx.projects
    .map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt || p.createdAt || 0 }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { activeId: idx.activeId, projects };
}

function touchActiveProject() {
  if (isViewer) return;
  try {
    const idx = readProjectsIndex();
    const p = idx.projects.find((x) => x.id === idx.activeId);
    if (p) { p.updatedAt = Date.now(); writeProjectsIndex(idx); }
  } catch (err) { console.warn('Falha a atualizar updatedAt do projeto:', err); }
}

/* Arranque do Builder: garante que existe pelo menos um projeto, copia o
 * layout antigo para o primeiro projeto preservando o original como backup,
 * e aponta as constantes para o projeto ativo após validar a configuração. */
function initProjects() {
  let idx = readProjectsIndex();

  if (idx.projects.length === 0) {
    const id = genProjectId();
    const legacyDataDir = path.join(WRITE_BASE, 'data');
    const legacyAssetsDir = path.join(WRITE_BASE, 'dist-assets');
    const legacyConfig = path.join(legacyDataDir, 'project-config.json');
    try {
      createProjectFolder(id);
      // Keep the legacy copy until the new index has committed successfully.
      if (fs.existsSync(legacyConfig)) {
        const legacy = readConfig(legacyConfig);
        copyDirRecursive(legacyDataDir, path.join(projectDir(id), 'data'));
        if (fs.existsSync(legacyAssetsDir)) copyProjectAssets(legacyAssetsDir, path.join(projectDir(id), 'dist-assets'), legacy);
      } else {
        fs.writeFileSync(path.join(projectDir(id), 'data', 'project-config.json'), JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
      }
      const now = Date.now();
      idx = { activeId: id, projects: [{ id, name: 'Projeto 1', createdAt: now, updatedAt: now }] };
      writeProjectsIndex(idx);
    } catch (error) {
      try { fs.rmSync(projectDir(id), { recursive: true, force: true }); } catch (_) {}
      throw error;
    }
    // Retain the original legacy folders as a migration backup.
  }

  if (!idx.activeId || !idx.projects.some((p) => p.id === idx.activeId)) {
    idx.activeId = idx.projects[0].id;
    writeProjectsIndex(idx);
  }

  readConfig(path.join(projectDir(idx.activeId), 'data', 'project-config.json'));
  applyActiveProjectPaths(idx.activeId);
  ensureDirs();
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

function validateConfigShape(config) {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(config)) throw new Error('A configuração deve ser um objeto JSON.');
  function check(defaults, value, key) {
    if (value === undefined) return;
    if (defaults === null) {
      if (value !== null && typeof value !== 'string') throw new Error(`Definição inválida: ${key}.`);
    } else if (Array.isArray(defaults)) {
      if (!Array.isArray(value)) throw new Error(`Definição inválida: ${key}.`);
    } else if (record(defaults)) {
      if (!record(value)) throw new Error(`Definição inválida: ${key}.`);
      for (const child of Object.keys(defaults)) check(defaults[child], value[child], `${key}.${child}`);
    } else if (typeof value !== typeof defaults) throw new Error(`Definição inválida: ${key}.`);
  }
  check(DEFAULT_CONFIG, config, 'config');
  for (const mod of config.content || []) {
    if (!record(mod) || typeof mod.type !== 'string' || (mod.data !== undefined && !record(mod.data))) {
      throw new Error('Módulo inválido na configuração.');
    }
  }
  return config;
}

function readConfig(configPath = CONFIG_PATH) {
  try {
    const parsed = validateConfigShape(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    return migrateConfig(deepMerge(DEFAULT_CONFIG, parsed));
  } catch (err) {
    throw new Error(`Não foi possível ler ${configPath}. O projeto não foi alterado; corrija o ficheiro ou restaure uma cópia de segurança. ${err.message}`);
  }
}

function writeConfig(config) {
  if (isViewer) throw new Error('Viewer não pode escrever configuração.');
  ensureDirs();
  const temp = CONFIG_PATH + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(config, null, 2), 'utf-8');
    fs.renameSync(temp, CONFIG_PATH);
  } finally {
    try { fs.unlinkSync(temp); } catch (_) {}
  }
  // The config is already committed; an index timestamp failure must not roll back its assets.
  try { touchActiveProject(); } catch (err) { console.warn('Project timestamp:', err.message); }
}

function sanitizeFilename(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._ -]/g, '_').trim() || 'curso';
}

function copyAssetToProject(sourcePath, prefix = 'asset') {
  ensureDirs();
  const ext = path.extname(sourcePath) || '';
  const base = sanitizeFilename(path.basename(sourcePath, ext)) || prefix;
  const finalName = `${prefix}-${crypto.randomUUID()}-${base}${ext}`;
  const destAbs = path.join(ASSETS_DIR, finalName);
  try { fs.copyFileSync(sourcePath, destAbs, fs.constants.COPYFILE_EXCL); }
  catch (error) { try { fs.unlinkSync(destAbs); } catch (_) {} throw error; }
  return path.posix.join('dist-assets', finalName);
}

function cleanupFiles(files) {
  for (const filename of new Set(files)) {
    try { fs.unlinkSync(filename); }
    catch (error) { if (error.code !== 'ENOENT') console.warn('Falha a limpar recurso:', filename, error.message); }
  }
}

function commitConfigFiles(config, created, retired) {
  try { writeConfig(config); }
  catch (error) { cleanupFiles(created); throw error; }
  cleanupFiles(retired.filter(filename => !created.includes(filename)));
  return config;
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

/* Converte um caminho relativo do config ("dist-assets/x", "data/y") no
 * caminho absoluto do PROJETO ATIVO. No Viewer, DATA_DIR/ASSETS_DIR já são o
 * layout plano, portanto o resultado é idêntico ao antigo path.join(WRITE_BASE,…). */
function relToAbs(relativePath) {
  const norm = String(relativePath || '').replace(/\\/g, '/');
  if (norm.startsWith('dist-assets/')) return path.join(ASSETS_DIR, norm.slice('dist-assets/'.length));
  if (norm.startsWith('data/')) return path.join(DATA_DIR, norm.slice('data/'.length));
  return path.join(WRITE_BASE, relativePath);
}

function deleteAssetIfInside(relativePath) {
  if (!relativePath) return;
  const abs = relToAbs(relativePath);
  try {
    resolveProjectFile(relativePath);
    try { fs.unlinkSync(abs); } catch (err) { console.warn('Failed to delete old asset:', err); }
  } catch (_) { /* Missing or unsafe references must never delete other files. */ }
}

function resolveRelativeAsset(relativePath) {
  if (!relativePath) return null;
  return relToAbs(relativePath);
}

function resolveProjectFile(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) throw new Error('Caminho de ficheiro inválido.');
  const absolute = relToAbs(relativePath);
  const root = fs.realpathSync(ASSETS_DIR);
  const real = fs.realpathSync(absolute);
  const relative = path.relative(root, real);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !fs.statSync(real).isFile()) {
    throw new Error('Caminho não permitido: ' + relativePath);
  }
  return real;
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
    else throw new Error('Recurso não suportado (ligação simbólica ou ficheiro especial): ' + s);
  }
}

function copyProjectAssets(src, dest, config) {
  const portableRoots = new Map();
  for (const mod of config.content || []) {
    if (mod.type !== 'portable') continue;
    const validated = portableApps.validatePortableProject({ data: mod.data, assetsDir: src });
    portableRoots.set(path.basename(validated.rootPath), validated.rootPath);
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (portableRoots.has(entry.name)) portableApps.copyPortableTree(from, to);
    else if (entry.isDirectory()) copyDirRecursive(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
    else throw new Error('Recurso não suportado: ' + from);
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


// A webview's HTML attributes must never grant Node/preload privileges.
function secureEmbeddedContent(win) {
  const localWebSessions = new WeakSet();
  const allowed = (value) => {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'http:') return true;
      if (url.protocol !== 'file:') return false;
      const file = fs.realpathSync(fileURLToPath(url));
      return isInsideAssetsDir(file) && path.extname(file).toLowerCase() === '.pdf';
    } catch (_) { return false; }
  };
  win.webContents.on('will-attach-webview', (event, preferences, params) => {
    lockGuestPreferences(preferences);
    if (!allowed(params.src)) { event.preventDefault(); return; }
    const partition = params.partition || preferences.partition;
    if (typeof partition === 'string' && partition.startsWith('local-web-')) {
      localWebSessions.add(session.fromPartition(partition));
    }
  });
  win.webContents.on('did-attach-webview', (_event, guest) => {
    guest.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    guest.session.setPermissionCheckHandler(() => false);
    configureGuestNavigation(guest, {
      isLocalWeb: localWebSessions.has(guest.session),
      allowed,
      openExternal: (url) => shell.openExternal(url),
      onError: (error) => console.warn('Could not open external link:', error.message)
    });
  });
}

function createBuilderWindow() {
  builderWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 1024, minHeight: 680,
    title: 'Windows & Mac Software Builder',
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
  secureEmbeddedContent(builderWindow);
  builderWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  builderWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // A renderer crash must provide recovery instead of trapping the user in a
  // blank window. Recovery reloads the editor; committed project files survive.
  const window = builderWindow;
  window.webContents.on('render-process-gone', async (_event, details) => {
    if (window.isDestroyed() || details.reason === 'clean-exit') return;
    console.error('[builder] renderer terminated:', details.reason, details.exitCode);
    try {
    const result = await dialog.showMessageBox(window, {
      type: 'error', title: 'Recuperar o editor',
      message: 'O editor deixou de responder. Os projetos guardados foram preservados.',
      detail: 'Pode reabrir o editor sem fechar a aplicação. Alterações que ainda não tinham sido guardadas poderão ter de ser repetidas.',
      buttons: ['Reabrir editor', 'Fechar'], defaultId: 0, cancelId: 1
    });
    if (window.isDestroyed()) return;
    if (result.response === 0) await window.loadFile(path.join(__dirname, 'src/builder/index.html'));
    else window.close();
    } catch (error) { console.error('[builder] recovery failed:', error.message); }
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
  if (img.isEmpty()) throw new Error('Imagem de ícone inválida ou formato não suportado (use .png, .jpg ou .ico): ' + sourceAbs);
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
    stopWebModules();
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

  /* YouTube: ver ensureYoutubeHost() — o leitor é embutido a partir de uma
   * página servida em http://127.0.0.1, uma origem web real que o YouTube
   * aceita. (O antigo gancho que forçava Referer/Origin=youtube.com continuava
   * a dar "Erro 152-4 / vídeo não disponível" e foi removido.) */

  /* IPTV / streaming: a página do Viewer corre em file:// (origem "null"), por
   * isso os pedidos do hls.js aos segmentos .m3u8/.ts remotos seriam bloqueados
   * por CORS (a maioria dos servidores IPTV não envia Access-Control-Allow-Origin).
   * Injetamos o cabeçalho na resposta para permitir a reprodução. Mantém-se o
   * webSecurity ligado. Limitamos o override APENAS a pedidos de média/stream
   * (o hls.js usa XHR; o <video> nativo usa 'media'), para não enfraquecer o
   * CORS dos restantes recursos (páginas incorporadas, scripts, imagens…). */
  const IPTV_CORS_TYPES = new Set(['xhr', 'media', 'object', 'other']);

  /* Pedidos de stream IPTV apresentam-se como o VLC. Servidores Xtream/relays
   * tratam de forma diferente um pedido "de browser" (User-Agent Chrome,
   * cabeçalhos Origin/Referer): há canais que entregam o cabeçalho do fluxo e
   * depois nada — e o mesmo URL no VLC reproduz bem. O Viewer diz ao processo
   * principal quais são os hosts IPTV (iptv:hosts); os redirecionamentos para
   * relays são aprendidos pelo id do pedido, que se mantém entre saltos. */
  ipcMain.removeHandler('iptv:hosts');
  handleTrustedIpc('iptv:hosts', (_event, hosts) => {
    for (const h of (Array.isArray(hosts) ? hosts : [])) if (typeof h === 'string' && h) iptvHosts.add(h.toLowerCase());
    return true;
  });
  const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch (_) { return ''; } };
  viewerWindow.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (details.webContentsId === viewerWindow.webContents.id && IPTV_CORS_TYPES.has(details.resourceType)) {
      const host = hostOf(details.url);
      if (iptvReqIds.has(details.id)) { if (host) iptvHosts.add(host); }          // destino de um redirect
      else if (host && iptvHosts.has(host)) iptvReqIds.add(details.id);
    }
    callback({});
  });
  viewerWindow.webContents.session.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const h = details.requestHeaders || {};
    if (iptvReqIds.has(details.id)) {
      for (const k of Object.keys(h)) if (/^(user-agent|origin|referer|sec-fetch-.*)$/i.test(k)) delete h[k];
      h['User-Agent'] = IPTV_USER_AGENT;
    }
    callback({ requestHeaders: h });
  });
  const forgetReq = (d) => { iptvReqIds.delete(d.id); };
  viewerWindow.webContents.session.webRequest.onCompleted(forgetReq);
  viewerWindow.webContents.session.webRequest.onErrorOccurred(forgetReq);

  const CORS_UNTOUCHED = /(^|\.)(youtube\.com|youtube-nocookie\.com|googlevideo\.com|ytimg\.com|google\.com|gstatic\.com)$/i;
  const viewerWcId = viewerWindow.webContents.id;
  viewerWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    /* BUG CORRIGIDO (YouTube "fica a rodar"): este override aplicava-se a
     * TODAS as respostas da sessão, incluindo as dos <webview>. O leitor do
     * YouTube pede os segmentos de vídeo ao googlevideo.com com credenciais e
     * cabeçalhos CORS próprios; trocar o Access-Control-Allow-Origin por "*"
     * invalida essas respostas e o vídeo nunca arranca. Agora só se mexe nas
     * respostas pedidas pela própria página do Viewer (onde corre o IPTV), e
     * nunca nas dos domínios da Google. */
    if (!IPTV_CORS_TYPES.has(details.resourceType) || details.webContentsId !== viewerWcId) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    let host = '';
    try { host = new URL(details.url).hostname; } catch (_) { host = ''; }
    if (CORS_UNTOUCHED.test(host)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const headers = details.responseHeaders || {};
    for (const k of Object.keys(headers)) {
      // "*" é incompatível com Allow-Credentials: true — retira-se também.
      if (/^access-control-allow-(origin|credentials)$/i.test(k)) delete headers[k];
    }
    headers['Access-Control-Allow-Origin'] = ['*'];
    callback({ responseHeaders: headers });
  });

  /* A janela do Viewer nunca deve sair da sua própria página: um <a href>
   * ou <form> dentro de um módulo HTML/artigo/opt-in navegava a app inteira
   * para fora (sem "voltar"), e window.open / target="_blank" abria janelas
   * Electron "nuas". Links http(s)/mailto vão para o browser do sistema; o
   * resto é bloqueado. Os <webview> são webContents próprios e não passam
   * por aqui, por isso YouTube/sites incorporados continuam a navegar livremente. */
  const openOutside = (url) => {
    if (/^(https?:\/\/|mailto:)/i.test(url)) shell.openExternal(url).catch(() => {});
  };
  viewerWindow.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    openOutside(url);
  });
  viewerWindow.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  secureEmbeddedContent(viewerWindow);
  viewerWindow.webContents.on('render-process-gone', stopWebModules);

  viewerWindow.setMenuBarVisibility(false);
  viewerWindow.loadFile(path.join(__dirname, 'src', 'viewer', 'index.html'));
  viewerWindow.once('ready-to-show', () => {
    if (standalone) viewerWindow.maximize();
    viewerWindow.show();
  });
  viewerWindow.on('closed', () => { stopWebModules(); viewerWindow = null; });
  return viewerWindow;
}

/* =========================================================
 * YOUTUBE — página anfitriã local
 *
 * O YouTube só reproduz o leitor embutido quando este está dentro de um
 * <iframe> de uma página com origem web válida, identificada pelo cabeçalho
 * Referer. Uma página file:// (o Viewer) não tem origem, e carregar o
 * /embed/ID diretamente como documento de topo dá "Erro 152-4 / 153".
 * Solução comprovada em apps Electron: servir uma página mínima em
 * http://127.0.0.1:<porta> (só loopback, porta aleatória) com o <iframe> do
 * YouTube. O browser envia então um Referer real e o leitor arranca.
 * ========================================================= */
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
let ytServer = null;
let ytPort = 0;

function youtubeHostHtml(id) {
  const src = 'https://www.youtube.com/embed/' + id + '?rel=0&playsinline=1';
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="referrer" content="strict-origin-when-cross-origin">'
    + '<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}'
    + 'iframe{display:block;width:100%;height:100%;border:0}</style></head><body>'
    + '<iframe src="' + src + '" referrerpolicy="strict-origin-when-cross-origin" '
    + 'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" '
    + 'allowfullscreen></iframe></body></html>';
}

function ensureYoutubeHost() {
  if (ytServer) return Promise.resolve(ytPort);
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let u;
      try { u = new URL(req.url, 'http://127.0.0.1'); } catch (_) { res.writeHead(400); res.end(); return; }
      if (u.pathname.startsWith('/iptv/')) { serveIptvProxy(u.pathname.slice(6), req, res); return; }
      const id = u.searchParams.get('v') || '';
      if (u.pathname !== '/yt' || !YT_ID_RE.test(id)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'strict-origin-when-cross-origin'
      });
      res.end(youtubeHostHtml(id));
    });
    srv.on('error', (err) => { ytServer = null; reject(err); });
    srv.listen(0, '127.0.0.1', () => {
      ytServer = srv;
      ytPort = srv.address().port;
      resolve(ytPort);
    });
  });
}

handleTrustedIpc('youtube:hostUrl', async (_event, id) => {
  const vid = String(id || '');
  if (!YT_ID_RE.test(vid)) throw new Error('ID de vídeo do YouTube inválido.');
  const port = await ensureYoutubeHost();
  return 'http://127.0.0.1:' + port + '/yt?v=' + vid;
});

/* =========================================================
 * IPTV — compatibility transcoding in a local FFmpeg process.
 * Video is decoded and re-encoded as progressive H.264 Main 720p/30;
 * remuxing (-c:v copy) cannot repair an unsupported source bitstream.
 * The optional bundled runtime must provide libx264, AAC and the filters.
 * ========================================================= */
const { createIptvProxy } = require('./src/shared/iptv-proxy');
function ffmpegPath() {
  const executable = path.join(runtimeDirectory('ffmpeg'), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  try { return fs.statSync(executable).isFile() ? executable : null; } catch (_) { return null; }
}
const iptvProxy = createIptvProxy({ getExecutable: ffmpegPath });
function serveIptvProxy(token, req, res) {
  iptvProxy.serve(token, req, res).catch(() => {
    if (res.destroyed || res.writableEnded) return;
    if (!res.headersSent) { res.writeHead(502); res.end(); }
    else res.destroy();
  });
}
handleTrustedIpc('iptv:proxyUrl', async (_event, url) => {
  if (!await iptvProxy.available()) return null;
  const token = iptvProxy.register(url);
  try {
    const port = await ensureYoutubeHost();
    return { url: 'http://127.0.0.1:' + port + '/iptv/' + token, token };
  } catch (error) { iptvProxy.stop(token); throw error; }
});
handleTrustedIpc('iptv:proxyStatus', (_event, token) => iptvProxy.status(token));
handleTrustedIpc('iptv:proxyStop', (_event, token) => { iptvProxy.stop(String(token || '')); return true; });
handleTrustedIpc('iptv:hasFfmpeg', () => iptvProxy.available());

app.on('will-quit', () => {
  try { if (ytServer) ytServer.close(); } catch (_) { /* noop */ }
  iptvProxy.closeAll();
});

/* Rede de segurança: uma exceção num stream/socket não pode abrir a janela
 * "A JavaScript error occurred in the main process" ao aluno. Fica em log. */
process.on('uncaughtException', (err) => {
  console.error('[main] exceção não tratada:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] promessa rejeitada sem tratamento:', reason && reason.stack ? reason.stack : reason);
});

/* Estado partilhado do "disfarce VLC" dos pedidos IPTV (ver createViewerWindow). */
const IPTV_USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20';
const iptvHosts = new Set();
const iptvReqIds = new Set();

/* -------- IPC: shared -------- */

// Decifra os url de IPTV em memória antes de entregar a config à janela. A
// config do Builder está em texto simples (sem marcador) → passa intacta; só a
// config embutida num curso gerado vem cifrada e é aqui decifrada.
handleTrustedIpc('config:load', () => Object.assign(iptvCipher.decryptConfigIptv(readConfig()), { viewerVersion: app.getVersion() }));
handleTrustedIpc('asset:resolve', (_event, relativePath) => resolveRelativeAsset(relativePath));

handleTrustedIpc('web:open', async (_event, moduleId) => {
  const mod = findModuleById(readConfig().content || [], moduleId);
  if (!mod || mod.type !== 'local-web') throw new Error('Módulo web não encontrado.');
  return webRuntime.open({ data: mod.data, assetsDir: ASSETS_DIR });
});
handleTrustedIpc('web:close', (_event, token) => webRuntime.close(token));

/* -------- IPC: projetos (Builder only) -------- */

handleTrustedIpc('projects:list', () => {
  assertBuilder();
  return projectsState();
});

handleTrustedIpc('projects:create', (_event, payload) => {
  assertBuilder();
  const idx = readProjectsIndex();
  const name = sanitizeProjectName(payload && payload.name);
  const id = genProjectId();
  try {
    createProjectFolder(id);
    fs.writeFileSync(path.join(projectDir(id), 'data', 'project-config.json'), JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    const now = Date.now();
    idx.projects.push({ id, name, createdAt: now, updatedAt: now });
    idx.activeId = id;
    writeProjectsIndex(idx);
  } catch (error) {
    try { fs.rmSync(projectDir(id), { recursive: true, force: true }); } catch (_) {}
    throw error;
  }
  applyActiveProjectPaths(id);
  return { state: projectsState(), config: readConfig() };
});

handleTrustedIpc('projects:open', (_event, payload) => {
  assertBuilder();
  const id = payload && payload.id;
  const idx = readProjectsIndex();
  if (!idx.projects.some((p) => p.id === id)) throw new Error('Projeto não encontrado.');
  const config = readConfig(path.join(projectDir(id), 'data', 'project-config.json'));
  idx.activeId = id;
  writeProjectsIndex(idx);
  applyActiveProjectPaths(id);
  ensureDirs();
  return { state: projectsState(), config };
});

handleTrustedIpc('projects:rename', (_event, payload) => {
  assertBuilder();
  const id = payload && payload.id;
  const name = sanitizeProjectName(payload && payload.name);
  const idx = readProjectsIndex();
  const p = idx.projects.find((x) => x.id === id);
  if (!p) throw new Error('Projeto não encontrado.');
  p.name = name;
  p.updatedAt = Date.now();
  writeProjectsIndex(idx);
  return projectsState();
});

handleTrustedIpc('projects:delete', (_event, payload) => {
  assertBuilder();
  const id = payload && payload.id;
  const idx = readProjectsIndex();
  if (!idx.projects.some((p) => p.id === id)) throw new Error('Projeto não encontrado.');
  idx.projects = idx.projects.filter((p) => p.id !== id);

  let switchedConfig = null;
  let replacementId = null;
  const switching = idx.activeId === id;
  try {
    if (switching) {
      if (idx.projects.length === 0) {
        const nid = genProjectId();
        replacementId = nid;
        createProjectFolder(nid);
        fs.writeFileSync(path.join(projectDir(nid), 'data', 'project-config.json'), JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
        const now = Date.now();
        idx.projects.push({ id: nid, name: 'Projeto 1', createdAt: now, updatedAt: now });
        idx.activeId = nid;
      } else {
        // O mais recente passa a ativo.
        const next = idx.projects.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
        idx.activeId = next.id;
      }
      switchedConfig = readConfig(path.join(projectDir(idx.activeId), 'data', 'project-config.json'));
    }
    writeProjectsIndex(idx);
  } catch (error) {
    if (replacementId) { try { fs.rmSync(projectDir(replacementId), { recursive: true, force: true }); } catch (_) {} }
    throw error;
  }
  if (switching) applyActiveProjectPaths(idx.activeId);
  let warning = null;
  try { fs.rmSync(projectDir(id), { recursive: true, force: true }); }
  catch (err) { warning = `O projeto saiu da lista, mas não foi possível limpar ${projectDir(id)}: ${err.message}`; console.warn(warning); }
  return { state: projectsState(), config: switchedConfig, ...(warning ? { warning } : {}) };
});

handleTrustedIpc('projects:duplicate', (_event, payload) => {
  assertBuilder();
  const srcId = payload && payload.id;
  const idx = readProjectsIndex();
  const src = idx.projects.find((p) => p.id === srcId);
  if (!src) throw new Error('Projeto não encontrado.');
  const newId = genProjectId();
  // Copia data/ (config + ícone) e dist-assets/ (logo, banners, ficheiros) do
  // projeto de origem para a nova pasta, de forma independente.
  const srcRoot = projectDir(srcId);
  const dstRoot = projectDir(newId);
  try {
    const sourceConfig = readConfig(path.join(srcRoot, 'data', 'project-config.json'));
    createProjectFolder(newId);
    copyDirRecursive(path.join(srcRoot, 'data'), path.join(dstRoot, 'data'));
    const sourceAssets = path.join(srcRoot, 'dist-assets');
    if (fs.existsSync(sourceAssets)) copyProjectAssets(sourceAssets, path.join(dstRoot, 'dist-assets'), sourceConfig);
    // A duplicate gets its own persistent program settings at runtime.
    const duplicateConfig = { ...sourceConfig, content: (sourceConfig.content || []).map((mod) => mod.type === 'portable'
      ? { ...mod, data: { ...mod.data, revision: crypto.randomUUID() } } : mod) };
    fs.writeFileSync(path.join(dstRoot, 'data', 'project-config.json'), JSON.stringify(duplicateConfig, null, 2), 'utf8');
    const now = Date.now();
    const name = sanitizeProjectName(src.name + ' (cópia)');
    idx.projects.push({ id: newId, name, createdAt: now, updatedAt: now });
    idx.activeId = newId;
    writeProjectsIndex(idx);
  } catch (error) {
    try { fs.rmSync(dstRoot, { recursive: true, force: true }); } catch (_) {}
    throw error;
  }
  applyActiveProjectPaths(newId);
  ensureDirs();
  return { state: projectsState(), config: readConfig() };
});

/* Editable project archives are separate from distributable Viewer exports. */
handleTrustedIpc('projects:exportArchive', async (_event, payload) => {
  assertBuilder();
  const idx = readProjectsIndex();
  const project = idx.projects.find(p => p.id === payload?.id);
  if (!project) throw new Error('Projeto não encontrado.');
  exportBusy = true;
  try {
    const chosen = await dialog.showSaveDialog(builderWindow, {
      title: 'Exportar projeto editável',
      defaultPath: projectExport.safeProjectName(project.name) + '.wsmb',
      filters: [{ name: 'Projeto Windows & Mac Software Builder', extensions: ['wsmb'] }]
    });
    if (chosen.canceled || !chosen.filePath) return { cancelled: true };
    const parent = fs.realpathSync(path.dirname(chosen.filePath));
    const relative = path.relative(fs.realpathSync(PROJECTS_ROOT), parent);
    if (!relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
      throw new Error('Guarde o arquivo fora das pastas internas dos projetos.');
    }
    return await projectArchive.exportArchive({ projectRoot: projectDir(project.id), outputPath: chosen.filePath,
      name: project.name, appVersion: app.getVersion(), readConfig });
  } finally { exportBusy = false; }
});

handleTrustedIpc('projects:importArchive', async () => {
  assertBuilder();
  exportBusy = true;
  const id = genProjectId();
  let imported = false;
  try {
    const chosen = await dialog.showOpenDialog(builderWindow, {
      title: 'Importar projeto editável', properties: ['openFile'],
      filters: [{ name: 'Projeto Windows & Mac Software Builder', extensions: ['wsmb', 'zip'] }]
    });
    if (chosen.canceled || !chosen.filePaths?.[0]) return { cancelled: true };
    const result = await projectArchive.importArchive({ archivePath: chosen.filePaths[0], destination: projectDir(id), readConfig });
    imported = true;
    const idx = readProjectsIndex();
    const now = Date.now();
    let name = sanitizeProjectName(result.name);
    if (idx.projects.some(p => p.name === name)) name = sanitizeProjectName(name.slice(0, 65) + ' (importado)');
    idx.projects.push({ id, name, createdAt: now, updatedAt: now });
    idx.activeId = id;
    writeProjectsIndex(idx);
    imported = false; // Index committed: a later UI error must not delete data.
    applyActiveProjectPaths(id);
    return { state: projectsState(), config: result.config };
  } catch (error) {
    if (imported) { try { fs.rmSync(projectDir(id), { recursive: true, force: true }); } catch (_) {} }
    throw error;
  } finally { exportBusy = false; }
});

/* -------- IPC: brand (Builder only) -------- */

function assertBuilder() {
  if (exportBusy) throw new Error('Aguarde a conclusão da exportação antes de alterar o projeto.');
  if (isViewer) throw new Error('Operação não disponível no Viewer.');
}

handleTrustedIpc('brand:save', (_event, payload) => {
  assertBuilder();
  const current = readConfig();
  let logoRelative = current.brand.logo || null;
  const created = [];
  if (payload && payload.logoSourcePath) {
    if (!fs.existsSync(payload.logoSourcePath)) throw new Error('Ficheiro de logo não encontrado: ' + payload.logoSourcePath);
    logoRelative = copyAssetToProject(payload.logoSourcePath, 'logo');
    created.push(relToAbs(logoRelative));
  } else if (payload && payload.removeLogo) {
    logoRelative = null;
  }
  const updated = {
    ...current,
    brand: {
      title: (payload && typeof payload.title === 'string' && payload.title.trim())
        ? payload.title.trim() : DEFAULT_CONFIG.brand.title,
      logo: logoRelative,
      colors: {
        sidebar: (typeof payload?.colors?.sidebar === 'string' && payload.colors.sidebar) || current.brand.colors.sidebar,
        background: (typeof payload?.colors?.background === 'string' && payload.colors.background) || current.brand.colors.background,
        buttons: (typeof payload?.colors?.buttons === 'string' && payload.colors.buttons) || current.brand.colors.buttons
      }
    }
  };
  commitConfigFiles(updated, created, []);
  if (current.brand.logo !== logoRelative) deleteAssetIfInside(current.brand.logo);
  return updated;
});

/* -------- IPC: marketing (Builder only) -------- */

handleTrustedIpc('marketing:saveLeads', (_event, payload) => {
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

handleTrustedIpc('marketing:saveBanners', (_event, payload) => {
  assertBuilder();
  const current = readConfig();
  const curBanners = (current.marketing && current.marketing.banners) || {};
  const created = [];

  // Cada slot (top/bottom) é independente: copia a imagem nova, remove a
  // existente, ou mantém a atual conforme o payload do slot.
  const saveSlot = (slotName) => {
    const cur = curBanners[slotName] || { enabled: false, image: null, url: '' };
    const p = (payload && payload[slotName]) || {};
    let image = cur.image || null;
    if (p.imageSourcePath) {
      if (!fs.existsSync(p.imageSourcePath)) throw new Error('Ficheiro de banner não encontrado: ' + p.imageSourcePath);
      image = copyAssetToProject(p.imageSourcePath, 'banner-' + slotName);
      created.push(relToAbs(image));
    } else if (p.removeImage) {
      image = null;
    }
    return {
      enabled: !!p.enabled,
      image,
      url: (typeof p.url === 'string') ? p.url.trim() : (cur.url || '')
    };
  };

  let updated;
  try {
    updated = {
      ...current,
      marketing: {
        ...current.marketing,
        banners: { top: saveSlot('top'), bottom: saveSlot('bottom') }
      }
    };
    if (updated.marketing.banner) delete updated.marketing.banner;
    commitConfigFiles(updated, created, []);
  } catch (error) { cleanupFiles(created); throw error; }
  for (const slot of ['top', 'bottom']) {
    if (curBanners[slot]?.image !== updated.marketing.banners[slot].image) deleteAssetIfInside(curBanners[slot]?.image);
  }
  return updated;
});

handleTrustedIpc('marketing:saveSocial', (_event, payload) => {
  assertBuilder();
  const current = readConfig();
  const keys = ['site', 'instagram', 'facebook', 'x', 'tiktok', 'pinterest', 'linkedin', 'spotify', 'whatsapp', 'telegram'];
  const social = {};
  for (const k of keys) {
    let v = (payload && typeof payload[k] === 'string') ? payload[k].trim() : '';
    // Ajuda o utilizador não-técnico: se faltar o esquema, assume https://
    if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v;
    social[k] = v;
  }
  const updated = { ...current, marketing: { ...current.marketing, social } };
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

handleTrustedIpc('content:save', (_event, payload) => {
  assertBuilder();
  if (!Array.isArray(payload && payload.modules)) throw new Error('Lista de módulos inválida. O projeto não foi alterado.');
  const current = readConfig();
  const previous = Array.isArray(current.content) ? current.content : [];
  const incoming = payload.modules;
  const incomingIds = new Set();
  for (const raw of incoming) {
    if (!raw || typeof raw.id !== 'string' || !raw.id || incomingIds.has(raw.id)) throw new Error('Identificador de módulo inválido ou repetido.');
    incomingIds.add(raw.id);
  }
  const nextModules = [];
  const importedFiles = [];
  const importedWeb = [];
  const importedPortable = [];
  try {
  for (const raw of incoming) {
    const mod = sanitizeModule(raw);
    if (!mod) continue;
    const prev = findModuleById(previous, mod.id);
    const d = mod.data || {};
    if (mod.type === 'local-web') {
      if (typeof d.sourcePath === 'string' && d.sourcePath) {
        mod.data = localWeb.importWebProject({ sourcePath: d.sourcePath, includeDirectory: d.includeDirectory === true, assetsDir: ASSETS_DIR });
        importedWeb.push(mod.data);
      } else {
        if (!prev || prev.type !== 'local-web') throw new Error('Selecione um ficheiro HTML ou PHP.');
        localWeb.validateWebProject({ data: prev.data, assetsDir: ASSETS_DIR });
        mod.data = { ...prev.data };
      }
    } else if (mod.type === 'portable') {
      if (typeof d.sourcePath === 'string' && d.sourcePath) {
        mod.data = portableApps.importPortableProject({ sourcePath: d.sourcePath,
          assetsDir: ASSETS_DIR, entries: d.entries, allowWine: d.allowWine === true });
        importedPortable.push(mod.data);
      } else {
        if (!prev || prev.type !== 'portable') throw new Error('Selecione uma pasta de software portable.');
        mod.data = portableApps.updatePortableProject({ data: prev.data,
          assetsDir: ASSETS_DIR, entries: d.entries === undefined ? prev.data.entries : d.entries,
          allowWine: d.allowWine === undefined ? prev.data.allowWine : d.allowWine === true });
      }
    } else if (SINGLE_FILE_TYPES.has(mod.type)) {
      const sourcePath = typeof d.sourcePath === 'string' ? d.sourcePath : null;
      let file, fileName;
      if (sourcePath) {
        if (!fs.existsSync(sourcePath)) throw new Error('Ficheiro não encontrado: ' + sourcePath);
        const prefix = mod.type === 'pdf' ? 'pdf'
          : mod.type === 'local-video' ? 'video'
          : mod.type === 'local-audio' ? 'audio'
          : (mod.type === 'download-vault' || mod.type === 'archive-download') ? 'download' : 'file';
        file = copyAssetToProject(sourcePath, prefix);
        importedFiles.push(relToAbs(file));
        fileName = path.basename(sourcePath);
      } else {
        file = (prev && prev.data && prev.data.file) || null;
        fileName = (prev && prev.data && prev.data.fileName) || null;
      }
      if (mod.type === 'archive-download' && !file) throw new Error('Selecione um arquivo para descarregar.');
      const out = { file, fileName };
      if (mod.type === 'download-vault' || mod.type === 'archive-download') {
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
          if (!fs.existsSync(it.sourcePath)) throw new Error('Imagem não encontrada: ' + it.sourcePath);
          const rel = copyAssetToProject(it.sourcePath, 'img');
          importedFiles.push(relToAbs(rel));
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
    } else if (mod.type === 'html') {
      mod.data = { html: typeof d.html === 'string' ? d.html : '' };
    } else if (mod.type === 'article-reader') {
      mod.data = { text: typeof d.text === 'string' ? d.text : '' };
    } else if (mod.type === 'iptv') {
      const source = ['xtream', 'm3u8', 'm3u', 'manual'].includes(d.source) ? d.source : 'manual';
      const rawCh = Array.isArray(d.channels) ? d.channels : [];
      const channels = [];
      for (const c of rawCh) {
        if (!c || typeof c !== 'object') continue;
        const url = typeof c.url === 'string' ? c.url.trim() : '';
        if (!url) continue;
        const name = (typeof c.name === 'string' && c.name.trim()) ? c.name.trim() : url;
        const logo = typeof c.logo === 'string' ? c.logo.trim() : '';
        const group = typeof c.group === 'string' ? c.group.trim() : '';
        channels.push({ name, url, logo, group });
        if (channels.length >= IPTV_MAX_CHANNELS) break;
      }
      const out = { source, channels };
      if (source === 'xtream') {
        // Guardamos apenas o URL do servidor (útil para reeditar). As credenciais
        // NÃO são persistidas no curso: os canais já foram resolvidos no build e
        // o utilizador/palavra-passe não devem ser distribuídos aos alunos.
        out.xtreamUrl = typeof d.xtreamUrl === 'string' ? d.xtreamUrl.trim() : '';
      } else if (source === 'm3u8') {
        out.playlistUrl = typeof d.playlistUrl === 'string' ? d.playlistUrl.trim() : '';
      }
      mod.data = out;
    } else {
      mod.data = {};
    }
    nextModules.push(mod);
  }
  const updated = { ...current, content: nextModules };
  writeConfig(updated);
  } catch (err) {
    cleanupFiles(importedFiles);
    for (const data of importedWeb) {
      try { localWeb.removeWebProject({ data, assetsDir: ASSETS_DIR }); } catch (_) {}
    }
    for (const data of importedPortable) {
      try { portableApps.removePortableProject({ data, assetsDir: ASSETS_DIR }); } catch (_) {}
    }
    throw err;
  }
  // Delete retired assets only after the new configuration was saved.
  const kept = new Set();
  for (const m of nextModules) for (const f of moduleAssetFiles(m)) kept.add(f);
  const keptRoots = new Set(nextModules.filter((m) => m.type === 'local-web').map((m) => m.data.root));
  const keptPortableRoots = new Set(nextModules.filter((m) => m.type === 'portable').map((m) => m.data.root));
  for (const prev of previous) {
    for (const f of moduleAssetFiles(prev)) { if (!kept.has(f)) deleteAssetIfInside(f); }
    if (prev.type === 'local-web' && !keptRoots.has(prev.data.root)) {
      stopWebModules();
      try { localWeb.removeWebProject({ data: prev.data, assetsDir: ASSETS_DIR }); }
      catch (err) { console.warn('Web asset cleanup:', err.message); }
    }
    if (prev.type === 'portable' && !keptPortableRoots.has(prev.data.root)) {
      try { portableApps.removePortableProject({ data: prev.data, assetsDir: ASSETS_DIR }); }
      catch (err) { console.warn('Portable asset cleanup:', err.message); }
    }
  }
  return { ...current, content: nextModules };
});

/* -------- IPTV: obtenção/parse de canais (Builder only) --------
 * Corre no processo principal (Node), por isso NÃO há CORS: falamos diretamente
 * com o painel Xtream Codes ou descarregamos uma lista M3U. Os canais resolvidos
 * ({name,url,logo,group}) ficam guardados no config e o Viewer apenas os
 * reproduz (hls.js) — não precisa de rede para os listar. */
const IPTV_MAX_CHANNELS = 200000;
const IPTV_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function iptvNormalizeBase(raw) {
  let u = String(raw || '').trim();
  if (!u) throw new Error('URL do servidor em falta.');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/(player_api|get|panel_api)\.php.*$/i, '');
  return u;
}

async function iptvFetch(url, asJson) {
  const controller = new AbortController();
  // Listas M3U grandes (dezenas de milhares de canais) podem ser vários MB;
  // damos margem generosa para o download não abortar a meio.
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': IPTV_UA, 'Accept': '*/*' }
    });
    if (!resp.ok) throw new Error('Servidor respondeu ' + resp.status + '.');
    return asJson ? await resp.json() : await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

async function iptvLoadXtream({ url, username, password } = {}) {
  const base = iptvNormalizeBase(url);
  const user = String(username || '').trim();
  const pass = String(password || '').trim();
  if (!user || !pass) throw new Error('Utilizador e palavra-passe são obrigatórios.');
  const q = 'username=' + encodeURIComponent(user) + '&password=' + encodeURIComponent(pass);
  const apiBase = base + '/player_api.php?' + q;
  let info;
  try { info = await iptvFetch(apiBase, true); }
  catch (e) { throw new Error('Não foi possível ligar ao servidor. Verifique o URL. (' + e.message + ')'); }
  if (!info || !info.user_info || Number(info.user_info.auth) !== 1) {
    throw new Error('Login inválido: verifique o utilizador, a palavra-passe e o URL do servidor.');
  }
  const catMap = {};
  try {
    const cats = await iptvFetch(apiBase + '&action=get_live_categories', true);
    if (Array.isArray(cats)) for (const c of cats) catMap[String(c.category_id)] = String(c.category_name || '');
  } catch (_) { /* categorias são opcionais */ }
  const streams = await iptvFetch(apiBase + '&action=get_live_streams', true);
  if (!Array.isArray(streams)) throw new Error('Não foi possível obter a lista de canais.');
  const channels = [];
  for (const s of streams) {
    if (!s || s.stream_id == null) continue;
    const id = s.stream_id;
    const name = String(s.name || ('Canal ' + id)).trim();
    const logo = typeof s.stream_icon === 'string' ? s.stream_icon.trim() : '';
    const group = catMap[String(s.category_id)] || '';
    const streamUrl = base + '/live/' + encodeURIComponent(user) + '/' + encodeURIComponent(pass) + '/' + id + '.m3u8';
    channels.push({ name, url: streamUrl, logo, group });
    if (channels.length >= IPTV_MAX_CHANNELS) break;
  }
  return channels;
}

/* Resolve entradas relativas de uma lista (ex.: "canais/1.m3u8") contra o
 * URL de onde a lista foi descarregada; URLs absolutos ficam como estão. */
function iptvResolveUrl(entry, baseUrl) {
  if (!baseUrl || /^[a-z][a-z0-9+.-]*:/i.test(entry)) return entry;
  try { return new URL(entry, baseUrl).href; } catch (_) { return entry; }
}

function iptvParseM3U(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/);
  const channels = [];
  let pending = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXTINF/i.test(line)) {
      // BUG CORRIGIDO: os atributos key="value" podem conter vírgulas
      // (group-title="Notícias, Desporto") e a 1.ª vírgula cortava o nome a
      // meio. Retiram-se os atributos antes de procurar a vírgula separadora.
      const stripped = line.replace(/\s+[\w.:-]+="[^"]*"/g, '');
      const comma = stripped.indexOf(',');
      const name = comma >= 0 ? stripped.slice(comma + 1).trim() : '';
      const logo = (line.match(/tvg-logo="([^"]*)"/i) || [])[1] || '';
      const group = (line.match(/group-title="([^"]*)"/i) || [])[1] || '';
      pending = { name, logo, group };
    } else if (line.charAt(0) === '#') {
      continue;
    } else {
      const meta = pending || { name: '', logo: '', group: '' };
      const url = iptvResolveUrl(line, baseUrl);
      channels.push({ name: meta.name || url, url, logo: meta.logo || '', group: meta.group || '' });
      pending = null;
      if (channels.length >= IPTV_MAX_CHANNELS) break;
    }
  }
  return channels;
}

/* Um manifesto HLS (o stream em si, com tags #EXT-X-*) não é uma lista de
 * canais: os "canais" seriam os segmentos/variantes, com URLs relativos que
 * nunca reproduziriam. Nesse caso o próprio URL é o único canal. */
function iptvLooksLikeHlsManifest(text) {
  return /^#EXT-X-(STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE|PLAYLIST-TYPE|ENDLIST|KEY|MAP)\b/im.test(String(text || ''));
}

function iptvFinalize(text, srcUrl) {
  if (srcUrl && iptvLooksLikeHlsManifest(text)) {
    return [{ name: 'Canal', url: srcUrl, logo: '', group: '' }];
  }
  const channels = iptvParseM3U(text, srcUrl);
  if (channels.length === 0 && srcUrl) {
    return [{ name: 'Canal', url: srcUrl, logo: '', group: '' }];
  }
  return channels;
}

async function iptvLoadM3UFromUrl(url) {
  let u = String(url || '').trim();
  if (!u) throw new Error('Ligação em falta.');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  let text;
  try { text = await iptvFetch(u, false); }
  catch (e) { throw new Error('Não foi possível descarregar a lista. Verifique a ligação. (' + e.message + ')'); }
  return iptvFinalize(text, u);
}

function iptvLoadM3UFromFile(filePath) {
  const p = String(filePath || '').trim();
  if (!p || !fs.existsSync(p)) throw new Error('Ficheiro não encontrado.');
  const text = fs.readFileSync(p, 'utf8');
  return iptvFinalize(text, null);
}

handleTrustedIpc('iptv:load', async (_event, payload) => {
  assertBuilder();
  const source = payload && payload.source;
  try {
    let channels = [];
    if (source === 'xtream') channels = await iptvLoadXtream((payload && payload.xtream) || {});
    else if (source === 'm3u8') channels = await iptvLoadM3UFromUrl(payload && payload.playlistUrl);
    else if (source === 'm3u') channels = iptvLoadM3UFromFile(payload && payload.filePath);
    else throw new Error('Fonte inválida.');
    if (!Array.isArray(channels) || channels.length === 0) {
      return { ok: false, error: 'Não foram encontrados canais.' };
    }
    return { ok: true, channels, count: channels.length };
  } catch (err) {
    return { ok: false, error: (err && err.message) ? err.message : String(err) };
  }
});

/* -------- IPC: file picker (Builder only) --------
 * Em Electron moderno, File.path foi removido do renderer por segurança, por
 * isso <input type="file"> deixou de expor o caminho real do ficheiro. Para
 * copiar ficheiros para dist-assets/ usamos o diálogo nativo no processo
 * principal e devolvemos o caminho absoluto ao renderer. */
const PICK_FILTERS = {
  image: [{ name: 'Imagens', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'] }],
  icon: [{ name: 'Ícone / Imagem (.ico, .png, .jpg)', extensions: ['ico', 'png', 'jpg', 'jpeg'] }],
  pdf: [{ name: 'PDF', extensions: ['pdf'] }],
  web: [{ name: 'HTML / PHP', extensions: ['html', 'htm', 'php'] }],
  video: [{ name: 'Vídeo', extensions: ['mp4', 'webm', 'mov', 'm4v', 'ogv'] }],
  audio: [{ name: 'Áudio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] }],
  playlist: [{ name: 'Listas IPTV', extensions: ['m3u', 'm3u8'] }],
  archives: [{ name: 'ZIP / RAR / 7z / TAR (incluindo arquivos protegidos)', extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '001'] }],
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

handleTrustedIpc('dialog:pickFile', async (_event, category) => {
  assertBuilder();
  const result = await dialog.showOpenDialog(builderWindow, {
    properties: ['openFile'],
    filters: pickFilters(category)
  });
  if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  return { path: filePath, name: path.basename(filePath) };
});

handleTrustedIpc('dialog:pickFiles', async (_event, category) => {
  assertBuilder();
  const result = await dialog.showOpenDialog(builderWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: pickFilters(category)
  });
  if (result.canceled || !Array.isArray(result.filePaths)) return [];
  return result.filePaths.map((p) => ({ path: p, name: path.basename(p) }));
});

/* Portable imports keep the entire folder. Scanning identifies candidates;
 * it never executes a program. Runtime paths belong to this computer only. */
const PORTABLE_LOCAL_DIR = path.join(app.getPath('appData'), 'LaunchBox Portable Apps');
const WINE_SETTINGS_PATH = path.join(PORTABLE_LOCAL_DIR, 'wine.json');

handleTrustedIpc('portable:pickFolder', async () => {
  assertBuilder();
  const result = await dialog.showOpenDialog(builderWindow, {
    title: 'Selecionar pasta do software portable',
    properties: ['openDirectory', 'treatPackageAsDirectory']
  });
  if (result.canceled || !result.filePaths?.[0]) return null;
  const sourcePath = result.filePaths[0];
  return { sourcePath, ...portableApps.scanPortableFolder(sourcePath) };
});

function readPortableWineSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(WINE_SETTINGS_PATH, 'utf8'));
    return { executable: settings.executable, prefix: settings.prefix };
  } catch (_) { return null; }
}

handleTrustedIpc('portable:configureWine', async () => {
  if (process.platform !== 'darwin') throw new Error('A opção Wine deste módulo está disponível apenas no Mac.');
  const parent = BrowserWindow.getFocusedWindow() || viewerWindow || builderWindow;
  const previous = readPortableWineSettings();
  const executable = await dialog.showOpenDialog(parent, {
    title: 'Selecionar executável Wine já instalado (wine)',
    ...(previous?.executable ? { defaultPath: previous.executable } : {}),
    properties: ['openFile', 'showHiddenFiles']
  });
  if (executable.canceled || !executable.filePaths?.[0]) return { configured: false, cancelled: true };
  const prefix = await dialog.showOpenDialog(parent, {
    title: 'Selecionar prefixo Wine já preparado (contém system.reg e user.reg)',
    ...(previous?.prefix ? { defaultPath: previous.prefix } : {}),
    properties: ['openDirectory', 'showHiddenFiles']
  });
  if (prefix.canceled || !prefix.filePaths?.[0]) return { configured: false, cancelled: true };
  const settings = portableRuntime.validateWineConfiguration({ executable: executable.filePaths[0], prefix: prefix.filePaths[0] });
  fs.mkdirSync(PORTABLE_LOCAL_DIR, { recursive: true });
  const temporary = WINE_SETTINGS_PATH + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, WINE_SETTINGS_PATH);
  } finally { fs.rmSync(temporary, { force: true }); }
  return { configured: true };
});

handleTrustedIpc('portable:launch', async (_event, moduleId) => {
  if (exportBusy) throw new Error('Aguarde a conclusão da exportação antes de abrir o programa.');
  if (typeof moduleId !== 'string' || !moduleId || moduleId.length > 256) throw new Error('Módulo portable inválido.');
  const module = findModuleById(readConfig().content || [], moduleId);
  if (!module || module.type !== 'portable') throw new Error('Módulo portable não encontrado.');
  return portableRuntime.launchPortableProject({ data: module.data, assetsDir: ASSETS_DIR,
    storageDir: path.join(PORTABLE_LOCAL_DIR, 'projects'), wine: readPortableWineSettings(),
    arch: app.runningUnderARM64Translation ? 'arm64' : process.arch });
});

/* Viewer: "Guardar como" para o módulo Cofre de Downloads. Copia o ficheiro
 * (que vive em dist-assets/) para o local escolhido pelo aluno. */
handleTrustedIpc('dialog:saveFileAs', async (_event, payload) => {
  const rel = payload && typeof payload.file === 'string' ? payload.file : null;
  const suggested = (payload && typeof payload.fileName === 'string' && payload.fileName) || 'ficheiro';
  if (!rel) throw new Error('Ficheiro inválido.');
  const real = resolveProjectFile(rel);
  const win = BrowserWindow.getFocusedWindow() || viewerWindow || builderWindow;
  const result = await dialog.showSaveDialog(win, { defaultPath: suggested });
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
  // The dialog can remain open while projects change. Keep the selected source
  // and reject a substituted symlink instead of following it after the wait.
  if (fs.realpathSync(real) !== real || !fs.statSync(real).isFile()) throw new Error('O ficheiro mudou enquanto o diálogo estava aberto.');
  fs.copyFileSync(real, result.filePath);
  return { ok: true, path: result.filePath };
});

/* -------- IPC: viewer + shell -------- */

handleTrustedIpc('viewer:open', () => {
  assertBuilder();
  createViewerWindow({ standalone: false });
  return true;
});

handleTrustedIpc('shell:openExternal', async (_event, url) => {
  if (typeof url !== 'string' || !url.trim()) return false;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('URL inválido (apenas http/https): ' + trimmed);
  await shell.openExternal(trimmed);
  return true;
});

handleTrustedIpc('shell:launchFile', async (_event, relativePath) => {
  if (exportBusy) throw new Error('Aguarde a conclusão da exportação antes de abrir o ficheiro.');
  const abs = resolveProjectFile(relativePath);
  const errMsg = await shell.openPath(abs);
  if (errMsg) throw new Error(errMsg);
  return true;
});

/* -------- IPC: export (Builder only) — SFX pipeline -------- */

const ICON_ALLOWED_EXTS = ['.ico', '.png', '.jpg', '.jpeg'];
const ICON_SOURCE_NAMES = ICON_ALLOWED_EXTS.map((e) => 'icon-source' + e);

function storedIconPaths(config) {
  const files = ICON_SOURCE_NAMES.map(name => path.join(DATA_DIR, name)).concat(ICON_DEST_PATH);
  const icon = config.export && config.export.iconPath;
  if (typeof icon === 'string' && /^data\/icon-source-[A-Za-z0-9-]+\.(ico|png|jpg|jpeg)$/.test(icon)) {
    files.push(path.join(DATA_DIR, path.posix.basename(icon)));
  }
  return files;
}

handleTrustedIpc('export:saveIcon', (_event, payload) => {
  assertBuilder();
  ensureDirs();
  const current = readConfig();
  const retired = storedIconPaths(current);

  // Remover o ícone personalizado (volta ao predefinido).
  if (payload && payload.removeIcon) {
    const updated = { ...current, export: { ...(current.export || {}), iconPath: null } };
    commitConfigFiles(updated, [], retired);
    return updated;
  }

  if (!payload || !payload.sourcePath) throw new Error('Caminho do ícone em falta.');
  if (!fs.existsSync(payload.sourcePath)) throw new Error('Ficheiro de ícone não encontrado.');
  const ext = path.extname(payload.sourcePath).toLowerCase();
  if (!ICON_ALLOWED_EXTS.includes(ext)) {
    throw new Error('O ícone tem de ser .ico, .png ou .jpg. O GIF não é suportado — os ícones de Windows são estáticos. Converta a imagem para PNG e tente de novo.');
  }
  const destName = 'icon-source-' + crypto.randomUUID() + ext;
  const destination = path.join(DATA_DIR, destName);
  try { fs.copyFileSync(payload.sourcePath, destination, fs.constants.COPYFILE_EXCL); }
  catch (error) { cleanupFiles([destination]); throw error; }
  const updated = { ...current, export: { ...(current.export || {}), iconPath: 'data/' + destName } };
  commitConfigFiles(updated, [destination], retired);
  return updated;
});

// Guard against re-entrant export invocations from a double-click.
let exportBusy = false;

async function buildWindowsExe(event, payload) {
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

    const courseConfig = iptvCipher.sanitizeConfigForCourse(readConfig());
    androidRuntime.assertAPKExport(courseConfig);

    for (const mod of readConfig().content || []) {
      if (mod.type !== 'portable') continue;
      const portable = portableApps.assertPortableTarget({ data: mod.data, assetsDir: ASSETS_DIR, target: 'windows' });
      if (portable.hasSymlinks) throw new Error('Esta pasta portable contém ligações simbólicas Mac. Utilize a exportação Windows ZIP.');
    }

    const sfxBinDir = getSfxBinDir();
    const sevenZipExe = path.join(sfxBinDir, '7za.exe');
    const sfxStub = path.join(sfxBinDir, '7zsd_All_x64.sfx');
    const templateZip = getExportTemplatePath('windows');
    const templateDir = getViewerTemplateDir();
    const templateExe = path.join(templateDir, 'LaunchBox Viewer.exe');
    if (!fs.existsSync(sevenZipExe) || !fs.existsSync(sfxStub)) {
      throw new Error('Ferramentas de exportação Windows em falta. Reinstale o construtor.');
    }
    if (!fs.existsSync(templateZip) && !fs.existsSync(templateExe)) {
      throw new Error('Template Windows em falta. Prepare export-templates/windows-x64.zip.');
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
    if (fs.existsSync(templateZip)) {
      await projectExport.extractWindowsTemplate(templateZip, stagingRoot, { config: courseConfig, assetsDir: ASSETS_DIR,
        sharedRuntimeSourcesDir: path.join(runtimeDirectory('ffmpeg'), 'sources') });
    } else {
      fs.mkdirSync(stagingRoot, { recursive: true });
      copyDirRecursive(templateDir, stagingRoot);
      const required = projectExport.projectRuntimeRequirements({ config: courseConfig, assetsDir: ASSETS_DIR });
      for (const runtime of ['ffmpeg', 'php']) {
        if (!required[runtime]) fs.rmSync(path.join(stagingRoot, 'resources', runtime), { recursive: true, force: true });
        else {
          const executable = path.join(stagingRoot, 'resources', runtime, runtime + '.exe');
          if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
            throw new Error('O template Windows antigo não inclui o runtime ' + runtime + ' necessário. Reinstale o construtor com os modelos atuais.');
          }
        }
      }
    }

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
    // Cifra os url dos canais IPTV (que contêm o utilizador/password Xtream) e
    // remove metadados só-do-Builder (xtreamUrl/playlistUrl) para que nenhuma
    // credencial fique em texto simples dentro do curso. O Viewer decifra os
    // canais em memória no config:load. Módulos não-IPTV ficam inalterados.
    fs.writeFileSync(path.join(stageData, 'project-config.json'), JSON.stringify(courseConfig, null, 2), 'utf-8');
    for (const mod of courseConfig.content || []) {
      if (mod.type !== 'local-web') continue;
      const web = localWeb.validateWebProject({ data: mod.data, assetsDir: ASSETS_DIR });
      if (web.requiresPhp && !fs.existsSync(path.join(stageResources, 'php', 'php.exe'))) {
        throw new Error('O curso contém PHP, mas o template não inclui php.exe. Prepare vendor/php e reconstrua o Viewer e o Construtor.');
      }
    }
    if (fs.existsSync(ASSETS_DIR)) copyProjectAssets(ASSETS_DIR, stageAssets, courseConfig);

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
      const iconAbs = relToAbs(iconRel);
      if (fs.existsSync(iconAbs)) {
        send('A aplicar o ícone personalizado ao executável…');
        stubToUse = await stampSfxIcon(sfxStub, iconAbs, iconTmpDir, send);
      } else {
        send('Aviso: ícone personalizado não encontrado; será usado o ícone padrão.');
      }
    }

    /* 6. The single-file magic: SFX stub + config + 7z payload, concatenated
     *    in that order, IS a valid Windows .exe that auto-extracts + runs. */
    const pendingTarget = target + '.' + stamp + '.tmp';
    try {
      await concatFilesToTarget([stubToUse, sfxCfgPath, archivePath], pendingTarget);
      fs.renameSync(pendingTarget, target);
    } finally { try { fs.unlinkSync(pendingTarget); } catch (_) {} }

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
}

handleTrustedIpc('export:targets', () => { assertBuilder(); return exportTargets(); });

async function exportProject(event, payload = {}) {
  assertBuilder();
  if (exportBusy) throw new Error('Já existe uma exportação em curso.');
  androidRuntime.assertAPKExport(readConfig());
  const target = payload.target;
  if (!['windows', 'mac'].includes(target)) throw new Error('Escolha Windows ou Mac.');
  const selected = exportTargets().targets.find((entry) => entry.id === target);
  if (!selected.available) throw new Error(selected.reason);
  if (target === 'windows' && selected.format === 'exe') return buildWindowsExe(event, payload);
  exportBusy = true;
  const send = (msg, kind = 'info') => {
    try { event.sender.send('export:log', { msg, kind }); } catch (_) {}
  };
  try {
    if (!hasProject()) throw new Error('Guarde o projeto antes de exportar.');
    const config = iptvCipher.sanitizeConfigForCourse(readConfig());
    const name = projectExport.safeProjectName(payload.defaultName || config.brand?.title || 'Meu Software');
    for (const mod of config.content || []) {
      if (mod.type === 'local-web') localWeb.validateWebProject({ data: mod.data, assetsDir: ASSETS_DIR });
      if (mod.type === 'portable') {
        const portable = portableApps.assertPortableTarget({ data: mod.data, assetsDir: ASSETS_DIR, target });
        for (const warning of portable.warnings || []) send(warning, 'warning');
      }
    }
    const choice = await dialog.showSaveDialog(builderWindow, {
      title: target === 'mac' ? 'Guardar aplicação Mac (.zip)' : 'Guardar aplicação Windows portátil (.zip)',
      defaultPath: name + '-' + target + '.zip', filters: [{ name: 'Aplicação portátil ZIP', extensions: ['zip'] }]
    });
    if (choice.canceled || !choice.filePath) return { ok: false, cancelled: true };
    const outputPath = /\.zip$/i.test(choice.filePath) ? choice.filePath : choice.filePath + '.zip';
    let lastProgress = -1;
    const result = await projectExport.exportProject({ target, templatePath: getExportTemplatePath(target),
      outputPath, projectName: name, config, assetsDir: ASSETS_DIR,
      sharedRuntimeSourcesDir: path.join(runtimeDirectory('ffmpeg'), 'sources'), onProgress: ({ completed, total }) => {
        const progress = Math.floor(10 * completed / Math.max(total, 1));
        if (progress !== lastProgress) { lastProgress = progress; send('A empacotar a aplicação: ' + progress * 10 + '%'); }
      } });
    send('Aplicação exportada: ' + result.path, 'success');
    return { ...result, ok: true };
  } catch (err) {
    send('Erro: ' + err.message, 'error');
    throw err;
  } finally { exportBusy = false; }
}
handleTrustedIpc('export:project', exportProject);
// Backwards-compatible bridge for older Builder renderers.
handleTrustedIpc('export:buildExe', (event, payload) => exportProject(event, { ...payload, target: 'windows' }));

handleTrustedIpc('export:revealInFolder', (_event, p) => {
  if (typeof p === 'string' && p && fs.existsSync(p)) {
    shell.showItemInFolder(p);
    return true;
  }
  return false;
});

/* -------- IPC: i18n -------- */

handleTrustedIpc('i18n:loadLocale', (_event, lang) => {
  const safeLang = ALLOWED_LANGS.has(lang) ? lang : 'pt';
  const filePath = path.join(LOCALES_DIR, safeLang + '.json');
  if (!fs.existsSync(filePath)) throw new Error('Ficheiro de tradução em falta: ' + safeLang);
  const raw = fs.readFileSync(filePath, 'utf-8');
  return { lang: safeLang, dict: JSON.parse(raw) };
});

handleTrustedIpc('language:save', (_event, lang) => {
  assertBuilder();
  const safeLang = ALLOWED_LANGS.has(lang) ? lang : 'pt';
  const current = readConfig();
  const updated = { ...current, language: safeLang };
  writeConfig(updated);
  return updated;
});

/* -------- App lifecycle -------- */

let webShutdownComplete = false;
app.on('before-quit', (event) => {
  if (webShutdownComplete) return;
  event.preventDefault();
  stopWebModules().finally(() => { webShutdownComplete = true; app.quit(); });
});

async function locateMacProject() {
  if (!(isViewer && app.isPackaged && process.platform === 'darwin')) return true;
  if (fs.existsSync(CONFIG_PATH)) return true;
  const choice = await dialog.showOpenDialog({
    title: 'Selecionar dados da aplicação',
    message: 'Mantenha a aplicação .app e a respetiva pasta .data juntas. Selecione a pasta .data deste projeto.',
    properties: ['openDirectory']
  });
  if (choice.canceled || !choice.filePaths[0]) return false;
  const base = choice.filePaths[0];
  const config = path.join(base, 'data', 'project-config.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(config, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.content)) throw new Error('Configuração inválida.');
  } catch (_) {
    dialog.showErrorBox('Dados não encontrados', 'A pasta escolhida não contém data/project-config.json válido.');
    return false;
  }
  WRITE_BASE = base;
  DATA_DIR = path.join(base, 'data'); ASSETS_DIR = path.join(base, 'dist-assets');
  CONFIG_PATH = config; ICON_DEST_PATH = path.join(DATA_DIR, 'icon.ico');
  return true;
}

app.whenReady().then(async () => {
  if (isViewer) {
    if (!await locateMacProject()) { app.quit(); return; }
    createViewerWindow({ standalone: true });
  } else {
    initProjects();
    readConfig();
    createBuilderWindow();
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (isViewer) createViewerWindow({ standalone: true });
      else createBuilderWindow();
    }
  });
}).catch(error => {
  console.error('Não foi possível abrir o projeto:', error);
  dialog.showErrorBox('Não foi possível abrir o projeto', error.message);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
