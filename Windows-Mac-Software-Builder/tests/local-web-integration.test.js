const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const localWeb = require('../src/shared/local-web');
const { isTrustedFrame, lockGuestPreferences } = require('../src/shared/electron-security');

const projectRoot = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');

// Run the production handlers/functions, without importing main.js (which starts
// Electron). Import, validation, removal, config writes and recursive copies use
// real temporary files. Electron delivery, Chromium guest isolation, PHP startup
// and Windows SFX packaging are NOT simulated by these integration tests.
function sourceSection(start, end) {
  const first = mainSource.indexOf(start);
  const last = mainSource.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Production section missing: ${start}`);
  return mainSource.slice(first, last);
}

function sourceFunction(name) {
  const match = mainSource.match(new RegExp(`^function ${name}\\([^]*?^\\}`, 'm'));
  assert.ok(match, `Production function missing: ${name}`);
  return match[0];
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapshotFiles(root) {
  const files = {};
  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) files[path.relative(root, abs)] = fs.readFileSync(abs).toString('base64');
    }
  }
  visit(root);
  return files;
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-web-integration-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const assetsDir = path.join(base, 'project', 'dist-assets');
  const dataDir = path.join(base, 'project', 'data');
  const configPath = path.join(dataDir, 'project-config.json');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ brand: { title: 'Integration' }, content: [] }));
  const sourceDir = path.join(base, 'source-html');
  fs.mkdirSync(path.join(sourceDir, 'css'), { recursive: true });
  fs.mkdirSync(path.join(sourceDir, 'js'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'index.html'), '<link rel="stylesheet" href="css/site.css"><script src="js/app.js"></script>');
  fs.writeFileSync(path.join(sourceDir, 'css', 'site.css'), 'body { color: navy; }');
  fs.writeFileSync(path.join(sourceDir, 'js', 'app.js'), 'document.title = "Imported";');
  const phpDir = path.join(base, 'source-php');
  fs.mkdirSync(phpDir, { recursive: true });
  fs.writeFileSync(path.join(phpDir, 'index.php'), '<?php echo "Replacement";');

  const events = [];
  const state = { failConfigWrite: false, failConfigRename: false, failTimestamp: false };
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const observedFs = Object.assign({}, fs, {
    writeFileSync(file, contents, ...args) {
      if (String(file).startsWith(configPath + '.') && state.failConfigWrite) {
        // Deliberately leave a partial temporary file before the failure.
        fs.writeFileSync(file, '{"partial":', 'utf8');
        throw new Error('Simulated disk full while saving configuration');
      }
      return fs.writeFileSync(file, contents, ...args);
    },
    renameSync(from, to) {
      if (to === configPath) {
        events.push({ kind: 'before-commit', assets: snapshotFiles(assetsDir) });
        if (state.failConfigRename) throw new Error('Simulated configuration rename failure');
      }
      const result = fs.renameSync(from, to);
      if (to === configPath) events.push({ kind: 'commit', config: readConfig() });
      return result;
    }
  });
  const observedWeb = {
    importWebProject(options) {
      const data = localWeb.importWebProject(options);
      events.push({ kind: 'import', data: plain(data) });
      return data;
    },
    validateWebProject(options) {
      events.push({ kind: 'validate', data: plain(options.data) });
      return localWeb.validateWebProject(options);
    },
    removeWebProject(options) {
      events.push({ kind: 'remove', data: plain(options.data), config: readConfig() });
      return localWeb.removeWebProject(options);
    }
  };
  const handlers = new Map();
  const context = vm.createContext({
    fs: observedFs, path, crypto, console: { warn() {} },
    ASSETS_DIR: assetsDir, CONFIG_PATH: configPath, isViewer: false,
    localWeb: observedWeb, readConfig,
    ensureDirs() {
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.mkdirSync(dataDir, { recursive: true });
    },
    touchActiveProject() {
      if (state.failTimestamp) throw new Error('Simulated project timestamp failure');
    },
    assertBuilder() {},
    stopWebModules() { events.push({ kind: 'stop-runtime' }); },
    handleTrustedIpc(channel, handler) { handlers.set(channel, handler); },
    copyAssetToProject() { throw new Error('Unexpected single-file import in web test'); },
    deleteAssetIfInside() { throw new Error('Unexpected single-file cleanup in web test'); }
  });
  vm.runInContext([
    sourceSection('const SINGLE_FILE_TYPES =', 'const LOCALES_DIR ='),
    sourceFunction('writeConfig'),
    sourceFunction('cleanupFiles'),
    sourceSection('function sanitizeModule(', '/* -------- IPTV: obtenção/parse de canais')
  ].join('\n'), context, { filename: 'main.js [content integration]' });
  const save = (modules) => plain(handlers.get('content:save')({}, { modules }));
  const htmlModule = () => ({
    id: 'web-one', type: 'local-web', title: 'HTML import',
    data: { sourcePath: path.join(sourceDir, 'index.html'), includeDirectory: true }
  });
  const replacement = () => ({
    id: 'web-one', type: 'local-web', title: 'PHP replacement',
    data: { sourcePath: path.join(phpDir, 'index.php'), includeDirectory: false }
  });
  return { base, assetsDir, dataDir, configPath, sourceDir, events, state, readConfig, save, htmlModule, replacement };
}

test('content:save imports HTML and preserves relative resources and project metadata', (t) => {
  const f = fixture(t);
  const saved = f.save([f.htmlModule()]);
  const data = saved.content[0].data;
  assert.equal(data.fileName, 'index.html');
  assert.equal(data.requiresPhp, false);
  assert.equal(data.fileCount, 3);
  assert.equal(typeof data.root, 'string');
  assert.equal(typeof data.entry, 'string');
  assert.equal(data.sourcePath, undefined, 'Machine source path must not be stored');
  assert.deepEqual(saved.brand, { title: 'Integration' });
  assert.deepEqual(f.readConfig(), saved);
  const imported = Object.entries(snapshotFiles(f.assetsDir));
  assert.equal(imported.length, 3);
  assert.ok(imported.some(([file]) => file.endsWith(path.join('css', 'site.css'))));
  assert.ok(imported.some(([file]) => file.endsWith(path.join('js', 'app.js'))));
});

test('content:save edits and reorders without reimporting or trusting a replacement root', (t) => {
  const f = fixture(t);
  const saved = f.save([f.htmlModule(), { id: 'article', type: 'article-reader', title: 'Text', data: { text: 'Hello' } }]);
  const original = saved.content[0];
  const assets = snapshotFiles(f.assetsDir);
  f.events.length = 0;
  const edited = f.save([
    saved.content[1],
    { ...original, title: 'Renamed', data: { root: 'dist-assets/untrusted', entry: 'other.php' } }
  ]);
  assert.deepEqual(edited.content.map((mod) => mod.id), ['article', 'web-one']);
  assert.equal(edited.content[1].title, 'Renamed');
  assert.deepEqual(edited.content[1].data, original.data);
  assert.deepEqual(snapshotFiles(f.assetsDir), assets);
  assert.equal(f.events.filter((event) => event.kind === 'import').length, 0);
  assert.equal(f.events.filter((event) => event.kind === 'remove').length, 0);
  assert.equal(f.events.filter((event) => event.kind === 'validate').length, 1);
});

test('content:save retires a replaced import only after the new configuration is committed', (t) => {
  const f = fixture(t);
  const initial = f.save([f.htmlModule()]);
  const oldData = initial.content[0].data;
  const oldFiles = snapshotFiles(f.assetsDir);
  f.events.length = 0;
  const updated = f.save([f.replacement()]);
  const newData = updated.content[0].data;
  assert.equal(newData.requiresPhp, true);
  assert.notEqual(newData.root, oldData.root);
  const beforeCommit = f.events.find((event) => event.kind === 'before-commit');
  for (const [file, bytes] of Object.entries(oldFiles)) assert.equal(beforeCommit.assets[file], bytes);
  const removal = f.events.find((event) => event.kind === 'remove');
  assert.equal(removal.data.root, oldData.root);
  assert.equal(removal.config.content[0].data.root, newData.root);
  assert.ok(f.events.findIndex((event) => event.kind === 'commit') < f.events.findIndex((event) => event.kind === 'remove'));
  const newFiles = snapshotFiles(f.assetsDir);
  for (const file of Object.keys(oldFiles)) assert.equal(newFiles[file], undefined);
  assert.equal(Object.keys(newFiles).length, 1);
  assert.ok(Object.keys(newFiles)[0].endsWith('index.php'));
});

for (const failure of ['failConfigWrite', 'failConfigRename']) {
  test(`content:save keeps previous configuration/assets and removes the new import on ${failure}`, (t) => {
    const f = fixture(t);
    const initial = f.save([f.htmlModule()]);
    const oldFiles = snapshotFiles(f.assetsDir);
    f.events.length = 0;
    f.state[failure] = true;
    assert.throws(() => f.save([f.replacement()]), /Simulated/);
    assert.deepEqual(f.readConfig(), initial);
    assert.deepEqual(snapshotFiles(f.assetsDir), oldFiles);
    assert.deepEqual(fs.readdirSync(f.dataDir), ['project-config.json'], 'Partial config files must be cleaned up');
    const imported = f.events.find((event) => event.kind === 'import');
    const removed = f.events.filter((event) => event.kind === 'remove');
    assert.equal(removed.length, 1);
    assert.equal(removed[0].data.root, imported.data.root);
    assert.notEqual(removed[0].data.root, initial.content[0].data.root);
    assert.equal(f.events.filter((event) => event.kind === 'commit').length, 0);
  });
}

test('content:save rolls back a new import when a later module fails validation', (t) => {
  const f = fixture(t);
  const initial = f.save([f.htmlModule()]);
  const oldFiles = snapshotFiles(f.assetsDir);
  assert.throws(() => f.save([
    f.replacement(), { id: 'never-imported', type: 'local-web', title: 'Missing', data: {} }
  ]), /Selecione um ficheiro/);
  assert.deepEqual(f.readConfig(), initial);
  assert.deepEqual(snapshotFiles(f.assetsDir), oldFiles);
});

test('a timestamp failure after config commit does not roll back the imported files', (t) => {
  const f = fixture(t);
  f.save([f.htmlModule()]);
  f.state.failTimestamp = true;
  const updated = f.save([f.replacement()]);
  assert.deepEqual(f.readConfig(), updated);
  localWeb.validateWebProject({ data: updated.content[0].data, assetsDir: f.assetsDir });
  assert.equal(Object.keys(snapshotFiles(f.assetsDir)).length, 1);
});

test('removing a web module commits first and then removes its imported directory', (t) => {
  const f = fixture(t);
  f.save([f.htmlModule()]);
  f.events.length = 0;
  f.save([]);
  assert.deepEqual(f.readConfig().content, []);
  assert.deepEqual(snapshotFiles(f.assetsDir), {});
  const removal = f.events.find((event) => event.kind === 'remove');
  assert.deepEqual(removal.config.content, []);
  assert.ok(f.events.findIndex((event) => event.kind === 'commit') < f.events.findIndex((event) => event.kind === 'remove'));
});

test('the export copy helper copies nested web resources byte for byte', (t) => {
  const f = fixture(t);
  f.save([f.htmlModule()]);
  const context = vm.createContext({ fs, path });
  vm.runInContext(sourceFunction('copyDirRecursive'), context);
  const stagedAssets = path.join(f.base, 'staging', 'resources', 'dist-assets');
  context.copyDirRecursive(f.assetsDir, stagedAssets);
  assert.deepEqual(snapshotFiles(stagedAssets), snapshotFiles(f.assetsDir));
});

test('the export copy helper rejects symbolic links rather than copying outside resources', (t) => {
  const f = fixture(t);
  const secret = path.join(f.base, 'outside.txt');
  fs.writeFileSync(secret, 'Must not be exported');
  try {
    fs.symlinkSync(secret, path.join(f.assetsDir, 'escape.txt'));
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') return t.skip('Symlink creation unavailable for this user');
    throw err;
  }
  const context = vm.createContext({ fs, path });
  vm.runInContext(sourceFunction('copyDirRecursive'), context);
  const destination = path.join(f.base, 'staged');
  assert.throws(() => context.copyDirRecursive(f.assetsDir, destination), /Recurso não suportado/);
  assert.equal(fs.existsSync(path.join(destination, 'escape.txt')), false);
});

function fakeWindow(entryPath) {
  const webContents = { mainFrame: { url: pathToFileURL(entryPath).href } };
  return { webContents, isDestroyed: () => false };
}

function eventFrom(window) {
  return { sender: window.webContents, senderFrame: window.webContents.mainFrame };
}

test('trusted IPC frames require the exact window, main frame and entry URL', () => {
  const entry = path.join(projectRoot, 'src', 'builder', 'index.html');
  const window = fakeWindow(entry);
  const event = eventFrom(window);
  assert.equal(isTrustedFrame(event, window, entry), true);
  assert.equal(isTrustedFrame({ ...event, senderFrame: { url: event.senderFrame.url } }, window, entry), false, 'Subframe with the same URL must be rejected');
  assert.equal(isTrustedFrame({ ...event, sender: fakeWindow(entry).webContents }, window, entry), false, 'A different window must be rejected');
  for (const url of ['https://example.test/', pathToFileURL(entry).href + '?guest=1', pathToFileURL(path.join(projectRoot, 'dist-assets', 'index.html')).href]) {
    window.webContents.mainFrame.url = url;
    assert.equal(isTrustedFrame(event, window, entry), false, `Unexpected URL: ${url}`);
  }
  assert.equal(isTrustedFrame(event, { ...window, isDestroyed: () => true }, entry), false);
  assert.equal(isTrustedFrame(event, null, entry), false);
});

test('the IPC registration wrapper denies viewer edits and untrusted frames', () => {
  const builder = fakeWindow(path.join(projectRoot, 'src/builder/index.html'));
  const viewer = fakeWindow(path.join(projectRoot, 'src/viewer/index.html'));
  const handlers = new Map();
  const context = vm.createContext({
    path, PROJECT_ROOT: projectRoot, isTrustedFrame, builderWindow: builder, viewerWindow: viewer,
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } }
  });
  vm.runInContext(sourceSection('const VIEWER_CHANNELS =', 'function handleTrustedIpc') + sourceFunction('handleTrustedIpc'), context);
  context.handleTrustedIpc('content:save', () => 'saved');
  context.handleTrustedIpc('config:load', () => 'loaded');
  assert.equal(handlers.get('content:save')(eventFrom(builder)), 'saved');
  assert.equal(handlers.get('config:load')(eventFrom(viewer)), 'loaded');
  assert.throws(() => handlers.get('content:save')(eventFrom(viewer)), /Origem IPC não autorizada/);
  const subframe = { ...eventFrom(builder), senderFrame: { url: builder.webContents.mainFrame.url } };
  assert.throws(() => handlers.get('config:load')(subframe), /Origem IPC não autorizada/);
  const guestWindow = fakeWindow(path.join(projectRoot, 'src/builder/index.html'));
  assert.throws(() => handlers.get('content:save')(eventFrom(guestWindow)), /Origem IPC não autorizada/);
});

test('guest preferences remove preload and all Node integration privileges', () => {
  const preferences = {
    preload: '/untrusted/preload.js', preloadURL: 'file:///untrusted/preload.js',
    nodeIntegration: true, nodeIntegrationInWorker: true, nodeIntegrationInSubFrames: true,
    contextIsolation: false, sandbox: false, webSecurity: false,
    allowRunningInsecureContent: true, webviewTag: true
  };
  lockGuestPreferences(preferences);
  assert.equal(Object.hasOwn(preferences, 'preload'), false);
  assert.equal(Object.hasOwn(preferences, 'preloadURL'), false);
  for (const name of ['nodeIntegration', 'nodeIntegrationInWorker', 'nodeIntegrationInSubFrames', 'allowRunningInsecureContent', 'webviewTag']) assert.equal(preferences[name], false, name);
  for (const name of ['contextIsolation', 'sandbox', 'webSecurity']) assert.equal(preferences[name], true, name);
});
