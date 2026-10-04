'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pipeline } = require('stream/promises');
const yazl = require('yazl');
const yauzl = require('yauzl');
const { exportProject, extractWindowsTemplate, safeProjectName } = require('../src/shared/project-export');

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

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-export-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetsDir = path.join(root, 'dist-assets');
  fs.mkdirSync(assetsDir);
  const templatePath = path.join(root, 'template.zip');
  const outputPath = path.join(root, 'export.zip');
  const config = { brand: { name: 'Curso António' }, content: [] };
  return { root, assetsDir, templatePath, outputPath, config, projectName: 'Curso António' };
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
