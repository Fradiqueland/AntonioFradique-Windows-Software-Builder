/* =========================================================
 * i18n ENGINE (Tarefa 3)
 * ========================================================= */
const I18N = {
  lang: 'pt',
  dict: {},
  ready: false
};
let projectGeneration = 0;
let projectTransition = null;
let contentMutation = null;
let localeRequest = 0;
const settingsWrites = new Set();

function tRaw(key) {
  if (!key) return undefined;
  return key.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), I18N.dict);
}
function t(key, fallback) {
  const v = tRaw(key);
  return (typeof v === 'string') ? v : (fallback !== undefined ? fallback : key);
}

function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const v = tRaw(el.getAttribute('data-i18n'));
    if (typeof v === 'string') el.textContent = v;
  });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const v = tRaw(el.getAttribute('data-i18n-html'));
    if (typeof v === 'string') el.innerHTML = v;
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const v = tRaw(el.getAttribute('data-i18n-placeholder'));
    if (typeof v === 'string') el.setAttribute('placeholder', v);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const v = tRaw(el.getAttribute('data-i18n-title'));
    if (typeof v === 'string') el.setAttribute('title', v);
  });
  // Refresh current tab header (it was set imperatively).
  const activeTab = document.querySelector('.tab.active');
  if (activeTab) refreshTabHeader(activeTab.dataset.tab);
  // Update <html lang> and text direction (RTL for Arabic).
  document.documentElement.setAttribute('lang', I18N.lang);
  document.documentElement.setAttribute('dir', I18N.lang === 'ar' ? 'rtl' : 'ltr');
}

async function setLanguage(lang, { persist = true } = {}) {
  const request = ++localeRequest;
  const generation = projectGeneration;
  try {
    const { lang: applied, dict } = await window.icurator.loadLocale(lang);
    if (request !== localeRequest || generation !== projectGeneration) return;
    I18N.lang = applied;
    I18N.dict = dict;
    I18N.ready = true;
    applyI18n();
    renderExportTarget();
    renderPortableEditor();
    if (lastExportConfig) updateExportSummary(lastExportConfig);
    // Os cartões de tipo de módulo são gerados por JS: refazê-los no novo idioma.
    if (typeof renderTypeCards === 'function' && typeof moduleType !== 'undefined') {
      renderTypeCards();
      syncTypeUI(moduleType.value);
    }
    // A lista de módulos mostra o tipo traduzido: refazê-la no novo idioma
    // (no arranque era desenhada antes do dicionário chegar).
    if (typeof renderContentList === 'function' && typeof contentModules !== 'undefined') renderContentList();
    const sel = document.getElementById('lang-select');
    if (sel && sel.value !== applied) sel.value = applied;
    if (persist) {
      try { await window.icurator.saveLanguage(applied); } catch (e) { console.warn('Falha a persistir idioma:', e); }
    }
  } catch (err) {
    console.error('Falha a carregar idioma', lang, err);
  }
}

/* =========================================================
 * Custom file input helpers
 * Updates the `<span class="file-name" id="${input.id}-name">` next to each
 * hidden native file input. Keeps the visible filename in sync with the
 * user's pick and falls back to the i18n default ("No file selected" …) when
 * the input is cleared. Also fires once on language change so that the
 * placeholder text stays in the active language.
 * ========================================================= */
function setFileNameForInput(input, label) {
  if (!input) return;
  const span = document.getElementById(input.id + '-name');
  if (!span) return;
  if (label) {
    span.textContent = label;
    span.classList.add('has-file');
    span.removeAttribute('data-i18n');
  } else {
    span.textContent = t('common.no_file_chosen');
    span.classList.remove('has-file');
    span.setAttribute('data-i18n', 'common.no_file_chosen');
  }
}
document.addEventListener('change', (ev) => {
  const input = ev.target;
  if (!(input instanceof HTMLInputElement)) return;
  if (input.type !== 'file' || !input.classList.contains('file-input-hidden')) return;
  const file = input.files && input.files[0];
  setFileNameForInput(input, file ? file.name : null);
});

/* -------- Tab navigation -------- */
function refreshTabHeader(target) {
  const title = t('header.' + target + '.title');
  const subtitle = t('header.' + target + '.subtitle');
  if (pageTitle) pageTitle.textContent = title;
  if (pageSubtitle) pageSubtitle.textContent = subtitle;
}

const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.panel');
const pageTitle = document.getElementById('page-title');
const pageSubtitle = document.getElementById('page-subtitle');

/* Navegação em 3 passos: cada passo (Conteúdo / Aparência / Publicar) mostra
 * de uma vez todos os painéis com esse data-step, empilhados; os opcionais
 * (banners, redes sociais, leads) ficam recolhidos até terem dados. */
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    tabs.forEach((t2) => t2.classList.toggle('active', t2 === tab));
    panels.forEach((p) => p.classList.toggle('hidden', !(p.dataset.step === target || p.dataset.panel === target)));
    refreshTabHeader(target);
    const main = document.querySelector('main.content');
    if (main) main.scrollTop = 0;
  });
});

function setSectionCollapsed(panelName, collapsed) {
  const panel = document.querySelector('.panel[data-panel="' + panelName + '"]');
  if (!panel || !panel.classList.contains('collapsible')) return;
  panel.classList.toggle('collapsed', collapsed);
  const btn = panel.querySelector('.section-toggle');
  if (btn) {
    btn.setAttribute('data-i18n', collapsed ? 'section.show' : 'section.hide');
    btn.textContent = t(collapsed ? 'section.show' : 'section.hide');
  }
}
document.querySelectorAll('.section-toggle').forEach((btn) => {
  btn.addEventListener('click', () => {
    const panel = btn.closest('.panel');
    if (panel) setSectionCollapsed(panel.dataset.panel, !panel.classList.contains('collapsed'));
  });
});
document.querySelectorAll('.panel.collapsible .section-head h2').forEach((h) => {
  h.addEventListener('click', () => {
    const panel = h.closest('.panel');
    if (panel) setSectionCollapsed(panel.dataset.panel, !panel.classList.contains('collapsed'));
  });
});

/* Gravação automática: os formulários de aparência/publicação gravam ao sair
 * de cada campo (evento change), sem botão "Guardar". O submit existente é
 * reutilizado tal e qual, por isso as validações e mensagens mantêm-se. */
const autosaveTimers = new WeakMap();
function queueAutosave(form) {
  if (!form) return;
  const generation = projectGeneration;
  clearTimeout(autosaveTimers.get(form));
  autosaveTimers.set(form, setTimeout(() => {
    if (generation !== projectGeneration || projectTransition) return;
    if (typeof form.reportValidity === 'function' && !form.checkValidity()) { form.reportValidity(); return; }
    form.requestSubmit();
  }, 250));
}

function beginSettingsSave(form) {
  if (projectTransition || settingsWrites.has(form)) return false;
  if (contentMutation) { queueAutosave(form); return false; }
  settingsWrites.add(form);
  form.inert = true;
  updateBuilderBusyUI();
  return true;
}

function endSettingsSave(form) {
  settingsWrites.delete(form);
  form.inert = !!projectTransition;
  updateBuilderBusyUI();
}

async function pickForCurrentProject(pick, showStatus) {
  if (projectTransition) return null;
  const generation = projectGeneration;
  try {
    const result = await pick();
    return generation === projectGeneration ? result : null;
  } catch (err) {
    if (generation === projectGeneration) showStatus(t('common.error_prefix') + err.message, 'error');
    return null;
  }
}

function updateBuilderBusyUI() {
  const writing = !!contentMutation || settingsWrites.size > 0;
  document.querySelectorAll('.panel').forEach((panel) => { panel.inert = !!projectTransition; });
  if (projectsListEl) projectsListEl.inert = writing || !!projectTransition || exportInProgress;
  if (projectNewForm) projectNewForm.inert = writing || !!projectTransition || exportInProgress;
  contentList.inert = writing || !!projectTransition;
  contentAddBtn.disabled = !!projectTransition;
  if (contentEditorSave) contentEditorSave.disabled = writing || !!projectTransition || !TYPE_KEYS.includes(moduleType.value)
    || (moduleType.value === 'portable' && !!portableOperation);
  updateExportButton();
}
document.querySelectorAll('form.autosave').forEach((form) => {
  form.addEventListener('change', () => queueAutosave(form));
});

/* -------- Language dropdown + corner links -------- */
document.addEventListener('DOMContentLoaded', () => {
  const verEl = document.querySelector('.sidebar-footer .version');
  if (verEl && window.icurator && window.icurator.version) verEl.textContent = 'v' + window.icurator.version;

  const sel = document.getElementById('lang-select');
  if (sel) sel.addEventListener('change', (e) => setLanguage(e.target.value));

  // Atalhos sempre visíveis no cabeçalho: pré-visualizar e exportar.
  const hp = document.getElementById('header-preview');
  const he = document.getElementById('header-export');
  if (hp) hp.addEventListener('click', () => { const b = document.getElementById('preview-btn'); if (b) b.click(); });
  if (he) he.addEventListener('click', () => {
    goToTab('publicar');
    const btn = document.getElementById('export-build');
    if (btn) setTimeout(() => btn.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  });

  document.querySelectorAll('.marquee-track').forEach((track) => {
    track.innerHTML += track.innerHTML;
  });

  document.querySelectorAll('.corner-link[data-ext]').forEach((a) => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const url = a.getAttribute('data-ext');
      if (url && window.icurator && window.icurator.openExternal) {
        window.icurator.openExternal(url);
      }
    });
  });
});

/* -------- Preview button (Passo 5) -------- */
const previewBtn = document.getElementById('preview-btn');
if (previewBtn) {
  previewBtn.disabled = false;
  previewBtn.addEventListener('click', async () => {
    previewBtn.disabled = true;
    try {
      await window.icurator.openViewer();
    } catch (err) {
      console.error('Falha ao abrir Pré-visualização:', err);
    } finally {
      setTimeout(() => { previewBtn.disabled = false; }, 800);
    }
  });
}

/* -------- Shared helpers -------- */

function makeStatus(el) {
  let lastMsg = '';
  return function showStatus(message, kind) {
    lastMsg = message;
    el.textContent = message;
    el.className = 'save-status ' + (kind || '');
    if (message) {
      setTimeout(() => {
        if (el.textContent === lastMsg) {
          el.textContent = '';
          el.className = 'save-status';
        }
      }, 3000);
    }
  };
}

function setImagePreview(imgEl, emptyEl, absPath) {
  if (!absPath) {
    imgEl.removeAttribute('src');
    imgEl.classList.remove('visible');
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }
  imgEl.src = 'file://' + absPath.replace(/\\/g, '/') + '?t=' + Date.now();
  imgEl.classList.add('visible');
  if (emptyEl) emptyEl.classList.add('hidden');
}

function uuid() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return 'm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
}

/* =========================================================
 * BRAND FORM (Passo 2)
 * ========================================================= */
const brandForm = document.getElementById('brand-form');
const titleInput = document.getElementById('brand-title');
const logoInput = document.getElementById('brand-logo');
const logoRemoveBtn = document.getElementById('brand-logo-remove');
const logoPreview = document.getElementById('brand-logo-preview');
const logoEmpty = document.getElementById('brand-logo-empty');
const colorInputs = {
  sidebar: document.getElementById('color-sidebar'),
  background: document.getElementById('color-background'),
  buttons: document.getElementById('color-buttons')
};
const colorHexLabels = {
  sidebar: document.getElementById('color-sidebar-hex'),
  background: document.getElementById('color-background-hex'),
  buttons: document.getElementById('color-buttons-hex')
};
const brandSaveBtn = document.getElementById('brand-save');
const showBrandStatus = makeStatus(document.getElementById('save-status'));

const brandState = { pendingLogoSourcePath: null, pendingRemoveLogo: false, currentLogoRelative: null };

Object.keys(colorInputs).forEach((key) => {
  colorInputs[key].addEventListener('input', (e) => {
    colorHexLabels[key].textContent = e.target.value.toUpperCase();
  });
});

const logoPickLabel = document.querySelector('label[for="brand-logo"]');
if (logoPickLabel) logoPickLabel.addEventListener('click', async (e) => {
  e.preventDefault();
  const picked = await pickForCurrentProject(() => window.icurator.pickFile('image'), showBrandStatus);
  if (!picked) return;
  brandState.pendingLogoSourcePath = picked.path;
  brandState.pendingRemoveLogo = false;
  setFileNameForInput(logoInput, picked.name);
  setImagePreview(logoPreview, logoEmpty, picked.path);
  queueAutosave(brandForm);
});

logoRemoveBtn.addEventListener('click', () => {
  brandState.pendingLogoSourcePath = null;
  brandState.pendingRemoveLogo = true;
  logoInput.value = '';
  setFileNameForInput(logoInput, null);
  setImagePreview(logoPreview, logoEmpty, null);
  queueAutosave(brandForm);
});

brandForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!beginSettingsSave(brandForm)) return;
  brandSaveBtn.disabled = true;
  showBrandStatus(t('common.saving'), '');
  const justPickedLogo = brandState.pendingLogoSourcePath;
  try {
    const updated = await window.icurator.saveBrandConfig({
      title: titleInput.value,
      colors: {
        sidebar: colorInputs.sidebar.value,
        background: colorInputs.background.value,
        buttons: colorInputs.buttons.value
      },
      logoSourcePath: brandState.pendingLogoSourcePath || undefined,
      removeLogo: brandState.pendingRemoveLogo || undefined
    });
    brandState.pendingLogoSourcePath = null;
    brandState.pendingRemoveLogo = false;
    brandState.currentLogoRelative = updated.brand.logo || null;
    logoInput.value = '';
    setFileNameForInput(logoInput, null);
    let logoPreviewPath = null;
    if (brandState.currentLogoRelative) {
      logoPreviewPath = justPickedLogo
        || await window.icurator.resolveAssetPath(brandState.currentLogoRelative);
    }
    setImagePreview(logoPreview, logoEmpty, logoPreviewPath);
    updateExportSummary(updated);
    showBrandStatus(t('common.saved'), 'success');
  } catch (err) {
    console.error(err);
    showBrandStatus(t('common.error_prefix') + (err && err.message ? err.message : err), 'error');
  } finally {
    brandSaveBtn.disabled = false;
    endSettingsSave(brandForm);
  }
});

/* =========================================================
 * REDES SOCIAIS
 * ========================================================= */
const socialForm = document.getElementById('social-form');
const socialInputs = {
  site: document.getElementById('social-site'),
  instagram: document.getElementById('social-instagram'),
  facebook: document.getElementById('social-facebook'),
  x: document.getElementById('social-x'),
  tiktok: document.getElementById('social-tiktok'),
  pinterest: document.getElementById('social-pinterest'),
  linkedin: document.getElementById('social-linkedin'),
  spotify: document.getElementById('social-spotify'),
  whatsapp: document.getElementById('social-whatsapp'),
  telegram: document.getElementById('social-telegram')
};
const socialSaveBtn = document.getElementById('social-save');
const showSocialStatus = makeStatus(document.getElementById('social-status'));

function fillSocialInputs(social) {
  const s = social || {};
  Object.keys(socialInputs).forEach((k) => {
    if (socialInputs[k]) socialInputs[k].value = s[k] || '';
  });
}

if (socialForm) {
  socialForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!beginSettingsSave(socialForm)) return;
    socialSaveBtn.disabled = true;
    showSocialStatus(t('common.saving'), '');
    try {
      const payload = {};
      Object.keys(socialInputs).forEach((k) => {
        payload[k] = socialInputs[k] ? socialInputs[k].value : '';
      });
      const updated = await window.icurator.saveSocialConfig(payload);
      fillSocialInputs(updated.marketing && updated.marketing.social);
      showSocialStatus(t('common.saved'), 'success');
    } catch (err) {
      console.error(err);
      showSocialStatus(t('common.error_prefix') + (err && err.message ? err.message : err), 'error');
    } finally {
      socialSaveBtn.disabled = false;
      endSettingsSave(socialForm);
    }
  });
}

/* =========================================================
 * LEADS FORM (Passo 3)
 * ========================================================= */
const leadsForm = document.getElementById('leads-form');
const leadsEnabled = document.getElementById('leads-enabled');
const leadsHeading = document.getElementById('leads-heading');
const leadsHtml = document.getElementById('leads-html');
const leadsSaveBtn = document.getElementById('leads-save');
const showLeadsStatus = makeStatus(document.getElementById('leads-status'));

leadsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!beginSettingsSave(leadsForm)) return;
  leadsSaveBtn.disabled = true;
  showLeadsStatus(t('common.saving'), '');
  try {
    const updated = await window.icurator.saveLeadsConfig({
      enabled: leadsEnabled.checked,
      heading: leadsHeading.value,
      formHtml: leadsHtml.value
    });
    updateExportSummary(updated);
    showLeadsStatus(t('common.saved'), 'success');
  } catch (err) {
    console.error(err);
    showLeadsStatus(t('common.error_prefix') + (err && err.message ? err.message : err), 'error');
  } finally {
    leadsSaveBtn.disabled = false;
    endSettingsSave(leadsForm);
  }
});

/* =========================================================
 * BANNER FORM (Passo 3)
 * ========================================================= */
const bannerForm = document.getElementById('banner-form');
const bannerSaveBtn = document.getElementById('banner-save');
const showBannerStatus = makeStatus(document.getElementById('banner-status'));

/* Dois banners independentes (topo e rodapé). Cada slot gere o seu próprio
 * estado de imagem pendente (escolher / remover / manter). */
function makeBannerSlot(slotName) {
  const enabled = document.getElementById('banner-' + slotName + '-enabled');
  const imageInput = document.getElementById('banner-' + slotName + '-image');
  const removeBtn = document.getElementById('banner-' + slotName + '-image-remove');
  const preview = document.getElementById('banner-' + slotName + '-image-preview');
  const empty = document.getElementById('banner-' + slotName + '-image-empty');
  const urlInput = document.getElementById('banner-' + slotName + '-url');
  const state = { pendingImageSourcePath: null, pendingRemoveImage: false, currentImageRelative: null };

  const pickLabel = document.querySelector('label[for="banner-' + slotName + '-image"]');
  if (pickLabel) pickLabel.addEventListener('click', async (e) => {
    e.preventDefault();
    const picked = await pickForCurrentProject(() => window.icurator.pickFile('image'), showBannerStatus);
    if (!picked) return;
    state.pendingImageSourcePath = picked.path;
    state.pendingRemoveImage = false;
    setFileNameForInput(imageInput, picked.name);
    setImagePreview(preview, empty, picked.path);
    if (!enabled.checked) enabled.checked = true; // escolher uma imagem é querer o banner
    queueAutosave(bannerForm);
  });

  removeBtn.addEventListener('click', () => {
    state.pendingImageSourcePath = null;
    state.pendingRemoveImage = true;
    imageInput.value = '';
    setFileNameForInput(imageInput, null);
    setImagePreview(preview, empty, null);
    queueAutosave(bannerForm);
  });

  return {
    state,
    payload() {
      return {
        enabled: enabled.checked,
        url: urlInput.value,
        imageSourcePath: state.pendingImageSourcePath || undefined,
        removeImage: state.pendingRemoveImage || undefined
      };
    },
    async load(banner) {
      const b = banner || {};
      enabled.checked = !!b.enabled;
      urlInput.value = b.url || '';
      state.currentImageRelative = b.image || null;
      state.pendingImageSourcePath = null;
      state.pendingRemoveImage = false;
      setFileNameForInput(imageInput, null);
      if (state.currentImageRelative) {
        const abs = await window.icurator.resolveAssetPath(state.currentImageRelative);
        setImagePreview(preview, empty, abs);
      } else {
        setImagePreview(preview, empty, null);
      }
    },
    async afterSave(savedBanner, justPicked) {
      const b = savedBanner || {};
      state.pendingImageSourcePath = null;
      state.pendingRemoveImage = false;
      state.currentImageRelative = b.image || null;
      imageInput.value = '';
      setFileNameForInput(imageInput, null);
      let previewPath = null;
      if (state.currentImageRelative) {
        previewPath = justPicked || await window.icurator.resolveAssetPath(state.currentImageRelative);
      }
      setImagePreview(preview, empty, previewPath);
    }
  };
}

const bannerTopSlot = makeBannerSlot('top');
const bannerBottomSlot = makeBannerSlot('bottom');

bannerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!beginSettingsSave(bannerForm)) return;
  bannerSaveBtn.disabled = true;
  showBannerStatus(t('common.saving'), '');
  const justPickedTop = bannerTopSlot.state.pendingImageSourcePath;
  const justPickedBottom = bannerBottomSlot.state.pendingImageSourcePath;
  try {
    const updated = await window.icurator.saveBannerConfig({
      top: bannerTopSlot.payload(),
      bottom: bannerBottomSlot.payload()
    });
    const banners = (updated.marketing && updated.marketing.banners) || {};
    await bannerTopSlot.afterSave(banners.top, justPickedTop);
    await bannerBottomSlot.afterSave(banners.bottom, justPickedBottom);
    updateExportSummary(updated);
    showBannerStatus(t('common.saved'), 'success');
  } catch (err) {
    console.error(err);
    showBannerStatus(t('common.error_prefix') + (err && err.message ? err.message : err), 'error');
  } finally {
    bannerSaveBtn.disabled = false;
    endSettingsSave(bannerForm);
  }
});

/* =========================================================
 * CONTENT / MENUS (Passo 4)
 * ========================================================= */

// Module type labels are now resolved from the active locale via
// `content.type.<key>` so the list stays in the user's chosen language
// (PT/EN/ES/FR). `typeLabel(type)` falls back to the raw type if no key.
const TYPE_KEYS = ['youtube', 'html', 'local-web', 'portable', 'pdf', 'webview', 'external', 'launch',
  'local-video', 'local-audio', 'download-vault', 'image-gallery',
  'article-reader', 'smart-embed', 'iptv'];
// Chaves de tradução por tipo (o id do tipo usa '-', a chave usa '_').
const TYPE_I18N = {
  youtube: 'youtube', html: 'html', 'local-web': 'local_web', portable: 'portable', pdf: 'pdf', webview: 'webview', external: 'external', launch: 'launch',
  'local-video': 'local_video', 'local-audio': 'local_audio', 'download-vault': 'download',
  'image-gallery': 'gallery', 'article-reader': 'article', 'smart-embed': 'embed', iptv: 'iptv'
};
const TYPE_ICON = {
  youtube: '▶️', 'local-video': '🎬', pdf: '📄', 'article-reader': '📝', html: '🧩', 'local-web': '📁',
  'download-vault': '⬇️', launch: '🚀', portable: '💼', webview: '🌐', external: '🔗', 'smart-embed': '📋',
  'image-gallery': '🖼️', 'local-audio': '🎵', iptv: '📺'
};
// Cartões agrupados por intenção (o que o aluno vai fazer), não por tecnologia.
const TYPE_GROUPS = [
  { key: 'video', types: ['youtube', 'local-video'] },
  { key: 'read',  types: ['pdf', 'article-reader', 'html'] },
  { key: 'files', types: ['download-vault', 'launch', 'portable'] },
  { key: 'web',   types: ['local-web', 'webview', 'external', 'smart-embed'] },
  { key: 'media', types: ['image-gallery', 'local-audio', 'iptv'] }
];
function typeLabel(type) {
  // BUG CORRIGIDO: 5 tipos (local-video, download-vault, …) apareciam na lista
  // com o id em bruto porque a chave de tradução usa '_' e o id usa '-'.
  const key = 'content.type.' + (TYPE_I18N[type] || type);
  const v = t(key);
  return v === key ? type : v;
}
function typeDesc(type) {
  const key = 'content.type_desc.' + (TYPE_I18N[type] || type);
  const v = t(key);
  return v === key ? '' : v;
}

const contentList = document.getElementById('content-list');
const contentListEmpty = document.getElementById('content-list-empty');
const contentAddBtn = document.getElementById('content-add');
const contentForm = document.getElementById('content-form');
const contentEditorEmpty = document.getElementById('content-editor-empty');
const contentEditorTitle = document.getElementById('content-editor-title');
const contentEditorClose = document.getElementById('content-editor-close');
const contentEditorCancel = document.getElementById('content-editor-cancel');
const moduleTitle = document.getElementById('module-title');
const moduleType = document.getElementById('module-type');
const modulePassword = document.getElementById('module-password');
const dynGroups = document.querySelectorAll('[data-dyn]');
const showContentStatus = makeStatus(document.getElementById('content-status'));

const dyn = {
  youtube: { url: document.getElementById('dyn-youtube-url') },
  html: { code: document.getElementById('dyn-html-code') },
  'local-web': {
    pick: document.getElementById('dyn-local-web-pick'),
    name: document.getElementById('dyn-local-web-name'),
    current: document.getElementById('dyn-local-web-current'),
    includeDirectory: document.getElementById('dyn-local-web-directory')
  },
  portable: {
    pick: document.getElementById('dyn-portable-pick'),
    name: document.getElementById('dyn-portable-name'),
    summary: document.getElementById('dyn-portable-summary'),
    windows: document.getElementById('dyn-portable-windows'),
    mac: document.getElementById('dyn-portable-mac'),
    allowWine: document.getElementById('dyn-portable-wine'),
    test: document.getElementById('dyn-portable-test'),
    configureWine: document.getElementById('dyn-portable-configure-wine'),
    wineHelp: document.getElementById('dyn-portable-wine-help'),
    status: document.getElementById('dyn-portable-status')
  },
  pdf: {
    file: document.getElementById('dyn-pdf-file'),
    current: document.getElementById('dyn-pdf-current')
  },
  webview: { url: document.getElementById('dyn-webview-url') },
  external: { url: document.getElementById('dyn-external-url') },
  launch: {
    file: document.getElementById('dyn-launch-file'),
    current: document.getElementById('dyn-launch-current')
  },
  'local-video': {
    file: document.getElementById('dyn-local-video-file'),
    current: document.getElementById('dyn-local-video-current')
  },
  'local-audio': {
    file: document.getElementById('dyn-local-audio-file'),
    current: document.getElementById('dyn-local-audio-current')
  },
  'download-vault': {
    file: document.getElementById('dyn-download-vault-file'),
    current: document.getElementById('dyn-download-vault-current'),
    btn: document.getElementById('dyn-download-vault-btn')
  },
  'image-gallery': {
    addBtn: document.getElementById('dyn-gallery-add'),
    list: document.getElementById('dyn-gallery-list')
  },
  'article-reader': {
    text: document.getElementById('dyn-article-text')
  },
  'smart-embed': {
    url: document.getElementById('dyn-smart-embed-url')
  },
  iptv: {
    source: document.getElementById('dyn-iptv-source'),
    xtreamUrl: document.getElementById('dyn-iptv-xtream-url'),
    xtreamUser: document.getElementById('dyn-iptv-xtream-user'),
    xtreamPass: document.getElementById('dyn-iptv-xtream-pass'),
    m3u8Url: document.getElementById('dyn-iptv-m3u8-url'),
    m3uPick: document.getElementById('dyn-iptv-m3u-pick'),
    m3uName: document.getElementById('dyn-iptv-m3u-name'),
    manualAdd: document.getElementById('dyn-iptv-manual-add'),
    manualList: document.getElementById('dyn-iptv-manual-list'),
    load: document.getElementById('dyn-iptv-load'),
    loadRow: document.getElementById('dyn-iptv-loadrow'),
    status: document.getElementById('dyn-iptv-status')
  }
};

// In-memory mirror of the saved content array. Always kept in sync with disk.
let contentModules = [];
// Editor state
let editingId = null;        // id of module being edited (null = creating new)
let pendingFileSourcePath = null;  // absolute path picked in <input type=file> for current edit
let pendingFileName = null;
const pendingFilesByType = new Map();
let pendingWebSourcePath = null;
let editorGeneration = 0;   // ignore a file dialog result after switching projects/editors
let pendingPortableSourcePath = null;
let portableCandidates = [];
let portableSourceName = '';
let portableScanStats = null;
let portableOperation = null;
let portableStatus = null;
let portableHostPlatform = '';
let activeDynamicType = '';
let editorRevision = 0;
let iptvRequest = 0;
let galleryItems = [];       // current gallery editor items ({kind:'existing'|'new', ...})
let iptvChannels = [];       // resolved channels for the module being edited (non-manual sources)
let iptvManual = [];         // manual channel rows [{name,url}]
let iptvM3uPath = null;      // absolute path of a picked .m3u file

function showDynamicGroup(type) {
  if (activeDynamicType !== type) {
    editorGeneration++;
    portableOperation = null;
    activeDynamicType = type;
    const fileDraft = pendingFilesByType.get(type);
    pendingFileSourcePath = fileDraft ? fileDraft.path : null;
    pendingFileName = fileDraft ? fileDraft.name : null;
    iptvRequest++;
    dyn.iptv.load.disabled = false;
  }
  dynGroups.forEach((g) => g.classList.toggle('hidden', g.dataset.dyn !== type));
  syncTypeUI(type);
  updatePortableActions();
}

function portableEntries() {
  return { windows: dyn.portable.windows.value || null, mac: dyn.portable.mac.value || null };
}

function portableSavedModule() {
  return contentModules.find((mod) => mod.id === editingId && mod.type === 'portable'
    && mod.data && mod.data.root && !mod.data.sourcePath);
}

function portableHasSavedSelection() {
  const saved = portableSavedModule();
  if (!saved || pendingPortableSourcePath) return false;
  const entries = portableEntries();
  const previous = saved.data.entries || {};
  return entries.windows === (previous.windows || null) && entries.mac === (previous.mac || null)
    && dyn.portable.allowWine.checked === !!saved.data.allowWine;
}

function updatePortableActions() {
  const busy = !!portableOperation;
  dyn.portable.pick.disabled = busy;
  dyn.portable.windows.disabled = busy || !portableCandidates.some((item) => item.platform === 'windows');
  dyn.portable.mac.disabled = busy || !portableCandidates.some((item) => item.platform === 'mac');
  dyn.portable.allowWine.disabled = busy || !dyn.portable.windows.value;
  dyn.portable.test.disabled = busy || !portableHasSavedSelection();
  dyn.portable.configureWine.disabled = busy;
  dyn.portable.configureWine.classList.toggle('hidden', portableHostPlatform !== 'darwin');
  dyn.portable.wineHelp.classList.toggle('hidden', portableHostPlatform !== 'darwin');
  if (moduleType.value === 'portable') contentEditorSave.disabled = busy || !!contentMutation || !!projectTransition || settingsWrites.size > 0;
}

function setPortableStatus(key, kind = '', detail = '') {
  portableStatus = key ? { key, kind, detail } : null;
  dyn.portable.status.textContent = portableStatus ? t('portable.' + key) + detail : '';
  dyn.portable.status.className = 'portable-status' + (kind ? ' ' + kind : '');
}

function renderPortableEditor(entries = portableEntries()) {
  const ui = dyn.portable;
  ui.name.textContent = portableSourceName || t('portable.no_folder');
  ui.name.classList.toggle('has-file', !!portableSourceName);
  ui.name.removeAttribute('data-i18n');
  for (const platform of ['windows', 'mac']) {
    const select = ui[platform];
    select.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = t('portable.no_entry');
    select.appendChild(empty);
    for (const candidate of portableCandidates.filter((item) => item.platform === platform)) {
      const option = document.createElement('option');
      option.value = candidate.path;
      const architectures = Array.isArray(candidate.architectures) ? candidate.architectures.join(' / ') : '';
      option.textContent = [candidate.label || candidate.path, candidate.kind, architectures].filter(Boolean).join(' · ');
      select.appendChild(option);
    }
    select.value = entries[platform] || '';
    if (select.selectedIndex < 0) select.value = '';
  }
  ui.summary.textContent = portableScanStats
    ? t('portable.scan_summary').replace('{files}', String(portableScanStats.files))
      .replace('{size}', (portableScanStats.bytes / (1024 * 1024)).toLocaleString(I18N.lang, { maximumFractionDigits: 1 }))
    : '';
  if (portableStatus) setPortableStatus(portableStatus.key, portableStatus.kind, portableStatus.detail);
  updatePortableActions();
}

function suggestPortableEntry(platform, candidates, sourceName) {
  const stem = (name) => String(name || '').split(/[\\/]/).pop().replace(/\.(exe|app)$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = stem(sourceName);
  const ranked = candidates.filter((item) => item.platform === platform && !/(^|[\\/_. -])(unins\w*|uninstall|setup|installer|updater|crashpad|helper)([\\/_. -]|$)/i.test(item.path))
    .map((item) => ({ item, score: (wanted && stem(item.path) === wanted ? 4 : 0) + (item.kind === 'app' ? 1 : 0) }))
    .sort((a, b) => b.score - a.score);
  if (ranked.length === 1 || (ranked.length > 1 && ranked[0].score > ranked[1].score)) return ranked[0].item.path;
  return null;
}

function portableDataForSave() {
  const saved = portableSavedModule();
  if (!pendingPortableSourcePath && !saved) throw new Error(t('portable.pick_first'));
  const entries = portableEntries();
  if (!entries.windows && !entries.mac) throw new Error(t('portable.entry_required'));
  for (const platform of ['windows', 'mac']) {
    if (entries[platform] && !portableCandidates.some((item) => item.platform === platform && item.path === entries[platform])) {
      throw new Error(t('portable.entry_required'));
    }
  }
  return {
    ...(pendingPortableSourcePath ? { sourcePath: pendingPortableSourcePath } : saved.data),
    entries,
    allowWine: !!entries.windows && dyn.portable.allowWine.checked
  };
}

/* Cartões de tipo: escolher um cartão preenche o <select> escondido e mostra
 * só os campos desse tipo; o tipo escolhido fica num "chip" com "Mudar". */
const typeCardsEl = document.getElementById('type-cards');
const typeChosenEl = document.getElementById('type-chosen');
const typeChipEl = document.getElementById('type-chip');
const typePickHint = document.getElementById('type-pick-hint');
const contentEditorSave = document.getElementById('content-editor-save');
const androidInfoPanel = document.getElementById('android-info-panel');
const androidInfoStatus = document.getElementById('android-info-status');
const androidImportBtn = document.getElementById('android-import-btn');
let androidInfoRequest = 0;

function setAndroidInformationStatus(key) {
  if (androidInfoStatus) {
    androidInfoStatus.setAttribute('data-i18n', key);
    androidInfoStatus.textContent = t(key);
  }
  // There is no validated execution adapter in this release. An optimistic
  // runtime response must never enable an importer that cannot run its APK.
  if (androidImportBtn) androidImportBtn.disabled = true;
}

function hideAndroidInformation() {
  androidInfoRequest++;
  if (androidInfoPanel) androidInfoPanel.classList.add('hidden');
  const card = typeCardsEl && typeCardsEl.querySelector('[data-android-info]');
  if (card) card.setAttribute('aria-expanded', 'false');
  setAndroidInformationStatus('android.unavailable');
}

async function showAndroidInformation() {
  if (!androidInfoPanel) return;
  const request = ++androidInfoRequest;
  androidInfoPanel.classList.remove('hidden');
  const card = typeCardsEl && typeCardsEl.querySelector('[data-android-info]');
  if (card) card.setAttribute('aria-expanded', 'true');
  if (typeof androidInfoPanel.scrollIntoView === 'function') androidInfoPanel.scrollIntoView({ block: 'nearest' });
  const api = window.icurator || {};
  if (typeof api.getAndroidRuntimeStatus !== 'function') {
    setAndroidInformationStatus('android.unavailable');
    return;
  }
  setAndroidInformationStatus('android.checking');
  try {
    const status = await api.getAndroidRuntimeStatus();
    if (request !== androidInfoRequest || androidInfoPanel.classList.contains('hidden')) return;
    setAndroidInformationStatus(status && status.available === true
      ? 'android.adapter_unavailable' : 'android.unavailable');
  } catch (_) {
    if (request === androidInfoRequest && !androidInfoPanel.classList.contains('hidden')) {
      setAndroidInformationStatus('android.unavailable');
    }
  }
}

const androidInfoClose = document.getElementById('android-info-close');
if (androidInfoClose) androidInfoClose.addEventListener('click', () => {
  hideAndroidInformation();
  const card = typeCardsEl && typeCardsEl.querySelector('[data-android-info]');
  if (card) card.focus();
});

function renderTypeCards() {
  if (!typeCardsEl) return;
  typeCardsEl.innerHTML = '';
  TYPE_GROUPS.forEach((g) => {
    const grp = document.createElement('div');
    grp.className = 'type-cards-group';
    const h = document.createElement('div');
    h.className = 'type-cards-group-title';
    h.textContent = t('content.type_group.' + g.key);
    grp.appendChild(h);
    const row = document.createElement('div');
    row.className = 'type-cards-row';
    g.types.forEach((type) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'type-card';
      card.dataset.type = type;
      card.innerHTML = '<span class="type-card-icon"></span><span class="type-card-name"></span><span class="type-card-desc"></span>';
      card.querySelector('.type-card-icon').textContent = TYPE_ICON[type] || '•';
      card.querySelector('.type-card-name').textContent = typeLabel(type);
      card.querySelector('.type-card-desc').textContent = typeDesc(type);
      card.addEventListener('click', () => {
        hideAndroidInformation();
        moduleType.value = type;
        showDynamicGroup(type);
        const first = document.querySelector('[data-dyn="' + type + '"] input:not([type=hidden]), [data-dyn="' + type + '"] textarea, [data-dyn="' + type + '"] select');
        if (first) { try { first.focus(); } catch (_) { /* noop */ } }
      });
      row.appendChild(card);
    });
    if (g.key === 'files') {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'type-card android-info-card';
      card.dataset.androidInfo = 'true';
      card.setAttribute('aria-controls', 'android-info-panel');
      card.setAttribute('aria-expanded', String(!!androidInfoPanel && !androidInfoPanel.classList.contains('hidden')));
      card.innerHTML = '<span class="type-card-icon" aria-hidden="true">🤖</span><span class="type-card-name"></span><span class="type-card-desc"></span>';
      card.querySelector('.type-card-name').textContent = t('android.card_title');
      card.querySelector('.type-card-desc').textContent = t('android.card_description');
      // Information only: no APK type is assigned and no project is changed.
      card.addEventListener('click', showAndroidInformation);
      row.appendChild(card);
    }
    grp.appendChild(row);
    typeCardsEl.appendChild(grp);
  });
}

function syncTypeUI(type) {
  if (!typeCardsEl) return;
  const chosen = !!type && TYPE_KEYS.includes(type);
  typeCardsEl.querySelectorAll('.type-card').forEach((c) => c.classList.toggle('active', c.dataset.type === type));
  typeCardsEl.classList.toggle('hidden', chosen);
  if (typePickHint) typePickHint.classList.toggle('hidden', chosen);
  if (typeChosenEl) typeChosenEl.classList.toggle('hidden', !chosen);
  if (typeChipEl) typeChipEl.textContent = chosen ? ((TYPE_ICON[type] || '') + ' ' + typeLabel(type)) : '';
  if (contentEditorSave) contentEditorSave.disabled = !chosen || !!contentMutation || !!projectTransition || settingsWrites.size > 0;
}

const typeChangeBtn = document.getElementById('type-change');
if (typeChangeBtn) typeChangeBtn.addEventListener('click', () => {
  // Volta a mostrar os cartões mantendo o tipo atual assinalado.
  typeCardsEl.classList.remove('hidden');
  if (typePickHint) typePickHint.classList.remove('hidden');
  typeChosenEl.classList.add('hidden');
});
renderTypeCards();

function setFileCurrentText(type, text, hasFile) {
  const el = dyn[type] && dyn[type].current;
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('has-file', !!hasFile);
  // Do not let a language refresh replace an actual filename with "No file".
  if (hasFile) el.removeAttribute('data-i18n');
  else el.setAttribute('data-i18n', 'content.file_none');
}

function clearEditor() {
  hideAndroidInformation();
  editorGeneration++;
  editorRevision++;
  iptvRequest++;
  pendingFilesByType.clear();
  editingId = null;
  pendingFileSourcePath = null;
  pendingFileName = null;
  pendingWebSourcePath = null;
  pendingPortableSourcePath = null;
  portableCandidates = [];
  portableSourceName = '';
  portableScanStats = null;
  portableOperation = null;
  setPortableStatus(null);
  dyn.portable.allowWine.checked = false;
  dyn['local-web'].includeDirectory.checked = false;
  dyn['local-web'].includeDirectory.disabled = false;
  dyn['local-web'].name.textContent = t('common.no_file_chosen');
  dyn['local-web'].name.setAttribute('data-i18n', 'common.no_file_chosen');
  dyn['local-web'].name.classList.remove('has-file');
  setFileCurrentText('local-web', t('content.file_none'), false);
  galleryItems = [];
  moduleTitle.value = '';
  moduleType.value = '';
  if (modulePassword) modulePassword.value = '';
  dyn.youtube.url.value = '';
  dyn.html.code.value = '';
  dyn.webview.url.value = '';
  dyn.external.url.value = '';
  dyn.pdf.file.value = '';
  dyn.launch.file.value = '';
  if (dyn['local-video'].file) dyn['local-video'].file.value = '';
  if (dyn['local-audio'].file) dyn['local-audio'].file.value = '';
  if (dyn['download-vault'].file) dyn['download-vault'].file.value = '';
  if (dyn['download-vault'].btn) dyn['download-vault'].btn.value = '';
  if (dyn['article-reader'].text) dyn['article-reader'].text.value = '';
  if (dyn['smart-embed'].url) dyn['smart-embed'].url.value = '';
  iptvChannels = [];
  iptvManual = [];
  iptvM3uPath = null;
  if (dyn.iptv.source) dyn.iptv.source.value = 'xtream';
  if (dyn.iptv.load) dyn.iptv.load.disabled = false;
  if (dyn.iptv.xtreamUrl) dyn.iptv.xtreamUrl.value = '';
  if (dyn.iptv.xtreamUser) dyn.iptv.xtreamUser.value = '';
  if (dyn.iptv.xtreamPass) dyn.iptv.xtreamPass.value = '';
  if (dyn.iptv.m3u8Url) dyn.iptv.m3u8Url.value = '';
  if (dyn.iptv.m3uName) dyn.iptv.m3uName.textContent = t('common.no_file_chosen');
  renderIptvManualList();
  updateIptvSourceUI();
  setIptvStatus(t('content.iptv.no_channels'), '');
  ['pdf', 'launch', 'local-video', 'local-audio', 'download-vault'].forEach((k) => {
    setFileCurrentText(k, t('content.file_none'), false);
  });
  // Reset visible filename labels for the dynamic file pickers — otherwise
  // the previous module's name would linger when reopening / editing.
  ['pdf', 'launch', 'local-video', 'local-audio', 'download-vault'].forEach((k) => {
    if (dyn[k] && dyn[k].file) setFileNameForInput(dyn[k].file, null);
  });
  renderGalleryList();
  showDynamicGroup('');
  renderPortableEditor({ windows: null, mac: null });
}

function hideEditor() {
  clearEditor();
  contentForm.classList.add('hidden');
  contentEditorEmpty.classList.remove('hidden');
  // Clear active highlight in list
  contentList.querySelectorAll('.content-list-item.active').forEach((el) => el.classList.remove('active'));
}

function openEditorForNew() {
  clearEditor();
  contentEditorTitle.textContent = t('content.editor_new_title');
  contentEditorEmpty.classList.add('hidden');
  contentForm.classList.remove('hidden');
  moduleTitle.focus();
  contentList.querySelectorAll('.content-list-item.active').forEach((el) => el.classList.remove('active'));
}

function openEditorForEdit(id) {
  const mod = contentModules.find((m) => m.id === id);
  if (!mod) return;
  clearEditor();
  editingId = mod.id;
  contentEditorTitle.textContent = t('content.editor_edit_title');
  contentEditorEmpty.classList.add('hidden');
  contentForm.classList.remove('hidden');

  moduleTitle.value = mod.title || '';
  moduleType.value = mod.type;
  if (modulePassword) modulePassword.value = mod.password || '';
  showDynamicGroup(mod.type);

  const d = mod.data || {};
  if (mod.type === 'youtube') dyn.youtube.url.value = d.url || '';
  else if (mod.type === 'html') dyn.html.code.value = d.html || '';
  else if (mod.type === 'local-web') {
    if (d.root && d.entry) {
      setFileCurrentText('local-web', t('content.file_current_prefix') + (d.fileName || d.entry), true);
      // The stored copy is immutable until the author chooses a new source.
      dyn['local-web'].includeDirectory.disabled = true;
    }
  }
  else if (mod.type === 'portable') {
    portableCandidates = (Array.isArray(d.candidates) ? d.candidates : [])
      .filter((item) => item && typeof item.path === 'string' && ['windows', 'mac'].includes(item.platform));
    portableSourceName = d.sourceName || '';
    dyn.portable.allowWine.checked = !!d.allowWine;
    renderPortableEditor(d.entries || { windows: null, mac: null });
  }
  else if (mod.type === 'webview') dyn.webview.url.value = d.url || '';
  else if (mod.type === 'external') dyn.external.url.value = d.url || '';
  else if (mod.type === 'smart-embed') dyn['smart-embed'].url.value = d.url || '';
  else if (mod.type === 'article-reader') dyn['article-reader'].text.value = d.text || '';
  else if (mod.type === 'image-gallery') {
    galleryItems = (Array.isArray(d.images) ? d.images : []).map((i) => ({
      kind: 'existing', file: i.file, fileName: i.fileName
    }));
    renderGalleryList();
  } else if (mod.type === 'pdf' || mod.type === 'launch'
             || mod.type === 'local-video' || mod.type === 'local-audio'
             || mod.type === 'download-vault') {
    if (d.file) {
      setFileCurrentText(mod.type, t('content.file_current_prefix') + (d.fileName || d.file), true);
    } else {
      setFileCurrentText(mod.type, t('content.file_none'), false);
    }
    if (mod.type === 'download-vault') dyn['download-vault'].btn.value = d.buttonLabel || '';
  } else if (mod.type === 'iptv') {
    const src = ['xtream', 'm3u8', 'm3u', 'manual'].includes(d.source) ? d.source : 'manual';
    dyn.iptv.source.value = src;
    const chans = Array.isArray(d.channels) ? d.channels : [];
    if (src === 'manual') {
      iptvManual = chans.map((c) => ({ name: c.name || '', url: c.url || '' }));
      iptvChannels = [];
    } else {
      iptvChannels = chans.slice();
      iptvManual = [];
      if (src === 'xtream') {
        dyn.iptv.xtreamUrl.value = d.xtreamUrl || '';
        dyn.iptv.xtreamUser.value = d.xtreamUser || '';
        dyn.iptv.xtreamPass.value = d.xtreamPass || '';
      } else if (src === 'm3u8') {
        dyn.iptv.m3u8Url.value = d.playlistUrl || '';
      }
    }
    renderIptvManualList();
    updateIptvSourceUI();
    const total = (src === 'manual') ? iptvManual.length : iptvChannels.length;
    setIptvStatus(total > 0
      ? t('content.iptv.loaded_count').replace('{count}', String(total))
      : t('content.iptv.no_channels'), total > 0 ? 'success' : '');
  }

  // Highlight active item
  contentList.querySelectorAll('.content-list-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === id);
  });
}

function renderContentList() {
  contentList.innerHTML = '';
  if (contentModules.length === 0) {
    contentListEmpty.classList.remove('hidden');
    return;
  }
  contentListEmpty.classList.add('hidden');

  contentModules.forEach((mod, index) => {
    const li = document.createElement('li');
    li.className = 'content-list-item';
    if (mod.id === editingId) li.classList.add('active');
    li.dataset.id = mod.id;

    const info = document.createElement('div');
    info.className = 'content-item-info';
    info.title = t('content.click_to_edit');
    info.innerHTML = `
      <span class="content-item-title"></span>
      <span class="content-item-type"></span>
    `;
    info.querySelector('.content-item-title').textContent = mod.title;
    info.querySelector('.content-item-type').textContent = (TYPE_ICON[mod.type] ? TYPE_ICON[mod.type] + ' ' : '') + typeLabel(mod.type);
    info.addEventListener('click', () => openEditorForEdit(mod.id));

    const actions = document.createElement('div');
    actions.className = 'content-item-actions';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'icon-btn';
    upBtn.title = t('content.btn_up');
    upBtn.textContent = '▲';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => moveModule(mod.id, -1));

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'icon-btn';
    downBtn.title = t('content.btn_down');
    downBtn.textContent = '▼';
    downBtn.disabled = index === contentModules.length - 1;
    downBtn.addEventListener('click', () => moveModule(mod.id, 1));

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'icon-btn';
    editBtn.title = t('content.btn_edit');
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', () => openEditorForEdit(mod.id));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'icon-btn danger';
    delBtn.title = t('content.btn_delete');
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => askDeleteModule(li, mod));

    actions.append(upBtn, downBtn, editBtn, delBtn);
    li.append(info, actions);
    contentList.append(li);
  });
}

async function persistContent(successMessage, proposedModules = contentModules) {
  if (contentMutation || projectTransition || settingsWrites.size > 0 || exportInProgress) return false;
  const operation = { generation: projectGeneration };
  contentMutation = operation;
  updateBuilderBusyUI();
  const payload = {
    modules: proposedModules.map((m) => ({ id: m.id, title: m.title, type: m.type,
      data: m.data || {}, password: m.password || '' }))
  };
  try {
    const updated = await window.icurator.saveContent(payload);
    if (operation.generation !== projectGeneration) return false;
    contentModules = Array.isArray(updated.content) ? updated.content : [];
    // A reorder/delete must not consume a file selected in a different draft.
    renderContentList();
    updateExportSummary(updated);
    if (successMessage) showContentStatus(successMessage, 'success');
    return true;
  } finally {
    if (contentMutation === operation) {
      contentMutation = null;
      updateBuilderBusyUI();
      updatePortableActions();
    }
  }
}

async function moveModule(id, delta) {
  if (contentMutation || projectTransition || settingsWrites.size > 0) return;
  const idx = contentModules.findIndex((m) => m.id === id);
  const newIdx = idx + delta;
  if (idx < 0 || newIdx < 0 || newIdx >= contentModules.length) return;
  const proposed = contentModules.slice();
  const [item] = proposed.splice(idx, 1);
  proposed.splice(newIdx, 0, item);
  const generation = projectGeneration;
  try {
    await persistContent(t('content.order_updated'), proposed);
  } catch (err) {
    if (generation !== projectGeneration) return;
    console.error(err);
    showContentStatus(t('content.reorder_error_prefix') + err.message, 'error');
  }
}

function askDeleteModule(li, mod) {
  const actions = li.querySelector('.content-item-actions');
  if (!actions || actions.querySelector('.content-delete-confirm')) return;
  actions.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'content-delete-confirm';
  const label = document.createElement('span');
  label.textContent = t('content.delete_confirm').replace('{title}', mod.title);
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'btn btn-sm btn-danger';
  yes.textContent = t('projects.delete_yes');
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'btn btn-sm btn-ghost';
  no.textContent = t('common.cancel');
  no.addEventListener('click', renderContentList);
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    no.disabled = true;
    await deleteModule(mod.id);
  });
  wrap.append(label, yes, no);
  actions.appendChild(wrap);
  no.focus();
}

async function deleteModule(id) {
  if (contentMutation || projectTransition || settingsWrites.size > 0) return;
  if (!contentModules.some((mod) => mod.id === id)) return;
  const generation = projectGeneration;
  const proposed = contentModules.filter((mod) => mod.id !== id);
  try {
    const applied = await persistContent(t('content.module_deleted'), proposed);
    if (applied && editingId === id) hideEditor();
  } catch (err) {
    if (generation !== projectGeneration) return;
    // The saved list and the open draft stay intact until deletion succeeds.
    renderContentList();
    console.error(err);
    showContentStatus(t('content.delete_error_prefix') + err.message, 'error');
  }
}

/* ---- Editor wiring ---- */

contentAddBtn.addEventListener('click', () => openEditorForNew());
contentEditorClose.addEventListener('click', () => hideEditor());
contentEditorCancel.addEventListener('click', () => hideEditor());
contentForm.addEventListener('input', () => { editorRevision++; });
contentForm.addEventListener('change', () => { editorRevision++; });

moduleType.addEventListener('change', () => {
  showDynamicGroup(moduleType.value);
});

dyn.portable.pick.addEventListener('click', async () => {
  if (portableOperation || moduleType.value !== 'portable') return;
  const operation = { generation: editorGeneration };
  portableOperation = operation;
  setPortableStatus('scanning');
  updatePortableActions();
  try {
    const picked = await window.icurator.pickPortableFolder();
    if (operation.generation !== editorGeneration || moduleType.value !== 'portable') return;
    if (!picked) { setPortableStatus(null); return; }
    if (typeof picked.sourcePath !== 'string' || !Array.isArray(picked.candidates)) throw new Error(t('portable.pick_first'));
    const candidates = picked.candidates.filter((item) => item && typeof item.path === 'string'
      && ['windows', 'mac'].includes(item.platform));
    if (!candidates.length) { setPortableStatus('no_candidates', 'error'); return; }
    editorRevision++;
    pendingPortableSourcePath = picked.sourcePath;
    portableCandidates = candidates;
    portableSourceName = picked.sourceName || '';
    const files = Array.isArray(picked.files) ? picked.files.length : Number(picked.files);
    const bytes = Number(picked.bytes);
    portableScanStats = Number.isFinite(files) && Number.isFinite(bytes) ? { files, bytes } : null;
    dyn.portable.allowWine.checked = false;
    setPortableStatus(null);
    renderPortableEditor({
      windows: suggestPortableEntry('windows', candidates, portableSourceName),
      mac: suggestPortableEntry('mac', candidates, portableSourceName)
    });
  } catch (err) {
    if (operation.generation === editorGeneration) {
      dyn.portable.status.textContent = t('common.error_prefix') + (err && err.message ? err.message : String(err));
      dyn.portable.status.className = 'portable-status error';
      portableStatus = null;
    }
  } finally {
    if (portableOperation === operation) { portableOperation = null; updatePortableActions(); }
  }
});

for (const input of [dyn.portable.windows, dyn.portable.mac, dyn.portable.allowWine]) {
  input.addEventListener('change', () => {
    if (!dyn.portable.windows.value) dyn.portable.allowWine.checked = false;
    setPortableStatus(null);
    updatePortableActions();
  });
}

dyn.portable.test.addEventListener('click', async () => {
  if (portableOperation || !portableHasSavedSelection() || moduleType.value !== 'portable') return;
  const operation = { generation: editorGeneration };
  const id = editingId;
  portableOperation = operation;
  setPortableStatus('viewer_launching');
  updatePortableActions();
  try {
    const result = await window.icurator.launchPortable(id);
    if (operation.generation !== editorGeneration || editingId !== id) return;
    if (!result || result.ok !== true) throw new Error(t('portable.viewer_invalid_result'));
    setPortableStatus(result.via === 'wine' ? 'viewer_started_wine' : 'viewer_started', 'success');
  } catch (err) {
    if (operation.generation === editorGeneration) {
      setPortableStatus('viewer_launch_error', 'error', err && err.message ? err.message : String(err));
    }
  } finally {
    if (portableOperation === operation) { portableOperation = null; updatePortableActions(); }
  }
});

dyn.portable.configureWine.addEventListener('click', async () => {
  if (portableOperation || portableHostPlatform !== 'darwin') return;
  const operation = { generation: editorGeneration };
  portableOperation = operation;
  setPortableStatus('viewer_configuring_wine');
  updatePortableActions();
  try {
    const result = await window.icurator.configurePortableWine();
    if (operation.generation !== editorGeneration) return;
    setPortableStatus(result && result.configured ? 'wine_ready' : null, result && result.configured ? 'success' : '');
  } catch (err) {
    if (operation.generation === editorGeneration) {
      setPortableStatus('viewer_config_error', 'error', err && err.message ? err.message : String(err));
    }
  } finally {
    if (portableOperation === operation) { portableOperation = null; updatePortableActions(); }
  }
});

const FILE_PICK_CATEGORY = {
  pdf: 'pdf',
  launch: 'launch',
  'local-video': 'video',
  'local-audio': 'audio',
  'download-vault': 'download'
};

async function pickForCurrentEditor(pick, type) {
  const generation = editorGeneration;
  const project = projectGeneration;
  try {
    const result = await pick();
    return generation === editorGeneration && project === projectGeneration && moduleType.value === type ? result : null;
  } catch (err) {
    if (generation === editorGeneration && project === projectGeneration) showContentStatus(t('common.error_prefix') + err.message, 'error');
    return null;
  }
}

function bindFilePicker(type) {
  const input = dyn[type].file;
  const label = document.querySelector('label[for="' + input.id + '"]');
  const category = FILE_PICK_CATEGORY[type] || 'launch';
  if (label) label.addEventListener('click', async (e) => {
    e.preventDefault();
    const picked = await pickForCurrentEditor(() => window.icurator.pickFile(category), type);
    if (!picked) return;
    pendingFileSourcePath = picked.path;
    pendingFileName = picked.name;
    pendingFilesByType.set(type, { path: picked.path, name: picked.name });
    editorRevision++;
    setFileNameForInput(input, picked.name);
    setFileCurrentText(type, t('content.file_new_prefix') + (pendingFileName || pendingFileSourcePath), true);
  });
}
bindFilePicker('pdf');
bindFilePicker('launch');
bindFilePicker('local-video');
bindFilePicker('local-audio');
bindFilePicker('download-vault');

dyn['local-web'].pick.addEventListener('click', async () => {
  const generation = editorGeneration;
  try {
    const picked = await window.icurator.pickFile('web');
    if (!picked || generation !== editorGeneration) return;
    if (!/\.(html?|php)$/i.test(picked.name)) {
      showContentStatus(t('content.local_web.invalid_file'), 'error');
      return;
    }
    editorRevision++;
    pendingWebSourcePath = picked.path;
    dyn['local-web'].name.textContent = picked.name;
    dyn['local-web'].name.removeAttribute('data-i18n');
    dyn['local-web'].name.classList.add('has-file');
    dyn['local-web'].includeDirectory.disabled = false;
    setFileCurrentText('local-web', t('content.file_new_prefix') + picked.name, true);
  } catch (err) {
    if (generation === editorGeneration) showContentStatus(t('common.error_prefix') + err.message, 'error');
  }
});

/* ---- Image gallery editor ---- */
function renderGalleryList() {
  const list = dyn['image-gallery'].list;
  if (!list) return;
  list.innerHTML = '';
  if (galleryItems.length === 0) {
    const li = document.createElement('li');
    li.className = 'gallery-list-empty';
    li.textContent = t('content.gallery_empty', 'Nenhuma imagem adicionada.');
    list.appendChild(li);
    return;
  }
  galleryItems.forEach((it, idx) => {
    const li = document.createElement('li');
    li.className = 'gallery-list-item';
    const name = document.createElement('span');
    name.className = 'gallery-item-name';
    name.textContent = it.fileName || it.name || '(imagem)';
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'icon-btn danger';
    rm.textContent = '✕';
    rm.title = t('content.btn_delete');
    rm.addEventListener('click', () => { editorRevision++; galleryItems.splice(idx, 1); renderGalleryList(); });
    li.append(name, rm);
    list.appendChild(li);
  });
}

if (dyn['image-gallery'].addBtn) {
  dyn['image-gallery'].addBtn.addEventListener('click', async () => {
    const picked = await pickForCurrentEditor(() => window.icurator.pickFiles('image'), 'image-gallery');
    if (!Array.isArray(picked) || picked.length === 0) return;
    editorRevision++;
    for (const p of picked) galleryItems.push({ kind: 'new', path: p.path, name: p.name });
    renderGalleryList();
  });
}

/* ---- IPTV editor ---- */
function setIptvStatus(text, kind) {
  const el = dyn.iptv.status;
  if (!el) return;
  el.textContent = text;
  el.classList.remove('has-file', 'is-error');
  if (kind === 'success') el.classList.add('has-file');
  else if (kind === 'error') el.classList.add('is-error');
}

function updateIptvSourceUI() {
  const src = dyn.iptv.source ? dyn.iptv.source.value : 'xtream';
  document.querySelectorAll('#dyn-iptv [data-iptv-src]').forEach((g) => {
    g.classList.toggle('hidden', g.dataset.iptvSrc !== src);
  });
  // O botão "Carregar canais" não se aplica ao modo manual.
  if (dyn.iptv.loadRow) dyn.iptv.loadRow.classList.toggle('hidden', src === 'manual');
}

function renderIptvManualList() {
  const list = dyn.iptv.manualList;
  if (!list) return;
  list.innerHTML = '';
  if (iptvManual.length === 0) {
    const li = document.createElement('li');
    li.className = 'iptv-manual-empty';
    li.textContent = t('content.iptv.manual_empty', 'Nenhum canal adicionado.');
    list.appendChild(li);
    return;
  }
  iptvManual.forEach((row, idx) => {
    const li = document.createElement('li');
    li.className = 'iptv-manual-item';
    const nameIn = document.createElement('input');
    nameIn.type = 'text';
    nameIn.className = 'iptv-manual-name';
    nameIn.value = row.name || '';
    nameIn.placeholder = t('content.iptv.manual_name_ph', 'Nome do canal');
    nameIn.addEventListener('input', () => { iptvManual[idx].name = nameIn.value; });
    const urlIn = document.createElement('input');
    urlIn.type = 'text';
    urlIn.className = 'iptv-manual-url';
    urlIn.value = row.url || '';
    urlIn.placeholder = t('content.iptv.manual_url_ph', 'Ligação do canal (.m3u8)');
    urlIn.addEventListener('input', () => { iptvManual[idx].url = urlIn.value; });
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'icon-btn danger';
    rm.textContent = '✕';
    rm.title = t('content.iptv.manual_remove', 'Remover');
    rm.addEventListener('click', () => { editorRevision++; iptvManual.splice(idx, 1); renderIptvManualList(); });
    li.append(nameIn, urlIn, rm);
    list.appendChild(li);
  });
}

function invalidateIptvChannels() {
  iptvRequest++;
  iptvChannels = [];
  dyn.iptv.load.disabled = false;
  setIptvStatus(t('content.iptv.no_channels'), '');
}
for (const input of [dyn.iptv.xtreamUrl, dyn.iptv.xtreamUser, dyn.iptv.xtreamPass, dyn.iptv.m3u8Url]) {
  input.addEventListener('input', invalidateIptvChannels);
}

if (dyn.iptv.source) {
  dyn.iptv.source.addEventListener('change', () => { invalidateIptvChannels(); updateIptvSourceUI(); });
}
if (dyn.iptv.manualAdd) {
  dyn.iptv.manualAdd.addEventListener('click', () => {
    editorRevision++;
    iptvManual.push({ name: '', url: '' });
    renderIptvManualList();
  });
}
if (dyn.iptv.m3uPick) {
  dyn.iptv.m3uPick.addEventListener('click', async () => {
    const picked = await pickForCurrentEditor(() => window.icurator.pickFile('playlist'), 'iptv');
    if (!picked) return;
    invalidateIptvChannels();
    editorRevision++;
    iptvM3uPath = picked.path;
    if (dyn.iptv.m3uName) dyn.iptv.m3uName.textContent = picked.name;
  });
}
if (dyn.iptv.load) {
  dyn.iptv.load.addEventListener('click', async () => {
    const source = dyn.iptv.source.value;
    const payload = { source };
    if (source === 'xtream') {
      payload.xtream = {
        url: dyn.iptv.xtreamUrl.value.trim(),
        username: dyn.iptv.xtreamUser.value.trim(),
        password: dyn.iptv.xtreamPass.value.trim()
      };
      if (!payload.xtream.url || !payload.xtream.username || !payload.xtream.password) {
        setIptvStatus(t('content.iptv.xtream_missing', 'Preencha URL, utilizador e palavra-passe.'), 'error');
        return;
      }
    } else if (source === 'm3u8') {
      payload.playlistUrl = dyn.iptv.m3u8Url.value.trim();
      if (!payload.playlistUrl) {
        setIptvStatus(t('content.iptv.m3u8_missing', 'Introduza a ligação .m3u8.'), 'error');
        return;
      }
    } else if (source === 'm3u') {
      if (!iptvM3uPath) {
        setIptvStatus(t('content.iptv.pick_file_first', 'Escolha primeiro um ficheiro .m3u.'), 'error');
        return;
      }
      payload.filePath = iptvM3uPath;
    } else {
      return;
    }
    const generation = editorGeneration;
    const request = ++iptvRequest;
    dyn.iptv.load.disabled = true;
    setIptvStatus(t('content.iptv.loading', 'A carregar canais…'), '');
    try {
      const res = await window.icurator.iptvLoad(payload);
      if (generation !== editorGeneration || request !== iptvRequest) return;
      editorRevision++;
      if (res && res.ok) {
        iptvChannels = Array.isArray(res.channels) ? res.channels : [];
        setIptvStatus(t('content.iptv.loaded_count').replace('{count}', String(res.count || iptvChannels.length)), 'success');
      } else {
        iptvChannels = [];
        setIptvStatus((res && res.error) ? res.error : t('content.iptv.load_error', 'Não foi possível carregar os canais.'), 'error');
      }
    } catch (err) {
      if (generation !== editorGeneration || request !== iptvRequest) return;
      iptvChannels = [];
      setIptvStatus(t('content.iptv.load_error', 'Não foi possível carregar os canais.') + ' ' + (err && err.message ? err.message : ''), 'error');
    } finally {
      if (generation === editorGeneration && request === iptvRequest) dyn.iptv.load.disabled = false;
    }
  });
}

contentForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const title = moduleTitle.value.trim();
  const type = moduleType.value;
  const password = modulePassword ? modulePassword.value.trim() : '';
  if (!title) { moduleTitle.focus(); return; }
  if (!TYPE_KEYS.includes(type)) return;
  if (contentMutation || projectTransition || settingsWrites.size > 0 || exportInProgress
      || (type === 'portable' && portableOperation)) return;

  // Build the data object for this module
  let data = {};
  if (type === 'youtube') data = { url: dyn.youtube.url.value.trim() };
  else if (type === 'html') data = { html: dyn.html.code.value };
  else if (type === 'local-web') {
    if (pendingWebSourcePath) {
      data = { sourcePath: pendingWebSourcePath, includeDirectory: dyn['local-web'].includeDirectory.checked };
    } else {
      const existing = contentModules.find((m) => m.id === editingId && m.type === 'local-web');
      if (!existing || !existing.data || !existing.data.root || !existing.data.entry) {
        showContentStatus(t('content.local_web.pick_first'), 'error');
        return;
      }
      data = { ...existing.data };
    }
  }
  else if (type === 'portable') {
    try { data = portableDataForSave(); }
    catch (err) { showContentStatus(err.message, 'error'); return; }
  }
  else if (type === 'webview') data = { url: dyn.webview.url.value.trim() };
  else if (type === 'external') data = { url: dyn.external.url.value.trim() };
  else if (type === 'smart-embed') data = { url: dyn['smart-embed'].url.value.trim() };
  else if (type === 'article-reader') data = { text: dyn['article-reader'].text.value };
  else if (type === 'iptv') {
    const source = dyn.iptv.source.value;
    const out = { source };
    if (source === 'manual') {
      out.channels = iptvManual
        .map((r) => ({ name: (r.name || '').trim(), url: (r.url || '').trim(), logo: '', group: '' }))
        .filter((c) => c.url);
    } else {
      out.channels = iptvChannels;
      if (source === 'xtream') {
        out.xtreamUrl = dyn.iptv.xtreamUrl.value.trim();
        out.xtreamUser = dyn.iptv.xtreamUser.value.trim();
        out.xtreamPass = dyn.iptv.xtreamPass.value.trim();
      } else if (source === 'm3u8') {
        out.playlistUrl = dyn.iptv.m3u8Url.value.trim();
      }
    }
    data = out;
  }
  else if (type === 'image-gallery') {
    data = {
      items: galleryItems.map((it) => it.kind === 'new'
        ? { sourcePath: it.path, fileName: it.name }
        : { file: it.file, fileName: it.fileName })
    };
  } else if (type === 'pdf' || type === 'launch'
             || type === 'local-video' || type === 'local-audio'
             || type === 'download-vault') {
    if (pendingFileSourcePath) {
      data = { sourcePath: pendingFileSourcePath };
    } else {
      // Keep whatever was there (main.js falls back to previous file when no sourcePath)
      data = {};
    }
    if (type === 'download-vault') data.buttonLabel = dyn['download-vault'].btn.value.trim();
  }

  const generation = editorGeneration;
  const revision = editorRevision;
  const currentProject = projectGeneration;
  const savedId = editingId || uuid();
  const module = { id: savedId, title, type, data, password };
  const proposed = contentModules.some((item) => item.id === savedId)
    ? contentModules.map((item) => item.id === savedId ? module : item)
    : [...contentModules, module];
  try {
    const applied = await persistContent(t('content.module_saved'), proposed);
    if (!applied || currentProject !== projectGeneration || generation !== editorGeneration) return;
    // A newer password, title or other draft input must survive a slow save.
    editingId = savedId;
    if (revision !== editorRevision) { renderContentList(); updatePortableActions(); return; }
    hideEditor();
    openEditorForEdit(savedId);
  } catch (err) {
    if (currentProject !== projectGeneration) return;
    console.error(err);
    showContentStatus(t('common.error_prefix') + err.message, 'error');
  }
});

/* =========================================================
 * Initial load
 * ========================================================= */
async function applyConfig(config) {
  editorGeneration++;
  iptvRequest++;
  portableOperation = null;
  {
    // --- Brand
    const brand = config.brand || {};
    titleInput.value = brand.title || '';
    colorInputs.sidebar.value = (brand.colors && brand.colors.sidebar) || '#111827';
    colorInputs.background.value = (brand.colors && brand.colors.background) || '#f8fafc';
    colorInputs.buttons.value = (brand.colors && brand.colors.buttons) || '#2563eb';
    Object.keys(colorInputs).forEach((k) => {
      colorHexLabels[k].textContent = colorInputs[k].value.toUpperCase();
    });
    brandState.currentLogoRelative = brand.logo || null;
    // BUG CORRIGIDO: ao mudar de projeto, um logo escolhido (mas não gravado)
    // no projeto anterior ficava pendente e era gravado no projeto novo.
    brandState.pendingLogoSourcePath = null;
    brandState.pendingRemoveLogo = false;
    setFileNameForInput(logoInput, null);
    if (brandState.currentLogoRelative) {
      const abs = await window.icurator.resolveAssetPath(brandState.currentLogoRelative);
      setImagePreview(logoPreview, logoEmpty, abs);
    } else {
      setImagePreview(logoPreview, logoEmpty, null);
    }

    // --- Leads
    const leads = (config.marketing && config.marketing.leads) || {};
    leadsEnabled.checked = !!leads.enabled;
    leadsHeading.value = leads.heading || '';
    leadsHtml.value = leads.formHtml || '';

    // --- Banners (topo + rodapé, independentes)
    const banners = (config.marketing && config.marketing.banners) || {};
    await bannerTopSlot.load(banners.top);
    await bannerBottomSlot.load(banners.bottom);

    // --- Redes sociais
    fillSocialInputs(config.marketing && config.marketing.social);

    // Secções opcionais: abertas só quando já têm alguma coisa configurada.
    const soc = (config.marketing && config.marketing.social) || {};
    setSectionCollapsed('social', !Object.keys(soc).some((k) => soc[k]));
    const bn = (config.marketing && config.marketing.banners) || {};
    setSectionCollapsed('banners', !((bn.top && (bn.top.enabled || bn.top.image)) || (bn.bottom && (bn.bottom.enabled || bn.bottom.image))));
    setSectionCollapsed('leads', !(leads.enabled || (leads.formHtml && leads.formHtml.trim())));

    // --- Content / menus
    contentModules = Array.isArray(config.content) ? config.content : [];
    // Fecha o editor de módulo: um módulo a meio de edição no projeto anterior
    // (editingId/ficheiro pendente) não pode "vazar" para o projeto aberto agora.
    hideEditor();
    renderContentList();

    // --- Export (Passo 5) + Ícone (Passo 6)
    updateExportSummary(config);
    await loadIconState(config);

    // --- i18n: apply saved language (do NOT persist again — it's already saved).
    const savedLang = config.language || 'pt';
    await setLanguage(savedLang, { persist: false });
    // Re-render the export summary + icon status so labels respect the new language.
    updateExportSummary(config);
    setIconCurrentText();
  }
}

async function loadInitialConfig() {
  if (!beginProjectTransition()) return;
  try {
    await loadExportTargets();
    const config = await window.icurator.loadConfig();
    await applyConfig(config);
    await refreshProjects();
  } catch (err) {
    console.error('Falha ao carregar configuração inicial:', err);
  } finally { endProjectTransition(); }
}

/* =========================================================
 * GESTOR DE PROJETOS
 * Cada projeto tem config + assets isolados no processo principal.
 * "Abrir" carrega o projeto e salta para Marca/Design; "Fechar" volta
 * a este separador. Criar/Renomear/Apagar via IPC.
 * ========================================================= */
const projectsListEl = document.getElementById('projects-list');
const projectNewForm = document.getElementById('project-new-form');
const projectNewName = document.getElementById('project-new-name');
const showProjectsStatus = makeStatus(document.getElementById('projects-status'));
const activeProjectName = document.getElementById('active-project-name');
const activeProjectCloseBtn = document.getElementById('active-project-close');

let projectsCache = { activeId: null, projects: [] };

function beginProjectTransition() {
  if (projectTransition || contentMutation || settingsWrites.size > 0 || exportInProgress) return false;
  projectTransition = {};
  projectGeneration++;
  editorGeneration++;
  iptvRequest++;
  portableOperation = null;
  updateBuilderBusyUI();
  return true;
}

function endProjectTransition() {
  projectTransition = null;
  updateBuilderBusyUI();
  updatePortableActions();
}

function activeProjectLabel() {
  const p = projectsCache.projects.find((x) => x.id === projectsCache.activeId);
  return p ? p.name : '—';
}

function updateActiveProjectBar() {
  if (activeProjectName) activeProjectName.textContent = activeProjectLabel();
}

function goToTab(target) {
  const tab = document.querySelector('.tab[data-tab="' + target + '"]');
  if (tab) tab.click();
}

function renderProjectsList() {
  if (!projectsListEl) return;
  projectsListEl.innerHTML = '';
  projectsCache.projects.forEach((p) => {
    const isActive = p.id === projectsCache.activeId;
    const li = document.createElement('li');
    li.className = 'project-item' + (isActive ? ' active' : '');

    const info = document.createElement('div');
    info.className = 'project-info';
    const nameEl = document.createElement('span');
    nameEl.className = 'project-name';
    nameEl.textContent = p.name;
    info.appendChild(nameEl);
    if (isActive) {
      const badge = document.createElement('span');
      badge.className = 'project-badge';
      badge.textContent = t('projects.open_badge');
      info.appendChild(badge);
    }

    const actions = document.createElement('div');
    actions.className = 'project-actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn btn-sm ' + (isActive ? 'btn-ghost' : 'btn-primary');
    openBtn.textContent = isActive ? t('projects.reopen_btn') : t('projects.open_btn');
    openBtn.addEventListener('click', () => openProject(p.id));

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'btn btn-sm btn-ghost';
    renameBtn.textContent = t('projects.rename_btn');
    renameBtn.addEventListener('click', () => startRename(li, p));

    const cloneBtn = document.createElement('button');
    cloneBtn.type = 'button';
    cloneBtn.className = 'btn btn-sm btn-ghost';
    cloneBtn.textContent = t('projects.clone_btn');
    cloneBtn.addEventListener('click', () => duplicateProject(p.id));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = t('projects.delete_btn');
    delBtn.addEventListener('click', () => askDeleteProject(li, p));

    actions.append(openBtn, renameBtn, cloneBtn, delBtn);
    li.append(info, actions);
    projectsListEl.appendChild(li);
  });
  updateActiveProjectBar();
}

async function refreshProjects() {
  const generation = projectGeneration;
  try {
    const state = await window.icurator.projectsList();
    if (generation !== projectGeneration) return;
    projectsCache = state;
    renderProjectsList();
  } catch (err) {
    console.error('Falha a listar projetos:', err);
  }
}

async function openProject(id) {
  if (projectTransition) return;
  if (id === projectsCache.activeId) { goToTab('content'); return; }
  if (!beginProjectTransition()) return;
  try {
    const res = await window.icurator.projectsOpen(id);
    projectsCache = res.state;
    if (res.config) await applyConfig(res.config);
    renderProjectsList();
    goToTab('content');
  } catch (err) {
    console.error('Falha a abrir projeto:', err);
    showProjectsStatus(t('common.error_prefix') + err.message, 'error');
  } finally { endProjectTransition(); }
}

function startRename(li, project) {
  if (li.querySelector('.project-rename')) return;
  const info = li.querySelector('.project-info');
  const nameEl = li.querySelector('.project-name');
  const wrap = document.createElement('div');
  wrap.className = 'project-rename';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 80;
  input.value = project.name;
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn btn-sm btn-primary';
  save.textContent = t('common.save');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-sm btn-ghost';
  cancel.textContent = t('common.cancel');
  wrap.append(input, save, cancel);
  nameEl.replaceWith(wrap);
  input.focus();
  input.select();

  const commit = async () => {
    const newName = input.value.trim();
    if (!newName || newName === project.name) { renderProjectsList(); return; }
    if (!beginProjectTransition()) return;
    try {
      projectsCache = await window.icurator.projectsRename(project.id, newName);
      renderProjectsList();
      updateActiveProjectBar();
      showProjectsStatus(t('projects.renamed_ok'), 'success');
    } catch (err) {
      console.error('Falha a renomear projeto:', err);
      showProjectsStatus(t('common.error_prefix') + err.message, 'error');
      renderProjectsList();
    } finally { endProjectTransition(); }
  };
  save.addEventListener('click', commit);
  cancel.addEventListener('click', () => renderProjectsList());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); renderProjectsList(); }
  });
}

/* O Electron bloqueia window.confirm() nos renderers (fica sem efeito), por
 * isso a confirmação de apagar é feita inline — botões "Sim" / "Cancelar"
 * dentro da própria linha do projeto, como no resto da app. Era esta a causa
 * de "não apagar": o confirm() nunca devolvia true. */
function askDeleteProject(li, project) {
  const actions = li.querySelector('.project-actions');
  if (!actions || actions.querySelector('.project-del-confirm')) return;
  actions.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'project-del-confirm';
  const label = document.createElement('span');
  label.className = 'project-del-label';
  label.textContent = t('projects.delete_confirm').replace('{name}', project.name);
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'btn btn-sm btn-danger';
  yes.textContent = t('projects.delete_yes');
  yes.addEventListener('click', () => performDeleteProject(project));
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'btn btn-sm btn-ghost';
  no.textContent = t('common.cancel');
  no.addEventListener('click', () => renderProjectsList());
  wrap.append(label, yes, no);
  actions.appendChild(wrap);
}

async function performDeleteProject(project) {
  if (!beginProjectTransition()) return;
  try {
    const res = await window.icurator.projectsDelete(project.id);
    projectsCache = res.state;
    // Atualiza a lista PRIMEIRO: assim a linha do projeto apagado desaparece
    // sempre, mesmo que o applyConfig do novo projeto ativo falhe a seguir.
    renderProjectsList();
    showProjectsStatus(t('projects.deleted_ok'), 'success');
    if (res.config) {
      try { await applyConfig(res.config); }
      catch (cfgErr) { console.error('Falha a aplicar config do projeto ativo:', cfgErr); }
    }
  } catch (err) {
    console.error('Falha a apagar projeto:', err);
    showProjectsStatus(t('common.error_prefix') + err.message, 'error');
  } finally { endProjectTransition(); }
}

async function duplicateProject(id) {
  if (!beginProjectTransition()) return;
  try {
    const res = await window.icurator.projectsDuplicate(id);
    projectsCache = res.state;
    if (res.config) await applyConfig(res.config);
    renderProjectsList();
    showProjectsStatus(t('projects.cloned_ok'), 'success');
    goToTab('content');
  } catch (err) {
    console.error('Falha a clonar projeto:', err);
    showProjectsStatus(t('common.error_prefix') + err.message, 'error');
  } finally { endProjectTransition(); }
}

if (projectNewForm) {
  projectNewForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = (projectNewName.value || '').trim();
    if (!name) { showProjectsStatus(t('projects.name_required'), 'error'); return; }
    if (!beginProjectTransition()) return;
    try {
      const res = await window.icurator.projectsCreate(name);
      projectsCache = res.state;
      if (res.config) await applyConfig(res.config);
      projectNewName.value = '';
      renderProjectsList();
      showProjectsStatus(t('projects.created_ok'), 'success');
      goToTab('content');
    } catch (err) {
      console.error('Falha a criar projeto:', err);
      showProjectsStatus(t('common.error_prefix') + err.message, 'error');
    } finally { endProjectTransition(); }
  });
}

if (activeProjectCloseBtn) {
  activeProjectCloseBtn.addEventListener('click', () => goToTab('projetos'));
}

/* Esconde a barra "A editar: …" quando estamos no próprio separador Projetos. */
function updateActiveBarVisibility(target) {
  const bar = document.getElementById('active-project-bar');
  if (bar) bar.style.display = target === 'projetos' ? 'none' : '';
}
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => updateActiveBarVisibility(tab.dataset.tab));
});

/* =========================================================
 * EXPORT (Passo 6)
 * ========================================================= */
const exportSummaryEl = document.getElementById('export-summary');
const exportBuildBtn = document.getElementById('export-build');
const exportLogEl = document.getElementById('export-log');
const exportOpenReleaseBtn = document.getElementById('export-open-release');
const exportTargetSelect = document.getElementById('export-target');
const exportTargetDescription = document.getElementById('export-target-description');
const exportTargetStatus = document.getElementById('export-target-status');
let exportTargets = [];
let exportTargetsError = '';
let exportInProgress = false;
let lastExportConfig = null;

function selectedExportTarget() {
  return exportTargets.find((target) => target.id === exportTargetSelect.value);
}

function updateExportButton() {
  const target = selectedExportTarget();
  const moduleCount = lastExportConfig && Array.isArray(lastExportConfig.content) ? lastExportConfig.content.length : 0;
  exportBuildBtn.disabled = exportInProgress || !!contentMutation || !!projectTransition || settingsWrites.size > 0 || moduleCount === 0 || !target || !target.available;
  exportTargetSelect.disabled = exportInProgress;
}

function renderExportTarget() {
  const target = selectedExportTarget();
  const isMac = exportTargetSelect.value === 'mac';
  const formatKey = isMac ? 'mac_zip' : (target && target.format === 'exe' ? 'windows_exe' : 'windows_zip');
  exportTargetDescription.textContent = t('export.formats.' + formatKey);
  exportTargetStatus.classList.toggle('unavailable', !target || !target.available);
  if (target && target.available) {
    exportTargetStatus.textContent = t('export.target_ready');
  } else {
    const reason = exportTargetsError || (target && target.reason);
    exportTargetStatus.textContent = t('export.target_unavailable') + (reason ? ' ' + reason : '');
  }
  updateExportButton();
}

async function loadExportTargets() {
  try {
    const result = await window.icurator.getExportTargets();
    if (!result || !Array.isArray(result.targets)) throw new Error(t('export.target_check_failed'));
    exportTargets = result.targets.filter((target) => target && ['windows', 'mac'].includes(target.id));
    portableHostPlatform = result.hostPlatform || '';
    updatePortableActions();
    exportTargetsError = '';
    exportTargetSelect.value = result.hostPlatform === 'darwin' ? 'mac' : 'windows';
  } catch (err) {
    exportTargets = [];
    exportTargetsError = err && err.message ? err.message : String(err);
  }
  renderExportTarget();
}

exportTargetSelect.addEventListener('change', renderExportTarget);

function updateExportSummary(config) {
  lastExportConfig = config;
  const title = (config.brand && config.brand.title) || '—';
  const moduleCount = Array.isArray(config.content) ? config.content.length : 0;
  const leadsOn = !!(config.marketing && config.marketing.leads && config.marketing.leads.enabled);
  const banners = (config.marketing && config.marketing.banners) || {};
  const bannerOn = !!((banners.top && banners.top.enabled) || (banners.bottom && banners.bottom.enabled));
  const hasLogo = !!(config.brand && config.brand.logo);
  const hasIcon = !!(config.export && config.export.iconPath);

  const S = (k) => t('export.summary.' + k);
  const untitled = !title || title === '—' || title === 'O Meu Software';
  const problems = [];
  if (untitled) problems.push(t('export.check.no_title'));
  if (moduleCount === 0) problems.push(t('export.check.no_modules'));
  const checkHtml = problems.length
    ? '<div class="export-check warn"><strong>' + t('export.check.title') + '</strong><ul>'
      + problems.map((p) => '<li>' + p + '</li>').join('') + '</ul></div>'
    : '<div class="export-check ok">' + t('export.check.ready') + '</div>';
  updateExportButton();
  exportSummaryEl.removeAttribute('data-i18n');
  exportSummaryEl.innerHTML = checkHtml + `
    <div class="summary-row"><span class="summary-label">${S('project')}</span><span class="summary-value"></span></div>
    <div class="summary-row"><span class="summary-label">${S('modules')}</span><span class="summary-value">${moduleCount}</span></div>
    <div class="summary-row"><span class="summary-label">${S('logo')}</span>
      <span class="pill ${hasLogo ? 'on' : 'off'}">${hasLogo ? S('defined') : S('no_logo')}</span></div>
    <div class="summary-row"><span class="summary-label">${S('leads')}</span>
      <span class="pill ${leadsOn ? 'on' : 'off'}">${leadsOn ? S('active') : S('inactive')}</span></div>
    <div class="summary-row"><span class="summary-label">${S('banner')}</span>
      <span class="pill ${bannerOn ? 'on' : 'off'}">${bannerOn ? S('active') : S('inactive')}</span></div>
    <div class="summary-row"><span class="summary-label">${S('icon')}</span>
      <span class="pill ${hasIcon ? 'on' : 'off'}">${hasIcon ? S('defined') : S('default_electron')}</span></div>
  `;
  exportSummaryEl.querySelector('.summary-row .summary-value').textContent = title;
}

/* =========================================================
 * ÍCONE (Passo 5) — aba dedicada com gravação explícita.
 * O seletor apenas pré-visualiza; o ícone só é gravado quando
 * o utilizador clica em "Guardar Ícone".
 * ========================================================= */
const iconPickBtn = document.getElementById('icon-pick');
const iconPickName = document.getElementById('icon-pick-name');
const iconRemoveBtn = document.getElementById('icon-remove');
const iconPreviewImg = document.getElementById('icon-preview');
const iconPreviewEmpty = document.getElementById('icon-preview-empty');
const iconCurrentEl = document.getElementById('icon-current');
const iconSaveBtn = document.getElementById('icon-save');
const showIconStatus = makeStatus(document.getElementById('icon-status'));

const iconState = { pendingSourcePath: null, pendingRemove: false, currentRelative: null };

function setIconName(label) {
  if (!iconPickName) return;
  if (label) {
    iconPickName.textContent = label;
    iconPickName.classList.add('has-file');
    iconPickName.removeAttribute('data-i18n');
  } else {
    iconPickName.textContent = t('common.no_file_chosen');
    iconPickName.classList.remove('has-file');
    iconPickName.setAttribute('data-i18n', 'common.no_file_chosen');
  }
}

function setIconCurrentText() {
  if (!iconCurrentEl) return;
  if (iconState.currentRelative) {
    iconCurrentEl.textContent = t('export.icon_current_prefix') + iconState.currentRelative;
    iconCurrentEl.classList.add('has-file');
    iconCurrentEl.removeAttribute('data-i18n');
  } else {
    iconCurrentEl.textContent = t('export.icon_none');
    iconCurrentEl.classList.remove('has-file');
    iconCurrentEl.setAttribute('data-i18n', 'export.icon_none');
  }
}

async function loadIconState(config) {
  iconState.pendingSourcePath = null;
  iconState.pendingRemove = false;
  iconState.currentRelative = (config && config.export && config.export.iconPath) || null;
  setIconName(null);
  setIconCurrentText();
  if (iconState.currentRelative) {
    const abs = await window.icurator.resolveAssetPath(iconState.currentRelative);
    setImagePreview(iconPreviewImg, iconPreviewEmpty, abs);
  } else {
    setImagePreview(iconPreviewImg, iconPreviewEmpty, null);
  }
}

if (iconPickBtn) iconPickBtn.addEventListener('click', async () => {
  const picked = await pickForCurrentProject(() => window.icurator.pickFile('icon'), showIconStatus);
  if (!picked) return;
  if (!/\.(ico|png|jpe?g)$/i.test(picked.name)) {
    alert(t('export.icon_must_be_image'));
    return;
  }
  iconState.pendingSourcePath = picked.path;
  iconState.pendingRemove = false;
  setIconName(picked.name);
  setImagePreview(iconPreviewImg, iconPreviewEmpty, picked.path);
  showIconStatus('', '');
  if (iconSaveBtn) iconSaveBtn.click();
});

if (iconRemoveBtn) iconRemoveBtn.addEventListener('click', () => {
  if (!iconState.currentRelative && !iconState.pendingSourcePath) return;
  iconState.pendingSourcePath = null;
  iconState.pendingRemove = true;
  setIconName(null);
  setImagePreview(iconPreviewImg, iconPreviewEmpty, null);
  if (iconSaveBtn) iconSaveBtn.click();
});

if (iconSaveBtn) iconSaveBtn.addEventListener('click', async () => {
  iconSaveBtn.disabled = true;
  showIconStatus(t('common.saving'), '');
  try {
    let updated;
    if (iconState.pendingSourcePath) {
      updated = await window.icurator.saveIcon({ sourcePath: iconState.pendingSourcePath });
    } else if (iconState.pendingRemove) {
      updated = await window.icurator.saveIcon({ removeIcon: true });
    } else {
      showIconStatus('', '');
      iconSaveBtn.disabled = false;
      return;
    }
    await loadIconState(updated);
    updateExportSummary(updated);
    showIconStatus(t('common.saved'), 'success');
  } catch (err) {
    showIconStatus(t('common.error_prefix') + (err && err.message ? err.message : err), 'error');
  } finally {
    iconSaveBtn.disabled = false;
  }
});

function appendExportLog(msg, kind) {
  const empty = exportLogEl.querySelector('.export-log-empty');
  if (empty) empty.remove();
  const line = document.createElement('div');
  line.className = 'log-line' + (kind && kind !== 'info' ? ' ' + kind : '');
  const ts = new Date().toLocaleTimeString();
  line.textContent = `[${ts}] ${msg}`;
  exportLogEl.appendChild(line);
  exportLogEl.scrollTop = exportLogEl.scrollHeight;
}

// Subscribe to streaming logs from main
if (window.icurator && window.icurator.onExportLog) {
  window.icurator.onExportLog(({ msg, kind }) => appendExportLog(msg, kind));
}

// Tracks the last successfully written product path so the "reveal in folder"
// button knows what to show. Reset to null after each new export attempt.
let lastExportedPath = null;

exportBuildBtn.addEventListener('click', async () => {
  const target = selectedExportTarget();
  if (exportInProgress || contentMutation || projectTransition || settingsWrites.size > 0 || !target || !target.available) return;
  exportInProgress = true;
  updateBuilderBusyUI();
  exportLogEl.innerHTML = '';
  appendExportLog(t('export.log.starting'));
  lastExportedPath = null;
  exportOpenReleaseBtn.disabled = true;
  try {
    // The main process chooses the correct extension for this platform.
    const cfg = await window.icurator.loadConfig();
    const suggested = (cfg && cfg.brand && cfg.brand.title) || 'meu-curso';
    const result = await window.icurator.exportProject({ target: target.id, defaultName: suggested });
    if (result && result.cancelled) {
      appendExportLog(t('export.log.cancelled'));
    } else if (result && result.ok && result.path) {
      lastExportedPath = result.path;
      exportOpenReleaseBtn.disabled = false;
      appendExportLog(t('export.log.saved_prefix') + result.path, 'success');
      if (target.id === 'mac' || target.format === 'zip') {
        appendExportLog(t(target.id === 'mac' ? 'export.mac_delivery_help' : 'export.windows_zip_delivery_help'));
      }
    } else {
      throw new Error((result && (result.error || result.message)) || t('export.log.no_result'));
    }
  } catch (err) {
    appendExportLog(t('export.log.failed_prefix') + (err && err.message ? err.message : err), 'error');
  } finally {
    exportInProgress = false;
    updateBuilderBusyUI();
  }
});

exportOpenReleaseBtn.addEventListener('click', () => {
  if (lastExportedPath) window.icurator.revealInFolder(lastExportedPath);
});

loadInitialConfig();
