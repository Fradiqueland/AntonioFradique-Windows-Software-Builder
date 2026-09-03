# AntonioFradique.net Windows Software Builder

App de secretária (Electron) que gera software para Windows: cada curso é empacotado
num `.exe` único e auto-extraível (via SFX 7-Zip), com o visualizador já embutido.

> **Nota:** este código é desenvolvido no Replit mas tem de ser compilado e executado
> no teu PC Windows (o Replit não corre apps Electron — não tem ambiente gráfico).

## Requisitos

- Windows 64-bit
- [Node.js](https://nodejs.org) 18+ (recomendado 20+)

## Compilar tudo (recomendado)

```bash
npm run build:all
```

Instala as dependências, gera o template do visualizador e cria o instalador final em
`dist/builder/`.

## Outros comandos

| Comando | O que faz |
| --- | --- |
| `npm start` | Abre a app em modo desenvolvimento |
| `npm run build:viewer-template` | Gera apenas o template do visualizador |
| `npm run build:builder` | Gera apenas o instalador do Construtor |

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

## Como funciona

- **Construtor** — configuras marca, banners, captura de leads e os menus/conteúdos do curso.
- **Visualizador** — a aplicação que o aluno abre.
- **Exportar** — cada curso fica num `.exe` único auto-extraível, pronto a distribuir.

## ffmpeg (opcional, recomendado para IPTV)

Alguns canais IPTV (vídeo entrelaçado 1080i, áudio AC-3/MP2) não são reproduzíveis
pelo Chromium através do MediaSource. Com um `ffmpeg.exe` em `vendor/ffmpeg/`,
o Viewer ganha um motor extra: o processo principal lê o stream com o ffmpeg,
remultiplexa para MP4 fragmentado (vídeo sem recodificar, áudio → AAC) e
serve-o localmente ao leitor. O electron-builder copia a pasta para
`resources/ffmpeg/` no Construtor e no template do Viewer, e por isso o
ffmpeg vai dentro de cada curso exportado (+~90 MB por .exe).

Ver `vendor/ffmpeg/README.txt` para onde obter o binário. Sem ele, tudo o
resto funciona como antes.
