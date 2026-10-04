const fs = require('fs');
const path = require('path');
const php = path.join(__dirname, '..', 'vendor', 'php', 'php.exe');
if (fs.existsSync(php)) {
  console.log('✓ PHP portátil encontrado. Será incluído no Construtor e no Viewer.');
} else {
  console.warn('⚠ PHP portátil ausente: HTML funciona, mas módulos PHP não podem ser executados/exportados.');
  console.warn('  Prepare vendor/php conforme vendor/php/README.md antes de npm run build:all.');
}
