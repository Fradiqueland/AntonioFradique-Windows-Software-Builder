'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createIptvProxy, compatibilityArgs, diagnosticRedactor } = require('../src/shared/iptv-proxy');

const SOURCE = 'https://example.invalid/live/demoUser987/demoPassword654/123.ts?token=demoToken321';
const CAPABILITIES = { '-encoders': ' V..... libx264 H264\n A..... aac AAC\n',
  '-filters': ' ... yadif x\n ... scale x\n ... format x\n ... fps x\n ... aresample x\n', '-muxers': ' E mp4 MP4\n' };

function probeCalls(calls, outputs = CAPABILITIES) {
  return (executable, args, options, callback) => {
    calls.push({ executable, args, options });
    process.nextTick(() => callback(null, outputs[args[1]] || ''));
  };
}

function fakeSpawner(children, onStart = child => { child.stdout.end(Buffer.from('mock-mp4')); child.complete(); }) {
  return (executable, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { executable, args, options, stdout: new PassThrough(), stderr: new PassThrough(), killed: false });
    child.complete = (code = 0, signal = null) => process.nextTick(() => { child.emit('exit', code, signal); child.emit('close', code, signal); });
    child.kill = () => { child.killed = true; child.stdout.destroy(); child.stderr.destroy(); process.nextTick(() => { child.emit('exit', null); child.emit('close', null); }); return true; };
    children.push(child);
    process.nextTick(() => onStart(child));
    return child;
  };
}

async function fixture(t, options = {}) {
  const probes = [], children = [];
  const proxy = createIptvProxy({ getExecutable: () => process.execPath,
    execFileImpl: probeCalls(probes), spawnImpl: fakeSpawner(children), ...options });
  const token = proxy.register(SOURCE);
  const server = http.createServer((req, res) => proxy.serve(req.url.slice(1), req, res).catch(error => { res.destroy(error); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { proxy.closeAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/${token}`;
  return { proxy, token, probes, children, url };
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('compatibility mode really transcodes H264 progressive 720p30 and AAC', () => {
  const args = compatibilityArgs(SOURCE);
  const value = name => args[args.indexOf(name) + 1];
  assert.equal(value('-c:v'), 'libx264');
  assert.equal(value('-profile:v'), 'main');
  assert.equal(value('-level:v'), '3.1');
  assert.equal(value('-g'), '60');
  assert.equal(value('-sc_threshold'), '0');
  assert.match(value('-vf'), /yadif=.*deint=interlaced/);
  assert.match(value('-vf'), /scale=w='min\(iw,1280\)':h='min\(ih,720\)'/);
  assert.match(value('-vf'), /force_divisible_by=2,format=yuv420p,fps=30/);
  assert.equal(value('-c:a'), 'aac');
  assert.equal(value('-profile:a'), 'aac_low');
  assert.equal(value('-ac'), '2');
  assert.equal(value('-protocol_whitelist'), 'http,https,tcp,tls,crypto');
  assert.equal(args.includes('copy'), false);
  assert.equal(args.at(-1), 'pipe:1');
});

test('capability checks are asynchronous, shared and cached', async () => {
  const calls = [];
  const proxy = createIptvProxy({ getExecutable: () => process.execPath, execFileImpl: probeCalls(calls) });
  assert.deepEqual(await Promise.all([proxy.available(), proxy.available(), proxy.available()]), [true, true, true]);
  assert.equal(calls.length, 3);
  assert.equal(await proxy.available(), true);
  assert.equal(calls.length, 3);
  for (const call of calls) { assert.equal(call.options.shell, false); assert.equal(call.options.timeout, 5000); }
  const missing = createIptvProxy({ getExecutable: () => process.execPath,
    execFileImpl: probeCalls([], { ...CAPABILITIES, '-encoders': 'A..... aac AAC' }) });
  assert.equal(await missing.available(), false);
});

test('proxy validates host/method/range and HEAD never starts a process', async t => {
  const f = await fixture(t);
  assert.equal((await request(f.url, { method: 'HEAD' })).status, 200);
  assert.equal((await request(f.url, { method: 'POST' })).status, 405);
  assert.equal((await request(f.url, { headers: { host: 'attacker.example' } })).status, 403);
  assert.equal((await request(f.url, { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await request(f.url, { headers: { range: 'bytes=100-' } })).status, 416);
  assert.equal(f.children.length, 0);
  const result = await request(f.url, { headers: { range: 'bytes=0-1023', origin: 'null' } });
  assert.equal(result.status, 200);
  assert.equal(result.headers['content-type'], 'video/mp4');
  assert.equal(result.headers['accept-ranges'], 'none');
  assert.equal(result.body, 'mock-mp4');
  assert.equal(f.children[0].options.shell, false);
});

test('registration rejects local files and invalid protocols', () => {
  const proxy = createIptvProxy({ getExecutable: () => null });
  for (const url of ['file:///private/file', 'concat:http://example.invalid', 'ftp://example.invalid', 'relative', SOURCE + '\n']) assert.throws(() => proxy.register(url), /inválido/);
});

test('diagnostics redact credential-bearing URLs and bounded stderr fragments', async t => {
  const children = [];
  const f = await fixture(t, { spawnImpl: fakeSpawner(children, child => {
    child.stderr.write(`Failed to open ${SOURCE}\nusername=demoUser987\npassword=demoPassword654\n`);
    child.stderr.write('token=demoToken321\n');
    child.stdout.end('mock');
    child.complete();
  }) });
  await request(f.url);
  const logs = f.proxy.status(f.token).log.join('\n');
  for (const secret of ['demoUser987', 'demoPassword654', 'demoToken321', 'example.invalid']) assert.equal(logs.includes(secret), false);
  assert.ok(logs.length < 10000);
  assert.doesNotMatch(diagnosticRedactor(SOURCE)(SOURCE), /example\.invalid/);
});

test('startup timeout returns an error and terminates a silent child', async t => {
  const children = [];
  const f = await fixture(t, { startupTimeoutMs: 30, spawnImpl: fakeSpawner(children, () => {}) });
  assert.equal((await request(f.url)).status, 504);
  assert.equal(children[0].killed, true);
  assert.match(f.proxy.status(f.token).log.join('\n'), /tempo limite/);
});

test('client abort terminates the FFmpeg child', async t => {
  const children = [];
  const f = await fixture(t, { spawnImpl: fakeSpawner(children, child => child.stdout.write('partial')) });
  await new Promise((resolve, reject) => {
    const req = http.get(f.url, response => {
      response.on('data', () => { response.destroy(); resolve(); });
      response.on('error', () => {});
    });
    req.on('error', reject);
  });
  await new Promise((resolve, reject) => {
    if (children[0].killed) return resolve();
    const timer = setTimeout(() => reject(new Error('the aborted response left its child running')), 1000);
    children[0].once('close', () => { clearTimeout(timer); resolve(); });
  });
  assert.equal(children[0].killed, true);
});

test('a stalled conversion closes the partial response and kills its child', async t => {
  const children = [];
  const f = await fixture(t, { inactivityTimeoutMs: 30,
    spawnImpl: fakeSpawner(children, child => child.stdout.write('partial')) });
  await assert.rejects(request(f.url), /aborted|reset|socket/i);
  assert.equal(children[0].killed, true);
  assert.match(f.proxy.status(f.token).log.join('\n'), /deixou de produzir/);
});

test('stopping during capability probing completes the waiting request', async t => {
  const pending = [];
  const f = await fixture(t, { execFileImpl: (_executable, args, _options, callback) => pending.push(() => callback(null, CAPABILITIES[args[1]])) });
  const result = request(f.url);
  while (pending.length !== 3) await new Promise(resolve => setImmediate(resolve));
  f.proxy.stop(f.token);
  pending.forEach(finish => finish());
  assert.equal((await result).status, 410);
  assert.equal(f.children.length, 0);
});

test('partial MP4 followed by exit code 1 aborts HTTP instead of reporting normal EOF', async t => {
  const children = [];
  const f = await fixture(t, { spawnImpl: fakeSpawner(children, child => {
    child.stdout.end('partial-mp4');
    setTimeout(() => child.complete(1), 20);
  }) });
  await assert.rejects(request(f.url), /aborted|reset|socket/i);
  assert.equal(f.proxy.status(f.token).exitCode, 1);
  assert.match(f.proxy.status(f.token).log.join('\n'), /código 1/);
  assert.equal(children[0].killed, false, 'an already closed child does not need to be killed again');
});

test('unexpected termination by a signal aborts a partial response', async t => {
  const f = await fixture(t, { spawnImpl: fakeSpawner([], child => {
    child.stdout.end('partial-mp4');
    setTimeout(() => child.complete(null, 'SIGTERM'), 20);
  }) });
  await assert.rejects(request(f.url), /aborted|reset|socket/i);
  assert.equal(f.proxy.status(f.token).exitCode, -1);
  assert.match(f.proxy.status(f.token).log.join('\n'), /SIGTERM/);
});

test('stdout EOF without process completion remains bounded and terminates the child', async t => {
  const children = [];
  const f = await fixture(t, { completionTimeoutMs: 30,
    spawnImpl: fakeSpawner(children, child => child.stdout.end('partial-mp4')) });
  await assert.rejects(request(f.url), /aborted|reset|socket/i);
  assert.equal(children[0].killed, true);
  assert.match(f.proxy.status(f.token).log.join('\n'), /não confirmou a conclusão/);
});
