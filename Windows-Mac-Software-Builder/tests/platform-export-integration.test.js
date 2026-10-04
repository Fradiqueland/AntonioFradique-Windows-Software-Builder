const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }

function targets(platform, present) {
  const root = path.resolve('/builder-resources');
  const ctx = { path, fs: { existsSync: (value) => present.some((suffix) => value.endsWith(suffix)) },
    app: { isPackaged: true }, process: { platform, resourcesPath: root }, PROJECT_ROOT: root,
    getSfxBinDir: () => path.join(root, 'sfx') };
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

function routeHarness({ target = 'mac', format = 'zip', cancelled = false, failure = false } = {}) {
  const calls = [];
  const ctx = {
    path, exportBusy: false, ASSETS_DIR: '/project/dist-assets', builderWindow: {},
    assertBuilder() { if (ctx.exportBusy) throw new Error('busy'); }, hasProject: () => true,
    exportTargets: () => ({ targets: [{ id: target, available: true, format }] }),
    buildWindowsExe: async () => { calls.push('sfx'); return { ok: true, format: 'exe' }; },
    readConfig: () => ({ brand: { title: 'Example' }, content: [] }),
    iptvCipher: { sanitizeConfigForCourse: (config) => config },
    localWeb: { validateWebProject() {} },
    getExportTemplatePath: (value) => '/templates/' + value + '.zip',
    dialog: { showSaveDialog: async () => ({ canceled: cancelled, filePath: '/output/project' }) },
    projectExport: { safeProjectName: (name) => name, exportProject: async (options) => {
      calls.push(options); if (failure) throw new Error('template damaged');
      return { path: options.outputPath, format: 'zip', target: options.target };
    } }
  };
  vm.createContext(ctx);
  vm.runInContext(section('async function exportProject(event, payload', "handleTrustedIpc('export:project'"), ctx);
  return { ctx, calls, run: (payload = { target }) => ctx.exportProject({ sender: { send() {} } }, payload) };
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
