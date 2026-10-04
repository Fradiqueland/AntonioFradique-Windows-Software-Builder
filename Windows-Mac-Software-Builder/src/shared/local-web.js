'use strict';

// HTML is served without Electron privileges. PHP is native, trusted code: this
// module restricts HTTP access, but it is NOT an operating-system PHP sandbox.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

const LIMITS = Object.freeze({ files: 2000, fileBytes: 32 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 });
const ROOT_PATTERN = /^dist-assets\/web-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENTRY_PATTERN = /\.(?:html?|php)$/i;
const PHP_SOURCE_PATTERN = /\.(?:php\d*|phtml|phar|inc)$/i;
const COOKIE_NAME = 'local-web-session';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf', '.wasm': 'application/wasm'
};

function isSafeName(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' &&
    !/[\\/:<>"|?*\x00-\x1f\x7f]/.test(name) && !name.endsWith('.') && !name.endsWith(' ') &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

function isIgnored(name) {
  return name.startsWith('.') || name.toLowerCase() === 'node_modules';
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assetsPath(assetsDir, create = false) {
  if (typeof assetsDir !== 'string' || !path.isAbsolute(assetsDir)) {
    throw new Error('A pasta de recursos deve ser um caminho absoluto.');
  }
  if (create) fs.mkdirSync(assetsDir, { recursive: true });
  const stat = fs.lstatSync(assetsDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('A pasta de recursos não é válida.');
  return fs.realpathSync(assetsDir);
}

function managedPaths({ data, assetsDir }) {
  if (!data || typeof data.root !== 'string' || !ROOT_PATTERN.test(data.root)) {
    throw new Error('O diretório do módulo web não é válido.');
  }
  const base = assetsPath(assetsDir);
  const rootPath = path.join(base, data.root.slice('dist-assets/'.length));
  const stat = fs.lstatSync(rootPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('O diretório do módulo web não é válido.');
  const realRoot = fs.realpathSync(rootPath);
  if (!isInside(base, realRoot)) throw new Error('O módulo web está fora da pasta de recursos.');
  return { rootPath: realRoot };
}

function walkFiles(root, visitor) {
  const totals = { fileCount: 0, totalBytes: 0, requiresPhp: false };
  let entries = 0;
  function walk(directory, prefix = '', depth = 0) {
    if (depth > 32) throw new Error('O projeto excede o limite de 32 níveis de pastas.');
    for (const name of fs.readdirSync(directory)) {
      if (isIgnored(name)) continue;
      if (++entries > LIMITS.files * 2) throw new Error('O projeto contém demasiados ficheiros ou pastas.');
      if (!isSafeName(name)) throw new Error(`Nome de ficheiro não permitido: ${name}`);
      const absolute = path.join(directory, name);
      const relative = prefix ? path.join(prefix, name) : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Ligações simbólicas não são permitidas: ${relative}`);
      if (stat.isDirectory()) {
        walk(absolute, relative, depth + 1);
      } else if (stat.isFile()) {
        totals.fileCount++;
        totals.totalBytes += stat.size;
        if (totals.fileCount > LIMITS.files || stat.size > LIMITS.fileBytes || totals.totalBytes > LIMITS.totalBytes) {
          throw new Error('O projeto excede os limites: 2000 ficheiros, 32 MB por ficheiro ou 256 MB no total.');
        }
        if (/\.php$/i.test(name)) totals.requiresPhp = true;
        if (visitor) visitor(absolute, relative, stat);
      } else {
        throw new Error(`Tipo de ficheiro não permitido: ${relative}`);
      }
    }
  }
  walk(root);
  return totals;
}

function copyRegularFile(source, destination, expectedStat) {
  // A fixed-size read prevents a source growing during import from bypassing
  // the limits. O_NOFOLLOW additionally rejects a last-moment link on POSIX.
  const input = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const actual = fs.fstatSync(input);
    if (!actual.isFile() || actual.size !== expectedStat.size || actual.ino !== expectedStat.ino) {
      throw new Error('O ficheiro de origem mudou durante a importação.');
    }
    const buffer = Buffer.alloc(actual.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(input, buffer, offset, buffer.length - offset, null);
      if (!count) throw new Error('O ficheiro de origem mudou durante a importação.');
      offset += count;
    }
    if (fs.readSync(input, Buffer.alloc(1), 0, 1, null)) throw new Error('O ficheiro de origem mudou durante a importação.');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, buffer, { flag: 'wx', mode: 0o600 });
  } finally {
    fs.closeSync(input);
  }
}

function importWebProject({ sourcePath, includeDirectory = false, assetsDir }) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) throw new Error('Selecione um ficheiro local com caminho absoluto.');
  const entry = path.basename(sourcePath);
  if (!isSafeName(entry) || isIgnored(entry) || !ENTRY_PATTERN.test(entry)) throw new Error('Selecione um ficheiro .html, .htm ou .php.');
  const sourceStat = fs.lstatSync(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('A origem deve ser um ficheiro normal, sem ligação simbólica.');
  const base = assetsPath(assetsDir, true);
  const sourceDirectory = fs.realpathSync(path.dirname(sourcePath));
  if (includeDirectory && (base === sourceDirectory || isInside(sourceDirectory, base))) {
    throw new Error('A pasta de origem não pode conter a pasta de recursos do projeto.');
  }
  const root = `dist-assets/web-${crypto.randomUUID()}`;
  const rootPath = path.join(base, root.slice('dist-assets/'.length));
  fs.mkdirSync(rootPath, { mode: 0o700 });
  try {
    if (includeDirectory) {
      walkFiles(sourceDirectory, (source, relative, stat) => copyRegularFile(source, path.join(rootPath, relative), stat));
    } else {
      if (sourceStat.size > LIMITS.fileBytes) throw new Error('O ficheiro excede o limite de 32 MB.');
      copyRegularFile(sourcePath, path.join(rootPath, entry), sourceStat);
    }
    const summary = walkFiles(rootPath);
    if (!fs.existsSync(path.join(rootPath, entry))) throw new Error('O ficheiro inicial não foi importado.');
    return { root, entry, fileName: entry, requiresPhp: summary.requiresPhp, fileCount: summary.fileCount };
  } catch (error) {
    fs.rmSync(rootPath, { recursive: true, force: true });
    throw error;
  }
}

function validateWebProject({ data, assetsDir }) {
  const { rootPath } = managedPaths({ data, assetsDir });
  if (!isSafeName(data.entry) || isIgnored(data.entry) || !ENTRY_PATTERN.test(data.entry)) {
    throw new Error('O ficheiro inicial do módulo web não é válido.');
  }
  const entryPath = path.join(rootPath, data.entry);
  const stat = fs.lstatSync(entryPath);
  if (!stat.isFile() || stat.isSymbolicLink() || !isInside(rootPath, fs.realpathSync(entryPath))) {
    throw new Error('O ficheiro inicial do módulo web não é válido.');
  }
  const summary = walkFiles(rootPath);
  return { rootPath, entryPath, entry: data.entry, fileName: data.entry, ...summary };
}

function removeWebProject({ data, assetsDir }) {
  // Never accept arbitrary directories, even when restoring a malformed project.
  try {
    const { rootPath } = managedPaths({ data, assetsDir });
    fs.rmSync(rootPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' && data && ROOT_PATTERN.test(data.root)) return false;
    throw error;
  }
}

function safeRequestPath(rawPath) {
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch (_) { return null; }
  if (!decoded.startsWith('/') || /[\\:\x00-\x1f\x7f]/.test(decoded)) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some(name => !isSafeName(name) || isIgnored(name))) return null;
  return segments;
}

function requestFile(root, segments) {
  let candidate = path.join(root, ...segments);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) return null;
  }
  if (fs.statSync(candidate).isDirectory()) {
    candidate = ['index.html', 'index.htm', 'index.php'].map(name => path.join(candidate, name)).find(name => fs.existsSync(name));
    if (!candidate || fs.lstatSync(candidate).isSymbolicLink()) return null;
  }
  if (!fs.statSync(candidate).isFile() || !isInside(root, fs.realpathSync(candidate))) return null;
  return candidate;
}

function respond(response, status, message) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(message);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
  });
}

function stopServer(server) {
  if (!server || !server.listening) return Promise.resolve();
  return new Promise(resolve => {
    server.close(resolve);
    if (server.closeAllConnections) server.closeAllConnections();
  });
}

function stopChild(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500);
    timer.unref();
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

function routerSource(rootPath, backendToken, port) {
  const encodedRoot = Buffer.from(rootPath).toString('base64');
  return `<?php
// Generated guard. This is access control, not a PHP/OS sandbox.
$root = base64_decode('${encodedRoot}');
if (($_SERVER['HTTP_HOST'] ?? '') !== '127.0.0.1:${port}' || !hash_equals('${backendToken}', $_SERVER['HTTP_X_LOCAL_WEB_AUTH'] ?? '')) { http_response_code(403); exit; }
if ($_SERVER['REQUEST_URI'] === '/__local_web_ready__') { http_response_code(204); exit; }
$publicHost = $_SERVER['HTTP_X_LOCAL_WEB_PUBLIC_HOST'] ?? '';
if (!preg_match('/^127\\.0\\.0\\.1:[0-9]+$/D', $publicHost)) { http_response_code(403); exit; }
$_SERVER['HTTP_HOST'] = $publicHost;
$_SERVER['SERVER_NAME'] = '127.0.0.1';
$_SERVER['SERVER_PORT'] = substr($publicHost, strrpos($publicHost, ':') + 1);
unset($_SERVER['HTTP_X_LOCAL_WEB_AUTH'], $_SERVER['HTTP_X_LOCAL_WEB_PUBLIC_HOST']);
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$decoded = rawurldecode($uri === false || $uri === null ? '' : $uri);
if ($decoded === '' || $decoded[0] !== '/' || preg_match('/[\\\\\\\\:\\x00-\\x1f\\x7f]/', $decoded)) { http_response_code(403); exit; }
$parts = array_values(array_filter(explode('/', $decoded), 'strlen'));
foreach ($parts as $part) {
  if ($part[0] === '.' || strtolower($part) === 'node_modules' || preg_match('/[. ]$/', $part)) { http_response_code(403); exit; }
}
$target = $root;
foreach ($parts as $part) { $target .= DIRECTORY_SEPARATOR . $part; if (is_link($target)) { http_response_code(403); exit; } }
if (is_dir($target)) {
  $found = false;
  foreach (array('index.html', 'index.htm', 'index.php') as $index) { if (is_file($target . DIRECTORY_SEPARATOR . $index)) { $target .= DIRECTORY_SEPARATOR . $index; $found = true; break; } }
  if (!$found) { http_response_code(404); exit; }
}
$real = realpath($target);
$prefix = realpath($root) . DIRECTORY_SEPARATOR;
$check = $real;
if (DIRECTORY_SEPARATOR === '\\\\') { $prefix = strtolower($prefix); $check = strtolower($check === false ? '' : $check); }
if ($real === false || !is_file($real) || is_link($target) || strpos($check, $prefix) !== 0) { http_response_code(404); exit; }
if (preg_match('/\\.(php[0-9]*|phtml|phar|inc)$/i', $real) && !preg_match('/\\.php$/i', $real)) { http_response_code(403); exit; }
if (preg_match('/\\.php$/i', $real)) {
  $_SERVER['SCRIPT_FILENAME'] = $real;
  $_SERVER['SCRIPT_NAME'] = '/' . str_replace(DIRECTORY_SEPARATOR, '/', substr($real, strlen(realpath($root)) + 1));
  $_SERVER['PHP_SELF'] = $_SERVER['SCRIPT_NAME'];
  chdir(dirname($real));
  require $real;
  return true;
}
return false;
`;
}

async function startPhp(record, phpPath) {
  if (typeof phpPath !== 'string' || !path.isAbsolute(phpPath)) {
    throw new Error('Este módulo necessita de PHP. Instale o runtime PHP incluído na pasta vendor/php e volte a gerar a aplicação.');
  }
  let stat;
  try { stat = fs.statSync(phpPath); } catch (_) { /* handled below */ }
  if (!stat || !stat.isFile()) throw new Error('O runtime PHP configurado não foi encontrado. Instale-o na pasta vendor/php.');
  const reservation = http.createServer();
  const port = await listen(reservation);
  await stopServer(reservation);
  if (record.cancelled) throw new Error('A abertura do módulo web foi cancelada.');
  record.tempPath = fs.mkdtempSync(path.join(os.tmpdir(), 'software-builder-web-'));
  const routerPath = path.join(record.tempPath, 'router.php');
  record.backendToken = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(routerPath, routerSource(record.project.rootPath, record.backendToken, port), { mode: 0o600 });
  const phpEnvironment = { ...process.env };
  // Prevent inherited CLI settings from forking untracked server workers.
  delete phpEnvironment.PHP_CLI_SERVER_WORKERS;
  const child = spawn(phpPath, ['-n', '-d', 'expose_php=0', '-d', 'display_errors=0', '-d', 'log_errors=1',
    '-d', 'user_ini.filename=', '-d', 'allow_url_include=0', '-S', `127.0.0.1:${port}`, '-t', record.project.rootPath, routerPath],
  { cwd: record.project.rootPath, env: phpEnvironment, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], shell: false });
  record.child = child;
  record.backendPort = port;
  // Keep stderr drained without retaining PHP content, secrets or request URLs.
  child.stderr.on('data', () => {});
  await new Promise((resolve, reject) => {
    let completed = false;
    let pollTimer;
    let probe;
    const startupTimer = setTimeout(() => finish(new Error('O runtime PHP não arrancou dentro de 8 segundos.')), 8000);
    function finish(error) {
      if (completed) return;
      completed = true;
      clearTimeout(startupTimer);
      clearTimeout(pollTimer);
      if (probe) probe.destroy();
      child.removeListener('error', failed);
      child.removeListener('exit', exited);
      error ? reject(error) : resolve();
    }
    function failed() { finish(new Error('Não foi possível iniciar o runtime PHP configurado.')); }
    function exited() { finish(new Error('O runtime PHP terminou antes de ficar disponível.')); }
    child.once('error', failed);
    child.once('exit', exited);
    function poll() {
      if (record.cancelled) return finish(new Error('A abertura do módulo web foi cancelada.'));
      probe = http.get({ hostname: '127.0.0.1', port, path: '/__local_web_ready__',
        headers: { 'X-Local-Web-Auth': record.backendToken }, timeout: 300 }, response => {
        response.resume();
        if (response.statusCode === 204) finish();
        else finish(new Error('O runtime PHP respondeu sem validar o acesso local.'));
      });
      probe.on('timeout', () => probe.destroy());
      probe.on('error', () => { if (!completed) pollTimer = setTimeout(poll, 80); });
    }
    poll();
  });
  // Keep a listener after startup so a late process error cannot crash Electron.
  child.on('error', () => {});
}

function createWebRuntime({ phpPath } = {}) {
  const sessions = new Map();

  async function dispose(record) {
    await stopServer(record.server);
    await stopChild(record.child);
    if (record.tempPath) fs.rmSync(record.tempPath, { recursive: true, force: true });
  }

  async function open({ data, assetsDir }) {
    const project = validateWebProject({ data, assetsDir });
    const token = crypto.randomBytes(32).toString('hex');
    const cookieName = `${COOKIE_NAME}-${token.slice(0, 16)}`;
    const record = { project, token, cancelled: false };
    sessions.set(token, record);
    record.started = (async () => {
      if (project.requiresPhp) await startPhp(record, phpPath);
      if (record.cancelled) throw new Error('A abertura do módulo web foi cancelada.');
      record.server = http.createServer((request, response) => {
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('Cache-Control', 'no-store');
        const host = `127.0.0.1:${record.port}`;
        if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== `http://${host}`) ||
          request.headers['sec-fetch-site'] === 'cross-site') return respond(response, 403, 'Acesso local não autorizado.');
        const raw = request.url || '';
        if (!raw.startsWith('/') || raw.startsWith('//')) return respond(response, 400, 'Pedido inválido.');
        const split = raw.indexOf('?');
        let requestPath = split < 0 ? raw : raw.slice(0, split);
        const query = split < 0 ? '' : raw.slice(split);
        const tokenPrefix = `/${token}/`;
        const hasToken = requestPath.startsWith(tokenPrefix);
        const cookie = (request.headers.cookie || '').split(';').map(value => value.trim());
        if (!hasToken && !cookie.includes(`${cookieName}=${token}`)) return respond(response, 403, 'Acesso local não autorizado.');
        if (hasToken) {
          requestPath = requestPath.slice(tokenPrefix.length - 1);
          response.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);
        }
        const segments = safeRequestPath(requestPath);
        if (!segments) return respond(response, 403, 'Caminho não permitido.');
        let file;
        try { file = requestFile(project.rootPath, segments); } catch (_) { /* missing/unreadable path */ }
        if (!file) return respond(response, 404, 'Ficheiro não encontrado.');
        if (PHP_SOURCE_PATTERN.test(file) && (!record.backendPort || !/\.php$/i.test(file))) {
          return respond(response, 403, 'O código PHP não pode ser servido como ficheiro estático.');
        }
        if (record.backendPort) {
          if (record.child.exitCode !== null || record.child.signalCode !== null) return respond(response, 503, 'O runtime PHP terminou. Feche e reabra o módulo.');
          const upstream = http.request({ hostname: '127.0.0.1', port: record.backendPort,
            path: '/' + segments.map(encodeURIComponent).join('/') + (requestPath.endsWith('/') ? '/' : '') + query,
            method: request.method,
            headers: { ...request.headers, host: `127.0.0.1:${record.backendPort}`, 'x-local-web-auth': record.backendToken,
              'x-local-web-public-host': host, connection: 'close' },
            timeout: 30000 }, result => {
            const headers = { ...result.headers };
            delete headers.connection;
            delete headers['transfer-encoding'];
            // Preserve our session cookie when a PHP application sets its own.
            if (hasToken) headers['set-cookie'] = [response.getHeader('Set-Cookie'), ...(headers['set-cookie'] || [])];
            headers['x-content-type-options'] = 'nosniff';
            headers['referrer-policy'] = 'no-referrer';
            headers['cache-control'] = 'no-store';
            response.writeHead(result.statusCode || 502, headers);
            result.pipe(response);
          });
          upstream.on('timeout', () => upstream.destroy());
          upstream.on('error', () => {
            if (!response.headersSent) respond(response, 502, 'O runtime PHP não respondeu ao pedido.');
            else response.destroy();
          });
          request.on('aborted', () => upstream.destroy());
          response.on('close', () => upstream.destroy());
          request.pipe(upstream);
          return;
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') return respond(response, 405, 'Método não permitido em conteúdo HTML.');
        try {
          const stat = fs.statSync(file);
          response.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size });
          if (request.method === 'HEAD') return response.end();
          const stream = fs.createReadStream(file);
          stream.on('error', () => response.destroy());
          response.on('close', () => stream.destroy());
          stream.pipe(response);
        } catch (_) {
          if (!response.headersSent) respond(response, 404, 'Ficheiro não encontrado.');
          else response.destroy();
        }
      });
      record.server.requestTimeout = 30000;
      record.server.headersTimeout = 10000;
      record.port = await listen(record.server);
      if (record.cancelled) throw new Error('A abertura do módulo web foi cancelada.');
      return { url: `http://127.0.0.1:${record.port}/${token}/${encodeURIComponent(project.entry)}`, token };
    })();
    try {
      return await record.started;
    } catch (error) {
      await dispose(record);
      sessions.delete(token);
      throw error;
    }
  }

  async function close(token) {
    const record = sessions.get(token);
    if (!record) return;
    record.cancelled = true;
    try { await record.started; } catch (_) { /* startup may have been cancelled */ }
    await dispose(record);
    sessions.delete(token);
  }

  async function closeAll() {
    await Promise.all([...sessions.keys()].map(close));
  }

  return { open, close, closeAll };
}

module.exports = { importWebProject, validateWebProject, removeWebProject, createWebRuntime, LIMITS };
