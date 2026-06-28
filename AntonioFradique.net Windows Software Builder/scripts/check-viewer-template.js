/*
 * check-viewer-template.js — guarda de pré-compilação do Construtor.
 *
 * Verifica que o template do Viewer (win-unpacked) existe E contém o código do
 * Viewer (resources/app.asar.bin, ou app.asar legado) ANTES de empacotar o
 * Construtor. Sem este ficheiro, o electron-builder produz um instalador onde
 * resources/viewer-template/ fica sem o asar do Viewer, e a exportação de
 * cursos rebenta com:
 *   ENOENT ... resources\viewer-template\resources\app.asar
 *
 * Nota: o asar é guardado como app.asar.bin (renomeado pelo prune) porque o
 * electron-builder DESCARTA ficheiros chamados app.asar ao copiar via
 * extraResources. O export volta a renomear para app.asar ao montar o SFX.
 *
 * Em vez de gerar um instalador silenciosamente partido, falhamos aqui com
 * instruções claras.
 */
const fs = require('fs');
const path = require('path');

const TEMPLATE_DIR = path.join(
  __dirname, '..', 'src', 'builder', 'templates', 'viewer-core', 'win-unpacked'
);
const ASAR_BIN = path.join(TEMPLATE_DIR, 'resources', 'app.asar.bin');
const ASAR_RAW = path.join(TEMPLATE_DIR, 'resources', 'app.asar');

if (!fs.existsSync(TEMPLATE_DIR) || (!fs.existsSync(ASAR_BIN) && !fs.existsSync(ASAR_RAW))) {
  console.error('');
  console.error('✗ Template do Viewer em falta ou incompleto.');
  console.error('  Esperado: ' + ASAR_BIN);
  console.error('       (ou: ' + ASAR_RAW + ')');
  console.error('');
  console.error('  Sem este ficheiro o instalador do Construtor fica sem o asar');
  console.error('  do Viewer e a exportação de cursos falha com ENOENT.');
  console.error('');
  console.error('  >> Execute PRIMEIRO:        npm run build:viewer-template');
  console.error('  >> Ou faça tudo de uma vez: npm run build:all');
  console.error('');
  process.exit(1);
}

console.log('✓ Template do Viewer presente: '
  + (fs.existsSync(ASAR_BIN) ? ASAR_BIN : ASAR_RAW));
