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
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const execFileP = promisify(execFile);
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const ffmpegSources = require('../build-configs/ffmpeg-sources.json').sources;
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

function templateRuntime(name, target) {
  const base = target === 'windows' ? 'resources' : 'LaunchBox Viewer.data';
  return ['ffmpeg', 'php'].find(runtime => name === base + '/' + runtime + '/' || name.startsWith(base + '/' + runtime + '/'));
}

function exportEntry(name, target, projectName) {
  if (target === 'windows') return name;
  return name.startsWith('LaunchBox Viewer.data/')
    ? projectName + '.data' + name.slice('LaunchBox Viewer.data'.length)
    : projectName + '.app' + name.slice('LaunchBox Viewer.app'.length);
}

function assertNoOptionalRuntimes(entries, target, projectName) {
  const bases = target === 'windows' ? ['resources'] : [projectName + '.data', projectName + '.app/Contents/Resources'];
  for (const name of entries.keys()) {
    assert.ok(!bases.some(base => /^(?:ffmpeg|php)(?:\/|$)/.test(name.slice(base.length + 1)) && name.startsWith(base + '/')),
      'HTML-only export contains an unnecessary native runtime: ' + name);
  }
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

async function verifyAndroidInformation(applicationRoot) {
  // Execute the shipped information/card handlers against the actual Builder
  // HTML in Chromium. Only unrelated application startup and IPC transport are
  // omitted; the status comes from the shipped production runtime gate.
  const renderer = electronFs.readFileSync(path.join(applicationRoot, 'src/builder/renderer.js'), 'utf8');
  const html = electronFs.readFileSync(path.join(applicationRoot, 'src/builder/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const messages = JSON.parse(electronFs.readFileSync(path.join(applicationRoot, 'locales/pt.json'), 'utf8'));
  const appRequire = createRequire(path.join(applicationRoot, 'package.json'));
  const runtimeStatus = appRequire('./src/shared/android-runtime').getAndroidRuntimeStatus({ audience: 'creator', locale: 'pt' });
  assert.equal(runtimeStatus.available, false);
  const infoWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } });
  try {
    await infoWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const types = functionBlock(renderer, 'const TYPE_KEYS =', 'const contentList =');
    const handlers = functionBlock(renderer, 'const typeCardsEl =', 'function syncTypeUI(');
    await infoWindow.webContents.executeJavaScript(`
      const messages = ${JSON.stringify(messages)};
      const t = key => key.split('.').reduce((value, part) => value && value[part], messages) || key;
      const moduleType = document.getElementById('module-type');
      moduleType.value = 'local-web';
      window.__statusRequests = 0;
      window.icurator = { getAndroidRuntimeStatus: async () => { window.__statusRequests++; return ${JSON.stringify(runtimeStatus)}; } };
      ${types}
      ${handlers}
      renderTypeCards();
    `);
    const snapshot = () => infoWindow.webContents.executeJavaScript(`({
      requests: window.__statusRequests,
      hidden: document.getElementById('android-info-panel').classList.contains('hidden'),
      disabled: document.getElementById('android-import-btn').disabled,
      status: document.getElementById('android-info-status').textContent,
      selectedType: document.getElementById('module-type').value,
      apkOption: !!document.querySelector('#module-type option[value="apk"], [data-type="apk"]')
    })`);
    const before = await snapshot();
    assert.equal(before.requests, 0, 'Opening the Builder must not activate/query Android');
    assert.equal(before.hidden, true);
    await infoWindow.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-android-info]').click();
      await new Promise(resolve => setTimeout(resolve, 0));
    })()`);
    const selected = await snapshot();
    assert.equal(selected.requests, 1);
    assert.equal(selected.hidden, false);
    assert.equal(selected.disabled, true);
    assert.equal(selected.apkOption, false);
    assert.equal(selected.status, messages.android.unavailable);
    assert.equal(selected.selectedType, before.selectedType, 'Information must preserve the existing module draft');
    await infoWindow.webContents.executeJavaScript("document.getElementById('android-import-btn').click(); document.getElementById('android-info-close').click();");
    const closed = await snapshot();
    assert.equal(closed.requests, 1);
    assert.equal(closed.hidden, true);
    assert.equal(closed.disabled, true);
    assert.equal(closed.selectedType, before.selectedType);
    report.android = { statusCode: runtimeStatus.code, availabilityQueries: selected.requests, importDisabled: true, draftPreserved: true };
    report.checks.push('shipped Builder Android information in real Chromium: query only on selection, import blocked, draft preserved');
  } finally { if (!infoWindow.isDestroyed()) infoWindow.destroy(); }
}

async function verifyRealWindowsSfx({ applicationRoot, resources, engine, config, assetsDir, templates, expectedAsar, sharedRuntimeSourcesDir }) {
  const outputPath = path.join(temporary, 'Smoke Export.exe');
  const sfxDir = packaged ? path.join(resources, 'sfx') : path.join(root, 'src/builder/bin');
  const source = electronFs.readFileSync(path.join(applicationRoot, 'main.js'), 'utf8');
  const appRequire = createRequire(path.join(applicationRoot, 'package.json'));
  const context = vm.createContext({
    fs: electronFs, path, os, crypto, process, console, Buffer, Date,
    projectExport: engine,
    sfxAssets: appRequire('./src/shared/sfx-assets'),
    iptvCipher: appRequire('./src/shared/iptv-cipher'),
    androidRuntime: appRequire('./src/shared/android-runtime'),
    localWeb: appRequire('./src/shared/local-web'),
    portableApps: appRequire('./src/shared/portable-app'),
    ASSETS_DIR: assetsDir, builderWindow: window, exportBusy: false,
    assertBuilder() {}, hasProject: () => true, readConfig: () => config,
    getSfxBinDir: () => sfxDir,
    getExportTemplatePath: () => path.join(templates, 'windows-x64.zip'),
    getViewerTemplateDir: () => path.join(temporary, 'unused-legacy-template'),
    runtimeDirectory: () => path.dirname(sharedRuntimeSourcesDir),
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
  const transport = appRequire('./src/shared/sfx-assets');
  assert.ok(fs.existsSync(path.join(expanded,'resources',transport.PACKAGE_FILE)));
  await transport.restoreAssets(path.join(expanded,'resources'));
  const asarFile = path.join(expanded, 'resources/app.asar');
  verifyAsar(asarFile);
  assert.equal(await fileHash(asarFile), expectedAsar);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(expanded, 'resources/data/project-config.json'), 'utf8')), config);
  for (const runtime of ['ffmpeg', 'php']) assert.equal(fs.existsSync(path.join(expanded, 'resources', runtime)), false,
    'HTML-only SFX must omit ' + runtime);
  report.checks.push('production buildWindowsExe + real 7-Zip SFX extraction + valid ASAR + no unused runtimes');
  // Run the actual produced SFX, not just 7za x (which has different long-path
  // support). No product test hook: the normal Viewer must restore and open.
  const temp = path.join(temporary,'native-sfx-temp');fs.mkdirSync(temp);
  const child = spawn(outputPath,[],{env:{...process.env,TEMP:temp,TMP:temp},stdio:'ignore'});
  let exit;const exited=new Promise(resolve=>child.once('exit',(code,signal)=>{exit={code,signal};resolve();}));
  let spawnError;child.once('error',error=>{spawnError=error;});
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  let restored;
  try {
    for(let i=0;i<300&&!restored;i++) {
      if(spawnError)throw spawnError;if(exit)throw new Error('SFX exited before opening the Viewer: '+JSON.stringify(exit));
      for(const name of fs.readdirSync(temp)) {
        const candidate=path.join(temp,name,'resources','dist-assets');
        if(fs.existsSync(path.join(candidate,transport.RECEIPT_FILE)))restored=candidate;
      }
      if(!restored)await wait(200);
    }
    assert.ok(restored,'Real SFX must restore its assets without a path error dialog');
    const longFile=path.join(restored,...report.longAsset.split('/'));
    assert.ok(longFile.length>260);
    assert.equal(fs.readFileSync(longFile,'utf8'),'LONG PATH PRESERVED');
    let opened=false;
    const env={...process.env,WSMB_QA_TITLE:config.brand.title};
    for(let i=0;i<30&&!opened;i++) {
      const check=await execFileP('powershell.exe',['-NoProfile','-NonInteractive','-Command',
        "Get-Process -Name 'LaunchBox Viewer' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq $env:WSMB_QA_TITLE } | ForEach-Object { 'READY' }; exit 0"],{env,windowsHide:true});
      opened=check.stdout.includes('READY');if(!opened)await wait(200);
    }
    assert.ok(opened,'The normal shipped Viewer must open with the exported project title');
    await execFileP('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      "Get-Process -Name 'LaunchBox Viewer' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq $env:WSMB_QA_TITLE } | ForEach-Object { [void]$_.CloseMainWindow() }"],{env,windowsHide:true});
    await Promise.race([exited,wait(10000)]);
    assert.equal(fs.existsSync(restored),false,'Closing the actual SFX must clean its long temporary resources');
    report.checks.push('actual generated SFX opens the normal shipped Viewer, restores >260-character paths and a 72-level resource tree, and cleans temporary resources on close');
  } finally {
    if(!exit&&child.pid)await execFileP('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});
  }
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
  const archiveEngine = appRequire('./src/shared/project-archive');
  const archiveRoot = path.join(temporary, 'editable-project');
  const restoredRoot = path.join(temporary, 'restored-project');
  fs.mkdirSync(path.join(archiveRoot, 'data'), { recursive: true });
  fs.mkdirSync(path.join(archiveRoot, 'dist-assets'));
  const archiveData = portable.importPortableProject({ sourcePath: workingDirectory,
    assetsDir: path.join(archiveRoot, 'dist-assets'), entries: data.entries, allowWine: false });
  const archiveConfig = {content:[{id:'portable',type:'portable',data:archiveData}]};
  fs.writeFileSync(path.join(archiveRoot, 'data/project-config.json'), JSON.stringify(archiveConfig));
  const archivePath = path.join(temporary, 'editable-project.wsmb');
  const readArchiveConfig = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
  await archiveEngine.exportArchive({ projectRoot: archiveRoot, outputPath: archivePath,
    name:'Portable archive', appVersion:pkg.version, readConfig:readArchiveConfig });
  const restored = await archiveEngine.importArchive({ archivePath, destination:restoredRoot, readConfig:readArchiveConfig });
  const restoredData = restored.config.content[0].data;
  assert.equal(await fileHash(path.join(restoredRoot, restoredData.root, 'resources/app.asar')), asarHash);
  assert.notEqual(restoredData.revision, archiveData.revision);
  await runtime.launchPortableProject({data:restoredData, assetsDir:path.join(restoredRoot,'dist-assets'),storageDir,spawnImpl});
  await completed;
  assert.notEqual(launched.options.cwd, workingDirectory);
  report.checks.push('editable project archive: real ASAR round trip, independent portable revision and native execution');
  portable.removePortableProject({ data, assetsDir });
  await runtime.launchPortableProject({ data, assetsDir, storageDir, spawnImpl });
  await completed;
  assert.equal(launched.options.cwd, workingDirectory);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), 'keep between launches');
  report.checks.push('portable import + real native process + physical ASAR + persistent working copy');
}

async function verifyCrossPlatformPortableExport({ applicationRoot, templates, engine }) {
  const fromWindows = process.platform === 'win32';
  const target = fromWindows ? 'mac' : 'windows';
  const portable = createRequire(path.join(applicationRoot, 'package.json'))('./src/shared/portable-app');
  const sourceName = fromWindows ? 'Imported Mac.app' : 'Imported Windows';
  const source = path.join(temporary, sourceName);
  const binaryRelative = fromWindows ? 'Contents/MacOS/Program' : 'Program.exe';
  const resourceRelative = fromWindows ? 'Contents/Resources/settings.txt' : 'resources/settings.txt';
  const executable = path.join(source, binaryRelative);
  fs.mkdirSync(path.dirname(executable), {recursive:true});
  fs.mkdirSync(path.dirname(path.join(source,resourceRelative)), {recursive:true});
  fs.writeFileSync(path.join(source,resourceRelative),'Preserve original resources');
  if (fromWindows) fs.writeFileSync(path.join(source,'Contents/Info.plist'),'<plist><dict><key>CFBundleExecutable</key><string>Program</string></dict></plist>');
  // Read a real binary from the verified destination template. The creator
  // never executes opposite-platform code or materialises the signed bundle.
  const templatePath = path.join(templates,fromWindows?'mac-universal.zip':'windows-x64.zip');
  const nativeEntry = fromWindows ? 'LaunchBox Viewer.app/Contents/MacOS/LaunchBox Viewer' : 'LaunchBox Viewer.exe';
  const zip = await engine.archiveIO.openZip(templatePath);
  try {
    await new Promise((resolve,reject) => {
      zip.once('error',reject);
      zip.once('end',()=>reject(new Error('Native portable fixture missing from template')));
      zip.on('entry',entry => {
        if(entry.fileName!==nativeEntry)return zip.readEntry();
        engine.archiveIO.entryStream(zip,entry).then(stream=>pipeline(stream,fs.createWriteStream(executable,{flags:'wx'}))).then(resolve,reject);
      });zip.readEntry();
    });
  } finally {zip.close();}
  const nativeHash=await fileHash(executable);
  assert.equal(fs.statSync(executable).mode&0o111,0,'Fixture must lack Unix execute bits on the creator host');
  const projectRoot=path.join(temporary,'cross-platform-regression'),assetsDir=path.join(projectRoot,'dist-assets');
  fs.mkdirSync(assetsDir,{recursive:true});fs.mkdirSync(path.join(projectRoot,'data'));
  const data=portable.importPortableProject({sourcePath:source,assetsDir,entries:fromWindows?{mac:'.'}:{windows:'Program.exe'}});
  data.candidates.forEach(candidate=>{candidate.executable=false;}); // Saved metadata is advisory.
  const config={brand:{title:'Cross-platform portable'},content:[{id:'native-portable',type:'portable',data}]};
  assert.equal(portable.assertPortableTarget({data,assetsDir,target}).requiresWine,false);
  const importedBinary=(fromWindows?sourceName+'/':'')+binaryRelative;
  const imported=path.join(projectRoot,data.root,importedBinary),modeBefore=fs.statSync(imported).mode;
  const outputPath=path.join(temporary,'cross-platform-portable.zip');
  await engine.exportProject({target,templatePath,outputPath,projectName:'Portable Regression',config,assetsDir});
  const base=(fromWindows?'Portable Regression.data/':'resources/')+data.root+'/';
  const resource=(fromWindows?sourceName+'/':'')+resourceRelative;
  const entries=await zipIndex(outputPath,[base+importedBinary,base+resource]);
  assert.equal(entries.get(base+importedBinary).mode,0o100000|(fromWindows?0o755:modeBefore&0o777));
  assert.equal(entries.get(base+importedBinary).sha256,nativeHash);
  assert.equal(entries.get(base+resource).mode&0o111,0);
  assert.equal(fs.statSync(imported).mode,modeBefore,'Export must not change the saved application on disk');
  report.checks.push(fromWindows
    ? 'Windows to Mac portable regression: real Mach-O, stale saved metadata, ZIP mode 0755, unchanged binary SHA-256/resources/project'
    : 'Mac to Windows portable regression: real PE EXE without Unix execute permission, complete export, unchanged binary SHA-256/resources/project');
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
  const nativeRuntime = packaged ? path.join(resources, 'ffmpeg')
    : path.join(root, require('../build-configs/runtime-resources.cjs').runtimeDirectory('ffmpeg', mac ? 'mac-universal' : 'windows-x64'));
  const sharedRuntimeSourcesDir = path.join(nativeRuntime, 'sources');
  const appRequire = createRequire(path.join(applicationRoot, 'package.json'));
  const engine = appRequire('./src/shared/project-export');
  report.enginePath = appRequire.resolve('./src/shared/project-export');
  report.dependencies = Object.fromEntries(['yauzl', 'yazl'].map(name => [name, appRequire(name + '/package.json').version]));
  const lock = require('../package-lock.json');
  for (const [name, version] of Object.entries(report.dependencies)) assert.equal(version, lock.packages['node_modules/' + name].version);
  temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'builder-real-electron-')));
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await window.loadURL('data:text/html,<title>Export regression smoke</title>');
  const assetsDir = path.join(temporary, 'assets');
  const webFolder = 'web-12345678-1234-4234-8234-123456789abc';
  fs.mkdirSync(path.join(assetsDir, webFolder, 'styles'), { recursive: true });
  fs.writeFileSync(path.join(assetsDir, webFolder, 'index.html'), '<!doctype html><link rel="stylesheet" href="styles/app.css"><h1>Olá, Windows e Mac</h1>');
  fs.writeFileSync(path.join(assetsDir, webFolder, 'styles/app.css'), 'h1 { color: #126; }');
  const projectName = 'Smoke António';
  const config = { language: 'pt', brand: { title: projectName }, content: [{ id: 'web-smoke', type: 'local-web', title: 'HTML local', data: { root: 'dist-assets/' + webFolder, entry: 'index.html' } }], export: { iconPath: null } };
  const archiveBytes = Buffer.from('UEsDBAoACQAAACwSVF3znKRmJAAAABgAAAAKABwAcmVhZG1lLnR4dFVUCQADA6XWagOl1mp1eAsAAQQAAAAABAAAAACWurCOwKQ3tkzfU8cAxHGblFHehLud84pZwrl86SehC6TwuPlQSwcI85ykZiQAAAAYAAAAUEsBAh4DCgAJAAAALBJUXfOcpGYkAAAAGAAAAAoAGAAAAAAAAQAAAKSBAAAAAHJlYWRtZS50eHRVVAUAAwOl1mp1eAsAAQQAAAAABAAAAABQSwUGAAAAAAEAAQBQAAAAeAAAAAAA', 'base64');
  fs.writeFileSync(path.join(assetsDir, 'protected.zip'), archiveBytes);
  const longAsset='long-paths/'+Array(72).fill('d').join('/')+'/'+ 'a'.repeat(64)+'-'+'b'.repeat(64)+'.cache';
  fs.mkdirSync(path.dirname(path.join(assetsDir,longAsset)),{recursive:true});
  fs.writeFileSync(path.join(assetsDir,longAsset),'LONG PATH PRESERVED');report.longAsset=longAsset;
  config.content.push({id:'archive-smoke',type:'archive-download',title:'Protected archive',data:{file:'dist-assets/protected.zip',fileName:'protected.zip'}});
  const gifBytes = fs.readFileSync(path.join(root, 'tests/fixtures/banner-animated.gif'));
  fs.writeFileSync(path.join(assetsDir, 'banner.gif'), gifBytes);
  config.marketing = { banners: {
    top: { enabled:true, dismissible:true, image:'dist-assets/banner.gif', url:'' },
    bottom: { enabled:true, dismissible:false, image:'dist-assets/banner.gif', url:'' }
  } };
  report.exports = [];
  let expectedWindowsAsar;
  for (const target of ['windows', 'mac']) {
    const templatePath = path.join(templates, target === 'windows' ? 'windows-x64.zip' : 'mac-universal.zip');
    const asarEntry = target === 'windows' ? 'resources/app.asar' : 'LaunchBox Viewer.app/Contents/Resources/app.asar';
    const runtimeBase = target === 'windows' ? 'resources/ffmpeg' : 'LaunchBox Viewer.data/ffmpeg';
    const sourceEntries = ffmpegSources.map(source => runtimeBase + '/sources/' + source.file);
    const baseline = await zipIndex(templatePath, [asarEntry, ...sourceEntries]);
    assert.ok([...baseline.keys()].some(name => name.endsWith('/')), 'Real templates must contain explicit directories');
    const runtimeExecutable = runtimeBase + '/' + (target === 'windows' ? 'ffmpeg.exe' : 'ffmpeg');
    assert.ok(baseline.has(runtimeExecutable), 'The template must contain its complete optional FFmpeg runtime');
    if (target === 'mac') {
      assert.ok(![...baseline.keys()].some(name => /^LaunchBox Viewer\.app\/Contents\/Resources\/(?:ffmpeg|php)(?:\/|$)/.test(name)),
        'The signed Mac template must put optional runtimes outside the sealed app');
    }
    const outputPath = path.join(temporary, target + '.zip');
    const result = await engine.exportProject({ target, templatePath, outputPath, projectName, config, assetsDir });
    assert.equal(result.target, target);
    const outputAsar = target === 'windows' ? asarEntry : projectName + '.app/Contents/Resources/app.asar';
    const base = target === 'windows' ? 'resources' : projectName + '.data';
    const exported = await zipIndex(outputPath, [outputAsar, base + '/data/project-config.json', base + '/dist-assets/' + webFolder + '/index.html', base + '/dist-assets/protected.zip', base + '/dist-assets/banner.gif',base+'/dist-assets/'+longAsset]);
    for (const [name, metadata] of baseline) {
      if (templateRuntime(name, target)) continue;
      const destination = exportEntry(name, target, projectName);
      assert.deepEqual(exported.get(destination), metadata, 'Template entry changed: ' + destination);
    }
    assertNoOptionalRuntimes(exported, target, projectName);
    const omitted = [...baseline].reduce((sum, [name, metadata]) => sum + (templateRuntime(name, target) ? metadata.size : 0), 0);
    assert.ok(omitted > 0, 'The real native template must allow measurable runtime omission');
    assert.equal(result.omittedRuntimeBytes, omitted);
    assert.equal(exported.get(base + '/data/project-config.json').sha256, crypto.createHash('sha256').update(JSON.stringify(config, null, 2)).digest('hex'));
    assert.equal(exported.get(base + '/dist-assets/' + webFolder + '/index.html').sha256, await fileHash(path.join(assetsDir, webFolder, 'index.html')));
    assert.equal(exported.get(base + '/dist-assets/protected.zip').sha256, crypto.createHash('sha256').update(archiveBytes).digest('hex'));
    assert.equal(exported.get(base+'/dist-assets/'+longAsset).sha256,crypto.createHash('sha256').update('LONG PATH PRESERVED').digest('hex'));
    assert.equal(exported.get(base + '/dist-assets/banner.gif').sha256, crypto.createHash('sha256').update(gifBytes).digest('hex'));
    report.checks.push(target + ' animated banner: unchanged GIF SHA-256 and close permissions in exported config');
    report.checks.push(target + ' protected archive: unchanged SHA-256');
    report.checks.push(target + ' HTML ZIP: real template, unchanged ASAR, project HTML, no unused FFmpeg/PHP');
    const iptvConfig = { ...config, content: [...config.content, { id: 'iptv-smoke', type: 'iptv', title: 'IPTV offline smoke', data: {} }] };
    const iptvPath = path.join(temporary, target + '-iptv.zip');
    await engine.exportProject({ target, templatePath, outputPath: iptvPath, projectName, config: iptvConfig, assetsDir, sharedRuntimeSourcesDir });
    const outputSources = sourceEntries.map(name => exportEntry(name, target, projectName));
    const iptv = await zipIndex(iptvPath, [outputAsar, ...outputSources]);
    for (const [name, metadata] of baseline) {
      if (templateRuntime(name, target) === 'php' || name.endsWith('/ffmpeg/template-sources.json')) continue;
      const destination = exportEntry(name, target, projectName);
      assert.deepEqual(iptv.get(destination), metadata, 'IPTV export changed a retained template entry: ' + destination);
    }
    assert.ok([...iptv.keys()].some(name => name.endsWith('/ffmpeg/' + (target === 'windows' ? 'ffmpeg.exe' : 'ffmpeg'))));
    assert.ok(![...iptv.keys()].some(name => /\/(?:php)(?:\/|$)/.test(name)), 'An IPTV-only export must not include PHP');
    assert.ok(![...iptv.keys()].some(name => name.endsWith('/ffmpeg/template-sources.json')), 'Shared-source markers must never replace the exported corresponding sources');
    for (const [index, source] of ffmpegSources.entries()) {
      assert.equal(iptv.get(outputSources[index])?.sha256, source.sha256, 'Exported FFmpeg matching source archive is absent or changed: ' + source.file);
    }
    const htmlBytes = fs.statSync(outputPath).size;
    const iptvBytes = fs.statSync(iptvPath).size;
    assert.ok(iptvBytes > htmlBytes, 'Omitting the real runtime must reduce the final ZIP size');
    report.exports.push({ target, htmlBytes, iptvBytes, savedBytes: iptvBytes - htmlBytes, omittedRuntimeBytes: omitted });
    report.checks.push(target + ' IPTV ZIP retains every FFmpeg binary, source, recipe and licence entry');
    if (target === 'windows') {
      expectedWindowsAsar = baseline.get(asarEntry).sha256;
      const extracted = path.join(temporary, 'windows-template');
      await engine.extractWindowsTemplate(templatePath, extracted, { config, assetsDir });
      const asarFile = path.join(extracted, 'resources/app.asar');
      verifyAsar(asarFile);
      assert.equal(await fileHash(asarFile), expectedWindowsAsar);
      for (const runtime of ['ffmpeg', 'php']) assert.equal(fs.existsSync(path.join(extracted, 'resources', runtime)), false);
      report.checks.push('Windows extraction through real Electron + valid ASAR members + runtime selection');
    } else if (mac) {
      const expanded = path.join(temporary, 'mac-expanded');
      await execFileP('/usr/bin/ditto', ['-x', '-k', outputPath, expanded]);
      const bundle = path.join(expanded, projectName + '.app');
      await execFileP('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]);
      await execFileP('/usr/bin/lipo', [path.join(bundle, 'Contents/MacOS/LaunchBox Viewer'), '-verify_arch', 'x86_64', 'arm64']);
      verifyAsar(path.join(bundle, 'Contents/Resources/app.asar'));
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(expanded, projectName + '.data/data/project-config.json'), 'utf8')), config);
      assert.equal(fs.readFileSync(path.join(expanded,projectName+'.data/dist-assets',longAsset),'utf8'),'LONG PATH PRESERVED');
      report.checks.push('Mac exported ZIP expanded by ditto + intact signature + universal executable');
    }
  }
  if (!mac) await verifyRealWindowsSfx({ applicationRoot, resources, engine, config, assetsDir, templates, expectedAsar: expectedWindowsAsar, sharedRuntimeSourcesDir });
  await verifyCrossPlatformPortableExport({ applicationRoot, templates, engine });
  await verifyRealPortableLaunch(applicationRoot, assetsDir);
  await verifyAndroidInformation(applicationRoot);
  report.builderUI = await require('./verify-builder-ui.cjs').verifyBuilderUI({ BrowserWindow, applicationRoot });
  report.checks.push('full shipped Builder UI in Chromium: banner toggles, failed saves, pending settings, editable import/export, no navigation');
  report.viewerBanners = await require('./verify-viewer-banners.cjs').verifyViewerBanners({ BrowserWindow, applicationRoot });
  report.checks.push('full shipped Viewer: animated GIF frames, independent X buttons, pointer/keyboard, reclaimed content space');
  if (!packaged) {
    report.links = await require('../tests/electron-links.cjs').runElectronLinkTests({ app, BrowserWindow });
    report.checks.push('real Electron webview link navigation');
  }
}

app.whenReady().then(main).then(() => finish()).catch(finish);
