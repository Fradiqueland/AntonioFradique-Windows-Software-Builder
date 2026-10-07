#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const lock = require('../build-configs/ffmpeg-sources.json');
const root = path.resolve(__dirname, '..');
const targets = ['windows-x64', 'mac-x64', 'mac-arm64'];
const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function prepare(target) {
  if (!targets.includes(target)) throw new Error('Choose windows-x64, mac-x64 or mac-arm64.');
  const base = path.join(root, 'dist/ffmpeg-build', target);
  const archiveDir = path.join(root, 'dist/ffmpeg-sources');
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const source of lock.sources) {
    const archive = path.join(archiveDir, source.file);
    if (!fs.existsSync(archive) || hashFile(archive) !== source.sha256) {
      const partial = archive + '.partial';
      try {
        const response = await fetch(source.url, { signal: AbortSignal.timeout(180000) });
        if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + source.url);
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
        if (hashFile(partial) !== source.sha256) throw new Error('Source SHA-256 mismatch: ' + source.name);
        fs.renameSync(partial, archive);
      } finally {
        fs.rmSync(partial, { force: true });
      }
    }
    const extracted = path.join(base, source.directory);
    // A fresh extraction also prevents stale configure output from changing a rebuild.
    fs.rmSync(extracted, { recursive: true, force: true });
    // Relative archive names avoid GNU tar interpreting a Windows drive colon
    // as a remote host when this process runs inside MSYS2.
    const result = spawnSync('tar', ['--no-same-owner', '-xf', source.file, '-C', path.relative(archiveDir, base).split(path.sep).join('/')], { cwd: archiveDir, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('Cannot extract verified source ' + source.file + ': ' + (result.error || result.status));
    if (!fs.statSync(path.join(extracted, 'configure')).isFile()) throw new Error('Invalid source archive: ' + source.name);
    console.log('Verified source ' + source.name + ' ' + source.version + ' (' + source.sha256 + ')');
  }
}

if (require.main === module) prepare(process.argv[2]).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepare, hashFile };
