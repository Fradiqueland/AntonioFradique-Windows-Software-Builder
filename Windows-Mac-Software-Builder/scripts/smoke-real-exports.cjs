'use strict';

// Run with `electron`, never ELECTRON_RUN_AS_NODE. Electron's ASAR-aware fs is
// the regression boundary: ordinary node:test cannot exercise that runtime.
const { app, BrowserWindow } = require('electron');
const electronFs = require('fs');
const fs = require('original-fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const yauzl = require('yauzl');
const execFileP = promisify(execFile);
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const packaged = process.argv.includes('--packaged');
const label = packaged ? 'packaged' : 'source';
const reportPath = path.join(root, 'build-electron-smoke-' + label + '.json');
const report = { status: 'running', mode: label, platform: process.platform, electron: process.versions.electron, appVersion: pkg.version, checks: [] };
let temporary;
let window;

app.disableHardwareAcceleration();
const deadline = setTimeout(() => finish(new Error('Real Electron smoke exceeded 15 minutes.')), 15 * 60 * 1000);

function finish(error) {
  clearTimeout(deadline);
  report.status = error ? 'failed' : 'passed';
  if (error) report.error = error.stack || String(error);
  try { if (window && !window.isDestroyed()) window.destroy(); } catch (_) {}
  try { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); } catch (_) {}
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  if (error) console.error(error.stack || error);
  else console.log('REAL ELECTRON EXPORT SMOKE PASSED (' + label + '): ' + report.checks.join(', '));
  app.exit(error ? 1 : 0);
}

async function fileHash(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function zipIndex(file, selected = []) {
  const wanted = new Set(selected);
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, strictFileNames: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = new Map();
      zip.on('error', reject);
      zip.on('end', () => resolve(entries));
      zip.on('entry', (entry) => {
        const value = { mode: entry.externalFileAttributes >>> 16, crc: entry.crc32, size: entry.uncompressedSize };
        entries.set(entry.fileName, value);
        if (!wanted.has(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, async (streamError, stream) => {
          if (streamError) { zip.close(); return reject(streamError); }
          try {
            const hash = crypto.createHash('sha256');
            for await (const chunk of stream) hash.update(chunk);
            value.sha256 = hash.digest('hex');
            zip.readEntry();
          } catch (readError) { zip.close(); reject(readError); }
        });
      });
      zip.readEntry();
    });
  });
}

function verifyAsar(filename) {
  // Reading a member through Electron's virtual filesystem proves that the
  // archive written by export is a real ASAR, not a stub or opaque test text.
  assert.ok(fs.statSync(filename).size > 1024, 'ASAR must contain the real viewer');
  const contents = JSON.parse(electronFs.readFileSync(path.join(filename, 'package.json'), 'utf8'));
  assert.equal(contents.version, pkg.version);
  assert.ok(electronFs.readFileSync(path.join(filename, 'main.js'), 'utf8').includes('createViewerWindow'));
}

function functionBlock(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'Production smoke seam no longer matches main.js: ' + start);
  return source.slice(first, last);
}

async function verifyRealWindowsSfx({ applicationRoot, resources, engine, config, assetsDir, templates, expectedAsar }) {
  const outputPath = path.join(temporary, 'Smoke Export.exe');
  const sfxDir = packaged ? path.join(resources, 'sfx') : path.join(root, 'src/builder/bin');
  const source = electronFs.readFileSync(path.join(applicationRoot, 'main.js'), 'utf8');
  const appRequire = createRequire(path.join(applicationRoot, 'package.json'));
  const context = vm.createContext({
    fs: electronFs, path, os, crypto, process, console, Buffer, Date,
    projectExport: engine,
    iptvCipher: appRequire('./src/shared/iptv-cipher'),
    localWeb: appRequire('./src/shared/local-web'),
    portableApps: appRequire('./src/shared/portable-app'),
    ASSETS_DIR: assetsDir, builderWindow: window, exportBusy: false,
    assertBuilder() {}, hasProject: () => true, readConfig: () => config,
    getSfxBinDir: () => sfxDir,
    getExportTemplatePath: () => path.join(templates, 'windows-x64.zip'),
    getViewerTemplateDir: () => path.join(temporary, 'unused-legacy-template'),
    sanitizeFilename: () => 'Smoke Export',
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: outputPath }) },
    execFileP
  });
  const helpers = functionBlock(source, 'function copyDirRecursive(', '/* -------- Windows -------- */');
  const build = functionBlock(source, 'async function buildWindowsExe(', "handleTrustedIpc('export:targets'");
  vm.runInContext(helpers + '\n' + build + '\nthis.realBuildWindowsExe = buildWindowsExe;', context, { filename: 'production-main-export-smoke.js' });
  const result = await context.realBuildWindowsExe({ sender: { send(_channel, item) { console.log('[SFX] ' + item.msg); } } }, { defaultName: 'Smoke Export' });
  assert.equal(result.ok, true);
  assert.equal(result.path, outputPath);
  const sevenZip = path.join(sfxDir, '7za.exe');
  await execFileP(sevenZip, ['t', outputPath, '-bsp0', '-bso0'], { windowsHide: true });
  const expanded = path.join(temporary, 'sfx-expanded');
  await execFileP(sevenZip, ['x', outputPath, '-o' + expanded, '-y', '-bsp0', '-bso0'], { windowsHide: true });
  const asarFile = path.join(expanded, 'resources/app.asar');
  verifyAsar(asarFile);
  assert.equal(await fileHash(asarFile), expectedAsar);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(expanded, 'resources/data/project-config.json'), 'utf8')), config);
  report.checks.push('production buildWindowsExe + real 7-Zip SFX extraction + valid ASAR');
}

async function verifyRealPortableLaunch(applicationRoot, assetsDir) {
  const appRequire = createRequire(path.join(applicationRoot, 'package.json'));
  const portable = appRequire('./src/shared/portable-app');
  const runtime = appRequire('./src/shared/portable-runtime');
  const mac = process.platform === 'darwin';
  const source = path.join(temporary, 'portable-source');
  fs.mkdirSync(path.join(source, 'resources'), { recursive: true });
  const entry = mac ? 'portable-check' : 'portable-check.exe';
  const systemProgram = mac ? '/usr/bin/true' : path.join(process.env.SystemRoot, 'System32', 'whoami.exe');
  fs.copyFileSync(systemProgram, path.join(source, entry));
  if (mac) fs.chmodSync(path.join(source, entry), 0o755);
  // A genuine ASAR payload exercises physical copying in Electron. It must not
  // be interpreted as a virtual directory by the portable importer or runtime.
  const asarSource = path.join(temporary, 'windows-template/resources/app.asar');
  fs.copyFileSync(asarSource, path.join(source, 'resources/app.asar'));
  const asarHash = await fileHash(asarSource);
  const scan = portable.scanPortableFolder(source);
  assert.ok(scan.candidates.some(item => item.path === entry && item.platform === (mac ? 'mac' : 'windows')));
  const data = portable.importPortableProject({ sourcePath: source, assetsDir,
    entries: { windows: mac ? null : entry, mac: mac ? entry : null }, allowWine: false });
  assert.equal(data.sourcePath, undefined);
  fs.rmSync(source, { recursive: true, force: true });
  const storageDir = path.join(temporary, 'persistent-portable');
  let launched;
  let completed;
  const spawnImpl = (executable, args, options) => {
    launched = { executable, args, options };
    const child = spawn(executable, args, options);
    completed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error('Native portable process failed: ' + code + '/' + signal)));
    });
    completed.catch(() => {});
    return child;
  };
  const result = await runtime.launchPortableProject({ data, assetsDir, storageDir, spawnImpl });
  await completed;
  assert.equal(result.ok, true);
  assert.equal(result.via, 'native');
  assert.equal(launched.options.shell, false);
  const workingDirectory = launched.options.cwd;
  assert.ok(workingDirectory.startsWith(storageDir + path.sep));
  assert.equal(await fileHash(path.join(workingDirectory, 'resources/app.asar')), asarHash);
  const settingsPath = path.join(workingDirectory, 'user-settings.txt');
  fs.writeFileSync(settingsPath, 'keep between launches');
  // Exported resources may be in a different SFX temporary folder on each run.
  // The existing local revision is usable after its original payload is gone.
  portable.removePortableProject({ data, assetsDir });
  await runtime.launchPortableProject({ data, assetsDir, storageDir, spawnImpl });
  await completed;
  assert.equal(launched.options.cwd, workingDirectory);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), 'keep between launches');
  report.checks.push('portable import + real native process + physical ASAR + persistent working copy');
}

async function main() {
  assert.ok(process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE, 'This gate must run in the actual Electron main process');
  assert.ok(['win32', 'darwin'].includes(process.platform), 'Run this smoke on a native Windows or Mac runner');
  const mac = process.platform === 'darwin';
  const resources = packaged
    ? path.join(root, mac ? 'dist/builder/mac-universal/' + pkg.build.productName + '.app/Contents/Resources' : 'dist/builder/win-unpacked/resources')
    : null;
  const applicationRoot = packaged ? path.join(resources, mac ? 'app.asar' : 'app') : root;
  const templates = packaged ? path.join(resources, 'export-templates') : path.join(root, 'dist/export-templates');
  const appRequire = createRequire(path.join(applicationRoot, 'package.json'));
  const engine = appRequire('./src/shared/project-export');
  report.enginePath = appRequire.resolve('./src/shared/project-export');
  report.dependencies = Object.fromEntries(['yauzl', 'yazl'].map(name => [name, appRequire(name + '/package.json').version]));
  const lock = require('../package-lock.json');
  for (const [name, version] of Object.entries(report.dependencies)) assert.equal(version, lock.packages['node_modules/' + name].version);
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-real-electron-'));
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await window.loadURL('data:text/html,<title>Export regression smoke</title>');
  const assetsDir = path.join(temporary, 'assets');
  const webFolder = 'web-12345678-1234-4234-8234-123456789abc';
  fs.mkdirSync(path.join(assetsDir, webFolder, 'styles'), { recursive: true });
  fs.writeFileSync(path.join(assetsDir, webFolder, 'index.html'), '<!doctype html><link rel="stylesheet" href="styles/app.css"><h1>Olá, Windows e Mac</h1>');
  fs.writeFileSync(path.join(assetsDir, webFolder, 'styles/app.css'), 'h1 { color: #126; }');
  const projectName = 'Smoke António';
  const config = { language: 'pt', brand: { title: projectName }, content: [{ id: 'web-smoke', type: 'local-web', title: 'HTML local', data: { root: 'dist-assets/' + webFolder, entry: 'index.html' } }], export: { iconPath: null } };
  let expectedWindowsAsar;
  for (const target of ['windows', 'mac']) {
    const templatePath = path.join(templates, target === 'windows' ? 'windows-x64.zip' : 'mac-universal.zip');
    const asarEntry = target === 'windows' ? 'resources/app.asar' : 'LaunchBox Viewer.app/Contents/Resources/app.asar';
    const baseline = await zipIndex(templatePath, [asarEntry]);
    assert.ok([...baseline.keys()].some(name => name.endsWith('/')), 'Real templates must contain explicit directories');
    const outputPath = path.join(temporary, target + '.zip');
    const result = await engine.exportProject({ target, templatePath, outputPath, projectName, config, assetsDir });
    assert.equal(result.target, target);
    const outputAsar = target === 'windows' ? asarEntry : projectName + '.app/Contents/Resources/app.asar';
    const base = target === 'windows' ? 'resources' : projectName + '.data';
    const exported = await zipIndex(outputPath, [outputAsar, base + '/data/project-config.json', base + '/dist-assets/' + webFolder + '/index.html']);
    for (const [name, metadata] of baseline) {
      const destination = target === 'windows' ? name : projectName + '.app' + name.slice('LaunchBox Viewer.app'.length);
      assert.deepEqual(exported.get(destination), metadata, 'Template entry changed: ' + destination);
    }
    assert.equal(exported.get(base + '/data/project-config.json').sha256, crypto.createHash('sha256').update(JSON.stringify(config, null, 2)).digest('hex'));
    assert.equal(exported.get(base + '/dist-assets/' + webFolder + '/index.html').sha256, await fileHash(path.join(assetsDir, webFolder, 'index.html')));
    report.checks.push(target + ' ZIP: real template, explicit directories, unchanged ASAR, project HTML');
    if (target === 'windows') {
      expectedWindowsAsar = baseline.get(asarEntry).sha256;
      const extracted = path.join(temporary, 'windows-template');
      await engine.extractWindowsTemplate(templatePath, extracted);
      const asarFile = path.join(extracted, 'resources/app.asar');
      verifyAsar(asarFile);
      assert.equal(await fileHash(asarFile), expectedWindowsAsar);
      report.checks.push('Windows extraction through real Electron + valid ASAR members');
    } else if (mac) {
      const expanded = path.join(temporary, 'mac-expanded');
      await execFileP('/usr/bin/ditto', ['-x', '-k', outputPath, expanded]);
      const bundle = path.join(expanded, projectName + '.app');
      await execFileP('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]);
      await execFileP('/usr/bin/lipo', [path.join(bundle, 'Contents/MacOS/LaunchBox Viewer'), '-verify_arch', 'x86_64', 'arm64']);
      verifyAsar(path.join(bundle, 'Contents/Resources/app.asar'));
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(expanded, projectName + '.data/data/project-config.json'), 'utf8')), config);
      report.checks.push('Mac exported ZIP expanded by ditto + intact signature + universal executable');
    }
  }
  if (!mac) await verifyRealWindowsSfx({ applicationRoot, resources, engine, config, assetsDir, templates, expectedAsar: expectedWindowsAsar });
  await verifyRealPortableLaunch(applicationRoot, assetsDir);
  if (!packaged) {
    report.links = await require('../tests/electron-links.cjs').runElectronLinkTests({ app, BrowserWindow });
    report.checks.push('real Electron webview link navigation');
  }
}

app.whenReady().then(main).then(() => finish()).catch(finish);
