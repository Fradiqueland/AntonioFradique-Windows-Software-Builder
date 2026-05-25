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
