#!/usr/bin/env node
/**
 * fetch-sfx.js — descarrega os binários SFX 7-Zip necessários para a
 * exportação de cursos para src/builder/bin/.
 *
 * Corra UMA VEZ por máquina:   npm run setup:sfx
 *
 * O que faz:
 *   1. Descarrega 7zr.exe (extractor standalone) do 7-zip.org
 *   2. Descarrega 7-Zip Extra (.7z) do 7-zip.org
 *   3. Usa 7zr.exe para extrair 7za.exe do Extra
 *   4. Descarrega 7zsd_All_x64.sfx do GitHub chrislake/7zsfxmm
 *
 * Segurança (TOFU — Trust-On-First-Use):
 *   - Os SHA-256 conhecidos podem ser fixados em scripts/sfx-hashes.json.
 *   - Se o ficheiro existir, qualquer download cujo hash NÃO BATE com o
 *     pinado falha imediatamente e o binário é apagado (fail-closed).
 *   - Se o ficheiro NÃO existir, o script grava o hash observado e mostra
 *     um aviso — a partir desse momento o pin está activo.
 *   - Para revogar/atualizar binários, apague src/builder/bin/* e
 *     scripts/sfx-hashes.json.
 *
 * Se algum URL mudar ou estiver offline, o script falha com instruções
 * para download manual (ver src/builder/bin/README.md).
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const BIN_DIR = path.join(__dirname, '..', 'src', 'builder', 'bin');
const HASHES_FILE = path.join(__dirname, 'sfx-hashes.json');
const README_HINT = 'Consulte src/builder/bin/README.md para download manual.';

// URLs estáveis. O 7-zip.org tira URLs directas quando lança versão nova
// (o ficheiro 7z2409-extra.7z passou a dar 404 quando saiu a 24.10), por
// isso usamos o repo oficial GitHub do Igor Pavlov (ip7z/7zip), onde as
// releases têm URLs permanentes que não desaparecem.
const URL_7ZR = 'https://github.com/ip7z/7zip/releases/download/24.09/7zr.exe';
const URL_7Z_EXTRA = 'https://github.com/ip7z/7zip/releases/download/24.09/7z2409-extra.7z';
const URL_SFX_MOD = 'https://github.com/chrislake/7zsfxmm/releases/download/1.7.1.3937/7zsd_All_x64.sfx';

function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); try { fs.unlinkSync(dest); } catch (_) {}
        if (redirectsLeft <= 0) return reject(new Error('Demasiados redirects: ' + url));
        return resolve(download(res.headers.location, dest, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        file.close(); try { fs.unlinkSync(dest); } catch (_) {}
        return reject(new Error('HTTP ' + res.statusCode + ' ao descarregar ' + url));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    });
    req.on('error', (err) => { file.close(); try { fs.unlinkSync(dest); } catch (_) {} reject(err); });
  });
}

function sha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function loadHashes() {
  try { return JSON.parse(fs.readFileSync(HASHES_FILE, 'utf-8')); }
  catch (_) { return {}; }
}

function saveHashes(obj) {
  fs.writeFileSync(HASHES_FILE, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

/**
 * Verifica o hash do ficheiro descarregado contra o lockfile.
 * - Se já existe pin e bate certo: OK.
 * - Se já existe pin e NÃO bate: apaga o ficheiro e atira erro (fail-closed).
 * - Se ainda não há pin: regista o hash observado (TOFU) e avisa o utilizador.
 */
function verifyAndPin(label, filePath, hashes) {
  const observed = sha256(filePath);
  const pinned = hashes[label];
  if (pinned) {
    if (pinned !== observed) {
      try { fs.unlinkSync(filePath); } catch (_) {}
      throw new Error(
        'SHA-256 não bate para ' + label + '!\n' +
        '  esperado: ' + pinned + '\n' +
        '  obtido:   ' + observed + '\n' +
        '  Possível MITM ou binário corrompido. Apague scripts/sfx-hashes.json para refazer o pin.'
      );
    }
    console.log('  ✓ SHA-256 verificado para ' + label);
  } else {
    hashes[label] = observed;
    saveHashes(hashes);
    console.log('  ▸ Hash fixado (TOFU) para ' + label + ': ' + observed);
  }
}

async function main() {
  if (process.platform !== 'win32') {
    console.warn('⚠ Aviso: estes binários só funcionam em Windows. A continuar mesmo assim…');
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const hashes = loadHashes();
  const isFirstRun = Object.keys(hashes).length === 0;
  if (isFirstRun) {
    console.warn('⚠ Sem pin SHA-256 conhecido — vai ser criado em ' + HASHES_FILE);
    console.warn('  Confie apenas se executar este script em rede de confiança.');
  }

  const dest7za = path.join(BIN_DIR, '7za.exe');
  const destSfx = path.join(BIN_DIR, '7zsd_All_x64.sfx');

  if (fs.existsSync(dest7za) && fs.existsSync(destSfx) && hashes['7za.exe'] && hashes['7zsd_All_x64.sfx']) {
    // Já estão cá e fixados — só re-verificar.
    verifyAndPin('7za.exe', dest7za, hashes);
    verifyAndPin('7zsd_All_x64.sfx', destSfx, hashes);
    console.log('✓ Binários já existem e estão verificados em ' + BIN_DIR);
    console.log('  Apague-os para forçar nova descarga.');
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lbpro-sfx-'));

  try {
    // 1. 7zr.exe (para conseguir extrair o .7z do Extra)
    const dest7zr = path.join(BIN_DIR, '7zr.exe');
    if (!fs.existsSync(dest7zr) || !hashes['7zr.exe']) {
      console.log('▸ A descarregar 7zr.exe…');
      await download(URL_7ZR, dest7zr);
      verifyAndPin('7zr.exe', dest7zr, hashes);
    }

    // 2. 7-Zip Extra (.7z) — contém 7za.exe
    if (!fs.existsSync(dest7za) || !hashes['7za.exe']) {
      console.log('▸ A descarregar 7-Zip Extra…');
      const extraArchive = path.join(tmp, '7z-extra.7z');
      await download(URL_7Z_EXTRA, extraArchive);
      verifyAndPin('7z-extra.7z', extraArchive, hashes);
      console.log('▸ A extrair 7za.exe…');
      await execFileP(dest7zr, ['x', extraArchive, '-o' + tmp, '-y', '7za.exe'], { windowsHide: true });
      const extracted = path.join(tmp, '7za.exe');
      if (!fs.existsSync(extracted)) throw new Error('7za.exe não encontrado no Extra. ' + README_HINT);
      fs.copyFileSync(extracted, dest7za);
      verifyAndPin('7za.exe', dest7za, hashes);
    }

    // 3. Módulo SFX modificado (chrislake fork)
    if (!fs.existsSync(destSfx) || !hashes['7zsd_All_x64.sfx']) {
      console.log('▸ A descarregar 7zsd_All_x64.sfx (fork chrislake)…');
      await download(URL_SFX_MOD, destSfx);
      verifyAndPin('7zsd_All_x64.sfx', destSfx, hashes);
    }

    console.log('');
    console.log('✓ Tudo pronto! Binários instalados em:');
    console.log('  ' + dest7za);
    console.log('  ' + destSfx);
    console.log('  Hashes fixados em: ' + HASHES_FILE);
  } catch (err) {
    console.error('');
    console.error('✗ Falhou: ' + (err && err.message ? err.message : err));
    console.error('  ' + README_HINT);
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

main();
