'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yauzl = require('yauzl');
const { zipTree, inspectTemplate, layouts } = require('../scripts/template-archive');
const { builderOnlyDependencies, windowsIconDependencies } = require('../build-configs/viewer-files.cjs');

function readZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = new Map();
      zip.on('error', reject);
      zip.on('entry', entry => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const data = [];
          stream.on('error', reject);
          stream.on('data', buffer => data.push(buffer));
          stream.on('end', () => { entries.set(entry.fileName, { data: Buffer.concat(data), mode: entry.externalFileAttributes >>> 16, compression: entry.compressionMethod }); zip.readEntry(); });
        });
      });
      zip.on('end', () => resolve(entries));
      zip.readEntry();
    });
  });
}

test('Viewer pruning preserves the entire production ZIP dependency graph', () => {
  const lock = require('../package-lock.json').packages;
  const removed = new Set(builderOnlyDependencies);
  function inspect(name, relative = 'node_modules/' + name) {
    assert.ok(lock[relative], 'Required dependency missing from lock: ' + relative);
    assert.ok(!removed.has(name), 'Required Viewer dependency would be pruned: ' + name);
    for (const child of Object.keys(lock[relative].dependencies || {})) {
      const nested = relative + '/node_modules/' + child;
      inspect(child, lock[nested] ? nested : 'node_modules/' + child);
    }
  }
  inspect('yauzl'); inspect('yazl');
  assert.ok(!windowsIconDependencies.includes('png-to-ico'));
  assert.ok(!windowsIconDependencies.includes('pngjs'));
});

test('Lossless template ZIP keeps app bytes, companion executable modes and internal symlinks', { skip: process.platform === 'win32' ? 'POSIX Mac bundle permissions/symlinks are checked on the native Mac runner.' : false }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-size-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = path.join(directory, 'LaunchBox Viewer.app');
  const companion = path.join(directory, layouts['mac-universal'].companion);
  const original = Buffer.alloc(128 * 1024, 7);
  for (const file of layouts['mac-universal'].required) {
    const destination = path.join(directory, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.endsWith('app-mode.json') ? '{"mode":"viewer"}' : file.endsWith('app.asar') ? original : 'SIGNED BYTES');
    if (file.includes('/MacOS/')) fs.chmodSync(destination, 0o755);
  }
  fs.symlinkSync('Info.plist', path.join(app, 'Contents/Info-link'));
  fs.mkdirSync(path.join(companion, 'ffmpeg'), { recursive: true });
  fs.writeFileSync(path.join(companion, 'ffmpeg/ffmpeg'), 'NATIVE EXECUTABLE');
  fs.chmodSync(path.join(companion, 'ffmpeg/ffmpeg'), 0o755);
  const archive = path.join(directory, 'template.zip');
  await zipTree(app, archive, { companions: [companion] });
  const inspection = await inspectTemplate(archive, 'mac-universal');
  assert.equal(inspection.runtimeLayout, 'external-data-v1');
  assert.deepEqual(inspection.companionRuntimes, ['ffmpeg']);
  const entries = await readZip(archive);
  assert.deepEqual(entries.get('LaunchBox Viewer.app/Contents/Resources/app.asar').data, original);
  assert.equal(entries.get('LaunchBox Viewer.app/Contents/Resources/app.asar').compression, 8);
  assert.equal(entries.get('LaunchBox Viewer.app/Contents/Info-link').data.toString(), 'Info.plist');
  assert.equal(entries.get('LaunchBox Viewer.app/Contents/Info-link').mode & 0o170000, 0o120000);
  assert.equal(entries.get('LaunchBox Viewer.data/ffmpeg/ffmpeg').mode & 0o111, 0o111);
});

test('Template companion compression refuses colliding roots and escaping links', { skip: process.platform === 'win32' ? 'POSIX symlink fixture is checked on the native Mac runner.' : false }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-size-unsafe-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = path.join(directory, 'App');
  fs.mkdirSync(app);
  assert.throws(() => zipTree(app, path.join(directory, 'collision.zip'), { companions: [app] }), /Duplicate template root/);
  assert.throws(() => zipTree(app, path.join(directory, 'rootless.zip'), { includeRoot: false, companions: [path.join(directory, 'Data')] }), /explicit archive roots/);
  fs.symlinkSync('../outside', path.join(app, 'escape'));
  await assert.rejects(zipTree(app, path.join(directory, 'escape.zip')), /escapes the template tree/);
});
