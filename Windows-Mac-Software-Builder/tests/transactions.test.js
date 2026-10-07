'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function productionFunction(name) {
  const found = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, 'm'));
  assert.ok(found, `Missing production function ${name}`);
  return found[0];
}
function productionHandler(channel) {
  const found = source.match(new RegExp(`^handleTrustedIpc\\('${channel}',[^]*?^\\}\\);`, 'm'));
  assert.ok(found, `Missing production handler ${channel}`);
  return found[0];
}
function snapshot(root) {
  const files = {};
  function visit(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, item.name);
      if (item.isDirectory()) visit(filename);
      else files[path.relative(root, filename)] = fs.readFileSync(filename).toString('base64');
    }
  }
  visit(root);
  return files;
}

// Production functions/IPC bodies run against real temporary files. Only native
// dialogs, shell launches and injected I/O failures are mocked; Electron itself
// and an actual OS process launch are outside this test's scope.
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'builder-transactions-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  const project = path.join(projects, 'p-original');
  const data = path.join(project, 'data');
  const assets = path.join(project, 'dist-assets');
  const config = path.join(data, 'project-config.json');
  const index = path.join(root, 'projects.json');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(assets, { recursive: true });
  const failure = { configWrite: false, configRename: false, indexWrite: false, indexRename: false, copyAt: 0 };
  const events = [];
  let copies = 0;
  const observedFs = { ...fs,
    writeFileSync(filename, contents, ...options) {
      if ((failure.configWrite && String(filename).startsWith(config + '.')) ||
          (failure.indexWrite && String(filename).startsWith(index + '.'))) {
        fs.writeFileSync(filename, '{"partial":', 'utf8');
        throw new Error('Injected disk full');
      }
      return fs.writeFileSync(filename, contents, ...options);
    },
    renameSync(from, to) {
      events.push({ kind: 'rename', to, oldProjectExists: fs.existsSync(project), oldAssets: fs.existsSync(assets) ? fs.readdirSync(assets) : [] });
      if ((failure.configRename && to === config) || (failure.indexRename && to === index)) throw new Error('Injected rename failure');
      return fs.renameSync(from, to);
    },
    copyFileSync(from, to, ...options) {
      if (failure.copyAt && ++copies === failure.copyAt) {
        fs.writeFileSync(to, 'PARTIAL COPY');
        throw new Error('Injected copy failure');
      }
      return fs.copyFileSync(from, to, ...options);
    },
    rmSync(filename, ...options) {
      events.push({ kind: 'remove', filename, index: fs.existsSync(index) ? fs.readFileSync(index, 'utf8') : null });
      return fs.rmSync(filename, ...options);
    }
  };
  const handlers = new Map();
  const launched = [];
  const saved = [];
  const ctx = vm.createContext({
    fs: observedFs, path, crypto, structuredClone,
    console: { warn() {}, error() {} }, isViewer: false, exportBusy: false,
    WRITE_BASE: root, PROJECTS_ROOT: projects, PROJECTS_INDEX: index,
    DATA_DIR: data, ASSETS_DIR: assets, CONFIG_PATH: config, ICON_DEST_PATH: path.join(data, 'icon.ico'),
    stopWebModules: () => Promise.resolve(),
    portableApps: { validatePortableProject() { throw new Error('Unexpected portable fixture'); } },
    handleTrustedIpc(channel, handler) { handlers.set(channel, handler); },
    BrowserWindow: { getFocusedWindow: () => null }, viewerWindow: null, builderWindow: null,
    shell: { async openPath(filename) { launched.push(filename); return ''; } },
    dialog: { async showSaveDialog(_parent, options) { saved.push(options); return { filePath: path.join(root, 'download.bin') }; } }
  });
  const names = ['ensureDirs', 'hasProject', 'genProjectId', 'projectDir', 'sanitizeProjectName', 'applyActiveProjectPaths',
    'createProjectFolder', 'readProjectsIndex', 'writeProjectsIndex', 'projectsState', 'touchActiveProject', 'initProjects',
    'deepMerge', 'migrateConfig', 'validateConfigShape', 'readConfig', 'writeConfig', 'sanitizeFilename', 'copyAssetToProject',
    'cleanupFiles', 'commitConfigFiles', 'relToAbs', 'deleteAssetIfInside', 'resolveProjectFile', 'copyDirRecursive',
    'copyProjectAssets', 'storedIconPaths', 'assertBuilder'];
  const channels = ['projects:create', 'projects:open', 'projects:rename', 'projects:delete', 'projects:duplicate',
    'brand:save', 'marketing:saveBanners', 'export:saveIcon', 'shell:launchFile', 'dialog:saveFileAs'];
  vm.runInContext([
    source.slice(source.indexOf('const DEFAULT_CONFIG ='), source.indexOf('let builderWindow =')),
    "const ICON_ALLOWED_EXTS=['.ico','.png','.jpg','.jpeg']; const ICON_SOURCE_NAMES=ICON_ALLOWED_EXTS.map(ext=>'icon-source'+ext);",
    ...names.map(productionFunction), ...channels.map(productionHandler)
  ].join('\n'), ctx);
  const initial = vm.runInContext('structuredClone(DEFAULT_CONFIG)', ctx);
  initial.content = [{ id: 'kept', type: 'html', data: { html: '<h1>Preserve me</h1>' } }];
  initial.brand.logo = 'dist-assets/old-logo.png';
  initial.marketing.banners.top.image = 'dist-assets/old-top.png';
  initial.marketing.banners.bottom.image = 'dist-assets/old-bottom.png';
  initial.export.iconPath = 'data/icon-source.png';
  for (const name of ['old-logo.png', 'old-top.png', 'old-bottom.png']) fs.writeFileSync(path.join(assets, name), 'ORIGINAL ' + name);
  fs.writeFileSync(path.join(data, 'icon-source.png'), 'ORIGINAL ICON');
  fs.writeFileSync(config, JSON.stringify(initial));
  fs.writeFileSync(index, JSON.stringify({ activeId: 'p-original', projects: [{ id: 'p-original', name: 'Original', updatedAt: 1 }] }));
  const image = path.join(root, 'new-image.png');
  fs.writeFileSync(image, 'NEW IMAGE');
  return { root, projects, project, assets, data, config, index, image, ctx, failure, events, launched, saved,
    run: (channel, payload) => handlers.get(channel)({}, payload) };
}

test('corrupt or wrongly typed configuration blocks saving and preserves every original byte', t => {
  const f = fixture(t);
  for (const invalid of ['{"content":[', 'null', '[]', '{"content":{}}', '{"brand":{"colors":7}}', '{"brand":{"logo":{}}}', '{"content":[null]}']) {
    fs.writeFileSync(f.config, invalid);
    const before = snapshot(f.project);
    assert.throws(() => f.run('brand:save', { title: 'Changed', logoSourcePath: f.image }), /não foi alterado/i);
    assert.deepEqual(snapshot(f.project), before);
  }
  fs.unlinkSync(f.config);
  assert.throws(() => f.run('brand:save', { title: 'Changed' }), /não foi alterado/i);
  assert.equal(fs.existsSync(f.config), false);
});

test('older partial configurations still merge defaults and migrate the single banner', t => {
  const f = fixture(t);
  fs.writeFileSync(f.config, JSON.stringify({ content: [{ type: 'html', data: { html: 'KEEP' } }],
    marketing: { banner: { position: 'top', image: 'dist-assets/old-top.png', enabled: true } } }));
  const saved = f.run('brand:save', { title: 'New', colors: { sidebar: { invalid: true } } });
  assert.equal(saved.content[0].data.html, 'KEEP');
  assert.equal(saved.marketing.banners.top.image, 'dist-assets/old-top.png');
  assert.equal(typeof saved.brand.colors.sidebar, 'string');
  assert.equal(saved.marketing.banner, undefined);
});

test('invalid project indexes block initialization and CRUD without replacing or hiding data', t => {
  const f = fixture(t);
  for (const invalid of ['{"projects":[', '{"activeId":null,"projects":[{"id":"../outside","name":"Bad"}]}']) {
    fs.writeFileSync(f.index, invalid);
    const before = snapshot(f.root);
    assert.throws(() => f.ctx.initProjects(), /ficheiro foi preservado/);
    assert.throws(() => f.run('projects:create', { name: 'New' }), /ficheiro foi preservado/);
    assert.deepEqual(snapshot(f.root), before);
  }
});

test('first startup initializes defaults and legacy migration retains originals across index failures', t => {
  const empty = fixture(t);
  fs.unlinkSync(empty.index);
  fs.rmSync(empty.projects, { recursive: true });
  empty.ctx.initProjects();
  assert.deepEqual(JSON.parse(JSON.stringify(empty.ctx.readConfig().content)), []);
  assert.equal(empty.ctx.projectsState().projects.length, 1);

  const f = fixture(t);
  fs.unlinkSync(f.index);
  fs.rmSync(f.projects, { recursive: true });
  const legacyData = path.join(f.root, 'data');
  const legacyAssets = path.join(f.root, 'dist-assets');
  fs.mkdirSync(legacyData);
  fs.mkdirSync(legacyAssets);
  fs.writeFileSync(path.join(legacyData, 'project-config.json'), JSON.stringify({ brand: { title: 'Legacy' }, content: [] }));
  fs.writeFileSync(path.join(legacyAssets, 'keep.txt'), 'LEGACY ASSET');
  const beforeData = snapshot(legacyData);
  const beforeAssets = snapshot(legacyAssets);
  f.failure.indexRename = true;
  assert.throws(() => f.ctx.initProjects(), /Injected rename failure/);
  assert.deepEqual(fs.readdirSync(f.projects), []);
  assert.deepEqual(snapshot(legacyData), beforeData);
  assert.deepEqual(snapshot(legacyAssets), beforeAssets);
  assert.equal(fs.existsSync(f.index), false);
  f.failure.indexRename = false;
  f.ctx.initProjects();
  assert.equal(f.ctx.readConfig().brand.title, 'Legacy');
  assert.equal(fs.readFileSync(path.join(f.ctx.ASSETS_DIR, 'keep.txt'), 'utf8'), 'LEGACY ASSET');
  assert.deepEqual(snapshot(legacyData), beforeData);
  assert.deepEqual(snapshot(legacyAssets), beforeAssets);
});

test('logo, both banners and icons retain old files and roll back replacements when config commit fails', t => {
  for (const fault of ['configWrite', 'configRename']) {
    for (const remove of [false, true]) {
      for (const channel of ['brand:save', 'marketing:saveBanners', 'export:saveIcon']) {
        const f = fixture(t);
        const before = snapshot(f.project);
        f.failure[fault] = true;
        const payload = channel === 'brand:save' ? (remove ? { removeLogo: true } : { logoSourcePath: f.image })
          : channel === 'export:saveIcon' ? (remove ? { removeIcon: true } : { sourcePath: f.image })
            : { top: remove ? { removeImage: true } : { imageSourcePath: f.image }, bottom: remove ? { removeImage: true } : { imageSourcePath: f.image } };
        assert.throws(() => f.run(channel, payload), /Injected/);
        assert.deepEqual(snapshot(f.project), before, channel + ' ' + fault);
      }
    }
  }
});

test('partial image copies and a failed second banner copy do not destroy prior resources', t => {
  for (const channel of ['brand:save', 'marketing:saveBanners', 'export:saveIcon']) {
    const f = fixture(t);
    const before = snapshot(f.project);
    f.failure.copyAt = channel === 'marketing:saveBanners' ? 2 : 1;
    const payload = channel === 'brand:save' ? { logoSourcePath: f.image }
      : channel === 'export:saveIcon' ? { sourcePath: f.image }
        : { top: { imageSourcePath: f.image }, bottom: { imageSourcePath: f.image } };
    assert.throws(() => f.run(channel, payload), /Injected copy failure/);
    assert.deepEqual(snapshot(f.project), before);
  }
});

test('successful resource saves retire old files only after commit and allow selecting the existing source', t => {
  const f = fixture(t);
  const oldLogo = path.join(f.assets, 'old-logo.png');
  const saved = f.run('brand:save', { logoSourcePath: oldLogo });
  const commit = f.events.find(event => event.kind === 'rename' && event.to === f.config);
  assert.ok(commit.oldAssets.includes('old-logo.png'));
  assert.equal(fs.existsSync(oldLogo), false);
  assert.equal(fs.readFileSync(f.ctx.relToAbs(saved.brand.logo), 'utf8'), 'ORIGINAL old-logo.png');
  const oldIcon = path.join(f.data, 'icon-source.png');
  const icon = f.run('export:saveIcon', { sourcePath: oldIcon });
  assert.equal(fs.existsSync(oldIcon), false);
  assert.equal(fs.readFileSync(f.ctx.relToAbs(icon.export.iconPath), 'utf8'), 'ORIGINAL ICON');
});

test('index write failures leave create, duplicate, rename and delete atomic with no active-project switch', t => {
  for (const fault of ['indexWrite', 'indexRename']) {
    for (const channel of ['projects:create', 'projects:duplicate', 'projects:rename', 'projects:delete']) {
      const f = fixture(t);
      const before = snapshot(f.root);
      f.failure[fault] = true;
      assert.throws(() => f.run(channel, { id: 'p-original', name: 'Changed' }), /Injected/);
      assert.deepEqual(snapshot(f.root), before, channel + ' ' + fault);
      assert.equal(f.ctx.CONFIG_PATH, f.config);
      assert.deepEqual(fs.readdirSync(f.projects), ['p-original']);
    }
  }
});

test('project deletion retires its folder after index commit and initializes the replacement project', t => {
  const f = fixture(t);
  const result = f.run('projects:delete', { id: 'p-original' });
  const removal = f.events.find(event => event.kind === 'remove' && event.filename === f.project);
  assert.ok(removal);
  assert.ok(!JSON.parse(removal.index).projects.some(project => project.id === 'p-original'));
  assert.equal(fs.existsSync(f.project), false);
  assert.notEqual(result.state.activeId, 'p-original');
  assert.deepEqual(JSON.parse(JSON.stringify(result.config.content)), []);
});

test('opening a corrupt project leaves the previous active project and index intact', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.projects, 'p-bad', 'data'), { recursive: true });
  fs.writeFileSync(path.join(f.projects, 'p-bad', 'data', 'project-config.json'), '{invalid');
  const idx = JSON.parse(fs.readFileSync(f.index));
  idx.projects.push({ id: 'p-bad', name: 'Bad' });
  fs.writeFileSync(f.index, JSON.stringify(idx));
  const previous = fs.readFileSync(f.index, 'utf8');
  assert.throws(() => f.run('projects:open', { id: 'p-bad' }), /não foi alterado/i);
  assert.equal(fs.readFileSync(f.index, 'utf8'), previous);
  assert.equal(f.ctx.CONFIG_PATH, f.config);
});

test('launch and download reject symlinks outside assets and non-files before calling OS APIs', async t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'private.txt');
  fs.writeFileSync(outside, 'PRIVATE');
  try { fs.symlinkSync(outside, path.join(f.assets, 'escape.txt'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Symlink creation unavailable on this host.'); throw error; }
  fs.mkdirSync(path.join(f.assets, 'directory'));
  for (const file of ['dist-assets/escape.txt', 'dist-assets/directory']) {
    await assert.rejects(f.run('shell:launchFile', file), /não permitido/);
    await assert.rejects(f.run('dialog:saveFileAs', { file }), /não permitido/);
  }
  assert.equal(f.launched.length, 0);
  assert.equal(f.saved.length, 0);
  await f.run('shell:launchFile', 'dist-assets/old-logo.png');
  await f.run('dialog:saveFileAs', { file: 'dist-assets/old-logo.png' });
  assert.equal(fs.readFileSync(path.join(f.root, 'download.bin'), 'utf8'), 'ORIGINAL old-logo.png');
  f.ctx.exportBusy = true;
  await assert.rejects(f.run('shell:launchFile', 'dist-assets/old-logo.png'), /exportação/);
  f.ctx.exportBusy = false;
  f.ctx.dialog.showSaveDialog = async () => {
    fs.unlinkSync(path.join(f.assets, 'old-logo.png'));
    fs.symlinkSync(outside, path.join(f.assets, 'old-logo.png'), 'file');
    return { filePath: path.join(f.root, 'download.bin') };
  };
  await assert.rejects(f.run('dialog:saveFileAs', { file: 'dist-assets/old-logo.png' }), /ficheiro mudou/);
  assert.equal(fs.readFileSync(path.join(f.root, 'download.bin'), 'utf8'), 'ORIGINAL old-logo.png');
});
