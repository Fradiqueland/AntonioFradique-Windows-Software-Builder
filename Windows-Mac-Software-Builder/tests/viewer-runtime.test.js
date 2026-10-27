'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const renderer = fs.readFileSync(path.join(__dirname, '../src/viewer/renderer.js'), 'utf8');

// A small DOM/media double runs the production renderer without Electron or a
// network. Deferred IPC and controlled timers reproduce navigation races.
function harness(overrides = {}) {
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map();
      this.attributes = new Map(); this.dataset = {}; this.className = ''; this.value = '';
      this.style = { setProperty() {} }; this._text = ''; this.parentNode = null;
      this.paused = true; this.currentTime = 0; this.videoWidth = 0; this.videoHeight = 0;
      this.buffered = { length: 0 }; this.frames = new Map(); this.playCalls = 0;
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
        toggle: (name, force) => { const add = force === undefined ? !this.classList.contains(name) : !!force; this.classList[add ? 'add' : 'remove'](name); return add; }
      };
    }
    appendChild(child) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this._text = ''; this.append(...children); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(value) { this.replaceChildren(); this._text = String(value); }
    get innerHTML() { return this.textContent; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'class') this.className = String(value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
    addEventListener(name, handler, options) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push({ handler, once: !!(options && options.once) }); }
    removeEventListener(name, handler) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item.handler !== handler)); }
    async dispatch(name, data = {}) {
      const event = { target: this, preventDefault() {}, stopPropagation() {}, ...data };
      const pending = [];
      for (const item of [...(this.listeners.get(name) || [])]) {
        if (item.once) this.removeEventListener(name, item.handler);
        pending.push(item.handler(event));
      }
      await Promise.all(pending);
    }
    click() { return this.dispatch('click'); }
    focus() { document.activeElement = this; }
    contains(other) { return other === this || this.children.some(child => child.contains(other)); }
    matches(selector) {
      const attrs = [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];
      const plain = selector.replace(/\[[^\]]+\]/g, '');
      const tag = plain.match(/^[a-z]+/i);
      if (tag && this.tagName !== tag[0].toUpperCase()) return false;
      const classes = [...plain.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
      if (!classes.every(name => this.classList.contains(name))) return false;
      return attrs.every(([, key, value]) => {
        const actual = key.startsWith('data-') ? this.dataset[key.slice(5)] ?? this.getAttribute(key) : this.getAttribute(key);
        return value === undefined ? actual != null : actual === value;
      });
    }
    querySelectorAll(selector) {
      const selectors = selector.split(',').map(value => value.trim());
      const matches = node => selectors.some(value => {
        const parts = value.split(/\s+/); if (!node.matches(parts.pop())) return false;
        let parent = node.parentNode;
        while (parts.length) { const part = parts.pop(); while (parent && !parent.matches(part)) parent = parent.parentNode; if (!parent) return false; parent = parent.parentNode; }
        return true;
      });
      const all = [];
      for (const child of this.children) { if (matches(child)) all.push(child); all.push(...child.querySelectorAll(selector)); }
      return all;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    pause() { this.paused = true; }
    load() { this.currentTime = 0; }
    play() { this.playCalls++; this.paused = false; return Promise.resolve(); }
    requestVideoFrameCallback(callback) { const id = this.frames.size + 1; this.frames.set(id, callback); return id; }
    cancelVideoFrameCallback(id) { this.frames.delete(id); }
    getBoundingClientRect() { return { top: 30, bottom: 60, right: 200 }; }
  }
  const document = new Element('document'); document.documentElement = new Element('html');
  document.body = new Element('body'); document.appendChild(document.documentElement); document.documentElement.appendChild(document.body);
  document.title = 'Course'; document.createElement = tag => new Element(tag);
  const ids = new Map(); document.getElementById = id => {
    if (!ids.has(id)) { const element = new Element(id === 'viewer-lang' ? 'select' : 'div'); ids.set(id, element); document.body.appendChild(element); }
    return ids.get(id);
  };
  const timers = new Map(); let timerId = 0;
  const stopped = [], opened = [], hlsInstances = [];
  const viewer = {
    loadConfig: async () => ({ brand: {}, content: [], marketing: {} }),
    loadLocale: async lang => ({ lang, dict: {} }), loadState: async () => ({}), saveState: async () => {},
    loadFavs: async () => ({ folders: [] }), saveFavs: async () => {},
    resolveAssetPath: async value => '/assets/' + value,
    openExternal: async value => { opened.push(value); }, launchFile: async value => { opened.push(value); },
    iptvHosts: async () => {}, iptvHasFfmpeg: async () => false,
    iptvProxyStop: async token => { stopped.push(token); }, iptvProxyStatus: async () => ({}),
    ...overrides
  };
  class Hls {
    static isSupported() { return true; }
    static Events = Object.fromEntries(['ERROR', 'BUFFER_CODECS', 'LEVEL_LOADED', 'FRAG_LOADED', 'BUFFER_APPENDING', 'FRAG_BUFFERED', 'FRAG_PARSED', 'MANIFEST_PARSED'].map(key => [key, key]));
    static ErrorTypes = { MEDIA_ERROR: 'mediaError' };
    constructor() { this.handlers = new Map(); this.destroyed = false; hlsInstances.push(this); }
    on(name, handler) { this.handlers.set(name, handler); }
    loadSource(url) { this.url = url; }
    attachMedia(video) { this.video = video; }
    destroy() { this.destroyed = true; }
  }
  const window = new Element('window'); Object.assign(window, { viewer, Hls, innerWidth: 1200, innerHeight: 800 });
  const storage = new Map();
  const context = vm.createContext({ window, document, navigator: {}, URL, URLSearchParams, console: { log() {}, warn() {}, error() {} },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id), localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } });
  vm.runInContext(renderer.replace(/\nboot\(\);\s*$/, '\n'), context, { filename: 'renderer.js' });
  const run = expression => vm.runInContext(expression, context);
  return { run, context, window, document, viewer, timers, stopped, opened, hlsInstances, stage: ids.get('viewer-stage'), menu: ids.get('viewer-menu'),
    tick: async delay => { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); } await flush(); } };
}

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
const iptv = { channels: [{ name: 'One', url: 'https://stream.example/live.m3u8' }] };

test('each permitted banner closes independently without opening its link or saving project state', async () => {
  let writes = 0;
  const h = harness({ saveState: async () => { writes++; } });
  const banners = { top: { enabled: true, dismissible: true, image: 'top.gif', url: 'https://example.org' },
    bottom: { enabled: true, dismissible: true, image: 'bottom.gif' } };
  h.context.banners = banners;
  await h.run('renderBanner(banners)');
  const top = h.document.getElementById('banner-top'), bottom = h.document.getElementById('banner-bottom');
  assert.match(top.querySelector('img').src, /top\.gif$/);
  assert.equal(top.querySelector('.banner-close').getAttribute('aria-label'), 'Fechar banner de topo');
  await top.querySelector('.banner-close').click();
  assert.equal(top.classList.contains('hidden'), true);
  assert.equal(h.document.body.classList.contains('banner-top'), false);
  assert.equal(h.document.body.classList.contains('banner-bottom'), true);
  assert.equal(bottom.classList.contains('hidden'), false);
  assert.equal(h.document.activeElement, h.stage);
  assert.equal(top.children.length, 0);
  await bottom.querySelector('.banner-close').click();
  assert.equal(h.document.body.classList.contains('banner-bottom'), false);
  assert.deepEqual(h.opened, []);
  assert.equal(writes, 0);
  // A fresh Viewer render displays configured banners again.
  await h.run('renderBanner(banners)');
  assert.equal(top.classList.contains('hidden'), false);
  assert.equal(bottom.classList.contains('hidden'), false);
});

test('legacy, disabled and non-dismissible banners do not gain a close button', async () => {
  const h = harness();
  h.context.banners = { top: { enabled: true, image: 'legacy.png', url: 'https://example.org' },
    bottom: { enabled: false, dismissible: true, image: 'off.gif' } };
  await h.run('renderBanner(banners)');
  const top = h.document.getElementById('banner-top'), bottom = h.document.getElementById('banner-bottom');
  assert.equal(top.querySelector('.banner-close'), null);
  assert.equal(bottom.classList.contains('hidden'), true);
  assert.equal(h.document.body.classList.contains('banner-bottom'), false);
  await top.querySelector('a').click();
  assert.deepEqual(h.opened, ['https://example.org']);
});

test('leaving IPTV before host registration finishes cannot create a hidden player', async () => {
  const hosts = deferred(); const h = harness({ iptvHosts: () => hosts.promise });
  h.context.iptv = iptv; await h.run("renderIptv(iptv, 'tv')");
  await h.stage.querySelector('.iptv-item-btn').click(); h.run("renderArticle({text:'Current module'})");
  hosts.resolve(); await flush();
  assert.equal(h.hlsInstances.length, 0);
  assert.match(h.stage.textContent, /Current module/);
});

test('leaving IPTV releases watchdogs, frame callbacks and stale proxy responses', async () => {
  const proxy = deferred(); const h = harness({ iptvHasFfmpeg: async () => true, iptvProxyUrl: () => proxy.promise });
  await h.run("renderIptv({channels:[{name:'Proxy',url:'https://stream.example/live.ts'}]}, 'tv')");
  await h.stage.querySelector('.iptv-item-btn').click(); await flush();
  const video = h.stage.querySelector('video'); h.run("renderArticle({text:'Next'})");
  proxy.resolve({ token: 'late-proxy', url: 'http://127.0.0.1:1234/stream' }); await flush();
  assert.deepEqual(h.stopped, ['late-proxy']);
  assert.equal(video.playCalls, 0); assert.equal(video.frames.size, 0);
  assert.equal([...h.timers.values()].filter(timer => timer.delay >= 15000).length, 0);
});

test('an abandoned IPTV watchdog cannot destroy the player in the next module', async () => {
  const h = harness(); h.context.iptv = iptv;
  await h.run("renderIptv(iptv, 'old')"); await h.stage.querySelector('.iptv-item-btn').click(); await flush();
  const oldTimers = [...h.timers.values()].filter(timer => timer.delay === 15000);
  await h.run("renderIptv(iptv, 'new')"); await h.stage.querySelector('.iptv-item-btn').click(); await flush();
  const active = h.hlsInstances.at(-1);
  oldTimers.forEach(timer => timer.callback()); await flush();
  assert.equal(active.destroyed, false);
});

test('the latest language choice wins even when locale responses arrive backwards', async () => {
  const fr = deferred(), ar = deferred(); const h = harness({ loadLocale: lang => lang === 'fr' ? fr.promise : ar.promise });
  const first = h.run("setLanguage('fr')"), last = h.run("setLanguage('ar')");
  ar.resolve({ lang: 'ar', dict: {} }); await last;
  fr.resolve({ lang: 'fr', dict: {} }); await first;
  assert.equal(h.document.documentElement.getAttribute('lang'), 'ar');
  assert.equal(h.document.documentElement.getAttribute('dir'), 'rtl');
});

test('language changes preserve an action password gate and never execute that action', async () => {
  const h = harness();
  await h.run("handleModuleClick({id:'article',type:'article-reader',data:{text:'Previous'}}, null)");
  await h.run("handleModuleClick({id:'link',type:'external',password:'secret',data:{url:'https://example.com'}}, null)");
  await h.run("setLanguage('en')");
  assert.ok(h.stage.querySelector('.pw-gate'));
  assert.deepEqual(h.opened, []);
});

test('submitting an action password twice opens it once and language changes cannot reopen it', async () => {
  const opened = []; const pending = deferred(); const h = harness({ openExternal: url => { opened.push(url); return pending.promise; } });
  await h.run("handleModuleClick({id:'link',type:'external',password:'secret',data:{url:'https://example.com'}}, null)");
  const form = h.stage.querySelector('form'); h.stage.querySelector('input').value = 'secret';
  const first = form.dispatch('submit'), second = form.dispatch('submit');
  assert.equal(opened.length, 1); pending.resolve(); await Promise.all([first, second]);
  await h.run("setLanguage('en')");
  assert.equal(opened.length, 1); assert.equal(h.stage.querySelector('.pw-gate'), null);
});

test('missing local files show an error without an unhandled module rejection', async () => {
  const h = harness({ resolveAssetPath: async () => { throw new Error('Missing asset'); } });
  await h.run("handleModuleClick({id:'pdf',type:'pdf',data:{file:'missing.pdf'}}, null)");
  assert.match(h.stage.textContent, /Missing asset/);
  assert.ok(h.stage.querySelector('[role="alert"]'));
});

test('a missing logo or banner cannot prevent the menu and language selector from starting', async () => {
  const h = harness({ loadConfig: async () => ({ language: 'en', brand: { title: 'Course', logo: 'missing.png' }, content: [{ id: 'one', title: 'Article', type: 'article-reader', data: {} }], marketing: { banners: { top: { enabled: true, image: 'missing-banner.png' } } } }), resolveAssetPath: async () => { throw new Error('Missing asset'); } });
  await h.run('boot()');
  assert.equal(h.menu.querySelectorAll('.viewer-menu-btn').length, 1);
  assert.equal(h.document.getElementById('viewer-lang').value, 'en');
});

test('stage cleanup closes the gallery overlay and stops native audio/video', () => {
  const h = harness(); const video = h.document.createElement('video'); video.src = 'file:///old.mp4'; video.paused = false; h.stage.appendChild(video);
  h.run("openLightbox('file:///image.png','Image','image.png')");
  h.run('clearStage()');
  assert.equal(h.document.querySelector('.lightbox-overlay'), null);
  assert.equal((h.document.listeners.get('keydown') || []).length, 0);
  assert.equal(video.paused, true); assert.equal(video.src, '');
});

test('an unsupported APK project shows a safe notice without launching or resolving its file', async () => {
  let files = 0, launches = 0;
  const h = harness({
    resolveAssetPath: async () => { files++; return '/untrusted.apk'; },
    launchFile: async () => { launches++; },
    openExternal: async () => { launches++; }
  });
  await h.run("handleModuleClick({id:'old',type:'article-reader',data:{text:'Old stage'}}, null)");
  await h.run("handleModuleClick({id:'apk',title:'<img src=x onerror=alert(1)>',type:'apk',data:{file:'untrusted.apk'}}, null)");
  assert.equal(files, 0); assert.equal(launches, 0);
  assert.ok(h.stage.querySelector('[role="alert"]'));
  assert.match(h.stage.textContent, /APK execution is unavailable/);
  assert.doesNotMatch(h.stage.textContent, /Old stage|onerror/);
});

test('APK unavailability notices follow the selected language without launching an application', async () => {
  const h = harness({ loadLocale: async lang => ({ lang, dict: { android: { viewer_title: 'APK indisponível', viewer_unavailable: 'O motor Android não está incluído.' } } }) });
  await h.run("handleModuleClick({id:'apk',type:'apk',data:{}}, null)");
  await h.run("setLanguage('pt')");
  assert.match(h.stage.textContent, /APK indisponível/);
  assert.match(h.stage.textContent, /O motor Android não está incluído/);
  assert.deepEqual(h.opened, []);
});

test('malformed saved favourite entries cannot crash the IPTV channel list', async () => {
  const h = harness({ loadFavs: async () => ({ folders: [null, { id: 'bad', name: 'Bad', keys: null }, { id: 'good', name: 'Good', keys: [null, 'https://stream.example/live.m3u8'] }] }) });
  h.context.iptv = iptv; await h.run("renderIptv(iptv, 'tv')");
  assert.equal(h.stage.querySelectorAll('.iptv-item-btn').length, 1);
  await h.stage.querySelectorAll('.iptv-tab')[1].click();
  assert.match(h.stage.textContent, /Good/);
});


test('archive downloads explain password handling and save only after a click, including retry and cancellation', async () => {
  const calls = []; let fail = true;
  const h = harness({saveFileAs: async payload => {
    calls.push({...payload}); if (fail) throw new Error('disk full'); return {cancelled:true};
  }});
  h.run("renderDownloadVault({file:'dist-assets/protected.zip',fileName:'protected.zip',buttonLabel:'Obter arquivo'}, true)");
  assert.match(h.stage.textContent, /palavra-passe original/);
  assert.equal(calls.length, 0);
  const button = h.stage.querySelector('.dl-btn');
  assert.equal(button.textContent, 'Obter arquivo');
  await button.click();
  assert.equal(button.disabled, false);
  fail = false;
  await button.click();
  assert.equal(button.disabled, false);
  assert.deepEqual(calls, [
    {file:'dist-assets/protected.zip',fileName:'protected.zip'},
    {file:'dist-assets/protected.zip',fileName:'protected.zip'}
  ]);
  assert.deepEqual(h.opened, [], 'Downloading must never launch or extract the archive');
});
