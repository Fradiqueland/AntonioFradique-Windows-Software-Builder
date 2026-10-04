'use strict';

// Called by the native Electron smoke workflow, not by node --test. Uses real
// Chromium <webview> navigation and native input delivery. The only substituted
// side effect is shell.openExternal, so CI never opens a user's browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { fileURLToPath } = require('node:url');
const security = require('../src/shared/electron-security');

async function waitFor(predicate, description, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Timed out: ' + description);
}

async function runElectronLinkTests({ app, BrowserWindow }) {
  assert.ok(app.isReady(), 'Call link smoke tests after app.whenReady()');
  const { session } = require('electron');
  const opened = [];
  const existingWindows = new Set(BrowserWindow.getAllWindows());
  const server = http.createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: 'https://example.invalid/automatic-redirect' });
      return response.end();
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/host') {
      return response.end(`<!doctype html><style>html,body{margin:0;height:100%}webview{width:100%;height:100%}</style>
        <webview id="module" partition="local-web-link-smoke-${Date.now()}" allowpopups
          webpreferences="nodeIntegration=yes,contextIsolation=no,sandbox=no"
          src="http://127.0.0.1:${server.address().port}/page"></webview>`);
    }
    response.end(`<!doctype html><style>body{padding:16px}button,a{display:block;margin:12px;padding:12px}</style>
      <button id="button" onclick="window.open('https://chatgpt.com/link-smoke','_blank')">Open ChatGPT</button>
      <a id="blank" target="_blank" href="https://antoniofradique.net/link-smoke-blank">See My Other Products</a>
      <a id="normal" href="https://antoniofradique.net/link-smoke-normal">Same-tab external link</a>
      <a id="local" href="/next">Local page</a>
      <a id="redirect" href="/redirect">Redirect must not open browser</a>
      <button id="unsafe" onclick="window.open('file:///private.txt','_blank')">Unsafe protocol</button>`);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let window;
  let guest;
  try {
    // Execute the production main-process wiring itself, with Electron's real
    // session objects. This catches regressions in local-web classification,
    // permission hardening and event registration in addition to helper tests.
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const source = main.match(/^function secureEmbeddedContent\(win\) \{[\s\S]*?^\}/m);
    assert.ok(source, 'Production secureEmbeddedContent function not found');
    const context = {
      ...security, fs, path, fileURLToPath, session, console, URL,
      isInsideAssetsDir: () => false,
      shell: { openExternal: async url => { opened.push(url); } }
    };
    vm.runInNewContext(source[0] + '\nthis.configureWindow = secureEmbeddedContent;', context);
    window = new BrowserWindow({
      width: 700, height: 650, show: false,
      webPreferences: { webviewTag: true, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
    });
    context.configureWindow(window);
    const attached = new Promise(resolve => window.webContents.once('did-attach-webview', (_event, contents) => resolve(contents)));
    await window.loadURL(`http://127.0.0.1:${server.address().port}/host`);
    guest = await Promise.race([attached, new Promise((_, reject) => setTimeout(() => reject(new Error('No real webview attached')), 8000))]);
    await waitFor(() => guest.executeJavaScript("!!document.getElementById('button')").catch(() => false), 'imported HTML loaded');
    assert.deepEqual(await guest.executeJavaScript('({node:typeof require,process:typeof process,viewer:typeof window.viewer})'),
      { node: 'undefined', process: 'undefined', viewer: 'undefined' });

    // BrowserWindow focus is required by Electron.sendInputEvent. The native CI
    // session briefly shows this fixture; no external URL is actually opened.
    window.show();
    window.focus();
    guest.focus();
    async function click(id) {
      const point = await guest.executeJavaScript(`(() => {
        const rect = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
        return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};
      })()`);
      guest.sendInputEvent({ type: 'mouseMove', ...point });
      guest.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      guest.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    }
    await guest.executeJavaScript("window.open('https://example.invalid/automatic-popup','_blank'); undefined;");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(opened, [], 'An automatic popup must not reach the browser');
    for (const [id, url] of [['button', 'https://chatgpt.com/link-smoke'], ['blank', 'https://antoniofradique.net/link-smoke-blank'], ['normal', 'https://antoniofradique.net/link-smoke-normal']]) {
      const before = opened.length;
      await click(id);
      await waitFor(() => opened.length === before + 1, 'native click opens ' + id);
      assert.equal(opened.at(-1), url);
      assert.equal(new URL(guest.getURL()).hostname, '127.0.0.1', 'The imported module stays open');
    }
    await click('local');
    await waitFor(() => new URL(guest.getURL()).pathname === '/next', 'local navigation remains in the module');
    assert.equal(opened.length, 3);
    await click('redirect');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(opened.length, 3, 'A server redirect is never a browser-opening gesture');
    await waitFor(() => guest.executeJavaScript("!!document.getElementById('unsafe')").catch(() => false), 'page survives blocked redirect');
    await click('unsafe');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(opened.length, 3, 'Non-HTTP(S) links stay blocked');
    assert.equal(BrowserWindow.getAllWindows().filter(item => !existingWindows.has(item)).length, 1,
      'No extra Electron window is created by a link');
    return { passed: 7, engine: 'Electron ' + process.versions.electron, nativeClicks: true, externalBrowserOpened: false };
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

module.exports = { runElectronLinkTests };
