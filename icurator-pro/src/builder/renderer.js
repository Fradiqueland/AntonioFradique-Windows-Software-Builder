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

/* -------- Brand form -------- */
const form = document.getElementById('brand-form');
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
const saveBtn = document.getElementById('brand-save');
const saveStatus = document.getElementById('save-status');

// In-memory state for the brand panel
const state = {
  pendingLogoSourcePath: null,  // absolute path from <input type=file>, if user picked a new logo
  pendingRemoveLogo: false,
  currentLogoRelative: null
};

function setLogoPreviewFromAbsolutePath(absPath) {
  if (!absPath) {
    logoPreview.removeAttribute('src');
    logoPreview.classList.remove('visible');
    logoEmpty.classList.remove('hidden');
    return;
  }
  // Cache-bust so a replaced file refreshes.
  logoPreview.src = 'file://' + absPath.replace(/\\/g, '/') + '?t=' + Date.now();
  logoPreview.classList.add('visible');
  logoEmpty.classList.add('hidden');
}

function bindColorPicker(key) {
  colorInputs[key].addEventListener('input', (e) => {
    colorHexLabels[key].textContent = e.target.value.toUpperCase();
  });
}
Object.keys(colorInputs).forEach(bindColorPicker);

logoInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  // In Electron with nodeIntegration off, the File object still exposes `.path`.
  state.pendingLogoSourcePath = file.path || null;
  state.pendingRemoveLogo = false;

  // Live preview from the source file before saving.
  if (state.pendingLogoSourcePath) {
    setLogoPreviewFromAbsolutePath(state.pendingLogoSourcePath);
  } else {
    const reader = new FileReader();
    reader.onload = () => {
      logoPreview.src = reader.result;
      logoPreview.classList.add('visible');
      logoEmpty.classList.add('hidden');
    };
    reader.readAsDataURL(file);
  }
});

logoRemoveBtn.addEventListener('click', () => {
  state.pendingLogoSourcePath = null;
  state.pendingRemoveLogo = true;
  logoInput.value = '';
  setLogoPreviewFromAbsolutePath(null);
});

function showStatus(message, kind) {
  saveStatus.textContent = message;
  saveStatus.className = 'save-status ' + (kind || '');
  if (message) {
    setTimeout(() => {
      if (saveStatus.textContent === message) {
        saveStatus.textContent = '';
        saveStatus.className = 'save-status';
      }
    }, 3000);
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  saveBtn.disabled = true;
  showStatus('A guardar…', '');

  try {
    const payload = {
      title: titleInput.value,
      colors: {
        sidebar: colorInputs.sidebar.value,
        background: colorInputs.background.value,
        buttons: colorInputs.buttons.value
      },
      logoSourcePath: state.pendingLogoSourcePath || undefined,
      removeLogo: state.pendingRemoveLogo || undefined
    };

    const updated = await window.icurator.saveBrandConfig(payload);

    // Reset pending state and reflect the saved logo (from dist-assets/).
    state.pendingLogoSourcePath = null;
    state.pendingRemoveLogo = false;
    state.currentLogoRelative = updated.brand.logo || null;
    logoInput.value = '';

    if (state.currentLogoRelative) {
      const abs = await window.icurator.resolveAssetPath(state.currentLogoRelative);
      setLogoPreviewFromAbsolutePath(abs);
    } else {
      setLogoPreviewFromAbsolutePath(null);
    }

    showStatus('Definições guardadas em project-config.json', 'success');
  } catch (err) {
    console.error(err);
    showStatus('Erro ao guardar: ' + (err && err.message ? err.message : err), 'error');
  } finally {
    saveBtn.disabled = false;
  }
});

/* -------- Initial load -------- */
async function loadInitialConfig() {
  try {
    const config = await window.icurator.loadConfig();
    const brand = config.brand || {};

    titleInput.value = brand.title || '';
    colorInputs.sidebar.value = (brand.colors && brand.colors.sidebar) || '#111827';
    colorInputs.background.value = (brand.colors && brand.colors.background) || '#f8fafc';
    colorInputs.buttons.value = (brand.colors && brand.colors.buttons) || '#2563eb';
    Object.keys(colorInputs).forEach((k) => {
      colorHexLabels[k].textContent = colorInputs[k].value.toUpperCase();
    });

    state.currentLogoRelative = brand.logo || null;
    if (state.currentLogoRelative) {
      const abs = await window.icurator.resolveAssetPath(state.currentLogoRelative);
      setLogoPreviewFromAbsolutePath(abs);
    } else {
      setLogoPreviewFromAbsolutePath(null);
    }
  } catch (err) {
    console.error('Falha ao carregar configuração inicial:', err);
  }
}

loadInitialConfig();
