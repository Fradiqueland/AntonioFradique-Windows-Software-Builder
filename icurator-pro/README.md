# iCurator Pro

Dashboard Creator / Content Packager — versão moderna em Electron.js do clássico iCurator.

> **Nota:** Este código foi gerado no Replit mas tem de ser executado/compilado no teu PC (o Replit não corre apps Electron — não tem ambiente gráfico).

## Como correr no teu PC

```bash
# 1. Faz download desta pasta `icurator-pro/` para o teu computador
# 2. Instala as dependências (precisas de Node.js 18+ instalado)
cd icurator-pro
npm install

# 3. Arranca a app em modo desenvolvimento
npm start
```

## Como compilar para .exe (Windows)

```bash
npm run build:win
```

O instalador `.exe` aparece em `dist/`.

## Estrutura

```
icurator-pro/
├── main.js              # Processo principal Electron
├── preload.js           # Bridge segura para o renderer
├── package.json         # Dependências + config electron-builder
├── assets/              # Ícones (icon.ico para Windows — coloca aqui o teu)
└── src/
    ├── builder/         # Modo Construtor (a interface do criador)
    │   ├── index.html
    │   ├── styles.css
    │   └── renderer.js
    └── viewer/          # Modo Visualizador (será criado no Passo 5)
```

## Roadmap

- [x] **Passo 1** — Estrutura base + navegação por separadores
- [ ] **Passo 2** — Separador Marca/Design (título, logo, cores)
- [ ] **Passo 3** — Captura de Leads + Banners
- [ ] **Passo 4** — Conteúdo/Menus (6 tipos de ação)
- [ ] **Passo 5** — Modo Visualizador (pré-visualização)
- [ ] **Passo 6** — Exportação para .exe
