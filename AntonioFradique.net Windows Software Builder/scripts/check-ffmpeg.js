#!/usr/bin/env node
/**
 * check-ffmpeg.js — aviso (não bloqueante) se vendor/ffmpeg/ffmpeg.exe faltar.
 * O binário não está no git (ver .gitignore); sem ele o Viewer perde o motor
 * de retransmissão local (canais IPTV 1080i / AC-3) mas tudo o resto funciona.
 */
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'vendor', 'ffmpeg');
const exe = ['ffmpeg.exe', 'ffmpeg'].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
if (exe) {
  console.log('✓ ffmpeg encontrado: ' + exe + ' (' + (fs.statSync(exe).size / 1048576).toFixed(1) + ' MB) — vai para resources/ffmpeg/');
} else {
  console.warn('');
  console.warn('⚠ vendor/ffmpeg/ffmpeg.exe em falta.');
  console.warn('  O Viewer fica SEM o motor ffmpeg (canais IPTV entrelaçados 1080i e áudio AC-3 não abrem).');
  console.warn('  Ver vendor/ffmpeg/README.txt para obter o binário. A compilação continua.');
  console.warn('');
}
