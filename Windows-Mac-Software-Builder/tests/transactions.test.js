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
    projectArchive: require('../src/shared/project-archive'),
    projectExport: require('../src/shared/project-export'), app: { getVersion: () => '2.6.0' },
    projectIcons: require('../src/shared/project-icon'),
    nativeImage: { createFromPath: filename => ({ isEmpty: () => fs.readFileSync(filename, 'utf8') === 'INVALID IMAGE' }) },
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
    'copyProjectAssets', 'storedIconPaths', 'assertBuilder', 'sanitizeModule', 'findModuleById', 'moduleAssetFiles'];
  const channels = ['projects:create', 'projects:open', 'projects:rename', 'projects:delete', 'projects:duplicate',
    'projects:exportArchive', 'projects:importArchive', 'content:save', 'brand:save', 'marketing:saveBanners', 'export:saveIcon', 'shell:launchFile', 'dialog:saveFileAs'];
  vm.runInContext([
    source.slice(source.indexOf('const SINGLE_FILE_TYPES ='), source.indexOf('const LOCALES_DIR =')),
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
  assert.equal(saved.marketing.banners.top.dismissible, false);
});

test('independent close permissions and animated GIF bytes survive save and project transfer', async t => {
  const f = fixture(t);
  const gif = path.join(__dirname, 'fixtures/banner-animated.gif');
  const before = fs.readFileSync(gif);
  const saved = f.run('marketing:saveBanners', {
    top: { enabled: true, dismissible: true, imageSourcePath: gif, url: 'https://example.org' },
    bottom: { enabled: true, dismissible: false, imageSourcePath: gif }
  });
  for (const slot of ['top', 'bottom']) {
    const banner = saved.marketing.banners[slot];
    assert.equal(banner.dismissible, slot === 'top');
    assert.match(banner.image, /\.gif$/);
    assert.deepEqual(fs.readFileSync(path.join(f.project, banner.image)), before);
  }
  // Older callers that omit the option must not reset a saved permission.
  const retained = f.run('marketing:saveBanners', { top: { enabled: true }, bottom: { enabled: true } });
  assert.equal(retained.marketing.banners.top.dismissible, true);
  assert.equal(retained.marketing.banners.bottom.dismissible, false);
  const archive = path.join(f.root, 'banners.wsmb'), destination = path.join(f.root, 'restored');
  const archiveAPI = require('../src/shared/project-archive');
  const readConfig = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  await archiveAPI.exportArchive({ projectRoot: f.project, outputPath: archive, name: 'Banners', appVersion: '2.6.2', readConfig });
  const restored = await archiveAPI.importArchive({ archivePath: archive, destination, readConfig });
  assert.deepEqual(restored.config.marketing.banners, JSON.parse(JSON.stringify(retained.marketing.banners)));
  for (const banner of Object.values(restored.config.marketing.banners)) {
    assert.deepEqual(fs.readFileSync(path.join(destination, banner.image)), before);
  }
  const off = f.run('marketing:saveBanners', { top: { enabled: true, dismissible: false } });
  assert.equal(off.marketing.banners.top.dismissible, false);
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

test('invalid and oversized icons preserve the selected icon, configuration and project index', t => {
  const f = fixture(t), before = snapshot(f.project), index = fs.readFileSync(f.index);
  fs.writeFileSync(f.image, 'INVALID IMAGE');
  assert.throws(() => f.run('export:saveIcon', { sourcePath: f.image }), /ícone inválid/i);
  assert.deepEqual(snapshot(f.project), before);
  fs.writeFileSync(f.image, Buffer.alloc(16 * 1024 ** 2 + 1));
  assert.throws(() => f.run('export:saveIcon', { sourcePath: f.image }), /ícone inválid/i);
  assert.deepEqual(snapshot(f.project), before);
  assert.deepEqual(fs.readFileSync(f.index), index);
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


test('editable export/import IPC commits a separate project and preserves the original', async t => {
  const f = fixture(t), original = snapshot(f.project);
  const output = path.join(f.root, 'transfer.wsmb');
  f.ctx.dialog.showSaveDialog = async () => ({ filePath: output });
  const exported = await f.run('projects:exportArchive', { id: 'p-original' });
  assert.equal(exported.path, output); assert.equal(f.ctx.exportBusy, false);
  f.ctx.dialog.showOpenDialog = async () => ({ filePaths: [output] });
  const restored = await f.run('projects:importArchive');
  assert.equal(restored.state.projects.length, 2);
  assert.notEqual(restored.state.activeId, 'p-original');
  assert.equal(restored.config.brand.logo, 'dist-assets/old-logo.png');
  assert.deepEqual(snapshot(f.project), original);
  assert.equal(f.ctx.exportBusy, false);
});

test('failed archive index commit and canceled dialogs leave project selection and files intact', async t => {
  const f = fixture(t), output = path.join(f.root, 'transfer.wsmb');
  f.ctx.dialog.showSaveDialog = async () => ({ filePath: output });
  await f.run('projects:exportArchive', { id: 'p-original' });
  const original = snapshot(f.projects), index = fs.readFileSync(f.index, 'utf8');
  f.ctx.dialog.showOpenDialog = async () => ({ filePaths: [output] });
  f.failure.indexRename = true;
  await assert.rejects(f.run('projects:importArchive'), /Injected/);
  assert.deepEqual(snapshot(f.projects), original);
  assert.equal(fs.readFileSync(f.index, 'utf8'), index);
  assert.equal(f.ctx.ASSETS_DIR, f.assets);
  assert.equal(f.ctx.exportBusy, false);
  f.ctx.dialog.showOpenDialog = async () => ({ canceled: true });
  assert.equal((await f.run('projects:importArchive')).cancelled, true);
  assert.equal(f.ctx.exportBusy, false);
});

test('an open archive dialog locks mutations and prevents overlapping archive operations', async t => {
  const f = fixture(t); let closeDialog;
  f.ctx.dialog.showOpenDialog = () => new Promise(resolve => { closeDialog = resolve; });
  const operation = f.run('projects:importArchive');
  assert.equal(f.ctx.exportBusy, true);
  assert.throws(() => f.run('brand:save', { title: 'Blocked' }), /Aguarde/);
  await assert.rejects(f.run('projects:exportArchive', {id:'p-original'}), /Aguarde/);
  closeDialog({canceled:true}); await operation;
  assert.equal(f.ctx.exportBusy, false);
});

test('failed single-file and gallery saves remove only new assets and retain the previous configuration', t => {
  for (const type of ['local-video', 'image-gallery']) {
    const f = fixture(t), original = snapshot(f.project);
    const data = type === 'image-gallery' ? {items:[{sourcePath:f.image}]} : {sourcePath:f.image};
    f.failure.configRename = true;
    assert.throws(() => f.run('content:save', { modules:[{id:'new',type,data}] }), /Injected/);
    assert.deepEqual(snapshot(f.project), original);
  }
});

test('missing gallery sources and duplicate module IDs reject the whole save', t => {
  const f = fixture(t), original = snapshot(f.project);
  assert.throws(() => f.run('content:save', { modules:[{id:'gallery',type:'image-gallery',data:{items:[{sourcePath:f.image},{sourcePath:path.join(f.root,'absent.png')}]}}] }), /Imagem não encontrada/);
  assert.deepEqual(snapshot(f.project), original);
  assert.throws(() => f.run('content:save', { modules:[{id:'same',type:'html'},{id:'same',type:'html'}] }), /repetido/);
  assert.deepEqual(snapshot(f.project), original);
});


test('protected archive module survives save, editable transfer, download and failed replacement byte-for-byte', async t => {
  const f = fixture(t);
  // A real ZipCrypto-encrypted ZIP, generated with a test-only password.
  // Production only copies the bytes; it never requests or uses that password.
  const original = Buffer.from('UEsDBAoACQAAACwSVF3znKRmJAAAABgAAAAKABwAcmVhZG1lLnR4dFVUCQADA6XWagOl1mp1eAsAAQQAAAAABAAAAACWurCOwKQ3tkzfU8cAxHGblFHehLud84pZwrl86SehC6TwuPlQSwcI85ykZiQAAAAYAAAAUEsBAh4DCgAJAAAALBJUXfOcpGYkAAAAGAAAAAoAGAAAAAAAAQAAAKSBAAAAAHJlYWRtZS50eHRVVAUAAwOl1mp1eAsAAQQAAAAABAAAAABQSwUGAAAAAAEAAQBQAAAAeAAAAAAA', 'base64');
  assert.equal(original.readUInt16LE(6) & 1, 1, 'Fixture must be encrypted');
  const sourcePath = path.join(f.root, 'protegido.zip');
  fs.writeFileSync(sourcePath, original);
  let updated = await f.run('content:save', { modules: [{id:'protected',type:'archive-download',title:'Arquivo',data:{sourcePath,buttonLabel:'Obter arquivo'}}] });
  const mod = updated.content[0];
  assert.equal(mod.type, 'archive-download');
  assert.equal(mod.data.fileName, 'protegido.zip');
  assert.equal(mod.data.buttonLabel, 'Obter arquivo');
  assert.deepEqual(fs.readFileSync(path.join(f.project, mod.data.file)), original);
  updated = await f.run('content:save', {modules:updated.content});
  assert.deepEqual(updated.content[0].data, mod.data, 'Reordering/re-saving must preserve the source');
  const archivePath = path.join(f.root, 'editable.wsmb');
  const readConfig = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
  const engine = require('../src/shared/project-archive');
  await engine.exportArchive({projectRoot:f.project,outputPath:archivePath,name:'Archive test',appVersion:'2.6.1',readConfig});
  const destination = path.join(f.root, 'restored');
  const restored = await engine.importArchive({archivePath,destination,readConfig});
  assert.equal(restored.config.content[0].type, 'archive-download');
  assert.deepEqual(fs.readFileSync(path.join(destination, restored.config.content[0].data.file)), original);
  const downloaded = await f.run('dialog:saveFileAs', mod.data);
  assert.equal(downloaded.ok, true);
  assert.deepEqual(fs.readFileSync(downloaded.path), original);
  const before = snapshot(f.project);
  f.failure.configWrite = true;
  fs.writeFileSync(sourcePath, 'replacement bytes');
  assert.throws(() => f.run('content:save', {modules:[{...mod,data:{sourcePath}}]}), /Injected disk full/);
  assert.deepEqual(snapshot(f.project), before, 'A failed replacement must preserve the original encrypted file');
});

test('an archive download cannot be saved without choosing its file', t => {
  const f = fixture(t), before = snapshot(f.project);
  assert.throws(() => f.run('content:save', {modules:[{id:'empty',type:'archive-download',data:{}}]}), /Selecione um arquivo/);
  assert.deepEqual(snapshot(f.project), before);
});
