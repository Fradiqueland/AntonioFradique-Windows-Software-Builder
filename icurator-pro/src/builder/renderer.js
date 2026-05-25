/* -------- Tab navigation -------- */
const tabTitles = {
  brand: { title: 'Marca / Design', subtitle: 'Personalize a aparência do produto final.' },
  leads: { title: 'Captura de Leads', subtitle: 'Configure o opt-in / squeeze page inicial.' },
  banners: { title: 'Banners', subtitle: 'Adicione banners de publicidade e links de afiliado.' },
  content: { title: 'Conteúdo / Menus', subtitle: 'Construa o menu de navegação do produto final.' },
  export: { title: 'Exportar', subtitle: 'Compile o produto final para .exe (Windows).' }
};

const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.panel');
const pageTitle = document.getElementById('page-title');
const pageSubtitle = document.getElementById('page-subtitle');

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    tabs.forEach((t) => t.classList.toggle('active', t === tab));
    panels.forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== target));
    const meta = tabTitles[target];
    if (meta) {
      pageTitle.textContent = meta.title;
      pageSubtitle.textContent = meta.subtitle;
    }
  });
});

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

logoInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  brandState.pendingLogoSourcePath = file.path || null;
  brandState.pendingRemoveLogo = false;
  if (brandState.pendingLogoSourcePath) {
    setImagePreview(logoPreview, logoEmpty, brandState.pendingLogoSourcePath);
  }
});

logoRemoveBtn.addEventListener('click', () => {
  brandState.pendingLogoSourcePath = null;
  brandState.pendingRemoveLogo = true;
  logoInput.value = '';
  setImagePreview(logoPreview, logoEmpty, null);
});

brandForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  brandSaveBtn.disabled = true;
  showBrandStatus('A guardar…', '');
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
    const abs = brandState.currentLogoRelative
      ? await window.icurator.resolveAssetPath(brandState.currentLogoRelative) : null;
    setImagePreview(logoPreview, logoEmpty, abs);
    showBrandStatus('Definições guardadas em project-config.json', 'success');
  } catch (err) {
    console.error(err);
    showBrandStatus('Erro ao guardar: ' + (err && err.message ? err.message : err), 'error');
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
  showLeadsStatus('A guardar…', '');
  try {
    await window.icurator.saveLeadsConfig({
      enabled: leadsEnabled.checked,
      heading: leadsHeading.value,
      formHtml: leadsHtml.value
    });
    showLeadsStatus('Definições de leads guardadas.', 'success');
  } catch (err) {
    console.error(err);
    showLeadsStatus('Erro ao guardar: ' + (err && err.message ? err.message : err), 'error');
  } finally {
    leadsSaveBtn.disabled = false;
  }
});

/* =========================================================
 * BANNER FORM (Passo 3)
 * ========================================================= */
const bannerForm = document.getElementById('banner-form');
const bannerEnabled = document.getElementById('banner-enabled');
const bannerImageInput = document.getElementById('banner-image');
const bannerImageRemoveBtn = document.getElementById('banner-image-remove');
const bannerImagePreview = document.getElementById('banner-image-preview');
const bannerImageEmpty = document.getElementById('banner-image-empty');
const bannerUrlInput = document.getElementById('banner-url');
const bannerPositionSelect = document.getElementById('banner-position');
const bannerSaveBtn = document.getElementById('banner-save');
const showBannerStatus = makeStatus(document.getElementById('banner-status'));

const bannerState = { pendingImageSourcePath: null, pendingRemoveImage: false, currentImageRelative: null };

bannerImageInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  bannerState.pendingImageSourcePath = file.path || null;
  bannerState.pendingRemoveImage = false;
  if (bannerState.pendingImageSourcePath) {
    setImagePreview(bannerImagePreview, bannerImageEmpty, bannerState.pendingImageSourcePath);
  }
});

bannerImageRemoveBtn.addEventListener('click', () => {
  bannerState.pendingImageSourcePath = null;
  bannerState.pendingRemoveImage = true;
  bannerImageInput.value = '';
  setImagePreview(bannerImagePreview, bannerImageEmpty, null);
});

bannerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  bannerSaveBtn.disabled = true;
  showBannerStatus('A guardar…', '');
  try {
    const updated = await window.icurator.saveBannerConfig({
      enabled: bannerEnabled.checked,
      url: bannerUrlInput.value,
      position: bannerPositionSelect.value,
      imageSourcePath: bannerState.pendingImageSourcePath || undefined,
      removeImage: bannerState.pendingRemoveImage || undefined
    });
    bannerState.pendingImageSourcePath = null;
    bannerState.pendingRemoveImage = false;
    bannerState.currentImageRelative = updated.marketing.banner.image || null;
    bannerImageInput.value = '';
    const abs = bannerState.currentImageRelative
      ? await window.icurator.resolveAssetPath(bannerState.currentImageRelative) : null;
    setImagePreview(bannerImagePreview, bannerImageEmpty, abs);
    showBannerStatus('Definições de banners guardadas.', 'success');
  } catch (err) {
    console.error(err);
    showBannerStatus('Erro ao guardar: ' + (err && err.message ? err.message : err), 'error');
  } finally {
    bannerSaveBtn.disabled = false;
  }
});

/* =========================================================
 * CONTENT / MENUS (Passo 4)
 * ========================================================= */

const TYPE_LABELS = {
  youtube: 'YouTube',
  html: 'HTML / Texto',
  pdf: 'PDF Local',
  webview: 'Browser Interno',
  external: 'Browser Externo',
  launch: 'Lançar Ficheiro'
};

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
  setFileCurrentText('pdf', 'Nenhum ficheiro selecionado.', false);
  setFileCurrentText('launch', 'Nenhum ficheiro selecionado.', false);
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
  contentEditorTitle.textContent = 'Novo Módulo';
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
  contentEditorTitle.textContent = 'Editar Módulo';
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
      setFileCurrentText(mod.type, 'Ficheiro atual: ' + (d.fileName || d.file), true);
    } else {
      setFileCurrentText(mod.type, 'Nenhum ficheiro selecionado.', false);
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
    info.title = 'Clique para editar';
    info.innerHTML = `
      <span class="content-item-title"></span>
      <span class="content-item-type"></span>
    `;
    info.querySelector('.content-item-title').textContent = mod.title;
    info.querySelector('.content-item-type').textContent = TYPE_LABELS[mod.type] || mod.type;
    info.addEventListener('click', () => openEditorForEdit(mod.id));

    const actions = document.createElement('div');
    actions.className = 'content-item-actions';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'icon-btn';
    upBtn.title = 'Subir';
    upBtn.textContent = '▲';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => moveModule(mod.id, -1));

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'icon-btn';
    downBtn.title = 'Descer';
    downBtn.textContent = '▼';
    downBtn.disabled = index === contentModules.length - 1;
    downBtn.addEventListener('click', () => moveModule(mod.id, 1));

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'icon-btn';
    editBtn.title = 'Editar';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', () => openEditorForEdit(mod.id));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'icon-btn danger';
    delBtn.title = 'Eliminar';
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
    await persistContent('Ordem atualizada.');
  } catch (err) {
    console.error(err);
    showContentStatus('Erro ao reordenar: ' + err.message, 'error');
  }
}

async function deleteModule(id) {
  const mod = contentModules.find((m) => m.id === id);
  if (!mod) return;
  if (!confirm(`Eliminar o módulo "${mod.title}"? Esta ação não pode ser desfeita.`)) return;

  contentModules = contentModules.filter((m) => m.id !== id);
  if (editingId === id) hideEditor();
  try {
    await persistContent('Módulo eliminado.');
  } catch (err) {
    console.error(err);
    showContentStatus('Erro ao eliminar: ' + err.message, 'error');
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
  input.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    pendingFileSourcePath = file.path || null;
    pendingFileName = file.name || null;
    if (pendingFileSourcePath) {
      setFileCurrentText(type, 'Novo ficheiro: ' + (pendingFileName || pendingFileSourcePath), true);
    }
  });
}
bindFilePicker('pdf');
bindFilePicker('launch');

contentForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const title = moduleTitle.value.trim();
  const type = moduleType.value;
  if (!title) { moduleTitle.focus(); return; }
  if (!TYPE_LABELS[type]) return;

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
    await persistContent('Módulo guardado.');
    // After save, re-open the editor on the (now updated) module so the user
    // sees the persisted state (e.g. the new file path).
    const savedId = editingId;
    hideEditor();
    if (savedId) openEditorForEdit(savedId);
  } catch (err) {
    console.error(err);
    showContentStatus('Erro ao guardar módulo: ' + err.message, 'error');
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

    // --- Banner
    const banner = (config.marketing && config.marketing.banner) || {};
    bannerEnabled.checked = !!banner.enabled;
    bannerUrlInput.value = banner.url || '';
    bannerPositionSelect.value = banner.position === 'top' ? 'top' : 'bottom';
    bannerState.currentImageRelative = banner.image || null;
    if (bannerState.currentImageRelative) {
      const abs = await window.icurator.resolveAssetPath(bannerState.currentImageRelative);
      setImagePreview(bannerImagePreview, bannerImageEmpty, abs);
    } else {
      setImagePreview(bannerImagePreview, bannerImageEmpty, null);
    }

    // --- Content / menus
    contentModules = Array.isArray(config.content) ? config.content : [];
    renderContentList();
  } catch (err) {
    console.error('Falha ao carregar configuração inicial:', err);
  }
}

loadInitialConfig();
