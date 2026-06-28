/*
 * check-viewer-template.js — guarda de pré-compilação do Construtor.
 *
 * Verifica que o template do Viewer (win-unpacked) existe E contém
 * resources/app.asar ANTES de empacotar o Construtor. Sem este ficheiro,
 * o electron-builder produz um instalador onde resources/viewer-template/
 * fica sem app.asar, e a exportação de cursos rebenta com:
 *   ENOENT ... resources\viewer-template\resources\app.asar
 *
 * Em vez de gerar um instalador silenciosamente partido, falhamos aqui
 * com instruções claras.
 */
const fs = require('fs');
const path = require('path');

const TEMPLATE_DIR = path.join(
  __dirname, '..', 'src', 'builder', 'templates', 'viewer-core', 'win-unpacked'
);
const ASAR_PATH = path.join(TEMPLATE_DIR, 'resources', 'app.asar');

if (!fs.existsSync(TEMPLATE_DIR) || !fs.existsSync(ASAR_PATH)) {
  console.error('');
  console.error('✗ Template do Viewer em falta ou incompleto.');
  console.error('  Esperado: ' + ASAR_PATH);
  console.error('');
  console.error('  Sem este ficheiro o instalador do Construtor fica sem');
  console.error('  viewer-template/resources/app.asar e a exportação falha com ENOENT.');
  console.error('');
  console.error('  >> Execute PRIMEIRO:        npm run build:viewer-template');
  console.error('  >> Ou faça tudo de uma vez: npm run build:all');
  console.error('');
  process.exit(1);
}

console.log('✓ Template do Viewer presente: ' + ASAR_PATH);
