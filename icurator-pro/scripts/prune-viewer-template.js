#!/usr/bin/env node
/**
 * prune-viewer-template.js — limpa o template do Viewer (pasta win-unpacked
 * gerada pelo electron-builder) ANTES de ser embebido no .exe final do curso.
 *
 * Objectivos:
 *   1. Reduzir o tamanho final do .exe (cada curso pesa menos no disco).
 *   2. Reduzir falsos positivos de antivírus (ficheiros de símbolos .pdb
 *      em particular disparam heurísticas).
 *
 * O que apaga:
 *   - Todos os .pak nativos do Electron em locales/ EXCEPTO en-US, pt-BR, pt-PT.
 *     (Estes .pak são as traduções da UI nativa do Chromium — não confundir
 *     com as nossas locales/*.json na raiz, que são para a UI da aplicação.)
 *   - Todos os .pdb (símbolos de debug nativos do Electron/Chromium).
 *   - LICENSE.electron.txt + LICENSES.chromium.html (~9 MB combinados, não
 *     são exigidos legalmente se o ficheiro de licença Electron principal
 *     permanecer no asar).
 *
 * Corre automaticamente após o electron-builder no script
 * `npm run build:viewer-template`.
 */
const fs = require('fs');
const path = require('path');

const TEMPLATE_DIR = path.join(
  __dirname, '..', 'src', 'builder', 'templates', 'viewer-core', 'win-unpacked'
);

// .pak a MANTER (Chromium UI locales). Tudo o resto vai abaixo.
const KEEP_PAKS = new Set(['en-US.pak', 'pt-BR.pak', 'pt-PT.pak']);

function fmtMB(bytes) { return (bytes / (1024 * 1024)).toFixed(2) + ' MB'; }

function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else { try { total += fs.statSync(p).size; } catch (_) {} }
  }
  return total;
}

function main() {
  if (!fs.existsSync(TEMPLATE_DIR)) {
    console.error('✗ Template do Viewer não encontrado em: ' + TEMPLATE_DIR);
    console.error('  Corra primeiro: npx electron-builder --config build-configs/viewer-template.json --win --x64');
    process.exit(1);
  }

  const sizeBefore = dirSize(TEMPLATE_DIR);
  console.log('▸ Tamanho antes da limpeza: ' + fmtMB(sizeBefore));

  let removed = 0;
  let freed = 0;

  /* 1. Apagar .pak excluídos. */
  const localesDir = path.join(TEMPLATE_DIR, 'locales');
  if (fs.existsSync(localesDir)) {
    for (const f of fs.readdirSync(localesDir)) {
      if (!f.endsWith('.pak')) continue;
      if (KEEP_PAKS.has(f)) continue;
      const p = path.join(localesDir, f);
      try {
        freed += fs.statSync(p).size;
        fs.unlinkSync(p);
        removed++;
      } catch (_) { /* skip */ }
    }
    console.log('  ✓ Apagados ' + removed + ' ficheiros .pak (mantidos: ' + [...KEEP_PAKS].join(', ') + ')');
  } else {
    console.warn('  ⚠ Pasta locales/ não encontrada — saltado');
  }

  /* 2. Apagar .pdb recursivamente em qualquer subdir. */
  let pdbCount = 0;
  function walkAndRemovePdb(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walkAndRemovePdb(p); continue; }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdb')) {
        try {
          freed += fs.statSync(p).size;
          fs.unlinkSync(p);
          pdbCount++;
        } catch (_) { /* skip */ }
      }
    }
  }
  walkAndRemovePdb(TEMPLATE_DIR);
  console.log('  ✓ Apagados ' + pdbCount + ' ficheiros .pdb');

  /* 3. Apagar licenças volumosas redundantes (electron-builder já mantém
   *    LICENSE no asar; estes ficheiros de texto soltos só inflam). */
  for (const name of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) {
    const p = path.join(TEMPLATE_DIR, name);
    if (fs.existsSync(p)) {
      try {
        freed += fs.statSync(p).size;
        fs.unlinkSync(p);
        console.log('  ✓ Apagado ' + name);
      } catch (_) { /* skip */ }
    }
  }

  /* 4. Renomear resources/app.asar → resources/app.asar.bin.
   *    CRÍTICO: o electron-builder DESCARTA silenciosamente ficheiros chamados
   *    app.asar quando copia uma pasta via "extraResources" (trata-os como o
   *    asar da própria app). Resultado: o instalador do Construtor ficava com
   *    resources/viewer-template/resources/ SEM app.asar e a exportação de
   *    cursos rebentava com ENOENT ...viewer-template\resources\app.asar.
   *    Com a extensão .bin o ficheiro deixa de ser tratado como asar e é
   *    copiado normalmente. O export (main.js) volta a renomear para app.asar
   *    ao montar o SFX, para o Electron do curso o carregar no arranque. */
  const asarSrc = path.join(TEMPLATE_DIR, 'resources', 'app.asar');
  const asarBin = path.join(TEMPLATE_DIR, 'resources', 'app.asar.bin');
  if (fs.existsSync(asarSrc)) {
    if (fs.existsSync(asarBin)) fs.unlinkSync(asarBin);
    fs.renameSync(asarSrc, asarBin);
    console.log('  ✓ app.asar → app.asar.bin (evita o descarte do electron-builder)');
  } else if (fs.existsSync(asarBin)) {
    console.log('  ✓ app.asar.bin já presente (template já preparado)');
  } else {
    console.error('✗ AVISO: resources/app.asar não encontrado — template incompleto?');
  }

  const sizeAfter = dirSize(TEMPLATE_DIR);
  console.log('');
  console.log('✓ Limpeza concluída.');
  console.log('  Antes:  ' + fmtMB(sizeBefore));
  console.log('  Depois: ' + fmtMB(sizeAfter));
  console.log('  Poupado: ' + fmtMB(freed));
}

main();
