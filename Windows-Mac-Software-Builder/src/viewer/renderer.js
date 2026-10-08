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
let currentTs = null;    // active mpegts.js instance (raw MPEG-TS streams)
let iptvCleanup = null;  // cancels the active IPTV attempt, timers and popover
let lightboxCleanup = null;
let stageGeneration = 0; // incremented by clearStage(); lets async renderers detect they went stale
let currentWebModuleToken = null; // local HTTP/PHP service owned by the visible module

const optinOverlay = document.getElementById('optin-overlay');
const optinHeading = document.getElementById('optin-heading');
const optinFormHtml = document.getElementById('optin-form-html');
const optinAccess = document.getElementById('optin-access');

const bannerTopEl = document.getElementById('banner-top');
const bannerBottomEl = document.getElementById('banner-bottom');

let config = null;
let i18nDict = {};
let languageGeneration = 0;

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
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const v = tr(el.getAttribute('data-i18n-title'), null);
    if (typeof v === 'string') { el.setAttribute('title', v); el.setAttribute('aria-label', v); }
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
  // Codifica cada segmento (mantendo a letra da unidade): um '#', '%' ou '?'
  // no caminho (ex.: nome de utilizador do Windows) partia o URL file://.
  const segs = absPath.replace(/\\/g, '/').split('/')
    .map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s)) ? s : encodeURIComponent(s));
  let p = segs.join('/');
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

// Diagnostic copies must never include provider credentials carried in URL
// userinfo, Xtream paths or query strings. Playback continues using the original.
function redactDiagnosticUrls(message) {
  return String(message).replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
    try { return new URL(value).origin + '/[caminho omitido]'; }
    catch (_) { return '[URL omitido]'; }
  });
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
  stageGeneration++;
  if (currentWebModuleToken) {
    closeWebModule(currentWebModuleToken);
    currentWebModuleToken = null;
  }
  if (iptvCleanup) { try { iptvCleanup(); } catch (_) { /* noop */ } iptvCleanup = null; }
  if (lightboxCleanup) lightboxCleanup();
  destroyHls();
  // Detached native media can keep playing/downloading while retained by an
  // async callback. Explicitly release it before removing the stage DOM.
  stageEl.querySelectorAll('video, audio').forEach((media) => {
    try { media.pause(); media.removeAttribute('src'); media.load(); } catch (_) { /* noop */ }
  });
  stageEl.className = 'viewer-stage';
  stageEl.innerHTML = '';
}

function closeWebModule(token) {
  if (token && window.viewer && typeof window.viewer.closeWebModule === 'function') {
    window.viewer.closeWebModule(token).catch((err) => console.warn('Could not close local web module:', err));
  }
}

window.addEventListener('beforeunload', clearStage);

function destroyHls() {
  if (window.__iptvProxyToken && window.viewer && typeof window.viewer.iptvProxyStop === 'function') {
    window.viewer.iptvProxyStop(window.__iptvProxyToken).catch(() => {});
    window.__iptvProxyToken = null;
  }
  if (currentHls) {
    const hls = currentHls;
    currentHls = null;
    try { hls.destroy(); } catch (_) { /* noop */ }
  }
  if (currentTs) {
    const player = currentTs;
    currentTs = null;
    // A failed decoder can make pause/unload throw. Still detach and destroy
    // the engine so it cannot keep downloading or appending to a failed MSE.
    for (const method of ['pause', 'unload', 'detachMediaElement', 'destroy']) {
      try { player[method](); } catch (_) { /* continue the remaining cleanup */ }
    }
  }
}

/* Links dentro do conteúdo (módulo HTML, artigo, formulário de opt-in):
 * sem isto, um <a href="https://…"> navegava a própria janela do Viewer para
 * fora da app (sem botão "voltar"), e um target="_blank" abria uma janela
 * Electron "nua". Todos os links externos passam a abrir no browser do sistema. */
document.addEventListener('click', (e) => {
  const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if (!a || a.classList.contains('corner-link')) return;
  const href = (a.getAttribute('href') || '').trim();
  if (!/^https?:\/\//i.test(href)) {
    if (/^(#|javascript:)/i.test(href) || href === '') e.preventDefault();
    return;
  }
  e.preventDefault();
  window.viewer.openExternal(href).catch((err) => {
    showToast(tr('viewer.external_error_prefix', 'Erro ao abrir link: ') + (err && err.message ? err.message : err));
  });
});

/* -------- Stage renderers (1 per type) -------- */

async function renderYoutube(data) {
  clearStage();
  stageEl.classList.add('fill');
  const url = youtubeEmbedUrl(data && data.url);
  if (!url) {
    stageEl.innerHTML = '<div class="viewer-empty"><p>' + tr('viewer.video_missing', 'URL de vídeo em falta.') + '</p></div>';
    return;
  }
  /* O YouTube exige que o leitor esteja num <iframe> de uma página com origem
   * web real (Referer). Carregar o /embed/ID diretamente num webview a partir
   * de file:// dava "Erro 152-4 / 153". O processo principal serve uma página
   * anfitriã em http://127.0.0.1 (ver main.js) e o webview abre essa página. */
  const id = extractYoutubeId(url);
  const watchUrl = id ? 'https://www.youtube.com/watch?v=' + id : url;
  let src = url; // links não reconhecidos (ex.: playlist) abrem tal e qual
  if (id) {
    const gen = stageGeneration;
    try { src = await window.viewer.youtubeHostUrl(id); }
    catch (err) { console.error('Página anfitriã do YouTube indisponível:', err); }
    if (gen !== stageGeneration) return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'yt-wrap';

  const wv = document.createElement('webview');
  wv.setAttribute('src', src);
  wv.setAttribute('allowpopups', 'true');
  wv.setAttribute('allowfullscreen', '');

  // Rede de segurança: se o leitor embutido falhar (vídeo com incorporação
  // desativada, bloqueio do YouTube, sem rede…), o aluno abre-o no browser.
  const bar = document.createElement('div');
  bar.className = 'yt-fallback';
  const msg = document.createElement('span');
  msg.className = 'yt-fallback-msg';
  msg.textContent = tr('viewer.youtube_hint', 'O vídeo não carrega?');
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'yt-open-btn';
  open.textContent = tr('viewer.youtube_open', 'Abrir no YouTube');
  open.addEventListener('click', () => {
    window.viewer.openExternal(watchUrl).catch((err) => {
      showToast(tr('viewer.external_error_prefix', 'Erro ao abrir link: ') + (err && err.message ? err.message : err));
    });
  });
  bar.append(msg, open);
  wv.addEventListener('did-fail-load', (e) => {
    if (e && e.errorCode === -3) return; // ERR_ABORTED: navegação interna do leitor, não é erro
    msg.textContent = tr('viewer.youtube_fail', 'Não foi possível carregar o leitor do YouTube.');
    bar.classList.add('error');
  });

  wrap.append(wv, bar);
  stageEl.appendChild(wrap);
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
  const gen = stageGeneration;
  const fileUrl = await relToFileUrl(data.file);
  if (gen !== stageGeneration) return; // o aluno já mudou de módulo entretanto
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

async function renderLocalWeb(mod) {
  clearStage();
  const generation = stageGeneration;
  const status = document.createElement('div');
  status.className = 'viewer-empty';
  status.setAttribute('role', 'status');
  const message = document.createElement('p');
  message.textContent = tr('viewer.local_web_loading', 'A abrir o ficheiro…');
  status.appendChild(message);
  stageEl.appendChild(status);

  const showFailure = (detail) => {
    if (generation !== stageGeneration) return;
    clearStage();
    const box = document.createElement('div');
    box.className = 'viewer-empty';
    box.setAttribute('role', 'alert');
    const heading = document.createElement('p');
    heading.textContent = tr('viewer.local_web_error', 'Não foi possível abrir este ficheiro.');
    box.appendChild(heading);
    if (detail) {
      const reason = document.createElement('p');
      reason.textContent = detail;
      box.appendChild(reason);
    }
    if (mod.data && mod.data.requiresPhp) {
      const hint = document.createElement('p');
      hint.textContent = tr('viewer.local_web_php_hint', 'Este módulo requer o runtime PHP incluído no produto. Contacte o autor se estiver em falta.');
      box.appendChild(hint);
    }
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'pw-gate-btn';
    retry.textContent = tr('viewer.retry', 'Tentar novamente');
    retry.addEventListener('click', () => renderLocalWeb(mod));
    box.appendChild(retry);
    stageEl.appendChild(box);
  };

  try {
    const opened = await window.viewer.openWebModule(mod.id);
    if (generation !== stageGeneration) {
      closeWebModule(opened && opened.token);
      return;
    }
    currentWebModuleToken = opened && opened.token;
    if (!opened || typeof opened.token !== 'string' || !opened.token
        || !/^http:\/\/127\.0\.0\.1:\d+\//.test(opened.url)) {
      throw new Error(tr('viewer.local_web_invalid', 'O serviço local não está disponível.'));
    }
    const wv = document.createElement('webview');
    // Each opening has an isolated, non-persistent session. Imported pages get
    // no preload or Node bridge; the main process independently enforces this.
    wv.setAttribute('partition', 'local-web-' + opened.token);
    wv.setAttribute('webpreferences', 'contextIsolation=yes,nodeIntegration=no,sandbox=yes');
    // Let new-window requests reach main's deny-and-open-in-browser handler.
    // This does not grant Node/preload privileges or permit Electron popups.
    wv.setAttribute('allowpopups', 'true');
    wv.setAttribute('src', opened.url);
    wv.addEventListener('did-fail-load', (event) => {
      if (event.errorCode === -3 || event.isMainFrame === false) return;
      showFailure(tr('viewer.local_web_load_failed', 'Verifique se o ficheiro principal e os recursos foram incluídos.'));
    });
    wv.addEventListener('render-process-gone', () => {
      showFailure(tr('viewer.local_web_load_failed', 'Verifique se o ficheiro principal e os recursos foram incluídos.'));
    });
    stageEl.classList.add('fill');
    stageEl.replaceChildren(wv);
  } catch (err) {
    showFailure(err && err.message ? err.message : '');
  }
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
  const gen = stageGeneration;
  const url = await relToFileUrl(data && data.file);
  if (gen !== stageGeneration) return;
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
  const gen = stageGeneration;
  const url = await relToFileUrl(data && data.file);
  if (gen !== stageGeneration) return;
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
  const gen = stageGeneration;
  for (const img of images) {
    const relFile = img && img.file;
    const url = await relToFileUrl(relFile);
    if (gen !== stageGeneration) return;
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
  if (lightboxCleanup) lightboxCleanup();
  const overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';

  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (lightboxCleanup === close) lightboxCleanup = null;
  }
  lightboxCleanup = close;
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

function renderAndroidUnavailable() {
  // A future or edited project may carry an APK module. Never hand the file
  // to the operating system or imply that the current Viewer can execute it.
  clearStage();
  stageEl.classList.add('html-mode');
  const notice = document.createElement('div');
  notice.className = 'html-host android-unavailable';
  notice.setAttribute('role', 'alert');
  const heading = document.createElement('h2');
  heading.textContent = tr('android.viewer_title', 'Android application unavailable');
  const message = document.createElement('p');
  message.textContent = tr('android.viewer_unavailable', 'This product does not include a validated Android engine. APK execution is unavailable in this version. Contact the creator for a compatible version.');
  notice.append(heading, message);
  stageEl.appendChild(notice);
}

function renderPortable(mod) {
  // Restoring the last module or changing language must never launch a process.
  // The only launch/configuration calls below are inside explicit button clicks.
  clearStage();
  const generation = stageGeneration;
  const data = (mod && mod.data) || {};
  const api = window.viewer || {};
  let busy = false;
  stageEl.classList.add('html-mode');

  const card = document.createElement('div');
  card.className = 'html-host dl-card';
  const icon = document.createElement('div');
  icon.className = 'dl-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '🧳';
  const heading = document.createElement('h2');
  heading.textContent = (mod && mod.title) || tr('portable.viewer_title', 'Programa portátil');
  card.append(icon, heading);

  const addParagraph = (text) => {
    const p = document.createElement('p');
    p.className = 'dl-name';
    p.textContent = text;
    card.appendChild(p);
    return p;
  };
  if (data.sourceName) addParagraph(data.sourceName);
  addParagraph(tr('portable.viewer_description', 'Abre numa janela própria do sistema. O programa não fica incorporado no visualizador.'));
  addParagraph(tr('portable.viewer_compatibility', 'Não converte programas entre sistemas. No Windows, é necessária uma versão Windows.'));

  const launchRow = addParagraph('');
  const launchButton = document.createElement('button');
  launchButton.type = 'button';
  launchButton.className = 'dl-btn';
  launchButton.textContent = tr('portable.viewer_launch', 'Abrir programa');
  launchRow.appendChild(launchButton);

  let wineButton = null;
  const canConfigureWine = api.platform === 'darwin' && data.allowWine === true
    && data.entries && typeof data.entries.windows === 'string' && data.entries.windows
    && typeof api.configurePortableWine === 'function';
  if (canConfigureWine) {
    addParagraph(tr('portable.viewer_wine_help', 'Para tentar abrir uma versão Windows neste Mac, configure um runtime Wine e um prefixo já preparados. A compatibilidade depende do programa.'));
    const wineRow = addParagraph('');
    wineButton = document.createElement('button');
    wineButton.type = 'button';
    wineButton.className = 'yt-open-btn';
    wineButton.textContent = tr('portable.viewer_configure_wine', 'Configurar Wine neste Mac');
    wineRow.appendChild(wineButton);
  }

  const status = addParagraph('');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  const showStatus = (message, error = false) => {
    status.className = error ? 'pw-gate-error' : 'dl-name';
    status.textContent = message;
  };
  const setBusy = (value) => {
    busy = value;
    launchButton.disabled = value || typeof api.launchPortable !== 'function';
    if (wineButton) wineButton.disabled = value;
    card.setAttribute('aria-busy', String(value));
  };
  setBusy(false);
  if (typeof api.launchPortable !== 'function') {
    showStatus(tr('portable.viewer_unavailable', 'Esta versão do visualizador não suporta programas portáteis.'), true);
  }

  launchButton.addEventListener('click', async () => {
    if (busy || generation !== stageGeneration || typeof api.launchPortable !== 'function') return;
    setBusy(true);
    showStatus(tr('portable.viewer_launching', 'A iniciar o processo…'));
    try {
      const result = await api.launchPortable(mod.id);
      if (generation !== stageGeneration) return;
      if (!result || result.ok !== true) {
        throw new Error(tr('portable.viewer_invalid_result', 'O sistema não confirmou o início do processo.'));
      }
      showStatus(result.via === 'wine'
        ? tr('portable.viewer_started_wine', 'Processo iniciado através do Wine.')
        : tr('portable.viewer_started', 'Processo iniciado.'));
    } catch (err) {
      if (generation === stageGeneration) {
        const detail = err && err.message ? err.message : String(err);
        showStatus(tr('portable.viewer_launch_error', 'Não foi possível iniciar o programa: ') + detail, true);
      }
    } finally {
      if (generation === stageGeneration) setBusy(false);
    }
  });

  if (wineButton) wineButton.addEventListener('click', async () => {
    if (busy || generation !== stageGeneration) return;
    setBusy(true);
    showStatus(tr('portable.viewer_configuring_wine', 'A configurar o Wine…'));
    try {
      const result = await api.configurePortableWine();
      if (generation !== stageGeneration) return;
      showStatus(result && result.configured === true
        ? tr('portable.viewer_wine_ready', 'Wine configurado. Clique em Abrir programa para tentar iniciar.')
        : '');
    } catch (err) {
      if (generation === stageGeneration) {
        const detail = err && err.message ? err.message : String(err);
        showStatus(tr('portable.viewer_config_error', 'Não foi possível configurar o Wine: ') + detail, true);
      }
    } finally {
      if (generation === stageGeneration) setBusy(false);
    }
  });

  stageEl.appendChild(card);
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

const MODULE_ICON = {
  youtube: '▶️', 'local-video': '🎬', pdf: '📄', 'article-reader': '📝', html: '🧩', 'local-web': '📁',
  'download-vault': '⬇️', launch: '🚀', portable: '🧳', webview: '🌐', external: '🔗', 'smart-embed': '📋',
  'image-gallery': '🖼️', 'local-audio': '🎵', iptv: '📺'
};

/* Barra lateral recolhível: fica só com os ícones (largura de 64px). Recolhe
 * sozinha em janelas estreitas; a escolha manual do aluno prevalece. */
let sidebarUserChoice = null; // true = recolhida, false = aberta, null = automático
function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const btn = document.getElementById('viewer-sidebar-toggle');
  if (btn) {
    btn.textContent = collapsed ? '»' : '«';
    const key = collapsed ? 'viewer.sidebar_expand' : 'viewer.sidebar_collapse';
    btn.setAttribute('data-i18n-title', key);
    const label = tr(key, collapsed ? 'Expandir menu' : 'Recolher menu');
    btn.title = label; btn.setAttribute('aria-label', label);
  }
}
function autoSidebar() {
  if (sidebarUserChoice !== null) return;
  setSidebarCollapsed(window.innerWidth < 900);
}
(function wireSidebarToggle() {
  const btn = document.getElementById('viewer-sidebar-toggle');
  if (btn) btn.addEventListener('click', () => {
    sidebarUserChoice = !document.body.classList.contains('sidebar-collapsed');
    setSidebarCollapsed(sidebarUserChoice);
  });
  window.addEventListener('resize', autoSidebar);
  autoSidebar();
})();

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
    btn.title = mod.title;
    const ico = document.createElement('span');
    ico.className = 'viewer-menu-ico';
    ico.textContent = MODULE_ICON[mod.type] || '•';
    const lbl = document.createElement('span');
    lbl.className = 'viewer-menu-label';
    lbl.textContent = mod.title;
    btn.append(ico, lbl);
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
    btn.addEventListener('click', () => handleExternal({ url }));
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
    saveViewerState({ lastModuleId: mod.id });
  }
  const pwd = (mod && typeof mod.password === 'string') ? mod.password.trim() : '';
  if (pwd && !unlockedModules.has(mod.id)) {
    // An action's gate is visible content too. Translating it must neither
    // restore a previous module nor perform the protected action.
    activeModuleRef = { mod, btn };
    setActiveMenuBtn(btn);
    renderPasswordGate(mod, btn, pwd);
    return;
  }
  const pending = dispatchModule(mod, btn);
  const generation = stageGeneration;
  try { await pending; }
  catch (err) {
    if (generation !== stageGeneration) return;
    clearStage();
    const host = document.createElement('div');
    host.className = 'viewer-empty';
    host.setAttribute('role', 'alert');
    const message = document.createElement('p');
    message.textContent = tr('viewer.local_web_error', 'Não foi possível abrir este ficheiro.');
    const detail = document.createElement('p');
    detail.textContent = err && err.message ? err.message : String(err);
    host.append(message, detail);
    stageEl.appendChild(host);
  }
}

/* Favoritos de IPTV — guardados no computador do aluno através do processo
 * principal (favs:load / favs:save), FORA da pasta temporária do SFX. O
 * localStorage do Viewer exportado vive nessa pasta temporária e é apagado ao
 * fechar o curso, por isso fica apenas como cache/fallback (dev, ou API em
 * falta). A chave inclui o curso + módulo para não misturar favoritos entre
 * cursos diferentes que partilham o mesmo Viewer. */
function iptvFavKey(moduleId) {
  const base = (document.title || 'curso') + '::' + (moduleId || 'iptv');
  return 'lbxIptvFav::' + base;
}
function normalizeFavs(obj) {
  if (!obj || !Array.isArray(obj.folders)) return null;
  return { folders: obj.folders.filter((folder) => folder && typeof folder.id === 'string'
    && typeof folder.name === 'string' && Array.isArray(folder.keys)).map((folder) => ({
    id: folder.id, name: folder.name, _open: !!folder._open,
    keys: [...new Set(folder.keys.filter((key) => typeof key === 'string' && key))]
  })) };
}
function loadFavsLocal(key) {
  try { return normalizeFavs(JSON.parse(localStorage.getItem(key) || 'null')); } catch (_) { return null; }
}
/* Estado do aluno neste curso (ex.: último módulo aberto) — mesmo mecanismo
 * persistente dos favoritos, chave própria. */
function viewerStateKey() { return 'lbxState::' + (document.title || 'curso'); }
async function loadViewerState() {
  if (!(window.viewer && typeof window.viewer.loadState === 'function')) return {};
  try { return (await window.viewer.loadState(viewerStateKey())) || {}; } catch (_) { return {}; }
}
function saveViewerState(patch) {
  if (!(window.viewer && typeof window.viewer.saveState === 'function')) return;
  window.viewer.saveState(viewerStateKey(), patch).catch(() => { /* não é crítico */ });
}
async function loadFavs(moduleId) {
  const key = iptvFavKey(moduleId);
  let stored = null;
  if (window.viewer && typeof window.viewer.loadFavs === 'function') {
    try { stored = normalizeFavs(await window.viewer.loadFavs(key)); } catch (_) { stored = null; }
  }
  if (!stored) {
    // Ainda sem ficheiro (primeira utilização, ou favoritos antigos só em
    // localStorage): usa o localStorage e migra-o para o armazenamento persistente.
    stored = loadFavsLocal(key);
    if (stored && stored.folders.length) saveFavs(moduleId, stored);
  }
  return stored || { folders: [] };
}
function saveFavs(moduleId, data) {
  const key = iptvFavKey(moduleId);
  try { localStorage.setItem(key, JSON.stringify(data)); } catch (_) { /* noop */ }
  if (window.viewer && typeof window.viewer.saveFavs === 'function') {
    window.viewer.saveFavs(key, data).catch((err) => {
      console.error('Falha ao guardar favoritos:', err);
      showToast(tr('viewer.iptv_favs_save_error', 'Não foi possível guardar os favoritos.'));
    });
  }
}

async function renderIptv(data, moduleId) {
  clearStage();
  stageEl.classList.add('iptv-mode');
  const channels = (data && Array.isArray(data.channels))
    ? data.channels.filter((ch) => ch && typeof ch.url === 'string' && ch.url) : [];
  if (channels.length === 0) {
    stageEl.innerHTML = '<div class="viewer-empty"><p>' + tr('viewer.iptv_empty', 'Sem canais para mostrar.') + '</p></div>';
    return;
  }

  const RENDER_CAP = 500;

  // Diz ao processo principal quais são os hosts dos streams (para os pedidos
  // se apresentarem como VLC — ver main.js). Hosts de segmentos HLS e de
  // redirecionamentos são acrescentados à medida que aparecem.
  const knownHosts = new Set();
  function announceHosts(urls) {
    const fresh = [];
    for (const u of urls) {
      let h = '';
      try { h = new URL(u).hostname.toLowerCase(); } catch (_) { h = ''; }
      if (h && !knownHosts.has(h)) { knownHosts.add(h); fresh.push(h); }
    }
    if (fresh.length && window.viewer && typeof window.viewer.iptvHosts === 'function') {
      return window.viewer.iptvHosts(fresh).catch(() => {});
    }
    return Promise.resolve();
  }
  const hostsReady = announceHosts(channels.map((c) => c && c.url).filter(Boolean));

  // ---- Estado dos favoritos (lidos do disco; ver loadFavs) ----
  const myGen = stageGeneration;
  const favs = await loadFavs(moduleId);
  // Se entretanto o aluno abriu outro módulo, não desenhar por cima dele.
  if (myGen !== stageGeneration) return;
  let view = 'all'; // 'all' | 'favs'
  let editingFolderId = null;
  let deletingFolderId = null;
  let creatingFolder = false;
  let attemptCleanup = null;
  let searchTimer = null;
  let pickerTimer = null;

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

  /* Diagnóstico: regista tudo o que o leitor faz (motor, URL, eventos do
   * <video>, erros do hls.js/mpegts.js) num painel que o aluno/autor pode
   * abrir com o botão ⓘ e copiar — é a única forma de perceber, à distância,
   * porque é que um canal não abre. */
  const diagLines = [];
  const diagBtn = document.createElement('button');
  diagBtn.type = 'button';
  diagBtn.className = 'iptv-diag-btn';
  diagBtn.title = 'Diagnóstico';
  diagBtn.textContent = 'ⓘ';
  const diagBox = document.createElement('div');
  diagBox.className = 'iptv-diag hidden';
  const diagPre = document.createElement('pre');
  const diagCopy = document.createElement('button');
  diagCopy.type = 'button';
  diagCopy.className = 'iptv-retry';
  diagCopy.textContent = 'Copiar';
  diagCopy.addEventListener('click', () => {
    const text = diagPre.textContent;
    const done = () => { diagCopy.textContent = 'Copiado ✓'; setTimeout(() => { diagCopy.textContent = 'Copiar'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => {});
    else { const r = document.createRange(); r.selectNodeContents(diagPre); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); try { document.execCommand('copy'); done(); } catch (_) { /* noop */ } }
  });
  diagBox.append(diagCopy, diagPre);
  diagBtn.addEventListener('click', () => diagBox.classList.toggle('hidden'));
  function logDiag(msg) {
    if (myGen !== stageGeneration) return;
    const safeMessage = redactDiagnosticUrls(msg);
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0');
    diagLines.push(hh + ' ' + safeMessage);
    if (diagLines.length > 300) diagLines.shift();
    diagPre.textContent = diagLines.join('\n');
    diagPre.scrollTop = diagPre.scrollHeight;
    console.log('[IPTV]', safeMessage);
  }
  logDiag('Viewer v' + (window.__viewerVersion || '?') + ' · hls.js ' + (window.Hls ? (window.Hls.version || 'ok') : 'AUSENTE')
    + ' · mpegts.js ' + (window.mpegts ? (window.mpegts.version || 'ok') : 'AUSENTE') + ' · MSE ' + (window.MediaSource ? 'ok' : 'AUSENTE'));
  try {
    const MS = window.MediaSource;
    const sup = (m) => (MS && MS.isTypeSupported(m)) ? 'sim' : 'NÃO';
    logDiag('codecs: H.264 ' + sup('video/mp4; codecs="avc1.64001f"') + ' · HEVC ' + sup('video/mp4; codecs="hvc1.1.6.L93.B0"')
      + ' · AAC ' + sup('audio/mp4; codecs="mp4a.40.2"') + ' · MP3 ' + sup('audio/mpeg') + ' · AC-3 ' + sup('audio/mp4; codecs="ac-3"') + ' · E-AC-3 ' + sup('audio/mp4; codecs="ec-3"'));
  } catch (_) { /* noop */ }
  /* Inspeciona um segmento fMP4 (moof+mdat) tal como vai para o MediaSource:
   * quantas amostras, quantas marcadas como keyframe (sync), primeiro DTS.
   * Se nenhuma amostra for "sync", o Chromium descarta tudo em silêncio até
   * aparecer uma — é exatamente o sintoma "anexa mas o buffer fica vazio". */
  function inspectFmp4(u8) {
    try {
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const str = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
      let out = null;
      const walk = (start, end, depth) => {
        let o = start;
        while (o + 8 <= end) {
          let size = dv.getUint32(o); const type = str(o + 4); let hdr = 8;
          if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; }
          if (size === 0) size = end - o;
          if (size < hdr) return;
          if (type === 'moof' || type === 'traf') walk(o + hdr, o + size, depth + 1);
          else if (type === 'tfhd') {
            const flags = dv.getUint32(o + hdr) & 0xffffff; let p = o + hdr + 8;
            if (flags & 1) p += 8; if (flags & 2) p += 4; if (flags & 8) p += 4; if (flags & 0x10) p += 4;
            out = out || {}; out.defFlags = (flags & 0x20) ? dv.getUint32(p) : null;
          } else if (type === 'tfdt') {
            const ver = u8[o + hdr];
            out = out || {}; out.dts = ver === 1 ? Number(dv.getBigUint64(o + hdr + 4)) : dv.getUint32(o + hdr + 4);
          } else if (type === 'trun') {
            const flags = dv.getUint32(o + hdr) & 0xffffff; const n = dv.getUint32(o + hdr + 4); let p = o + hdr + 8;
            if (flags & 1) p += 4; let first = null; if (flags & 4) { first = dv.getUint32(p); p += 4; }
            let sync = 0, dur = 0;
            for (let i = 0; i < n; i++) {
              let d = 0, f = null;
              if (flags & 0x100) { d = dv.getUint32(p); p += 4; }
              if (flags & 0x200) p += 4;
              if (flags & 0x400) { f = dv.getUint32(p); p += 4; }
              if (flags & 0x800) p += 4;
              if (i === 0 && first !== null) f = first;
              if (f === null) f = (out && out.defFlags != null) ? out.defFlags : 0x10000;
              if (!(f & 0x10000)) sync++;
              dur += d;
            }
            out = out || {}; out.n = (out.n || 0) + n; out.sync = (out.sync || 0) + sync; out.dur = (out.dur || 0) + dur;
          }
          o += size;
        }
      };
      walk(0, u8.byteLength, 0);
      if (!out || !out.n) return 'sem amostras';
      return out.n + ' amostras, ' + out.sync + ' keyframe(s), DTS inicial ' + (out.dts != null ? (out.dts / 90000).toFixed(1) + 's' : '?') + ', duração ' + (out.dur / 90000).toFixed(1) + 's';
    } catch (err) { return 'inspeção falhou: ' + err.message; }
  }
  const bufInfo = () => {
    try {
      const b = video.buffered; const parts = [];
      for (let i = 0; i < b.length; i++) parts.push(b.start(i).toFixed(1) + '–' + b.end(i).toFixed(1));
      return 't=' + video.currentTime.toFixed(1) + ' buffer=[' + parts.join(', ') + '] readyState=' + video.readyState;
    } catch (_) { return ''; }
  };
  ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'stalled', 'suspend', 'abort', 'emptied', 'ended', 'pause'].forEach((ev) => {
    video.addEventListener(ev, () => {
      logDiag('video: ' + ev + (ev === 'loadedmetadata' || ev === 'playing' ? ' (' + video.videoWidth + 'x' + video.videoHeight + ', readyState ' + video.readyState + ')' : '')
        + (ev === 'waiting' || ev === 'stalled' || ev === 'playing' ? ' ' + bufInfo() : ''));
    });
  });
  video.addEventListener('error', () => {
    const e = video.error;
    logDiag('video: error code=' + (e && e.code) + ' ' + (e && e.message ? e.message : ''));
  });
  now.appendChild(diagBtn);
  main.appendChild(now);
  main.appendChild(video);
  main.appendChild(diagBox);

  wrap.appendChild(side);
  wrap.appendChild(main);
  stageEl.appendChild(wrap);

  let activeItem = null;

  function looksLikeHls(url) {
    return /\.m3u8(\?|$)/i.test(url) || /(get\.php|type=m3u|\/live\/)/i.test(url);
  }

  let lastPlayed = null;
  function showPlayError() {
    now.textContent = tr('viewer.iptv_play_error', 'Não foi possível reproduzir este canal.') + ' ';
    if (lastFailReason) {
      const why = document.createElement('span');
      why.className = 'iptv-why';
      why.textContent = '(' + lastFailReason + ') ';
      now.appendChild(why);
    }
    if (!lastPlayed) return;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'iptv-retry';
    retry.textContent = tr('viewer.retry', 'Tentar novamente');
    retry.addEventListener('click', () => play(lastPlayed.ch, lastPlayed.item));
    now.appendChild(retry);
    now.appendChild(diagBtn);
  }

  /* Reprodução com cadeia de motores. Cada canal pode vir em formatos
   * diferentes e nem sempre o primeiro funciona:
   *   - HLS (.m3u8)            → hls.js
   *   - MPEG-TS bruto (.ts, ou URL sem extensão, típico de listas "output=ts")
   *                            → mpegts.js (o Chromium não lê MPEG-TS sozinho)
   *   - ficheiros (.mp4, .mp3…) → <video> nativo
   * Para URLs Xtream (/live/user/pass/ID.ext) tentam-se as duas variantes,
   * porque há canais que o servidor só serve num dos formatos. Um "watchdog"
   * deteta falta de progresso tanto no arranque como depois do primeiro frame,
   * passando ao motor seguinte em vez de deixar um canal parado a descarregar. */
  const XTREAM_LIVE = /^(.*\/live\/[^/]+\/[^/]+\/\d+)\.(ts|m3u8)(\?.*)?$/i;
  const FILE_EXT = /\.(mp4|m4v|webm|mkv|mov|mp3|m4a|aac|ogg|wav|flac)(\?|$)/i;
  let hasFfmpeg = false;
  let ffmpegReady = Promise.resolve();
  if (window.viewer && typeof window.viewer.iptvHasFfmpeg === 'function') {
    ffmpegReady = window.viewer.iptvHasFfmpeg().then((v) => { hasFfmpeg = !!v; logDiag('ffmpeg local: ' + (hasFfmpeg ? 'disponível' : 'AUSENTE neste produto')); }).catch(() => {});
  }
  function buildAttempts(url) {
    const x = XTREAM_LIVE.exec(url);
    let list;
    if (x) {
      const q = x[3] || '';
      // HLS primeiro (reproduz bem a maioria); depois o ffmpeg local (canais que
      // o Chromium não aceita via MSE); MPEG-TS bruto em último recurso.
      list = [{ engine: 'hls', url: x[1] + '.m3u8' + q }, { engine: 'proxy', url: x[1] + '.ts' + q }, { engine: 'ts', url: x[1] + '.ts' + q }];
    } else if (looksLikeHls(url)) list = [{ engine: 'hls', url }, { engine: 'proxy', url }];
    else if (FILE_EXT.test(url)) list = [{ engine: 'native', url }, { engine: 'proxy', url }];
    else if (/\.ts(\?|$)/i.test(url)) list = [{ engine: 'proxy', url }, { engine: 'ts', url }, { engine: 'native', url }];
    else list = [{ engine: 'proxy', url }, { engine: 'ts', url }, { engine: 'hls', url }, { engine: 'native', url }];
    return hasFfmpeg ? list : list.filter((a) => a.engine !== 'proxy');
  }
  let proxyToken = null;

  let playSeq = 0;
  let lastFailReason = '';
  function mediaFailureReason(error) {
    if (error && error.code === 3) {
      return 'falha de descodificação (código 3): o vídeo pode usar um formato incompatível com este leitor'
        + (hasFfmpeg ? '' : '; FFmpeg não está disponível neste produto para tentar a transcodificação');
    }
    return 'erro no leitor (código ' + (error && error.code) + ')';
  }
  const isCurrent = (seq) => myGen === stageGeneration && seq === playSeq;
  function cancelAttempt() {
    if (attemptCleanup) { attemptCleanup(); attemptCleanup = null; }
  }
  function resetVideo() {
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_) { /* noop */ }
  }
  function play(ch, item) {
    if (myGen !== stageGeneration) return;
    const seq = ++playSeq;
    cancelAttempt();
    destroyHls();
    proxyToken = null;
    resetVideo();
    if (activeItem) activeItem.classList.remove('active');
    activeItem = item || null;
    if (activeItem) activeItem.classList.add('active');
    lastPlayed = { ch, item };
    now.textContent = ch.name || '';
    now.appendChild(diagBtn);
    logDiag('── canal: ' + (ch.name || '') + ' → ' + ch.url);
    if (!ch.url) return;
    lastFailReason = '';
    Promise.all([hostsReady, ffmpegReady]).then(() => {
      if (isCurrent(seq)) runAttempt(buildAttempts(ch.url), 0, seq);
    });
  }

  function runAttempt(attempts, idx, seq) {
    if (!isCurrent(seq)) return;
    cancelAttempt();
    destroyHls();
    proxyToken = null;
    resetVideo();
    if (idx >= attempts.length) { logDiag('✗ todos os motores falharam'); showPlayError(); return; }
    const { engine, url } = attempts[idx];
    logDiag('tentativa ' + (idx + 1) + '/' + attempts.length + ' [' + engine + '] ' + url);

    let done = false; // cancelled/failed, not merely started playing
    let playing = false;
    let watchdog = null;
    let frameCallback = null;
    let videoError = null;
    function stopWatching() {
      clearTimeout(watchdog);
      if (frameCallback !== null && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(frameCallback);
      }
      frameCallback = null;
    }
    attemptCleanup = () => {
      done = true;
      stopWatching();
      if (videoError) video.removeEventListener('error', videoError);
    };
    function onVideoError(handler) {
      videoError = handler;
      video.addEventListener('error', handler);
    }
    const frames = () => {
      try { return video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality().totalVideoFrames : -1; } catch (_) { return -1; }
    };
    let previousTime = video.currentTime;
    let previousFrames = frames();
    function watchProgress(delay = 15000) {
      previousTime = video.currentTime;
      previousFrames = frames();
      clearTimeout(watchdog);
      watchdog = setTimeout(checkProgress, delay);
    }
    function logProxyStatus() {
      if (engine !== 'proxy' || !proxyToken) return;
      window.viewer.iptvProxyStatus(proxyToken).then((st) => {
        if (isCurrent(seq) && st && st.log && st.log.length) logDiag('ffmpeg: ' + st.log.join(' | '));
      }).catch(() => {});
    }
    const next = (reason) => {
      if (done || !isCurrent(seq)) return;
      done = true;
      stopWatching();
      lastFailReason = redactDiagnosticUrls(engine + ': ' + reason);
      logDiag('✗ [' + engine + '] ' + reason);
      runAttempt(attempts, idx + 1, seq);
    };
    const ok = (how) => {
      if (done || playing || !isCurrent(seq)) return;
      playing = true;
      stopWatching();
      watchProgress();
      logDiag('✓ [' + engine + '] a reproduzir (' + how + ', ' + video.videoWidth + 'x' + video.videoHeight + ')');
    };
    // Decoder failures also arrive directly on <video>, without a usable HLS
    // or MPEG-TS error. They are terminal for this attempt, even after frames.
    onVideoError(() => {
      if (done || !isCurrent(seq) || !video.error) return;
      logProxyStatus();
      next(mediaFailureReason(video.error));
    });
    // Sucesso = frames de vídeo a serem realmente apresentados, não apenas o
    // evento "playing" (que dispara mesmo com o vídeo em preto).
    if (typeof video.requestVideoFrameCallback === 'function') {
      const onFrame = () => { frameCallback = null; if (!done && isCurrent(seq) && video.videoWidth > 0) ok('frame apresentado'); };
      try { frameCallback = video.requestVideoFrameCallback(onFrame); } catch (_) { /* noop */ }
    }
    function checkProgress() {
      if (done || !isCurrent(seq)) return;
      if (video.error) { logProxyStatus(); next(mediaFailureReason(video.error)); return; }
      if (video.ended) { stopWatching(); return; }
      // Pausing a working player is a user action, not a broken stream.
      if (playing && video.paused) { watchProgress(); return; }
      const f = frames();
      const advancing = Math.abs(video.currentTime - previousTime) > 0.05 && !video.paused;
      const visibleProgress = video.videoWidth === 0 || f < 0 || f > previousFrames;
      if (advancing && visibleProgress) {
        if (playing) watchProgress();
        else ok(video.videoWidth === 0 ? 'watchdog: só áudio' : 'watchdog: ' + f + ' frames');
        return;
      }
      logProxyStatus();
      if (advancing) { next('a tocar mas sem frames de vídeo (' + video.videoWidth + 'x' + video.videoHeight + ', ' + f + ' frames) — codec não suportado?'); return; }
      next('sem progresso de reprodução (' + bufInfo() + ', frames ' + f + ')');
    }
    watchProgress(engine === 'proxy' ? 25000 : 15000);

    try {
      if (engine === 'hls') {
        if (!(window.Hls && window.Hls.isSupported())) { next('hls.js indisponível'); return; }
        const hls = new window.Hls({ maxBufferLength: 20, enableWorker: true, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 1, fragLoadingMaxRetry: 2 });
        currentHls = hls;
        let recoveries = 0;
        hls.on(window.Hls.Events.ERROR, (_evt, d) => {
          if (!d || done || !isCurrent(seq) || currentHls !== hls) return;
          const code = d.response && d.response.code ? ' HTTP ' + d.response.code : '';
          logDiag('hls ' + (d.fatal ? 'FATAL ' : '') + (d.details || d.type) + code + (d.reason ? ' — ' + d.reason : ''));
          if (video.error) { next(mediaFailureReason(video.error)); return; }
          if (!d.fatal) return;
          if (recoveries < 2 && d.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
            recoveries++;
            // Recovery can pause/detach the media element. That pause is not a
            // user pause: require playback to start again within the watchdog.
            playing = false;
            watchProgress();
            try { hls.recoverMediaError(); return; } catch (_) { /* try the next engine */ }
          }
          next((d.details || d.type) + code);
        });
        hls.on(window.Hls.Events.BUFFER_CODECS, (_e, d) => {
          const v = d && d.video ? (d.video.codec || '?') + ' (' + (d.video.container || '') + ')' : 'sem vídeo';
          const a = d && d.audio ? (d.audio.codec || '?') + ' (' + (d.audio.container || '') + ')' : 'sem áudio';
          logDiag('hls codecs: vídeo ' + v + ' · áudio ' + a);
        });
        let firstFrag = true, firstAppend = true;
        hls.on(window.Hls.Events.LEVEL_LOADED, (_e, d) => {
          if (!isCurrent(seq) || currentHls !== hls) return;
          const det = d && d.details;
          if (det) {
            logDiag('hls playlist: ' + det.fragments.length + ' segmento(s), ' + (det.live ? 'live' : 'VOD') + ', duração alvo ' + det.targetduration + 's');
            announceHosts(det.fragments.map((f) => f.url));
          }
        });
        let fragLogs = 0, appendLogs = 0;
        hls.on(window.Hls.Events.FRAG_LOADED, (_e, d) => {
          if (fragLogs++ >= 8) return;
          const f = d && d.frag;
          const kb = f && f.stats ? Math.round((f.stats.loaded || f.stats.total || 0) / 1024) : '?';
          logDiag('hls segmento #' + (f ? f.sn : '?') + ' carregado: ' + kb + ' KB' + (fragLogs === 1 && f ? ' ← ' + f.url : ''));
        });
        hls.on(window.Hls.Events.BUFFER_APPENDING, (_e, d) => {
          if (appendLogs++ >= 8) return;
          const kb = d && d.data ? Math.round(d.data.byteLength / 1024) : 0;
          logDiag('hls a anexar ' + (d && d.type) + ' ' + kb + ' KB' + (d && d.frag ? ' (seg #' + d.frag.sn + ')' : '')
            + (d && d.type === 'video' && kb > 8 ? ' → ' + inspectFmp4(d.data) : ''));
        });
        let mediaAppends = 0;
        hls.on(window.Hls.Events.FRAG_BUFFERED, (_e, d) => {
          if (firstAppend) { firstAppend = false; logDiag('hls 1.º segmento no buffer: ' + bufInfo()); }
          mediaAppends++;
          // Falha rápida: segmentos entregues ao MediaSource e o buffer continua
          // vazio → o Chromium está a descartá-los (vídeo entrelaçado, etc.).
          // Não vale a pena esperar pelo watchdog: passar ao motor seguinte.
          if (mediaAppends >= 2 && video.buffered.length === 0) next('o Chromium descarta as amostras (MSE) — vídeo entrelaçado/incompatível');
        });
        hls.on(window.Hls.Events.FRAG_PARSED, (_e, d) => {
          if (firstFrag) { firstFrag = false; logDiag('hls 1.º segmento descodificado: ' + bufInfo()); }
        });
        hls.on(window.Hls.Events.MANIFEST_PARSED, (_e, d) => {
          if (!isCurrent(seq) || currentHls !== hls) return;
          const lv = (d && d.levels) || [];
          logDiag('hls manifesto ok: ' + lv.length + ' nível(is) ' + lv.map((l) => (l.width || '?') + 'x' + (l.height || '?') + (l.videoCodec ? ' ' + l.videoCodec : '') + (l.audioCodec ? '/' + l.audioCodec : '')).join(', '));
          Promise.resolve(video.play()).catch((err) => logDiag('play() recusado: ' + (err && err.message)));
        });
        hls.loadSource(url);
        hls.attachMedia(video);
        return;
      }

      if (engine === 'ts') {
        const M = window.mpegts;
        if (!(M && M.getFeatureList && M.getFeatureList().mseLivePlayback)) { next('mpegts.js indisponível'); return; }
        const player = M.createPlayer(
          { type: 'mpegts', isLive: true, url },
          // REGRESSÃO CORRIGIDA: sem stash buffer e com "latency chasing" o
          // leitor parava de 2 em 2 s (saltava para a frente sempre que o
          // buffer crescia). Buffer normal, sem perseguição de latência.
          { enableWorker: false, enableStashBuffer: true, stashInitialSize: 384 * 1024, liveBufferLatencyChasing: false,
            autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 30, autoCleanupMinBackwardDuration: 10, lazyLoad: false }
        );
        currentTs = player;
        player.on(M.Events.ERROR, (type, detail, info) => {
          if (done || !isCurrent(seq) || currentTs !== player) return;
          logDiag('mpegts ERRO ' + type + ' / ' + detail + (info && info.msg ? ' — ' + info.msg : '') + (info && info.code ? ' (HTTP ' + info.code + ')' : ''));
          next(video.error ? mediaFailureReason(video.error) : String(detail || type) + (info && info.code ? ' HTTP ' + info.code : ''));
        });
        let lastStat = 0;
        player.on(M.Events.STATISTICS_INFO, (st) => {
          const t = Date.now();
          if (t - lastStat < 5000) return;
          lastStat = t;
          logDiag('mpegts fluxo de dados: ' + Math.round(st.speed || 0) + ' KB/s · frames descodificados ' + (st.decodedFrames || 0) + ' · ' + bufInfo());
        });
        player.on(M.Events.LOADING_COMPLETE, () => logDiag('mpegts: o servidor FECHOU a ligação (fim de fluxo)'));
        player.on(M.Events.RECOVERED_EARLY_EOF, () => logDiag('mpegts: ligação caiu e foi recuperada'));
        player.on(M.Events.MEDIA_INFO, (mi) => {
          logDiag('mpegts fluxo: ' + (mi.videoCodec || 'sem vídeo') + ' ' + (mi.width || '?') + 'x' + (mi.height || '?') + ' / ' + (mi.audioCodec || 'sem áudio'));
        });
        player.attachMediaElement(video);
        player.load();
        Promise.resolve(player.play()).catch((err) => logDiag('play() recusado: ' + (err && err.message)));
        return;
      }

      if (engine === 'proxy') {
        window.viewer.iptvProxyUrl(url).then((res) => {
          if (done || !isCurrent(seq) || !res || !res.url) {
            if (res && res.token) window.viewer.iptvProxyStop(res.token).catch(() => {});
            if (!done && isCurrent(seq)) next('ffmpeg indisponível');
            return;
          }
          proxyToken = res.token;
          window.__iptvProxyToken = res.token;
          logDiag('ffmpeg a retransmitir via ' + res.url);
          video.src = res.url;
          Promise.resolve(video.play()).catch((err) => logDiag('play() recusado: ' + (err && err.message)));
        }).catch((err) => next('proxy: ' + (err && err.message ? err.message : err)));
        return;
      }

      // native
      video.src = url;
      Promise.resolve(video.play()).catch((err) => logDiag('play() recusado: ' + (err && err.message)));
    } catch (err) {
      next('exceção: ' + (err && err.message ? err.message : err));
    }
  }

  // ---- Menu flutuante para escolher/criar pasta ao clicar na estrela ----
  let openPicker = null;
  function closePicker() {
    clearTimeout(pickerTimer);
    if (openPicker) {
      openPicker.remove();
      openPicker = null;
      document.removeEventListener('click', onDocClick, true);
    }
  }
  function onDocClick(e) {
    if (openPicker && !openPicker.contains(e.target)) closePicker();
  }
  iptvCleanup = () => {
    playSeq++;
    cancelAttempt();
    clearTimeout(searchTimer);
    closePicker();
  };
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
    pickerTimer = setTimeout(() => {
      if (myGen === stageGeneration && openPicker === pop) document.addEventListener('click', onDocClick, true);
    }, 0);
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

  search.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { if (myGen === stageGeneration) render(); }, 120);
  });

  render();
}

async function dispatchModule(mod, btn) {
  switch (mod.type) {
    case 'youtube':  setActiveMenuBtn(btn); await renderYoutube(mod.data); break;
    case 'html':     setActiveMenuBtn(btn); renderHtml(mod.data); break;
    case 'local-web': setActiveMenuBtn(btn); await renderLocalWeb(mod); break;
    case 'pdf':      setActiveMenuBtn(btn); await renderPdf(mod.data); break;
    case 'webview':  setActiveMenuBtn(btn); renderWebview(mod.data); break;
    case 'smart-embed':    setActiveMenuBtn(btn); renderWebview(mod.data); break;
    case 'local-video':    setActiveMenuBtn(btn); await renderLocalVideo(mod.data); break;
    case 'local-audio':    setActiveMenuBtn(btn); await renderLocalAudio(mod.data); break;
    case 'image-gallery':  setActiveMenuBtn(btn); await renderGallery(mod.data); break;
    case 'article-reader': setActiveMenuBtn(btn); renderArticle(mod.data); break;
    case 'download-vault': setActiveMenuBtn(btn); renderDownloadVault(mod.data); break;
    case 'portable': setActiveMenuBtn(btn); renderPortable(mod); break;
    case 'apk':
    case 'android-apk': setActiveMenuBtn(btn); renderAndroidUnavailable(); break;
    case 'iptv':     setActiveMenuBtn(btn); await renderIptv(mod.data, mod.id); break;
    case 'external': await handleExternal(mod.data); break;
    case 'launch':   await handleLaunch(mod.data); break;
    default: break;
  }
}

/* In-stage password gate for protected modules. Once the correct password is
 * entered, the module stays unlocked for the rest of the viewing session. */
function renderPasswordGate(mod, btn, pwd) {
  clearStage();
  const generation = stageGeneration;
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
    if (submit.disabled || generation !== stageGeneration) return;
    if (input.value === pwd) {
      submit.disabled = true;
      unlockedModules.add(mod.id);
      if (btn) {
        btn.classList.remove('locked');
        const lock = btn.querySelector('.viewer-menu-lock');
        if (lock) lock.remove();
      }
      if (mod.type === 'external' || mod.type === 'launch') {
        // The gate has finished. Keep no action reference that translation or
        // session restoration could execute again.
        activeModuleRef = null;
        setActiveMenuBtn(null);
        clearStage();
        const welcome = document.createElement('div');
        welcome.className = 'viewer-empty';
        const heading = document.createElement('h2');
        const text = document.createElement('p');
        welcome.append(heading, text);
        stageEl.appendChild(welcome);
        applyDynamicTexts();
      }
      await handleModuleClick(mod, btn);
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

  let fileUrl;
  try { fileUrl = await relToFileUrl(banner.image); }
  catch (err) {
    showToast(tr('viewer.local_web_error', 'Não foi possível abrir este ficheiro.') + ' ' + (err && err.message ? err.message : err));
    return;
  }
  if (!fileUrl) return;

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

/* Desbloqueio do conteúdo. Existem dois caminhos:
 *  1) Submit do <form> do fornecedor colado no HTML. BUG CORRIGIDO: o
 *     preventDefault() anterior cancelava a submissão e o email do aluno
 *     NUNCA chegava ao fornecedor (Mailchimp, E-goi, …). Deixar o submit
 *     seguir também não serve — navegava a janela do Viewer para a página de
 *     "obrigado" do fornecedor. Solução: enviar o formulário em segundo plano
 *     (fetch no-cors com a mesma codificação que o browser usaria) e só depois
 *     fechar o portão. A resposta é opaca (cross-origin), mas a inscrição
 *     fica registada no servidor do fornecedor.
 *  2) Botão "Já me inscrevi — Aceder ao conteúdo". */
async function submitOptinForm(form) {
  const action = (form.getAttribute('action') || '').trim();
  if (!/^https?:\/\//i.test(action)) return false;
  const method = (form.getAttribute('method') || 'get').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const enctype = (form.getAttribute('enctype') || '').toLowerCase();
  const fd = new FormData(form);
  // Inclui o botão de submit com name (alguns fornecedores exigem-no).
  const submitter = form.querySelector('button[type=submit][name], input[type=submit][name]');
  if (submitter && submitter.name && !fd.has(submitter.name)) fd.append(submitter.name, submitter.value || '');
  const opts = { mode: 'no-cors', credentials: 'omit', redirect: 'follow' };
  let url = action;
  if (method === 'GET') {
    const qs = new URLSearchParams();
    fd.forEach((v, k) => { if (typeof v === 'string') qs.append(k, v); });
    url = action + (action.includes('?') ? '&' : '?') + qs.toString();
  } else if (enctype === 'multipart/form-data') {
    opts.method = 'POST'; opts.body = fd;
  } else {
    const body = new URLSearchParams();
    fd.forEach((v, k) => { if (typeof v === 'string') body.append(k, v); });
    opts.method = 'POST'; opts.body = body; // application/x-www-form-urlencoded (predefinição do browser)
  }
  await fetch(url, opts);
  return true;
}

optinFormHtml.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  const sending = (form && form.tagName === 'FORM') ? submitOptinForm(form) : Promise.resolve(false);
  sending
    .then((sent) => { if (sent) showToast(tr('viewer.optin_sent', 'Inscrição enviada. Obrigado!')); })
    .catch((err) => { console.error('Falha a enviar o formulário de inscrição:', err); })
    .finally(hideOptinGate);
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
    try {
      const logoUrl = await relToFileUrl(config.brand.logo);
      if (logoUrl) {
        logoEl.src = logoUrl;
        logoEl.classList.remove('hidden');
      }
    } catch (err) {
      logoEl.classList.add('hidden');
      logoEl.removeAttribute('src');
      showToast(tr('viewer.local_web_error', 'Não foi possível abrir este ficheiro.') + ' ' + (err && err.message ? err.message : err));
    }
  } else {
    logoEl.classList.add('hidden');
    logoEl.removeAttribute('src');
  }

  applyDynamicTexts();

  window.__viewerVersion = config.viewerVersion || '';
  const modules = Array.isArray(config.content) ? config.content : [];
  buildMenu(modules);
  renderSocial(config.marketing && config.marketing.social);
  await renderBanner(config.marketing && config.marketing.banners);

  // Ecrã de boas-vindas com ação: "Começar" abre o primeiro módulo.
  const startBtn = document.getElementById('viewer-start');
  const firstOpenable = modules.find((m) => m && m.type !== 'external' && m.type !== 'launch') || modules[0];
  if (startBtn) {
    startBtn.classList.toggle('hidden', !firstOpenable);
    startBtn.addEventListener('click', () => {
      const b = firstOpenable && menuEl.querySelector('.viewer-menu-btn[data-id="' + firstOpenable.id + '"]');
      if (b) b.click();
    });
  }

  // Retomar onde o aluno ficou da última vez (só módulos abertos dentro da app).
  try {
    const st = await loadViewerState();
    const last = st && st.lastModuleId && modules.find((m) => m && m.id === st.lastModuleId);
    if (last && last.type !== 'external' && last.type !== 'launch') {
      const b = menuEl.querySelector('.viewer-menu-btn[data-id="' + last.id + '"]');
      if (b) await handleModuleClick(last, b);
    }
  } catch (_) { /* fica na página de boas-vindas */ }

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
  const generation = ++languageGeneration;
  let applied = lang;
  try {
    const res = await window.viewer.loadLocale(lang);
    if (generation !== languageGeneration) return;
    i18nDict = res.dict || {};
    if (res.lang) applied = res.lang;
  } catch (_) { return; }
  applyI18n();
  applyDynamicTexts();
  applyDir(ALLOWED_LANGS.includes(applied) ? applied : 'pt');
  const langSelect = document.getElementById('viewer-lang');
  if (langSelect) langSelect.value = ALLOWED_LANGS.includes(applied) ? applied : 'pt';
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
