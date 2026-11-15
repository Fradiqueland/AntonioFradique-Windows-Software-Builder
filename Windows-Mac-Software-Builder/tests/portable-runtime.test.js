'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { importPortableProject } = require('../src/shared/portable-app');
const { launchPortableProject, validateWineConfiguration } = require('../src/shared/portable-runtime');
const unixModeTest = { skip: process.platform === 'win32' && 'Windows fixtures cannot preserve Unix executable permission bits; native Mac launch is tested on macOS/Linux.' };

function pe(machine = 0x8664) {
  const buffer = Buffer.alloc(512);
  buffer.write('MZ', 0);
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.writeUInt32LE(0x4550, 0x80);
  buffer.writeUInt16LE(machine, 0x84);
  buffer.writeUInt16LE(240, 0x94);
  buffer.writeUInt16LE(2, 0x96);
  buffer.writeUInt16LE(machine === 0x14c ? 0x10b : 0x20b, 0x98);
  return buffer;
}

function macho(cpu = 0x1000007) {
  const buffer = Buffer.alloc(64);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(cpu, 4);
  buffer.writeUInt32LE(2, 12);
  return buffer;
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portable-runtime-test-')));
  const source = path.join(root, 'portable source');
  const assetsDir = path.join(root, 'extracted viewer', 'dist-assets');
  const storageDir = path.join(root, 'persistent');
  fs.mkdirSync(source);
  fs.mkdirSync(assetsDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(relative, data, mode = 0o644) {
    const filename = path.join(source, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, data, { mode });
    return filename;
  }
  function imported(entries, allowWine = false) {
    return importPortableProject({ sourcePath: source, assetsDir, entries, allowWine });
  }
  return { root, source, assetsDir, storageDir, write, imported };
}

function spawned(calls, behavior = 'success') {
  return (executable, args, options) => {
    const child = new EventEmitter();
    child.unref = () => { child.unreferenced = true; };
    child.kill = () => { child.killed = true; };
    calls.push({ executable, args, options, child });
    process.nextTick(() => {
      if (behavior === 'error') child.emit('error', Object.assign(new Error('bad'), { code: 'ENOEXEC' }));
      else {
        child.emit('spawn');
        if (behavior === 'success') child.emit('exit', 0, null);
        if (behavior === 'failure') child.emit('exit', 7, null);
      }
    });
    return child;
  };
}

function preparedWine(f) {
  const executable = path.join(f.root, 'Wine Runtime');
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const prefix = path.join(f.root, 'prepared prefix');
  fs.mkdirSync(prefix);
  fs.writeFileSync(path.join(prefix, 'system.reg'), 'WINE REGISTRY Version 2\n');
  fs.writeFileSync(path.join(prefix, 'user.reg'), 'WINE REGISTRY Version 2\n');
  return { executable, prefix };
}

test('Windows launches a persistent physical copy without a shell and with launcher cwd', async t => {
  const f = fixture(t);
  const input = f.write('program dir/run.exe', pe());
  assert.equal(fs.statSync(input).mode & 0o111, 0, 'Windows portable code must not require Unix execute bits');
  f.write('program dir/settings.ini', 'original');
  const data = f.imported({ windows: 'program dir/run.exe', mac: null });
  const calls = [];
  const result = await launchPortableProject({ data, ...f, platform: 'win32', arch: 'x64', spawnImpl: spawned(calls) });
  assert.deepEqual(result, { ok: true, via: 'native' });
  const launch = calls[0];
  assert.equal(launch.executable.startsWith(f.storageDir + path.sep), true);
  assert.equal(launch.executable.includes('extracted viewer'), false);
  assert.equal(launch.options.cwd, path.dirname(launch.executable));
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.detached, true);
  assert.equal(launch.options.stdio, 'ignore');
  assert.deepEqual(launch.args, []);
  assert.equal(launch.child.unreferenced, true);
  assert.deepEqual(fs.readFileSync(launch.executable), pe());
});

test('reopening the same revision preserves settings even after SFX extraction is removed', async t => {
  const f = fixture(t);
  f.write('run.exe', pe());
  f.write('settings.ini', 'original');
  const data = f.imported({ windows: 'run.exe' });
  const calls = [];
  const options = { data, ...f, platform: 'win32', arch: 'x64', spawnImpl: spawned(calls) };
  await launchPortableProject(options);
  const settings = path.join(calls[0].options.cwd, 'settings.ini');
  fs.writeFileSync(settings, 'user changes');
  fs.rmSync(f.assetsDir, { recursive: true, force: true });
  await launchPortableProject(options);
  assert.equal(calls[0].executable, calls[1].executable);
  assert.equal(fs.readFileSync(settings, 'utf8'), 'user changes');
});

test('a new import revision gets its own working copy', async t => {
  const f = fixture(t);
  f.write('run.exe', pe());
  const data = f.imported({ windows: 'run.exe' });
  const calls = [];
  const options = { ...f, platform: 'win32', arch: 'x64', spawnImpl: spawned(calls) };
  await launchPortableProject({ ...options, data });
  await launchPortableProject({ ...options, data: { ...data, revision: crypto.randomUUID() } });
  assert.notEqual(calls[0].executable, calls[1].executable);
});

test('Mac prefers its native app and asks LaunchServices to open the copied bundle', unixModeTest, async t => {
  const f = fixture(t);
  f.write('windows.exe', pe());
  f.write('Example.app/Contents/Info.plist', '<plist><dict><key>CFBundleExecutable</key><string>Example</string></dict></plist>');
  f.write('Example.app/Contents/MacOS/Example', macho(), 0o755);
  const data = f.imported({ windows: 'windows.exe', mac: 'Example.app' }, true);
  const opens = [];
  const result = await launchPortableProject({ data, ...f, platform: 'darwin', arch: 'x64',
    spawnImpl: () => assert.fail('native Mac app must not use Wine'),
    execFileImpl: (executable, args, options, callback) => { opens.push({ executable, args, options }); process.nextTick(() => callback(null)); } });
  assert.deepEqual(result, { ok: true, via: 'native' });
  assert.equal(opens[0].executable, '/usr/bin/open');
  assert.deepEqual(opens[0].args.slice(0, 2), ['-n', '-a']);
  assert.equal(opens[0].args[2].startsWith(f.storageDir + path.sep), true);
  assert.equal(opens[0].args[2].endsWith('Example.app'), true);
  assert.equal(opens[0].options.cwd, path.dirname(opens[0].args[2]));
  assert.equal(opens[0].options.shell, false);
  assert.equal(fs.statSync(path.join(opens[0].args[2], 'Contents/MacOS/Example')).mode & 0o111, 0o111);
});

test('bare Mach-O uses native spawn and retains its execute permission', unixModeTest, async t => {
  const f = fixture(t);
  f.write('native-tool', macho(), 0o755);
  const data = f.imported({ mac: 'native-tool' });
  const calls = [];
  await launchPortableProject({ data, ...f, platform: 'darwin', arch: 'arm64', spawnImpl: spawned(calls) });
  assert.equal(path.basename(calls[0].executable), 'native-tool');
  assert.equal(calls[0].options.cwd, path.dirname(calls[0].executable));
});

test('Wine fallback requires explicit module authorization and an existing prepared prefix', async t => {
  const f = fixture(t);
  f.write('windows.exe', pe(0x14c));
  const data = f.imported({ windows: 'windows.exe' });
  const wine = preparedWine(f);
  const calls = [];
  const options = { data, ...f, platform: 'darwin', arch: 'arm64', wine, spawnImpl: spawned(calls) };
  await assert.rejects(launchPortableProject(options), /autorize explicitamente Wine/);
  assert.equal(calls.length, 0);
  const result = await launchPortableProject({ ...options, data: { ...data, allowWine: true } });
  assert.deepEqual(result, { ok: true, via: 'wine' });
  assert.equal(calls[0].executable, fs.realpathSync(wine.executable));
  assert.equal(calls[0].args.length, 1);
  assert.equal(calls[0].args[0].endsWith('windows.exe'), true);
  assert.equal(calls[0].options.env.WINEPREFIX, fs.realpathSync(wine.prefix));
  assert.equal(Object.hasOwn(calls[0].options.env, 'WINEARCH'), false);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, path.dirname(calls[0].args[0]));
});

test('Wine configuration rejects PATH lookup, missing executables, and unprepared prefixes', t => {
  const f = fixture(t);
  const wine = preparedWine(f);
  assert.deepEqual(validateWineConfiguration(wine), wine);
  assert.throws(() => validateWineConfiguration({ ...wine, executable: 'wine' }), /absoluto/);
  assert.throws(() => validateWineConfiguration({ ...wine, executable: path.join(f.root, 'missing') }), /não existe/);
  assert.throws(() => validateWineConfiguration({ ...wine, prefix: 'relative' }), /absoluto/);
  fs.rmSync(path.join(wine.prefix, 'system.reg'));
  assert.throws(() => validateWineConfiguration(wine), /não está preparado/);
  assert.equal(fs.existsSync(path.join(wine.prefix, 'system.reg')), false, 'runtime never initializes Wine');
});

test('Windows accepts x86 on x64 but rejects ARM; Wine rejects Windows ARM', async t => {
  const f = fixture(t);
  f.write('x86.exe', pe(0x14c));
  f.write('arm.exe', pe(0xaa64));
  const x86 = f.imported({ windows: 'x86.exe' });
  const arm = f.imported({ windows: 'arm.exe' }, true);
  const calls = [];
  await launchPortableProject({ data: x86, ...f, platform: 'win32', arch: 'x64', spawnImpl: spawned(calls) });
  await assert.rejects(launchPortableProject({ data: arm, ...f, platform: 'win32', arch: 'x64', spawnImpl: spawned(calls) }), /arquitetura/);
  await assert.rejects(launchPortableProject({ data: arm, ...f, platform: 'darwin', arch: 'arm64', wine: preparedWine(f), spawnImpl: spawned(calls) }), /ARM/);
  assert.equal(calls.length, 1);
});

test('Mac rejects ARM-only on Intel and 32-bit Mach-O without launching', unixModeTest, async t => {
  const f = fixture(t);
  f.write('arm-tool', macho(0x100000c), 0o755);
  f.write('legacy-tool', macho(7), 0o755);
  const calls = [];
  for (const entry of ['arm-tool', 'legacy-tool']) {
    const data = f.imported({ mac: entry });
    await assert.rejects(launchPortableProject({ data, ...f, platform: 'darwin', arch: 'x64', spawnImpl: spawned(calls) }), /arquitetura/);
  }
  assert.equal(calls.length, 0);
});

test('native spawn failures and immediate nonzero exits are surfaced', async t => {
  const f = fixture(t);
  f.write('run.exe', pe());
  const data = f.imported({ windows: 'run.exe' });
  for (const [behavior, message] of [['error', /ENOEXEC/], ['failure', /código 7/]]) {
    await assert.rejects(launchPortableProject({ data, ...f, platform: 'win32', arch: 'x64', spawnImpl: spawned([], behavior) }), message);
  }
});

test('a running process passes only a bounded startup grace and is unreferenced', async t => {
  const f = fixture(t);
  f.write('run.exe', pe());
  const data = f.imported({ windows: 'run.exe' });
  const calls = [];
  const before = Date.now();
  await launchPortableProject({ data, ...f, platform: 'win32', arch: 'x64', spawnImpl: spawned(calls, 'running') });
  assert.ok(Date.now() - before < 2500);
  assert.equal(calls[0].child.unreferenced, true);
  assert.doesNotThrow(() => calls[0].child.emit('error', new Error('late error')));
});

test('LaunchServices failures are surfaced instead of reporting compatibility', unixModeTest, async t => {
  const f = fixture(t);
  f.write('Example.app/Contents/Info.plist', '<plist><dict><key>CFBundleExecutable</key><string>Example</string></dict></plist>');
  f.write('Example.app/Contents/MacOS/Example', macho(), 0o755);
  const data = f.imported({ mac: 'Example.app' });
  await assert.rejects(launchPortableProject({ data, ...f, platform: 'darwin', arch: 'x64',
    execFileImpl: (_exe, _args, _options, callback) => { process.nextTick(() => callback(new Error('LaunchServices rejected'))); } }), /macOS não conseguiu/);
});

test('unsafe imports or working-directory symlinks cannot launch or escape storage', async t => {
  const f = fixture(t);
  f.write('run.exe', pe());
  const data = f.imported({ windows: 'run.exe' });
  const calls = [];
  const options = { ...f, platform: 'win32', arch: 'x64', spawnImpl: spawned(calls) };
  await assert.rejects(launchPortableProject({ ...options, data: { ...data, root: '../outside' } }), /revisão/);
  await assert.rejects(launchPortableProject({ ...options, data: { ...data, entries: { windows: '../run.exe' } } }), /selecionado/);
  assert.equal(calls.length, 0);
  fs.mkdirSync(f.storageDir, { recursive: true });
  const identity = { root: data.root, revision: data.revision };
  const key = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  try { fs.symlinkSync(f.source, path.join(f.storageDir, key), 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('This Windows account cannot create symlinks.'); return; } throw error; }
  await assert.rejects(launchPortableProject({ ...options, data }), /pasta de trabalho/);
  assert.equal(fs.readFileSync(path.join(f.source, 'run.exe')).length, 512);
});

test('safe internal symlinks are preserved on Mac; external changes are rejected', unixModeTest, async t => {
  const f = fixture(t);
  f.write('native-tool', macho(), 0o755);
  f.write('resources/data.txt', 'data');
  try { fs.symlinkSync('resources/data.txt', path.join(f.source, 'data-link')); }
  catch (error) { if (error.code === 'EPERM') { t.skip('This Windows account cannot create symlinks.'); return; } throw error; }
  const data = f.imported({ mac: 'native-tool' });
  const calls = [];
  const options = { data, ...f, platform: 'darwin', arch: 'x64', spawnImpl: spawned(calls) };
  await launchPortableProject(options);
  const link = path.join(calls[0].options.cwd, 'data-link');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(link, 'utf8'), 'data');
  fs.unlinkSync(link);
  fs.symlinkSync(path.join(f.source, 'resources/data.txt'), link);
  await assert.rejects(launchPortableProject(options), /Ligação simbólica externa/);
  assert.equal(calls.length, 1);
});

test('incomplete existing working copies are preserved and not overwritten', async t => {
  const f = fixture(t);
  f.write('run.exe', pe());
  const data = f.imported({ windows: 'run.exe' });
  const key = crypto.createHash('sha256').update(JSON.stringify({ root: data.root, revision: data.revision })).digest('hex');
  const incomplete = path.join(f.storageDir, key);
  fs.mkdirSync(incomplete, { recursive: true });
  fs.writeFileSync(path.join(incomplete, 'user-settings'), 'keep');
  await assert.rejects(launchPortableProject({ data, ...f, platform: 'win32', arch: 'x64', spawnImpl: spawned([]) }), /incompleta/);
  assert.equal(fs.readFileSync(path.join(incomplete, 'user-settings'), 'utf8'), 'keep');
});

test('unsupported platforms and missing native Windows entry do not launch', async t => {
  const f = fixture(t);
  f.write('native-tool', macho(), 0o755);
  const data = f.imported({ mac: 'native-tool' }, true);
  await assert.rejects(launchPortableProject({ data, ...f, platform: 'linux', arch: 'x64', spawnImpl: spawned([]) }), /Windows ou no Mac/);
  await assert.rejects(launchPortableProject({ data, ...f, platform: 'win32', arch: 'x64', spawnImpl: spawned([]) }), /executável Windows/);
});
