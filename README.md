# Windows & Mac Software Builder — v2.0.0

O Builder instala-se em Windows ou Mac e cria aplicações independentes para ambos os sistemas. Em **Exportar**, escolha **Windows** ou **Mac**.

| Sistema do Builder | Projeto para Windows | Projeto para Mac |
| --- | --- | --- |
| Windows x64 | EXE único auto-extraível | ZIP com .app universal e pasta .data |
| Mac Intel / Apple Silicon | ZIP portátil com EXE e dependências | ZIP com .app universal e pasta .data |

Os instaladores do **Builder** são um Setup EXE e um DMG. Ambos incluem os dois modelos de exportação. São diferentes dos softwares criados pelo utilizador, que funcionam sem instalar o Builder.

O código mantém a pasta original para preservar os caminhos existentes.

- [Criar os dois instaladores, instalar e exportar](AntonioFradique.net%20Windows%20Software%20Builder/BUILD-V2.md)
- [Importar HTML/PHP e conhecer os limites](AntonioFradique.net%20Windows%20Software%20Builder/IMPORTAR-HTML-PHP.md)
- [Auditoria do produto](AntonioFradique.net%20Windows%20Software%20Builder/AUDITORIA-2026-10-04.md)

O workflow **Build v2 Windows and Mac installers** compila nativamente os dois modelos e os dois instaladores. Consulte o estado da execução e descarregue os seus artefactos no GitHub Actions.

Desenvolvimento: Node.js 22, Windows x64 ou macOS.

```bash
cd "AntonioFradique.net Windows Software Builder"
npm ci
npm test
npm start
```

PHP e ffmpeg são opcionais e não estão incluídos no Git. HTML funciona sem PHP. Esta versão não exporta para iOS.
