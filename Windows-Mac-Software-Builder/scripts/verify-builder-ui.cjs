'use strict';
const fs = require('fs'); // ASAR-aware: also inspect the installed application's code.
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');

async function verifyBuilderUI({ BrowserWindow, applicationRoot }) {
  const renderer = fs.readFileSync(path.join(applicationRoot, 'src/builder/renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(applicationRoot, 'src/builder/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const main = fs.readFileSync(path.join(applicationRoot, 'main.js'), 'utf8');
  const config = vm.runInNewContext('(' + main.match(/const DEFAULT_CONFIG = ([\s\S]*?);\n/)[1] + ')');
  config.content = [{ id: 'first', type: 'html', title: 'Test', data: { html: '<h1>Test</h1>' } }];
  const dict = JSON.parse(fs.readFileSync(path.join(applicationRoot, 'locales/pt.json'), 'utf8'));
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true,
    nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  const navigations = [], crashes = [];
  const evaluate = script => win.webContents.executeJavaScript(script);
  async function until(condition) {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await evaluate(condition)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Builder UI condition timed out: ' + condition);
  }
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    win.webContents.on('did-start-navigation', (_event, url, _inPlace, isMainFrame) => { if (isMainFrame) navigations.push(url); });
    win.webContents.on('render-process-gone', (_event, detail) => crashes.push(detail.reason));
    // Only IPC transport/dialogs are mocked. Execute the entire shipped renderer,
    // actual forms, browser validation, DOM events and asynchronous save handlers.
    await evaluate(`
      window.qa = { config: ${JSON.stringify(config)}, errors: [], calls: [], failBanner: false, active: 'alpha' };
      addEventListener('error', event => qa.errors.push(String(event.error || event.message)));
      addEventListener('unhandledrejection', event => qa.errors.push(String(event.reason)));
      const copy = value => JSON.parse(JSON.stringify(value));
      const pause = () => new Promise(resolve => setTimeout(resolve, 40));
      const projectState = () => ({ activeId: qa.active, projects: [{id:'alpha', name:'Alpha'}, {id:'beta', name:'Beta'}] });
      window.icurator = {
        version: 'test', loadConfig: async () => copy(qa.config), projectsList: async () => projectState(),
        loadLocale: async () => ({lang:'pt', dict:${JSON.stringify(dict)}}), saveLanguage: async () => {},
        getExportTargets: async () => ({hostPlatform:'win32',targets:[{id:'windows',available:true,format:'exe'},{id:'mac',available:true,format:'zip'}]}),
        resolveAssetPath: async () => null, onExportLog: () => {},
        saveBannerConfig: async payload => {
          qa.calls.push('banner-start'); await pause();
          if (qa.failBanner) throw new Error('Injected banner write failure');
          qa.config.marketing.banners = copy(payload); qa.calls.push('banner-done'); return copy(qa.config);
        },
        saveBrandConfig: async payload => { await pause(); Object.assign(qa.config.brand,payload); qa.calls.push('brand-done'); return copy(qa.config); },
        projectsOpen: async id => { qa.calls.push('open'); qa.active=id; return {state:projectState(),config:copy(qa.config)}; },
        projectsExportArchive: async id => { qa.calls.push('archive-export'); qa.exported=copy(qa.config); await pause(); return {ok:true,path:'Project.wsmb'}; },
        projectsImportArchive: async () => { qa.calls.push('archive-import'); await pause(); if(qa.cancelImport)return {cancelled:true}; qa.config.brand.title='Imported'; return {state:projectState(),config:copy(qa.config)}; },
        exportProject: async () => { qa.calls.push('build'); qa.built=copy(qa.config); await pause(); return {cancelled:true}; },
        openViewer: async () => { qa.calls.push('preview'); },
        pickFile: async () => ({path:'chosen.png',name:'chosen.png'}),
        saveIcon: async () => { qa.calls.push('icon-start'); await pause(); if(qa.failIcon)throw new Error('Injected icon failure'); qa.config.export.iconPath='data/icon-source.png'; qa.calls.push('icon-done'); return copy(qa.config); }
      }; void 0;
    `);
    await evaluate(renderer);
    await evaluate("document.dispatchEvent(new Event('DOMContentLoaded')); void 0;");
    await until("document.querySelectorAll('.project-item').length === 2 && !projectTransition");
    await evaluate("goToTab('aparencia'); setSectionCollapsed('banners',false); void 0;");
    for (const slot of ['top', 'bottom']) {
      for (const enabled of [true, false, true, false]) {
        await evaluate(`document.getElementById('banner-${slot}-enabled').click(); void 0;`);
        await until(`qa.config.marketing.banners.${slot}.enabled === ${enabled} && settingsWrites.size === 0`);
        assert.equal(await evaluate("document.getElementById('banner-status').textContent"), dict.common.saved);
      }
    }
    // An edit followed immediately by a project switch must commit before open.
    await evaluate("qa.calls=[]; document.getElementById('banner-top-enabled').click(); openProject('beta'); void 0;");
    await until("qa.active === 'beta' && !projectTransition");
    assert.deepEqual(await evaluate('qa.calls'), ['banner-start', 'banner-done', 'open']);
    assert.equal(await evaluate('qa.config.marketing.banners.top.enabled'), true);
    // A failed save remains editable and prevents a switch; retry preserves it.
    await evaluate("qa.failBanner=true; qa.calls=[]; goToTab('aparencia'); document.getElementById('banner-bottom-enabled').click(); openProject('alpha'); void 0;");
    await until("settingsFailures.size === 1 && settingsWrites.size === 0");
    assert.equal(await evaluate('qa.active'), 'beta');
    assert.match(await evaluate("document.getElementById('banner-status').textContent"), /Injected/);
    await evaluate("qa.failBanner=false; openProject('alpha'); void 0;");
    await until("qa.active === 'alpha' && !projectTransition");
    assert.equal(await evaluate('qa.config.marketing.banners.bottom.enabled'), true);
    // A native form submit is always canceled, including forms without handlers.
    assert.equal(await evaluate("(() => {const f=document.createElement('form');document.body.append(f);const event=new Event('submit',{bubbles:true,cancelable:true});f.dispatchEvent(event);f.remove();return event.defaultPrevented;})()"), true);
    // Editable export uses the pending input; canceling import preserves it.
    await evaluate("goToTab('aparencia'); const title=document.getElementById('brand-title'); title.value='Newest title';title.dispatchEvent(new Event('input',{bubbles:true})); exportEditableProject('alpha'); void 0;");
    await until("qa.exported && !projectTransition");
    assert.equal(await evaluate('qa.exported.brand.title'), 'Newest title');
    await evaluate("qa.cancelImport=true;document.getElementById('project-import').click();void 0;");
    await until("qa.calls.includes('archive-import') && !projectTransition");
    assert.equal(await evaluate("document.getElementById('brand-title').value"), 'Newest title');
    await evaluate("qa.cancelImport=false;qa.calls=[];document.getElementById('project-import').click();void 0;");
    await until("qa.calls.includes('archive-import') && !projectTransition");
    assert.equal(await evaluate("document.getElementById('brand-title').value"), 'Imported');
    await evaluate("goToTab('aparencia'); document.getElementById('banner-top-enabled').click();document.getElementById('export-build').click();void 0;");
    await until("qa.built && !exportInProgress");
    assert.equal(await evaluate('qa.built.marketing.banners.top.enabled'), false);
    await evaluate("qa.calls=[]; goToTab('aparencia'); document.getElementById('banner-bottom-enabled').click();document.getElementById('preview-btn').click();void 0;");
    await until("qa.calls.includes('preview')");
    assert.deepEqual(await evaluate('qa.calls'), ['banner-start','banner-done','preview']);
    await evaluate("qa.calls=[];qa.failIcon=true;document.getElementById('icon-pick').click();void 0;");
    await until("settingsFailures.size === 1 && settingsWrites.size === 0");
    await evaluate("qa.failIcon=false; openProject('beta');void 0;");
    await until("qa.active === 'beta' && !projectTransition");
    assert.deepEqual(await evaluate('qa.calls'), ['icon-start','icon-start','icon-done','open']);
    assert.deepEqual(await evaluate('qa.errors'), []);
    assert.deepEqual(crashes, []);
    assert.deepEqual(navigations, []);
    assert.ok(await evaluate("document.querySelector('.app').isConnected && document.body.innerText.length > 1000"));
    return { bannerToggles: 8, navigationCount: navigations.length, saveFailureRecovery: true,
      pendingSettingsPreserved: true, projectImportExport: true, renderer: 'full shipped code in Chromium' };
  } finally { if (!win.isDestroyed()) win.destroy(); }
}
module.exports = { verifyBuilderUI };
