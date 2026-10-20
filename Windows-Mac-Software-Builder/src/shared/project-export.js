'use strict';

// Repack templates without extracting the Mac bundle: Windows cannot faithfully
// materialise its Unix symlinks. The signed app's bytes and modes stay unchanged.
// Electron's patched fs treats *.asar as virtual, read-only directories. This
// module copies archive bytes on disk, including the Viewer's app.asar, so use
// the physical filesystem without changing process.noAsar for the running UI.
const fs = process.versions.electron ? require('original-fs') : require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const yauzl = require('yauzl');
const yazl = require('yazl');
const { validateWebProject } = require('./local-web');
const { assertPortableTarget, normalizePortableLink, portableFileMode, validatePortableProject } = require('./portable-app');
const { assertAPKExport } = require('./android-runtime');
const { FFMPEG_SOURCE_LOCK } = require('./ffmpeg-source-lock');

const MAC_BUNDLE = 'LaunchBox Viewer.app';
const MAC_RUNTIME_DATA = 'LaunchBox Viewer.data';
const OPTIONAL_RUNTIMES = Object.freeze(['ffmpeg', 'php']);
const LIMITS = Object.freeze({ entries: 30000, fileBytes: 2 * 1024 ** 3, totalBytes: 8 * 1024 ** 3, depth: 64 });
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n & 1) ? (0xedb88320 ^ (n >>> 1)) : (n >>> 1);
  return n >>> 0;
});

function safeProjectName(value) {
  let name = String(value || 'My Software').normalize('NFC').replace(/[\\/:<>"|?*\x00-\x1f\x7f]/g, '-').trim();
  name = Array.from(name).slice(0, 80).join('').replace(/[. ]+$/, '');
  // Leave room for .app/.data and avoid invalid filesystem components when a
  // short display name uses multi-byte characters or decomposed Unicode.
  const characters = Array.from(name);
  while (Buffer.byteLength(characters.join(''), 'utf8') > 240 || Buffer.byteLength(characters.join('').normalize('NFD'), 'utf8') > 240) characters.pop();
  name = characters.join('').replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') name = 'My Software';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}

function validPath(name) {
  if (typeof name !== 'string' || !name || name.length > 2048 || /[\\:<>"|?*\x00-\x1f\x7f]/.test(name) || name.startsWith('/')) {
    throw new Error(`Caminho ZIP inválido: ${name}`);
  }
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.length > LIMITS.depth || parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw new Error(`Caminho ZIP inválido: ${name}`);
  }
  return parts;
}

function key(name) { return name.replace(/\/$/, '').normalize('NFD').toLowerCase(); }

function registerPath(paths, name, kind) {
  const parts = validPath(name);
  if (!['directory', 'file', 'symlink'].includes(kind) || (name.endsWith('/') && kind !== 'directory')) throw new Error(`Tipo de caminho ZIP inválido: ${name}`);
  const normalized = key(name);
  const previous = paths.get(normalized);
  if (previous && !(previous === 'implicit-directory' && kind === 'directory')) throw new Error(`Caminhos ZIP duplicados: ${name}`);
  paths.set(normalized, kind);
  for (let i = 1; i < parts.length; i++) {
    const parent = key(parts.slice(0, i).join('/'));
    const type = paths.get(parent);
    if (type && type !== 'directory' && type !== 'implicit-directory') throw new Error(`Caminho ZIP atravessa um ficheiro ou ligação: ${name}`);
    if (!type) paths.set(parent, 'implicit-directory');
  }
}

function verifyStream(size, crc32, verifyFinal, sha256) {
  let count = 0;
  let crc = 0xffffffff;
  const hash = sha256 ? crypto.createHash('sha256') : null;
  return new Transform({
    transform(chunk, encoding, callback) {
      count += chunk.length;
      if (count > size) return callback(new Error('O tamanho do ficheiro ZIP excede o declarado.'));
      if (crc32 !== undefined) for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      if (hash) hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      if (count !== size || (crc32 !== undefined && ((crc ^ 0xffffffff) >>> 0) !== crc32)) {
        return callback(new Error('Ficheiro ZIP corrompido: tamanho ou CRC inválido.'));
      }
      if (hash && hash.digest('hex') !== sha256) return callback(new Error('Arquivo de código-fonte FFmpeg corrompido: SHA-256 inválido.'));
      if (verifyFinal) Promise.resolve().then(verifyFinal).then(() => callback(), callback);
      else callback();
    }
  });
}

function openZip(filename) {
  return new Promise((resolve, reject) => yauzl.open(filename, {
    lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true
  }, (error, zip) => error ? reject(error) : resolve(zip)));
}

function entryStream(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => {
    if (error) return reject(error);
    const verified = verifyStream(entry.uncompressedSize, entry.crc32);
    stream.on('error', error => verified.destroy(error));
    verified.on('close', () => stream.destroy());
    resolve(stream.pipe(verified));
  }));
}

async function inspectTemplate(templatePath, target) {
  const zip = await openZip(templatePath);
  const entries = [];
  const paths = new Map();
  let bytes = 0;
  // Keep a listener for I/O failures after the central directory has been read.
  let ioError;
  zip.on('error', error => { ioError = error; });
  try {
    await new Promise((resolve, reject) => {
      zip.once('error', reject);
      zip.once('end', resolve);
      zip.on('entry', entry => {
        try {
          if (entries.length >= LIMITS.entries) throw new Error('O template excede o limite de ficheiros.');
          if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) throw new Error('Formato ZIP não suportado.');
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > LIMITS.fileBytes ||
              (bytes += entry.uncompressedSize) > LIMITS.totalBytes) throw new Error('O template excede os limites de tamanho.');
          const name = entry.fileName;
          const storedMode = entry.externalFileAttributes >>> 16;
          const type = storedMode & 0o170000;
          const kind = name.endsWith('/') ? 'directory' : type === 0o120000 ? 'symlink' : 'file';
          if (type && type !== (kind === 'directory' ? 0o040000 : kind === 'symlink' ? 0o120000 : 0o100000)) throw new Error(`Tipo de ficheiro ZIP não permitido: ${name}`);
          if (kind === 'directory' && entry.uncompressedSize) throw new Error('Diretório ZIP com conteúdo inválido.');
          registerPath(paths, name, kind);
          if (target === 'mac') {
            const bundle = name === `${MAC_BUNDLE}/` || name.startsWith(`${MAC_BUNDLE}/`);
            const companionRoot = name === `${MAC_RUNTIME_DATA}/` && kind === 'directory';
            const companionRuntime = OPTIONAL_RUNTIMES.some(runtime => name.startsWith(`${MAC_RUNTIME_DATA}/${runtime}/`));
            // Only optional native runtimes may sit beside the signed app.
            // Configuration/assets from an earlier project never enter a template.
            if (!bundle && !companionRoot && !companionRuntime) throw new Error('O template Mac contém um ficheiro fora da aplicação ou dos runtimes permitidos.');
          } else {
            if (kind === 'symlink') throw new Error('O template Windows não pode conter ligações simbólicas.');
            if (/^resources\/(?:data|dist-assets)(?:\/|$)/i.test(name)) throw new Error('O template Windows contém dados de um projeto.');
          }
          entries.push({ entry, name, kind, mode: storedMode || (kind === 'directory' ? 0o040755 : 0o100644) });
          zip.readEntry();
        } catch (error) { reject(error); }
      });
      zip.readEntry();
    });
    const required = target === 'mac'
      ? [`${MAC_BUNDLE}/Contents/Info.plist`, `${MAC_BUNDLE}/Contents/Resources/app.asar`, `${MAC_BUNDLE}/Contents/MacOS/LaunchBox Viewer`]
      : ['LaunchBox Viewer.exe', 'resources/app.asar'];
    if (required.some(name => !entries.some(item => item.name === name && item.kind === 'file'))) throw new Error('Template incompleto: executável ou app.asar em falta ou com nome incorreto.');
    if (target === 'mac' && !(entries.find(item => item.name === `${MAC_BUNDLE}/Contents/MacOS/LaunchBox Viewer`).mode & 0o111)) {
      throw new Error('O executável do template Mac não tem permissão de execução.');
    }
    const markerPath = target === 'windows' ? 'resources/ffmpeg/template-sources.json' : `${MAC_RUNTIME_DATA}/ffmpeg/template-sources.json`;
    let sharedSources = null;
    for (const item of entries.filter(item => key(path.posix.basename(item.name)) === 'template-sources.json')) {
      if (item.name !== markerPath || item.kind !== 'file' || item.entry.uncompressedSize > 4096) throw new Error('Marcador de código-fonte FFmpeg inválido no template.');
      const chunks = [];
      for await (const chunk of await entryStream(zip, item.entry)) chunks.push(chunk);
      let marker;
      try { marker = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (_) { throw new Error('Marcador de código-fonte FFmpeg inválido no template.'); }
      const exactKeys = (object, expected) => object && typeof object === 'object' && !Array.isArray(object)
        && Object.keys(object).length === expected.length && expected.every(name => Object.hasOwn(object, name));
      if (!exactKeys(marker, ['schemaVersion', 'sources']) || marker.schemaVersion !== 1 || !Array.isArray(marker.sources) || marker.sources.length !== FFMPEG_SOURCE_LOCK.length) {
        throw new Error('Marcador de código-fonte FFmpeg inválido no template.');
      }
      const used = new Set();
      let bytes = 0;
      for (const source of marker.sources) {
        const locked = FFMPEG_SOURCE_LOCK.find(expected => source && source.file === expected.file);
        if (!exactKeys(source, ['file', 'sha256', 'size']) || !locked || source.sha256 !== locked.sha256 || source.size !== locked.size
            || used.has(source.file) || !Number.isSafeInteger(source.size) || source.size < 1 || source.size > 50 * 1024 ** 2 || (bytes += source.size) > 16 * 1024 ** 2) {
          throw new Error('Marcador de código-fonte FFmpeg não corresponde aos arquivos fixados.');
        }
        used.add(source.file);
      }
      const runtimeRoot = path.posix.dirname(markerPath);
      if (FFMPEG_SOURCE_LOCK.some(source => paths.has(key(`${runtimeRoot}/sources/${source.file}`)))) throw new Error('O template mistura arquivos de código-fonte FFmpeg com referências externas.');
      for (const source of FFMPEG_SOURCE_LOCK) registerPath(paths, `${runtimeRoot}/sources/${source.file}`, 'file');
      sharedSources = { markerPath, runtimeRoot, sources: FFMPEG_SOURCE_LOCK };
    }
    const links = new Map();
    for (const item of entries.filter(item => item.kind === 'symlink')) {
      if (item.entry.uncompressedSize > 4096) throw new Error('Ligação simbólica ZIP demasiado longa.');
      const buffers = [];
      for await (const chunk of await entryStream(zip, item.entry)) buffers.push(chunk);
      item.link = Buffer.concat(buffers);
      const targetName = item.link.toString('utf8');
      if (!targetName || !Buffer.from(targetName, 'utf8').equals(item.link) || /[\\:\x00-\x1f\x7f]/.test(targetName) || targetName.startsWith('/')) throw new Error('Destino de ligação simbólica inválido.');
      links.set(key(item.name), targetName);
    }
    function resolveLink(name) {
      const linkRoot = name.split('/')[0];
      const runtimeRoot = linkRoot === MAC_RUNTIME_DATA ? name.split('/')[1] : null;
      let pending = name.split('/');
      const resolved = [];
      let followed = 0;
      while (pending.length) {
        const part = pending.shift();
        if (!part || part === '.') continue;
        if (part === '..') {
          if (resolved.length <= (runtimeRoot ? 2 : 1)) throw new Error('Ligação simbólica fora do bundle ou runtime.');
          resolved.pop();
          continue;
        }
        const current = [...resolved, part].join('/');
        if (links.has(key(current))) {
          if (++followed > 40) throw new Error('Ciclo de ligações simbólicas no template.');
          pending = [...links.get(key(current)).split('/'), ...pending];
        } else {
          if (!paths.has(key(current))) throw new Error('Ligação simbólica com destino inexistente.');
          resolved.push(part);
        }
      }
      if (resolved[0] !== linkRoot || resolved.length < 2 || (runtimeRoot && resolved[1] !== runtimeRoot)) throw new Error('Ligação simbólica fora do bundle ou runtime.');
    }
    for (const item of entries.filter(item => item.kind === 'symlink')) resolveLink(item.name);
    if (ioError) throw ioError;
    return { zip, entries, paths, sharedSources, checkError() { if (ioError) throw ioError; } };
  } catch (error) { zip.close(); throw error; }
}

function inside(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function inspectAssets(assetsDir, portableRoots = []) {
  if (!path.isAbsolute(assetsDir)) throw new Error('A pasta de recursos deve ser absoluta.');
  const rootStat = await fs.promises.lstat(assetsDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Pasta de recursos inválida.');
  const root = await fs.promises.realpath(assetsDir);
  const entries = [];
  const paths = new Map();
  let bytes = 0;
  async function walk(directory, prefix = '', depth = 0) {
    if (depth > LIMITS.depth) throw new Error('Demasiados níveis de recursos.');
    for (const name of (await fs.promises.readdir(directory)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const absolute = path.join(directory, name);
      const stat = await fs.promises.lstat(absolute);
      const portable = portableRoots.find(item => inside(item.rootPath, absolute));
      const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null;
      if (!kind || (kind === 'symlink' && !portable)) throw new Error(`Recurso não permitido: ${relative}`);
      registerPath(paths, relative, kind);
      if (paths.size > LIMITS.entries) throw new Error('Demasiados recursos.');
      const type = kind === 'directory' ? 0o040000 : kind === 'symlink' ? 0o120000 : 0o100000;
      // Preserve Unix modes. On Windows only validated native Mac executables
      // in managed portable modules receive 0755 in the ZIP, never on disk.
      const permissions = portable ? (kind === 'file' ? portableFileMode(absolute, stat) : stat.mode & 0o777)
        : kind === 'directory' ? 0o755 : 0o644;
      const mode = type | permissions;
      const item = { absolute, relative, stat, kind, mode, portable };
      entries.push(item);
      if (kind === 'directory') await walk(absolute, relative, depth + 1);
      else if (kind === 'symlink') {
        item.rawLink = await fs.promises.readlink(absolute, { encoding: 'buffer' });
        const rawTarget = item.rawLink.toString('utf8');
        if (!Buffer.from(rawTarget, 'utf8').equals(item.rawLink)) throw new Error(`Destino de ligação simbólica inválido: ${relative}`);
        item.linkTarget = normalizePortableLink(rawTarget, process.platform);
        item.link = Buffer.from(item.linkTarget, 'utf8');
        if ((bytes += item.link.length) > LIMITS.totalBytes) throw new Error('Os recursos excedem os limites de tamanho.');
      } else {
        if (stat.size > LIMITS.fileBytes || (bytes += stat.size) > LIMITS.totalBytes) throw new Error('Os recursos excedem os limites de tamanho.');
      }
    }
  }
  await walk(root);
  const indexed = new Map(entries.map(item => [key(item.relative), item]));
  const links = entries.filter(item => item.kind === 'symlink');
  // Resolve against the exact tree that will enter the ZIP, not just a lexical
  // normalisation of link text. This rejects chained escapes and dangling links.
  for (const link of links) {
    const rootParts = link.portable.relative.split('/');
    const resolved = [...rootParts];
    let pending = link.relative.split('/').slice(rootParts.length);
    let followed = 0;
    while (pending.length) {
      const part = pending.shift();
      if (!part || part === '.') continue;
      if (part === '..') {
        if (resolved.length <= rootParts.length) throw new Error(`Ligação simbólica fora do programa portátil: ${link.relative}`);
        resolved.pop();
        continue;
      }
      const candidate = [...resolved, part].join('/');
      const item = indexed.get(key(candidate));
      if (!item) throw new Error(`Ligação simbólica com destino inexistente: ${link.relative}`);
      if (item.kind === 'symlink') {
        if (++followed > 40) throw new Error(`Ciclo de ligações simbólicas: ${link.relative}`);
        pending = [...item.linkTarget.split('/'), ...pending];
      } else {
        if (pending.length && item.kind !== 'directory') throw new Error(`Ligação simbólica atravessa um ficheiro: ${link.relative}`);
        resolved.push(part);
      }
    }
    link.resolvedRelative = resolved.join('/');
    const canonical = await fs.promises.realpath(link.absolute);
    if (!inside(link.portable.rootPath, canonical)) throw new Error(`Ligação simbólica fora do programa portátil: ${link.relative}`);
  }
  // Directory links can form a recursive graph without a direct symlink chain
  // (A/link -> B and B/link -> A). Do not ship those recursive bundles either.
  const directoryEdges = new Map(entries.filter(item => item.kind === 'directory' && item.portable).map(item => [key(item.relative), []]));
  for (const item of entries.filter(item => item.portable)) {
    const parent = directoryEdges.get(key(path.posix.dirname(item.relative)));
    if (!parent) continue;
    if (item.kind === 'directory') parent.push(key(item.relative));
    else if (item.kind === 'symlink' && directoryEdges.has(key(item.resolvedRelative))) parent.push(key(item.resolvedRelative));
  }
  const visiting = new Set();
  const visited = new Set();
  function checkDirectory(name) {
    if (visiting.has(name)) throw new Error('Ciclo de diretórios e ligações no programa portátil.');
    if (visited.has(name)) return;
    visiting.add(name);
    for (const child of directoryEdges.get(name) || []) checkDirectory(child);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of directoryEdges.keys()) checkDirectory(name);
  return { root, entries, files: entries.filter(item => item.kind === 'file'), links, paths, portableRoots };
}

// Shared with the SFX route: callers can inspect links before choosing a format.
// Only validated portable modules grant permission to archive asset symlinks.
async function inspectProjectAssets({ config, assetsDir, target }) {
  if (!['windows', 'mac', 'project'].includes(target)) throw new Error('Selecione Windows ou Mac.');
  const assetRoot = await fs.promises.realpath(assetsDir);
  const portableRoots = [];
  for (const module of config.content || []) {
    if (module.type !== 'portable') continue;
    const validated = target === 'project' ? validatePortableProject({ data: module.data, assetsDir }) : assertPortableTarget({ data: module.data, assetsDir, target });
    const rootPath = await fs.promises.realpath(validated.rootPath);
    if (rootPath === assetRoot || !inside(assetRoot, rootPath)) throw new Error('Pasta de programa portátil fora dos recursos.');
    const relative = path.relative(assetRoot, rootPath).split(path.sep).join('/');
    if (portableRoots.some(item => item.rootPath === rootPath)) continue;
    if (portableRoots.some(item => inside(item.rootPath, rootPath) || inside(rootPath, item.rootPath))) throw new Error('Pastas de programas portáteis sobrepostas.');
    portableRoots.push({ rootPath, relative });
  }
  return inspectAssets(assetsDir, portableRoots);
}

async function assetStream(asset, root) {
  const real = await fs.promises.realpath(asset.absolute);
  const relative = path.relative(asset.portable ? asset.portable.rootPath : root, real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('O recurso saiu da pasta do projeto.');
  const handle = await fs.promises.open(asset.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const actual = await handle.stat();
    const matches = stat => stat.isFile() && stat.size === asset.stat.size && stat.ino === asset.stat.ino && stat.dev === asset.stat.dev
      && stat.mtimeMs === asset.stat.mtimeMs && stat.ctimeMs === asset.stat.ctimeMs;
    if (!matches(actual)) throw new Error('Um recurso mudou durante a exportação.');
    // Keep the descriptor open until the final stat has checked modifications
    // made while the file was streaming, including writes of the same length.
    const stream = handle.createReadStream({ autoClose: false });
    const checked = verifyStream(actual.size, undefined, async () => {
      if (!matches(await handle.stat())) throw new Error('Um recurso mudou durante a exportação.');
    }, asset.sha256);
    stream.on('error', error => checked.destroy(error));
    checked.on('close', () => { stream.destroy(); handle.close().catch(() => {}); });
    return stream.pipe(checked);
  } catch (error) { await handle.close(); throw error; }
}

function projectRuntimeRequirements({ config, assetsDir, requiresPhp = false }) {
  const requirements = { ffmpeg: false, php: requiresPhp === true };
  for (const module of config.content || []) {
    // Local media uses Electron's media decoder; only IPTV needs the native
    // fallback transcoder. Keep its complete binaries/source/licence tree.
    if (module.type === 'iptv') requirements.ffmpeg = true;
    if (module.type === 'local-web') requirements.php = validateWebProject({ data: module.data, assetsDir }).requiresPhp || requirements.php;
  }
  return requirements;
}

function runtimeForEntry(name, target) {
  const base = target === 'windows' ? 'resources' : MAC_RUNTIME_DATA;
  return OPTIONAL_RUNTIMES.find(runtime => key(name) === key(`${base}/${runtime}`) || key(name).startsWith(key(`${base}/${runtime}`) + '/'));
}

function selectedTemplateEntries(template, target, requirements) {
  // Runtimes in older sealed Mac app bundles stay byte-for-byte intact. New
  // templates put them beside the bundle so Windows can filter them without
  // modifying a Mac signature or requiring codesign on the creator's system.
  return template.entries.filter(item => {
    if (template.sharedSources && item.name === template.sharedSources.markerPath) return false;
    const runtime = runtimeForEntry(item.name, target);
    return !runtime || requirements[runtime];
  });
}

async function inspectSharedRuntimeSources(template, requirements, sharedRuntimeSourcesDir) {
  if (!requirements.ffmpeg || !template.sharedSources) return [];
  if (typeof sharedRuntimeSourcesDir !== 'string' || !path.isAbsolute(sharedRuntimeSourcesDir)) {
    throw new Error('O construtor não inclui a pasta comum de código-fonte FFmpeg necessária para esta exportação IPTV. Reinstale o construtor.');
  }
  const directoryStat = await fs.promises.lstat(sharedRuntimeSourcesDir);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Pasta comum de código-fonte FFmpeg inválida.');
  const root = await fs.promises.realpath(sharedRuntimeSourcesDir);
  const restored = [];
  for (const source of template.sharedSources.sources) {
    const absolute = path.join(root, source.file);
    const stat = await fs.promises.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== source.size) throw new Error('Arquivo comum de código-fonte FFmpeg inválido: ' + source.file);
    const handle = await fs.promises.open(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const unchanged = actual => actual.isFile() && actual.size === stat.size && actual.ino === stat.ino && actual.dev === stat.dev
        && actual.mtimeMs === stat.mtimeMs && actual.ctimeMs === stat.ctimeMs;
      if (!unchanged(await handle.stat())) throw new Error('O código-fonte FFmpeg mudou durante a exportação.');
      const hash = crypto.createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      if (hash.digest('hex') !== source.sha256 || !unchanged(await handle.stat())) throw new Error('Arquivo comum de código-fonte FFmpeg corrompido: SHA-256 inválido.');
    } finally { await handle.close(); }
    restored.push({ absolute, root, stat, sha256: source.sha256,
      destination: `${template.sharedSources.runtimeRoot}/sources/${source.file}`, mode: 0o100644 });
  }
  return restored;
}

function assertTemplateRuntimes(template, target, requirements) {
  const base = target === 'windows' ? 'resources' : `${MAC_BUNDLE}/Contents/Resources`;
  for (const runtime of OPTIONAL_RUNTIMES) {
    if (!requirements[runtime]) continue;
    const executable = runtime + (target === 'windows' ? '.exe' : '');
    const candidates = [`${base}/${runtime}/${executable}`];
    if (target === 'mac') candidates.push(`${MAC_RUNTIME_DATA}/${runtime}/${executable}`);
    const included = template.entries.find(item => item.kind === 'file' && candidates.some(candidate => key(candidate) === key(item.name)));
    if (!included) {
      throw new Error(`O template ${target === 'mac' ? 'Mac' : 'Windows'} não inclui o runtime ${runtime === 'php' ? 'PHP' : 'FFmpeg'} necessário. Instale um runtime para essa plataforma e recrie o template.`);
    }
    if (target === 'mac' && !(included.mode & 0o111)) throw new Error(`O runtime ${runtime === 'php' ? 'PHP' : 'FFmpeg'} do template Mac não tem permissão de execução.`);
  }
}

async function exportProject({ target, templatePath, outputPath, projectName, config, assetsDir, requiresPhp = false, sharedRuntimeSourcesDir, onProgress }) {
  if (!['windows', 'mac'].includes(target)) throw new Error('Selecione Windows ou Mac.');
  assertAPKExport(config, { audience: 'creator', locale: config && config.language });
  if (!path.isAbsolute(templatePath) || !path.isAbsolute(outputPath) || path.resolve(templatePath) === path.resolve(outputPath)) throw new Error('Caminhos de exportação inválidos.');
  const name = safeProjectName(projectName);
  const configBytes = Buffer.from(JSON.stringify(config, null, 2));
  if (configBytes.length > 16 * 1024 ** 2) throw new Error('A configuração do projeto é demasiado grande.');
  const assets = await inspectProjectAssets({ config, assetsDir, target });
  function validateReferences(value) {
    if (typeof value === 'string' && value.startsWith('dist-assets/')) {
      const relative = value.slice('dist-assets/'.length);
      validPath(relative);
      if (!assets.paths.has(key(relative))) throw new Error(`Recurso do projeto em falta: ${value}`);
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) validateReferences(child);
    }
  }
  validateReferences(config);
  for (const module of (config.content || [])) {
    if (target === 'mac' && module.type === 'launch' && [module.data && module.data.file, module.data && module.data.fileName].some(value => typeof value === 'string' && /\.(?:exe|msi|bat|cmd|com|scr)$/i.test(value))) {
      throw new Error(`O módulo "${module.title || module.id || 'Launch'}" contém um programa Windows incompatível com Mac.`);
    }
  }
  const requirements = projectRuntimeRequirements({ config, assetsDir, requiresPhp });
  const template = await inspectTemplate(templatePath, target);
  let temporary;
  try {
    assertTemplateRuntimes(template, target, requirements);
    const restoredSources = await inspectSharedRuntimeSources(template, requirements, sharedRuntimeSourcesDir);
    const selectedEntries = selectedTemplateEntries(template, target, requirements);
    const omittedRuntimeBytes = template.entries.reduce((sum, item) => {
      const runtime = runtimeForEntry(item.name, target);
      return sum + (runtime && !requirements[runtime] ? item.entry.uncompressedSize : 0);
    }, 0);
    const outputParent = await fs.promises.realpath(path.dirname(outputPath));
    const relativeParent = path.relative(assets.root, outputParent);
    if (!relativeParent || (relativeParent !== '..' && !relativeParent.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeParent))) throw new Error('Guarde a exportação fora da pasta de recursos.');
    temporary = path.join(outputParent, `.${path.basename(outputPath)}.${crypto.randomUUID()}.tmp`);
    const archive = new yazl.ZipFile();
    const output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
    const activeStreams = new Set();
    const completion = pipeline(archive.outputStream, output);
    // Register immediately: failures while entries are being queued must not
    // surface as unhandled rejections before the final await.
    completion.catch(() => {});
    archive.on('error', error => archive.outputStream.destroy(error));
    let completed = 0;
    const total = selectedEntries.length + assets.entries.length + restoredSources.length + 1;
    function progress() { if (onProgress) { try { onProgress({ completed, total }); } catch (_) { /* UI observers do not invalidate an export. */ } } }
    function addLazy(destination, options, getter) {
      archive.addReadStreamLazy(destination, options, callback => {
        getter().then(stream => {
          activeStreams.add(stream);
          stream.once('close', () => activeStreams.delete(stream));
          stream.once('error', error => archive.outputStream.destroy(error));
          stream.once('end', () => { completed++; progress(); });
          callback(null, stream);
        }, callback);
      });
    }
    try {
      for (const item of selectedEntries) {
        let destination = item.name;
        if (target === 'mac') {
          destination = item.name.startsWith(`${MAC_RUNTIME_DATA}/`)
            ? `${name}.data${item.name.slice(MAC_RUNTIME_DATA.length)}`
            : `${name}.app${item.name.slice(MAC_BUNDLE.length)}`;
        }
        // size belongs only to streamed files. yazl rejects it for directory
        // and buffer entries, including the explicit directories in real apps.
        const options = { mode: item.mode, mtime: item.entry.getLastModDate() };
        if (item.kind === 'directory') { archive.addEmptyDirectory(destination, options); completed++; }
        else if (item.kind === 'symlink') { archive.addBuffer(item.link, destination, options); completed++; }
        else addLazy(destination, { ...options, size: item.entry.uncompressedSize, compressionLevel: 9 }, () => entryStream(template.zip, item.entry));
      }
      for (const source of restoredSources) {
        const destination = target === 'mac' ? `${name}.data${source.destination.slice(MAC_RUNTIME_DATA.length)}` : source.destination;
        addLazy(destination, { mode: source.mode, size: source.stat.size, mtime: source.stat.mtime, compressionLevel: 9 }, () => assetStream(source, source.root));
      }
      const base = target === 'windows' ? 'resources' : `${name}.data`;
      archive.addEmptyDirectory(`${base}/dist-assets/`, { mode: 0o040755 });
      archive.addBuffer(configBytes, `${base}/data/project-config.json`, { mode: 0o100644, compressionLevel: 9 });
      completed++;
      for (const asset of assets.entries) {
        const destination = `${base}/dist-assets/${asset.relative}`;
        const options = { mode: asset.mode, mtime: asset.stat.mtime };
        if (asset.kind === 'directory') { archive.addEmptyDirectory(destination + '/', options); completed++; }
        else if (asset.kind === 'symlink') { archive.addBuffer(asset.link, destination, options); completed++; }
        else addLazy(destination, { ...options, size: asset.stat.size, compressionLevel: 9 }, () => assetStream(asset, assets.root));
      }
      archive.end();
      await completion;
      template.checkError();
    } catch (error) {
      for (const stream of activeStreams) stream.destroy();
      archive.outputStream.destroy();
      output.destroy();
      await completion.catch(() => {});
      throw error;
    }
    // rename replaces an existing destination only after a complete, closed ZIP.
    await fs.promises.rename(temporary, outputPath);
    temporary = null;
    completed = total;
    progress();
    return { path: outputPath, format: 'zip', target, projectName: name, omittedRuntimeBytes };
  } finally {
    template.zip.close();
    if (temporary) await fs.promises.rm(temporary, { force: true });
  }
}

async function extractWindowsTemplate(templatePath, destination, options) {
  if (!path.isAbsolute(destination)) throw new Error('O destino do template deve ser absoluto.');
  if (options && options.config) assertAPKExport(options.config, { audience: 'creator', locale: options.config.language });
  const template = await inspectTemplate(templatePath, 'windows');
  let created = false;
  try {
    const requirements = options && options.config
      ? projectRuntimeRequirements(options) : null;
    if (requirements) assertTemplateRuntimes(template, 'windows', requirements);
    // A compact template always needs its common archives restored when no
    // project selection is supplied, preserving the old full-template API.
    const restoredSources = await inspectSharedRuntimeSources(template, requirements || { ffmpeg: true }, options && options.sharedRuntimeSourcesDir);
    const selectedEntries = requirements ? selectedTemplateEntries(template, 'windows', requirements)
      : template.entries.filter(item => !template.sharedSources || item.name !== template.sharedSources.markerPath);
    await fs.promises.mkdir(destination); // never merge into an existing tree
    created = true;
    for (const item of selectedEntries) {
      const filename = path.join(destination, ...item.name.replace(/\/$/, '').split('/'));
      if (item.kind === 'directory') await fs.promises.mkdir(filename, { recursive: true });
      else {
        await fs.promises.mkdir(path.dirname(filename), { recursive: true });
        await pipeline(await entryStream(template.zip, item.entry), fs.createWriteStream(filename, { flags: 'wx', mode: item.mode & 0o777 }));
      }
    }
    for (const source of restoredSources) {
      const filename = path.join(destination, ...source.destination.split('/'));
      await fs.promises.mkdir(path.dirname(filename), { recursive: true });
      await pipeline(await assetStream(source, source.root), fs.createWriteStream(filename, { flags: 'wx', mode: 0o644 }));
    }
    template.checkError();
    return destination;
  } catch (error) {
    if (created) await fs.promises.rm(destination, { recursive: true, force: true });
    throw error;
  } finally { template.zip.close(); }
}

module.exports = { exportProject, extractWindowsTemplate, inspectProjectAssets, projectRuntimeRequirements, safeProjectName,
  archiveIO: { LIMITS, validPath, registerPath, verifyStream, openZip, entryStream, assetStream, inspectAssets } };
