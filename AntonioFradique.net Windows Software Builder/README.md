# LaunchBox Pro

Dashboard Creator / Content Packager — versão moderna em Electron.js.

> **Nota:** Este código foi gerado no Replit mas tem de ser executado/compilado no teu PC (o Replit não corre apps Electron — não tem ambiente gráfico).

## Como correr no teu PC

```bash
# 1. Faz download desta pasta para o teu computador
# 2. Instala as dependências (precisas de Node.js 18+ instalado)
cd icurator-pro
npm install

# 3. Arranca a app em modo desenvolvimento
npm start
```

> A pasta do projeto continua a chamar-se `icurator-pro/` por compatibilidade interna; apenas o nome comercial mudou para **LaunchBox Pro**.

## Como compilar para .exe (Windows)

Modo recomendado — pelo separador **Exportar** dentro da app (gera `release/`).

Modo manual:

```bash
npm run build:win
```

## Estrutura

```
icurator-pro/
├── main.js              # Processo principal Electron
├── preload.js           # Bridge segura (Construtor)
├── preload-viewer.js    # Bridge segura (Viewer)
├── package.json         # Dependências + config electron-builder
├── data/                # project-config.json + icon.ico
├── dist-assets/         # Ficheiros locais (logos, PDFs, etc.)
└── src/
    ├── builder/         # Modo Construtor
    └── viewer/          # Modo Visualizador
```

## Roadmap

- [x] **Passo 1** — Estrutura base + navegação por separadores
- [x] **Passo 2** — Separador Marca/Design
- [x] **Passo 3** — Captura de Leads + Banners
- [x] **Passo 4** — Conteúdo/Menus (6 tipos de ação)
- [x] **Passo 5** — Modo Visualizador
- [x] **Passo 6** — Exportação para .exe
