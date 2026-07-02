/* Viewer renderer — SFX-stamped player.
 *
 * No welcome / load-project flow: the Viewer is only ever launched from a
 * self-extracting course .exe, which guarantees project-config.json exists
 * at process.resourcesPath/data/project-config.json before this code runs.
 *
 * The 4 promotional corners are wired in index.html and stay visible above
 * everything else (z-index in styles.css).
 */

const sidebarEl = document.getElementById('viewer-sidebar');
const titleEl = document.getElementById('viewer-title');
const logoEl = document.getElementById('viewer-logo');
const menuEl = document.getElementById('viewer-menu');
const socialEl = document.getElementById('viewer-social');
const stageEl = document.getElementById('viewer-stage');
let currentHls = null;   // active hls.js instance for the IPTV player (destroyed on stage change)
let iptvCleanup = null;  // tears down the IPTV favourites popover + its document listener

const optinOverlay = document.getElementById('optin-overlay');
const optinHeading = document.getElementById('optin-heading');
const optinFormHtml = document.getElementById('optin-form-html');
const optinAccess = document.getElementById('optin-access');

const bannerTopEl = document.getElementById('banner-top');
const bannerBottomEl = document.getElementById('banner-bottom');

let config = null;
let i18nDict = {};

/* -------- i18n (com seletor de idioma em direto no Viewer) -------- */

const ALLOWED_LANGS = ['pt', 'en', 'es', 'fr', 'hi', 'ar', 'zh', 'bn', 'ru', 'id'];
const RTL_LANGS = ['ar'];

function applyDir(lang) {
  document.documentElement.setAttribute('lang', lang);
  document.documentElement.setAttribute('dir', RTL_LANGS.includes(lang) ? 'rtl' : 'ltr');
}

function tr(key, fallback) {
  const parts = key.split('.');
  let cur = i18nDict;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
    else return fallback !== undefined ? fallback : key;
  }
  return typeof cur === 'string' ? cur : (fallback !== undefined ? fallback : key);
}

/* Apply translations to any element marked with data-i18n attributes.
 * Called once on boot after the locale dictionary is loaded — keeps the
 * static markup (corners, optin heading, etc.) in sync with the chosen
 * language without each piece of code needing to set textContent manually. */
function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const v = tr(el.getAttribute('data-i18n'), null);
    if (typeof v === 'string') el.textContent = v;
  });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const v = tr(el.getAttribute('data-i18n-html'), null);
    if (typeof v === 'string') el.innerHTML = v;
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const v = tr(el.getAttribute('data-i18n-placeholder'), null);
    if (typeof v === 'string') el.setAttribute('placeholder', v);
  });
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

function youtubeEmbedUrl(input) {
  if (!input) return null;
  const id = extractYoutubeId(input);
  if (id) return 'https://www.youtube.com/embed/' + id;
  const raw = String(input).trim();
  return raw || null;
}

function clearStage() {
  destroyHls();
  if (iptvCleanup) { try { iptvCleanup(); } catch (_) { /* noop */ } iptvCleanup = null; }
  stageEl.className = 'viewer-stage';
  stageEl.innerHTML = '';
}

function destroyHls() {
  if (currentHls) {
    try { currentHls.destroy(); } catch (_) { /* noop */ }
    currentHls = null;
  }
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
  /* Usa <webview> em vez de <iframe>: dentro de uma página file:// o iframe
   * envia um referrer file:// que o YouTube rejeita (Erro 153). O webview
   * navega como documento de topo em youtube.com, sem esse referrer. */
  const wv = document.createElement('webview');
  wv.setAttribute('src', url);
  wv.setAttribute('allowpopups', 'true');
  wv.setAttribute('allowfullscreen', '');
  stageEl.appendChild(wv);
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

async function renderLocalVideo(data) {
  clearStage();
  stageEl.classList.add('media-mode');
  const url = await relToFileUrl(data && data.file);
  if (!url) {
    stageEl.innerHTML = '<div class="viewer-empty"><p>' + tr('viewer.local_video_missing', 'Ficheiro de vídeo em falta.') + '</p></div>';
    return;
  }
  const v = document.createElement('video');
  v.setAttribute('controls', '');
  v.className = 'media-video';
  v.src = url;
  stageEl.appendChild(v);
}

async function renderLocalAudio(data) {
  clearStage();
  stageEl.classList.add('media-mode');
  const url = await relToFileUrl(data && data.file);
  if (!url) {
    stageEl.innerHTML = '<div class="viewer-empty"><p>' + tr('viewer.local_audio_missing', 'Ficheiro de áudio em falta.') + '</p></div>';
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'media-audio-wrap';
  const a = document.createElement('audio');
  a.setAttribute('controls', '');
  a.className = 'media-audio';
  a.src = url;
  wrap.appendChild(a);
  stageEl.appendChild(wrap);
}

async function renderGallery(data) {
  clearStage();
  stageEl.classList.add('gallery-mode');
  const images = (data && Array.isArray(data.images)) ? data.images : [];
  if (images.length === 0) {
    stageEl.innerHTML = '<div class="viewer-empty"><p>' + tr('viewer.gallery_empty', 'Galeria sem imagens.') + '</p></div>';
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'gallery-grid';
  for (const img of images) {
    const relFile = img && img.file;
    const url = await relToFileUrl(relFile);
    if (!url) continue;
    const fileName = (img && img.fileName) || '';
    const cell = document.createElement('div');
    cell.className = 'gallery-cell';
    const el = document.createElement('img');
    el.src = url;
    el.alt = fileName;
    el.loading = 'lazy';
    cell.appendChild(el);
    cell.addEventListener('click', () => openLightbox(url, fileName, relFile));
    grid.appendChild(cell);
  }
  stageEl.appendChild(grid);
}

/* Janela ampliada (lightbox) para a galeria: clicar numa imagem abre-a em
 * grande sobre o curso, com botão para descarregar. Fecha com ×, clique no
 * fundo ou Escape. */
function openLightbox(url, fileName, relFile) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';

  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const box = document.createElement('div');
  box.className = 'lightbox-box';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'lightbox-close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', close);

  const bigImg = document.createElement('img');
  bigImg.className = 'lightbox-img';
  bigImg.src = url;
  bigImg.alt = fileName;

  const bar = document.createElement('div');
  bar.className = 'lightbox-bar';

  const dlBtn = document.createElement('button');
  dlBtn.type = 'button';
  dlBtn.className = 'dl-btn lightbox-dl';
  dlBtn.textContent = tr('viewer.download_btn_default', 'Descarregar ficheiro');
  if (!relFile) {
    dlBtn.disabled = true;
  } else {
    dlBtn.addEventListener('click', async () => {
      dlBtn.disabled = true;
      try {
        const res = await window.viewer.saveFileAs({ file: relFile, fileName });
        if (res && res.ok) showToast(tr('viewer.download_done', 'Ficheiro guardado.'));
      } catch (err) {
        showToast(tr('viewer.download_error_prefix', 'Erro ao guardar: ') + err.message);
      } finally {
        dlBtn.disabled = false;
      }
    });
  }
  bar.appendChild(dlBtn);

  box.append(closeBtn, bigImg, bar);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function renderArticle(data) {
  clearStage();
  stageEl.classList.add('html-mode');
  const host = document.createElement('div');
  host.className = 'html-host article-host';
  host.innerHTML = miniMarkdown((data && data.text) || '');
  stageEl.appendChild(host);
}

function renderDownloadVault(data) {
  clearStage();
  const host = document.createElement('div');
  host.className = 'viewer-empty';
  const card = document.createElement('div');
  card.className = 'dl-card';
  const icon = document.createElement('div');
  icon.className = 'dl-icon';
  icon.textContent = '📦';
  const name = document.createElement('p');
  name.className = 'dl-name';
  name.textContent = (data && data.fileName) || '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dl-btn';
  btn.textContent = (data && data.buttonLabel) || tr('viewer.download_btn_default', 'Descarregar ficheiro');
  if (!data || !data.file) {
    btn.disabled = true;
  } else {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await window.viewer.saveFileAs({ file: data.file, fileName: data.fileName });
        if (res && res.ok) showToast(tr('viewer.download_done', 'Ficheiro guardado.'));
      } catch (err) {
        showToast(tr('viewer.download_error_prefix', 'Erro ao guardar: ') + err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }
  card.append(icon, name, btn);
  host.appendChild(card);
  stageEl.appendChild(host);
}

function renderCommunity(data) {
  clearStage();
  const url = (data && data.url) || '';
  const platform = (data && data.platform) || 'generic';
  const host = document.createElement('div');
  host.className = 'viewer-empty';
  const card = document.createElement('div');
  card.className = 'community-card platform-' + platform;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'community-btn platform-' + platform;
  btn.textContent = (data && data.buttonLabel) || tr('viewer.community_btn_default', 'Entrar na comunidade');
  if (!url) {
    btn.disabled = true;
  } else {
    btn.addEventListener('click', async () => {
      try { await window.viewer.openExternal(url); }
      catch (err) { showToast(tr('viewer.external_error_prefix', 'Erro ao abrir link: ') + err.message); }
    });
  }
  card.append(btn);
  host.appendChild(card);
  stageEl.appendChild(host);
}

/* Conversor Markdown minimalista e seguro: escapa HTML primeiro e só depois
 * aplica títulos, listas, negrito/itálico, código e links. */
function miniMarkdown(src) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s) => s.replace(/"/g, '&quot;');
  const safeUrl = (u) => /^https?:\/\//i.test(u) ? u : '';
  const text = esc(String(src || '')).replace(/\r\n/g, '\n');
  const inline = (s) => s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
      const u = safeUrl(url);
      return u ? '<img alt="' + escAttr(alt) + '" src="' + escAttr(u) + '" />' : escAttr(alt);
    })
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const u = safeUrl(url);
      return u ? '<a href="' + escAttr(u) + '" target="_blank" rel="noopener">' + label + '</a>' : label;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const lines = text.split('\n');
  let html = '';
  let inList = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    const li = line.match(/^[-*]\s+(.*)$/);
    if (h) {
      if (inList) { html += '</ul>'; inList = false; }
      const lvl = h[1].length;
      html += '<h' + lvl + '>' + inline(h[2]) + '</h' + lvl + '>';
    } else if (li) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += '<li>' + inline(li[1]) + '</li>';
    } else if (line.trim() === '') {
      if (inList) { html += '</ul>'; inList = false; }
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<p>' + inline(line) + '</p>';
    }
  }
  if (inList) html += '</ul>';
  return html;
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
    const hasPwd = mod && typeof mod.password === 'string' && mod.password.trim() !== '';
    if (hasPwd) {
      btn.classList.add('locked');
      const lock = document.createElement('span');
      lock.className = 'viewer-menu-lock';
      lock.textContent = '🔒';
      lock.title = tr('viewer.locked_hint', 'Protegido por senha');
      btn.appendChild(lock);
    }
    btn.dataset.id = mod.id;
    btn.addEventListener('click', () => handleModuleClick(mod, btn));
    menuEl.appendChild(btn);
  });
}

/* -------- Redes sociais (menu lateral) -------- */
const SOCIAL_ORDER = ['site', 'instagram', 'facebook', 'x', 'tiktok', 'pinterest', 'linkedin', 'spotify', 'whatsapp', 'telegram'];
const SOCIAL_LABELS = {
  site: 'Site', instagram: 'Instagram', facebook: 'Facebook', x: 'X', tiktok: 'TikTok',
  pinterest: 'Pinterest', linkedin: 'LinkedIn', spotify: 'Spotify', whatsapp: 'WhatsApp', telegram: 'Telegram'
};
const SOCIAL_ICONS = {
  site: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.94-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z',
  instagram: 'M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077',
  facebook: 'M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z',
  x: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z',
  tiktok: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z',
  pinterest: 'M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.099.12.112.225.085.345-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.401.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.354-.629-2.758-1.379l-.749 2.848c-.269 1.045-1.004 2.352-1.498 3.146 1.123.345 2.306.535 3.55.535 6.607 0 11.985-5.365 11.985-11.987C23.97 5.39 18.592.026 11.985.026L12.017 0z',
  linkedin: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z',
  spotify: 'M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z',
  whatsapp: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z',
  telegram: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z'
};

function renderSocial(social) {
  if (!socialEl) return;
  socialEl.innerHTML = '';
  const s = social || {};
  const active = SOCIAL_ORDER.filter((k) => typeof s[k] === 'string' && /^https?:\/\//i.test(s[k].trim()));
  if (active.length === 0) { socialEl.classList.add('hidden'); return; }
  socialEl.classList.remove('hidden');
  active.forEach((k) => {
    const url = s[k].trim();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'viewer-social-btn';
    btn.title = SOCIAL_LABELS[k];
    btn.setAttribute('aria-label', SOCIAL_LABELS[k]);
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="' + (SOCIAL_ICONS[k] || '') + '"/></svg>';
    btn.addEventListener('click', () => { window.viewer.openExternal(url); });
    socialEl.appendChild(btn);
  });
}

function setActiveMenuBtn(btn) {
  menuEl.querySelectorAll('.viewer-menu-btn.active').forEach((el) => el.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

const unlockedModules = new Set();
let activeModuleRef = null;

async function handleModuleClick(mod, btn) {
  // Só memorizamos módulos que desenham no palco. 'external'/'launch' têm
  // efeitos (abrir link/ficheiro) e não devem ser re-disparados ao mudar de
  // idioma; assim mantemos a referência do último módulo visível.
  if (mod && mod.type !== 'external' && mod.type !== 'launch') {
    activeModuleRef = { mod, btn };
  }
  const pwd = (mod && typeof mod.password === 'string') ? mod.password.trim() : '';
  if (pwd && !unlockedModules.has(mod.id)) {
    setActiveMenuBtn(btn);
    renderPasswordGate(mod, btn, pwd);
    return;
  }
  await dispatchModule(mod, btn);
}

/* Favoritos de IPTV — guardados localmente (localStorage) no computador do
 * aluno. A chave inclui o curso + módulo para não misturar favoritos entre
 * cursos diferentes que partilham o mesmo Viewer. */
function iptvFavKey(moduleId) {
  const base = (document.title || 'curso') + '::' + (moduleId || 'iptv');
  return 'lbxIptvFav::' + base;
}
function loadFavs(moduleId) {
  try {
    const raw = localStorage.getItem(iptvFavKey(moduleId));
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && Array.isArray(obj.folders)) return obj;
    }
  } catch (_) { /* noop */ }
  return { folders: [] };
}
function saveFavs(moduleId, data) {
  try { localStorage.setItem(iptvFavKey(moduleId), JSON.stringify(data)); } catch (_) { /* noop */ }
}

function renderIptv(data, moduleId) {
  clearStage();
  stageEl.classList.add('iptv-mode');
  const channels = (data && Array.isArray(data.channels)) ? data.channels : [];
  if (channels.length === 0) {
    stageEl.innerHTML = '<div class="viewer-empty"><p>' + tr('viewer.iptv_empty', 'Sem canais para mostrar.') + '</p></div>';
    return;
  }

  const RENDER_CAP = 500;

  // ---- Estado dos favoritos ----
  const favs = loadFavs(moduleId);
  let view = 'all'; // 'all' | 'favs'
  let editingFolderId = null;
  let deletingFolderId = null;
  let creatingFolder = false;

  const chanKey = (ch) => (ch && (ch.url || ch.name)) || '';
  const byKey = new Map();
  for (const ch of channels) {
    const k = chanKey(ch);
    if (k && !byKey.has(k)) byKey.set(k, ch);
  }
  const persist = () => saveFavs(moduleId, favs);
  const isFav = (ch) => favs.folders.some((f) => f.keys.indexOf(chanKey(ch)) !== -1);
  const genId = () => 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---- Estrutura ----
  const wrap = document.createElement('div');
  wrap.className = 'iptv-wrap';

  const side = document.createElement('div');
  side.className = 'iptv-side';

  const tabs = document.createElement('div');
  tabs.className = 'iptv-tabs';
  const tabAll = document.createElement('button');
  tabAll.type = 'button';
  tabAll.className = 'iptv-tab active';
  tabAll.textContent = tr('viewer.iptv_tab_all', 'Todos');
  const tabFav = document.createElement('button');
  tabFav.type = 'button';
  tabFav.className = 'iptv-tab';
  tabFav.textContent = tr('viewer.iptv_tab_favs', 'Favoritos');
  tabs.appendChild(tabAll);
  tabs.appendChild(tabFav);

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'iptv-search';
  search.placeholder = tr('viewer.iptv_search', 'Procurar canal…');
  const listEl = document.createElement('div');
  listEl.className = 'iptv-list';
  side.appendChild(tabs);
  side.appendChild(search);
  side.appendChild(listEl);

  const main = document.createElement('div');
  main.className = 'iptv-player';
  const now = document.createElement('div');
  now.className = 'iptv-now';
  now.textContent = tr('viewer.iptv_pick', 'Escolha um canal para começar.');
  const video = document.createElement('video');
  video.className = 'iptv-video';
  video.controls = true;
  video.setAttribute('playsinline', '');
  main.appendChild(now);
  main.appendChild(video);

  wrap.appendChild(side);
  wrap.appendChild(main);
  stageEl.appendChild(wrap);

  let activeItem = null;

  function looksLikeHls(url) {
    return /\.m3u8(\?|$)/i.test(url) || /(get\.php|type=m3u|\/live\/)/i.test(url);
  }

  video.addEventListener('error', () => {
    now.textContent = tr('viewer.iptv_play_error', 'Não foi possível reproduzir este canal.');
  });

  function play(ch, item) {
    destroyHls();
    if (activeItem) activeItem.classList.remove('active');
    activeItem = item || null;
    if (activeItem) activeItem.classList.add('active');
    now.textContent = ch.name || '';
    const url = ch.url;
    if (!url) return;
    try { video.pause(); } catch (_) { /* noop */ }
    video.removeAttribute('src');
    try { video.load(); } catch (_) { /* noop */ }
    if (looksLikeHls(url) && window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({ maxBufferLength: 20, enableWorker: true });
      currentHls = hls;
      hls.on(window.Hls.Events.ERROR, (_evt, d) => {
        if (d && d.fatal) {
          now.textContent = tr('viewer.iptv_play_error', 'Não foi possível reproduzir este canal.');
          destroyHls();
        }
      });
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else {
      // Reprodução nativa (ficheiros .mp4 remotos, ou HLS onde suportado).
      video.src = url;
      video.play().catch(() => {});
    }
  }

  // ---- Menu flutuante para escolher/criar pasta ao clicar na estrela ----
  let openPicker = null;
  function closePicker() {
    if (openPicker) {
      openPicker.remove();
      openPicker = null;
      document.removeEventListener('click', onDocClick, true);
    }
  }
  function onDocClick(e) {
    if (openPicker && !openPicker.contains(e.target)) closePicker();
  }
  iptvCleanup = closePicker;
  function openFolderPicker(ch, anchorBtn) {
    closePicker();
    const key = chanKey(ch);
    const pop = document.createElement('div');
    pop.className = 'iptv-picker';

    const head = document.createElement('div');
    head.className = 'iptv-picker-head';
    head.textContent = tr('viewer.iptv_add_to_folder', 'Adicionar a favoritos');
    pop.appendChild(head);

    favs.folders.forEach((folder) => {
      const row = document.createElement('label');
      row.className = 'iptv-picker-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = folder.keys.indexOf(key) !== -1;
      cb.addEventListener('change', () => {
        if (cb.checked) { if (folder.keys.indexOf(key) === -1) folder.keys.push(key); }
        else { folder.keys = folder.keys.filter((k) => k !== key); }
        persist();
        if (anchorBtn) anchorBtn.classList.toggle('on', isFav(ch));
      });
      const nm = document.createElement('span');
      nm.textContent = folder.name;
      row.appendChild(cb);
      row.appendChild(nm);
      pop.appendChild(row);
    });

    const newRow = document.createElement('div');
    newRow.className = 'iptv-picker-new';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = tr('viewer.iptv_new_folder', 'Nova pasta');
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = '+';
    const doAdd = () => {
      const name = (input.value || '').trim();
      if (!name) return;
      favs.folders.push({ id: genId(), name, keys: [key], _open: true });
      persist();
      if (anchorBtn) anchorBtn.classList.add('on');
      openFolderPicker(ch, anchorBtn);
    };
    addBtn.addEventListener('click', doAdd);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
    newRow.appendChild(input);
    newRow.appendChild(addBtn);
    pop.appendChild(newRow);

    document.body.appendChild(pop);
    const r = anchorBtn.getBoundingClientRect();
    let top = r.bottom + 4;
    if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - pop.offsetHeight - 4);
    let left = r.right - pop.offsetWidth;
    if (left < 8) left = 8;
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
    openPicker = pop;
    setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
    input.focus();
  }

  // ---- Cartão de canal (usado nas duas vistas) ----
  function makeChannelItem(ch, opts) {
    opts = opts || {};
    const item = document.createElement('div');
    item.className = 'iptv-item';

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'iptv-item-btn';
    if (ch.logo) {
      const img = document.createElement('img');
      img.className = 'iptv-item-logo';
      img.src = ch.logo;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
      playBtn.appendChild(img);
    }
    const label = document.createElement('span');
    label.className = 'iptv-item-name';
    label.textContent = ch.name || ch.url || '';
    playBtn.appendChild(label);
    playBtn.addEventListener('click', () => play(ch, item));
    item.appendChild(playBtn);

    if (opts.showStar) {
      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'iptv-star' + (isFav(ch) ? ' on' : '');
      star.textContent = '★';
      star.title = tr('viewer.iptv_add_to_folder', 'Adicionar a favoritos');
      star.addEventListener('click', (e) => { e.stopPropagation(); openFolderPicker(ch, star); });
      item.appendChild(star);
    }
    if (opts.showRemove) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'iptv-remove';
      rm.textContent = '✕';
      rm.title = tr('viewer.iptv_remove_from_folder', 'Remover da pasta');
      rm.addEventListener('click', (e) => { e.stopPropagation(); opts.onRemove(); });
      item.appendChild(rm);
    }
    return item;
  }

  // ---- Vista "Todos" ----
  function renderAll(filter) {
    listEl.innerHTML = '';
    const f = (filter || '').trim().toLowerCase();
    let shown = 0;
    for (const ch of channels) {
      const name = ch.name || ch.url || '';
      if (f && name.toLowerCase().indexOf(f) === -1) continue;
      listEl.appendChild(makeChannelItem(ch, { showStar: true }));
      shown++;
      if (shown >= RENDER_CAP) {
        const more = document.createElement('div');
        more.className = 'iptv-more';
        more.textContent = tr('viewer.iptv_more', 'A mostrar os primeiros 500 — use a pesquisa para filtrar.');
        listEl.appendChild(more);
        break;
      }
    }
    if (shown === 0) {
      const none = document.createElement('div');
      none.className = 'iptv-more';
      none.textContent = tr('viewer.iptv_no_results', 'Nenhum canal encontrado.');
      listEl.appendChild(none);
    }
  }

  function makeInlineEditor(initial, onCommit, onCancel) {
    const row = document.createElement('div');
    row.className = 'iptv-fav-newrow';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'iptv-fav-input';
    input.placeholder = tr('viewer.iptv_folder_name', 'Nome da pasta');
    input.value = initial || '';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'iptv-fav-ok';
    ok.textContent = '✓';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'iptv-fav-cancel';
    cancel.textContent = '✕';
    const commit = () => { onCommit((input.value || '').trim()); };
    ok.addEventListener('click', commit);
    cancel.addEventListener('click', onCancel);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    });
    row.appendChild(input);
    row.appendChild(ok);
    row.appendChild(cancel);
    setTimeout(() => input.focus(), 0);
    return row;
  }

  // ---- Vista "Favoritos" ----
  function renderFavs(filter) {
    listEl.innerHTML = '';
    const f = (filter || '').trim().toLowerCase();

    const headRow = document.createElement('div');
    headRow.className = 'iptv-fav-head';
    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'iptv-fav-new';
    newBtn.textContent = '+ ' + tr('viewer.iptv_new_folder', 'Nova pasta');
    newBtn.addEventListener('click', () => { creatingFolder = true; renderFavs(search.value); });
    headRow.appendChild(newBtn);
    listEl.appendChild(headRow);

    if (creatingFolder) {
      listEl.appendChild(makeInlineEditor('', (name) => {
        if (name) favs.folders.push({ id: genId(), name, keys: [], _open: true });
        persist();
        creatingFolder = false;
        renderFavs(search.value);
      }, () => { creatingFolder = false; renderFavs(search.value); }));
    }

    if (favs.folders.length === 0 && !creatingFolder) {
      const none = document.createElement('div');
      none.className = 'iptv-more';
      none.textContent = tr('viewer.iptv_no_favs', 'Ainda não tem pastas de favoritos. Crie uma para guardar os seus canais.');
      listEl.appendChild(none);
      return;
    }

    favs.folders.forEach((folder) => {
      const fEl = document.createElement('div');
      fEl.className = 'iptv-folder';

      if (editingFolderId === folder.id) {
        fEl.appendChild(makeInlineEditor(folder.name, (name) => {
          if (name) { folder.name = name; persist(); }
          editingFolderId = null;
          renderFavs(search.value);
        }, () => { editingFolderId = null; renderFavs(search.value); }));
        listEl.appendChild(fEl);
        return;
      }

      if (deletingFolderId === folder.id) {
        const confirmRow = document.createElement('div');
        confirmRow.className = 'iptv-fav-confirm';
        const msg = document.createElement('span');
        msg.textContent = tr('viewer.iptv_delete_confirm', 'Apagar esta pasta?');
        const yes = document.createElement('button');
        yes.type = 'button';
        yes.className = 'iptv-fav-yes';
        yes.textContent = '✓';
        yes.addEventListener('click', () => {
          favs.folders = favs.folders.filter((x) => x.id !== folder.id);
          persist();
          deletingFolderId = null;
          renderFavs(search.value);
        });
        const no = document.createElement('button');
        no.type = 'button';
        no.className = 'iptv-fav-cancel';
        no.textContent = '✕';
        no.addEventListener('click', () => { deletingFolderId = null; renderFavs(search.value); });
        confirmRow.appendChild(msg);
        confirmRow.appendChild(yes);
        confirmRow.appendChild(no);
        fEl.appendChild(confirmRow);
        listEl.appendChild(fEl);
        return;
      }

      const fhead = document.createElement('div');
      fhead.className = 'iptv-folder-head';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'iptv-folder-toggle';
      toggle.textContent = (folder._open ? '▾ ' : '▸ ') + folder.name + ' (' + folder.keys.length + ')';
      toggle.addEventListener('click', () => { folder._open = !folder._open; persist(); renderFavs(search.value); });
      fhead.appendChild(toggle);

      const ren = document.createElement('button');
      ren.type = 'button';
      ren.className = 'iptv-folder-act';
      ren.textContent = '✎';
      ren.title = tr('viewer.iptv_rename_folder', 'Renomear');
      ren.addEventListener('click', () => { editingFolderId = folder.id; renderFavs(search.value); });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'iptv-folder-act';
      del.textContent = '🗑';
      del.title = tr('viewer.iptv_delete_folder', 'Apagar pasta');
      del.addEventListener('click', () => { deletingFolderId = folder.id; renderFavs(search.value); });
      fhead.appendChild(ren);
      fhead.appendChild(del);
      fEl.appendChild(fhead);

      if (folder._open) {
        const body = document.createElement('div');
        body.className = 'iptv-folder-body';
        const keys = folder.keys.filter((k) => {
          const ch = byKey.get(k);
          if (!ch) return false;
          const name = (ch.name || ch.url || '').toLowerCase();
          return !f || name.indexOf(f) !== -1;
        });
        if (keys.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'iptv-more';
          empty.textContent = tr('viewer.iptv_folder_empty', 'Pasta vazia.');
          body.appendChild(empty);
        } else {
          keys.forEach((k) => {
            const ch = byKey.get(k);
            body.appendChild(makeChannelItem(ch, {
              showRemove: true,
              onRemove: () => {
                folder.keys = folder.keys.filter((x) => x !== k);
                persist();
                renderFavs(search.value);
              },
            }));
          });
        }
        fEl.appendChild(body);
      }
      listEl.appendChild(fEl);
    });
  }

  function render() {
    closePicker();
    if (view === 'all') renderAll(search.value);
    else renderFavs(search.value);
  }

  tabAll.addEventListener('click', () => {
    view = 'all';
    tabAll.classList.add('active');
    tabFav.classList.remove('active');
    render();
  });
  tabFav.addEventListener('click', () => {
    view = 'favs';
    tabFav.classList.add('active');
    tabAll.classList.remove('active');
    render();
  });

  let searchTimer = null;
  search.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 120);
  });

  render();
}

async function dispatchModule(mod, btn) {
  switch (mod.type) {
    case 'youtube':  setActiveMenuBtn(btn); renderYoutube(mod.data); break;
    case 'html':     setActiveMenuBtn(btn); renderHtml(mod.data); break;
    case 'pdf':      setActiveMenuBtn(btn); await renderPdf(mod.data); break;
    case 'webview':  setActiveMenuBtn(btn); renderWebview(mod.data); break;
    case 'smart-embed':    setActiveMenuBtn(btn); renderWebview(mod.data); break;
    case 'local-video':    setActiveMenuBtn(btn); await renderLocalVideo(mod.data); break;
    case 'local-audio':    setActiveMenuBtn(btn); await renderLocalAudio(mod.data); break;
    case 'image-gallery':  setActiveMenuBtn(btn); await renderGallery(mod.data); break;
    case 'article-reader': setActiveMenuBtn(btn); renderArticle(mod.data); break;
    case 'download-vault': setActiveMenuBtn(btn); renderDownloadVault(mod.data); break;
    case 'community-link': setActiveMenuBtn(btn); renderCommunity(mod.data); break;
    case 'iptv':     setActiveMenuBtn(btn); renderIptv(mod.data, mod.id); break;
    case 'external': await handleExternal(mod.data); break;
    case 'launch':   await handleLaunch(mod.data); break;
    default: break;
  }
}

/* In-stage password gate for protected modules. Once the correct password is
 * entered, the module stays unlocked for the rest of the viewing session. */
function renderPasswordGate(mod, btn, pwd) {
  clearStage();
  const host = document.createElement('div');
  host.className = 'viewer-empty';

  const card = document.createElement('div');
  card.className = 'pw-gate';

  const icon = document.createElement('div');
  icon.className = 'pw-gate-icon';
  icon.textContent = '🔒';

  const h = document.createElement('h2');
  h.textContent = tr('viewer.pw_title', 'Módulo protegido');

  const p = document.createElement('p');
  p.textContent = tr('viewer.pw_prompt', 'Introduza a senha para aceder a este módulo.');

  const form = document.createElement('form');
  form.className = 'pw-gate-form';
  form.autocomplete = 'off';

  const input = document.createElement('input');
  input.type = 'password';
  input.className = 'pw-gate-input';
  input.autocomplete = 'off';
  input.setAttribute('placeholder', tr('viewer.pw_placeholder', 'Senha'));

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'pw-gate-btn';
  submit.textContent = tr('viewer.pw_submit', 'Aceder');

  const error = document.createElement('div');
  error.className = 'pw-gate-error';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (input.value === pwd) {
      unlockedModules.add(mod.id);
      if (btn) {
        btn.classList.remove('locked');
        const lock = btn.querySelector('.viewer-menu-lock');
        if (lock) lock.remove();
      }
      await dispatchModule(mod, btn);
    } else {
      error.textContent = tr('viewer.pw_wrong', 'Senha incorreta.');
      input.value = '';
      input.focus();
    }
  });

  form.append(input, submit);
  card.append(icon, h, p, form, error);
  host.appendChild(card);
  stageEl.appendChild(host);
  input.focus();
}

/* -------- Banner -------- */

async function renderBanner(banners) {
  bannerTopEl.classList.add('hidden');
  bannerBottomEl.classList.add('hidden');
  bannerTopEl.innerHTML = '';
  bannerBottomEl.innerHTML = '';
  document.body.classList.remove('banner-top', 'banner-bottom');

  const b = banners || {};
  await renderBannerSlot('top', b.top, bannerTopEl);
  await renderBannerSlot('bottom', b.bottom, bannerBottomEl);
}

async function renderBannerSlot(position, banner, host) {
  if (!banner || !banner.enabled || !banner.image) return;

  const fileUrl = await relToFileUrl(banner.image);

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
  document.body.classList.add(position === 'top' ? 'banner-top' : 'banner-bottom');
}

/* -------- Opt-in gate -------- */

function showOptinGate(leads) {
  optinHeading.textContent = leads.heading || tr('viewer.optin_default_heading', 'Insira o seu email para aceder ao conteúdo');
  // A captura de leads é EXCLUSIVAMENTE feita pelo formulário HTML do
  // fornecedor (Mailchimp, Mailwizz, E-goi, etc.), injetado tal e qual.
  optinFormHtml.innerHTML = (leads.formHtml && leads.formHtml.trim())
    ? leads.formHtml
    : '<p style="color:#64748b;text-align:center">(O criador não definiu um formulário de inscrição.)</p>';
  optinOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function hideOptinGate() {
  optinOverlay.classList.add('hidden');
  document.body.style.overflow = '';
}

/* Desbloqueio do conteúdo. Existem dois caminhos, ambos exigem que o aluno
 * tenha interagido com o formulário do fornecedor:
 *  1) Interceção (best-effort) do submit de qualquer <form> colado no HTML.
 *     Muitos fornecedores fazem POST cross-origin ou abrem nova janela, pelo
 *     que isto nem sempre dispara — daí o botão explícito abaixo.
 *  2) Botão "Já me inscrevi — Aceder ao conteúdo". */
optinFormHtml.addEventListener('submit', (e) => {
  e.preventDefault();
  hideOptinGate();
});

if (optinAccess) {
  optinAccess.addEventListener('click', hideOptinGate);
}

/* -------- Boot -------- */

async function boot() {
  try {
    config = await window.viewer.loadConfig();
  } catch (err) {
    showToast('Erro ao carregar configuração: ' + (err && err.message ? err.message : err));
    return;
  }

  // Load locale based on the saved project language (defaults to 'pt').
  const lang = (config && config.language) || 'pt';
  try {
    const { dict } = await window.viewer.loadLocale(lang);
    i18nDict = dict || {};
  } catch (_) { i18nDict = {}; }

  // Translate every static element marked with data-i18n (corners, optin
  // heading, etc.) now that the dictionary is loaded.
  applyI18n();

  applyTheme(config.brand);
  const title = (config.brand && config.brand.title) || 'O Meu Software';
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

  applyDynamicTexts();

  buildMenu(Array.isArray(config.content) ? config.content : []);
  renderSocial(config.marketing && config.marketing.social);
  await renderBanner(config.marketing && config.marketing.banners);

  // Seletor de idioma em direto: re-traduz texto estático + dinâmico sem
  // reiniciar o Viewer. Não persiste (o Viewer é um leitor só-de-leitura).
  applyDir(ALLOWED_LANGS.includes(lang) ? lang : 'pt');

  const langSelect = document.getElementById('viewer-lang');
  if (langSelect) {
    langSelect.value = ALLOWED_LANGS.includes(lang) ? lang : 'pt';
    langSelect.addEventListener('change', () => setLanguage(langSelect.value));
  }

  const leads = config.marketing && config.marketing.leads;
  if (leads && leads.enabled) showOptinGate(leads);
}

/* Re-aplica as traduções definidas por JS (não cobertas por data-i18n):
 * o ecrã de boas-vindas e o aviso de menu vazio. */
function applyDynamicTexts() {
  const emptyHeading = stageEl.querySelector('.viewer-empty h2');
  const emptyText = stageEl.querySelector('.viewer-empty p');
  if (emptyHeading) emptyHeading.textContent = tr('viewer.empty_heading', 'Bem-vindo');
  if (emptyText) emptyText.textContent = tr('viewer.empty_text', 'Selecione uma opção no menu para começar.');
  const menuEmpty = menuEl.querySelector('.viewer-menu-empty');
  if (menuEmpty) menuEmpty.textContent = tr('viewer.menu_empty', 'Nenhum módulo configurado.');
}

async function setLanguage(lang) {
  let applied = lang;
  try {
    const res = await window.viewer.loadLocale(lang);
    i18nDict = res.dict || {};
    if (res.lang) applied = res.lang;
  } catch (_) { return; }
  applyI18n();
  applyDynamicTexts();
  applyDir(ALLOWED_LANGS.includes(applied) ? applied : 'pt');
  // Re-renderiza o módulo aberto para que o texto interno (ex.: "Escolha um
  // canal…" e os rótulos do IPTV) acompanhe o novo idioma.
  if (activeModuleRef && activeModuleRef.mod) {
    await handleModuleClick(activeModuleRef.mod, activeModuleRef.btn);
  }
}

/* =========================================================
 * Cantos promocionais — abrem no browser do sistema.
 * Hardcoded em index.html, sempre visíveis.
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

/* Duplica o conteúdo de cada faixa para criar um scroll contínuo e sem
 * "salto" (a animação translada -50%, exatamente uma cópia). */
function setupMarquees() {
  document.querySelectorAll('.marquee-track').forEach((track) => {
    track.innerHTML += track.innerHTML;
  });
}

setupMarquees();
wireCornerLinks();

boot();
