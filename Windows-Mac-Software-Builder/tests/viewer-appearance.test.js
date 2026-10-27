'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

test('reopening an existing preview refreshes its native appearance before reloading', () => {
  const events = [];
  const config = { brand: { title: 'Updated app', colors: { background: '#abcdef' } }, export: { iconPath: 'data/new.png' } };
  const window = {
    isDestroyed: () => false,
    setTitle: title => events.push(['title', title]),
    setBackgroundColor: color => events.push(['background', color]),
    webContents: { reload: () => events.push(['reload']) },
    focus: () => events.push(['focus'])
  };
  const ctx = vm.createContext({
    viewerWindow: window, readConfig: () => config, stopWebModules() {},
    projectIcons: { applyWindowIcon: options => events.push(['icon', options.config.export.iconPath, options.defaultIconPath, options.assetsDir]) },
    app: {}, nativeImage: {}, path, process, WRITE_BASE: '/builder-data', ASSETS_DIR: '/builder-data/projects/current/dist-assets', PROJECT_ROOT: '/builder', console
  });
  const functions = ['applyViewerAppearance', 'createViewerWindow'].map(name => source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, 'm'))?.[0]).filter(Boolean);
  vm.runInContext(functions.join('\n'), ctx);
  assert.equal(ctx.createViewerWindow(), window);
  assert.ok(events.some(e => e[0] === 'icon' && e[1] === 'data/new.png'), 'updated native icon must be applied');
  assert.equal(events.find(e => e[0] === 'icon')[3], '/builder-data/projects/current/dist-assets', 'preview must use the active project, rather than the Builder storage root');
  assert.ok(events.some(e => e[0] === 'background' && e[1] === '#abcdef'));
  assert.ok(events.findIndex(e => e[0] === 'icon') < events.findIndex(e => e[0] === 'reload'));
  events.length = 0;
  config.export.iconPath = null;
  ctx.createViewerWindow();
  assert.equal(events.find(e => e[0] === 'icon')[2], path.join('/builder', 'src/builder/app-icon.png'), 'removing the custom icon must supply the Builder default');
});
