# Windows & Mac Software Builder — v2.5

Aplicação desktop Electron para editar conteúdos e exportar produtos independentes para Windows e macOS. A apresentação do produto e os downloads atuais estão em [README.md](README.md).

## Código e comandos do produto

O código mantido da aplicação está em `Windows-Mac-Software-Builder/`. Use Node.js 22:

```bash
cd Windows-Mac-Software-Builder
npm ci
npm test
npm start
```

Electron precisa de uma sessão gráfica. Os instaladores e os modelos de exportação são compilados em Windows e macOS pelo workflow `.github/workflows/build-v2-installers.yml`. O ambiente Replit/Linux pode editar o código e executar os testes JavaScript, mas não produz o DMG Mac nativo.

## Instalação e exportação

- O Builder é distribuído como Setup EXE Windows e DMG universal Mac.
- Os produtos exportados incorporam o Viewer e os conteúdos. Windows gera EXE SFX para Windows; Mac gera ZIP portátil para Windows. Ambos geram ZIP para Mac.
- Os dados dos produtos Mac ficam numa pasta `.data` junto da `.app`, preservando a assinatura do bundle.
- FFmpeg é compilado pelo workflow a partir de fontes verificadas, incorporado no Builder e nos projetos com IPTV. PHP é opcional e precisa de preparação própria. Os projetos que não usam estes runtimes não os incluem na exportação.
- Android/APK apresenta apenas informação experimental; a importação e execução não estão disponíveis nesta versão.
- Não há exportação para iOS.

Consulte [BUILD-V2.md](Windows-Mac-Software-Builder/BUILD-V2.md), [NOTAS.md](Windows-Mac-Software-Builder/NOTAS.md) e a [auditoria](Windows-Mac-Software-Builder/AUDITORIA-2026-10-04.md).

## Outros ficheiros do repositório

As pastas `artifacts/`, `lib/` e `scripts/`, com a configuração pnpm na raiz, pertencem ao ambiente web/Replit anterior. Não são os comandos de compilação do produto Electron e não são necessários para instalar ou utilizar o Builder. Os ZIPs em `exports/` e os anexos anteriores são material histórico; use os downloads v2 indicados no README principal.

Conserve os identificadores internos de armazenamento e os formatos dos projetos ao alterar o nome público. Depois de alterar o Viewer, reconstrua os dois modelos, os instaladores e os produtos a distribuir.
