/* Viewer renderer — universal player.
 *
 * Two boot paths:
 *   1. No project loaded (Universal Viewer fresh install) — show welcome
 *      overlay, ask the user to pick a .lbpro, extract, then re-boot.
 *   2. Project loaded — render brand/menu/banner/opt-in from project-config.
 *
 * The 4 promotional corners are wired exactly once and remain visible on
 * both paths (welcome screen + course screen).
 */

const sidebarEl = document.getElementById('viewer-sidebar');
const titleEl = document.getElementById('viewer-title');
const logoEl = document.getElementById('viewer-logo');
const menuEl = document.getElementById('viewer-menu');
const stageEl = document.getElementById('viewer-stage');

const optinOverlay = document.getElementById('optin-overlay');
const optinHeading = document.getElementById('optin-heading');
const optinFormHtml = document.getElementById('optin-form-html');
const optinBypass = document.getElementById('optin-bypass');

const bannerTopEl = document.getElementById('banner-top');
const bannerBottomEl = document.getElementById('banner-bottom');

const welcomeOverlay = document.getElementById('welcome-overlay');
const welcomeTitleEl = document.getElementById('welcome-title');
const welcomeSubtitleEl = document.getElementById('welcome-subtitle');
const welcomeLoadBtn = document.getElementById('welcome-load-btn');
const welcomeStatusEl = document.getElementById('welcome-status');

let config = null;
let i18nDict = {};

/* -------- i18n (minimal — viewer doesn't expose a language switcher) -------- */

function tr(key, fallback) {
  // Tiny dotted-path lookup against the loaded locale dictionary.
  const parts = key.split('.');
  let cur = i18nDict;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
    else return fallback !== undefined ? fallback : key;
  }
  return typeof cur === 'string' ? cur : (fallback !== undefined ? fallback : key);
}

async function loadViewerLocale() {
  try {
    const lang = await window.viewer.detectLocale();
    const { dict } = await window.viewer.loadLocale(lang);
    i18nDict = dict || {};
  } catch (_) {
    i18nDict = {};
  }
}

/* -------- Helpers -------- */

function applyTheme(brand) {
  const c = (brand && brand.colors) || {};
  const root = document.documentElement;
  if (c.sidebar) root.style.setProperty('--v-sidebar', c.sidebar);
  if (c.background) root.style.setProperty('--v-bg', c.background);
  if (c.buttons) root.style.setProperty('--v-button', c.buttons);
}

function toFileUrl(absPath) {
  if (!absPath) return null;
  let p = absPath.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  return 'file://' + p;
}

async function relToFileUrl(rel) {
  if (!rel) return null;
  const abs = await window.viewer.resolveAssetPath(rel);
  return toFileUrl(abs);
}

function showToast(message) {
  const t = document.createElement('div');
  t.className = 'viewer-toast';
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function youtubeEmbedUrl(input) {
  if (!input) return null;
  const raw = String(input).trim();
  const idMatch =
    raw.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/) ||
    raw.match(/^([A-Za-z0-9_-]{6,})$/);
  if (idMatch) return 'https://www.youtube.com/embed/' + idMatch[1];
  return raw;
}

function clearStage() {
  stageEl.className = 'viewer-stage';
  stageEl.innerHTML = '';
}

/* -------- Stage renderers (1 per type) -------- */

function renderYoutube(data) {
  clearStage();
  stageEl.classList.add('fill');
  const url = youtubeEmbedUrl(data && data.url);
  if (!url) {
    stageEl.innerHTML = '<div class="viewer-empty"><p>' + tr('viewer.video_missing', 'URL de vídeo em falta.') + '</p></div>';
    return;
  }
  const iframe = document.createElement('iframe');
  iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
  iframe.setAttribute('allowfullscreen', '');
  iframe.src = url;
  stageEl.appendChild(iframe);
}

function renderHtml(data) {
  clearStage();
  stageEl.classList.add('html-mode');
  const host = document.createElement('div');
  host.className = 'html-host';
  host.innerHTML = (data && data.html) || '';
  stageEl.appendChild(host);
}

async function renderPdf(data) {
  clearStage();
  stageEl.classList.add('fill');
  if (!data || !data.file) {
    stageEl.innerHTML = '<div class="viewer-empty"><p>' + tr('viewer.pdf_missing', 'Ficheiro PDF em falta.') + '</p></div>';
    return;
  }
  const fileUrl = await relToFileUrl(data.file);
  const wv = document.createElement('webview');
  wv.setAttribute('src', fileUrl);
  wv.setAttribute('allowpopups', 'true');
  stageEl.appendChild(wv);
}

function renderWebview(data) {
  clearStage();
  stageEl.classList.add('fill');
  const url = (data && data.url) || '';
  if (!url) {
    stageEl.innerHTML = '<div class="viewer-empty"><p>' + tr('viewer.url_missing', 'URL em falta.') + '</p></div>';
    return;
  }
  const wv = document.createElement('webview');
  wv.setAttribute('src', url);
  wv.setAttribute('allowpopups', 'true');
  stageEl.appendChild(wv);
}

async function handleExternal(data) {
  const url = (data && data.url) || '';
  if (!url) { showToast(tr('viewer.url_missing', 'URL em falta.')); return; }
  try {
    await window.viewer.openExternal(url);
  } catch (err) {
    showToast(tr('viewer.external_error_prefix', 'Erro ao abrir link: ') + err.message);
  }
}

async function handleLaunch(data) {
  if (!data || !data.file) { showToast(tr('viewer.file_missing', 'Ficheiro em falta.')); return; }
  try {
    await window.viewer.launchFile(data.file);
  } catch (err) {
    showToast(tr('viewer.launch_error_prefix', 'Erro ao lançar ficheiro: ') + err.message);
  }
}

/* -------- Menu + dispatch -------- */

function buildMenu(modules) {
  menuEl.innerHTML = '';
  if (!modules || modules.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'viewer-menu-empty';
    empty.textContent = tr('viewer.menu_empty', 'Nenhum módulo configurado.');
    menuEl.appendChild(empty);
    return;
  }
  modules.forEach((mod) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'viewer-menu-btn';
    btn.textContent = mod.title;
    btn.dataset.id = mod.id;
    btn.addEventListener('click', () => handleModuleClick(mod, btn));
    menuEl.appendChild(btn);
  });
}

function setActiveMenuBtn(btn) {
  menuEl.querySelectorAll('.viewer-menu-btn.active').forEach((el) => el.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

async function handleModuleClick(mod, btn) {
  switch (mod.type) {
    case 'youtube':  setActiveMenuBtn(btn); renderYoutube(mod.data); break;
    case 'html':     setActiveMenuBtn(btn); renderHtml(mod.data); break;
    case 'pdf':      setActiveMenuBtn(btn); await renderPdf(mod.data); break;
    case 'webview':  setActiveMenuBtn(btn); renderWebview(mod.data); break;
    case 'external': await handleExternal(mod.data); break;
    case 'launch':   await handleLaunch(mod.data); break;
    default: break;
  }
}

/* -------- Banner -------- */

async function renderBanner(banner) {
  bannerTopEl.classList.add('hidden');
  bannerBottomEl.classList.add('hidden');
  bannerTopEl.innerHTML = '';
  bannerBottomEl.innerHTML = '';
  document.body.classList.remove('banner-top', 'banner-bottom');

  if (!banner || !banner.enabled || !banner.image) return;

  const fileUrl = await relToFileUrl(banner.image);
  const host = banner.position === 'top' ? bannerTopEl : bannerBottomEl;

  const link = document.createElement('a');
  link.href = '#';
  link.addEventListener('click', async (e) => {
    e.preventDefault();
    if (banner.url) {
      try { await window.viewer.openExternal(banner.url); }
      catch (err) { showToast(tr('viewer.external_error_prefix', 'Erro ao abrir link: ') + err.message); }
    }
  });

  const img = document.createElement('img');
  img.src = fileUrl;
  img.alt = 'Banner';
  link.appendChild(img);
  host.appendChild(link);
  host.classList.remove('hidden');
  document.body.classList.add(banner.position === 'top' ? 'banner-top' : 'banner-bottom');
}

/* -------- Opt-in gate -------- */

function showOptinGate(leads) {
  optinHeading.textContent = leads.heading || tr('viewer.optin_default_heading', 'Insira o seu email para aceder');
  optinFormHtml.innerHTML = leads.formHtml || '<p style="color:#64748b;text-align:center">(Sem formulário definido.)</p>';
  optinOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function hideOptinGate() {
  optinOverlay.classList.add('hidden');
  document.body.style.overflow = '';
}

optinBypass.addEventListener('click', hideOptinGate);
optinFormHtml.addEventListener('submit', (e) => { e.preventDefault(); hideOptinGate(); });

/* -------- Welcome screen (Universal Viewer) -------- */

function applyWelcomeTranslations() {
  welcomeTitleEl.textContent = tr('viewer.welcome_title', 'Bem-vindo ao LaunchBox Viewer');
  welcomeSubtitleEl.textContent = tr('viewer.welcome_subtitle',
    'Por favor, selecione o seu ficheiro de projeto .lbpro para começar.');
  welcomeLoadBtn.textContent = tr('viewer.load_project_btn', 'Carregar Projeto');
  document.title = tr('viewer.welcome_window_title', 'LaunchBox Viewer');
  // Also fill the optin bypass label since that's the only other always-present
  // bit of UI text.
  optinBypass.textContent = tr('viewer.optin_bypass', optinBypass.textContent);
}

function showWelcome() {
  applyWelcomeTranslations();
  welcomeStatusEl.textContent = '';
  welcomeStatusEl.classList.remove('error');
  welcomeOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function hideWelcome() {
  welcomeOverlay.classList.add('hidden');
  document.body.style.overflow = '';
}

welcomeLoadBtn.addEventListener('click', async () => {
  welcomeLoadBtn.disabled = true;
  welcomeStatusEl.classList.remove('error');
  welcomeStatusEl.textContent = tr('viewer.loading', 'A carregar projeto…');
  try {
    const result = await window.viewer.loadProject();
    if (result && result.cancelled) {
      welcomeStatusEl.textContent = '';
      return;
    }
    if (result && result.ok) {
      // Re-boot in "loaded" mode now that the extraction wrote the new
      // project-config.json + dist-assets/ into our writable area.
      hideWelcome();
      await bootLoaded();
    }
  } catch (err) {
    welcomeStatusEl.classList.add('error');
    welcomeStatusEl.textContent = tr('viewer.load_error_prefix', 'Erro ao carregar projeto: ')
      + (err && err.message ? err.message : String(err));
  } finally {
    welcomeLoadBtn.disabled = false;
  }
});

/* -------- Boot -------- */

async function bootLoaded() {
  try {
    config = await window.viewer.loadConfig();
  } catch (err) {
    showToast(tr('viewer.config_error_prefix', 'Erro ao carregar configuração: ') + err.message);
    return;
  }

  // Re-load locale based on the project's saved language preference.
  if (config && config.language) {
    try {
      const { dict } = await window.viewer.loadLocale(config.language);
      i18nDict = dict || i18nDict;
    } catch (_) { /* keep previous dict */ }
  }

  applyTheme(config.brand);
  const title = (config.brand && config.brand.title) || 'LaunchBox Pro';
  titleEl.textContent = title;
  document.title = title;

  if (config.brand && config.brand.logo) {
    const logoUrl = await relToFileUrl(config.brand.logo);
    if (logoUrl) {
      logoEl.src = logoUrl;
      logoEl.classList.remove('hidden');
    }
  } else {
    logoEl.classList.add('hidden');
    logoEl.removeAttribute('src');
  }

  // Translate the static "viewer-empty" placeholder in the stage area.
  const emptyHeading = stageEl.querySelector('.viewer-empty h2');
  const emptyText = stageEl.querySelector('.viewer-empty p');
  if (emptyHeading) emptyHeading.textContent = tr('viewer.empty_heading', 'Bem-vindo');
  if (emptyText) emptyText.textContent = tr('viewer.empty_text', 'Selecione uma opção no menu para começar.');

  buildMenu(Array.isArray(config.content) ? config.content : []);
  await renderBanner(config.marketing && config.marketing.banner);

  const leads = config.marketing && config.marketing.leads;
  if (leads && leads.enabled) showOptinGate(leads);
}

async function boot() {
  await loadViewerLocale();
  let projectLoaded = false;
  try {
    projectLoaded = await window.viewer.hasProject();
  } catch (_) {
    projectLoaded = false;
  }
  if (projectLoaded) {
    await bootLoaded();
  } else {
    showWelcome();
  }
}

/* =========================================================
 * Cantos promocionais — abrem no browser do sistema.
 * Hardcoded em index.html, sempre visíveis (welcome + course).
 * ========================================================= */
function wireCornerLinks() {
  document.querySelectorAll('.corner-link[data-ext]').forEach((a) => {
    a.addEventListener('click', async (ev) => {
      ev.preventDefault();
      const url = a.getAttribute('data-ext');
      if (!url) return;
      try {
        await window.viewer.openExternal(url);
      } catch (err) {
        console.error('Falha a abrir link promocional:', err);
      }
    });
  });
}
wireCornerLinks();

boot();
