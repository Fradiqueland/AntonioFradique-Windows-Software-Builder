/* =========================================================
 * i18n ENGINE (Tarefa 3)
 * ========================================================= */
const I18N = {
  lang: 'pt',
  dict: {},
  ready: false
};

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
  // Update <html lang>.
  document.documentElement.setAttribute('lang', I18N.lang);
}

async function setLanguage(lang, { persist = true } = {}) {
  try {
    const { lang: applied, dict } = await window.icurator.loadLocale(lang);
    I18N.lang = applied;
    I18N.dict = dict;
    I18N.ready = true;
    applyI18n();
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

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    tabs.forEach((t2) => t2.classList.toggle('active', t2 === tab));
    panels.forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== target));
    refreshTabHeader(target);
  });
});

/* -------- Language dropdown + corner links -------- */
document.addEventListener('DOMContentLoaded', () => {
  const sel = document.getElementById('lang-select');
  if (sel) sel.addEventListener('change', (e) => setLanguage(e.target.value));

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
  const picked = await window.icurator.pickFile('image');
  if (!picked) return;
  brandState.pendingLogoSourcePath = picked.path;
  brandState.pendingRemoveLogo = false;
  setFileNameForInput(logoInput, picked.name);
  setImagePreview(logoPreview, logoEmpty, picked.path);
});

logoRemoveBtn.addEventListener('click', () => {
  brandState.pendingLogoSourcePath = null;
  brandState.pendingRemoveLogo = true;
  logoInput.value = '';
  setFileNameForInput(logoInput, null);
  setImagePreview(logoPreview, logoEmpty, null);
});

brandForm.addEventListener('submit', async (e) => {
  e.preventDefault();
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
  }
});

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
  leadsSaveBtn.disabled = true;
  showLeadsStatus(t('common.saving'), '');
  try {
    await window.icurator.saveLeadsConfig({
      enabled: leadsEnabled.checked,
      heading: leadsHeading.value,
      formHtml: leadsHtml.value
    });
    showLeadsStatus(t('common.saved'), 'success');
  } catch (err) {
    console.error(err);
    showLeadsStatus(t('common.error_prefix') + (err && err.message ? err.message : err), 'error');
  } finally {
    leadsSaveBtn.disabled = false;
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
    const picked = await window.icurator.pickFile('image');
    if (!picked) return;
    state.pendingImageSourcePath = picked.path;
    state.pendingRemoveImage = false;
    setFileNameForInput(imageInput, picked.name);
    setImagePreview(preview, empty, picked.path);
  });

  removeBtn.addEventListener('click', () => {
    state.pendingImageSourcePath = null;
    state.pendingRemoveImage = true;
    imageInput.value = '';
    setFileNameForInput(imageInput, null);
    setImagePreview(preview, empty, null);
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
  }
});

/* =========================================================
 * CONTENT / MENUS (Passo 4)
 * ========================================================= */

// Module type labels are now resolved from the active locale via
// `content.type.<key>` so the list stays in the user's chosen language
// (PT/EN/ES/FR). `typeLabel(type)` falls back to the raw type if no key.
const TYPE_KEYS = ['youtube', 'html', 'pdf', 'webview', 'external', 'launch'];
function typeLabel(type) {
  const key = 'content.type.' + type;
  const v = t(key);
  return v === key ? type : v;
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
const dynGroups = document.querySelectorAll('[data-dyn]');
const showContentStatus = makeStatus(document.getElementById('content-status'));

const dyn = {
  youtube: { url: document.getElementById('dyn-youtube-url') },
  html: { code: document.getElementById('dyn-html-code') },
  pdf: {
    file: document.getElementById('dyn-pdf-file'),
    current: document.getElementById('dyn-pdf-current')
  },
  webview: { url: document.getElementById('dyn-webview-url') },
  external: { url: document.getElementById('dyn-external-url') },
  launch: {
    file: document.getElementById('dyn-launch-file'),
    current: document.getElementById('dyn-launch-current')
  }
};

// In-memory mirror of the saved content array. Always kept in sync with disk.
let contentModules = [];
// Editor state
let editingId = null;        // id of module being edited (null = creating new)
let pendingFileSourcePath = null;  // absolute path picked in <input type=file> for current edit
let pendingFileName = null;

function showDynamicGroup(type) {
  dynGroups.forEach((g) => g.classList.toggle('hidden', g.dataset.dyn !== type));
}

function setFileCurrentText(type, text, hasFile) {
  const el = dyn[type] && dyn[type].current;
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('has-file', !!hasFile);
}

function clearEditor() {
  editingId = null;
  pendingFileSourcePath = null;
  pendingFileName = null;
  moduleTitle.value = '';
  moduleType.value = 'youtube';
  dyn.youtube.url.value = '';
  dyn.html.code.value = '';
  dyn.webview.url.value = '';
  dyn.external.url.value = '';
  dyn.pdf.file.value = '';
  dyn.launch.file.value = '';
  setFileCurrentText('pdf', t('content.file_none'), false);
  setFileCurrentText('launch', t('content.file_none'), false);
  // Reset visible filename labels for the dynamic file pickers — otherwise
  // the previous module's name would linger when reopening / editing.
  ['pdf', 'launch'].forEach((k) => {
    if (dyn[k] && dyn[k].file) setFileNameForInput(dyn[k].file, null);
  });
  showDynamicGroup('youtube');
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
  showDynamicGroup(mod.type);

  const d = mod.data || {};
  if (mod.type === 'youtube') dyn.youtube.url.value = d.url || '';
  else if (mod.type === 'html') dyn.html.code.value = d.html || '';
  else if (mod.type === 'webview') dyn.webview.url.value = d.url || '';
  else if (mod.type === 'external') dyn.external.url.value = d.url || '';
  else if (mod.type === 'pdf' || mod.type === 'launch') {
    if (d.file) {
      setFileCurrentText(mod.type, t('content.file_current_prefix') + (d.fileName || d.file), true);
    } else {
      setFileCurrentText(mod.type, t('content.file_none'), false);
    }
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
    info.querySelector('.content-item-type').textContent = typeLabel(mod.type);
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
    delBtn.addEventListener('click', () => deleteModule(mod.id));

    actions.append(upBtn, downBtn, editBtn, delBtn);
    li.append(info, actions);
    contentList.append(li);
  });
}

async function persistContent(successMessage) {
  // Send the in-memory list to main; for the module being edited, pendingFileSourcePath
  // (if any) is already attached inside its data.sourcePath.
  const payload = {
    modules: contentModules.map((m) => ({
      id: m.id,
      title: m.title,
      type: m.type,
      data: m.data || {}
    }))
  };
  const updated = await window.icurator.saveContent(payload);
  contentModules = Array.isArray(updated.content) ? updated.content : [];
  // After persistence, sourcePath has been consumed — clear pending.
  pendingFileSourcePath = null;
  pendingFileName = null;
  renderContentList();
  if (successMessage) showContentStatus(successMessage, 'success');
}

async function moveModule(id, delta) {
  const idx = contentModules.findIndex((m) => m.id === id);
  if (idx < 0) return;
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= contentModules.length) return;
  const [item] = contentModules.splice(idx, 1);
  contentModules.splice(newIdx, 0, item);
  try {
    await persistContent(t('content.order_updated'));
  } catch (err) {
    console.error(err);
    showContentStatus(t('content.reorder_error_prefix') + err.message, 'error');
  }
}

async function deleteModule(id) {
  const mod = contentModules.find((m) => m.id === id);
  if (!mod) return;
  if (!confirm(t('content.delete_confirm').replace('{title}', mod.title))) return;

  contentModules = contentModules.filter((m) => m.id !== id);
  if (editingId === id) hideEditor();
  try {
    await persistContent(t('content.module_deleted'));
  } catch (err) {
    console.error(err);
    showContentStatus(t('content.delete_error_prefix') + err.message, 'error');
  }
}

/* ---- Editor wiring ---- */

contentAddBtn.addEventListener('click', () => openEditorForNew());
contentEditorClose.addEventListener('click', () => hideEditor());
contentEditorCancel.addEventListener('click', () => hideEditor());

moduleType.addEventListener('change', () => {
  showDynamicGroup(moduleType.value);
});

function bindFilePicker(type) {
  const input = dyn[type].file;
  const label = document.querySelector('label[for="' + input.id + '"]');
  const category = type === 'pdf' ? 'pdf' : 'launch';
  if (label) label.addEventListener('click', async (e) => {
    e.preventDefault();
    const picked = await window.icurator.pickFile(category);
    if (!picked) return;
    pendingFileSourcePath = picked.path;
    pendingFileName = picked.name;
    setFileNameForInput(input, picked.name);
    setFileCurrentText(type, t('content.file_new_prefix') + (pendingFileName || pendingFileSourcePath), true);
  });
}
bindFilePicker('pdf');
bindFilePicker('launch');

contentForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const title = moduleTitle.value.trim();
  const type = moduleType.value;
  if (!title) { moduleTitle.focus(); return; }
  if (!TYPE_KEYS.includes(type)) return;

  // Build the data object for this module
  let data = {};
  if (type === 'youtube') data = { url: dyn.youtube.url.value.trim() };
  else if (type === 'html') data = { html: dyn.html.code.value };
  else if (type === 'webview') data = { url: dyn.webview.url.value.trim() };
  else if (type === 'external') data = { url: dyn.external.url.value.trim() };
  else if (type === 'pdf' || type === 'launch') {
    if (pendingFileSourcePath) {
      data = { sourcePath: pendingFileSourcePath };
    } else {
      // Keep whatever was there (main.js falls back to previous file when no sourcePath)
      data = {};
    }
  }

  // Update or insert in the local list
  if (editingId) {
    const idx = contentModules.findIndex((m) => m.id === editingId);
    if (idx >= 0) {
      // If editing and changing type, drop the old file association so GC kicks in.
      const old = contentModules[idx];
      const typeChanged = old.type !== type;
      contentModules[idx] = {
        id: old.id,
        title,
        type,
        data: typeChanged ? data : data
      };
    }
  } else {
    const newMod = { id: uuid(), title, type, data };
    contentModules.push(newMod);
    editingId = newMod.id;
  }

  try {
    await persistContent(t('content.module_saved'));
    // After save, re-open the editor on the (now updated) module so the user
    // sees the persisted state (e.g. the new file path).
    const savedId = editingId;
    hideEditor();
    if (savedId) openEditorForEdit(savedId);
  } catch (err) {
    console.error(err);
    showContentStatus(t('common.error_prefix') + err.message, 'error');
  }
});

/* =========================================================
 * Initial load
 * ========================================================= */
async function loadInitialConfig() {
  try {
    const config = await window.icurator.loadConfig();

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

    // --- Content / menus
    contentModules = Array.isArray(config.content) ? config.content : [];
    renderContentList();

    // --- Export (Passo 6)
    updateExportSummary(config);
    const iconPath = config.export && config.export.iconPath;
    if (iconPath) {
      exportIconCurrent.textContent = t('export.icon_current_prefix') + iconPath;
      exportIconCurrent.classList.add('has-file');
    } else {
      exportIconCurrent.textContent = t('export.icon_none');
      exportIconCurrent.classList.remove('has-file');
    }

    // --- i18n: apply saved language (do NOT persist again — it's already saved).
    const savedLang = config.language || 'pt';
    await setLanguage(savedLang, { persist: false });
    // Re-render the export summary so its labels respect the new language.
    updateExportSummary(config);
  } catch (err) {
    console.error('Falha ao carregar configuração inicial:', err);
  }
}

/* =========================================================
 * EXPORT (Passo 6)
 * ========================================================= */
const exportIconInput = document.getElementById('export-icon');
const exportIconCurrent = document.getElementById('export-icon-current');
const exportSummaryEl = document.getElementById('export-summary');
const exportBuildBtn = document.getElementById('export-build');
const exportLogEl = document.getElementById('export-log');
const exportOpenReleaseBtn = document.getElementById('export-open-release');

function updateExportSummary(config) {
  const title = (config.brand && config.brand.title) || '—';
  const moduleCount = Array.isArray(config.content) ? config.content.length : 0;
  const leadsOn = !!(config.marketing && config.marketing.leads && config.marketing.leads.enabled);
  const banners = (config.marketing && config.marketing.banners) || {};
  const bannerOn = !!((banners.top && banners.top.enabled) || (banners.bottom && banners.bottom.enabled));
  const hasLogo = !!(config.brand && config.brand.logo);
  const hasIcon = !!(config.export && config.export.iconPath);

  const S = (k) => t('export.summary.' + k);
  exportSummaryEl.innerHTML = `
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

const iconPickLabel = document.querySelector('label[for="export-icon"]');
if (iconPickLabel) iconPickLabel.addEventListener('click', async (e) => {
  e.preventDefault();
  const picked = await window.icurator.pickFile('icon');
  if (!picked) return;
  if (!/\.(ico|png|jpe?g)$/i.test(picked.name)) {
    alert(t('export.icon_must_be_image'));
    return;
  }
  try {
    const updated = await window.icurator.saveIcon({ sourcePath: picked.path });
    exportIconCurrent.textContent = t('export.icon_current_prefix') + updated.export.iconPath;
    exportIconCurrent.classList.add('has-file');
    updateExportSummary(updated);
    setFileNameForInput(exportIconInput, picked.name);
  } catch (err) {
    alert(t('common.error_prefix') + err.message);
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

// Tracks the last successfully written .lbpro path so the "reveal in folder"
// button knows what to show. Reset to null after each new export attempt.
let lastExportedPath = null;

exportBuildBtn.addEventListener('click', async () => {
  exportBuildBtn.disabled = true;
  exportLogEl.innerHTML = '';
  appendExportLog(t('export.log.starting'));
  lastExportedPath = null;
  exportOpenReleaseBtn.disabled = true;
  try {
    // Use the project title as the default file name so the user gets
    // "Curso de Photoshop.exe" pre-filled in the save dialog.
    const cfg = await window.icurator.loadConfig();
    const suggested = (cfg && cfg.brand && cfg.brand.title) || 'meu-curso';
    const result = await window.icurator.buildExe({ defaultName: suggested });
    if (result && result.cancelled) {
      appendExportLog(t('export.log.cancelled'));
    } else if (result && result.ok && result.path) {
      lastExportedPath = result.path;
      exportOpenReleaseBtn.disabled = false;
      appendExportLog(t('export.log.saved_prefix') + result.path, 'success');
    }
  } catch (err) {
    appendExportLog(t('export.log.failed_prefix') + (err && err.message ? err.message : err), 'error');
  } finally {
    exportBuildBtn.disabled = false;
  }
});

exportOpenReleaseBtn.addEventListener('click', () => {
  if (lastExportedPath) window.icurator.revealInFolder(lastExportedPath);
});

loadInitialConfig();
