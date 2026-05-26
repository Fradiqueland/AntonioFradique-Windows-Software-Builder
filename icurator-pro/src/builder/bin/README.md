# Binários SFX 7-Zip

Esta pasta tem de conter **2 ficheiros** para que o Construtor consiga exportar
cursos `.exe`. São binários redistribuíveis (licenças LGPL / 7-Zip License).

## Ficheiros necessários

| Ficheiro             | Tamanho | Origem                                                |
| -------------------- | ------- | ----------------------------------------------------- |
| `7za.exe`            | ~600 KB | 7-Zip Extra — https://www.7-zip.org/download.html     |
| `7zsd_All_x64.sfx`   | ~430 KB | 7-Zip SFX Modified (chrislake fork) — ver abaixo      |

> ⚠️ **Atenção:** o módulo SFX **standard** do 7-Zip oficial (`7zSD.sfx`) é um
> *instalador*, não suporta extração silenciosa para `%TEMP%` com auto-cleanup.
> Por isso usamos a versão **modificada** do Oleg Scherbakov mantida por
> chrislake, que adiciona as diretivas `GUIMode=2`, `RunProgram` e cleanup
> automático que precisamos.

## Modo automático (recomendado)

A partir da raiz do projeto:

```bash
npm run setup:sfx
```

O script `scripts/fetch-sfx.js` descarrega os 2 ficheiros e coloca-os aqui.
Só precisa de correr **uma vez** por máquina.

## Modo manual

### 1) `7za.exe` (criador de arquivos .7z)

1. Vá a https://www.7-zip.org/download.html
2. Descarregue a linha **"7-Zip Extra: standalone console version, 7z DLL,
   plugin for Far Manager"** (`.7z`, ~1 MB)
3. Extraia o arquivo e copie `7za.exe` para esta pasta

### 2) `7zsd_All_x64.sfx` (módulo SFX modificado)

1. Vá a https://github.com/chrislake/7zsfxmm/releases (última release)
2. Descarregue `7zsd_All_x64.sfx` (ou `7zsd_All.sfx` para 32-bit; o ficheiro
   tem de chamar-se exactamente `7zsd_All_x64.sfx` aqui)
3. Copie para esta pasta

## Validação rápida

```
src/builder/bin/
├── README.md
├── 7za.exe              ← 600 KB
└── 7zsd_All_x64.sfx     ← 430 KB
```

Se algum estiver em falta, o Construtor mostra um erro claro a indicar o que
fazer quando o utilizador tenta exportar.

## Porque é que isto não está no Git?

Binários não pertencem ao repositório — são facilmente acessíveis a partir dos
sites oficiais e respeitam as suas próprias licenças de redistribuição. Quando
empacotar o Construtor (`npm run build:builder`), eles são embutidos como
`extraResources` e viajam dentro do instalador final do Construtor — o
utilizador final do Construtor **não** precisa de fazer nada disto.
