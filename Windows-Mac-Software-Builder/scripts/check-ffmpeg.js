#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { runtimeDirectory } = require('../build-configs/runtime-resources.cjs');
const projectRoot = path.resolve(__dirname, '..');
const targets = new Set(['windows-x64', 'mac-universal', 'mac-x64', 'mac-arm64']);

function fail(message) { throw new Error('FFmpeg runtime: ' + message); }
function regularFile(directory, relative) {
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes(':'))) fail('unsafe file path: ' + relative);
  let current = directory;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); } catch { fail('missing required file: ' + relative); }
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) fail('file must be physical: ' + relative);
  }
  return current;
}
function sha256(filename) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filename, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}
function readJson(filename, label) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { fail('invalid ' + label + '.'); }
}
function run(executable, args, label, timeout = 30000) {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const details = String(result.stderr || result.error?.message || 'exit ' + result.status).trim().slice(-2000);
    fail(label + ' failed: ' + details);
  }
  return String(result.stdout || '') + String(result.stderr || '');
}
function architectures(filename) {
  const descriptor = fs.openSync(filename, 'r');
  try {
    const header = Buffer.alloc(4096);
    const length = fs.readSync(descriptor, header, 0, header.length, 0);
    if (length < 32) fail('invalid executable header: ' + path.basename(filename));
    if (header.toString('ascii', 0, 2) === 'MZ') {
      const offset = header.readUInt32LE(0x3c);
      const pe = Buffer.alloc(26);
      if (offset < 64 || fs.readSync(descriptor, pe, 0, pe.length, offset) !== pe.length || pe.readUInt32LE(0) !== 0x4550) fail('invalid PE header.');
      if (pe.readUInt16LE(4) !== 0x8664 || !(pe.readUInt16LE(22) & 0x0002) || (pe.readUInt16LE(22) & 0x2000) || pe.readUInt16LE(24) !== 0x20b) fail('Windows binary must be an x64 executable, not a DLL.');
      return ['windows-x64'];
    }
    const magic = header.readUInt32BE(0);
    const cpuName = cpu => cpu === 0x01000007 ? 'mac-x64' : cpu === 0x0100000c ? 'mac-arm64' : 'unknown';
    if (magic === 0xcffaedfe || magic === 0xfeedfacf) {
      return [cpuName(magic === 0xcffaedfe ? header.readUInt32LE(4) : header.readUInt32BE(4))];
    }
    if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) {
      const little = magic === 0xbebafeca || magic === 0xbfbafeca;
      const read32 = offset => little ? header.readUInt32LE(offset) : header.readUInt32BE(offset);
      const stride = magic === 0xcafebabf || magic === 0xbfbafeca ? 32 : 20;
      const count = read32(4);
      if (count < 1 || count > 32 || 8 + count * stride > length) fail('invalid universal Mach-O header.');
      return Array.from({ length: count }, (_, i) => cpuName(read32(8 + i * stride)));
    }
    fail('unrecognized executable format: ' + path.basename(filename));
  } finally { fs.closeSync(descriptor); }
}
function smokeTest(ffmpeg, ffprobe) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-ffmpeg-check-'));
  try {
    const output = path.join(temporary, 'cpu-h264-aac.mp4');
    run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=352x288:rate=25:duration=1.2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1.2',
      '-map', '0:v:0', '-map', '1:a:0',
      '-vf', 'yadif=mode=send_frame:parity=auto:deint=all,scale=320:240,fps=30,format=yuv420p',
      '-af', 'aresample=48000', '-c:v', 'libx264', '-preset', 'veryfast', '-threads', '2',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-t', '1', '-movflags', '+faststart', output],
    'native CPU H.264/AAC transcode', 60000);
    let probe;
    try { probe = JSON.parse(run(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output], 'ffprobe smoke inspection')); }
    catch (error) { if (error.message.startsWith('FFmpeg runtime:')) throw error; fail('ffprobe smoke inspection returned invalid JSON.'); }
    const video = probe.streams?.find(stream => stream.codec_type === 'video');
    const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
    if (!video || video.codec_name !== 'h264' || video.width !== 320 || video.height !== 240 || video.pix_fmt !== 'yuv420p' || video.field_order !== 'progressive' || video.avg_frame_rate !== '30/1') fail('CPU transcode did not produce progressive 320x240 H.264/yuv420p at 30 fps.');
    if (!audio || audio.codec_name !== 'aac' || Number(audio.sample_rate) !== 48000) fail('CPU transcode did not produce 48 kHz AAC.');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function checkFFmpeg(directory, { target, smoke = true, verifyBinaryHashes = false } = {}) {
  if (!targets.has(target)) fail('unsupported target: ' + target);
  if (!directory) fail('runtime missing for ' + target + '; prepare the bundled runtime before packaging.');
  directory = path.resolve(directory);
  const manifest = readJson(regularFile(directory, 'runtime-manifest.json'), 'runtime manifest');
  if (manifest.schemaVersion !== 1 || manifest.target !== target || !Array.isArray(manifest.sources) || !manifest.binaries || !manifest.build || Array.isArray(manifest.build) || typeof manifest.build !== 'object' || !Object.keys(manifest.build).length) fail('runtime manifest has an invalid schema or target.');
  const lock = readJson(path.join(projectRoot, 'build-configs', 'ffmpeg-sources.json'), 'source lock');
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.sources) || !lock.sources.length || manifest.sources.length !== lock.sources.length) fail('runtime source list does not match the source lock.');
  for (const source of lock.sources) {
    if (typeof source.file !== 'string' || path.basename(source.file) !== source.file || !/^[a-f0-9]{64}$/.test(source.sha256)) fail('invalid source lock entry.');
    const matching = manifest.sources.filter(item => item.name === source.name);
    if (matching.length !== 1 || ['file', 'url', 'sha256'].some(key => matching[0][key] !== source[key])) fail('source provenance differs from the lock: ' + source.name);
    if (sha256(regularFile(directory, 'sources/' + source.file)) !== source.sha256) fail('source archive checksum mismatch: ' + source.file);
  }
  regularFile(directory, 'sources/recipe/scripts/build-ffmpeg.sh');
  const recipeLock = readJson(regularFile(directory, 'sources/recipe/build-configs/ffmpeg-sources.json'), 'bundled source lock');
  if (JSON.stringify(recipeLock) !== JSON.stringify(lock)) fail('bundled build recipe source lock differs from the official source lock.');
  for (const license of ['licenses/ffmpeg/COPYING.GPLv2', 'licenses/x264/COPYING']) {
    const text = fs.readFileSync(regularFile(directory, license), 'utf8');
    if (!text.includes('GNU GENERAL PUBLIC LICENSE') || !/Version 2, June 1991/.test(text)) fail('missing GPL version 2 license text: ' + license);
  }
  const binaries = {};
  for (const name of ['ffmpeg', 'ffprobe']) {
    const file = name + (target === 'windows-x64' ? '.exe' : '');
    const entry = manifest.binaries[name];
    if (!entry || entry.file !== file || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail('invalid binary provenance: ' + name);
    const executable = regularFile(directory, file);
    if (verifyBinaryHashes && sha256(executable) !== entry.sha256) fail('binary checksum mismatch: ' + name);
    const slices = architectures(executable);
    const expected = target === 'mac-universal' ? ['mac-x64', 'mac-arm64'] : [target];
    if (expected.some(arch => !slices.includes(arch)) || slices.length !== expected.length) fail(name + ' does not match architecture ' + target + '.');
    if (target.startsWith('mac-')) {
      if (!(fs.statSync(executable).mode & 0o111)) fail(name + ' is not executable.');
      if (process.platform === 'darwin' && target === 'mac-universal') run('/usr/bin/lipo', [executable, '-verify_arch', 'x86_64', 'arm64'], name + ' universal architecture verification');
      if (process.platform === 'darwin') {
        const dependencies = run('/usr/bin/otool', ['-L', executable], name + ' system dependency verification');
        for (const line of dependencies.split('\n')) {
          const dependency = line.match(/^\s+(\S+)\s+\(/)?.[1];
          if (dependency && !dependency.startsWith('/usr/lib/') && !dependency.startsWith('/System/Library/')) fail(name + ' links a non-system library: ' + dependency);
        }
      }
    }
    binaries[name] = executable;
  }
  if (smoke) {
    if (target === 'windows-x64' ? process.platform !== 'win32' || process.arch !== 'x64' : process.platform !== 'darwin' || (target === 'mac-x64' && process.arch !== 'x64') || (target === 'mac-arm64' && process.arch !== 'arm64')) fail('native smoke verification must run on the target operating system and architecture.');
    const version = run(binaries.ffmpeg, ['-version'], 'version check');
    if (!version.includes('--enable-gpl') || !version.includes('--enable-libx264')) fail('build must enable GPL and libx264.');
    const protocols = new Set(run(binaries.ffmpeg, ['-hide_banner', '-protocols'], 'protocol check').split(/\s+/));
    for (const protocol of ['http', 'https', 'tls', 'file', 'pipe']) if (!protocols.has(protocol)) fail('required protocol is unavailable: ' + protocol);
    smokeTest(binaries.ffmpeg, binaries.ffprobe);
  }
  return { target, directory, manifest, smokeVerified: smoke };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const target = args[0] || (process.platform === 'darwin' ? 'mac-universal' : 'windows-x64');
    const supplied = args[1];
    const relative = supplied || runtimeDirectory('ffmpeg', target);
    checkFFmpeg(relative ? path.resolve(supplied ? process.cwd() : projectRoot, relative) : null, { target, verifyBinaryHashes: true });
    console.log('Bundled FFmpeg verified for ' + target + ': sources, GPL licenses, architectures and native CPU H.264/AAC smoke test.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { checkFFmpeg };
