'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { EventEmitter } = require('events');
const web = require('../src/shared/local-web');

function fixture(t, extension = 'html') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-web-races-'));
  const source = path.join(root, 'source');
  const assetsDir = path.join(root, 'dist-assets');
  fs.mkdirSync(source);
  const sourcePath = path.join(source, `index.${extension}`);
  fs.writeFileSync(sourcePath, extension === 'php' ? '<?php echo "safe";' : 'safe');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, source, sourcePath, assetsDir };
}

function canLink(t, root) {
  const filename = path.join(root, 'link-probe');
  try { fs.symlinkSync('missing', filename); fs.unlinkSync(filename); return true; }
  catch (error) { if (error.code === 'EPERM') { t.skip('This Windows account cannot create symlinks.'); return false; } throw error; }
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

test('a late leaf-symlink swap cannot change the file being streamed', async t => {
  const f = fixture(t);
  if (!canLink(t, f.root)) return;
  const outside = path.join(f.root, 'outside.txt');
  fs.writeFileSync(outside, 'LEAK');
  const data = web.importWebProject(f);
  const { entryPath } = web.validateWebProject({ data, assetsDir: f.assetsDir });
  const runtime = web.createWebRuntime();
  t.after(() => runtime.closeAll());
  const session = await runtime.open({ data, assetsDir: f.assetsDir });
  const original = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', function(filename, options) {
    if (filename === entryPath) {
      fs.unlinkSync(filename);
      fs.symlinkSync(outside, filename);
    }
    return original.call(this, filename, options);
  });
  const response = await get(session.url);
  assert.equal(response.status, 200);
  assert.equal(response.body, 'safe');
});

test('a parent-directory swap before open fails closed', async t => {
  const f = fixture(t);
  if (!canLink(t, f.root)) return;
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'asset.txt'), 'LEAK');
  fs.mkdirSync(path.join(f.source, 'assets'));
  fs.writeFileSync(path.join(f.source, 'assets/asset.txt'), 'safe');
  const data = web.importWebProject({ ...f, includeDirectory: true });
  const { rootPath } = web.validateWebProject({ data, assetsDir: f.assetsDir });
  const runtime = web.createWebRuntime();
  t.after(() => runtime.closeAll());
  const session = await runtime.open({ data, assetsDir: f.assetsDir });
  const filename = path.join(rootPath, 'assets/asset.txt');
  const original = fs.openSync;
  let swapped = false;
  t.mock.method(fs, 'openSync', function(file, ...args) {
    if (file === filename && !swapped) {
      swapped = true;
      fs.renameSync(path.join(rootPath, 'assets'), path.join(rootPath, 'saved-assets'));
      fs.symlinkSync(outside, path.join(rootPath, 'assets'), 'dir');
    }
    return original.call(this, file, ...args);
  });
  const response = await get(new URL(`/${session.token}/assets/asset.txt`, session.url));
  assert.equal(response.status, 404);
  assert.doesNotMatch(response.body, /LEAK/);
});

test('an interrupted PHP transport aborts its frontend response instead of hanging (mock backend)', async t => {
  const f = fixture(t, 'php');
  const backendProcesses = [];
  const fakeProcess = {
    spawn(_executable, args) {
      const port = Number(args[args.indexOf('-S') + 1].split(':')[1]);
      const child = new EventEmitter();
      child.pid = 12345;
      child.exitCode = null;
      child.signalCode = null;
      child.stderr = new EventEmitter();
      const server = http.createServer((request, response) => {
        if (request.url === '/__local_web_ready__') { response.writeHead(204); response.end(); return; }
        response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '100' });
        response.write('partial');
        setTimeout(() => response.socket.destroy(), 10);
      });
      server.listen(port, '127.0.0.1');
      child.kill = () => {
        server.close();
        server.closeAllConnections();
        child.exitCode = 0;
        process.nextTick(() => child.emit('exit', 0));
        return true;
      };
      backendProcesses.push(child);
      return child;
    }
  };
  // This substitutes only process creation. The proxy and both HTTP sockets are
  // real; it does not claim to execute or validate a native PHP installation.
  const sandbox = { require: name => name === 'child_process' ? fakeProcess : require(name),
    module: { exports: {} }, Buffer, process, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/shared/local-web'), 'utf8'), sandbox);
  const helper = sandbox.module.exports;
  const data = helper.importWebProject(f);
  const runtime = helper.createWebRuntime({ phpPath: process.execPath });
  t.after(() => runtime.closeAll());
  const session = await runtime.open({ data, assetsDir: f.assetsDir });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { request.destroy(); reject(new Error('frontend hung after the backend aborted')); }, 1000);
    const finish = error => { clearTimeout(timeout); error ? reject(error) : resolve(); };
    const request = http.get(session.url, response => {
      response.resume();
      response.on('aborted', () => finish());
      response.on('error', () => finish());
      response.on('end', () => finish(new Error('truncated response was reported as complete')));
    });
    request.on('error', () => finish());
  });
  await Promise.all([runtime.closeAll(), runtime.closeAll()]);
  assert.equal(backendProcesses[0].exitCode, 0);
});
