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
const stageEl = document.getElementById('viewer-stage');

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
