'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const expectedVersion = require('../package-lock.json').packages['node_modules/hls.js'].version;
const expectedTsVersion = require('../package-lock.json').packages['node_modules/mpegts.js'].version;

// Use the shipped preload, HTML, CSP, renderer and player. Supply only the
// project's configuration/state, a two-segment HLS channel and a raw TS channel.
async function verifyViewerHls({ electron, applicationRoot, segment, transportStream }) {
  const requests = new Set();
  const playlist = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n' +
    '#EXTINF:2,\nfirst.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\nsecond.ts\n#EXT-X-ENDLIST\n';
  const server = http.createServer((req, res) => {
    requests.add(req.url);
    const manifest = req.url === '/channel.m3u8';
    if (!manifest && !['/first.ts', '/second.ts', '/transport.ts'].includes(req.url)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': manifest ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(manifest ? playlist : req.url === '/transport.ts' ? transportStream : segment);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const config = { language: 'en', brand: { title: 'Offline HLS' }, content: [{ id: 'station', type: 'iptv', title: 'Broadcast',
    data: { channels: [{ name: 'HLS', url: origin + '/channel.m3u8' }, { name: 'MPEG-TS', url: origin + '/transport.ts' }] } }] };
  const replies = { 'config:load': config, 'i18n:loadLocale': { lang: 'en', dict: {} }, 'state:load': {}, 'state:save': true,
    'favs:load': { folders: [] }, 'iptv:hosts': true, 'iptv:hasFfmpeg': false };
  let win;
  const registered = [];
  const blocked = [];
  try {
    for (const [channel, value] of Object.entries(replies)) {
      electron.ipcMain.handle(channel, () => value);
      registered.push(channel);
    }
    win = new electron.BrowserWindow({ show: false, width: 900, height: 600, webPreferences: {
      preload: path.join(applicationRoot, 'preload-viewer.js'), partition: 'viewer-hls-smoke',
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true
    } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      const allowed = details.url.startsWith(origin + '/');
      if (!allowed) blocked.push(details.url);
      callback({ cancel: !allowed });
    });
    await win.loadFile(path.join(applicationRoot, 'src/viewer/index.html'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const until = async (predicate, detail) => {
        const end = performance.now() + 18000;
        while (!predicate()) {
          if (performance.now() >= end) throw Error(detail + ': ' + (document.querySelector('.iptv-diag')?.textContent || ''));
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      };
      await until(() => document.querySelector('#viewer-menu button'), 'No IPTV module');
      document.querySelector('#viewer-menu button').click();
      await until(() => document.querySelector('.iptv-item-btn'), 'No HLS channel');
      const video = document.querySelector('.iptv-main video') || document.querySelector('video');
      video.muted = true;
      let callbacks = 0;
      const count = () => { callbacks++; video.requestVideoFrameCallback(count); };
      video.requestVideoFrameCallback(count);
      document.querySelector('.iptv-item-btn').click();
      await until(() => video.currentTime > 2.4 && callbacks >= 40, 'Playback failed to cross the segment boundary');
      const hlsResult = { version: Hls.version, active: Boolean(currentHls), callbacks, seconds: video.currentTime,
        width: video.videoWidth, height: video.videoHeight, videoError: video.error?.code || null };
      const channels = document.querySelectorAll('.iptv-item-btn');
      const beforeSwitch = callbacks;
      channels[1].click();
      await until(() => currentTs && !currentHls && video.currentTime > 1 && callbacks - beforeSwitch >= 25,
        'Raw MPEG-TS playback failed');
      const raw = { version: mpegts.version, callbacks: callbacks - beforeSwitch, seconds: video.currentTime,
        width: video.videoWidth, height: video.videoHeight, videoError: video.error?.code || null };
      channels[0].click();
      await until(() => !currentTs && currentHls && video.currentTime > 0.25, 'Could not return from MPEG-TS to HLS');
      return { ...hlsResult, raw, switchedBackToHls: true };
    })()`, true);
    assert.equal(result.version, expectedVersion);
    assert.ok(result.active && result.width && result.height);
    assert.equal(result.videoError, null);
    assert.equal(result.raw.version, expectedTsVersion);
    assert.ok(result.raw.width && result.raw.height && result.switchedBackToHls);
    assert.equal(result.raw.videoError, null);
    assert.deepEqual([...requests].sort(), ['/channel.m3u8', '/first.ts', '/second.ts', '/transport.ts']);
    assert.deepEqual(blocked, []);
    return result;
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    for (const channel of registered) electron.ipcMain.removeHandler(channel);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

module.exports = { verifyViewerHls };
