'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

test('two Viewer saves can overlap and a failed replacement keeps the last saved file', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-data-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'course.json');
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = main.indexOf('function saveViewerData(');
  const end = main.indexOf("handleTrustedIpc('favs:save'", start);
  assert.ok(start >= 0 && end > start);
  const io = Object.create(fs);
  const save = vm.runInNewContext(main.slice(start, end) + '\nsaveViewerData', {
    fs: io, os, path, crypto, FAVS_DIR: directory
  });
  let overlapping = true;
  io.renameSync = (from, to) => {
    if (overlapping) {
      overlapping = false;
      save(file, { lastModuleId: 'second' });
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { lastModuleId: 'second' });
    }
    fs.renameSync(from, to);
  };
  save(file, { lastModuleId: 'first' });
  io.renameSync = () => { throw new Error('cannot replace'); };
  assert.throws(() => save(file, { lastModuleId: 'unsaved' }), /cannot replace/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { lastModuleId: 'first' });
  assert.deepEqual(fs.readdirSync(directory), ['course.json']);
});
