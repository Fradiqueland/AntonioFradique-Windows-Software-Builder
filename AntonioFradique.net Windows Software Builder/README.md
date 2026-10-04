# Windows & Mac Software Builder — v2.0.1

O Builder instala-se em Windows e macOS. Em **Exportar**, escolha o sistema operativo do software que está a criar. Cada instalador inclui os modelos dos dois sistemas.

| Sistema do Builder | Projeto para Windows | Projeto para Mac |
| --- | --- | --- |
| Windows x64 | EXE auto-extraível | ZIP: .app + .data |
| Mac universal | ZIP portátil Windows | ZIP: .app + .data |

- [Compilação, instalação e exportação](BUILD-V2.md)
- [Importação HTML/PHP](IMPORTAR-HTML-PHP.md)
- [Runtime PHP opcional](vendor/php/README.md)
- [Auditoria e limitações](AUDITORIA-2026-10-04.md)

Desenvolvimento: Node.js 22 e Windows x64 ou macOS. Execute `npm ci`, `npm test` e `npm start`.

O workflow na raiz do repositório produz os dois instaladores em máquinas nativas. Para builds locais, reúna **ambos os modelos** antes de compilar qualquer Builder, conforme o guia.
