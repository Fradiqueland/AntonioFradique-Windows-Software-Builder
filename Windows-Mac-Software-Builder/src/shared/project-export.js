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

const MAC_BUNDLE = 'LaunchBox Viewer.app';
const LIMITS = Object.freeze({ entries: 30000, fileBytes: 2 * 1024 ** 3, totalBytes: 8 * 1024 ** 3, depth: 64 });
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n & 1) ? (0xedb88320 ^ (n >>> 1)) : (n >>> 1);
  return n >>> 0;
});

function safeProjectName(value) {
  let name = String(value || 'My Software').normalize('NFC').replace(/[\\/:<>"|?*\x00-\x1f\x7f]/g, '-').trim();
  name = Array.from(name).slice(0, 80).join('').replace(/[. ]+$/, '');
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

function verifyStream(size, crc32) {
  let count = 0;
  let crc = 0xffffffff;
  return new Transform({
    transform(chunk, encoding, callback) {
      count += chunk.length;
      if (count > size) return callback(new Error('O tamanho do ficheiro ZIP excede o declarado.'));
      if (crc32 !== undefined) for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      callback(null, chunk);
    },
    flush(callback) {
      if (count !== size || (crc32 !== undefined && ((crc ^ 0xffffffff) >>> 0) !== crc32)) {
        return callback(new Error('Ficheiro ZIP corrompido: tamanho ou CRC inválido.'));
      }
      callback();
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
            if (name !== `${MAC_BUNDLE}/` && !name.startsWith(`${MAC_BUNDLE}/`)) throw new Error('O template Mac deve conter apenas LaunchBox Viewer.app.');
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
    if (required.some(name => paths.get(key(name)) !== 'file')) throw new Error('Template incompleto: executável ou app.asar em falta.');
    if (target === 'mac' && !(entries.find(item => item.name === `${MAC_BUNDLE}/Contents/MacOS/LaunchBox Viewer`).mode & 0o111)) {
      throw new Error('O executável do template Mac não tem permissão de execução.');
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
      let pending = name.split('/');
      const resolved = [];
      let followed = 0;
      while (pending.length) {
        const part = pending.shift();
        if (!part || part === '.') continue;
        if (part === '..') {
          if (resolved.length <= 1) throw new Error('Ligação simbólica fora do bundle.');
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
      if (resolved[0] !== MAC_BUNDLE || resolved.length < 2) throw new Error('Ligação simbólica fora do bundle.');
    }
    for (const item of entries.filter(item => item.kind === 'symlink')) resolveLink(item.name);
    if (ioError) throw ioError;
    return { zip, entries, paths, checkError() { if (ioError) throw ioError; } };
  } catch (error) { zip.close(); throw error; }
}

async function inspectAssets(assetsDir) {
  if (!path.isAbsolute(assetsDir)) throw new Error('A pasta de recursos deve ser absoluta.');
  const rootStat = await fs.promises.lstat(assetsDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Pasta de recursos inválida.');
  const root = await fs.promises.realpath(assetsDir);
  const files = [];
  const paths = new Map();
  let bytes = 0;
  async function walk(directory, prefix = '', depth = 0) {
    if (depth > LIMITS.depth) throw new Error('Demasiados níveis de recursos.');
    for (const name of (await fs.promises.readdir(directory)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const absolute = path.join(directory, name);
      const stat = await fs.promises.lstat(absolute);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Recurso não permitido: ${relative}`);
      registerPath(paths, relative, stat.isDirectory() ? 'directory' : 'file');
      if (paths.size > LIMITS.entries) throw new Error('Demasiados recursos.');
      if (stat.isDirectory()) await walk(absolute, relative, depth + 1);
      else {
        if (stat.size > LIMITS.fileBytes || (bytes += stat.size) > LIMITS.totalBytes) throw new Error('Os recursos excedem os limites de tamanho.');
        files.push({ absolute, relative, stat });
      }
    }
  }
  await walk(root);
  return { root, files, paths };
}

async function assetStream(asset, root) {
  const real = await fs.promises.realpath(asset.absolute);
  const relative = path.relative(root, real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('O recurso saiu da pasta do projeto.');
  const handle = await fs.promises.open(asset.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size !== asset.stat.size || actual.ino !== asset.stat.ino || actual.mtimeMs !== asset.stat.mtimeMs) throw new Error('Um recurso mudou durante a exportação.');
    const stream = handle.createReadStream();
    const checked = verifyStream(actual.size);
    stream.on('error', error => checked.destroy(error));
    checked.on('close', () => stream.destroy());
    return stream.pipe(checked);
  } catch (error) { await handle.close(); throw error; }
}

async function exportProject({ target, templatePath, outputPath, projectName, config, assetsDir, requiresPhp = false, onProgress }) {
  if (!['windows', 'mac'].includes(target)) throw new Error('Selecione Windows ou Mac.');
  if (!path.isAbsolute(templatePath) || !path.isAbsolute(outputPath) || path.resolve(templatePath) === path.resolve(outputPath)) throw new Error('Caminhos de exportação inválidos.');
  const name = safeProjectName(projectName);
  const configBytes = Buffer.from(JSON.stringify(config, null, 2));
  if (configBytes.length > 16 * 1024 ** 2) throw new Error('A configuração do projeto é demasiado grande.');
  const assets = await inspectAssets(assetsDir);
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
    if (module.type === 'local-web') requiresPhp = validateWebProject({ data: module.data, assetsDir }).requiresPhp || requiresPhp;
  }
  const template = await inspectTemplate(templatePath, target);
  let temporary;
  try {
    const phpPath = target === 'windows' ? 'resources/php/php.exe' : `${MAC_BUNDLE}/Contents/Resources/php/php`;
    if (requiresPhp && template.paths.get(key(phpPath)) !== 'file') throw new Error(`O template ${target === 'mac' ? 'Mac' : 'Windows'} não inclui o runtime PHP necessário. Instale um runtime para essa plataforma e recrie o template.`);
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
    const total = template.entries.length + assets.files.length + 1;
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
      for (const item of template.entries) {
        const destination = target === 'mac' ? `${name}.app${item.name.slice(MAC_BUNDLE.length)}` : item.name;
        // size belongs only to streamed files. yazl rejects it for directory
        // and buffer entries, including the explicit directories in real apps.
        const options = { mode: item.mode, mtime: item.entry.getLastModDate() };
        if (item.kind === 'directory') { archive.addEmptyDirectory(destination, options); completed++; }
        else if (item.kind === 'symlink') { archive.addBuffer(item.link, destination, options); completed++; }
        else addLazy(destination, { ...options, size: item.entry.uncompressedSize }, () => entryStream(template.zip, item.entry));
      }
      const base = target === 'windows' ? 'resources' : `${name}.data`;
      archive.addEmptyDirectory(`${base}/dist-assets/`, { mode: 0o040755 });
      archive.addBuffer(configBytes, `${base}/data/project-config.json`, { mode: 0o100644 });
      completed++;
      for (const asset of assets.files) addLazy(`${base}/dist-assets/${asset.relative}`, { mode: 0o100644, mtime: asset.stat.mtime, size: asset.stat.size }, () => assetStream(asset, assets.root));
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
    return { path: outputPath, format: 'zip', target, projectName: name };
  } finally {
    template.zip.close();
    if (temporary) await fs.promises.rm(temporary, { force: true });
  }
}

async function extractWindowsTemplate(templatePath, destination) {
  if (!path.isAbsolute(destination)) throw new Error('O destino do template deve ser absoluto.');
  const template = await inspectTemplate(templatePath, 'windows');
  let created = false;
  try {
    await fs.promises.mkdir(destination); // never merge into an existing tree
    created = true;
    for (const item of template.entries) {
      const filename = path.join(destination, ...item.name.replace(/\/$/, '').split('/'));
      if (item.kind === 'directory') await fs.promises.mkdir(filename, { recursive: true });
      else {
        await fs.promises.mkdir(path.dirname(filename), { recursive: true });
        await pipeline(await entryStream(template.zip, item.entry), fs.createWriteStream(filename, { flags: 'wx', mode: item.mode & 0o777 }));
      }
    }
    template.checkError();
    return destination;
  } catch (error) {
    if (created) await fs.promises.rm(destination, { recursive: true, force: true });
    throw error;
  } finally { template.zip.close(); }
}

module.exports = { exportProject, extractWindowsTemplate, safeProjectName };
