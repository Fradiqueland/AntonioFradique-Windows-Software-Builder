#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const lock = require('../build-configs/ffmpeg-sources.json');
const root = path.resolve(__dirname, '..');
const targets = ['windows-x64', 'mac-x64', 'mac-arm64'];
const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function downloadSource(source, archiveDir, { spawn = spawnSync } = {}) {
  const archive = path.join(archiveDir, source.file);
  const partial = archive + '.partial';
  let gitDir;
  function command(executable, args, options = {}) {
    const result = spawn(executable, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...options });
    if (result.error || result.status !== 0) throw new Error(executable + ' source transport failed: ' + String(result.stderr || result.error?.message || result.status).slice(-2000));
  }
  try {
    try {
      // VideoLAN rejects the default Node fetch user agent with HTTP 406 on
      // GitHub runners. Use the standard system curl HTTPS client instead.
      command('curl', ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '20', '--max-time', '120', '--output', partial, source.url]);
      // Some rejected requests return an HTML challenge with HTTP 200. It is
      // still a failed archive download and must never be extracted.
      if (hashFile(partial) !== source.sha256) throw new Error('Source SHA-256 mismatch: ' + source.name);
    } catch (downloadError) {
      // The public GitLab archive endpoint can also reject a runner's address.
      // Recreate its archive from the same official immutable commit. git
      // archive + bzip2 was verified to produce exactly the locked bytes.
      if (source.name !== 'x264' || source.gitRepository !== 'https://code.videolan.org/videolan/x264.git' || !/^[a-f0-9]{40}$/.test(source.gitCommit) || source.gitCommit !== source.version || source.directory !== 'x264-' + source.gitCommit) throw downloadError;
      console.warn('Archive transport unavailable; rebuilding the identical x264 source archive from official Git.');
      gitDir = fs.mkdtempSync(path.join(archiveDir, '.x264-git-'));
      command('git', ['init', '--quiet', gitDir]);
      command('git', ['-c', 'core.autocrlf=false', '-c', 'http.lowSpeedLimit=1024', '-c', 'http.lowSpeedTime=30', 'fetch', '--quiet', '--depth=1', source.gitRepository, source.gitCommit], { cwd: gitDir });
      const tar = path.join(gitDir, 'source.tar');
      const tarFd = fs.openSync(tar, 'w');
      // Archive applies worktree conversion too. Fetch's -c flags do not carry
      // into this separate process: Windows autocrlf or a user tar.umask can
      // otherwise change the pinned source bytes without changing the commit.
      // Keep the original commit timestamp/PAX header and archive prefix.
      try { command('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'tar.umask=0002',
        'archive', '--format=tar', '--prefix=' + source.directory + '/', source.gitCommit], { cwd: gitDir, stdio: ['ignore', tarFd, 'pipe'] }); }
      finally { fs.closeSync(tarFd); }
      const archiveFd = fs.openSync(partial, 'w');
      try { command('bzip2', ['-9', '-c', 'source.tar'], { cwd: gitDir, stdio: ['ignore', archiveFd, 'pipe'] }); }
      finally { fs.closeSync(archiveFd); }
    }
    if (hashFile(partial) !== source.sha256) throw new Error('Source SHA-256 mismatch: ' + source.name);
    fs.renameSync(partial, archive);
  } finally {
    fs.rmSync(partial, { force: true });
    if (gitDir) fs.rmSync(gitDir, { recursive: true, force: true });
  }
  return archive;
}

async function prepare(target) {
  if (!targets.includes(target)) throw new Error('Choose windows-x64, mac-x64 or mac-arm64.');
  const base = path.join(root, 'dist/ffmpeg-build', target);
  const archiveDir = path.join(root, 'dist/ffmpeg-sources');
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const source of lock.sources) {
    const archive = path.join(archiveDir, source.file);
    if (!fs.existsSync(archive) || hashFile(archive) !== source.sha256) {
      downloadSource(source, archiveDir);
    }
    const extracted = path.join(base, source.directory);
    // A fresh extraction also prevents stale configure output from changing a rebuild.
    fs.rmSync(extracted, { recursive: true, force: true });
    // Relative archive names avoid GNU tar interpreting a Windows drive colon
    // as a remote host when this process runs inside MSYS2.
    const result = spawnSync('tar', ['--no-same-owner', '-xf', source.file, '-C', path.relative(archiveDir, base).split(path.sep).join('/')], { cwd: archiveDir, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('Cannot extract verified source ' + source.file + ': ' + (result.error || result.status));
    if (!fs.statSync(path.join(extracted, 'configure')).isFile()) throw new Error('Invalid source archive: ' + source.name);
    console.log('Verified source ' + source.name + ' ' + source.version + ' (' + source.sha256 + ')');
  }
}

if (require.main === module) prepare(process.argv[2]).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepare, hashFile, downloadSource };
