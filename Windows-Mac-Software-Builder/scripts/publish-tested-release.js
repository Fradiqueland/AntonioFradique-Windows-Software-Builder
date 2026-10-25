#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checkedContext, verifyPayload, sha256 } = require('./release-payload');
const root = path.resolve(__dirname, '..');

function gh(args) { return execFileSync('gh', args, { encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }); }
function api(endpoint) { return JSON.parse(gh(['api', endpoint, '-H', 'X-GitHub-Api-Version: 2026-03-10'])); }
function requireAbsent(endpoint, label) {
  try { api(endpoint); }
  catch (error) {
    if (/HTTP 404/.test(String(error.stderr || error.message))) return;
    throw error;
  }
  throw new Error('Refusing to overwrite an existing ' + label + '.');
}

function requireReleaseAbsent(prefix, tag) {
  // REST's by-tag lookup omits pending draft releases. The authenticated
  // collection includes them; paginate before proving this tag is unused.
  const pages = JSON.parse(gh(['api', prefix + '/releases?per_page=100', '--paginate', '--slurp', '-H', 'X-GitHub-Api-Version: 2026-03-10']));
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error('Could not verify existing release collection.');
  if (pages.flat().some(release => release.tag_name === tag)) throw new Error('Refusing to overwrite an existing ' + tag + ' draft or published release.');
}

function verifyUploadedAssets(assets, expected) {
  if (!Array.isArray(assets) || assets.length !== expected.length) throw new Error('Release upload has missing or unexpected assets; draft remains unpublished.');
  for (const item of expected) {
    const matches = assets.filter(asset => asset.name === item.name);
    if (matches.length !== 1 || matches[0].state !== 'uploaded' || matches[0].size !== item.size || matches[0].digest !== 'sha256:' + item.sha256) throw new Error('Release upload digest/size differs from native proof: ' + item.name + '; draft remains unpublished.');
  }
}

function verifyReleaseTag(reference, sourceSha) {
  if (reference?.object?.type !== 'commit' || reference.object.sha !== sourceSha) throw new Error('Release tag does not point to the exact tested source commit; draft remains unpublished.');
}

async function publish({ applicationRoot = root, context = checkedContext() } = {}) {
  const version = require(path.join(applicationRoot, 'package.json')).version;
  const tag = 'v' + version;
  if (!/^v2\.\d+\.\d+$/.test(tag)) throw new Error('Release version must be an explicit v2 semantic version.');
  const payloadRoot = path.join(applicationRoot, 'dist/release');
  const proofs = [];
  for (const platform of ['Windows', 'macOS']) proofs.push(await verifyPayload(path.join(payloadRoot, platform), platform, context, version));
  const prefix = 'repos/' + context.repository;
  const tested = api(prefix + '/git/commits/' + context.testedSourceSha);
  const source = api(prefix + '/git/commits/' + context.sourceSha);
  if (!tested.tree?.sha || tested.tree.sha !== source.tree?.sha) throw new Error('The release source tree differs from the exact tree tested by both native Builders.');
  requireReleaseAbsent(prefix, tag);
  requireAbsent(prefix + '/git/ref/tags/' + tag, tag + ' tag');
  const staging = path.join(payloadRoot, 'publish');
  if (fs.existsSync(staging)) throw new Error('Refusing to overwrite an existing release staging directory.');
  fs.mkdirSync(staging);
  const assets = [];
  const checksums = [];
  for (const proof of proofs) {
    const directory = path.join(payloadRoot, proof.platform);
    for (const file of proof.files) {
      if (file.name === 'SHA256SUMS.txt') continue;
      const name = /\.(?:exe|dmg)$/.test(file.name) ? file.name : proof.platform + '-' + file.name;
      fs.copyFileSync(path.join(directory, file.name), path.join(staging, name));
      assets.push({ name, size: file.size, sha256: file.sha256 });
      if (/\.(?:exe|dmg)$/.test(name)) checksums.push(file.sha256 + '  ' + name);
    }
    const proofName = proof.platform + '-build-proof.json';
    fs.copyFileSync(path.join(directory, 'build-proof.json'), path.join(staging, proofName));
    assets.push({ name: proofName, size: fs.statSync(path.join(staging, proofName)).size, sha256: await sha256(path.join(staging, proofName)) });
  }
  fs.writeFileSync(path.join(staging, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
  assets.push({ name: 'SHA256SUMS.txt', size: fs.statSync(path.join(staging, 'SHA256SUMS.txt')).size, sha256: await sha256(path.join(staging, 'SHA256SUMS.txt')) });
  const notes = [
    'Windows & Mac Software Builder ' + version + ' — native Windows x64 and universal Mac installers.',
    '',
    'Fix long resource paths when opening the Windows self-extracting EXE: the legacy SFX transports assets in a short-named opaque ZIP, then the normal Viewer validates and atomically restores every original byte using extended Windows paths before opening. No profile or cache is deleted. Native tests execute the actual generated SFX and verify the normal Viewer window and resources longer than 260 characters.',
    '',
    'Remove artificial 32/64-directory depth caps from web/portable imports and Windows/Mac exports, and the internal 2048-character ZIP path cap. Both native export gates preserve and extract 72-level trees. Filesystem limits and existing file count/size quotas still apply. See V2.6.4.md.',
    '',
    'Fix Windows-to-Mac exports containing native portable Mac applications: Windows does not preserve Unix execute bits, so validated Mach-O executables are written with mode 0755 inside the exported ZIP and editable project archives. Existing saved projects work without reimporting. Original files, binary bytes and the signed Viewer template remain unchanged. Ordinary resources are not made executable; native Unix permission checks and rejection of incompatible or invalid programs remain in place.',
    '',
    '**APK execution is unavailable in this release.** The Android option is an information panel; there is no bundled tested Android engine. Existing modules remain usable without an Android emulator.',
    '',
    'Top and bottom image banners each have an optional end-user X button. Closing a permitted banner increases the viewing area without opening its destination link or losing the current content. Banners return when the application is reopened. Existing projects keep closing disabled by default.',
    '',
    'Both banner image pickers show the recommended 728 × 90 px size and PNG/JPG/animated GIF support. GIF animation and original file bytes are preserved in editable project transfers and Windows/Mac exports. Native source and packaged UI checks cover actual GIF frames, pointer and keyboard closing, independent permissions and reclaimed content space.',
    '',
    'Editable project import/export (.wsmb) includes configuration and assets, creates independent copies and verifies archive integrity. Pending appearance edits are saved before project changes, previews and exports. Failed content imports roll back copied files. The banner focus/scroll fix and protected ZIP/RAR downloads from v2.6.1 are included.',
    '',
    'Lossless package compression, removal of Builder-only Viewer dependencies and project-specific FFmpeg/PHP payloads reduce unnecessary package content. Every IPTV export includes the exact FFmpeg/x264 sources and GPL notices.',
    '',
    'Windows: Windows 10+ x64. Mac: macOS 13+ Intel or Apple Silicon. The Windows installer is unsigned; the Mac application is ad-hoc signed, without Apple notarization.',
    '',
    'Install the update and re-export existing projects to apply the Viewer changes. Compare downloaded installer hashes with SHA256SUMS.txt.',
    '',
    'Source commit: `' + context.sourceSha + '`.',
    'Tested workflow commit: `' + context.testedSourceSha + '`.',
    'Identical tested/source tree: `' + source.tree.sha + '`.',
    'Validated workflow run: https://github.com/' + context.repository + '/actions/runs/' + context.runId,
    'Workflow attempt: ' + context.runAttempt + '.',
    '',
    'Both native Builder jobs completed source and packaged export checks, native transcoding and advancing video playback before these assets were transferred. Package-size reports and native execution reports accompany the installers.', ''
  ].join('\n');
  const notesFile = path.join(payloadRoot, 'release-notes.txt');
  fs.writeFileSync(notesFile, notes);
  // Draft releases do not create their Git tag until publication. Create one
  // new lightweight ref atomically first; POST rejects a concurrent existing
  // tag and never moves or replaces an existing ref.
  const createdTag = JSON.parse(gh(['api', prefix + '/git/refs', '--method', 'POST', '-f', 'ref=refs/tags/' + tag, '-f', 'sha=' + context.sourceSha, '-H', 'X-GitHub-Api-Version: 2026-03-10']));
  verifyReleaseTag(createdTag, context.sourceSha);
  verifyReleaseTag(api(prefix + '/git/ref/tags/' + tag), context.sourceSha);
  const requestFile = path.join(payloadRoot, 'release-request.json');
  fs.writeFileSync(requestFile, JSON.stringify({ tag_name: tag, target_commitish: context.sourceSha, name: 'Windows & Mac Software Builder ' + version, body: notes, draft: true, prerelease: true, make_latest: 'false' }));
  // Capture the new numeric draft ID directly. REST by-tag lookup does not
  // resolve an unpublished release; all subsequent reads use its ID.
  const createdDraft = JSON.parse(gh(['api', prefix + '/releases', '--method', 'POST', '--input', requestFile, '-H', 'X-GitHub-Api-Version: 2026-03-10']));
  if (!Number.isSafeInteger(createdDraft.id) || createdDraft.id < 1) throw new Error('New draft did not return a valid release ID.');
  const draft = api(prefix + '/releases/' + createdDraft.id);
  if (draft.id !== createdDraft.id || draft.tag_name !== tag || !draft.draft || !draft.prerelease) throw new Error('New release draft does not match the tested version.');
  verifyReleaseTag(api(prefix + '/git/ref/tags/' + tag), context.sourceSha);
  if (api(prefix + '/releases/' + draft.id + '/assets?per_page=100').length !== 0) throw new Error('Refusing to upload over assets in an unexpected nonempty release draft.');
  // gh resolves draft tags through GraphQL and uploads without --clobber.
  gh(['release', 'upload', tag, ...assets.map(asset => path.join(staging, asset.name)), '--repo', context.repository]);
  verifyUploadedAssets(api(prefix + '/releases/' + draft.id + '/assets?per_page=100'), assets);
  verifyReleaseTag(api(prefix + '/git/ref/tags/' + tag), context.sourceSha);
  gh(['release', 'edit', tag, '--repo', context.repository, '--draft=false', '--prerelease', '--latest=false']);
  const published = api(prefix + '/releases/' + draft.id);
  if (published.id !== draft.id || published.tag_name !== tag || published.draft || !published.prerelease) throw new Error('Release publication could not be verified.');
  verifyReleaseTag(api(prefix + '/git/ref/tags/' + tag), context.sourceSha);
  verifyUploadedAssets(api(prefix + '/releases/' + published.id + '/assets?per_page=100'), assets);
  console.log(JSON.stringify({ release: published.html_url, sourceSha: context.sourceSha, testedSourceSha: context.testedSourceSha, treeSha: source.tree.sha, assets: published.assets.map(asset => ({ name: asset.name, size: asset.size, digest: asset.digest, url: asset.browser_download_url })) }, null, 2));
}

if (require.main === module) publish().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { publish, verifyUploadedAssets, verifyReleaseTag };
