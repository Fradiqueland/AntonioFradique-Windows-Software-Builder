'use strict';

// Portable applications are trusted native programs, not sandboxed content.
// A successful launch only confirms startup, never application compatibility.
const fs = process.versions.electron ? require('original-fs') : require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { assertPortableTarget, copyPortableTree } = require('./portable-app');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ROOT_PATTERN = new RegExp(`^dist-assets/portable-${UUID}$`);
const REVISION_PATTERN = new RegExp(`^${UUID}$`);
const STARTUP_GRACE_MS = 350;
const STARTUP_TIMEOUT_MS = 5000;
const SEED_FILE = '.portable-seed.json';
const seeds = new Map();

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function localDirectory(filename, create = false) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('A pasta de trabalho da aplicação deve ter um caminho absoluto.');
  if (create) fs.mkdirSync(filename, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(filename);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('A pasta de trabalho da aplicação não é válida.');
  return fs.realpathSync(filename);
}

function validateWineConfiguration({ executable, prefix } = {}) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable)) throw new Error('Selecione o executável Wine instalado neste Mac, com caminho absoluto.');
  if (typeof prefix !== 'string' || !path.isAbsolute(prefix)) throw new Error('Selecione uma pasta de prefixo Wine já preparada, com caminho absoluto.');
  let resolvedExecutable;
  let resolvedPrefix;
  try {
    resolvedExecutable = fs.realpathSync(executable);
    if (!fs.statSync(resolvedExecutable).isFile()) throw new Error('file');
    fs.accessSync(resolvedExecutable, fs.constants.X_OK);
  } catch (_) { throw new Error('O executável Wine selecionado não existe ou não tem permissão de execução.'); }
  try {
    resolvedPrefix = fs.realpathSync(prefix);
    if (!fs.statSync(resolvedPrefix).isDirectory()) throw new Error('directory');
    for (const name of ['system.reg', 'user.reg']) {
      const stat = fs.lstatSync(path.join(resolvedPrefix, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('registry');
    }
  } catch (_) { throw new Error('O prefixo Wine não está preparado: são necessários os ficheiros system.reg e user.reg. Prepare-o no Wine antes de o selecionar.'); }
  return { executable: resolvedExecutable, prefix: resolvedPrefix };
}

function readSeed(directory, identity) {
  const realDirectory = localDirectory(directory);
  const markerPath = path.join(realDirectory, SEED_FILE);
  let marker;
  try {
    const stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('marker');
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (_) { throw new Error('A cópia local da aplicação está incompleta ou alterada. Os seus dados foram preservados; importe novamente a aplicação para criar uma nova revisão.'); }
  if (marker.schema !== 1 || marker.root !== identity.root || marker.revision !== identity.revision) {
    throw new Error('A cópia local não corresponde à revisão da aplicação. Os seus dados foram preservados.');
  }
  return path.join(realDirectory, 'dist-assets');
}

async function workingAssets({ data, assetsDir, storageDir, target, platform, preflight }) {
  if (!data || !ROOT_PATTERN.test(data.root || '') || !REVISION_PATTERN.test(data.revision || '')) {
    throw new Error('O diretório ou a revisão da aplicação portátil não é válido.');
  }
  const storage = localDirectory(storageDir, true);
  const identity = { root: data.root, revision: data.revision };
  const key = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const destination = path.join(storage, key);
  if (fs.existsSync(destination)) return readSeed(destination, identity);
  if (seeds.has(destination)) return seeds.get(destination);
  const pending = (async () => {
    const original = assertPortableTarget({ data, assetsDir, target });
    preflight(original);
    if (storage === original.rootPath || inside(original.rootPath, storage)) throw new Error('A pasta de trabalho não pode ficar dentro da aplicação importada.');
    const temporary = fs.mkdtempSync(path.join(storage, `${key}.tmp-`));
    try {
      const temporaryAssets = path.join(temporary, 'dist-assets');
      fs.mkdirSync(temporaryAssets, { mode: 0o700 });
      const copiedRoot = path.join(temporaryAssets, data.root.slice('dist-assets/'.length));
      // Windows cannot reliably create Unix symlinks without special privileges.
      // The shared copier can materialise already-validated internal targets.
      copyPortableTree(original.rootPath, copiedRoot, { dereferenceLinks: platform === 'win32' });
      assertPortableTarget({ data, assetsDir: temporaryAssets, target });
      fs.writeFileSync(path.join(temporary, SEED_FILE), JSON.stringify({ schema: 1, ...identity }), { flag: 'wx', mode: 0o600 });
      try { fs.renameSync(temporary, destination); }
      catch (error) {
        // Another process may have published the same seed first. Never replace
        // an existing working copy or erase settings written by its application.
        if (!fs.existsSync(destination)) throw error;
        readSeed(destination, identity);
      }
      return readSeed(destination, identity);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  })();
  seeds.set(destination, pending);
  try { return await pending; }
  finally { if (seeds.get(destination) === pending) seeds.delete(destination); }
}

function assertArchitecture(project, platform, arch) {
  const architectures = project.architectures || [];
  if (project.requiresWine) {
    if (!architectures.some(value => value === 'ia32' || value === 'x64')) {
      throw new Error('Esta versão Windows usa uma arquitetura ARM incompatível com o modo Wine disponível. Escolha uma versão Windows x86/x64 ou uma versão Mac nativa.');
    }
    return;
  }
  if (platform === 'win32') {
    const accepted = arch === 'arm64' ? ['arm64', 'x64', 'ia32'] : arch === 'x64' ? ['x64', 'ia32'] : arch === 'ia32' ? ['ia32'] : [];
    if (!architectures.some(value => accepted.includes(value))) throw new Error('A arquitetura deste programa não corresponde a este Windows.');
  } else {
    // macOS on Apple silicon may run x64 through separately installed Rosetta.
    // This permits an attempt; startup can still fail and compatibility is not
    // inferred from the header or from a successful LaunchServices request.
    const accepted = arch === 'arm64' ? ['arm64', 'x64'] : arch === 'x64' ? ['x64'] : [];
    if (!architectures.some(value => accepted.includes(value))) throw new Error('A arquitetura desta aplicação não corresponde a este Mac.');
  }
}

function startProcess(executable, args, options, spawnImpl) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let spawned = false;
    let grace;
    const timeout = setTimeout(() => {
      if (child && typeof child.kill === 'function') child.kill();
      finish(new Error('O programa não confirmou o arranque dentro de 5 segundos.'));
    }, STARTUP_TIMEOUT_MS);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(grace);
      if (child) {
        child.removeListener('spawn', started);
        child.removeListener('exit', exited);
        child.removeListener('error', failed);
        // Late errors must not crash the Builder after the startup result.
        child.on('error', () => {});
        if (typeof child.unref === 'function') child.unref();
      }
      error ? reject(error) : resolve();
    }
    function failed(error) { finish(new Error(`Não foi possível iniciar o programa${error && error.code ? ` (${error.code})` : ''}. Confirme as permissões e dependências da aplicação.`)); }
    function started() { spawned = true; grace = setTimeout(() => finish(), STARTUP_GRACE_MS); }
    function exited(code, signal) {
      if (code === 0 && spawned) finish();
      else finish(new Error(`O programa terminou durante o arranque${signal ? ` (${signal})` : Number.isInteger(code) ? ` (código ${code})` : ''}. Confirme a compatibilidade e as dependências.`));
    }
    try {
      child = spawnImpl(executable, args, options);
      child.once('error', failed);
      child.once('spawn', started);
      child.once('exit', exited);
    } catch (error) { failed(error); }
  });
}

function openMacBundle(bundlePath, execFileImpl) {
  return new Promise((resolve, reject) => {
    let done = false;
    let child;
    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      if (child && typeof child.kill === 'function') child.kill();
      reject(new Error('O macOS não confirmou a abertura da aplicação dentro de 5 segundos.'));
    }, STARTUP_TIMEOUT_MS);
    try {
      child = execFileImpl('/usr/bin/open', ['-n', '-a', bundlePath], {
        cwd: path.dirname(bundlePath), shell: false, timeout: STARTUP_TIMEOUT_MS,
        windowsHide: false, maxBuffer: 64 * 1024
      }, error => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        if (error) reject(new Error('O macOS não conseguiu abrir a aplicação. Confirme a arquitetura, permissões, assinatura e dependências.'));
        else resolve();
      });
    } catch (_) {
      done = true;
      clearTimeout(timeout);
      reject(new Error('Não foi possível pedir ao macOS para abrir a aplicação.'));
    }
  });
}

async function launchPortableProject({ data, assetsDir, platform = process.platform, arch = process.arch,
  storageDir, wine = null, spawnImpl = spawn, execFileImpl = execFile } = {}) {
  if (!['win32', 'darwin'].includes(platform)) throw new Error('As aplicações portáteis só podem ser iniciadas no Windows ou no Mac.');
  const target = platform === 'win32' ? 'windows' : 'mac';
  let configuration;
  function preflight(project) {
    assertArchitecture(project, platform, arch);
    if (project.requiresWine) {
      if (!wine) throw new Error('Esta aplicação precisa de Wine. Escolha o executável Wine e um prefixo já preparado nas definições deste Mac.');
      configuration = validateWineConfiguration(wine);
    }
  }
  const persistedAssets = await workingAssets({ data, assetsDir, storageDir, target, platform, preflight });
  const project = assertPortableTarget({ data, assetsDir: persistedAssets, target });
  preflight(project);
  if (project.requiresWine) {
    const environment = { ...process.env, WINEPREFIX: configuration.prefix };
    delete environment.WINEARCH;
    await startProcess(configuration.executable, [project.launchPath], {
      cwd: path.dirname(project.launchPath), env: environment, shell: false,
      detached: true, stdio: 'ignore', windowsHide: false
    }, spawnImpl);
    return { ok: true, via: 'wine' };
  }
  if (platform === 'darwin' && project.launchKind === 'app') {
    await openMacBundle(project.launchPath, execFileImpl);
  } else {
    if (platform === 'darwin') {
      try { fs.accessSync(project.launchPath, fs.constants.X_OK); }
      catch (_) { throw new Error('O programa Mac não tem permissão de execução. Corrija a aplicação de origem e importe-a novamente.'); }
    }
    await startProcess(project.launchPath, [], {
      cwd: path.dirname(project.launchPath), shell: false, detached: true,
      stdio: 'ignore', windowsHide: false
    }, spawnImpl);
  }
  return { ok: true, via: 'native' };
}

module.exports = { launchPortableProject, validateWineConfiguration };
