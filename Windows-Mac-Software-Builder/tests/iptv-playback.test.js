'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const renderer = fs.readFileSync(path.join(__dirname, '../src/viewer/renderer.js'), 'utf8');
const CHANNEL = 'https://media.invalid/live/example/example/12.ts';
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

// Run the real renderer with media-engine doubles. No provider URL, credentials,
// network or decoder is needed to reproduce one frame followed by a fatal error.
function playerHarness({ ffmpeg = false, pauseThrows = false } = {}) {
  let now = 0, nextTimer = 0, nextFrame = 0;
  const timers = new Map(), ids = new Map(), hls = [], ts = [], proxies = [], stopped = [], consoleLines = [];
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
      this.listeners = new Map(); this.attrs = {}; this.style = { setProperty() {} }; this.dataset = {};
      this.className = ''; this._text = ''; this.value = ''; this.frames = new Map(); this.totalFrames = 0;
      this.paused = true; this.ended = false; this.currentTime = 0; this.videoWidth = 0; this.videoHeight = 0;
      this.buffered = { length: 0 }; this.error = null;
      this.classList = {
        contains: name => this.className.split(' ').includes(name),
        add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
        toggle: (name, force) => { const on = force === undefined ? !this.classList.contains(name) : force; this.classList[on ? 'add' : 'remove'](name); }
      };
    }
    appendChild(child) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this._text = ''; this.append(...children); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(value) { this.textContent = value; }
    get innerHTML() { return this.textContent; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    removeAttribute(key) { delete this.attrs[key]; if (key === 'src') this.src = ''; }
    addEventListener(name, callback, options) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push({ callback, once: options && options.once }); }
    removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item.callback !== callback)); }
    emit(name) { for (const item of [...(this.listeners.get(name) || [])]) { if (item.once) this.removeEventListener(name, item.callback); item.callback({ target: this, preventDefault() {}, stopPropagation() {} }); } }
    click() { this.emit('click'); }
    querySelectorAll(selector) {
      const matches = node => selector.split(',').some(raw => { const part = raw.trim(); return part.startsWith('.') ? node.classList.contains(part.slice(1)) : /^[a-z]+$/i.test(part) && node.tagName.toLowerCase() === part; });
      return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    pause() { this.paused = true; }
    load() { this.currentTime = 0; this.totalFrames = 0; this.videoWidth = 0; this.error = null; this.ended = false; }
    play() { this.paused = false; return Promise.resolve(); }
    getVideoPlaybackQuality() { return { totalVideoFrames: this.totalFrames }; }
    requestVideoFrameCallback(callback) { const id = ++nextFrame; this.frames.set(id, callback); return id; }
    cancelVideoFrameCallback(id) { this.frames.delete(id); }
    presentFrame(time = 0.12) { this.currentTime = time; this.totalFrames++; this.videoWidth = 1920; this.videoHeight = 1080; this.paused = false; const callbacks = [...this.frames.values()]; this.frames.clear(); callbacks.forEach(callback => callback(now, { mediaTime: time, presentedFrames: this.totalFrames })); }
  }
  class Engine {
    constructor() { this.handlers = new Map(); this.destroyed = false; this.recoveries = 0; this.cleanup = []; }
    on(name, callback) { this.handlers.set(name, callback); }
    emit(name, ...args) { this.handlers.get(name)?.(...args); }
    loadSource(url) { this.url = url; }
    attachMedia(video) { this.video = video; }
    attachMediaElement(video) { this.video = video; }
    load() {}
    play() { return this.video.play(); }
    recoverMediaError() { this.recoveries++; }
    pause() { this.cleanup.push('pause'); if (pauseThrows) throw new Error('decoder already failed'); this.video.pause(); }
    unload() { this.cleanup.push('unload'); }
    detachMediaElement() { this.cleanup.push('detach'); }
    destroy() { this.cleanup.push('destroy'); this.destroyed = true; }
  }
  class Hls extends Engine {
    static isSupported() { return true; }
    static Events = Object.fromEntries(['ERROR', 'BUFFER_CODECS', 'LEVEL_LOADED', 'FRAG_LOADED', 'BUFFER_APPENDING', 'FRAG_BUFFERED', 'FRAG_PARSED', 'MANIFEST_PARSED'].map(key => [key, key]));
    static ErrorTypes = { MEDIA_ERROR: 'mediaError' };
    constructor() { super(); hls.push(this); }
  }
  const mpegts = {
    Events: Object.fromEntries(['ERROR', 'STATISTICS_INFO', 'LOADING_COMPLETE', 'RECOVERED_EARLY_EOF', 'MEDIA_INFO'].map(key => [key, key])),
    getFeatureList: () => ({ mseLivePlayback: true }),
    createPlayer: () => { const player = new Engine(); ts.push(player); return player; }
  };
  const document = new Element('document'); document.documentElement = new Element('html'); document.body = new Element('body'); document.title = 'IPTV test';
  document.appendChild(document.documentElement); document.documentElement.appendChild(document.body);
  document.createElement = tag => new Element(tag);
  document.getElementById = id => { if (!ids.has(id)) { const element = new Element('div'); ids.set(id, element); document.body.appendChild(element); } return ids.get(id); };
  const viewer = { loadFavs: async () => ({ folders: [] }), iptvHosts: async () => {}, iptvHasFfmpeg: async () => ffmpeg,
    iptvProxyUrl: async url => { proxies.push(url); return { token: 'proxy-' + proxies.length, url: 'http://127.0.0.1:8000/local.mp4' }; },
    iptvProxyStatus: async () => ({}), iptvProxyStop: async token => { stopped.push(token); } };
  const window = new Element('window'); Object.assign(window, { viewer, Hls, mpegts, innerWidth: 1200 });
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({ document, window, URL, navigator: {}, Date: ClockDate, localStorage: { getItem: () => null, setItem() {} },
    console: { log: (...args) => consoleLines.push(args.join(' ')), warn() {}, error() {} },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, due: now + delay }); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(renderer.replace(/\nboot\(\);\s*$/, '\n'), context, { filename: 'renderer.js' });
  const run = expression => vm.runInContext(expression, context);
  const stage = ids.get('viewer-stage');
  return { hls, ts, proxies, stopped, stage, run, window, timers, consoleLines,
    async start(url = CHANNEL) { context.channel = url; await run("renderIptv({channels:[{name:'Test channel',url:channel}]}, 'tv')"); stage.querySelector('.iptv-item-btn').click(); await flush(); return stage.querySelector('video'); },
    async advance(ms) { const end = now + ms; let steps = 0; for (;;) { const due = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0]; if (!due) break; assert.ok(++steps < 100, 'bounded timer scheduling'); now = due[1].due; timers.delete(due[0]); due[1].callback(); await flush(); } now = end; }
  };
}

function exhaustHlsRecovery(player) { for (let i = 0; i < 3; i++) player.emit('ERROR', 'ERROR', { fatal: true, type: 'mediaError', details: 'bufferAppendError' }); }

test('MPEG-TS fatal MSE error after its first frame destroys the engine and ends the finite fallback chain', async () => {
  const h = playerHarness(); const video = await h.start(); exhaustHlsRecovery(h.hls[0]);
  const player = h.ts[0]; assert.ok(player); video.presentFrame();
  player.emit('ERROR', 'MediaError', 'MediaMSEError', { code: 11 });
  assert.equal(player.destroyed, true);
  assert.ok(h.stage.querySelector('.iptv-retry'));
  const finalText = h.stage.querySelector('.iptv-now').textContent;
  for (let i = 0; i < 100; i++) player.emit('ERROR', 'MediaError', 'MediaMSEError', { code: 11 });
  await h.advance(90000);
  assert.equal(h.hls.length, 1); assert.equal(h.ts.length, 1); assert.equal(h.proxies.length, 0);
  assert.equal(h.stage.querySelector('.iptv-now').textContent, finalText);
});

test('terminal video decode errors after a frame advance HLS to FFmpeg and then TS exactly once', async () => {
  const h = playerHarness({ ffmpeg: true }); const video = await h.start(); video.presentFrame();
  video.error = { code: 3, message: 'PIPELINE_ERROR_DECODE' }; video.emit('error'); await flush();
  assert.equal(h.hls[0].destroyed, true); assert.equal(h.hls[0].recoveries, 0); assert.equal(h.proxies.length, 1);
  video.presentFrame(); video.error = { code: 3, message: 'PIPELINE_ERROR_DECODE' }; video.emit('error'); await flush();
  assert.deepEqual(h.stopped, ['proxy-1']); assert.equal(h.ts.length, 1);
  video.presentFrame(); video.error = { code: 3, message: 'PIPELINE_ERROR_DECODE' }; video.emit('error'); await flush();
  assert.equal(h.ts[0].destroyed, true); assert.ok(h.stage.querySelector('.iptv-retry'));
});

test('HLS recovery remains bounded after a successful frame', async () => {
  const h = playerHarness(); const video = await h.start(); video.presentFrame(); exhaustHlsRecovery(h.hls[0]);
  assert.equal(h.hls[0].recoveries, 2); assert.equal(h.hls[0].destroyed, true); assert.equal(h.ts.length, 1);
});

test('a stalled HLS recovery is not mistaken for an intentional user pause', async () => {
  const h = playerHarness(); const video = await h.start(); video.presentFrame();
  h.hls[0].emit('ERROR', 'ERROR', { fatal: true, type: 'mediaError', details: 'bufferAppendError' });
  video.paused = true;
  await h.advance(15000);
  assert.equal(h.hls[0].destroyed, true); assert.equal(h.ts.length, 1);
});

test('one frame followed by a silent stall still reaches the watchdog after playback began', async () => {
  const h = playerHarness(); const video = await h.start(); exhaustHlsRecovery(h.hls[0]); video.presentFrame();
  await h.advance(15000);
  assert.equal(h.ts[0].destroyed, true); assert.ok(h.stage.querySelector('.iptv-retry'));
});

test('progress, an intentional pause and a naturally ended stream do not trigger fallback', async () => {
  const h = playerHarness(); const video = await h.start(); exhaustHlsRecovery(h.hls[0]); video.presentFrame();
  video.currentTime = 14; video.totalFrames = 700; await h.advance(15000);
  assert.equal(h.ts[0].destroyed, false);
  video.paused = true; await h.advance(45000); assert.equal(h.ts[0].destroyed, false);
  video.paused = false; video.currentTime = 29; video.totalFrames = 1400; await h.advance(15000);
  video.ended = true; await h.advance(45000); assert.equal(h.ts[0].destroyed, false);
});

test('a failing pause operation cannot skip MPEG-TS unload/detach/destroy', async () => {
  const h = playerHarness({ pauseThrows: true }); const video = await h.start(); exhaustHlsRecovery(h.hls[0]); video.presentFrame();
  h.ts[0].emit('ERROR', 'MediaError', 'MediaMSEError', { code: 11 });
  assert.deepEqual(h.ts[0].cleanup, ['pause', 'unload', 'detach', 'destroy']);
});

test('late errors and watchdogs from a completed module cannot interrupt a replacement player', async () => {
  const h = playerHarness(); const oldVideo = await h.start(); exhaustHlsRecovery(h.hls[0]); oldVideo.presentFrame();
  const oldPlayer = h.ts[0]; const newVideo = await h.start(); const active = h.hls[1]; newVideo.presentFrame();
  oldPlayer.emit('ERROR', 'MediaError', 'MediaMSEError', { code: 11 }); oldVideo.error = { code: 3 }; oldVideo.emit('error');
  newVideo.currentTime = 14; newVideo.totalFrames = 700; await h.advance(15000);
  assert.equal(active.destroyed, false); assert.equal(h.hls.length, 2); assert.equal(h.ts.length, 1);
});

test('diagnostics and console hide URL credentials, paths, query and fragment without changing requests', async () => {
  const h = playerHarness();
  const url = 'https://demo-user:demo-password@streams.invalid:8443/live/path-user/path-password/12.ts?token=private-token#private-fragment';
  await h.start(url);
  assert.equal(h.hls[0].url, url.replace('/12.ts', '/12.m3u8'));
  h.hls[0].emit('FRAG_LOADED', 'FRAG_LOADED', { frag: { sn: 1, stats: { loaded: 1024 }, url } });
  h.hls[0].emit('ERROR', 'ERROR', { fatal: false, type: 'networkError', details: 'segment', reason: 'HTTP source: ' + url + ' alternate http://another-user:another-pass@backup.invalid/private-segment?auth=private-auth' });
  for (const output of [h.stage.querySelector('.iptv-diag').textContent, h.consoleLines.join('\n')]) {
    for (const secret of ['demo-user', 'demo-password', 'path-user', 'path-password', 'private-token', 'private-fragment', 'another-user', 'another-pass', 'private-segment', 'private-auth']) {
      assert.equal(output.includes(secret), false, 'diagnostic must omit ' + secret);
    }
    assert.match(output, /https:\/\/streams\.invalid:8443\/\[caminho omitido\]/);
    assert.match(output, /http:\/\/backup\.invalid\/\[caminho omitido\]/);
  }
});

test('decode failure explains unavailable transcoding without a Windows-only runtime path', async () => {
  const h = playerHarness(); const video = await h.start(); exhaustHlsRecovery(h.hls[0]);
  video.presentFrame(); video.error = { code: 3, message: 'PIPELINE_ERROR_DECODE' }; video.emit('error');
  const message = h.stage.querySelector('.iptv-now').textContent;
  assert.match(message, /descodifica|incompatível/i); assert.match(message, /FFmpeg/); assert.match(message, /transcodifica/i);
  assert.doesNotMatch(h.stage.querySelector('.iptv-diag').textContent, /ffmpeg\.exe|vendor\/ffmpeg/);
});
