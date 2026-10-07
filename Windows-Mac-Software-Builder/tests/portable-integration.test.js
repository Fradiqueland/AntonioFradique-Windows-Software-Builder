const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const portableApps = require('../src/shared/portable-app');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}
function productionFunction(name) {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, 'm'));
  assert.ok(match);
  return match[0];
}
function pe() {
  const data = Buffer.alloc(512);
  data.write('MZ'); data.writeUInt32LE(64, 0x3c); data.write('PE\0\0', 64);
  data.writeUInt16LE(0x8664, 68); data.writeUInt16LE(0xf0, 84);
  data.writeUInt16LE(2, 86); data.writeUInt16LE(0x20b, 88);
  return data;
}
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-main-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const assetsDir = path.join(base, 'project', 'dist-assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  const input = path.join(base, 'input');
  fs.mkdirSync(path.join(input, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(input, 'Program.exe'), pe());
  fs.writeFileSync(path.join(input, 'resources', 'data.txt'), 'support file');
  let config = { brand: { title: 'Portable integration' }, content: [] };
  let failWrite = false;
  const writes = [];
  const handlers = new Map();
  const context = vm.createContext({ fs, path, crypto, console, ASSETS_DIR: assetsDir,
    portableApps, readConfig: () => JSON.parse(JSON.stringify(config)),
    writeConfig(value) {
      writes.push(fs.readdirSync(assetsDir));
      if (failWrite) throw new Error('disk full');
      config = JSON.parse(JSON.stringify(value));
    },
    assertBuilder() {}, handleTrustedIpc: (channel, handler) => handlers.set(channel, handler),
    localWeb: { removeWebProject() {} }, stopWebModules() {},
    deleteAssetIfInside() { throw new Error('unexpected single file cleanup'); }
  });
  vm.runInContext(section('const SINGLE_FILE_TYPES =', 'const LOCALES_DIR =') + '\n' +
    section('function sanitizeModule(', '/* -------- IPTV: obtenção/parse de canais'), context);
  return { base, assetsDir, input, writes, handlers, context,
    config: () => JSON.parse(JSON.stringify(config)), failWrite: (value) => { failWrite = value; },
    save: (modules) => JSON.parse(JSON.stringify(handlers.get('content:save')({}, { modules }))),
    module: (id = 'portable-one') => ({ id, type: 'portable', title: 'Portable program',
      data: { sourcePath: input, entries: { windows: 'Program.exe', mac: null }, allowWine: false } })
  };
}

test('production content handler imports the full portable folder and persists no source path', (t) => {
  const f = fixture(t), saved = f.save([f.module()]), data = saved.content[0].data;
  const inspected = portableApps.validatePortableProject({ data, assetsDir: f.assetsDir });
  assert.equal(fs.readFileSync(path.join(inspected.rootPath, 'resources/data.txt'), 'utf8'), 'support file');
  assert.equal(data.sourcePath, undefined);
  assert.deepEqual(f.config(), saved);
});

test('editing and reordering use saved roots, keep revisions and apply selected Wine permission', (t) => {
  const f = fixture(t), saved = f.save([f.module()]);
  const first = saved.content[0], root = first.data.root, revision = first.data.revision;
  const edited = f.save([{ ...first, title: 'Edited', data: { ...first.data,
    root: 'dist-assets/forged', revision: crypto.randomUUID(), allowWine: true } }]);
  assert.equal(edited.content[0].data.root, root);
  assert.equal(edited.content[0].data.revision, revision);
  assert.equal(edited.content[0].data.allowWine, true);
  assert.equal(fs.readdirSync(f.assetsDir).length, 1);
});

test('replacement retires the old folder only after the production configuration commit', (t) => {
  const f = fixture(t), first = f.save([f.module()]).content[0];
  const oldFolder = first.data.root.slice('dist-assets/'.length);
  const replacement = f.save([f.module()]).content[0];
  assert.notEqual(replacement.data.root, first.data.root);
  assert.ok(f.writes.at(-1).includes(oldFolder));
  assert.equal(fs.existsSync(path.join(f.assetsDir, oldFolder)), false);
});

test('a failed configuration commit removes the new portable copy and preserves the old one', (t) => {
  const f = fixture(t), first = f.save([f.module()]);
  f.failWrite(true);
  assert.throws(() => f.save([f.module()]), /disk full/);
  assert.deepEqual(f.config(), first);
  assert.deepEqual(fs.readdirSync(f.assetsDir), [first.content[0].data.root.slice('dist-assets/'.length)]);
});

test('a later invalid module rolls back earlier imports in the same save', (t) => {
  const f = fixture(t);
  const invalid = f.module('portable-invalid'); invalid.data.entries.windows = '../outside.exe';
  assert.throws(() => f.save([f.module(), invalid]), /executável selecionado/);
  assert.deepEqual(f.config().content, []);
  assert.deepEqual(fs.readdirSync(f.assetsDir), []);
});

test('deleting a portable module commits first, then removes its managed project copy', (t) => {
  const f = fixture(t), first = f.save([f.module()]).content[0];
  f.save([]);
  assert.deepEqual(f.config().content, []);
  assert.ok(f.writes.at(-1).includes(first.data.root.slice('dist-assets/'.length)));
  assert.deepEqual(fs.readdirSync(f.assetsDir), []);
});

test('project asset copying preserves all portable resources and executable permissions', (t) => {
  const f = fixture(t), saved = f.save([f.module()]);
  const destination = path.join(f.base, 'duplicate-assets');
  vm.runInContext(productionFunction('copyDirRecursive') + '\n' + productionFunction('copyProjectAssets'), f.context);
  f.context.copyProjectAssets(f.assetsDir, destination, saved);
  const original = portableApps.validatePortableProject({ data: saved.content[0].data, assetsDir: f.assetsDir });
  const duplicate = portableApps.validatePortableProject({ data: saved.content[0].data, assetsDir: destination });
  assert.deepEqual(fs.readFileSync(duplicate.launchPaths.windows), fs.readFileSync(original.launchPaths.windows));
  assert.equal(fs.readFileSync(path.join(duplicate.rootPath, 'resources/data.txt'), 'utf8'), 'support file');
});

test('launch IPC resolves a saved module ID rather than accepting a renderer executable path', async (t) => {
  const f = fixture(t), saved = f.save([f.module()]);
  const handlers = new Map(), calls = [];
  const context = vm.createContext({ fs, path, crypto, console, process: { arch: 'x64' }, ASSETS_DIR: f.assetsDir,
    app: { getPath: () => f.base, runningUnderARM64Translation: true },
    PORTABLE_LOCAL_DIR: path.join(f.base, 'internal-data'), exportBusy: false,
    findModuleById: (list, id) => list.find(item => item.id === id), readConfig: f.config,
    readPortableWineSettings: () => null, handleTrustedIpc: (channel, handler) => handlers.set(channel, handler),
    portableRuntime: { launchPortableProject: async options => { calls.push(options); return { ok: true, via: 'native' }; } }
  });
  vm.runInContext(section("handleTrustedIpc('portable:launch'", '/* Viewer: "Guardar como"'), context);
  const launch = handlers.get('portable:launch');
  await assert.rejects(launch({}, '/outside/Program.exe'), /não encontrado/);
  await launch({}, saved.content[0].id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data.root, saved.content[0].data.root);
  assert.equal(calls[0].arch, 'arm64', 'Electron x64 under translation must use the ARM64 host architecture');
  assert.ok(calls[0].storageDir.startsWith(path.join(f.base, 'internal-data')));
});
