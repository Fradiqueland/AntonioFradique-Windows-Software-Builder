'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { recipeFiles, verifyNativeCache } = require('../scripts/verify-native-ffmpeg-cache');

const root = path.resolve(__dirname, '..');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-cache-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projectRoot = path.join(directory, 'checkout');
  const runtime = path.join(directory, 'runtime');
  const archive = path.join(directory, 'runtime.tar.gz');
  function write(base, relative, bytes) {
    const filename = path.join(base, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
    return filename;
  }
  for (const file of recipeFiles) {
    const bytes = fs.readFileSync(path.join(root, file));
    write(projectRoot, file, bytes);
    write(runtime, 'sources/recipe/' + file, bytes);
  }
  function pack() {
    const result = spawnSync('tar', ['-czf', 'runtime.tar.gz', '-C', 'runtime', '.'], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  }
  pack();
  return { directory, projectRoot, runtime, archive, write, pack };
}

test('cache recipe list stays equal to the packaged recipe and workflow content key', () => {
  const packager = fs.readFileSync(path.join(root, 'scripts/package-ffmpeg-runtime.js'), 'utf8');
  const packagedList = packager.match(/for \(const file of \[([^\]]+)\]\) copy\(path\.join\(root, file\), 'sources\/recipe\//)?.[1];
  assert.ok(packagedList, 'Find the production recipe copy list');
  assert.deepEqual(Array.from(packagedList.matchAll(/'([^']+)'/g), match => match[1]), [...recipeFiles]);
  const workflow = fs.readFileSync(path.join(root, '../.github/workflows/build-v2-installers.yml'), 'utf8');
  const keyedList = workflow.match(/RECIPE_HASH:.*hashFiles\(([^)]+)\)/)?.[1];
  assert.ok(keyedList, 'Find the workflow recipe hash inputs');
  assert.deepEqual(Array.from(keyedList.matchAll(/'Windows-Mac-Software-Builder\/([^']+)'/g), match => match[1]), [...recipeFiles]);
});

test('real tar reuse requires byte-equal recipes and repeats the complete native gate', t => {
  const f = fixture(t);
  let extracted;
  let calls = 0;
  const result = verifyNativeCache('windows-x64', f.archive, {
    projectRoot: f.projectRoot,
    checker(directory, options) {
      extracted = directory;
      calls++;
      assert.deepEqual(options, { target: 'windows-x64', smoke: true, verifyBinaryHashes: true });
      for (const file of recipeFiles) assert.deepEqual(fs.readFileSync(path.join(directory, 'sources/recipe', file)), fs.readFileSync(path.join(f.projectRoot, file)));
    }
  });
  assert.deepEqual(result, { reusable: true, changedInputs: [] });
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(extracted), false, 'Disposable extraction is removed');
});

test('changing any of the six native recipe inputs forces a new build', t => {
  const f = fixture(t);
  let calls = 0;
  for (const file of recipeFiles) {
    const filename = path.join(f.projectRoot, file);
    const original = fs.readFileSync(filename);
    fs.appendFileSync(filename, '\nchanged native input\n');
    const result = verifyNativeCache('mac-arm64', f.archive, { projectRoot: f.projectRoot, checker() { calls++; } });
    assert.deepEqual(result, { reusable: false, changedInputs: [file] }, file);
    fs.writeFileSync(filename, original);
  }
  assert.equal(calls, 0, 'A different complete recipe is never reused');
});

test('missing recipe or malformed archive is corruption rather than a reusable miss', t => {
  const f = fixture(t);
  let calls = 0;
  const options = { projectRoot: f.projectRoot, checker() { calls++; } };
  fs.rmSync(path.join(f.runtime, 'sources/recipe', recipeFiles[0]));
  f.pack();
  assert.throws(() => verifyNativeCache('windows-x64', f.archive, options), /ENOENT/);
  fs.writeFileSync(f.archive, 'not a gzip tar archive');
  assert.throws(() => verifyNativeCache('windows-x64', f.archive, options), /tar failed/);
  assert.equal(calls, 0);
});

test('the real source checksum verifier rejects a corrupted cached source archive', t => {
  const f = fixture(t);
  const lock = require('../build-configs/ffmpeg-sources.json');
  f.write(f.runtime, 'runtime-manifest.json', JSON.stringify({
    schemaVersion: 1, target: 'windows-x64', sources: lock.sources,
    binaries: {}, build: { recipe: 'sources/recipe/scripts/build-ffmpeg.sh' }
  }));
  f.write(f.runtime, 'sources/' + lock.sources[0].file, 'corrupt corresponding source');
  f.pack();
  assert.throws(() => verifyNativeCache('windows-x64', f.archive, { projectRoot: f.projectRoot }), /source archive checksum mismatch/);
});

test('binary, license and native CPU gate failures propagate instead of recompiling silently', t => {
  const f = fixture(t);
  for (const failure of ['binary checksum mismatch', 'missing GPL version 2 license', 'native CPU H.264/AAC transcode failed']) {
    const error = new Error(failure);
    assert.throws(() => verifyNativeCache('mac-x64', f.archive, {
      projectRoot: f.projectRoot,
      checker(directory, options) {
        assert.equal(options.smoke, true);
        assert.equal(options.verifyBinaryHashes, true);
        throw error;
      }
    }), thrown => thrown === error);
  }
});

test('archive links are rejected before extraction', t => {
  const f = fixture(t);
  const file = f.write(f.runtime, 'physical-file', 'payload');
  fs.linkSync(file, path.join(f.runtime, 'hard-link'));
  f.pack();
  assert.throws(() => verifyNativeCache('windows-x64', f.archive, { projectRoot: f.projectRoot, checker() { assert.fail('Must not reach native checker'); } }), /only physical files and directories/);
});

test('an exact content key requires the current recipe even if a seed mismatch can rebuild', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.runtime, 'sources/recipe', recipeFiles[0]), '\nold recipe\n');
  f.pack();
  const script = path.join(root, 'scripts/verify-native-ffmpeg-cache.js');
  const output = path.join(f.directory, 'github-output');
  const result = spawnSync(process.execPath, [script, 'windows-x64', f.archive, '--require-current-recipe'], {
    encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /recipe differs from checkout/);
  assert.equal(fs.existsSync(output), false, 'Cannot report a reusable cache after failure');
});
