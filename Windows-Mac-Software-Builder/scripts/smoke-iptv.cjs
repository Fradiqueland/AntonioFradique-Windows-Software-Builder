'use strict';

// Native regression gate: synthetic 1080i TS -> production HTTP proxy/FFmpeg ->
// progressive MP4 -> real Chromium compositor callbacks over several seconds.
// No provider URLs, credentials or downloaded video are used. --node-only is a
// diagnostic subset and never claims to verify Electron playback.
const isElectron = Boolean(process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE);
const electron = isElectron ? require('electron') : null;
const fs = isElectron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const execFileP = promisify(execFile);
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const packaged = process.argv.includes('--packaged');
const nodeOnly = process.argv.includes('--node-only');
const mode = packaged ? 'packaged' : 'source';
const reportPath = path.join(root, `build-iptv-smoke-${mode}${nodeOnly ? '-node' : ''}.json`);
const report = { status: 'running', mode, phase: nodeOnly ? 'FFmpeg only' : 'FFmpeg + Electron compositor',
  platform: process.platform, electron: process.versions.electron || null, version: pkg.version, checks: [] };
let temporary;
let server;
let proxy;
let window;
let finishing = false;
const children = new Set();
const tokens = [];
const deadline = setTimeout(() => finish(new Error('IPTV smoke exceeded three minutes.')), 180000);

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  assert.ok(value && !value.startsWith('--'), `Missing value for ${name}`);
  return path.resolve(value);
}

async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  if (proxy) {
    report.proxyStatus = tokens.map(token => proxy.status(token));
    proxy.closeAll();
  }
  if (window && !window.isDestroyed()) window.destroy();
  for (const child of children) { try { child.kill('SIGKILL'); } catch (_) {} }
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  report.status = error ? 'failed' : 'passed';
  if (error) report.error = error.stack || String(error);
  try { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
  catch (cleanupError) { report.cleanupWarning = cleanupError.message; }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  if (error) console.error(error.stack || error);
  else console.log(`IPTV SMOKE PASSED (${mode}, ${report.phase}): ${report.checks.join('; ')}`);
  if (isElectron) electron.app.exit(error ? 1 : 0);
  else process.exitCode = error ? 1 : 0;
}

async function probe(ffprobe, filename, frames = false) {
  const args = frames
    ? ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '0%+3', '-show_frames',
      '-show_entries', 'frame=interlaced_frame,best_effort_timestamp_time', '-of', 'json', filename]
    : ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename];
  const { stdout } = await execFileP(ffprobe, args, { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function streamSummary(stream) {
  return Object.fromEntries(['codec_type', 'codec_name', 'profile', 'level', 'width', 'height', 'pix_fmt',
    'field_order', 'r_frame_rate', 'avg_frame_rate', 'sample_rate', 'channels'].filter(key => key in stream).map(key => [key, stream[key]]));
}

async function main() {
  assert.ok(isElectron || nodeOnly, 'Run with Electron; --node-only runs only the FFmpeg diagnostic subset.');
  assert.ok(!packaged || isElectron, 'Packaged ASAR code must be tested in real Electron.');
  assert.ok(!packaged || (!option('--ffmpeg') && !option('--ffprobe')), 'Packaged tests must use the shipped runtime.');
  const mac = process.platform === 'darwin';
  const resources = packaged ? path.join(root, mac
    ? `dist/builder/mac-universal/${pkg.build.productName}.app/Contents/Resources`
    : 'dist/builder/win-unpacked/resources') : null;
  const applicationRoot = packaged ? path.join(resources, mac ? 'app.asar' : 'app') : root;
  const appRequire = createRequire(path.join(applicationRoot, 'package.json'));
  const proxyModule = appRequire('./src/shared/iptv-proxy');
  report.proxyModule = appRequire.resolve('./src/shared/iptv-proxy');
  let ffmpeg = option('--ffmpeg');
  if (!ffmpeg) {
    assert.ok(['win32', 'darwin'].includes(process.platform), 'Other hosts require an explicit --ffmpeg diagnostic override.');
    const relative = packaged ? null : require('../build-configs/runtime-resources.cjs').runtimeDirectory('ffmpeg', mac ? 'mac-universal' : 'windows-x64');
    assert.ok(packaged || relative, 'The native FFmpeg runtime is missing. Provision it before this gate.');
    ffmpeg = path.join(packaged ? resources : root, packaged ? 'ffmpeg' : relative, mac ? 'ffmpeg' : 'ffmpeg.exe');
  }
  ffmpeg = fs.realpathSync(ffmpeg);
  const ffprobe = fs.realpathSync(option('--ffprobe') || path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'));
  report.ffmpeg = { path: ffmpeg, sha256: crypto.createHash('sha256').update(fs.readFileSync(ffmpeg)).digest('hex') };
  report.ffprobe = ffprobe;
  temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'builder-iptv-smoke-')));
  const fixture = path.join(temporary, 'source-1080i.ts');
  const fixtureArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000', '-t', '6',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high',
    '-pix_fmt', 'yuv420p', '-flags', '+ilme+ildct', '-x264-params', 'tff=1:interlaced=1', '-threads', '2', '-g', '25',
    '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '2', '-f', 'mpegts', fixture];
  await execFileP(ffmpeg, fixtureArgs, { windowsHide: true, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  const input = await probe(ffprobe, fixture);
  const inputVideo = input.streams.find(stream => stream.codec_type === 'video');
  assert.equal(inputVideo.codec_name, 'h264');
  assert.equal(inputVideo.profile, 'High');
  assert.equal(inputVideo.width, 1920);
  assert.equal(inputVideo.height, 1080);
  assert.ok(['tt', 'bb', 'tb', 'bt'].includes(inputVideo.field_order), 'The regression source must really be interlaced.');
  report.fixture = input.streams.map(streamSummary);
  report.checks.push('offline H.264 High 1080i/AAC TS fixture verified by ffprobe');

  const invocations = [];
  proxy = proxyModule.createIptvProxy({ getExecutable: () => ffmpeg, spawnImpl(executable, args, options) {
    invocations.push({ executable, args, shell: options.shell });
    const child = spawn(executable, args, options);
    children.add(child);
    child.once('close', () => children.delete(child));
    return child;
  } });
  assert.equal(await proxy.available(), true, 'The real native runtime must provide the required encoders, filters and MP4 muxer.');
  const fixtureBytes = fs.readFileSync(fixture);
  let sourceRequests = 0;
  server = http.createServer((req, res) => {
    if (req.url === '/fixture.ts') {
      sourceRequests++;
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': fixtureBytes.length, 'Cache-Control': 'no-store' });
      res.end(fixtureBytes);
    } else if (req.url === '/player') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><title>IPTV regression smoke</title><style>html,body{margin:0;background:#000}video{width:960px;height:540px}</style>');
    } else if (/^\/iptv\/[a-f0-9]{24}$/.test(req.url || '')) {
      proxy.serve(req.url.slice('/iptv/'.length), req, res).catch(error => { res.destroy(error); });
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const register = () => { const token = proxy.register(origin + '/fixture.ts'); tokens.push(token); return origin + '/iptv/' + token; };
  const output = path.join(temporary, 'compatibility.mp4');
  const response = await fetch(register(), { signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^video\/mp4/);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(output));
  const converted = await probe(ffprobe, output);
  const video = converted.streams.find(stream => stream.codec_type === 'video');
  const audio = converted.streams.find(stream => stream.codec_type === 'audio');
  assert.equal(video.codec_name, 'h264');
  assert.equal(video.profile, 'Main');
  assert.equal(video.level, 31);
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assert.equal(video.pix_fmt, 'yuv420p');
  assert.equal(video.field_order, 'progressive');
  assert.equal(video.r_frame_rate, '30/1');
  assert.equal(audio.codec_name, 'aac');
  assert.equal(audio.profile, 'LC');
  assert.equal(audio.sample_rate, '48000');
  assert.equal(audio.channels, 2);
  const decoded = (await probe(ffprobe, output, true)).frames;
  assert.ok(decoded.length >= 60, `Expected at least 60 decoded frames, got ${decoded.length}`);
  assert.ok(decoded.every(frame => frame.interlaced_frame === 0), 'All decoded output frames must be progressive.');
  report.output = converted.streams.map(streamSummary);
  report.decodedFrames = decoded.length;
  report.checks.push('production proxy output decodes as progressive H.264 Main 720p30 + AAC-LC stereo');

  if (!nodeOnly) {
    const externalRequests = [];
    let paints = 0;
    window = new electron.BrowserWindow({ width: 960, height: 540, show: false, webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true
    } });
    window.webContents.setFrameRate(30);
    window.webContents.on('paint', () => paints++);
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const allowed = details.url.startsWith(origin + '/') || details.url === 'about:blank';
      if (!allowed) externalRequests.push(details.url);
      callback({ cancel: !allowed });
    });
    await window.loadURL(origin + '/player');
    const url = register();
    report.playback = await window.webContents.executeJavaScript(`(${function playback(url) {
      return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.muted = true; video.autoplay = true; video.playsInline = true;
        let callbacks = 0;
        const samples = [];
        let finished = false;
        const timer = setTimeout(() => end(new Error('No sustained presented video: ' + JSON.stringify({ callbacks, currentTime: video.currentTime, readyState: video.readyState, samples }))), 35000);
        function end(error) {
          if (finished) return;
          finished = true; clearTimeout(timer);
          if (error) reject(error);
          else resolve({ callbacks, currentTime: video.currentTime, width: video.videoWidth, height: video.videoHeight,
            totalVideoFrames: video.getVideoPlaybackQuality().totalVideoFrames, samples });
        }
        video.addEventListener('error', () => end(new Error('Chromium video error ' + (video.error?.code || '?') + ': ' + (video.error?.message || ''))));
        if (typeof video.requestVideoFrameCallback !== 'function') return end(new Error('Chromium frame presentation API is required.'));
        function frame(_now, metadata) {
          if (finished) return;
          callbacks++;
          if (callbacks === 1 || callbacks % 10 === 0) samples.push({ mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames, currentTime: video.currentTime });
          const first = samples[0];
          if (callbacks >= 60 && metadata.presentedFrames >= 60 && metadata.mediaTime - first.mediaTime >= 2 && video.currentTime >= 2) return end();
          video.requestVideoFrameCallback(frame);
        }
        video.requestVideoFrameCallback(frame);
        document.body.appendChild(video);
        video.src = url;
        video.play().catch(end);
      });
    }.toString()})(${JSON.stringify(url)})`, true);
    assert.equal(report.playback.width, 1280);
    assert.equal(report.playback.height, 720);
    assert.ok(report.playback.callbacks >= 60 && report.playback.totalVideoFrames >= 60);
    assert.ok(paints > 0, 'The offscreen compositor must actually paint video.');
    assert.deepEqual(externalRequests, [], 'The smoke must make no external browser requests.');
    report.paints = paints;
    report.checks.push('real Electron: 60+ frame presentation callbacks and 2+ seconds of advancing playback');
  }
  assert.ok(sourceRequests >= (nodeOnly ? 1 : 2), 'Both probes must traverse the HTTP input source.');
  for (const invocation of invocations) {
    assert.equal(invocation.executable, ffmpeg);
    assert.equal(invocation.shell, false);
    assert.equal(invocation.args[invocation.args.indexOf('-c:v') + 1], 'libx264', 'Compatibility mode must transcode video, not stream-copy it.');
    assert.equal(invocation.args[invocation.args.indexOf('-c:a') + 1], 'aac');
    assert.match(invocation.args[invocation.args.indexOf('-vf') + 1], /yadif=.*scale=.*fps=30/);
  }
  report.sourceRequests = sourceRequests;
  report.transcodeInvocations = invocations;
  await finish();
}

if (isElectron) {
  electron.app.disableHardwareAcceleration();
  electron.app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  electron.app.whenReady().then(main).catch(finish);
} else main().catch(finish);
