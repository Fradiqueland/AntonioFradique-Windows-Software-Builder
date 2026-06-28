# AntonioFradique.net Windows Software Builder

App de secretária (Electron) que gera software para Windows: cada curso é empacotado
num `.exe` único e auto-extraível (via SFX 7-Zip), com o visualizador já embutido.

> **Importante:** o projeto é desenvolvido aqui no Replit, mas é **compilado e executado
> no teu PC Windows**. O Replit não corre aplicações de secretária Electron (não tem
> ambiente gráfico), por isso a compilação tem de ser feita no teu computador.

## Onde está o projeto

O código está na pasta **`AntonioFradique.net Windows Software Builder/`**.
Abre o terminal dentro dessa pasta (atenção ao espaço no nome — usa aspas):

```bash
cd "AntonioFradique.net Windows Software Builder"
```

## Requisitos (no teu PC)

- Windows 64-bit
- [Node.js](https://nodejs.org) 18 ou superior (recomendado 20+)

## Compilar tudo (recomendado)

```bash
npm run build:all
```

Este comando trata de tudo: instala as dependências, gera o template do visualizador e
cria o instalador final. O resultado fica em **`dist/builder/`**.

## Outros comandos

| Comando | O que faz |
| --- | --- |
| `npm start` | Abre a app em modo desenvolvimento |
| `npm run build:viewer-template` | Gera apenas o template do visualizador |
| `npm run build:builder` | Gera apenas o instalador do Construtor |

## Como funciona

- **Construtor** — configuras a marca, banners, captura de leads e os menus/conteúdos do curso.
- **Visualizador** — a aplicação que o aluno abre para ver o curso.
- **Exportar** — cada curso é empacotado num `.exe` único auto-extraível, pronto a distribuir.

## Estrutura

```
main.js              # processo principal do Electron
preload.js           # ponte segura (Construtor)
preload-viewer.js    # ponte segura (Visualizador)
package.json         # dependências + configuração do electron-builder
src/builder/         # interface do Construtor (+ icon.ico da app)
src/viewer/          # interface do Visualizador
build-configs/       # configurações de compilação
scripts/             # scripts auxiliares de build
locales/  assets/    # recursos
```

## Atualizar no teu PC (via GitHub)

Este projeto está guardado num repositório **privado** no GitHub. Para o manteres
atualizado no computador sem copiar ficheiros à mão:

1. Instala o **[GitHub Desktop](https://desktop.github.com)** e inicia sessão com a tua conta.
2. **File → Clone repository** e escolhe este repositório.
3. Sempre que houver alterações novas, clica em **Pull** para atualizar.

Depois é só correr `npm run build:all` dentro da pasta do projeto.
