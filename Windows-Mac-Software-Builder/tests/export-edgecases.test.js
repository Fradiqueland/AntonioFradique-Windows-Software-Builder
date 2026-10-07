'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pipeline } = require('node:stream/promises');
const yazl = require('yazl');
const yauzl = require('yauzl');
const engine = require('../src/shared/project-export');
const { normalizePortableLink, importPortableProject } = require('../src/shared/portable-app');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-edge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetsDir = path.join(root, 'dist-assets');
  fs.mkdirSync(assetsDir);
  return { root, assetsDir, templatePath: path.join(root, 'template.zip'), outputPath: path.join(root, 'output.zip'), projectName: 'Edge', config: { content: [] } };
}

async function template(filename, target, lowerCaseExecutable = false) {
  const zip = new yazl.ZipFile();
  const writing = pipeline(zip.outputStream, fs.createWriteStream(filename));
  if (target === 'windows') {
    zip.addBuffer(Buffer.from('EXE'), 'LaunchBox Viewer.exe');
    zip.addBuffer(Buffer.from('ASAR'), 'resources/app.asar');
  } else {
    const root = 'LaunchBox Viewer.app/Contents';
    zip.addBuffer(Buffer.from('PLIST'), `${root}/Info.plist`);
    zip.addBuffer(Buffer.from('ASAR'), `${root}/Resources/app.asar`);
    zip.addBuffer(Buffer.from('BINARY'), `${root}/MacOS/${lowerCaseExecutable ? 'launchbox viewer' : 'LaunchBox Viewer'}`, { mode: 0o100755 });
  }
  zip.end();
  await writing;
}

function loadEngineWithFs(replacement, platform = process.platform) {
  const filename = require.resolve('../src/shared/project-export');
  const originalRequire = createRequire(filename);
  const holder = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Buffer, process: { versions: process.versions, platform }, module: holder, exports: holder.exports,
    require(name) { return name === 'fs' || name === 'original-fs' ? replacement : originalRequire(name); }
  }, { filename });
  return holder.exports;
}

test('same-size resource mutation after streaming starts aborts without replacing the previous export', async t => {
  const f = fixture(t);
  await template(f.templatePath, 'windows');
  const asset = path.join(f.assetsDir, 'large.bin');
  fs.writeFileSync(asset, Buffer.alloc(256 * 1024, 0x41));
  fs.writeFileSync(f.outputPath, 'PREVIOUS EXPORT');
  let changed = false;
  const promises = new Proxy(fs.promises, {
    get(target, property) {
      if (property !== 'open') return Reflect.get(target, property);
      return async (...args) => {
        const handle = await fs.promises.open(...args);
        if (args[0] !== asset) return handle;
        return new Proxy(handle, {
          get(value, key) {
            if (key === 'createReadStream') return options => {
              const stream = handle.createReadStream(options);
              stream.once('data', () => {
                const output = fs.openSync(asset, 'r+');
                try { fs.writeSync(output, Buffer.from('B'), 0, 1, 200 * 1024); }
                finally { fs.closeSync(output); }
                const later = new Date(Date.now() + 10000);
                fs.utimesSync(asset, later, later);
                changed = true;
              });
              return stream;
            };
            const member = Reflect.get(value, key, value);
            return typeof member === 'function' ? member.bind(value) : member;
          }
        });
      };
    }
  });
  const mockedFs = new Proxy(fs, { get(target, property) { return property === 'promises' ? promises : Reflect.get(target, property); } });
  await assert.rejects(loadEngineWithFs(mockedFs).exportProject({ ...f, target: 'windows' }), /mudou durante a exportação/);
  assert.equal(changed, true);
  assert.equal(fs.readFileSync(f.outputPath, 'utf8'), 'PREVIOUS EXPORT');
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['dist-assets', 'output.zip', 'template.zip']);
});

test('project names leave space for filesystem suffixes even with emoji and decomposed Unicode', () => {
  for (const input of ['😀'.repeat(80), 'ǘ'.repeat(80), 'Curso António']) {
    const name = engine.safeProjectName(input);
    for (const suffix of ['.app', '.data']) {
      assert.ok(Buffer.byteLength(name + suffix, 'utf8') <= 255);
      assert.ok(Buffer.byteLength((name + suffix).normalize('NFD'), 'utf8') <= 255);
    }
    assert.equal(name.includes('\ufffd'), false);
  }
  assert.equal(engine.safeProjectName('Curso António'), 'Curso António');
});

test('wrong-case executable in a Mac template produces a validation error instead of TypeError', async t => {
  const f = fixture(t);
  await template(f.templatePath, 'mac', true);
  await assert.rejects(engine.exportProject({ ...f, target: 'mac' }), error => {
    assert.equal(error.name, 'Error');
    assert.match(error.message, /Template incompleto/);
    return true;
  });
  assert.equal(fs.existsSync(f.outputPath), false);
});

test('Windows relative symlinks are canonicalised only after rejecting roots, drives and UNC', () => {
  assert.equal(normalizePortableLink('bin\\App.exe', 'win32'), 'bin/App.exe');
  assert.equal(normalizePortableLink('..\\assets\\image.png', 'win32'), '../assets/image.png');
  for (const target of ['C:\\app.exe', 'C:app.exe', '\\app.exe', '\\\\server\\share', '\\\\?\\C:\\app.exe', '/app.exe']) {
    assert.throws(() => normalizePortableLink(target, 'win32'), /externa ou inválida/);
  }
  assert.throws(() => normalizePortableLink('bin\\App.exe', 'darwin'), /externa ou inválida/);
  assert.equal(normalizePortableLink('../Versions/A', 'darwin'), '../Versions/A');
});

test('Windows native readlink separators become portable slash bytes in exported ZIP symlinks', async t => {
  const f = fixture(t);
  const sourcePath = path.join(f.root, 'portable');
  fs.mkdirSync(path.join(sourcePath, 'bin'), { recursive: true });
  const pe = Buffer.alloc(0x80 + 24 + 0xf0);
  pe.write('MZ'); pe.writeUInt32LE(0x80, 0x3c); pe.writeUInt32LE(0x4550, 0x80);
  pe.writeUInt16LE(0x8664, 0x84); pe.writeUInt16LE(0xf0, 0x94); pe.writeUInt16LE(2, 0x96); pe.writeUInt16LE(0x20b, 0x98);
  fs.writeFileSync(path.join(sourcePath, 'bin', 'App.exe'), pe);
  try { fs.symlinkSync('bin/App.exe', path.join(sourcePath, 'link.exe'), 'file'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Windows symlink creation requires Developer Mode.'); throw error; }
  const data = importPortableProject({ sourcePath, assetsDir: f.assetsDir, entries: { windows: 'bin/App.exe' } });
  f.config.content.push({ type: 'portable', data });
  await template(f.templatePath, 'windows');
  const promises = new Proxy(fs.promises, {
    get(target, property) {
      if (property !== 'readlink') return Reflect.get(target, property);
      return async filename => Buffer.from((await fs.promises.readlink(filename)).replace(/\//g, '\\'));
    }
  });
  const mockedFs = new Proxy(fs, { get(target, property) { return property === 'promises' ? promises : Reflect.get(target, property); } });
  await loadEngineWithFs(mockedFs, 'win32').exportProject({ ...f, target: 'windows' });
  const zip = await new Promise((resolve, reject) => yauzl.open(f.outputPath, { lazyEntries: true }, (error, archive) => error ? reject(error) : resolve(archive)));
  let found = false;
  await new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', entry => {
      if (!entry.fileName.endsWith('/link.exe')) return zip.readEntry();
      zip.openReadStream(entry, async (error, stream) => {
        if (error) return reject(error);
        try {
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          assert.equal(Buffer.concat(chunks).toString(), 'bin/App.exe');
          found = true;
          zip.readEntry();
        } catch (error) { reject(error); }
      });
    });
    zip.readEntry();
  });
  assert.equal(found, true);
});
