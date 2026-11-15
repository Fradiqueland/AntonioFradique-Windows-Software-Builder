'use strict';

// One-time recovery of immutable native payloads. This run is NOT a new build:
// the original run/attempt remains in the proofs and release provenance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const context = Object.freeze({
  repository: 'Fradiqueland/AntonioFradique-Windows-Software-Builder',
  sourceSha: 'a309fdcc9ab69bcf0f080e18444991dedb116e37',
  testedSourceSha: 'a34f0da74a1f10eb0c83ed81b8208874eaa6167e',
  runId: '39344259482', runAttempt: '1'
});
const title = 'v2.6.1: recover verified installers from run 39344259482';
const allowedFiles = [
  '.github/scripts/recover-v2.6.1.cjs',
  '.github/workflows/build-v2-installers.yml',
  '.github/workflows/recover-v2.6.1.yml'
].sort();
const requiredJobs = new Map([
  [118373008541, 'FFmpeg from verified sources (windows-x64)'],
  [118373008903, 'FFmpeg from verified sources (mac-arm64)'],
  [118373008949, 'FFmpeg from verified sources (mac-x64)'],
  [118373146038, 'Viewer template (windows-x64)'],
  [118373146051, 'Viewer template (mac-universal)'],
  [118374431140, 'Builder installer (Windows)'],
  [118374431197, 'Builder installer (macOS)']
]);
function validateEvidence({ event, run, jobs, tested, source, current, comparison }, env) {
  assert.equal(env.GITHUB_REPOSITORY, context.repository);
  assert.equal(env.GITHUB_EVENT_NAME, 'pull_request');
  assert.equal(env.GITHUB_REF, 'refs/pull/6/merge');
  assert.notEqual(env.GITHUB_RUN_ID, context.runId);
  assert.equal(event.number, 6);
  assert.equal(event.pull_request.title, title);
  assert.equal(event.pull_request.head.repo.full_name, context.repository);
  assert.equal(run.id, Number(context.runId));
  assert.equal(run.event, 'pull_request');
  assert.equal(run.path, '.github/workflows/build-v2-installers.yml');
  assert.equal(run.head_sha, context.sourceSha);
  assert.equal(run.repository.full_name, context.repository);
  assert(run.pull_requests.some(pr => pr.number === 6));
  assert.equal(jobs.total_count, jobs.jobs.length, 'Incomplete attempt-1 job list');
  for (const [id, name] of requiredJobs) {
    const matches = jobs.jobs.filter(job => job.id === id);
    assert.equal(matches.length, 1);
    const job = matches[0];
    assert.equal(job.name, name);
    assert.equal(job.conclusion, 'success');
    assert.equal(job.status, 'completed');
    assert.equal(job.run_id, Number(context.runId));
    assert.equal(job.run_attempt, 1);
    assert.equal(job.head_sha, context.sourceSha);
  }
  assert.equal(tested.sha, context.testedSourceSha);
  assert.equal(source.sha, context.sourceSha);
  assert.equal(source.tree.sha, '3a1328ee4fa1deeaf6f5f0d35133a44f1a7cfb74');
  assert.equal(tested.tree.sha, source.tree.sha);
  assert.equal(current.sha, event.pull_request.head.sha);
  assert.deepEqual(current.parents.map(parent => parent.sha), [context.sourceSha]);
  assert.equal(comparison.status, 'ahead');
  assert.equal(comparison.ahead_by, 1);
  assert.equal(comparison.behind_by, 0);
  assert.equal(comparison.total_commits, 1);
  assert.deepEqual(comparison.files.map(file => file.filename).sort(), allowedFiles);
  assert(comparison.files.every(file => ['added', 'modified'].includes(file.status)));
}
function api(endpoint) {
  return JSON.parse(execFileSync('gh', ['api', 'repos/' + context.repository + '/' + endpoint], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
}
async function main(mode) {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const evidence = {
    event, run: api('actions/runs/' + context.runId),
    jobs: api('actions/runs/' + context.runId + '/attempts/1/jobs?per_page=100'),
    tested: api('git/commits/' + context.testedSourceSha),
    source: api('git/commits/' + context.sourceSha),
    current: api('git/commits/' + event.pull_request.head.sha),
    comparison: api('compare/' + context.sourceSha + '...' + event.pull_request.head.sha)
  };
  validateEvidence(evidence, process.env);
  const checkout = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(checkout, context.sourceSha, 'Publisher must execute the frozen native-tested checkout');
  if (mode === 'validate') {
    console.log('Original attempt-1 native evidence and workflow-only recovery change verified.');
    return;
  }
  assert.equal(mode, 'publish');
  const root = path.resolve('Windows-Mac-Software-Builder');
  const { verifyPayload, sha256 } = require(path.join(root, 'scripts/release-payload'));
  const expected = {
    Windows: ['Windows-Mac-Software-Builder-2.6.1-windows-x64-setup.exe', '0d170323fec998b4343b2f68387ca5869d8d7f15f109dbadef6e219a84ef5cf6'],
    macOS: ['Windows-Mac-Software-Builder-2.6.1-mac-universal.dmg', '46121bfb20421afc312062ab56a9bb2772663aab4110945dd70c87280ccb7778']
  };
  for (const [platform, [filename, digest]] of Object.entries(expected)) {
    const directory = path.join(root, 'dist/release', platform);
    await verifyPayload(directory, platform, context, '2.6.1');
    assert.equal(await sha256(path.join(directory, filename)), digest, 'Installer differs from successful native job');
  }
  console.log('Both original payload proofs and independently recorded native installer hashes verified.');
  await require(path.join(root, 'scripts/publish-tested-release')).publish({ applicationRoot: root, context });
}
if (require.main === module) main(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { validateEvidence, context, title, allowedFiles, requiredJobs };
