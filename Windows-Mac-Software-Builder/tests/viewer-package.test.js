'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const asar = require('@electron/asar');
const { normalizeAsarEntry, validateViewerDependencies } = require('../scripts/package-viewer-template');

const projectRoot = path.resolve(__dirname, '..');
const lock = require('../package-lock.json').packages;

function fixture(t) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-asar-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = path.join(directory, 'app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'viewer-package-fixture', version: require('../package.json').version }));
  const copied = new Set();
  function copyDependency(name, relative = 'node_modules/' + name) {
    if (copied.has(relative)) return;
    copied.add(relative);
    assert.ok(lock[relative], 'A real production dependency must exist in the lock: ' + relative);
    fs.cpSync(path.join(projectRoot, relative), path.join(app, relative), { recursive: true });
    for (const child of Object.keys(lock[relative].dependencies || {})) {
      const nested = relative + '/node_modules/' + child;
      copyDependency(child, lock[nested] ? nested : 'node_modules/' + child);
    }
  }
  copyDependency('yauzl');
  copyDependency('yazl');
  return { directory, app, archive: path.join(directory, 'app.asar') };
}

test('ASAR dependency paths use the same rootless form on Windows and POSIX', () => {
  for (const name of ['yauzl', 'yazl', 'png-to-ico', 'rcedit']) {
    const expected = 'node_modules/' + name + '/package.json';
    assert.equal(normalizeAsarEntry(path.win32.join('/', 'node_modules', name, 'package.json')), expected);
    assert.equal(normalizeAsarEntry(path.posix.join('/', 'node_modules', name, 'package.json')), expected);
    assert.equal(normalizeAsarEntry(expected), expected);
  }
});

test('Viewer checker accepts a real ASAR with working production ZIP dependencies', async t => {
  const f = fixture(t);
  await asar.createPackage(f.app, f.archive);
  assert.doesNotThrow(() => validateViewerDependencies(f.archive));
  for (const name of ['yauzl', 'yazl']) {
    const source = require.resolve(name);
    const entry = path.relative(projectRoot, source).split(path.sep).join('/');
    assert.deepEqual(asar.extractFile(f.archive, entry), fs.readFileSync(source));
  }
  const extracted = path.join(f.directory, 'extracted');
  asar.extractAll(f.archive, extracted);
  const load = createRequire(path.join(extracted, 'package.json'));
  for (const name of ['yauzl', 'yazl']) {
    assert.ok(load.resolve(name).startsWith(path.join(extracted, 'node_modules') + path.sep), 'The extracted dependency must resolve inside the packaged application: ' + name);
    assert.doesNotThrow(() => load(name));
    const dependencyLoad = createRequire(load.resolve(name));
    for (const child of Object.keys(lock['node_modules/' + name].dependencies || {})) {
      assert.ok(dependencyLoad.resolve(child).startsWith(path.join(extracted, 'node_modules') + path.sep), 'Transitive dependencies must resolve inside the packaged application: ' + child);
      assert.doesNotThrow(() => dependencyLoad(child));
    }
  }
  assert.equal(typeof load('yauzl').open, 'function');
  assert.equal(typeof load('yazl').ZipFile, 'function');
});

test('Viewer checker rejects either missing required ZIP package in a real ASAR', async t => {
  for (const name of ['yauzl', 'yazl']) {
    const f = fixture(t);
    fs.rmSync(path.join(f.app, 'node_modules', name), { recursive: true });
    await asar.createPackage(f.app, f.archive);
    assert.throws(() => validateViewerDependencies(f.archive), new RegExp('Viewer lost required ZIP dependency: ' + name));
  }
});

test('Viewer checker rejects a retained Builder-only dependency in a real ASAR', async t => {
  const f = fixture(t);
  const source = path.join(projectRoot, 'node_modules/rcedit/package.json');
  const destination = path.join(f.app, 'node_modules/rcedit/package.json');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  await asar.createPackage(f.app, f.archive);
  assert.throws(() => validateViewerDependencies(f.archive), /Viewer still contains a Builder-only dependency: rcedit/);
});
