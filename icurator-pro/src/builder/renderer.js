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

const brandState = {
  pendingLogoSourcePath: null,
  pendingRemoveLogo: false,
  currentLogoRelative: null
};

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
      ? await window.icurator.resolveAssetPath(brandState.currentLogoRelative)
      : null;
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

const bannerState = {
  pendingImageSourcePath: null,
  pendingRemoveImage: false,
  currentImageRelative: null
};

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
      ? await window.icurator.resolveAssetPath(bannerState.currentImageRelative)
      : null;
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
 * Initial load — populate all forms from project-config.json
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

    // --- Marketing: Leads
    const leads = (config.marketing && config.marketing.leads) || {};
    leadsEnabled.checked = !!leads.enabled;
    leadsHeading.value = leads.heading || '';
    leadsHtml.value = leads.formHtml || '';

    // --- Marketing: Banner
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
  } catch (err) {
    console.error('Falha ao carregar configuração inicial:', err);
  }
}

loadInitialConfig();
