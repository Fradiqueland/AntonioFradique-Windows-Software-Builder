'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t, target = 'windows-x64') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-runtime-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  function write(relative, data) {
    const filename = path.join(directory, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, data);
    return filename;
  }
  const source = Buffer.from('exact source fixture');
  const lock = { schemaVersion: 1, sources: [{ name: 'fixture', file: 'fixture.tar.xz', url: 'https://example.invalid/fixture.tar.xz', sha256: digest(source) }] };
  write('sources/fixture.tar.xz', source);
  write('sources/recipe/scripts/build-ffmpeg.sh', '#!/bin/sh\n');
  write('sources/recipe/build-configs/ffmpeg-sources.json', JSON.stringify(lock));
  for (const license of ['licenses/ffmpeg/COPYING.GPLv2', 'licenses/x264/COPYING']) write(license, 'GNU GENERAL PUBLIC LICENSE\nVersion 2, June 1991\n');
  const binary = Buffer.alloc(256);
  if (target === 'windows-x64') {
    binary.write('MZ', 0, 'ascii'); binary.writeUInt32LE(128, 0x3c);
    binary.writeUInt32LE(0x4550, 128); binary.writeUInt16LE(0x8664, 132);
    binary.writeUInt16LE(2, 150); binary.writeUInt16LE(0x20b, 152);
  } else {
    binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(0x0100000c, 4);
  }
  const manifest = { schemaVersion: 1, target, sources: lock.sources, binaries: {}, build: { recipe: 'sources/recipe/scripts/build-ffmpeg.sh' } };
  for (const name of ['ffmpeg', 'ffprobe']) {
    const file = name + (target === 'windows-x64' ? '.exe' : '');
    fs.chmodSync(write(file, binary), 0o755);
    manifest.binaries[name] = { file, sha256: digest(binary) };
  }
  function saveManifest() { write('runtime-manifest.json', JSON.stringify(manifest)); }
  saveManifest();
  return { directory, lock, manifest, write, saveManifest };
}
function loadVerifier(lock, { spawnSync, platform = process.platform, arch = process.arch } = {}) {
  const filename = require.resolve('../scripts/check-ffmpeg');
  const requireReal = createRequire(filename);
  const module = { exports: {} };
  const replacementFs = new Proxy(fs, { get(value, key) {
    // Windows cannot preserve Unix execute bits; the simulated Mac runtime
    // needs the mode that this fixture requests with chmod(0755).
    if (key === 'statSync' && platform === 'darwin' && process.platform === 'win32') return (...args) => {
      const stat = fs.statSync(...args); stat.mode |= 0o111; return stat;
    };
    if (key !== 'readFileSync') return value[key];
    return (file, ...args) => path.resolve(String(file)) === path.resolve(__dirname, '../build-configs/ffmpeg-sources.json') ? JSON.stringify(lock) : fs.readFileSync(file, ...args);
  } });
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Buffer, console, __dirname: path.dirname(filename), module, exports: module.exports,
    process: { platform, arch },
    require(name) {
      if (name === 'node:fs') return replacementFs;
      if (name === 'node:child_process' && spawnSync) return { spawnSync };
      return requireReal(name);
    }
  }, { filename });
  return module.exports.checkFFmpeg;
}

test('runtime requires bundled pinned sources even when executable smoke is disabled', t => {
  const f = fixture(t);
  const check = loadVerifier(f.lock);
  assert.equal(check(f.directory, { target: 'windows-x64', smoke: false, verifyBinaryHashes: true }).smokeVerified, false);
  f.write('sources/fixture.tar.xz', 'modified source');
  assert.throws(() => check(f.directory, { target: 'windows-x64', smoke: false }), /source archive checksum mismatch/);
});

test('source provenance, GPL text and rebuild recipe cannot be omitted', t => {
  const f = fixture(t);
  const check = loadVerifier(f.lock);
  f.manifest.sources = [{ ...f.lock.sources[0], url: 'https://example.invalid/other.tar.xz' }];
  f.saveManifest();
  assert.throws(() => check(f.directory, { target: 'windows-x64', smoke: false }), /source provenance differs/);
  f.manifest.sources = f.lock.sources; f.saveManifest();
  f.write('licenses/x264/COPYING', 'not a license');
  assert.throws(() => check(f.directory, { target: 'windows-x64', smoke: false }), /missing GPL/);
  f.write('licenses/x264/COPYING', 'GNU GENERAL PUBLIC LICENSE\nVersion 2, June 1991');
  fs.rmSync(path.join(f.directory, 'sources/recipe/scripts/build-ffmpeg.sh'));
  assert.throws(() => check(f.directory, { target: 'windows-x64', smoke: false }), /missing required file/);
});

test('binary hashes can account for signing but machine architecture is always validated', t => {
  const f = fixture(t);
  const check = loadVerifier(f.lock);
  fs.appendFileSync(path.join(f.directory, 'ffmpeg.exe'), 'signing data');
  assert.doesNotThrow(() => check(f.directory, { target: 'windows-x64', smoke: false }));
  assert.throws(() => check(f.directory, { target: 'windows-x64', smoke: false, verifyBinaryHashes: true }), /binary checksum mismatch/);
  const file = path.join(f.directory, 'ffprobe.exe');
  const binary = fs.readFileSync(file); binary.writeUInt16LE(0x14c, 132); fs.writeFileSync(file, binary);
  assert.throws(() => check(f.directory, { target: 'windows-x64', smoke: false }), /must be an x64 executable/);
});

test('native smoke rejects an incompatible result and non-system Mac dependencies', t => {
  const f = fixture(t, 'mac-arm64');
  let nonSystem = false;
  let incorrectVideo = false;
  let smokeRuns = 0;
  const check = loadVerifier(f.lock, { platform: 'darwin', arch: 'arm64', spawnSync(executable, args) {
    let stdout = '';
    if (executable.endsWith('/otool')) stdout = 'ffmpeg:\n\t' + (nonSystem ? '/opt/homebrew/lib/libx264.dylib' : '/usr/lib/libSystem.B.dylib') + ' (compatibility version 1.0.0, current version 1.0.0)\n';
    else if (args.includes('-version')) stdout = 'ffmpeg version fixture --enable-gpl --enable-libx264';
    else if (args.includes('-protocols')) stdout = 'Input:\nhttp\nhttps\ntls\nfile\npipe\n';
    else if (args.includes('-show_streams')) stdout = JSON.stringify({ streams: [
      { codec_type: 'video', codec_name: incorrectVideo ? 'hevc' : 'h264', width: 320, height: 240, pix_fmt: 'yuv420p', field_order: 'progressive', avg_frame_rate: '30/1' },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000' }
    ] });
    else { smokeRuns++; assert.ok(args.includes('libx264')); assert.ok(args.includes('aac')); }
    return { status: 0, stdout, stderr: '' };
  } });
  assert.equal(check(f.directory, { target: 'mac-arm64' }).smokeVerified, true);
  assert.equal(smokeRuns, 1);
  incorrectVideo = true;
  assert.throws(() => check(f.directory, { target: 'mac-arm64' }), /CPU transcode did not produce progressive/);
  nonSystem = true;
  assert.throws(() => check(f.directory, { target: 'mac-arm64' }), /links a non-system library/);
});
