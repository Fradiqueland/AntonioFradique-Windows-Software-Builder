'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { pipeline } = require('stream/promises');
const { Transform } = require('node:stream');
const yazl = require('yazl');
const yauzl = require('yauzl');
const { exportProject, extractWindowsTemplate, inspectProjectAssets, projectRuntimeRequirements, safeProjectName } = require('../src/shared/project-export');
const { importPortableProject } = require('../src/shared/portable-app');
const { FFMPEG_SOURCE_LOCK } = require('../src/shared/ffmpeg-source-lock');

const APP = 'LaunchBox Viewer.app';
const WINDOWS = [
  { name: 'LaunchBox Viewer.exe', data: 'WINDOWS EXE', mode: 0o100755 },
  { name: 'resources/app.asar', data: 'VIEWER SOURCE' },
  { name: 'resources/app-mode.json', data: '{"mode":"viewer"}' },
  { name: 'resources/', mode: 0o040755 }
];
const MAC = [
  { name: `${APP}/Contents/Info.plist`, data: 'SIGNED PLIST' },
  { name: `${APP}/Contents/Resources/app.asar`, data: 'SIGNED SOURCE' },
  { name: `${APP}/Contents/MacOS/LaunchBox Viewer`, data: 'MACH-O UNIVERSAL', mode: 0o100755 },
  { name: `${APP}/Contents/_CodeSignature/CodeResources`, data: 'SEALED HASHES' },
  { name: `${APP}/Contents/Frameworks/Test.framework/Versions/A/Test`, data: 'SIGNED FRAMEWORK', mode: 0o100755 },
  { name: `${APP}/Contents/Frameworks/Test.framework/Versions/Current`, data: 'A', mode: 0o120777 },
  { name: `${APP}/Contents/Frameworks/Test.framework/Test`, data: 'Versions/Current/Test', mode: 0o120777 },
  { name: `${APP}/`, mode: 0o040755 },
  { name: `${APP}/Contents/`, mode: 0o040755 },
  { name: `${APP}/Contents/Resources/`, mode: 0o040755 },
  { name: `${APP}/Contents/Resources/empty-directory/`, mode: 0o040750 }
];

function runtimeEntries(target) {
  const base = target === 'windows' ? 'resources' : 'LaunchBox Viewer.data';
  const extension = target === 'windows' ? '.exe' : '';
  return [
    { name: `${base}/ffmpeg/`, mode: 0o040755 },
    { name: `${base}/ffmpeg/ffmpeg${extension}`, data: crypto.randomBytes(96 * 1024), mode: 0o100755 },
    { name: `${base}/ffmpeg/ffprobe${extension}`, data: 'PROBE', mode: 0o100755 },
    { name: `${base}/ffmpeg/COPYING.GPLv2`, data: 'FULL RUNTIME LICENCE' },
    { name: `${base}/ffmpeg/sources/ffmpeg-source.tar.xz`, data: crypto.randomBytes(128 * 1024) },
    { name: `${base}/ffmpeg/sources/x264-source.tar.bz2`, data: 'X264 SOURCE' },
    { name: `${base}/php/`, mode: 0o040755 },
    { name: `${base}/php/php${extension}`, data: 'PHP RUNTIME', mode: 0o100755 },
    { name: `${base}/php/LICENSE`, data: 'PHP LICENCE' }
  ];
}

function sourceFixture(t) {
  const f = fixture(t);
  f.sharedRuntimeSourcesDir = path.join(f.root, 'shared-sources');
  fs.mkdirSync(f.sharedRuntimeSourcesDir);
  f.sourceBytes = [crypto.randomBytes(192 * 1024), crypto.randomBytes(32 * 1024)];
  f.sourceLock = FFMPEG_SOURCE_LOCK.map((source, index) => ({ file: source.file,
    sha256: crypto.createHash('sha256').update(f.sourceBytes[index]).digest('hex'), size: f.sourceBytes[index].length }));
  for (let i = 0; i < f.sourceLock.length; i++) fs.writeFileSync(path.join(f.sharedRuntimeSourcesDir, f.sourceLock[i].file), f.sourceBytes[i]);
  f.engine = loadSourceEngine(f.sourceLock);
  f.config.content.push({ type: 'iptv', data: { channels: [] } });
  return f;
}

function loadSourceEngine(sourceLock, physicalFs = fs) {
  const filename = require.resolve('../src/shared/project-export');
  const originalRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process, Buffer,
    require(name) {
      if (name === 'fs' || name === 'original-fs') return physicalFs;
      if (name === './ffmpeg-source-lock') return { FFMPEG_SOURCE_LOCK: sourceLock };
      return originalRequire(name);
    }
  }, { filename });
  return module.exports;
}

function compactRuntimeEntries(target, sources, marker = { schemaVersion: 1, sources }) {
  const base = target === 'windows' ? 'resources' : 'LaunchBox Viewer.data';
  return [
    { name: `${base}/ffmpeg/ffmpeg${target === 'windows' ? '.exe' : ''}`, data: 'NATIVE RUNTIME', mode: 0o100755 },
    { name: `${base}/ffmpeg/ffprobe${target === 'windows' ? '.exe' : ''}`, data: 'NATIVE PROBE', mode: 0o100755 },
    { name: `${base}/ffmpeg/COPYING.GPLv2`, data: 'FULL LICENSE' },
    { name: `${base}/ffmpeg/sources/recipe/build.sh`, data: 'FULL BUILD RECIPE' },
    { name: `${base}/ffmpeg/template-sources.json`, data: JSON.stringify(marker) }
  ];
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'builder-export-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetsDir = path.join(root, 'dist-assets');
  fs.mkdirSync(assetsDir);
  const templatePath = path.join(root, 'template.zip');
  const outputPath = path.join(root, 'export.zip');
  const config = { brand: { name: 'Curso António' }, content: [] };
  return { root, assetsDir, templatePath, outputPath, config, projectName: 'Curso António' };
}

function executableHeader(platform, fileType = 2) {
  if (platform === 'mac') {
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(0x01000007, 4);
    bytes.writeUInt32LE(3, 8);
    bytes.writeUInt32LE(fileType, 12);
    return bytes;
  }
  const bytes = Buffer.alloc(1024);
  bytes.write('MZ', 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80);
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(0xf0, 0x94);
  bytes.writeUInt16LE(0x22, 0x96);
  bytes.writeUInt16LE(0x20b, 0x98);
  return bytes;
}

function portableFixture(t, { windows = true, mac = true, symlinks = false, allowWine = false } = {}) {
  const f = fixture(t);
  const sourcePath = path.join(f.root, 'portable-source');
  fs.mkdirSync(sourcePath);
  if (windows) fs.writeFileSync(path.join(sourcePath, 'tool.exe'), executableHeader('windows'));
  const bundle = 'Portable Tool.app';
  if (mac) {
    const contents = path.join(sourcePath, bundle, 'Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(contents, 'Resources', 'empty-state'), { recursive: true });
    fs.writeFileSync(path.join(contents, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Portable Tool</string><key>CFBundleIdentifier</key><string>example.portable.tool</string></dict></plist>');
    fs.writeFileSync(path.join(contents, 'MacOS', 'Portable Tool'), executableHeader('mac'), { mode: 0o750 });
    fs.writeFileSync(path.join(contents, 'Resources', 'settings.json'), '{"portable":true}', { mode: 0o640 });
    const framework = path.join(contents, 'Frameworks', 'Demo.framework');
    fs.mkdirSync(path.join(framework, 'Versions', 'A'), { recursive: true });
    fs.writeFileSync(path.join(framework, 'Versions', 'A', 'Demo'), executableHeader('mac', 6), { mode: 0o755 });
    if (symlinks) {
      try {
        fs.symlinkSync('A', path.join(framework, 'Versions', 'Current'), 'dir');
        fs.symlinkSync('Versions/Current/Demo', path.join(framework, 'Demo'), 'file');
      } catch (error) {
        if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Symlink creation unavailable on this host.'); return null; }
        throw error;
      }
    }
  }
  const data = importPortableProject({ sourcePath, assetsDir: f.assetsDir,
    entries: { windows: windows ? 'tool.exe' : null, mac: mac ? bundle : null }, allowWine });
  f.config.content.push({ id: 'portable-test', type: 'portable', title: 'Portable tool', data });
  return { ...f, data, portableRoot: path.join(f.root, ...data.root.split('/')), bundle };
}

async function writeTemplate(filename, entries) {
  const zip = new yazl.ZipFile();
  const completion = pipeline(zip.outputStream, fs.createWriteStream(filename));
  for (const item of entries) {
    const options = { mode: item.mode || 0o100644, compress: false, mtime: new Date('2026-01-02T12:00:00Z') };
    if (item.name.endsWith('/')) zip.addEmptyDirectory(item.name, { mode: options.mode, mtime: options.mtime });
    else zip.addBuffer(Buffer.from(item.data || ''), item.name, options);
  }
  zip.end();
  await completion;
}

async function readZip(filename) {
  const zip = await new Promise((resolve, reject) => yauzl.open(filename, { lazyEntries: true }, (error, result) => error ? reject(error) : resolve(result)));
  const result = new Map();
  await new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', entry => {
      zip.openReadStream(entry, async (error, stream) => {
        if (error) return reject(error);
        try {
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          result.set(entry.fileName, { data: Buffer.concat(chunks), mode: entry.externalFileAttributes >>> 16 });
          zip.readEntry();
        } catch (error) { reject(error); }
      });
    });
    zip.readEntry();
  });
  return result;
}

test('Windows ZIP keeps the Viewer, configuration and nested Unicode assets', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.assetsDir, 'páginas'));
  fs.writeFileSync(path.join(f.assetsDir, 'páginas', 'olá.html'), '<h1>Olá</h1>');
  f.config.brand.logo = 'dist-assets/páginas/olá.html';
  await writeTemplate(f.templatePath, WINDOWS);
  const progress = [];
  const result = await exportProject({ ...f, target: 'windows', onProgress: item => progress.push(item) });
  assert.equal(result.format, 'zip');
  assert.equal(result.path, f.outputPath);
  const entries = await readZip(f.outputPath);
  assert.equal(entries.get('LaunchBox Viewer.exe').data.toString(), 'WINDOWS EXE');
  assert.deepEqual(JSON.parse(entries.get('resources/data/project-config.json').data), f.config);
  assert.equal(entries.get('resources/dist-assets/páginas/olá.html').data.toString(), '<h1>Olá</h1>');
  assert.equal(progress.at(-1).completed, progress.at(-1).total);
});

test('ordinary exports omit optional native runtimes without changing local media or signed Mac bundle bytes', async t => {
  const f = fixture(t);
  const media = Buffer.from('ORIGINAL LOSSLESS MEDIA');
  fs.writeFileSync(path.join(f.assetsDir, 'video.mp4'), media);
  f.config.content.push({ type: 'local-video', data: { file: 'dist-assets/video.mp4' } });
  for (const target of ['windows', 'mac']) {
    const appEntries = target === 'windows' ? WINDOWS : MAC;
    const runtimes = runtimeEntries(target);
    await writeTemplate(f.templatePath, [...appEntries, ...runtimes]);
    const result = await exportProject({ ...f, target });
    const ordinarySize = fs.statSync(f.outputPath).size;
    const entries = await readZip(f.outputPath);
    const base = target === 'windows' ? 'resources' : 'Curso António.data';
    assert.equal([...entries.keys()].some(name => name.startsWith(`${base}/ffmpeg/`) || name.startsWith(`${base}/php/`)), false);
    assert.deepEqual(entries.get(`${base}/dist-assets/video.mp4`).data, media);
    assert.equal(result.omittedRuntimeBytes, runtimes.reduce((sum, item) => sum + Buffer.byteLength(item.data || ''), 0));
    for (const original of appEntries) {
      const name = target === 'windows' ? original.name : original.name.replace(APP, 'Curso António.app');
      assert.deepEqual(entries.get(name).data, Buffer.from(original.data || ''));
      assert.equal(entries.get(name).mode, original.mode || 0o100644);
    }
    f.config.content.push({ type: 'iptv', data: { channels: [] } });
    await exportProject({ ...f, target });
    assert.ok(fs.statSync(f.outputPath).size - ordinarySize > 200 * 1024, 'Unused source/binary bytes must actually be absent from the ZIP');
    f.config.content.pop();
  }
});

test('IPTV exports keep every FFmpeg binary, licence and matching source archive while omitting unused PHP', async t => {
  const f = fixture(t);
  f.config.content.push({ type: 'iptv', data: { channels: [] } });
  for (const target of ['windows', 'mac']) {
    const runtimes = runtimeEntries(target);
    await writeTemplate(f.templatePath, [...(target === 'windows' ? WINDOWS : MAC), ...runtimes]);
    await exportProject({ ...f, target });
    const entries = await readZip(f.outputPath);
    const base = target === 'windows' ? 'resources' : 'Curso António.data';
    for (const original of runtimes.filter(item => item.name.includes('/ffmpeg/'))) {
      const name = target === 'windows' ? original.name : original.name.replace('LaunchBox Viewer.data', base);
      assert.deepEqual(entries.get(name).data, Buffer.from(original.data || ''));
      assert.equal(entries.get(name).mode, original.mode || 0o100644);
    }
    assert.equal([...entries.keys()].some(name => name.startsWith(`${base}/php/`)), false);
    assert.equal([...entries.keys()].some(name => name.startsWith('LaunchBox Viewer.data/')), false);
  }
});

test('PHP web exports retain their native runtime but a PHP download does not', async t => {
  const f = fixture(t);
  const dirname = 'web-12345678-1234-4234-8234-123456789abc';
  fs.mkdirSync(path.join(f.assetsDir, dirname));
  fs.writeFileSync(path.join(f.assetsDir, dirname, 'index.php'), '<?php echo "ok";');
  f.config.content.push({ type: 'local-web', data: { root: `dist-assets/${dirname}`, entry: 'index.php', requiresPhp: false } });
  assert.deepEqual(projectRuntimeRequirements(f), { ffmpeg: false, php: true });
  for (const target of ['windows', 'mac']) {
    const runtimes = runtimeEntries(target);
    await writeTemplate(f.templatePath, [...(target === 'windows' ? WINDOWS : MAC), ...runtimes]);
    await exportProject({ ...f, target });
    const entries = await readZip(f.outputPath);
    const base = target === 'windows' ? 'resources' : 'Curso António.data';
    assert.equal(entries.get(`${base}/php/php${target === 'windows' ? '.exe' : ''}`).data.toString(), 'PHP RUNTIME');
    assert.equal(entries.get(`${base}/php/LICENSE`).data.toString(), 'PHP LICENCE');
    assert.equal([...entries.keys()].some(name => name.startsWith(`${base}/ffmpeg/`)), false);
  }
  f.config.content[0] = { type: 'download-vault', data: { file: `dist-assets/${dirname}/index.php` } };
  assert.deepEqual(projectRuntimeRequirements(f), { ffmpeg: false, php: false });
  await exportProject({ ...f, target: 'mac' });
  const entries = await readZip(f.outputPath);
  assert.equal([...entries.keys()].some(name => name.startsWith('Curso António.data/php/')), false);
  assert.equal(entries.get(`Curso António.data/dist-assets/${dirname}/index.php`).data.toString(), '<?php echo "ok";');
});

test('older sealed Mac templates retain optional resources and signatures even when no module needs them', async t => {
  const f = fixture(t);
  const runtimes = runtimeEntries('mac').map(item => ({ ...item, name: item.name.replace('LaunchBox Viewer.data', `${APP}/Contents/Resources`) }));
  await writeTemplate(f.templatePath, [...MAC, ...runtimes]);
  const result = await exportProject({ ...f, target: 'mac' });
  assert.equal(result.omittedRuntimeBytes, 0);
  const entries = await readZip(f.outputPath);
  for (const original of [...MAC, ...runtimes]) {
    assert.deepEqual(entries.get(original.name.replace(APP, 'Curso António.app')).data, Buffer.from(original.data || ''));
  }
});

test('Mac templates reject project injection and links that escape a companion runtime', async t => {
  const f = fixture(t);
  const externalBase = 'LaunchBox Viewer.data';
  for (const additions of [
    [{ name: `${externalBase}/data/project-config.json`, data: 'PREVIOUS PROJECT' }],
    [{ name: `${externalBase}/dist-assets/secret.txt`, data: 'PREVIOUS ASSET' }],
    [{ name: `${externalBase}/ffmpeg/file`, data: 'FILE' }, { name: `${externalBase}/php/php`, data: 'PHP' }, { name: `${externalBase}/ffmpeg/link`, data: '../php/php', mode: 0o120777 }],
    [{ name: `${externalBase}/ffmpeg/link`, data: `../../${APP}/Contents/Info.plist`, mode: 0o120777 }]
  ]) {
    await writeTemplate(f.templatePath, [...MAC, ...additions]);
    await assert.rejects(exportProject({ ...f, target: 'mac' }), /permitidos|fora do bundle|runtime/);
    assert.equal(fs.existsSync(f.outputPath), false);
  }
});

test('IPTV export fails atomically if its target template lacks the bundled FFmpeg runtime', async t => {
  const f = fixture(t);
  f.config.content.push({ type: 'iptv', data: { channels: [] } });
  for (const target of ['windows', 'mac']) {
    await writeTemplate(f.templatePath, target === 'windows' ? WINDOWS : MAC);
    fs.writeFileSync(f.outputPath, 'PREVIOUS GOOD EXPORT');
    await assert.rejects(exportProject({ ...f, target }), /runtime FFmpeg/);
    assert.equal(fs.readFileSync(f.outputPath, 'utf8'), 'PREVIOUS GOOD EXPORT');
    assert.equal(fs.readdirSync(f.root).some(name => name.endsWith('.tmp')), false);
  }
  await writeTemplate(f.templatePath, [...MAC, { name: 'LaunchBox Viewer.data/ffmpeg/ffmpeg', data: 'NATIVE RUNTIME', mode: 0o100644 }]);
  await assert.rejects(exportProject({ ...f, target: 'mac' }), /FFmpeg.*permissão de execução/);
  assert.equal(fs.readFileSync(f.outputPath, 'utf8'), 'PREVIOUS GOOD EXPORT');
});

test('Windows SFX extraction can select runtimes, preserving the default full-template compatibility route', async t => {
  const f = fixture(t);
  await writeTemplate(f.templatePath, [...WINDOWS, ...runtimeEntries('windows')]);
  const full = path.join(f.root, 'full-template');
  await extractWindowsTemplate(f.templatePath, full);
  assert.equal(fs.existsSync(path.join(full, 'resources/ffmpeg/sources/ffmpeg-source.tar.xz')), true);
  assert.equal(fs.existsSync(path.join(full, 'resources/php/php.exe')), true);
  const ordinary = path.join(f.root, 'ordinary-template');
  await extractWindowsTemplate(f.templatePath, ordinary, f);
  assert.equal(fs.existsSync(path.join(ordinary, 'resources/ffmpeg')), false);
  assert.equal(fs.existsSync(path.join(ordinary, 'resources/php')), false);
  assert.equal(fs.readFileSync(path.join(ordinary, 'resources/app.asar'), 'utf8'), 'VIEWER SOURCE');
  f.config.content.push({ type: 'iptv', data: { channels: [] } });
  const iptv = path.join(f.root, 'iptv-template');
  await extractWindowsTemplate(f.templatePath, iptv, f);
  assert.equal(fs.existsSync(path.join(iptv, 'resources/ffmpeg/sources/ffmpeg-source.tar.xz')), true);
  assert.equal(fs.existsSync(path.join(iptv, 'resources/ffmpeg/COPYING.GPLv2')), true);
  assert.equal(fs.existsSync(path.join(iptv, 'resources/php')), false);
});

test('APK references cannot produce an export or stage without a validated included Android runtime', async t => {
  const f = fixture(t);
  f.config.content.push({ type: 'android-apk', data: { file: 'dist-assets/mobile.apk' } });
  fs.writeFileSync(f.outputPath, 'PREVIOUS GOOD EXPORT');
  for (const target of ['windows', 'mac']) {
    // The guard must run before reading assets/templates or creating output.
    await assert.rejects(exportProject({ ...f, target }), error => error.code === 'ANDROID_RUNTIME_NOT_INCLUDED');
    assert.equal(fs.readFileSync(f.outputPath, 'utf8'), 'PREVIOUS GOOD EXPORT');
  }
  const staging = path.join(f.root, 'apk-stage');
  await assert.rejects(extractWindowsTemplate(f.templatePath, staging, f), error => error.code === 'ANDROID_RUNTIME_NOT_INCLUDED');
  assert.equal(fs.existsSync(staging), false);
});

test('the production source lock matches the pinned native build hashes and bounded exact archive sizes', () => {
  const buildLock = require('../build-configs/ffmpeg-sources.json');
  assert.deepEqual(FFMPEG_SOURCE_LOCK.map(({ file, sha256 }) => ({ file, sha256 })), buildLock.sources.map(({ file, sha256 }) => ({ file, sha256 })));
  assert.equal(FFMPEG_SOURCE_LOCK.reduce((sum, source) => sum + source.size, 0), 12580755);
  assert.equal(Object.isFrozen(FFMPEG_SOURCE_LOCK), true);
  assert.ok(FFMPEG_SOURCE_LOCK.every(Object.isFrozen));
});

test('compact Builder templates restore exact common FFmpeg archives into IPTV ZIPs and SFX staging', async t => {
  const f = sourceFixture(t);
  for (const target of ['windows', 'mac']) {
    await writeTemplate(f.templatePath, [...(target === 'windows' ? WINDOWS : MAC), ...compactRuntimeEntries(target, f.sourceLock)]);
    await f.engine.exportProject({ ...f, target });
    const entries = await readZip(f.outputPath);
    const base = target === 'windows' ? 'resources' : 'Curso António.data';
    for (let i = 0; i < f.sourceLock.length; i++) {
      const restored = entries.get(`${base}/ffmpeg/sources/${f.sourceLock[i].file}`);
      assert.deepEqual(restored.data, f.sourceBytes[i]);
      assert.equal(restored.mode, 0o100644);
    }
    assert.equal(entries.has(`${base}/ffmpeg/template-sources.json`), false);
    assert.equal(entries.get(`${base}/ffmpeg/sources/recipe/build.sh`).data.toString(), 'FULL BUILD RECIPE');
    if (target === 'mac') {
      for (const original of MAC) assert.deepEqual(entries.get(original.name.replace(APP, 'Curso António.app')).data, Buffer.from(original.data || ''));
    } else {
      const stage = path.join(f.root, 'restored-stage');
      await f.engine.extractWindowsTemplate(f.templatePath, stage, f);
      for (let i = 0; i < f.sourceLock.length; i++) assert.deepEqual(fs.readFileSync(path.join(stage, 'resources/ffmpeg/sources', f.sourceLock[i].file)), f.sourceBytes[i]);
      assert.equal(fs.existsSync(path.join(stage, 'resources/ffmpeg/template-sources.json')), false);
      const fullStage = path.join(f.root, 'full-restored-stage');
      await f.engine.extractWindowsTemplate(f.templatePath, fullStage, { sharedRuntimeSourcesDir: f.sharedRuntimeSourcesDir });
      assert.deepEqual(fs.readFileSync(path.join(fullStage, 'resources/ffmpeg/sources', f.sourceLock[0].file)), f.sourceBytes[0]);
    }
  }
});

test('non-IPTV exports from compact templates need no shared archive folder and contain no native marker or source bytes', async t => {
  const f = sourceFixture(t);
  f.config.content = [];
  for (const target of ['windows', 'mac']) {
    await writeTemplate(f.templatePath, [...(target === 'windows' ? WINDOWS : MAC), ...compactRuntimeEntries(target, f.sourceLock)]);
    await f.engine.exportProject({ ...f, target, sharedRuntimeSourcesDir: undefined });
    const entries = await readZip(f.outputPath);
    assert.equal([...entries.keys()].some(name => name.includes('/ffmpeg/')), false);
    if (target === 'windows') {
      const stage = path.join(f.root, 'no-runtime-stage');
      await f.engine.extractWindowsTemplate(f.templatePath, stage, { config: f.config, assetsDir: f.assetsDir });
      assert.equal(fs.existsSync(path.join(stage, 'resources/ffmpeg')), false);
    }
  }
});

test('missing, wrong-size and same-size corrupt shared sources fail before ZIP replacement or SFX staging', async t => {
  const f = sourceFixture(t);
  await writeTemplate(f.templatePath, [...WINDOWS, ...compactRuntimeEntries('windows', f.sourceLock)]);
  fs.writeFileSync(f.outputPath, 'PREVIOUS GOOD EXPORT');
  await assert.rejects(f.engine.exportProject({ ...f, target: 'windows', sharedRuntimeSourcesDir: undefined }), /pasta comum/);
  const sourcePath = path.join(f.sharedRuntimeSourcesDir, f.sourceLock[0].file);
  for (const invalid of [null, Buffer.from('TRUNCATED'), Buffer.alloc(f.sourceBytes[0].length)]) {
    if (invalid === null) fs.unlinkSync(sourcePath); else fs.writeFileSync(sourcePath, invalid);
    await assert.rejects(f.engine.exportProject({ ...f, target: 'windows' }), /ENOENT|inválido|corrompido/);
    const stage = path.join(f.root, 'invalid-source-stage');
    await assert.rejects(f.engine.extractWindowsTemplate(f.templatePath, stage, f), /ENOENT|inválido|corrompido/);
    assert.equal(fs.existsSync(stage), false);
    assert.equal(fs.readFileSync(f.outputPath, 'utf8'), 'PREVIOUS GOOD EXPORT');
    assert.equal(fs.readdirSync(f.root).some(name => name.endsWith('.tmp')), false);
  }
});

test('streamed common archive bytes are hashed again even when their source stat has not changed', async t => {
  const f = sourceFixture(t);
  await writeTemplate(f.templatePath, [...WINDOWS, ...compactRuntimeEntries('windows', f.sourceLock)]);
  fs.writeFileSync(f.outputPath, 'PREVIOUS GOOD EXPORT');
  // Native realpath can expand Windows TEMP short names or normalize casing,
  // unlike the synchronous JavaScript realpath used by the fixture. Match the
  // production descriptor path so the corruption is injected on every host.
  const sourcePath = path.join(await fs.promises.realpath(f.sharedRuntimeSourcesDir), f.sourceLock[0].file);
  let opens = 0;
  let corruptedStreams = 0;
  const mockedPromises = new Proxy(fs.promises, {
    get(target, property) {
      if (property !== 'open') return Reflect.get(target, property);
      return async (filename, ...args) => {
        const handle = await fs.promises.open(filename, ...args);
        if (filename !== sourcePath || ++opens < 2) return handle;
        return new Proxy(handle, {
          get(original, field) {
            if (field !== 'createReadStream') {
              const value = Reflect.get(original, field);
              return typeof value === 'function' ? value.bind(original) : value;
            }
            return options => {
              const incoming = original.createReadStream(options);
              let corrupted = false;
              const transform = new Transform({ transform(chunk, encoding, callback) {
                const copy = Buffer.from(chunk);
                if (!corrupted && copy.length) { copy[0] ^= 1; corrupted = true; corruptedStreams++; }
                callback(null, copy);
              } });
              incoming.on('error', error => transform.destroy(error));
              transform.on('close', () => incoming.destroy());
              return incoming.pipe(transform);
            };
          }
        });
      };
    }
  });
  const mockedFs = new Proxy(fs, { get(target, property) { return property === 'promises' ? mockedPromises : Reflect.get(target, property); } });
  const engine = loadSourceEngine(f.sourceLock, mockedFs);
  await assert.rejects(engine.exportProject({ ...f, target: 'windows' }), /SHA-256/);
  assert.equal(opens, 2, 'The selected source must be opened for validation and again for ZIP streaming.');
  assert.equal(corruptedStreams, 1, 'The second read must actually emit corrupted bytes.');
  assert.deepEqual(fs.readFileSync(sourcePath), f.sourceBytes[0], 'Only emitted stream bytes change; the source file stays valid.');
  assert.equal(fs.readFileSync(f.outputPath, 'utf8'), 'PREVIOUS GOOD EXPORT');
  assert.equal(fs.readdirSync(f.root).some(name => name.endsWith('.tmp')), false);
});

test('common-source markers reject changed schemas, traversal, duplicates and unlocked hashes or sizes', async t => {
  const f = sourceFixture(t);
  f.config.content = [];
  const first = f.sourceLock[0];
  const invalidMarkers = [
    { schemaVersion: 2, sources: f.sourceLock },
    { schemaVersion: 1, sources: f.sourceLock, directory: '/outside' },
    { schemaVersion: 1, sources: [first, first] },
    { schemaVersion: 1, sources: [{ ...first, file: '../outside.tar.xz' }, f.sourceLock[1]] },
    { schemaVersion: 1, sources: [{ ...first, sha256: '0'.repeat(64) }, f.sourceLock[1]] },
    { schemaVersion: 1, sources: [{ ...first, size: first.size + 1 }, f.sourceLock[1]] },
    { schemaVersion: 1, sources: [{ ...first, url: 'https://example.invalid' }, f.sourceLock[1]] }
  ];
  for (const marker of invalidMarkers) {
    await writeTemplate(f.templatePath, [...WINDOWS, ...compactRuntimeEntries('windows', f.sourceLock, marker)]);
    await assert.rejects(f.engine.exportProject({ ...f, target: 'windows', sharedRuntimeSourcesDir: undefined }), /Marcador/);
    assert.equal(fs.existsSync(f.outputPath), false);
  }
  const misplaced = compactRuntimeEntries('windows', f.sourceLock).map(item => ({ ...item, name: item.name.replace('/ffmpeg/template-sources.json', '/php/template-sources.json') }));
  await writeTemplate(f.templatePath, [...WINDOWS, ...misplaced]);
  await assert.rejects(f.engine.exportProject({ ...f, target: 'windows' }), /Marcador/);
  const duplicateArchive = { name: `resources/ffmpeg/sources/${first.file}`, data: f.sourceBytes[0] };
  await writeTemplate(f.templatePath, [...WINDOWS, ...compactRuntimeEntries('windows', f.sourceLock), duplicateArchive]);
  await assert.rejects(f.engine.exportProject({ ...f, target: 'windows' }), /mistura arquivos/);
});

test('Mac ZIP preserves all bundle bytes, executable modes and framework symlink chains', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.assetsDir, 'logo.png'), 'PNG');
  await writeTemplate(f.templatePath, MAC);
  await exportProject({ ...f, target: 'mac' });
  const entries = await readZip(f.outputPath);
  for (const original of MAC) {
    const renamed = original.name.replace(APP, 'Curso António.app');
    assert.deepEqual(entries.get(renamed).data, Buffer.from(original.data || ''));
    assert.equal(entries.get(renamed).mode, original.mode || 0o100644);
  }
  assert.deepEqual(JSON.parse(entries.get('Curso António.data/data/project-config.json').data), f.config);
  assert.equal(entries.get('Curso António.data/dist-assets/logo.png').data.toString(), 'PNG');
  assert.equal([...entries.keys()].filter(name => name.startsWith('Curso António.app/')).length, MAC.length);
});

test('portable ZIP exports preserve safe app symlink bytes, executable modes and empty directories', async t => {
  if (process.platform === 'win32') return t.skip('Windows cannot preserve Unix executable bits for native Mac asset exports.');
  const f = portableFixture(t, { symlinks: true });
  if (!f) return;
  const executable = path.join(f.portableRoot, f.bundle, 'Contents', 'MacOS', 'Portable Tool');
  const settings = path.join(f.portableRoot, f.bundle, 'Contents', 'Resources', 'settings.json');
  const empty = path.join(f.portableRoot, f.bundle, 'Contents', 'Resources', 'empty-state');
  if (process.platform !== 'win32') {
    fs.chmodSync(f.portableRoot, 0o750);
    fs.chmodSync(empty, 0o700);
  }
  for (const target of ['mac', 'windows']) {
    await writeTemplate(f.templatePath, target === 'mac' ? MAC : WINDOWS);
    const inspected = await inspectProjectAssets({ ...f, target });
    assert.equal(inspected.links.length, 2);
    assert.ok(inspected.files.every(item => item.kind === 'file'));
    assert.ok(inspected.entries.some(item => item.kind === 'directory' && item.absolute === empty));
    await exportProject({ ...f, target });
    const entries = await readZip(f.outputPath);
    const base = (target === 'mac' ? 'Curso António.data/' : 'resources/') + f.data.root;
    const framework = base + '/' + f.bundle + '/Contents/Frameworks/Demo.framework';
    assert.equal(entries.get(framework + '/Versions/Current').data.toString(), 'A');
    assert.equal(entries.get(framework + '/Demo').data.toString(), 'Versions/Current/Demo');
    assert.equal(entries.get(framework + '/Demo').mode & 0o170000, 0o120000);
    assert.deepEqual(entries.get(base + '/' + f.bundle + '/Contents/MacOS/Portable Tool').data, executableHeader('mac'));
    assert.equal(entries.get(base + '/' + f.bundle + '/Contents/MacOS/Portable Tool').mode, 0o100000 | (fs.statSync(executable).mode & 0o777));
    assert.equal(entries.get(base + '/' + f.bundle + '/Contents/Resources/settings.json').mode, 0o100000 | (fs.statSync(settings).mode & 0o777));
    assert.equal(entries.get(base + '/' + f.bundle + '/Contents/Resources/empty-state/').mode, 0o040000 | (fs.statSync(empty).mode & 0o777));
    assert.equal(entries.get(base + '/').mode, 0o040000 | (fs.statSync(f.portableRoot).mode & 0o777));
    assert.deepEqual(JSON.parse(entries.get((target === 'mac' ? 'Curso António.data/' : 'resources/') + 'data/project-config.json').data), f.config);
  }
});

test('Mac portable export rejects executable permissions lost on import or later edits', async t => {
  const f = portableFixture(t, { windows: false });
  fs.chmodSync(path.join(f.portableRoot, f.bundle, 'Contents', 'MacOS', 'Portable Tool'), 0o644);
  await writeTemplate(f.templatePath, MAC);
  await assert.rejects(exportProject({ ...f, target: 'mac' }), /permiss|execut.*Mac|Mac.*execut/i);
  assert.equal(fs.existsSync(f.outputPath), false);
});

test('portable export rejects missing native targets and permits an explicit Mac Wine option', async t => {
  const windowsOnly = portableFixture(t, { mac: false });
  await writeTemplate(windowsOnly.templatePath, MAC);
  await assert.rejects(exportProject({ ...windowsOnly, target: 'mac' }), /Mac|macOS|Wine|compatível/i);
  assert.equal(fs.existsSync(windowsOnly.outputPath), false);
  windowsOnly.config.content[0].data.allowWine = true;
  await exportProject({ ...windowsOnly, target: 'mac' });
  const macOnly = portableFixture(t, { windows: false });
  await writeTemplate(macOnly.templatePath, WINDOWS);
  await assert.rejects(exportProject({ ...macOnly, target: 'windows' }), /Windows|compatível|executável/i);
  assert.equal(fs.existsSync(macOnly.outputPath), false);
});

test('portable export rejects escaping, chained, dangling and cyclic symlinks without replacing output', async t => {
  const f = portableFixture(t);
  const marker = path.join(f.portableRoot, 'link');
  try { fs.symlinkSync('tool.exe', marker, 'file'); fs.unlinkSync(marker); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Symlink creation unavailable on this host.'); throw error; }
  fs.writeFileSync(path.join(f.assetsDir, 'other-private.txt'), 'NOT PART OF PORTABLE APP');
  await writeTemplate(f.templatePath, MAC);
  fs.writeFileSync(f.outputPath, 'PREVIOUS EXPORT');
  const invalidCases = [
    [['link', path.join(f.assetsDir, 'other-private.txt')]],
    [['link', '../other-private.txt']],
    [['link', 'hop'], ['hop', '../other-private.txt']],
    [['link', 'missing-file']],
    [['link', 'hop'], ['hop', 'link']],
    [['link', '.']]
  ];
  for (const links of invalidCases) {
    for (const [name, destination] of links) fs.symlinkSync(destination, path.join(f.portableRoot, name), 'file');
    await assert.rejects(exportProject({ ...f, target: 'mac' }), /ligaç|symlink|ciclo|cycle|fora|inexistente|ENOENT|ELOOP/i);
    assert.equal(fs.readFileSync(f.outputPath, 'utf8'), 'PREVIOUS EXPORT');
    for (const [name] of links) fs.unlinkSync(path.join(f.portableRoot, name));
  }
  assert.equal(fs.readdirSync(f.root).filter(name => name.endsWith('.tmp')).length, 0);
});

test('portable symlink permission never extends to other assets or local web roots', async t => {
  const f = portableFixture(t);
  await writeTemplate(f.templatePath, WINDOWS);
  const webRoot = path.join(f.assetsDir, 'web-12345678-1234-4234-8234-123456789abc');
  fs.mkdirSync(webRoot);
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<h1>Local</h1>');
  try { fs.symlinkSync('index.html', path.join(webRoot, 'linked.html'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Symlink creation unavailable on this host.'); throw error; }
  f.config.content.push({ id: 'web-test', type: 'local-web', data: { root: 'dist-assets/' + path.basename(webRoot), entry: 'index.html' } });
  await assert.rejects(exportProject({ ...f, target: 'windows' }), /Recurso não permitido/);
  fs.unlinkSync(path.join(webRoot, 'linked.html'));
  f.config.content = [];
  fs.symlinkSync('tool.exe', path.join(f.portableRoot, 'unregistered-link'), 'file');
  await assert.rejects(exportProject({ ...f, target: 'windows' }), /Recurso não permitido/);
});

test('ordinary empty asset directories survive export without making content executable', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.assetsDir, 'empty', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(f.assetsDir, 'ordinary.txt'), 'Content', { mode: 0o755 });
  await writeTemplate(f.templatePath, WINDOWS);
  await exportProject({ ...f, target: 'windows' });
  const entries = await readZip(f.outputPath);
  assert.equal(entries.get('resources/dist-assets/empty/').mode, 0o040755);
  assert.equal(entries.get('resources/dist-assets/empty/nested/').mode, 0o040755);
  assert.equal(entries.get('resources/dist-assets/ordinary.txt').mode, 0o100644);
});

test('PHP export is blocked unless the selected target template includes its runtime', async t => {
  const f = fixture(t);
  const dirname = 'web-12345678-1234-4234-8234-123456789abc';
  fs.mkdirSync(path.join(f.assetsDir, dirname));
  fs.writeFileSync(path.join(f.assetsDir, dirname, 'page.php'), '<?php echo 1;');
  f.config.content.push({ type: 'local-web', data: { root: `dist-assets/${dirname}`, entry: 'page.php', requiresPhp: false } });
  for (const target of ['windows', 'mac']) {
    await writeTemplate(f.templatePath, target === 'windows' ? WINDOWS : MAC);
    await assert.rejects(exportProject({ ...f, target }), /runtime PHP/);
    assert.equal(fs.existsSync(f.outputPath), false);
    const runtime = target === 'windows' ? 'resources/php/php.exe' : `${APP}/Contents/Resources/php/php`;
    await writeTemplate(f.templatePath, [...(target === 'windows' ? WINDOWS : MAC), { name: runtime, data: 'PHP', mode: 0o100755 }]);
    await exportProject({ ...f, target });
    assert.equal(fs.existsSync(f.outputPath), true);
    fs.unlinkSync(f.outputPath);
  }
});

test('PHP downloads do not require a runtime, but an explicit PHP requirement does', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.assetsDir, 'source.php'), '<?php echo 1;');
  f.config.content.push({ type: 'download-vault', data: { file: 'dist-assets/source.php', fileName: 'source.php' } });
  for (const target of ['windows', 'mac']) {
    await writeTemplate(f.templatePath, target === 'windows' ? WINDOWS : MAC);
    await exportProject({ ...f, target });
    const entries = await readZip(f.outputPath);
    const base = target === 'windows' ? 'resources' : 'Curso António.data';
    assert.equal(entries.get(`${base}/dist-assets/source.php`).data.toString(), '<?php echo 1;');
    await assert.rejects(exportProject({ ...f, target, requiresPhp: true }), /runtime PHP/);
  }
});

test('Mac project names containing dollar replacement tokens are preserved literally', async t => {
  const f = fixture(t);
  await writeTemplate(f.templatePath, MAC);
  const projectName = "Curso $& $$ $` $'";
  await exportProject({ ...f, target: 'mac', projectName });
  const entries = await readZip(f.outputPath);
  for (const original of MAC) {
    const destination = `${projectName}.app${original.name.slice(APP.length)}`;
    assert.deepEqual(entries.get(destination).data, Buffer.from(original.data || ''));
  }
  assert.deepEqual(JSON.parse(entries.get(`${projectName}.data/data/project-config.json`).data), f.config);
});

test('Mac requires a real executable with Unix execute permission', async t => {
  const f = fixture(t);
  const executable = `${APP}/Contents/MacOS/LaunchBox Viewer`;
  await writeTemplate(f.templatePath, MAC.filter(item => item.name !== executable));
  await assert.rejects(exportProject({ ...f, target: 'mac' }), /Template incompleto/);
  await writeTemplate(f.templatePath, MAC.map(item => item.name === executable ? { ...item, mode: 0o100644 } : item));
  await assert.rejects(exportProject({ ...f, target: 'mac' }), /permissão de execução/);
});

test('Mac blocks Windows launch modules but allows the same file as a download', async t => {
  const f = fixture(t);
  await writeTemplate(f.templatePath, MAC);
  fs.writeFileSync(path.join(f.assetsDir, 'tool.exe'), 'EXE');
  f.config.content.push({ type: 'launch', title: 'Ferramenta', data: { file: 'dist-assets/tool.exe', fileName: 'tool.exe' } });
  await assert.rejects(exportProject({ ...f, target: 'mac' }), /Ferramenta.*Windows incompatível com Mac/);
  f.config.content[0].type = 'download-vault';
  await exportProject({ ...f, target: 'mac' });
});

test('missing referenced assets and local-web entry files block incomplete exports', async t => {
  const f = fixture(t);
  await writeTemplate(f.templatePath, WINDOWS);
  f.config.brand.logo = 'dist-assets/missing.png';
  await assert.rejects(exportProject({ ...f, target: 'windows' }), /Recurso do projeto em falta/);
  delete f.config.brand.logo;
  const dirname = 'web-12345678-1234-4234-8234-123456789abc';
  fs.mkdirSync(path.join(f.assetsDir, dirname));
  f.config.content.push({ type: 'local-web', data: { root: `dist-assets/${dirname}`, entry: 'missing.html' } });
  await assert.rejects(exportProject({ ...f, target: 'windows' }), /ENOENT|inicial/);
});

test('unsafe asset symlinks and case collisions are rejected', async t => {
  const f = fixture(t);
  await writeTemplate(f.templatePath, WINDOWS);
  fs.writeFileSync(path.join(f.root, 'private.txt'), 'PRIVATE');
  try { fs.symlinkSync(path.join(f.root, 'private.txt'), path.join(f.assetsDir, 'link.txt')); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Creating symlinks requires permission on this Windows host.'); throw error; }
  await assert.rejects(exportProject({ ...f, target: 'windows' }), /Recurso não permitido/);
  fs.unlinkSync(path.join(f.assetsDir, 'link.txt'));
  await writeTemplate(f.templatePath, [...WINDOWS, { name: 'Readme.txt', data: 'A' }, { name: 'README.TXT', data: 'B' }]);
  await assert.rejects(exportProject({ ...f, target: 'windows' }), /duplicados/);
});

test('Mac rejects external symlinks, cycles and entries nested beneath a symlink', async t => {
  const f = fixture(t);
  const base = MAC.slice(0, 4);
  for (const additions of [
    [{ name: `${APP}/Contents/escape`, data: '../../../outside', mode: 0o120777 }],
    [{ name: `${APP}/Contents/a`, data: 'b', mode: 0o120777 }, { name: `${APP}/Contents/b`, data: 'a', mode: 0o120777 }],
    [{ name: `${APP}/Contents/link`, data: 'Resources', mode: 0o120777 }, { name: `${APP}/Contents/link/injected.txt`, data: 'BAD' }]
  ]) {
    await writeTemplate(f.templatePath, [...base, ...additions]);
    await assert.rejects(exportProject({ ...f, target: 'mac' }), /simbólica|ligações|atravessa/);
  }
});

test('template traversal, absolute paths and backslashes are rejected before output', async t => {
  const f = fixture(t);
  for (const malicious of ['../evil!', '/evil!!!', 'C:\\evil!']) {
    await writeTemplate(f.templatePath, [...WINDOWS, { name: 'safe.txt', data: 'BAD' }]);
    let bytes = fs.readFileSync(f.templatePath);
    bytes = Buffer.from(bytes.toString('latin1').replaceAll('safe.txt', malicious), 'latin1');
    fs.writeFileSync(f.templatePath, bytes);
    await assert.rejects(exportProject({ ...f, target: 'windows' }), /path|Caminho|backslash|fileName/i);
    assert.equal(fs.existsSync(f.outputPath), false);
  }
});

test('corrupt template CRC leaves an existing destination intact and removes temporary output', async t => {
  const f = fixture(t);
  await writeTemplate(f.templatePath, WINDOWS);
  const bytes = fs.readFileSync(f.templatePath);
  const offset = bytes.indexOf(Buffer.from('VIEWER SOURCE'));
  assert.ok(offset >= 0);
  bytes[offset] ^= 1;
  fs.writeFileSync(f.templatePath, bytes);
  fs.writeFileSync(f.outputPath, 'PREVIOUS GOOD EXPORT');
  await assert.rejects(exportProject({ ...f, target: 'windows' }), /CRC/);
  assert.equal(fs.readFileSync(f.outputPath, 'utf8'), 'PREVIOUS GOOD EXPORT');
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['dist-assets', 'export.zip', 'template.zip']);
});

test('a resource changed during export fails atomically', async t => {
  const f = fixture(t);
  await writeTemplate(f.templatePath, WINDOWS);
  fs.writeFileSync(path.join(f.assetsDir, 'image.png'), 'PNG');
  fs.writeFileSync(f.outputPath, 'OLD EXPORT');
  let changed = false;
  await assert.rejects(exportProject({ ...f, target: 'windows', onProgress() {
    if (!changed) { changed = true; fs.writeFileSync(path.join(f.assetsDir, 'image.png'), 'CHANGED PNG'); }
  } }), /mudou/);
  assert.equal(fs.readFileSync(f.outputPath, 'utf8'), 'OLD EXPORT');
});

test('Windows template extraction roundtrip cannot merge with an existing directory', async t => {
  const f = fixture(t);
  await writeTemplate(f.templatePath, WINDOWS);
  const destination = path.join(f.root, 'staging');
  assert.equal(await extractWindowsTemplate(f.templatePath, destination), destination);
  assert.equal(fs.readFileSync(path.join(destination, 'resources', 'app.asar'), 'utf8'), 'VIEWER SOURCE');
  await assert.rejects(extractWindowsTemplate(f.templatePath, destination), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(destination, 'LaunchBox Viewer.exe'), 'utf8'), 'WINDOWS EXE');
});

test('Electron extraction writes physical ASAR bytes without the virtual filesystem or global noAsar', async t => {
  const f = fixture(t);
  await writeTemplate(f.templatePath, WINDOWS);
  const enginePath = require.resolve('../src/shared/project-export');
  const nativeRequire = createRequire(enginePath);
  const physicalWrites = [];
  const physicalFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'createWriteStream') return (filename, options) => {
        physicalWrites.push(filename);
        return fs.createWriteStream(filename, options);
      };
      return Reflect.get(target, property);
    }
  });
  const electronFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'createWriteStream') return (filename, options) => {
        if (/\.asar(?:[\\/]|$)/i.test(filename)) throw new Error(`Invalid package ${filename}`);
        return fs.createWriteStream(filename, options);
      };
      return Reflect.get(target, property);
    }
  });
  const electronProcess = { versions: { ...process.versions, electron: '32.3.4' } };
  Object.defineProperty(electronProcess, 'noAsar', {
    get() { return undefined; },
    set() { throw new Error('The exporter must not disable ASAR globally.'); }
  });
  const electronModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(enginePath, 'utf8'), {
    module: electronModule,
    exports: electronModule.exports,
    process: electronProcess,
    Buffer,
    require(name) {
      if (name === 'fs' || name === 'node:fs') return electronFs;
      if (name === 'original-fs') return physicalFs;
      return nativeRequire(name);
    }
  }, { filename: enginePath });
  const destination = path.join(f.root, 'electron-staging');
  await electronModule.exports.extractWindowsTemplate(f.templatePath, destination);
  const asarPath = path.join(destination, 'resources', 'app.asar');
  assert.equal(fs.readFileSync(asarPath, 'utf8'), 'VIEWER SOURCE');
  assert.ok(physicalWrites.includes(asarPath), 'ASAR must be streamed through the physical filesystem');
  assert.equal(electronProcess.noAsar, undefined);
});

test('project names retain Unicode but cannot escape or create reserved Windows paths', () => {
  assert.equal(safeProjectName('Curso António'), 'Curso António');
  assert.equal(safeProjectName('../../escape'), '..-..-escape');
  assert.equal(safeProjectName('CON'), '_CON');
  assert.equal(safeProjectName('  '), 'My Software');
});


test('opaque archive downloads keep every byte in Windows and Mac exports without native runtimes', async t => {
  const f = fixture(t);
  // Opaque data may be encrypted or use an unsupported archive format. Export
  // must never try to unpack, decode or recompress the inner file itself.
  const originals = ['protected.zip', 'protected.rar', 'protected.7z'].map(fileName => ({
    fileName, bytes: Buffer.concat([Buffer.from(fileName), crypto.randomBytes(2048)])
  }));
  f.config.content = originals.map((item, index) => {
    fs.writeFileSync(path.join(f.assetsDir, item.fileName), item.bytes);
    return {id:'archive-'+index,type:'archive-download',data:{file:'dist-assets/'+item.fileName,fileName:item.fileName}};
  });
  assert.deepEqual(projectRuntimeRequirements(f), {ffmpeg:false,php:false});
  for (const target of ['windows','mac']) {
    await writeTemplate(f.templatePath, [...(target === 'windows' ? WINDOWS : MAC), ...runtimeEntries(target)]);
    await exportProject({...f,target});
    const entries = await readZip(f.outputPath);
    const base = target === 'windows' ? 'resources' : 'Curso António.data';
    const config = JSON.parse(entries.get(base+'/data/project-config.json').data);
    assert.equal(config.content.length, originals.length);
    assert.ok(config.content.every(mod=>mod.type==='archive-download'));
    for (const item of originals) assert.deepEqual(entries.get(base+'/dist-assets/'+item.fileName).data, item.bytes);
    assert.equal([...entries.keys()].some(name=>name.startsWith(base+'/ffmpeg/') || name.startsWith(base+'/php/')),false);
  }
});
