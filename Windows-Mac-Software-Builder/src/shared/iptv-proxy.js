'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20';
const TOKEN = /^[a-f0-9]{24}$/;
const REQUIRED = {
  '-encoders': ['libx264', 'aac'],
  '-filters': ['yadif', 'scale', 'format', 'fps', 'aresample'],
  '-muxers': ['mp4']
};

function compatibilityArgs(url) {
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    // A remote playlist must not turn into local-file or arbitrary-protocol IO.
    '-protocol_whitelist', 'http,https,tcp,tls,crypto', '-user_agent', USER_AGENT,
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '3', '-rw_timeout', '15000000',
    '-fflags', '+genpts+discardcorrupt', '-analyzeduration', '3000000', '-probesize', '3000000',
    '-threads', '2', '-filter_threads', '2',
    '-i', url, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn',
    '-vf', "yadif=mode=send_frame:parity=auto:deint=interlaced,scale=w='min(iw,1280)':h='min(ih,720)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p,fps=30",
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'main', '-level:v', '3.1',
    '-crf', '23', '-maxrate', '4M', '-bufsize', '8M', '-threads', '2',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-flags', '+cgop',
    '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-af', 'aresample=async=1:first_pts=0',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000', 'pipe:1'
  ];
}

function parseTarget(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('URL de stream inválido.');
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw new Error('URL de stream inválido.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('URL de stream inválido.');
  return parsed;
}

function diagnosticRedactor(url) {
  const parsed = parseTarget(url);
  const values = [parsed.username, parsed.password];
  for (const name of ['username', 'password', 'user', 'pass', 'token', 'auth', 'key']) values.push(parsed.searchParams.get(name));
  const account = parsed.pathname.match(/\/(?:live|movie|series)\/([^/]+)\/([^/]+)\//i);
  if (account) values.push(account[1], account[2]);
  const secrets = new Set();
  for (const value of values) if (value) {
    secrets.add(value);
    try { secrets.add(decodeURIComponent(value)); } catch (_) { /* malformed escapes stay redacted verbatim */ }
  }
  return value => {
    let text = String(value).replace(/https?:\/\/[^\s"'<>]+/gi, '[URL omitido]');
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[credencial omitida]');
    return text.replace(/(?:username|password|token|authorization)\s*[:=]\s*\S+/gi, '[credencial omitida]').slice(0, 800);
  };
}

function createIptvProxy({ getExecutable, spawnImpl = spawn, execFileImpl = execFile,
  startupTimeoutMs = 20000, inactivityTimeoutMs = 15000, completionTimeoutMs = 5000 } = {}) {
  const targets = new Map();
  const runs = new Map();
  let capabilityKey;
  let capabilityPromise;

  async function available() {
    let executable;
    let stat;
    try {
      executable = getExecutable && getExecutable();
      if (typeof executable !== 'string' || !path.isAbsolute(executable)) return false;
      executable = fs.realpathSync(executable);
      stat = fs.statSync(executable);
      if (!stat.isFile()) return false;
      if (process.platform !== 'win32') fs.accessSync(executable, fs.constants.X_OK);
    } catch (_) { return false; }
    const key = `${executable}:${stat.size}:${stat.mtimeMs}`;
    if (key === capabilityKey) return capabilityPromise;
    capabilityKey = key;
    capabilityPromise = Promise.all(Object.entries(REQUIRED).map(([flag, names]) => new Promise(resolve => {
      try {
        execFileImpl(executable, ['-hide_banner', flag], { windowsHide: true, shell: false, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
          const output = String(stdout || '');
          resolve(!error && names.every(name => new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, 'm').test(output)));
        });
      } catch (_) { resolve(false); }
    }))).then(results => results.every(Boolean));
    return capabilityPromise;
  }

  function register(url) {
    parseTarget(url);
    for (const [token, target] of targets) if (Date.now() - target.createdAt > 3600000) stop(token);
    while (targets.size >= 64) stop(targets.keys().next().value);
    const token = crypto.randomBytes(12).toString('hex');
    targets.set(token, { url, createdAt: Date.now() });
    return token;
  }

  function endRun(run, status = 0, message) {
    if (!run || run.stopped) return;
    run.stopped = true;
    clearTimeout(run.startup);
    clearTimeout(run.inactivity);
    clearTimeout(run.completion);
    if (message) log(run, message);
    if (run.child) { try { run.child.kill('SIGKILL'); } catch (_) { /* already exited */ } }
    if (status && !run.response.destroyed) {
      if (!run.response.headersSent) {
        run.response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        run.response.end('Não foi possível converter o canal para reprodução. Consulte o diagnóstico.');
      } else run.response.destroy();
    } else if (!run.response.destroyed && !run.response.writableEnded) run.response.destroy();
  }

  function log(run, message) {
    const safe = run.redact(message).trim();
    if (safe) { run.log.push(safe); if (run.log.length > 40) run.log.shift(); }
  }

  function stop(token) {
    endRun(runs.get(token));
    runs.delete(token);
    targets.delete(token);
  }

  function status(token) {
    const run = runs.get(String(token || ''));
    return run ? { running: !run.stopped && !!run.child, exitCode: run.exitCode, log: run.log.slice(-12), mode: 'compatibility' } : null;
  }

  async function serve(token, request, response) {
    const expectedHost = `127.0.0.1:${request.socket.localPort}`;
    if (request.headers.host !== expectedHost || (request.headers.origin && request.headers.origin !== 'null' && request.headers.origin !== `http://${expectedHost}`)) {
      response.writeHead(403); response.end(); return;
    }
    const target = TOKEN.test(token) && targets.get(token);
    if (!target) { response.writeHead(404); response.end(); return; }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
    // Live transcoding is not seekable. Chromium's initial bytes=0- request is
    // allowed as a normal 200 stream; later byte seeks must not restart a live
    // channel while pretending to honour an unavailable Content-Range.
    if (request.headers.range && !/^bytes=0-(?:\d+)?$/i.test(request.headers.range.trim())) {
      response.writeHead(416, { 'Accept-Ranges': 'none' }); response.end(); return;
    }
    if (!await available()) { if (!response.destroyed) { response.writeHead(503); response.end(); } return; }
    if (response.destroyed || request.aborted) return;
    if (targets.get(token) !== target) { response.writeHead(410); response.end(); return; }
    const headers = { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Accept-Ranges': 'none', 'X-Content-Type-Options': 'nosniff' };
    if (request.method === 'HEAD') { response.writeHead(200, headers); response.end(); return; }
    endRun(runs.get(token));
    const run = { child: null, response, log: [], exitCode: null, stopped: false, outputEnded: false,
      processClosed: false, bytes: 0, stderr: '', redact: diagnosticRedactor(target.url) };
    runs.set(token, run);
    log(run, 'Modo de compatibilidade: H.264 Main 720p/30, vídeo progressivo e áudio AAC.');
    const fail = message => { run.exitCode = run.exitCode == null ? -1 : run.exitCode; endRun(run, 502, message); };
    const watchInactivity = () => {
      clearTimeout(run.inactivity);
      run.inactivity = setTimeout(() => endRun(run, 504, 'O conversor deixou de produzir dados.'), inactivityTimeoutMs);
    };
    const finishOutput = () => {
      if (run.stopped) return;
      clearTimeout(run.startup);
      clearTimeout(run.inactivity);
      if (run.outputEnded && run.processClosed && run.exitCode === 0) {
        clearTimeout(run.completion);
        response.end();
      } else if (!run.completion) {
        // stdout EOF is not proof of a successful conversion. The process may
        // still report failure, or remain alive after closing its output pipe.
        run.completion = setTimeout(() => fail('O conversor não confirmou a conclusão dentro do tempo limite.'), completionTimeoutMs);
      }
    };
    response.on('error', () => endRun(run));
    response.on('close', () => endRun(run));
    request.on('aborted', () => endRun(run));
    run.startup = setTimeout(() => endRun(run, 504, 'Sem saída do conversor dentro do tempo limite.'), startupTimeoutMs);
    try {
      const executable = getExecutable();
      const child = spawnImpl(executable, compatibilityArgs(target.url), { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      run.child = child;
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        run.stderr += String(chunk);
        if (run.stderr.length > 16384) { run.stderr = ''; log(run, '[diagnóstico demasiado longo omitido]'); return; }
        const lines = run.stderr.split(/\r?\n/);
        run.stderr = lines.pop();
        for (const line of lines) log(run, line);
      });
      child.stdout.on('data', chunk => {
        if (run.stopped || response.destroyed) return;
        clearTimeout(run.startup);
        watchInactivity();
        run.bytes += chunk.length;
        if (!response.headersSent) response.writeHead(200, headers);
        if (!response.write(chunk)) {
          // A full browser buffer is backpressure, not a stalled provider.
          clearTimeout(run.inactivity);
          child.stdout.pause();
        }
      });
      response.on('drain', () => { if (!run.stopped) { watchInactivity(); child.stdout.resume(); } });
      child.stdout.on('end', () => {
        if (run.stopped) return;
        if (!run.bytes) { fail('O conversor terminou sem produzir vídeo.'); return; }
        run.outputEnded = true;
        finishOutput();
      });
      child.stdout.on('error', () => fail('Falha na saída do conversor.'));
      child.stderr.on('error', () => {});
      child.on('error', error => fail(`Não foi possível iniciar o conversor${error.code ? ` (${error.code})` : ''}.`));
      child.on('exit', code => { if (Number.isInteger(code)) run.exitCode = code; });
      child.on('close', (code, signal) => {
        if (run.stderr) { log(run, run.stderr); run.stderr = ''; }
        if (Number.isInteger(code) && code !== 0) log(run, `O conversor terminou com código ${code}.`);
        if (Number.isInteger(code)) run.exitCode = code;
        else if (!run.stopped) run.exitCode = -1;
        run.child = null;
        run.processClosed = true;
        if (run.stopped) return;
        if (code !== 0 || signal) {
          fail(signal ? `O conversor foi interrompido pelo sinal ${signal}.` : 'A conversão terminou com erro.');
        } else if (!run.bytes) fail('O conversor terminou sem produzir vídeo.');
        else finishOutput();
      });
    } catch (_) { fail('Não foi possível iniciar o conversor.'); }
  }

  function closeAll() { for (const token of [...targets.keys()]) stop(token); }
  return { available, register, serve, status, stop, closeAll };
}

module.exports = { createIptvProxy, compatibilityArgs, diagnosticRedactor };
