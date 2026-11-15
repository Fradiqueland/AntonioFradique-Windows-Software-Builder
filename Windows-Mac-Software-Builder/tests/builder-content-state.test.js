'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual renderer functions with deferred IPC. These tests run
// without Electron and model disk acknowledgements, rejected writes and races.
const renderer = fs.readFileSync(path.join(__dirname, '../src/builder/renderer.js'), 'utf8');
const mutations = renderer.slice(renderer.indexOf('async function persistContent('), renderer.indexOf('\nfunction askDeleteModule('));
const deletion = renderer.slice(renderer.indexOf('async function deleteModule('), renderer.indexOf('\n/* ---- Editor wiring ---- */'));
function setup(saveContent) {
  const state = {
    contentModules: [{ id: 'a', title: 'A', data: {} }, { id: 'b', title: 'B', data: {} }],
    contentMutation: null, projectTransition: null, projectGeneration: 1,
    settingsWrites: new Set(), exportInProgress: false, editingId: 'a',
    pendingFileSourcePath: '/draft/unsaved.pdf', renders: 0, hidden: 0, summaries: 0,
    console: { error() {} }, t: key => key,
    updateBuilderBusyUI() {}, updatePortableActions() {},
    renderContentList() { state.renders++; }, updateExportSummary() { state.summaries++; },
    showContentStatus(message) { state.status = message; },
    hideEditor() { state.hidden++; }, window: { icurator: { saveContent } }
  };
  vm.createContext(state);
  vm.runInContext(mutations + deletion, state);
  return state;
}
const ids = state => Array.from(state.contentModules, item => item.id);

test('rejected reorder leaves the saved list unchanged', async () => {
  const state = setup(async () => { throw new Error('disk full'); });
  await state.moveModule('b', -1);
  assert.deepEqual(ids(state), ['a', 'b']);
  assert.equal(state.contentMutation, null);
  assert.equal(state.summaries, 0);
  assert.match(state.status, /disk full/);
});

test('reorder waits for the saved response and preserves an unrelated file draft', async () => {
  let finish; let payload;
  const state = setup(value => { payload = value; return new Promise(resolve => { finish = resolve; }); });
  const pending = state.moveModule('b', -1);
  assert.deepEqual(ids(state), ['a', 'b']);
  finish({ content: payload.modules });
  await pending;
  assert.deepEqual(ids(state), ['b', 'a']);
  assert.equal(state.pendingFileSourcePath, '/draft/unsaved.pdf');
  assert.equal(state.summaries, 1);
});

test('only one content mutation is sent while a write is in flight', async () => {
  let calls = 0; let finish;
  const state = setup(payload => { calls++; return new Promise(resolve => { finish = () => resolve({ content: payload.modules }); }); });
  const first = state.moveModule('b', -1);
  await state.moveModule('a', 1);
  await state.deleteModule('a');
  assert.equal(calls, 1);
  finish();
  await first;
  assert.equal(state.contentMutation, null);
});

test('failed deletion preserves both the saved item and its open draft', async () => {
  const state = setup(async () => { throw new Error('read-only volume'); });
  await state.deleteModule('a');
  assert.deepEqual(ids(state), ['a', 'b']);
  assert.equal(state.editingId, 'a');
  assert.equal(state.hidden, 0);
  assert.equal(state.pendingFileSourcePath, '/draft/unsaved.pdf');
});

test('an old project response cannot replace the current project list', async () => {
  let finish;
  const state = setup(payload => new Promise(resolve => { finish = () => resolve({ content: payload.modules }); }));
  const pending = state.moveModule('b', -1);
  state.projectGeneration++;
  state.contentModules = [{ id: 'new-project', data: {} }];
  finish();
  await pending;
  assert.deepEqual(ids(state), ['new-project']);
  assert.equal(state.summaries, 0);
  assert.equal(state.contentMutation, null);
});

test('a previous status expiry cannot erase a newer save result', () => {
  let now = 0, sequence = 0;
  const timers = new Map();
  const context = vm.createContext({
    setTimeout(callback, delay) { const id=++sequence; timers.set(id,{callback,deadline:now+delay}); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  const code = renderer.slice(renderer.indexOf('function makeStatus('), renderer.indexOf('function setImagePreview('));
  vm.runInContext(code,context);
  const el={textContent:'',className:''};
  const show=context.makeStatus(el);
  function advance(ms) {
    now+=ms;
    for(const [id,timer] of [...timers]) if(timer.deadline<=now){timers.delete(id);timer.callback();}
  }
  show('Saved first change','success');
  advance(2000);
  show('Failed to save newest change','error');
  advance(1000);
  assert.equal(el.textContent,'Failed to save newest change');
  assert.equal(el.className,'save-status error');
  advance(2000);
  assert.equal(el.textContent,'');
  assert.equal(timers.size,0);
});
