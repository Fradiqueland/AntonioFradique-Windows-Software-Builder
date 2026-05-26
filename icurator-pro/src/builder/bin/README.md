# Binários SFX 7-Zip (commitados no repositório)

Esta pasta contém os 2 binários que o Construtor usa para gerar o `Curso.exe`
de cada projecto. **Estão commitados directamente no git** (~1,5 MB no total)
para garantir builds offline e sem fricção — não há `npm run setup:sfx`, não
há downloads na primeira utilização, e funciona em qualquer máquina sem
internet.

## Ficheiros

| Ficheiro             | Tamanho | Origem (uma única vez)                                                                          |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `7za.exe`            | 1,3 MB  | 7-Zip Extra 24.09 (`x64/7za.exe`) — https://github.com/ip7z/7zip/releases/tag/24.09             |
| `7zsd_All_x64.sfx`   | 191 KB  | 7-Zip SFX Modified (chrislake fork) v1.7.1.3901 — https://github.com/chrislake/7zsfxmm/releases |
| `LICENSE-7zip.txt`   | 5 KB    | Licença do 7-Zip (LGPL-2.1 + unRAR restriction), redistribuída conforme exigido                 |

> O módulo SFX **standard** do 7-Zip oficial (`7zSD.sfx`) é um *instalador* e
> não suporta extracção silenciosa para `%TEMP%` com auto-cleanup. Por isso
> usamos a versão **modificada** do Oleg Scherbakov mantida por chrislake, que
> adiciona as directivas `GUIMode=2`, `RunProgram` e cleanup automático que
> precisamos para o fluxo "duplo-clique → curso abre → fechar limpa tudo".

## Hashes SHA-256 (verificação)

```
7za.exe              fbb3dadcc29bcbc5460484d858c5f33f99e5317f5f6cd8d9c83f4dd8c39b3e30
7zsd_All_x64.sfx     56642f9ed03cd60fd9a69695f098957767d9570ffe1d5d970b38ba6b6b1a2936
```

## Como o Construtor os usa

Em desenvolvimento, o `main.js` lê-os directamente de
`src/builder/bin/`. Em produção (após `npm run build:builder`), o
`electron-builder` copia esta pasta inteira para os `extraResources` do
instalador do Construtor (mapeada para `resources/sfx/`), pelo que o
utilizador final do Construtor não precisa de fazer nada — basta abrir o
Construtor e exportar.

## Como actualizar (quando sair uma versão nova do 7-Zip)

1. Descarregar `7z<VVVV>-extra.7z` da release oficial em
   https://github.com/ip7z/7zip/releases
2. Extrair `x64/7za.exe` e substituir o ficheiro nesta pasta
3. Actualizar o hash SHA-256 acima e committar

Para o `7zsd_All_x64.sfx` é raríssimo precisar de actualização — só sai
versão nova quando o módulo SFX modificado for actualizado pelo chrislake.
