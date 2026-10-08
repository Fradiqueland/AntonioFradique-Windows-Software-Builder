'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const renderer = fs.readFileSync(path.join(__dirname, '../src/builder/renderer.js'), 'utf8');
const information = renderer.slice(renderer.indexOf('const androidInfoPanel ='), renderer.indexOf('\nfunction renderTypeCards()'));

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function harness(status) {
  const ids = new Map();
  for (const id of ['android-info-panel', 'android-info-status', 'android-import-btn', 'android-info-close']) {
    const classes = new Set(id === 'android-info-panel' ? ['hidden'] : []);
    ids.set(id, {
      disabled: id === 'android-import-btn', textContent: '', attributes: {},
      classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
      setAttribute(name, value) { this.attributes[name] = value; }, addEventListener() {}
    });
  }
  let calls = 0;
  const context = vm.createContext({
    document: { getElementById: id => ids.get(id) }, typeCardsEl: null,
    t: key => key, moduleType: { value: 'portable' }, moduleTitle: { value: 'Unsaved draft' },
    window: { icurator: status === undefined ? {} : { getAndroidRuntimeStatus: () => { calls++; return status(); } } }
  });
  vm.runInContext(information, context);
  return { run: expression => vm.runInContext(expression, context), ids, context, calls: () => calls };
}

test('Android status is queried only when requested and cannot modify an existing draft', async () => {
  const h = harness(async () => ({ available: false }));
  assert.equal(h.calls(), 0);
  assert.equal(h.ids.get('android-info-panel').classList.contains('hidden'), true);
  await h.run('showAndroidInformation()');
  assert.equal(h.calls(), 1);
  assert.equal(h.ids.get('android-info-panel').classList.contains('hidden'), false);
  assert.equal(h.ids.get('android-import-btn').disabled, true);
  assert.equal(h.ids.get('android-info-status').textContent, 'android.unavailable');
  assert.equal(h.context.moduleType.value, 'portable');
  assert.equal(h.context.moduleTitle.value, 'Unsaved draft');
});

test('an optimistic runtime response cannot enable APK import without an execution adapter', async () => {
  const h = harness(async () => ({ available: true }));
  await h.run('showAndroidInformation()');
  assert.equal(h.ids.get('android-import-btn').disabled, true);
  assert.equal(h.ids.get('android-info-status').textContent, 'android.adapter_unavailable');
});

test('a missing or failed runtime API leaves APK import unavailable', async () => {
  for (const status of [undefined, async () => { throw new Error('sensitive internal path'); }]) {
    const h = harness(status);
    await h.run('showAndroidInformation()');
    assert.equal(h.ids.get('android-import-btn').disabled, true);
    assert.equal(h.ids.get('android-info-status').textContent, 'android.unavailable');
  }
});

test('closing information invalidates a late runtime response', async () => {
  const pending = deferred(); const h = harness(() => pending.promise);
  const show = h.run('showAndroidInformation()');
  h.run('hideAndroidInformation()');
  pending.resolve({ available: true }); await show;
  assert.equal(h.ids.get('android-info-panel').classList.contains('hidden'), true);
  assert.equal(h.ids.get('android-info-status').textContent, 'android.unavailable');
});

test('a stale availability response cannot replace the current Android information', async () => {
  const first = deferred(), second = deferred(); let calls = 0;
  const h = harness(() => ++calls === 1 ? first.promise : second.promise);
  const old = h.run('showAndroidInformation()'), latest = h.run('showAndroidInformation()');
  second.resolve({ available: false }); await latest;
  first.resolve({ available: true }); await old;
  assert.equal(h.ids.get('android-info-status').textContent, 'android.unavailable');
  assert.equal(h.ids.get('android-import-btn').disabled, true);
});
