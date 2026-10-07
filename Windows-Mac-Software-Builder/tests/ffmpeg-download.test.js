'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { downloadSource } = require('../scripts/prepare-ffmpeg-sources');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-source-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('the exact pinned source archive bytes');
  const commit = 'b35605ace3ddf7c1a5d67a2eb553f034aef41d55';
  return { directory, bytes, source: {
    name: 'x264', version: commit, gitCommit: commit,
    gitRepository: 'https://code.videolan.org/videolan/x264.git',
    directory: 'x264-' + commit, file: 'source.tar.bz2',
    url: 'https://code.videolan.org/videolan/x264/-/archive/' + commit + '/x264-' + commit + '.tar.bz2',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  } };
}

function simulatedTransport(f, { challenge = false, corruptGit = false } = {}) {
  const calls = [];
  return { calls, spawn(command, args, options) {
    calls.push({ command, args });
    assert.ok(options.timeout > 0 && options.timeout <= 180000);
    assert.equal(options.shell, undefined, 'source commands must never use shell interpolation');
    if (command === 'curl') {
      if (challenge) {
        fs.writeFileSync(args[args.indexOf('--output') + 1], '<html>request rejected</html>');
        return { status: 0 };
      }
      return { status: 22, stderr: 'HTTP406' };
    }
    if (command === 'git' && args.includes('fetch')) {
      assert.equal(args[args.length - 2], f.source.gitRepository);
      assert.equal(args[args.length - 1], f.source.gitCommit);
    }
    if (command === 'git' && args[0] === 'archive') fs.writeSync(options.stdio[1], Buffer.from('pinned git tar'));
    if (command === 'bzip2') fs.writeSync(options.stdio[1], corruptGit ? Buffer.from('wrong source bytes') : f.bytes);
    return { status: 0 };
  } };
}

test('official immutable Git fallback keeps the exact locked archive after HTTP406', (t) => {
  const f = fixture(t);
  const transport = simulatedTransport(f);
  const output = downloadSource(f.source, f.directory, transport);
  assert.deepEqual(fs.readFileSync(output), f.bytes);
  assert.deepEqual(transport.calls.map(call => call.command), ['curl', 'git', 'git', 'git', 'bzip2']);
  assert.deepEqual(fs.readdirSync(f.directory), ['source.tar.bz2']);
});

test('HTTP200 HTML challenge is rejected before the checksum-verified Git fallback', (t) => {
  const f = fixture(t);
  const transport = simulatedTransport(f, { challenge: true });
  assert.deepEqual(fs.readFileSync(downloadSource(f.source, f.directory, transport)), f.bytes);
  assert.ok(transport.calls.some(call => call.command === 'bzip2'));
});

test('a corrupt fallback cannot replace an existing archive and removes temporary files', (t) => {
  const f = fixture(t);
  const destination = path.join(f.directory, f.source.file);
  fs.writeFileSync(destination, 'previous archive');
  const transport = simulatedTransport(f, { corruptGit: true });
  assert.throws(() => downloadSource(f.source, f.directory, transport), /SHA-256 mismatch/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'previous archive');
  assert.deepEqual(fs.readdirSync(f.directory), ['source.tar.bz2']);
});

test('fallback does not fetch another repository or a mutable branch', (t) => {
  const f = fixture(t);
  for (const change of [{ gitRepository: 'https://example.com/x264.git' }, { gitCommit: 'stable' }]) {
    const transport = simulatedTransport(f);
    assert.throws(() => downloadSource({ ...f.source, ...change }, f.directory, transport), /source transport failed/);
    assert.deepEqual(transport.calls.map(call => call.command), ['curl']);
  }
});
