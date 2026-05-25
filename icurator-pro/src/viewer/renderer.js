/* Viewer renderer — renderiza o produto final a partir do project-config.json */

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

let config = null;

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
  // Accept full URLs, short URLs, embed URLs, or just an ID
  const idMatch =
    raw.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/) ||
    raw.match(/^([A-Za-z0-9_-]{6,})$/);
  if (idMatch) {
    return 'https://www.youtube.com/embed/' + idMatch[1];
  }
  return raw; // fallback — let iframe try it
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
    stageEl.innerHTML = '<div class="viewer-empty"><p>URL de vídeo em falta.</p></div>';
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
    stageEl.innerHTML = '<div class="viewer-empty"><p>Ficheiro PDF em falta.</p></div>';
    return;
  }
  const fileUrl = await relToFileUrl(data.file);
  // <webview> renders local PDFs reliably in Electron.
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
    stageEl.innerHTML = '<div class="viewer-empty"><p>URL em falta.</p></div>';
    return;
  }
  const wv = document.createElement('webview');
  wv.setAttribute('src', url);
  wv.setAttribute('allowpopups', 'true');
  stageEl.appendChild(wv);
}

async function handleExternal(data) {
  const url = (data && data.url) || '';
  if (!url) { showToast('URL em falta.'); return; }
  try {
    await window.viewer.openExternal(url);
  } catch (err) {
    showToast('Erro ao abrir link: ' + err.message);
  }
}

async function handleLaunch(data) {
  if (!data || !data.file) { showToast('Ficheiro em falta.'); return; }
  try {
    await window.viewer.launchFile(data.file);
  } catch (err) {
    showToast('Erro ao lançar ficheiro: ' + err.message);
  }
}

/* -------- Menu + dispatch -------- */

function buildMenu(modules) {
  menuEl.innerHTML = '';
  if (!modules || modules.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'viewer-menu-empty';
    empty.textContent = 'Nenhum módulo configurado.';
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
  // For types that change the stage, mark as active. For pass-through actions
  // (external, launch), do NOT mark active and do NOT clear the stage.
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
      catch (err) { showToast('Erro ao abrir link: ' + err.message); }
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
  optinHeading.textContent = leads.heading || 'Insira o seu email para aceder';
  optinFormHtml.innerHTML = leads.formHtml || '<p style="color:#64748b;text-align:center">(Sem formulário definido.)</p>';
  optinOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function hideOptinGate() {
  optinOverlay.classList.add('hidden');
  document.body.style.overflow = '';
}

optinBypass.addEventListener('click', hideOptinGate);

// If a form inside the user HTML is submitted, close the overlay.
optinFormHtml.addEventListener('submit', (e) => {
  e.preventDefault();
  hideOptinGate();
});

/* -------- Boot -------- */

async function boot() {
  try {
    config = await window.viewer.loadConfig();
  } catch (err) {
    showToast('Erro ao carregar configuração: ' + err.message);
    return;
  }

  // Brand / theme
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
  }

  // Menu
  buildMenu(Array.isArray(config.content) ? config.content : []);

  // Banner
  await renderBanner(config.marketing && config.marketing.banner);

  // Opt-in gate (last, so it sits on top)
  const leads = config.marketing && config.marketing.leads;
  if (leads && leads.enabled) showOptinGate(leads);
}

boot();
