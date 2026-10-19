'use strict';

// Editable project backups contain content and configuration, never Electron or
// native runtimes. Import always stages a new project; no existing file is replaced.
const fs = process.versions.electron ? require('original-fs') : require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const yazl = require('yazl');
const { inspectProjectAssets, archiveIO: io } = require('./project-export');
const { validateWebProject } = require('./local-web');
const { validatePortableProject, normalizePortableLink } = require('./portable-app');
const FORMAT = 'windows-mac-software-builder-project';
const MANIFEST = 'project.wsmb.json';
const CONFIG = 'data/project-config.json';
const JSON_LIMIT = 16 * 1024 ** 2;
const dataFile = name => name === CONFIG || /^data\/icon(?:-source(?:-[0-9a-f-]+)?)?\.(?:ico|png|jpe?g)$/i.test(name);
const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function validateReferences(config, files) {
  function reference(value, prefix, directory = false) {
    if (value == null || value === '') return;
    if (typeof value !== 'string' || !value.startsWith(prefix)) throw new Error('Referência de ficheiro inválida no projeto.');
    io.validPath(value);
    const item = files.get(value);
    if (!item || (directory ? item.kind !== 'directory' : item.kind !== 'file')) throw new Error('Recurso do projeto em falta ou inválido: ' + value);
  }
  reference(config.brand?.logo, 'dist-assets/');
  reference(config.export?.iconPath, 'data/');
  reference(config.marketing?.banner?.image, 'dist-assets/');
  for (const slot of ['top', 'bottom']) reference(config.marketing?.banners?.[slot]?.image, 'dist-assets/');
  const ids = new Set();
  for (const mod of config.content || []) {
    if (!mod || typeof mod.id !== 'string' || !mod.id || ids.has(mod.id)) throw new Error('Identificadores de módulos inválidos ou repetidos.');
    ids.add(mod.id);
    const d = mod.data || {};
    reference(d.file, 'dist-assets/');
    for (const image of d.images || []) reference(image?.file, 'dist-assets/');
    if (['portable', 'local-web'].includes(mod.type)) reference(d.root, 'dist-assets/', true);
    if (d.sourcePath) throw new Error('O projeto contém um ficheiro por importar. Guarde os módulos antes de exportar.');
  }
}

function validateModules(config, assetsDir) {
  for (const mod of config.content || []) {
    if (mod.type === 'local-web') validateWebProject({ data: mod.data, assetsDir });
    if (mod.type === 'portable') validatePortableProject({ data: mod.data, assetsDir });
  }
}

async function exportArchive({ projectRoot, outputPath, name, appVersion, readConfig }) {
  const root = await fs.promises.realpath(projectRoot);
  const parent = await fs.promises.realpath(path.dirname(outputPath));
  if (inside(root, parent)) throw new Error('Guarde o arquivo fora da pasta interna do projeto.');
  const config = readConfig(path.join(root, CONFIG));
  validateModules(config, path.join(root, 'dist-assets'));
  const assets = await inspectProjectAssets({ config, assetsDir: path.join(root, 'dist-assets'), target: 'project' });
  const data = await io.inspectAssets(path.join(root, 'data'));
  const entries = [...assets.entries.map(x => ({ ...x, name: 'dist-assets/' + x.relative, root: assets.root })),
    ...data.entries.filter(x => dataFile('data/' + x.relative)).map(x => ({ ...x, name: 'data/' + x.relative, root: data.root }))];
  const refs = new Map(entries.map(x => [x.name, x]));
  validateReferences(config, refs);
  const total = entries.reduce((sum, x) => sum + (x.kind === 'directory' ? 0 : x.kind === 'symlink' ? x.link.length : x.stat.size), 0);
  if (entries.length > io.LIMITS.entries || total > io.LIMITS.totalBytes) throw new Error('Projeto demasiado grande.');
  const temporary = path.join(parent, '.' + path.basename(outputPath) + '.' + crypto.randomUUID() + '.tmp');
  const zip = new yazl.ZipFile();
  const out = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
  const done = pipeline(zip.outputStream, out); done.catch(() => {});
  zip.on('error', err => zip.outputStream.destroy(err));
  const manifest = { format: FORMAT, version: 1, appVersion, name, files: [] };
  const streams = new Set();
  try {
    for (const entry of entries) {
      const record = { path: entry.name, kind: entry.kind, mode: entry.mode & 0o777, size: 0 };
      manifest.files.push(record);
      if (entry.kind === 'directory') zip.addEmptyDirectory(entry.name + '/', { mode: entry.mode });
      else if (entry.kind === 'symlink') {
        record.size = entry.link.length; record.sha256 = hash(entry.link);
        zip.addBuffer(entry.link, entry.name, { mode: entry.mode });
      } else {
        record.size = entry.stat.size;
        // Start each stream only when yazl is ready: media files are never buffered.
        await new Promise((resolve, reject) => {
          zip.addReadStreamLazy(entry.name, { size: record.size, mode: entry.mode, compressionLevel: 6 }, callback => {
            io.assetStream(entry, entry.root).then(source => {
              const digest = crypto.createHash('sha256');
              const pass = new Transform({ transform(chunk, enc, next) { digest.update(chunk); next(null, chunk); },
                flush(next) { record.sha256 = digest.digest('hex'); next(); resolve(); } });
              streams.add(source); streams.add(pass);
              source.on('error', err => pass.destroy(err));
              pass.on('error', err => { zip.outputStream.destroy(err); reject(err); });
              pass.on('close', () => { source.destroy(); streams.delete(source); streams.delete(pass); });
              callback(null, source.pipe(pass));
            }, err => { callback(err); reject(err); });
          });
          done.catch(reject);
        });
      }
    }
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (bytes.length > JSON_LIMIT) throw new Error('Manifesto do projeto demasiado grande.');
    zip.addBuffer(bytes, MANIFEST, { mode: 0o100600 });
    zip.end();
    await done;
    await fs.promises.rename(temporary, outputPath);
    return { ok: true, path: outputPath };
  } catch (err) {
    for (const stream of streams) stream.destroy();
    zip.outputStream.destroy(); out.destroy(); await done.catch(() => {});
    throw err;
  } finally { await fs.promises.rm(temporary, { force: true }); }
}

async function bytes(zip, entry, limit = JSON_LIMIT) {
  if (entry.uncompressedSize > limit) throw new Error('Metadados do arquivo demasiado grandes.');
  const parts = []; for await (const part of await io.entryStream(zip, entry)) parts.push(part);
  return Buffer.concat(parts);
}

async function importArchive({ archivePath, destination, readConfig, platform = process.platform }) {
  const zip = await io.openZip(archivePath);
  let created = false, ioError;
  zip.on('error', err => { ioError = err; });
  try {
    const entries = new Map(), registry = new Map(); let total = 0;
    await new Promise((resolve, reject) => {
      zip.once('error', reject); zip.once('end', resolve);
      zip.on('entry', entry => {
        try {
          if (entries.size > io.LIMITS.entries || entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) throw new Error('Formato ou quantidade de ficheiros inválidos.');
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > io.LIMITS.fileBytes || (total += entry.uncompressedSize) > io.LIMITS.totalBytes + JSON_LIMIT) throw new Error('O arquivo excede os limites de tamanho.');
          const name = entry.fileName.replace(/\/$/, '');
          const mode = entry.externalFileAttributes >>> 16, type = mode & 0o170000;
          const kind = entry.fileName.endsWith('/') ? 'directory' : type === 0o120000 ? 'symlink' : 'file';
          if (type && type !== (kind === 'directory' ? 0o040000 : kind === 'symlink' ? 0o120000 : 0o100000)) throw new Error('Tipo de ficheiro não suportado.');
          if (kind === 'directory' && entry.uncompressedSize) throw new Error('Diretório com conteúdo inválido.');
          io.registerPath(registry, entry.fileName, kind);
          if (!(name === MANIFEST || dataFile(name) || name.startsWith('dist-assets/') || (kind === 'directory' && ['data', 'dist-assets'].includes(name)))) throw new Error('Ficheiro fora do projeto: ' + name);
          if ((name === MANIFEST || name.startsWith('data/')) && kind !== 'file') throw new Error('Metadados devem ser ficheiros normais.');
          entries.set(name, { entry, kind, name, mode: mode & 0o777 });
          zip.readEntry();
        } catch (err) { reject(err); }
      }); zip.readEntry();
    });
    if (!entries.has(MANIFEST) || !entries.has(CONFIG)) throw new Error('Este ficheiro não é um projeto exportado pelo Builder (.wsmb).');
    const manifest = JSON.parse((await bytes(zip, entries.get(MANIFEST).entry)).toString('utf8'));
    if (manifest.format !== FORMAT || manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > io.LIMITS.entries || typeof manifest.name !== 'string') throw new Error('Formato ou versão de projeto não suportados.');
    const records = new Map();
    for (const record of manifest.files) {
      if (!record || typeof record.path !== 'string' || records.has(record.path) || record.path === MANIFEST) throw new Error('Manifesto inválido.');
      const item = entries.get(record.path);
      if (!item || item.kind !== record.kind || item.entry.uncompressedSize !== record.size || item.mode !== record.mode ||
        (item.kind !== 'directory' && !/^[a-f0-9]{64}$/.test(record.sha256 || ''))) throw new Error('O arquivo não corresponde ao manifesto.');
      records.set(record.path, record); item.sha256 = record.sha256;
    }
    for (const item of entries.values()) if (item.name !== MANIFEST && !records.has(item.name) && !(['data', 'dist-assets'].includes(item.name) && item.kind === 'directory')) throw new Error('Ficheiro não declarado no manifesto.');
    const configBytes = await bytes(zip, entries.get(CONFIG).entry);
    if (hash(configBytes) !== entries.get(CONFIG).sha256) throw new Error('Configuração do arquivo corrompida.');
    const rawConfig = JSON.parse(configBytes.toString('utf8'));
    validateReferences(rawConfig, entries);
    const roots = (rawConfig.content || []).filter(m => m.type === 'portable').map(m => m.data.root);
    // Validate links entirely in the archive before creating any filesystem links.
    for (const item of entries.values()) {
      if (item.kind !== 'symlink') continue;
      item.root = roots.find(root => item.name.startsWith(root + '/'));
      if (!item.root) throw new Error('Ligação simbólica fora de um módulo portable.');
      const buffer = await bytes(zip, item.entry, 4096);
      if (hash(buffer) !== item.sha256 || !Buffer.from(buffer.toString('utf8')).equals(buffer)) throw new Error('Ligação corrompida.');
      item.link = normalizePortableLink(buffer.toString('utf8'), 'linux');
    }
    function resolveLink(item) {
      const parts = item.root.split('/'), floor = parts.length;
      let pending = item.name.split('/').slice(floor), follows = 0;
      while (pending.length) {
        const part = pending.shift();
        if (part === '.' || !part) continue;
        if (part === '..') { if (parts.length <= floor) throw new Error('Ligação fora do módulo portable.'); parts.pop(); continue; }
        const node = entries.get([...parts, part].join('/'));
        if (!node) throw new Error('Ligação com destino inexistente.');
        if (node.kind === 'symlink') { if (++follows > 40 || node.root !== item.root) throw new Error('Ciclo ou destino inválido de ligação.'); pending = [...node.link.split('/'), ...pending]; }
        else { if (pending.length && node.kind !== 'directory') throw new Error('Ligação atravessa um ficheiro.'); parts.push(part); }
      }
      return entries.get(parts.join('/'));
    }
    for (const item of entries.values()) if (item.kind === 'symlink') item.target = resolveLink(item);
    const children = new Map();
    for (const item of entries.values()) {
      const parent = path.posix.dirname(item.name);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(item);
    }
    let expandedCount = 0, expandedBytes = 0;
    function checkGraph(item, stack = new Set()) {
      if (++expandedCount > io.LIMITS.entries || (expandedBytes += item.kind === 'file' ? item.entry.uncompressedSize : 0) > io.LIMITS.totalBytes + JSON_LIMIT) throw new Error('Ligações expandem o projeto para além dos limites.');
      if (stack.has(item.name)) throw new Error('Ciclo de diretórios no projeto.');
      const next = new Set(stack).add(item.name);
      if (item.kind === 'symlink') checkGraph(item.target, next);
      else if (item.kind === 'directory') for (const child of children.get(item.name) || []) checkGraph(child, next);
    }
    // Archive exports use explicit asset directories; implicit root directories
    // are allowed. Missing intermediate directories are rejected consistently.
    for (const item of entries.values()) {
      const parent = path.posix.dirname(item.name);
      if (!['.', 'data', 'dist-assets'].includes(parent) && entries.get(parent)?.kind !== 'directory') throw new Error('Diretório pai em falta.');
      if (['data', 'dist-assets'].includes(parent)) checkGraph(item);
    }
    await fs.promises.mkdir(destination, { recursive: false, mode: 0o700 }); created = true;
    await fs.promises.mkdir(path.join(destination, 'data'), { mode: 0o700 });
    await fs.promises.mkdir(path.join(destination, 'dist-assets'), { mode: 0o700 });
    async function writeNode(item, filename) {
      if (item.kind === 'symlink') return writeNode(item.target, filename);
      if (item.kind === 'directory') {
        await fs.promises.mkdir(filename, { recursive: true, mode: 0o700 });
        for (const child of children.get(item.name) || []) await writeNode(child, path.join(filename, path.posix.basename(child.name)));
        if (platform !== 'win32') await fs.promises.chmod(filename, item.mode | 0o700);
      } else {
        await fs.promises.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await pipeline(await io.entryStream(zip, item.entry), io.verifyStream(item.entry.uncompressedSize, undefined, undefined, item.sha256), fs.createWriteStream(filename, { flags: 'wx', mode: item.mode | 0o600 }));
      }
    }
    for (const item of entries.values()) {
      if (item.name === MANIFEST || ['data', 'dist-assets'].includes(item.name)) continue;
      const filename = path.join(destination, ...item.name.split('/'));
      if (item.kind === 'directory') await fs.promises.mkdir(filename, { recursive: true, mode: 0o700 });
      else if (item.kind === 'file') await writeNode(item, filename);
    }
    for (const item of entries.values()) if (item.kind === 'symlink') {
      const filename = path.join(destination, ...item.name.split('/'));
      if (platform === 'win32') await writeNode(item.target, filename);
      else await fs.promises.symlink(item.link, filename, item.target.kind === 'directory' ? 'dir' : 'file');
    }
    if (ioError) throw ioError;
    const config = readConfig(path.join(destination, CONFIG));
    validateModules(config, path.join(destination, 'dist-assets'));
    // Imported portable apps must not share writable runtime state with originals.
    for (const mod of config.content || []) if (mod.type === 'portable') mod.data.revision = crypto.randomUUID();
    await fs.promises.writeFile(path.join(destination, CONFIG), JSON.stringify(config, null, 2));
    // Keep the staged tree writable until validation and normalization complete.
    // Restore portable file/directory permissions, including executable bits.
    if (platform !== 'win32') {
      for (const item of [...entries.values()].sort((a, b) => b.name.length - a.name.length)) {
        if (item.name === MANIFEST || item.name === CONFIG || item.kind === 'symlink') continue;
        await fs.promises.chmod(path.join(destination, ...item.name.split('/')), item.mode);
      }
    }
    return { name: manifest.name, config };
  } catch (err) {
    if (created) await fs.promises.rm(destination, { recursive: true, force: true });
    throw err;
  } finally { zip.close(); }
}
module.exports = { exportArchive, importArchive, validateReferences };
