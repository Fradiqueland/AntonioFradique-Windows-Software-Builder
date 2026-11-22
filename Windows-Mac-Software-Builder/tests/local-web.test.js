'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { importWebProject, validateWebProject, removeWebProject, createWebRuntime, LIMITS } = require('../src/shared/local-web');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-web-test-'));
  const source = path.join(root, 'source');
  const assetsDir = path.join(root, 'project', 'dist-assets');
  fs.mkdirSync(source);
  fs.mkdirSync(assetsDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(name, contents = '') {
    const absolute = path.join(source, name);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents);
    return absolute;
  }
  return { root, source, assetsDir, write };
}

function request(url, { requestPath, headers = {}, method = 'GET', body } = {}) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: parsed.hostname, port: parsed.port,
      path: requestPath || `${parsed.pathname}${parsed.search}`, headers, method }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('web folder imports preserve 72 directory levels without a depth cap',t=>{
  const f=fixture(t),sourcePath=f.write('index.html','<h1>Deep tree</h1>');
  const relative=Array(72).fill('d').join('/')+'/style.css';f.write(relative,'body{color:red}');
  const data=importWebProject({sourcePath,includeDirectory:true,assetsDir:f.assetsDir});
  const verified=validateWebProject({data,assetsDir:f.assetsDir});
  assert.equal(fs.readFileSync(path.toNamespacedPath(path.join(verified.rootPath,...relative.split('/'))),'utf8'),'body{color:red}');
});

test('imports a single HTML/HTM file into a unique managed directory', t => {
  const f = fixture(t);
  const sourcePath = f.write('Olá mundo.HTM', '<h1>Olá</h1>');
  f.write('not-copied.txt', 'private');
  const first = importWebProject({ sourcePath, assetsDir: f.assetsDir });
  const second = importWebProject({ sourcePath, assetsDir: f.assetsDir });
  assert.notEqual(first.root, second.root);
  assert.equal(first.entry, 'Olá mundo.HTM');
  assert.equal(first.fileCount, 1);
  assert.equal(first.requiresPhp, false);
  const verified = validateWebProject({ data: first, assetsDir: f.assetsDir });
  assert.equal(fs.readFileSync(verified.entryPath, 'utf8'), '<h1>Olá</h1>');
  assert.equal(fs.existsSync(path.join(verified.rootPath, 'not-copied.txt')), false);
});

test('folder import preserves resources, detects nested PHP and skips hidden/dependency entries', t => {
  const f = fixture(t);
  const sourcePath = f.write('index.html', '<link href="assets/style.css">');
  f.write('assets/style.css', 'body { color: red; }');
  f.write('api/submit.PHP', '<?php echo "ok";');
  fs.mkdirSync(path.join(f.source, 'empty/cache'), { recursive: true });
  for (const name of ['.env', '.git/config', '.secret/file', 'node_modules/lib.js', 'assets/.env']) f.write(name, 'excluded');
  const data = importWebProject({ sourcePath, includeDirectory: true, assetsDir: f.assetsDir });
  assert.equal(data.fileCount, 3);
  assert.equal(data.requiresPhp, true);
  const validated = validateWebProject({ data: { ...data, requiresPhp: false }, assetsDir: f.assetsDir });
  assert.equal(validated.requiresPhp, true, 'manifest cannot conceal PHP files');
  assert.equal(fs.readFileSync(path.join(validated.rootPath, 'assets/style.css'), 'utf8'), 'body { color: red; }');
  assert.equal(fs.existsSync(path.join(validated.rootPath, '.env')), false);
  assert.equal(fs.statSync(path.join(validated.rootPath, 'empty/cache')).isDirectory(), true);
});

test('rejects invalid entry names, unsupported files and recursive destination imports', t => {
  const f = fixture(t);
  const sourcePath = f.write('index.html', 'ok');
  assert.throws(() => importWebProject({ sourcePath: f.write('script.exe'), assetsDir: f.assetsDir }), /html/);
  assert.throws(() => importWebProject({ sourcePath: 'relative.html', assetsDir: f.assetsDir }), /absoluto/);
  assert.throws(() => importWebProject({ sourcePath, includeDirectory: true, assetsDir: path.join(f.source, 'dist-assets') }), /não pode conter/);
  assert.equal(fs.readdirSync(f.assetsDir).length, 0);
});

test('rolls back partial imports when a source exceeds the size limit', t => {
  const f = fixture(t);
  const sourcePath = f.write('a-index.html', 'ok');
  const oversized = f.write('z-large.bin');
  fs.truncateSync(oversized, LIMITS.fileBytes + 1);
  assert.throws(() => importWebProject({ sourcePath, includeDirectory: true, assetsDir: f.assetsDir }), /limites/);
  assert.deepEqual(fs.readdirSync(f.assetsDir), []);
});

test('enforces file-count limits and removes the partially copied directory', t => {
  const f = fixture(t);
  const sourcePath = f.write('index.html', 'ok');
  for (let index = 0; index < LIMITS.files; index++) f.write(`data/${index}.txt`);
  assert.throws(() => importWebProject({ sourcePath, includeDirectory: true, assetsDir: f.assetsDir }), /limites/);
  assert.deepEqual(fs.readdirSync(f.assetsDir), []);
});

test('rejects symlinks in imports and managed projects', t => {
  const f = fixture(t);
  const sourcePath = f.write('index.html', 'ok');
  try { fs.symlinkSync(sourcePath, path.join(f.source, 'linked.html')); }
  catch (error) { if (error.code === 'EPERM') { t.skip('This Windows account cannot create symlinks.'); return; } throw error; }
  assert.throws(() => importWebProject({ sourcePath, includeDirectory: true, assetsDir: f.assetsDir }), /simbólicas/);
  assert.deepEqual(fs.readdirSync(f.assetsDir), []);
  const data = importWebProject({ sourcePath, assetsDir: f.assetsDir });
  const valid = validateWebProject({ data, assetsDir: f.assetsDir });
  fs.symlinkSync(sourcePath, path.join(valid.rootPath, 'escape.html'));
  assert.throws(() => validateWebProject({ data, assetsDir: f.assetsDir }), /simbólicas/);
});

test('validates manifest boundaries and only removes a managed directory', t => {
  const f = fixture(t);
  const data = importWebProject({ sourcePath: f.write('index.html', 'ok'), assetsDir: f.assetsDir });
  for (const root of ['dist-assets', '../source', data.root + '/..', data.root.replace('/', '\\'), '/tmp', 'C:\\Windows']) {
    assert.throws(() => validateWebProject({ data: { ...data, root }, assetsDir: f.assetsDir }), /diretório/);
    assert.throws(() => removeWebProject({ data: { ...data, root }, assetsDir: f.assetsDir }), /diretório/);
  }
  for (const entry of ['../index.html', 'sub/index.html', 'C:\\index.html', '.env', 'index.html:secret', 'bad?.html', 'bad*.html', 'bad<.html', 'bad>.html', 'bad|.html', 'bad".html']) {
    assert.throws(() => validateWebProject({ data: { ...data, entry }, assetsDir: f.assetsDir }), /inicial/);
  }
  assert.equal(removeWebProject({ data, assetsDir: f.assetsDir }), true);
  assert.equal(removeWebProject({ data, assetsDir: f.assetsDir }), false);
  assert.equal(fs.existsSync(path.join(f.source, 'index.html')), true);
  assert.equal(fs.existsSync(f.assetsDir), true);
});

test('serves HTML/resources, cookies for absolute URLs and HEAD without a body', async t => {
  const f = fixture(t);
  const sourcePath = f.write('index.html', '<h1>Olá</h1><link href="/assets/style.css">');
  f.write('assets/style.css', 'body { color: red; }');
  const data = importWebProject({ sourcePath, includeDirectory: true, assetsDir: f.assetsDir });
  const runtime = createWebRuntime();
  t.after(() => runtime.closeAll());
  const session = await runtime.open({ data, assetsDir: f.assetsDir });
  assert.equal(new URL(session.url).hostname, '127.0.0.1');
  const html = await request(session.url);
  assert.equal(html.status, 200);
  assert.match(html.body, /Olá/);
  assert.match(html.headers['content-type'], /text\/html/);
  assert.match(html.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  const cookie = html.headers['set-cookie'][0].split(';')[0];
  const resource = await request(session.url, { requestPath: '/assets/style.css', headers: { Cookie: cookie } });
  assert.equal(resource.status, 200);
  assert.match(resource.body, /color: red/);
  const head = await request(session.url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal((await request(session.url, { method: 'POST' })).status, 405);
  await runtime.close(session.token);
  await assert.rejects(request(session.url));
});

test('denies missing tokens, foreign hosts/origins, traversal and PHP source', async t => {
  const f = fixture(t);
  const data = importWebProject({ sourcePath: f.write('index.html', 'safe'), assetsDir: f.assetsDir });
  const runtime = createWebRuntime();
  t.after(() => runtime.closeAll());
  const session = await runtime.open({ data, assetsDir: f.assetsDir });
  const prefix = `/${session.token}`;
  assert.equal((await request(session.url, { requestPath: '/index.html' })).status, 403);
  assert.equal((await request(session.url, { headers: { Host: 'attacker.example' } })).status, 403);
  assert.equal((await request(session.url, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  for (const bad of ['/../index.html', '/%2e%2e/index.html', '/C%3a/windows', '/..%5cindex.html', '/%00x', '/.env', '/node_modules/lib.js', '/%ZZ']) {
    assert.equal((await request(session.url, { requestPath: prefix + bad })).status, 403, bad);
  }
  const { rootPath } = validateWebProject({ data, assetsDir: f.assetsDir });
  for (const name of ['added.php', 'secret.PHP', 'secret.inc', 'secret.phtml', 'secret.phps', 'secret.pht', 'secret.php.bak', 'secret.php~', 'secret.inc.old']) {
    fs.writeFileSync(path.join(rootPath, name), '<?php $secret = "NEVER-SERVE";');
    const result = await request(session.url, { requestPath: prefix + '/' + name });
    assert.equal(result.status, 403);
    assert.doesNotMatch(result.body, /NEVER-SERVE/);
  }
});

test('directory URLs redirect with a trailing slash so relative resources resolve correctly', async t => {
  const f = fixture(t);
  const sourcePath = f.write('index.html', 'home');
  f.write('pages/index.html', '<link href="style.css">');
  f.write('pages/style.css', 'body{color:red}');
  const data = importWebProject({ sourcePath, includeDirectory: true, assetsDir: f.assetsDir });
  const runtime = createWebRuntime();
  t.after(() => runtime.closeAll());
  const session = await runtime.open({ data, assetsDir: f.assetsDir });
  const page = await request(session.url, { requestPath: `/${session.token}/pages?name=value` });
  assert.equal(page.status, 308);
  assert.equal(page.headers.location, `/${session.token}/pages/?name=value`);
  const directoryUrl = new URL(page.headers.location, session.url);
  assert.equal((await request(directoryUrl.href)).status, 200);
  assert.equal((await request(new URL('style.css', directoryUrl).href)).body, 'body{color:red}');
});

test('blocks a symlink introduced after runtime validation', async t => {
  const f = fixture(t);
  const data = importWebProject({ sourcePath: f.write('index.html', 'safe'), assetsDir: f.assetsDir });
  const { rootPath } = validateWebProject({ data, assetsDir: f.assetsDir });
  const runtime = createWebRuntime();
  t.after(() => runtime.closeAll());
  const session = await runtime.open({ data, assetsDir: f.assetsDir });
  try { fs.symlinkSync(f.source, path.join(rootPath, 'escape'), 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('This Windows account cannot create symlinks.'); return; } throw error; }
  assert.equal((await request(session.url, { requestPath: `/${session.token}/escape/index.html` })).status, 404);
});

test('PHP requires an explicit installed runtime; HTML never needs PHP', async t => {
  const f = fixture(t);
  const data = importWebProject({ sourcePath: f.write('index.php', '<?php echo "ok";'), assetsDir: f.assetsDir });
  for (const phpPath of [undefined, 'php', path.join(f.root, 'missing-php')]) {
    const runtime = createWebRuntime({ phpPath });
    await assert.rejects(runtime.open({ data, assetsDir: f.assetsDir }), /PHP/);
    await runtime.closeAll();
  }
});

test('PHP runtime paths are resolved lazily after relocation while HTML never requests one', async t => {
  const f = fixture(t);
  const html = importWebProject({ sourcePath: f.write('index.html', '<h1>HTML</h1>'), assetsDir: f.assetsDir });
  const php = importWebProject({ sourcePath: f.write('index.php', '<?php echo "ok";'), assetsDir: f.assetsDir });
  let phpPath = path.join(f.root, 'old-data', 'php', 'php');
  const requested = [];
  const runtime = createWebRuntime({ getPhpPath: () => { requested.push(phpPath); return phpPath; } });
  t.after(() => runtime.closeAll());
  const session = await runtime.open({ data: html, assetsDir: f.assetsDir });
  assert.equal((await request(session.url)).status, 200);
  assert.deepEqual(requested, []);
  phpPath = path.join(f.root, 'relocated-data', 'php', 'php');
  await assert.rejects(runtime.open({ data: php, assetsDir: f.assetsDir }), /PHP/);
  assert.deepEqual(requested, [phpPath]);
  phpPath = path.join(f.root, 'second-location', 'php', 'php');
  await assert.rejects(runtime.open({ data: php, assetsDir: f.assetsDir }), /PHP/);
  assert.equal(requested.at(-1), phpPath);
  assert.equal(requested.length, 2, 'The provider must resolve the current path separately for each PHP session');
});

test('a failed PHP process does not leave a live session', async t => {
  const f = fixture(t);
  const data = importWebProject({ sourcePath: f.write('index.php', '<?php echo "ok";'), assetsDir: f.assetsDir });
  // Node is deliberately not a PHP executable and rejects PHP CLI flags.
  const runtime = createWebRuntime({ phpPath: process.execPath });
  await assert.rejects(runtime.open({ data, assetsDir: f.assetsDir }), /PHP/);
  await runtime.closeAll();
});

test('closeAll shuts down independent HTML sessions', async t => {
  const f = fixture(t);
  const data = importWebProject({ sourcePath: f.write('index.html', 'ok'), assetsDir: f.assetsDir });
  const runtime = createWebRuntime();
  t.after(() => runtime.closeAll());
  const sessions = await Promise.all([runtime.open({ data, assetsDir: f.assetsDir }), runtime.open({ data, assetsDir: f.assetsDir })]);
  assert.notEqual(sessions[0].token, sessions[1].token);
  const results = await Promise.all(sessions.map(session => request(session.url)));
  assert.notEqual(results[0].headers['set-cookie'][0].split('=')[0], results[1].headers['set-cookie'][0].split('=')[0]);
  await runtime.closeAll();
  for (const session of sessions) await assert.rejects(request(session.url));
});

test('closeAll cancels a session while its listener is still starting', async t => {
  const f = fixture(t);
  const data = importWebProject({ sourcePath: f.write('index.html', 'ok'), assetsDir: f.assetsDir });
  const runtime = createWebRuntime();
  const pending = runtime.open({ data, assetsDir: f.assetsDir });
  const rejected = assert.rejects(pending, /cancelada/);
  await runtime.closeAll();
  await rejected;
  await runtime.closeAll();
});

const phpPath = process.env.LOCAL_WEB_TEST_PHP || ['/usr/bin/php', '/usr/local/bin/php'].find(candidate => fs.existsSync(candidate));
test('real PHP executes GET/POST and exposes the public host to applications', { skip: !phpPath && 'PHP is not installed; native execution and direct backend denial must be verified with the bundled Windows runtime.' }, async t => {
  const f = fixture(t);
  const sourcePath = f.write('index.php', '<?php header("Content-Type: application/json"); echo json_encode(["answer" => 6 * 7, "input" => $_POST["name"] ?? $_GET["name"] ?? "", "port" => $_SERVER["SERVER_PORT"], "host" => $_SERVER["HTTP_HOST"]]);');
  f.write('assets/style.css', 'body{color:red}');
  const data = importWebProject({ sourcePath, includeDirectory: true, assetsDir: f.assetsDir });
  const runtime = createWebRuntime({ phpPath });
  t.after(() => runtime.closeAll());
  const session = await runtime.open({ data, assetsDir: f.assetsDir });
  const result = await request(session.url + '?name=hello');
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).answer, 42);
  assert.equal(JSON.parse(result.body).input, 'hello');
  assert.equal(JSON.parse(result.body).port, new URL(session.url).port);
  assert.equal(JSON.parse(result.body).host, new URL(session.url).host);
  const cookie = result.headers['set-cookie'][0].split(';')[0];
  const posted = await request(session.url, { requestPath: '/index.php', method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=posted' });
  assert.equal(JSON.parse(posted.body).input, 'posted');
  const css = await request(session.url, { requestPath: '/assets/style.css', headers: { Cookie: cookie } });
  assert.equal(css.body, 'body{color:red}');
  await runtime.close(session.token);
  await assert.rejects(request(session.url));
});
