# NOTAS — contexto do projeto (v1.5.5 → v1.5.20)

Documento de passagem de testemunho. Explica **o que mudou, porquê, e as
armadilhas** que custaram mais a descobrir. Ler antes de mexer no IPTV, no
YouTube ou na persistência do Viewer.

## O que é isto

Electron 32 + electron-builder. Duas aplicações no mesmo código, distinguidas
por `resources/app-mode.json` (`builder` | `viewer`):

- **Construtor** (`src/builder/`): cria "cursos" (módulos de conteúdo) e
  exporta cada um como um único `.exe` (7-Zip SFX) que embute o Viewer.
- **Viewer** (`src/viewer/`): o que o aluno abre. Corre a partir de uma pasta
  `%TEMP%` descartável criada pelo SFX e apagada ao fechar.

Compilar só no Windows: `npm run build:all` (reconstrói o **template do
Viewer** e depois o Construtor). `build:builder` sozinho reutiliza o template
antigo — se a alteração for no Viewer, o curso exportado não a leva. Depois de
qualquer build, **reexportar os cursos**: o `.exe` do curso é carimbado na
exportação.

## Decisões técnicas (por ordem de importância)

### 1. Persistência do Viewer (favoritos, último módulo)
`main.js` redireciona `userData` para dentro da pasta `%TEMP%` do SFX
(cache descartável, de propósito). Consequência: **`localStorage` do Viewer
é apagado a cada fecho**. Tudo o que tem de sobreviver vai por IPC para
`%AppData%\LaunchBox Viewer\favorites\<slug>-<hash>.json`, escrita atómica
(`favs:load/save`, `state:load/save` em `main.js`). Nunca guardar estado do
aluno em `localStorage`.

### 2. YouTube (erro 152-4 / 153)
O YouTube só reproduz o leitor embutido num `<iframe>` de uma página com
origem web real. `file://` não serve; forçar `Referer` por `webRequest` não
serve. Solução: `main.js` corre um servidor HTTP em `127.0.0.1:<porta
aleatória>` (`ensureYoutubeHost`) que serve uma página mínima com o iframe;
o Viewer abre-a num `<webview>`. O mesmo servidor serve o proxy IPTV (`/iptv/`).
`app.userAgentFallback` é um UA Chrome sem "Electron" (o YouTube degrada
agentes desconhecidos).

### 3. IPTV — cadeia de motores (`src/viewer/renderer.js`, `renderIptv`)
Cada canal passa por uma lista de tentativas (`buildAttempts`), com watchdog:

| motor | quando | notas |
|---|---|---|
| `hls` (hls.js) | `.m3u8`, URLs Xtream | 1.ª escolha; reproduz a maioria |
| `proxy` (ffmpeg local) | 2.ª para Xtream; 1.ª para `.ts`/sem extensão | ver §4 |
| `ts` (mpegts.js) | último recurso | `liveBufferLatencyChasing: false` — com `true` parava de 2 em 2 s |
| `native` | ficheiros `.mp4/.mp3` | |

O sucesso é medido por **frames apresentados** (`requestVideoFrameCallback`),
não pelo evento `playing` (dispara com ecrã preto). Falha rápida no HLS: dois
segmentos anexados e `video.buffered` vazio → o Chromium está a descartar as
amostras → motor seguinte em ~2 s.

**A armadilha que custou mais:** canais 1080i (entrelaçados, típicos de
desporto europeu) chegam inteiros, hls.js/mpegts.js entregam-nos ao
MediaSource com keyframes, e o Chromium descarta tudo em silêncio, sem erro.
Sintoma: `loadedmetadata` 1920×1080, `readyState 1`, `buffer=[]`, 50
amostras/s em H.264 nível 4.0. Não há configuração de hls.js que resolva.

### 4. ffmpeg (motor `proxy`)
`vendor/ffmpeg/ffmpeg.exe` (FFmpeg 9.0.1 essentials, gyan.dev, GPL, ~98 MB) —
**fora do git** (`.gitignore`), dentro do zip de entrega; `build:all` avisa se
faltar (`scripts/check-ffmpeg.js`). O electron-builder copia-o para
`resources/ffmpeg/` no Construtor e no template do Viewer (+~90 MB por curso).

`main.js` → `serveIptvProxy`: `ffmpeg -i <url> -c:v copy -c:a aac -f mp4
-movflags frag_keyframe+empty_moov+default_base_moof pipe:1`, servido como
`video/mp4` a um `<video>` normal (descodificador nativo, sem MSE). Vídeo não é
recodificado; áudio → AAC cobre AC-3/MP2. **Não chamar `res.end()` à mão** no
`exit` do processo: o pipe termina sozinho; chamar à mão dava `write after
end` e rebentava o processo principal ao trocar de canal.

### 5. Pedidos IPTV apresentam-se como VLC
`webRequest.onBeforeSendHeaders`: para hosts anunciados pelo Viewer
(`iptv:hosts`) e destinos de redirect (mesmo `details.id`), UA `VLC/3.0.20
LibVLC/3.0.20` e sem `Origin`/`Referer`/`Sec-Fetch-*`. Só afeta pedidos do
webContents do Viewer (não os webviews).

### 6. CORS para IPTV — só na página do Viewer
`onHeadersReceived` põe `Access-Control-Allow-Origin: *` **apenas** em
respostas pedidas pelo `webContents` do Viewer (onde corre o IPTV) e nunca em
domínios Google. Antes aplicava-se à sessão inteira e partia o YouTube
(googlevideo com credenciais) → "fica a rodar aos 0:00".

### 7. Navegação do Viewer
`will-navigate` + `setWindowOpenHandler`: a janela nunca sai da sua página;
links http(s)/mailto vão para o browser do sistema. Popups do webview do
YouTube também. Um listener global de `click` no Viewer intercepta `<a href>`
de módulos HTML/artigo.

### 8. Opt-in (captura de leads)
O `preventDefault()` no submit cancelava a submissão ao fornecedor. Agora
`submitOptinForm` envia o formulário em segundo plano (`fetch` `no-cors`,
mesma codificação que o browser) e só depois fecha o portão.

### 9. Redesenho (v1.5.8–1.5.10)
- Construtor: 4 separadores (Projetos · 1 Conteúdo · 2 Aparência · 3 Publicar);
  painéis agrupados por `data-step`, opcionais recolhidos (`collapsible`);
  gravação automática ao `change` nos formulários `form.autosave`; lista de
  verificação antes de exportar. **Os ids/formulários originais não mudaram.**
- Editor de módulos: cartões por intenção (`TYPE_GROUPS`, `renderTypeCards`);
  o `<select id="module-type">` continua a existir escondido como fonte de
  verdade. Chaves i18n `content.type.*` usam `_` e os ids de tipo usam `-`
  (`TYPE_I18N` faz a ponte).
- Viewer: ícones no menu (`MODULE_ICON`), barra recolhível
  (`sidebar-collapsed`), idioma/redes no rodapé, "Começar", retoma o último
  módulo, IPTV com "Tentar novamente" e painel de diagnóstico **ⓘ** (copiar
  e colar o texto é a forma de reportar canais que não abrem).

## Regras de manutenção
- Versão só em `package.json`; `preload.js` e a etiqueta do Construtor leem-na.
- 10 locales em `locales/*.json`; ao acrescentar uma chave, acrescentar nas 10
  (há um teste de paridade fácil: as chaves de todos têm de ser iguais às de `pt.json`).
- Renderers assíncronos do Viewer usam `stageGeneration` para não desenhar
  por cima de um módulo aberto entretanto.
- Depois de mexer no Viewer: `build:all` **e** reexportar; senão o aluno não vê nada mudar.

## Histórico curto
1.5.6 favoritos persistentes · 1.5.7 YouTube via 127.0.0.1, opt-in, links,
M3U · 1.5.8–1.5.10 redesenho · 1.5.11 CORS só no Viewer · 1.5.12–1.5.18 cadeia
de motores IPTV + diagnóstico · 1.5.19 motor ffmpeg · 1.5.20 write-after-end,
`.gitignore` do ffmpeg.
