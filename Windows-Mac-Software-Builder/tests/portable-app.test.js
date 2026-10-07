'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const portable = require('../src/shared/portable-app');

function pe({ machine = 0x8664, characteristics = 2 } = {}) {
  const data = Buffer.alloc(0x80 + 24 + 0xf0);
  data.write('MZ');
  data.writeUInt32LE(0x80, 0x3c);
  data.writeUInt32LE(0x4550, 0x80);
  data.writeUInt16LE(machine, 0x84);
  data.writeUInt16LE(0xf0, 0x94);
  data.writeUInt16LE(characteristics, 0x96);
  data.writeUInt16LE(0x20b, 0x98);
  return data;
}

function macho(cpu = 0x1000007, filetype = 2) {
  const data = Buffer.alloc(32);
  data.writeUInt32LE(0xfeedfacf, 0);
  data.writeUInt32LE(cpu, 4);
  data.writeUInt32LE(filetype, 12);
  return data;
}

function fat() {
  const data = Buffer.alloc(8192 + 32);
  data.writeUInt32BE(0xcafebabe, 0);
  data.writeUInt32BE(2, 4);
  for (const [index, cpu] of [0x1000007, 0x100000c].entries()) {
    const offset = (index + 1) * 4096;
    const at = 8 + index * 20;
    data.writeUInt32BE(cpu, at);
    data.writeUInt32BE(offset, at + 8);
    data.writeUInt32BE(32, at + 12);
    data.writeUInt32BE(12, at + 16);
    macho(cpu).copy(data, offset);
  }
  return data;
}

function binaryPlist(executable) {
  function string(value) {
    const bytes = Buffer.from(value, 'utf16le').swap16();
    return Buffer.concat([Buffer.from(value.length < 15 ? [0x60 | value.length] : [0x6f, 0x10, value.length]), bytes]);
  }
  const objects = [Buffer.from([0xd1, 1, 2]), string('CFBundleExecutable'), string(executable)];
  const offsets = [];
  let offset = 8;
  for (const object of objects) { offsets.push(offset); offset += object.length; }
  const trailer = Buffer.alloc(32);
  trailer[6] = 1;
  trailer[7] = 1;
  trailer.writeBigUInt64BE(3n, 8);
  trailer.writeBigUInt64BE(BigInt(offset), 24);
  return Buffer.concat([Buffer.from('bplist00'), ...objects, Buffer.from(offsets), trailer]);
}

function fixture(t, sourceName = 'Portable Suite') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-app-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, sourceName);
  const assetsDir = path.join(root, 'dist-assets');
  fs.mkdirSync(sourcePath);
  fs.mkdirSync(assetsDir);
  function write(relative, content, mode = 0o644) {
    const filename = path.join(sourcePath, ...relative.split('/'));
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content, { mode });
    return filename;
  }
  function app(prefix = 'Mac App.app', plistType = 'xml') {
    const base = prefix ? `${prefix}/` : '';
    const executable = 'Aplicação';
    write(`${base}Contents/Info.plist`, plistType === 'binary' ? binaryPlist(executable) : `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${executable}</string></dict></plist>`);
    write(`${base}Contents/MacOS/${executable}`, fat(), 0o755);
    write(`${base}Contents/Resources/app.asar`, Buffer.from([0, 1, 2, 255]));
    // A nested helper must never be offered instead of the outer bundle.
    write(`${base}Contents/MacOS/helper`, macho(0x1000007), 0o755);
  }
  return { root, sourcePath, assetsDir, write, app };
}

function linkOrSkip(t, target, filename) {
  try { fs.symlinkSync(target, filename); return true; }
  catch (error) { if (error.code === 'EPERM') { t.skip('Windows symlinks require Developer Mode or administrator permission.'); return false; } throw error; }
}

test('scan detects real PE and universal Mach-O, ignores DLL/fake extensions and nested app helpers', t => {
  const f = fixture(t);
  f.write('Portable.exe', pe());
  f.write('uninstall.exe', pe());
  f.write('fake.exe', 'not a native program');
  f.write('library.exe', pe({ characteristics: 0x2002 }));
  f.write('not-executable.exe', pe({ characteristics: 0 }));
  f.write('mac-tool', macho(0x100000c), 0o755);
  f.write('library.dylib', macho(0x1000007, 6));
  f.app();
  const scan = portable.scanPortableFolder(f.sourcePath);
  assert.deepEqual(scan.candidates.map(item => item.path).sort(), ['Mac App.app', 'Portable.exe', 'mac-tool', 'uninstall.exe'].sort());
  assert.deepEqual(scan.candidates.find(item => item.kind === 'app').architectures, ['x64', 'arm64']);
  assert.deepEqual(scan.candidates.find(item => item.path === 'Portable.exe').architectures, ['x64']);
  assert.equal(scan.candidates.at(-1).path, 'uninstall.exe');
  assert.equal(scan.hasSymlinks, false);
});

test('XML and binary plist root .app imports preserve bundle name, modes and opaque app.asar', t => {
  for (const kind of ['xml', 'binary']) {
    const f = fixture(t, `${kind} Aplicação.app`);
    f.app('', kind);
    const originalAsar = fs.readFileSync(path.join(f.sourcePath, 'Contents/Resources/app.asar'));
    const scan = portable.scanPortableFolder(f.sourcePath);
    assert.equal(scan.candidates[0].path, '.');
    const data = portable.importPortableProject({ ...f, entries: { mac: '.', windows: null } });
    assert.equal(data.entries.mac, `${kind} Aplicação.app`);
    const inspected = portable.validatePortableProject({ data, assetsDir: f.assetsDir });
    const launchPath = inspected.launchPaths.mac;
    if (process.platform !== 'win32') {
      const valid = portable.assertPortableTarget({ data, assetsDir: f.assetsDir, target: 'mac' });
      assert.equal(valid.launchKind, 'app');
      assert.equal(valid.requiresWine, false);
      assert.deepEqual(valid.architectures, ['x64', 'arm64']);
      assert.equal(fs.statSync(path.join(launchPath, 'Contents/MacOS/Aplicação')).mode & 0o777, 0o755);
    } else {
      assert.throws(() => portable.assertPortableTarget({ data, assetsDir: f.assetsDir, target: 'mac' }), /permissão de execução/);
    }
    assert.deepEqual(fs.readFileSync(path.join(launchPath, 'Contents/Resources/app.asar')), originalAsar);
    assert.deepEqual(fs.readFileSync(path.join(f.sourcePath, 'Contents/Resources/app.asar')), originalAsar);
  }
});

test('import preserves internal relative symlink chains; copy can materialize them for Windows', t => {
  const f = fixture(t);
  f.write('App.exe', pe());
  f.write('assets/original.txt', 'DATA');
  if (!linkOrSkip(t, 'assets', path.join(f.sourcePath, 'assets-link'))) return;
  if (!linkOrSkip(t, 'assets-link/original.txt', path.join(f.sourcePath, 'file-link'))) return;
  const data = portable.importPortableProject({ ...f, entries: { windows: 'App.exe' } });
  const valid = portable.validatePortableProject({ data, assetsDir: f.assetsDir });
  assert.equal(valid.hasSymlinks, true);
  assert.equal(fs.readlinkSync(path.join(valid.rootPath, 'file-link')), 'assets-link/original.txt');
  const destination = path.join(f.root, 'work-copy');
  portable.copyPortableTree(valid.rootPath, destination, { dereferenceLinks: true });
  assert.equal(fs.lstatSync(path.join(destination, 'assets-link')).isDirectory(), true);
  assert.equal(fs.lstatSync(path.join(destination, 'file-link')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(destination, 'file-link'), 'utf8'), 'DATA');
  assert.throws(() => portable.copyPortableTree(valid.rootPath, destination), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(destination, 'file-link'), 'utf8'), 'DATA');
});

test('external, dangling and cyclic symlinks are rejected before creating managed data', t => {
  for (const type of ['escape', 'absolute', 'dangling', 'cycle', 'directory-cycle']) {
    const f = fixture(t);
    f.write('App.exe', pe());
    fs.writeFileSync(path.join(f.root, 'secret.txt'), 'SECRET');
    const target = type === 'escape' ? '../secret.txt' : type === 'absolute' ? path.join(f.root, 'secret.txt') : type === 'dangling' ? 'missing.txt' : type === 'cycle' ? 'two' : '.';
    if (!linkOrSkip(t, target, path.join(f.sourcePath, 'one'))) return;
    if (type === 'cycle') fs.symlinkSync('one', path.join(f.sourcePath, 'two'));
    assert.throws(() => portable.importPortableProject({ ...f, entries: { windows: 'App.exe' } }), /simbólica|simbólicas/);
    assert.deepEqual(fs.readdirSync(f.assetsDir), []);
  }
});

test('Wine is explicitly opt-in and never overrides a selected native Mac entry', t => {
  const f = fixture(t);
  f.write('App.exe', pe());
  f.write('mac-tool', macho(), 0o755);
  let data = portable.importPortableProject({ ...f, entries: { windows: 'App.exe' } });
  assert.throws(() => portable.assertPortableTarget({ data, assetsDir: f.assetsDir, target: 'mac' }), /Wine/);
  data = portable.updatePortableProject({ data, assetsDir: f.assetsDir, entries: data.entries, allowWine: true });
  const wine = portable.assertPortableTarget({ data, assetsDir: f.assetsDir, target: 'mac' });
  assert.equal(wine.requiresWine, true);
  assert.equal(wine.launchKind, 'exe');
  assert.match(wine.warnings.join(' '), /não é garantida/);
  data = portable.updatePortableProject({ data, assetsDir: f.assetsDir, entries: { windows: 'App.exe', mac: 'mac-tool' }, allowWine: true });
  if (process.platform !== 'win32') assert.equal(portable.assertPortableTarget({ data, assetsDir: f.assetsDir, target: 'mac' }).requiresWine, false);
  else assert.throws(() => portable.assertPortableTarget({ data, assetsDir: f.assetsDir, target: 'mac' }), /permissão de execução/);
});

test('changes preserve the import revision and revalidate real files instead of trusting candidates', t => {
  const f = fixture(t);
  f.write('App.exe', pe());
  f.write('Other.exe', pe({ machine: 0xaa64 }));
  const data = portable.importPortableProject({ ...f, entries: { windows: 'App.exe' } });
  const updated = portable.updatePortableProject({ data, assetsDir: f.assetsDir, entries: { windows: 'Other.exe' }, allowWine: false });
  assert.equal(updated.revision, data.revision);
  assert.deepEqual(portable.assertPortableTarget({ data: updated, assetsDir: f.assetsDir, target: 'windows' }).architectures, ['arm64']);
  const root = portable.validatePortableProject({ data, assetsDir: f.assetsDir }).rootPath;
  fs.writeFileSync(path.join(root, 'App.exe'), 'damaged');
  assert.throws(() => portable.validatePortableProject({ data: { ...data, candidates: [{ path: 'App.exe', platform: 'windows' }] }, assetsDir: f.assetsDir }), /não é válido/);
});

test('managed roots, selections and recursive source destinations cannot escape their boundary', t => {
  const f = fixture(t);
  f.write('App.exe', pe());
  assert.throws(() => portable.importPortableProject({ ...f, entries: { windows: '../outside.exe' } }), /não é válido/);
  assert.throws(() => portable.importPortableProject({ ...f, assetsDir: f.sourcePath, entries: { windows: 'App.exe' } }), /conter-se/);
  const data = portable.importPortableProject({ ...f, entries: { windows: 'App.exe' } });
  assert.throws(() => portable.removePortableProject({ data: { ...data, root: 'dist-assets/../Portable Suite' }, assetsDir: f.assetsDir }), /diretório/);
  assert.equal(fs.existsSync(f.sourcePath), true);
  assert.throws(() => portable.copyPortableTree(f.sourcePath, path.join(f.sourcePath, 'copy')), /Destino inválido/);
  assert.equal(portable.removePortableProject({ data, assetsDir: f.assetsDir }), true);
  assert.equal(portable.removePortableProject({ data, assetsDir: f.assetsDir }), false);
});

test('native header truncation, DLLs and invalid app plist/executable are not valid launch targets', t => {
  const f = fixture(t);
  f.write('short.exe', pe().subarray(0, 100));
  f.write('fake-fat', Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]));
  assert.deepEqual(portable.scanPortableFolder(f.sourcePath).candidates, []);
  f.app();
  f.write('Mac App.app/Contents/Info.plist', '<plist><dict><key>CFBundleExecutable</key><string>../../outside</string></dict></plist>');
  assert.throws(() => portable.scanPortableFolder(f.sourcePath), /nome de ficheiro seguro/);
  f.write('Mac App.app/Contents/Info.plist', binaryPlist('missing'));
  assert.throws(() => portable.scanPortableFolder(f.sourcePath), /em falta/);
});

test('oversized files are rejected before import without allocating their contents', t => {
  const f = fixture(t);
  f.write('App.exe', pe());
  const filename = f.write('oversized.bin', '');
  fs.truncateSync(filename, portable.LIMITS.fileBytes + 1);
  assert.throws(() => portable.importPortableProject({ ...f, entries: { windows: 'App.exe' } }), /limites/);
  assert.deepEqual(fs.readdirSync(f.assetsDir), []);
});

test('Mac export rejects valid native code when executable permissions have been lost', t => {
  const f = fixture(t);
  f.write('mac-tool', macho(), 0o644);
  f.app();
  fs.chmodSync(path.join(f.sourcePath, 'Mac App.app/Contents/MacOS/Aplicação'), 0o644);
  for (const mac of ['mac-tool', 'Mac App.app']) {
    const data = portable.importPortableProject({ ...f, entries: { mac } });
    assert.throws(() => portable.assertPortableTarget({ data, assetsDir: f.assetsDir, target: 'mac' }), /sem permissão de execução.*num Mac/);
  }
});

test('plist comments, nested dictionaries and duplicate wrong-type executable keys cannot spoof the bundle entry', t => {
  const f = fixture(t);
  f.app();
  const plist = 'Mac App.app/Contents/Info.plist';
  f.write(plist, '<plist><dict><!-- <key>CFBundleExecutable</key><string>ignored</string> --><key>Nested</key><dict><key>CFBundleExecutable</key><string>ignored</string></dict><key>CFBundleExecutable</key><string>Aplicação</string></dict></plist>');
  assert.equal(portable.scanPortableFolder(f.sourcePath).candidates[0].path, 'Mac App.app');
  f.write(plist, '<plist><dict><key>CFBundleExecutable</key><string>Aplicação</string><key>CFBundleExecutable</key><integer>3</integer></dict></plist>');
  assert.throws(() => portable.scanPortableFolder(f.sourcePath), /tipo string/);
});
