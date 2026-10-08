'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { preparePayload, verifyPayload, reportNames, sha256 } = require('../scripts/release-payload');
const { verifyUploadedAssets, verifyReleaseTag } = require('../scripts/publish-tested-release');
const context = { repository: 'example/private-builder', testedSourceSha: 'a'.repeat(40), sourceSha: 'b'.repeat(40), runId: '12345', runAttempt: '1' };

function fixture(t, platform) {
  const applicationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-release-proof-'));
  t.after(() => fs.rmSync(applicationRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(applicationRoot, 'package.json'), '{"version":"2.5.0"}');
  fs.mkdirSync(path.join(applicationRoot, 'dist/builder'), { recursive: true });
  const installerName = 'Windows-Mac-Software-Builder-2.5.0-' + (platform === 'Windows' ? 'windows-x64-setup.exe' : 'mac-universal.dmg');
  const installer = Buffer.alloc(2 * 1048576, 8);
  installer.write(platform === 'Windows' ? 'MZ' : 'koly', platform === 'Windows' ? 0 : installer.length - 512, 'ascii');
  fs.writeFileSync(path.join(applicationRoot, 'dist/builder', installerName), installer);
  const hash = crypto.createHash('sha256').update(installer).digest('hex');
  fs.writeFileSync(path.join(applicationRoot, 'dist/builder/SHA256SUMS.txt'), hash + '  ' + installerName + '\n');
  const hostPlatform = platform === 'Windows' ? 'win32' : 'darwin';
  for (const name of reportNames) fs.writeFileSync(path.join(applicationRoot, name), JSON.stringify({ status: 'passed', platform: hostPlatform, ...(name.includes('iptv') ? { version: '2.5.0' } : { appVersion: '2.5.0' }), checks: ['native execution and playback verified'] }));
  fs.writeFileSync(path.join(applicationRoot, 'dist/package-size-report.json'), JSON.stringify({ version: '2.5.0', items: [{ path: 'dist/builder/' + installerName, bytes: installer.length }] }));
  return { applicationRoot, installerName, hostPlatform, context, checkoutSha: context.testedSourceSha };
}

for (const platform of ['Windows', 'macOS']) test('Native release payload survives cross-platform restore with exact proofs: ' + platform, async t => {
  const f = fixture(t, platform);
  const proof = await preparePayload(platform, f);
  assert.equal(proof.apkExecutionAvailable, false);
  assert.equal(proof.testedSourceSha, context.testedSourceSha);
  assert.equal(proof.sourceSha, context.sourceSha);
  const restored = await verifyPayload(path.join(f.applicationRoot, 'dist/release', platform), platform, context, '2.5.0');
  assert.deepEqual(restored, proof);
});

test('Release payload preparation refuses stale or failed checks, wrong checkout and changed installer', async t => {
  for (const failure of ['failed-report', 'stale-report', 'wrong-checkout', 'changed-installer', 'wrong-size']) {
    const f = fixture(t, 'Windows');
    if (failure === 'failed-report' || failure === 'stale-report') fs.writeFileSync(path.join(f.applicationRoot, reportNames[0]), JSON.stringify({ status: failure === 'failed-report' ? 'failed' : 'passed', platform: 'win32', appVersion: '2.1.1', checks: ['old'] }));
    if (failure === 'wrong-checkout') f.checkoutSha = 'c'.repeat(40);
    if (failure === 'changed-installer') fs.appendFileSync(path.join(f.applicationRoot, 'dist/builder', f.installerName), 'changed');
    if (failure === 'wrong-size') fs.writeFileSync(path.join(f.applicationRoot, 'dist/package-size-report.json'), JSON.stringify({ version: '2.5.0', items: [] }));
    await assert.rejects(preparePayload('Windows', f));
    assert.ok(!fs.existsSync(path.join(f.applicationRoot, 'dist/release/Windows')));
  }
});

test('Cached release payload rejects another workflow, altered bytes and unexpected files', async t => {
  for (const failure of ['run', 'attempt', 'sha', 'bytes', 'extra', 'traversal']) {
    const f = fixture(t, 'Windows'); await preparePayload('Windows', f);
    const directory = path.join(f.applicationRoot, 'dist/release/Windows');
    const expectedContext = { ...context };
    if (failure === 'run') expectedContext.runId = '12346';
    if (failure === 'attempt') expectedContext.runAttempt = '2';
    if (failure === 'sha') expectedContext.testedSourceSha = 'c'.repeat(40);
    if (failure === 'bytes') fs.appendFileSync(path.join(directory, f.installerName), 'tampered');
    if (failure === 'extra') fs.writeFileSync(path.join(directory, 'unrequested.txt'), 'extra');
    if (failure === 'traversal') { const proof = JSON.parse(fs.readFileSync(path.join(directory, 'build-proof.json'))); proof.files[0].name = '../outside'; fs.writeFileSync(path.join(directory, 'build-proof.json'), JSON.stringify(proof)); }
    await assert.rejects(verifyPayload(directory, 'Windows', expectedContext, '2.5.0'));
  }
});

test('Published asset and tag validation rejects size/digest changes and a concurrent different tag', () => {
  const expected = [{ name: 'installer.exe', size: 123, sha256: 'a'.repeat(64) }];
  const good = [{ name: 'installer.exe', state: 'uploaded', size: 123, digest: 'sha256:' + expected[0].sha256 }];
  verifyUploadedAssets(good, expected);
  assert.throws(() => verifyUploadedAssets([{ ...good[0], size: 124 }], expected), /digest\/size/);
  assert.throws(() => verifyUploadedAssets([{ ...good[0], digest: 'sha256:' + 'b'.repeat(64) }], expected), /digest\/size/);
  assert.throws(() => verifyUploadedAssets([], expected), /missing/);
  verifyReleaseTag({ object: { type: 'commit', sha: context.sourceSha } }, context.sourceSha);
  assert.throws(() => verifyReleaseTag({ object: { type: 'commit', sha: 'c'.repeat(40) } }, context.sourceSha), /exact tested source/);
  assert.throws(() => verifyReleaseTag({ object: { type: 'tag', sha: context.sourceSha } }, context.sourceSha), /exact tested source/);
});

function publicationHarness({ differentTree = false, existingRelease = false, wrongConcurrentTag = false, corruptAsset = false } = {}) {
  const mutations = [];
  let draft;
  let assets = [];
  let tagCreated = false;
  function absent() { const error = new Error('Not Found'); error.stderr = 'gh: Not Found (HTTP 404)'; throw error; }
  function execFileSync(command, args) {
    assert.equal(command, 'gh');
    if (args[0] === 'api') {
      const endpoint = args[1];
      if (endpoint.endsWith('/git/refs') && args.includes('POST')) {
        mutations.push('tag-create');
        if (wrongConcurrentTag) throw new Error('Reference already exists (HTTP 422).');
        assert.ok(args.includes('sha=' + context.sourceSha));
        tagCreated = true;
        return JSON.stringify({ object: { type: 'commit', sha: context.sourceSha } });
      }
      if (endpoint.endsWith('/releases') && args.includes('POST')) {
        mutations.push('draft-create');
        const body = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf8'));
        assert.equal(body.draft, true); assert.equal(body.prerelease, true);
        draft = { id: 20, draft: true, prerelease: true, tag_name: 'v2.5.0', target_commitish: context.sourceSha, html_url: 'https://example.test/release', assets };
        return JSON.stringify(draft);
      }
      if (endpoint.includes('/git/commits/')) return JSON.stringify({ tree: { sha: differentTree && endpoint.endsWith(context.sourceSha) ? 'e'.repeat(40) : 'd'.repeat(40) } });
      if (endpoint.includes('/releases?')) return JSON.stringify([existingRelease ? [{ id: 11, tag_name: 'v2.5.0', draft: true }] : []]);
      if (endpoint.includes('/releases/tags/')) absent(); // Drafts never resolve here.
      if (endpoint.endsWith('/releases/20')) return JSON.stringify({ ...draft, assets });
      if (endpoint.includes('/git/ref/tags/')) { if (!tagCreated) absent(); return JSON.stringify({ object: { type: 'commit', sha: context.sourceSha } }); }
      if (endpoint.includes('/assets?')) return JSON.stringify(corruptAsset ? assets.map((asset, index) => index ? asset : { ...asset, digest: 'sha256:' + 'e'.repeat(64) }) : assets);
      throw new Error('Unexpected API request: ' + endpoint);
    }
    mutations.push(args[1]);
    if (args[1] === 'upload') {
      assert.ok(tagCreated); assert.ok(draft && draft.draft); assert.ok(!args.includes('--clobber'));
      const files = args.slice(3, args.indexOf('--repo'));
      assets = files.map(file => { const data = fs.readFileSync(file); return { name: path.basename(file), state: 'uploaded', size: data.length, digest: 'sha256:' + crypto.createHash('sha256').update(data).digest('hex'), browser_download_url: 'https://example.test/' + path.basename(file) }; });
    } else if (args[1] === 'edit') draft.draft = false;
    else throw new Error('Unexpected mutation: ' + args[1]);
    return '';
  }
  const file = path.resolve(__dirname, '../scripts/publish-tested-release.js');
  const module = { exports: {} };
  const localRequire = request => request === 'node:child_process' ? { execFileSync } : require(request.startsWith('.') ? path.resolve(path.dirname(file), request) : request);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: localRequire, module, exports: module.exports, __dirname: path.dirname(file), process, console: { log() {}, error() {} } }, { filename: file });
  return { ...module.exports, mutations };
}

test('Release publication stays read-only for mismatching trees/existing releases and keeps bad uploads in draft', async t => {
  for (const scenario of [{ differentTree: true }, { existingRelease: true }, { wrongConcurrentTag: true }, { corruptAsset: true }, {}]) {
    const windows = fixture(t, 'Windows'); await preparePayload('Windows', windows);
    const mac = fixture(t, 'macOS'); await preparePayload('macOS', mac);
    fs.cpSync(path.join(mac.applicationRoot, 'dist/release/macOS'), path.join(windows.applicationRoot, 'dist/release/macOS'), { recursive: true });
    const h = publicationHarness(scenario);
    if (Object.keys(scenario).length) {
      await assert.rejects(h.publish({ applicationRoot: windows.applicationRoot, context }));
      assert.deepEqual(h.mutations, scenario.differentTree || scenario.existingRelease ? [] : scenario.wrongConcurrentTag ? ['tag-create'] : ['tag-create', 'draft-create', 'upload']);
    } else {
      await h.publish({ applicationRoot: windows.applicationRoot, context });
      assert.deepEqual(h.mutations, ['tag-create', 'draft-create', 'upload', 'edit']);
      const checksums = fs.readFileSync(path.join(windows.applicationRoot, 'dist/release/publish/SHA256SUMS.txt'), 'utf8');
      assert.equal(checksums.trim().split('\n').length, 2);
      assert.ok(fs.readFileSync(path.join(windows.applicationRoot, 'dist/release/release-notes.txt'), 'utf8').includes('APK execution is unavailable'));
    }
  }
});
