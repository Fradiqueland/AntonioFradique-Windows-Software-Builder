'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const yauzl = require('yauzl');
const yazl = require('yazl');
const { pipeline } = require('node:stream/promises');

const sourceBytes = [Buffer.from('Exact FFmpeg source archive\n'.repeat(128)), Buffer.from('Exact x264 source archive\n'.repeat(128))];
const productionLock = require('../src/shared/ffmpeg-source-lock').FFMPEG_SOURCE_LOCK;
const syntheticLock = productionLock.map((source, index) => ({ file: source.file, sha256: crypto.createHash('sha256').update(sourceBytes[index]).digest('hex'), size: sourceBytes[index].length }));

function harness() {
  const cache = new Map();
  const scripts = path.resolve(__dirname, '../scripts');
  function load(file) {
    file = require.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const localRequire = request => {
      if (request === '../src/shared/ffmpeg-source-lock') return { FFMPEG_SOURCE_LOCK: syntheticLock };
      if (request.startsWith('.') && ['template-sources.js', 'template-archive.js'].includes(path.basename(require.resolve(path.resolve(path.dirname(file), request))))) return load(path.resolve(path.dirname(file), request));
      return require(request.startsWith('.') ? path.resolve(path.dirname(file), request) : request);
    };
    const context = { require: localRequire, module, exports: module.exports, __dirname: path.dirname(file), __filename: file, process, Buffer, console };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    return module.exports;
  }
  return { ...load(path.join(scripts, 'deduplicate-template-sources.js')), ...load(path.join(scripts, 'template-archive.js')) };
}

async function entries(file) {
  const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false }, (error, result) => error ? reject(error) : resolve(result)));
  const found = [];
  try {
    await new Promise((resolve, reject) => { zip.on('error', reject); zip.on('end', resolve); zip.on('entry', entry => { found.push(entry); zip.readEntry(); }); zip.readEntry(); });
    const result = new Map();
    for (const entry of found) {
      const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)));
      const data = [];
      for await (const chunk of stream) data.push(chunk);
      result.set(entry.fileName, { data: Buffer.concat(data), mode: entry.externalFileAttributes >>> 16, offset: entry.relativeOffsetOfLocalHeader });
    }
    return result;
  } finally { zip.close(); }
}

async function fixture(t, target, { badTemplateSource = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-source-dedup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sharedRuntimeSourcesDir = path.join(directory, 'shared-sources');
  fs.mkdirSync(sharedRuntimeSourcesDir);
  syntheticLock.forEach((source, index) => fs.writeFileSync(path.join(sharedRuntimeSourcesDir, source.file), sourceBytes[index]));
  const engine = harness();
  const archivePath = path.join(directory, target + '.zip');
  const runtimeRoot = (target === 'windows-x64' ? 'resources' : 'LaunchBox Viewer.data') + '/ffmpeg';
  const archive = new yazl.ZipFile();
  const completion = pipeline(archive.outputStream, fs.createWriteStream(archivePath));
  for (const name of engine.layouts[target].required) archive.addBuffer(Buffer.from(name.endsWith('app-mode.json') ? '{"mode":"viewer"}' : name.endsWith('app.asar') ? 'ASAR ORIGINAL BYTES' : 'SEALED ORIGINAL BYTES'), name, { mode: name.includes('/MacOS/') ? 0o100755 : 0o100644, compress: false });
  if (target === 'mac-universal') {
    archive.addBuffer(Buffer.from('A'), 'LaunchBox Viewer.app/Contents/Frameworks/Test.framework/Versions/Current', { mode: 0o120755, compress: false });
    archive.addBuffer(Buffer.from('NATIVE FFMPEG'), runtimeRoot + '/ffmpeg', { mode: 0o100755 });
  } else archive.addBuffer(Buffer.from('NATIVE FFMPEG'), runtimeRoot + '/ffmpeg.exe', { mode: 0o100755 });
  archive.addBuffer(Buffer.from('LICENSE ORIGINAL BYTES'), runtimeRoot + '/licenses/COPYING', { mode: 0o100644 });
  archive.addBuffer(Buffer.from('RECIPE ORIGINAL BYTES'), runtimeRoot + '/sources/recipe/build.sh', { mode: 0o100644 });
  for (let i = 0; i < syntheticLock.length; i++) archive.addBuffer(badTemplateSource && i === 0 ? Buffer.alloc(sourceBytes[i].length, 1) : sourceBytes[i], runtimeRoot + '/sources/' + syntheticLock[i].file, { mode: 0o100644 });
  archive.end(); await completion;
  const manifestPath = path.join(directory, target + '.manifest.json');
  const manifest = { formatVersion: 1, target, appVersion: require('../package.json').version, sourceCommit: 'original', sha256: await engine.sha256(archivePath), ...await engine.inspectTemplate(archivePath, target) };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { directory, target, sharedRuntimeSourcesDir, archivePath, manifestPath, runtimeRoot, engine };
}

for (const target of ['windows-x64', 'mac-universal']) test('Source dedup preserves every retained byte/mode and the full physical source copy: ' + target, async t => {
  const f = await fixture(t, target);
  const baseline = await entries(f.archivePath);
  const result = await f.engine.deduplicateTemplate(f);
  assert.equal(result.removedSourceBytes, syntheticLock.reduce((sum, source) => sum + source.size, 0));
  const output = await entries(f.archivePath);
  for (const [name, entry] of baseline) {
    if (syntheticLock.some(source => name === f.runtimeRoot + '/sources/' + source.file)) { assert.ok(!output.has(name)); continue; }
    assert.deepEqual(output.get(name).data, entry.data, name); assert.equal(output.get(name).mode, entry.mode, name);
  }
  assert.deepEqual(JSON.parse(output.get(f.runtimeRoot + '/template-sources.json').data.toString()), { schemaVersion: 1, sources: syntheticLock });
  syntheticLock.forEach((source, index) => assert.deepEqual(fs.readFileSync(path.join(f.sharedRuntimeSourcesDir, source.file)), sourceBytes[index]));
  const manifest = JSON.parse(fs.readFileSync(f.manifestPath));
  assert.equal(manifest.sha256, await f.engine.sha256(f.archivePath));
  assert.equal(manifest.sourceLayout, 'shared-in-builder-v1');
  const hash = manifest.sha256;
  const again = await f.engine.deduplicateTemplate(f);
  assert.equal(again.unchanged, true); assert.equal(await f.engine.sha256(f.archivePath), hash);
});

test('Source dedup rejects missing, damaged and symlinked shared archives without changing the template', async t => {
  for (const kind of ['missing', 'damaged', ...(process.platform === 'win32' ? [] : ['symlink'])]) {
    const f = await fixture(t, 'windows-x64');
    const zipBefore = fs.readFileSync(f.archivePath); const manifestBefore = fs.readFileSync(f.manifestPath);
    const source = path.join(f.sharedRuntimeSourcesDir, syntheticLock[0].file);
    if (kind === 'missing') fs.rmSync(source);
    else if (kind === 'damaged') fs.writeFileSync(source, Buffer.alloc(syntheticLock[0].size, 9));
    else { const moved = path.join(f.directory, 'source-copy'); fs.renameSync(source, moved); fs.symlinkSync(moved, source); }
    await assert.rejects(f.engine.deduplicateTemplate(f));
    assert.deepEqual(fs.readFileSync(f.archivePath), zipBefore); assert.deepEqual(fs.readFileSync(f.manifestPath), manifestBefore);
  }
});

test('Source dedup rejects a different template source archive and corrupted retained bytes atomically', async t => {
  for (const kind of ['source', 'retained']) {
    const f = await fixture(t, 'windows-x64', { badTemplateSource: kind === 'source' });
    if (kind === 'retained') {
      const archiveEntries = await entries(f.archivePath);
      const offset = archiveEntries.get('resources/app.asar').offset;
      const bytes = fs.readFileSync(f.archivePath);
      const dataOffset = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
      bytes[dataOffset] ^= 1; fs.writeFileSync(f.archivePath, bytes);
      const manifest = JSON.parse(fs.readFileSync(f.manifestPath)); manifest.sha256 = await f.engine.sha256(f.archivePath); fs.writeFileSync(f.manifestPath, JSON.stringify(manifest));
    }
    const zipBefore = fs.readFileSync(f.archivePath); const manifestBefore = fs.readFileSync(f.manifestPath);
    await assert.rejects(f.engine.deduplicateTemplate(f), kind === 'source' ? /differs from the shared physical source/ : /CRC/);
    assert.deepEqual(fs.readFileSync(f.archivePath), zipBefore); assert.deepEqual(fs.readFileSync(f.manifestPath), manifestBefore);
    assert.ok(!fs.readdirSync(f.directory).some(name => name.endsWith('.tmp') || name.endsWith('.original')));
  }
});
