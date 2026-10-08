const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const androidRuntime = require('../src/shared/android-runtime');
const iptvCipher = require('../src/shared/iptv-cipher');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }

function targets(platform, present, { modules = [], hasSymlinks = false, validations = [] } = {}) {
  const root = path.resolve('/builder-resources');
  const ctx = { path, fs: { existsSync: (value) => present.some((suffix) => value.endsWith(suffix)) },
    app: { isPackaged: true }, process: { platform, resourcesPath: root }, PROJECT_ROOT: root,
    getSfxBinDir: () => path.join(root, 'sfx'), ASSETS_DIR: '/project/dist-assets',
    readConfig: () => ({ content: modules }),
    portableApps: { validatePortableProject(options) {
      validations.push(options); return { hasSymlinks };
    } } };
  vm.createContext(ctx);
  vm.runInContext(section('function getViewerTemplateDir()', 'const DEFAULT_CONFIG'), ctx);
  return JSON.parse(JSON.stringify(ctx.exportTargets()));
}

test('Windows builder offers native EXE and Mac ZIP when both templates are installed', () => {
  const result = targets('win32', ['windows-x64.zip', 'mac-universal.zip', '7za.exe', '7zsd_All_x64.sfx']);
  assert.equal(result.hostPlatform, 'win32');
  assert.deepEqual(result.targets.map((item) => [item.id, item.available, item.format]),
    [['windows', true, 'exe'], ['mac', true, 'zip']]);
});

test('Mac builder offers Windows and Mac portable ZIP exports', () => {
  const result = targets('darwin', ['windows-x64.zip', 'mac-universal.zip']);
  assert.deepEqual(result.targets.map((item) => [item.id, item.available, item.format]),
    [['windows', true, 'zip'], ['mac', true, 'zip']]);
});

test('Windows builder offers ZIP for portable symlinks even with SFX installed', () => {
  const data = { root: 'dist-assets/portable-fixture' };
  const validations = [];
  const result = targets('win32', ['windows-x64.zip', 'mac-universal.zip', '7za.exe', '7zsd_All_x64.sfx'], {
    modules: [{ type: 'portable', data }], hasSymlinks: true, validations
  });
  assert.deepEqual(result.targets.map(item => [item.id, item.available, item.format]),
    [['windows', true, 'zip'], ['mac', true, 'zip']]);
  assert.equal(validations.length, 1);
  assert.equal(validations[0].data, data);
  assert.equal(validations[0].assetsDir, '/project/dist-assets');
});

test('missing Mac template does not disable Windows export; missing SFX falls back to ZIP', () => {
  const result = targets('win32', ['windows-x64.zip']);
  assert.equal(result.targets[0].available, true);
  assert.equal(result.targets[0].format, 'zip');
  assert.equal(result.targets[1].available, false);
  assert.match(result.targets[1].reason, /Mac/);
});

test('Mac project data lives beside the bundle, never inside signed Resources', () => {
  const ctx = { path }; vm.createContext(ctx);
  vm.runInContext(section('function macProjectDirectory(', 'let WRITE_BASE'), ctx);
  const resources = path.resolve('/Applications/My Product.app/Contents/Resources');
  assert.equal(ctx.macProjectDirectory(resources), path.resolve('/Applications/My Product.data'));
});

function routeHarness({ target = 'mac', format = 'zip', cancelled = false, failure = false,
  modules = [], portableError = null, portableWarnings = [] } = {}) {
  const calls = [];
  const validations = [];
  const dialogs = [];
  const logs = [];
  const ctx = {
    path, exportBusy: false, ASSETS_DIR: '/project/dist-assets', builderWindow: {},
    assertBuilder() { if (ctx.exportBusy) throw new Error('busy'); }, hasProject: () => true,
    exportTargets: () => ({ targets: [{ id: target, available: true, format }] }),
    buildWindowsExe: async () => { calls.push('sfx'); return { ok: true, format: 'exe' }; },
    readConfig: () => ({ brand: { title: 'Example' }, content: modules }),
    iptvCipher: { sanitizeConfigForCourse: (config) => config },
    androidRuntime,
    localWeb: { validateWebProject() {} },
    portableApps: { assertPortableTarget(options) {
      validations.push(options);
      if (portableError) throw new Error(portableError);
      return { warnings: portableWarnings };
    } },
    getExportTemplatePath: (value) => '/templates/' + value + '.zip',
    runtimeDirectory: (runtime) => '/runtime/' + runtime,
    dialog: { showSaveDialog: async (_window, options) => {
      dialogs.push(options); return { canceled: cancelled, filePath: '/output/project' };
    } },
    projectExport: { safeProjectName: (name) => name, exportProject: async (options) => {
      calls.push(options); if (failure) throw new Error('template damaged');
      return { path: options.outputPath, format: 'zip', target: options.target };
    } }
  };
  vm.createContext(ctx);
  vm.runInContext(section('async function exportProject(event, payload', "handleTrustedIpc('export:project'"), ctx);
  return { ctx, calls, validations, dialogs, logs,
    run: (payload = { target }) => ctx.exportProject({ sender: { send(_channel, message) { logs.push(message); } } }, payload) };
}

test('Windows EXE route retains SFX export; Mac goes through the portable engine', async () => {
  const windows = routeHarness({ target: 'windows', format: 'exe' });
  assert.equal((await windows.run()).format, 'exe');
  assert.deepEqual(windows.calls, ['sfx']);
  const mac = routeHarness();
  assert.equal((await mac.run()).format, 'zip');
  assert.equal(mac.calls[0].target, 'mac');
  assert.equal(mac.calls[0].outputPath, '/output/project.zip');
  assert.equal(mac.ctx.exportBusy, false);
});

test('portable export cancels cleanly and releases its lock on errors', async () => {
  const cancelled = routeHarness({ cancelled: true });
  assert.equal((await cancelled.run()).cancelled, true);
  assert.equal(cancelled.calls.length, 0);
  assert.equal(cancelled.ctx.exportBusy, false);
  const failed = routeHarness({ failure: true });
  await assert.rejects(failed.run(), /template damaged/);
  assert.equal(failed.ctx.exportBusy, false);
});

test('export rejects unsupported platforms instead of silently producing the wrong package', async () => {
  const harness = routeHarness();
  await assert.rejects(harness.run({ target: 'ios' }), /Windows ou Mac/);
  assert.equal(harness.calls.length, 0);
});

test('APK references are rejected before either ZIP or SFX export opens a save dialog', async () => {
  for (const format of ['zip', 'exe']) {
    const harness = routeHarness({ target: 'windows', format, modules: [{ type: 'apk', data: { ready: true } }] });
    await assert.rejects(harness.run(), { code: 'ANDROID_RUNTIME_NOT_INCLUDED' });
    assert.equal(harness.dialogs.length, 0);
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.ctx.exportBusy, false);
  }
});

test('ZIP route validates every portable target before opening a save dialog or writing output', async () => {
  const modules = [{ id: 'portable-one', type: 'portable', data: { root: 'dist-assets/portable-fixture' } }];
  for (const target of ['windows', 'mac']) {
    const harness = routeHarness({ target, modules, portableError: 'Missing native executable for target' });
    await assert.rejects(harness.run(), /Missing native executable/);
    assert.equal(harness.validations.length, 1);
    assert.equal(harness.validations[0].target, target);
    assert.equal(harness.validations[0].data, modules[0].data);
    assert.equal(harness.validations[0].assetsDir, '/project/dist-assets');
    assert.equal(harness.dialogs.length, 0);
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.ctx.exportBusy, false);
  }
});

test('Mac ZIP route forwards an explicit Wine requirement as a warning', async () => {
  const warning = 'Wine is required; this is not a native Mac application.';
  const modules = [{ id: 'portable-wine', type: 'portable', data: { allowWine: true } }];
  const harness = routeHarness({ modules, portableWarnings: [warning] });
  assert.equal((await harness.run()).ok, true);
  assert.equal(harness.validations.length, 1);
  assert.equal(harness.calls[0].config.content, modules);
  assert.ok(harness.logs.some(item => item.kind === 'warning' && item.msg === warning));
  assert.equal(harness.ctx.exportBusy, false);
});

test('SFX preflight rejects missing Windows entries and symlinks before staging or save dialogs', async () => {
  // Execute the production SFX function until its safety gate. No Electron,
  // Windows compressor, filesystem writes or native executable are invoked.
  for (const hasSymlinks of [false, true]) {
    const validations = [];
    const ctx = {
      path, os: { tmpdir: () => '/unwritten-qa-staging' }, crypto: require('node:crypto'),
      process: { platform: 'win32' }, exportBusy: false, ASSETS_DIR: '/project/dist-assets',
      assertBuilder() {}, hasProject: () => true,
      readConfig: () => ({ content: [{ id: 'portable', type: 'portable', data: {} }] }),
      iptvCipher, androidRuntime,
      fs: { existsSync: () => false },
      portableApps: { assertPortableTarget(options) {
        validations.push(options);
        if (!hasSymlinks) throw new Error('No selected Windows executable');
        return { hasSymlinks: true };
      } },
      getSfxBinDir() { assert.fail('SFX tools must not be used after rejected portable validation'); },
      dialog: { showSaveDialog() { assert.fail('No save dialog may open for invalid SFX content'); } }
    };
    vm.createContext(ctx);
    vm.runInContext(section('async function buildWindowsExe(', "handleTrustedIpc('export:targets'"), ctx);
    await assert.rejects(ctx.buildWindowsExe({ sender: { send() {} } }, {}), hasSymlinks ? /ligações simbólicas.*ZIP/ : /No selected Windows executable/);
    assert.equal(validations.length, 1);
    assert.equal(validations[0].target, 'windows');
    assert.equal(ctx.exportBusy, false);
  }
});

test('Mac can locate a moved data folder without changing the signed app', async () => {
  const chosen = path.resolve('/Documents/Example.data');
  const ctx = { path, isViewer: true, app: { isPackaged: true }, process: { platform: 'darwin' },
    CONFIG_PATH: '/translocated/Example.data/data/project-config.json',
    WRITE_BASE: '', DATA_DIR: '', ASSETS_DIR: '', ICON_DEST_PATH: '',
    fs: { existsSync: () => false, readFileSync: () => JSON.stringify({ content: [] }) },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] }), showErrorBox() {} }
  };
  vm.createContext(ctx);
  vm.runInContext(section('async function locateMacProject()', 'app.whenReady()'), ctx);
  assert.equal(await ctx.locateMacProject(), true);
  assert.equal(ctx.WRITE_BASE, chosen);
  assert.equal(ctx.CONFIG_PATH, path.join(chosen, 'data', 'project-config.json'));
  assert.equal(ctx.ASSETS_DIR, path.join(chosen, 'dist-assets'));
});

test('Mac optional runtimes follow the relocated data folder and retain sealed-resource fallback', () => {
  const resources = path.resolve('/translocated/Example.app/Contents/Resources');
  const movedData = path.resolve('/Documents/Example.data');
  const ctx = { path, isViewer: true, app: { isPackaged: true },
    process: { platform: 'darwin', resourcesPath: resources },
    WRITE_BASE: path.resolve('/translocated/Example.data'),
    fs: { existsSync: filename => filename === path.join(movedData, 'ffmpeg') || filename === path.join(movedData, 'php') }
  };
  vm.createContext(ctx);
  vm.runInContext(section('function runtimeDirectory(', 'const webRuntime ='), ctx);
  assert.equal(ctx.runtimeDirectory('ffmpeg'), path.join(resources, 'ffmpeg'));
  ctx.WRITE_BASE = movedData;
  assert.equal(ctx.runtimeDirectory('ffmpeg'), path.join(movedData, 'ffmpeg'));
  assert.equal(ctx.runtimeDirectory('php'), path.join(movedData, 'php'));
  ctx.isViewer = false;
  assert.equal(ctx.runtimeDirectory('php'), path.join(resources, 'php'), 'Builder must use its installed runtime');
  ctx.isViewer = true;
  ctx.fs.existsSync = () => false;
  assert.equal(ctx.runtimeDirectory('ffmpeg'), path.join(resources, 'ffmpeg'), 'Older sealed Viewer runtimes remain usable');
});
