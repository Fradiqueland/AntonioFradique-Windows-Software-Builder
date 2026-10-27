'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const platforms = Object.freeze({ Windows: { nodePlatform: 'win32', suffix: 'windows-x64-setup.exe' }, macOS: { nodePlatform: 'darwin', suffix: 'mac-universal.dmg' } });
const reportNames = ['build-electron-smoke-source.json', 'build-electron-smoke-packaged.json', 'build-iptv-smoke-source.json', 'build-iptv-smoke-packaged.json', 'build-builder-startup.json'];

function checkedContext(env = process.env) {
  const { GITHUB_REPOSITORY: repository, TESTED_SOURCE_SHA: testedSourceSha, RELEASE_SOURCE_SHA: sourceSha, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: runAttempt } = env;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !/^[a-f0-9]{40}$/.test(testedSourceSha || '') || !/^[a-f0-9]{40}$/.test(sourceSha || '') || !/^\d+$/.test(runId || '') || !/^[1-9]\d*$/.test(runAttempt || '')) throw new Error('Missing or invalid exact GitHub build context.');
  return { repository, testedSourceSha, sourceSha, runId, runAttempt };
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function physicalFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Release payload must contain physical files: ' + path.basename(file));
  return stat;
}

function assertInstallerFormat(file, platform) {
  const { size } = physicalFile(file);
  if (size < 1048576 || size >= 2 * 1024 ** 3) throw new Error('Installer has an invalid release asset size.');
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(4);
    fs.readSync(fd, header, 0, 4, platform === 'Windows' ? 0 : size - 512);
    if (platform === 'Windows' ? header.toString('ascii', 0, 2) !== 'MZ' : header.toString('ascii') !== 'koly') throw new Error('Installer format does not match its platform.');
  } finally { fs.closeSync(fd); }
  return size;
}

function readJson(file) { physicalFile(file); return JSON.parse(fs.readFileSync(file, 'utf8')); }

async function preparePayload(platform, { applicationRoot = root, context = checkedContext(), hostPlatform = process.platform, checkoutSha } = {}) {
  if (!platforms[platform] || platforms[platform].nodePlatform !== hostPlatform) throw new Error('Prepare release installers on their native platform.');
  const pkg = readJson(path.join(applicationRoot, 'package.json'));
  if (checkoutSha === undefined) checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: applicationRoot, encoding: 'utf8' }).trim();
  if (checkoutSha !== context.testedSourceSha) throw new Error('Release payload checkout differs from the tested workflow SHA.');
  const installerName = 'Windows-Mac-Software-Builder-' + pkg.version + '-' + platforms[platform].suffix;
  const installer = path.join(applicationRoot, 'dist/builder', installerName);
  const size = assertInstallerFormat(installer, platform);
  const digest = await sha256(installer);
  const checksumLines = fs.readFileSync(path.join(applicationRoot, 'dist/builder/SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/);
  if (!checksumLines.includes(digest + '  ' + installerName)) throw new Error('Installer checksum does not match its native build result.');
  const reports = reportNames.map(name => {
    const report = readJson(path.join(applicationRoot, name));
    if (report.status !== 'passed' || report.platform !== hostPlatform || (report.appVersion || report.version) !== pkg.version || !Array.isArray(report.checks) || !report.checks.length) throw new Error('Native release report is missing, stale or failed: ' + name);
    if (name === 'build-builder-startup.json' && (report.installer?.name !== installerName || report.installer.sha256 !== digest)) throw new Error('Builder startup did not test this exact installer.');
    return { name, report };
  });
  const sizeReport = readJson(path.join(applicationRoot, 'dist/package-size-report.json'));
  const measured = sizeReport.items?.find(item => item.path === 'dist/builder/' + installerName);
  if (sizeReport.version !== pkg.version || !measured || measured.bytes !== size) throw new Error('Native installer size report does not match its release payload.');
  const directory = path.join(applicationRoot, 'dist/release', platform);
  if (fs.existsSync(directory)) throw new Error('Refusing to replace an existing release payload directory.');
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.copyFileSync(installer, path.join(directory, installerName));
    fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), digest + '  ' + installerName + '\n');
    fs.writeFileSync(path.join(directory, 'package-size-report.json'), JSON.stringify(sizeReport, null, 2) + '\n');
    for (const { name, report } of reports) fs.writeFileSync(path.join(directory, name), JSON.stringify(report, null, 2) + '\n');
    const files = [];
    for (const name of fs.readdirSync(directory).sort()) files.push({ name, size: physicalFile(path.join(directory, name)).size, sha256: await sha256(path.join(directory, name)) });
    const proof = { schemaVersion: 1, version: pkg.version, platform, ...context, apkExecutionAvailable: false, files };
    fs.writeFileSync(path.join(directory, 'build-proof.json'), JSON.stringify(proof, null, 2) + '\n');
    return proof;
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}

async function verifyPayload(directory, platform, context, version) {
  const proof = readJson(path.join(directory, 'build-proof.json'));
  if (!platforms[platform] || proof.schemaVersion !== 1 || proof.version !== version || proof.platform !== platform || proof.apkExecutionAvailable !== false || ['repository', 'testedSourceSha', 'sourceSha', 'runId', 'runAttempt'].some(key => proof[key] !== context[key]) || !Array.isArray(proof.files)) throw new Error('Cached release proof does not match this exact tested workflow/platform.');
  const installerName = 'Windows-Mac-Software-Builder-' + version + '-' + platforms[platform].suffix;
  const expected = new Set([installerName, 'SHA256SUMS.txt', 'package-size-report.json', ...reportNames]);
  if (proof.files.length !== expected.size || new Set(proof.files.map(file => file.name)).size !== expected.size) throw new Error('Cached release proof has missing or duplicate payload files.');
  for (const file of proof.files) {
    if (!expected.has(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 1) throw new Error('Cached release proof has unsafe or invalid file metadata.');
    const actual = path.join(directory, file.name);
    if (physicalFile(actual).size !== file.size || await sha256(actual) !== file.sha256) throw new Error('Cached release asset changed: ' + file.name);
  }
  if (fs.readdirSync(directory).sort().join('\n') !== [...expected, 'build-proof.json'].sort().join('\n')) throw new Error('Cached release directory contains unexpected payload files.');
  assertInstallerFormat(path.join(directory, installerName), platform);
  const installerProof = proof.files.find(file => file.name === installerName);
  if (fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8') !== installerProof.sha256 + '  ' + installerName + '\n') throw new Error('Cached checksum list differs from its installer proof.');
  for (const name of reportNames) {
    const report = readJson(path.join(directory, name));
    if (report.status !== 'passed' || report.platform !== platforms[platform].nodePlatform || (report.appVersion || report.version) !== version || !Array.isArray(report.checks) || !report.checks.length) throw new Error('Cached release contains an invalid native execution report.');
    if (name === 'build-builder-startup.json' && (report.installer?.name !== installerName || report.installer.sha256 !== installerProof.sha256)) throw new Error('Cached Builder startup proof differs from the installer.');
  }
  const sizeReport = readJson(path.join(directory, 'package-size-report.json'));
  if (sizeReport.version !== version || !sizeReport.items?.some(item => item.path === 'dist/builder/' + installerName && item.bytes === installerProof.size)) throw new Error('Cached release contains an invalid native size report.');
  return proof;
}

if (require.main === module) preparePayload(process.argv[2]).then(proof => console.log(JSON.stringify(proof, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { checkedContext, preparePayload, verifyPayload, sha256, assertInstallerFormat, reportNames, platforms };
