'use strict';

// Portable programs are native, trusted code. Scanning never executes them.
// Physical fs is required to preserve Electron app.asar files as opaque bytes.
const fs = process.versions.electron ? require('original-fs') : require('fs');
const path = require('path');
const crypto = require('crypto');

const LIMITS = Object.freeze({ entries: 30000, fileBytes: 2 * 1024 ** 3, totalBytes: 8 * 1024 ** 3, depth: 64, plistBytes: 1024 ** 2 });
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ROOT_PATTERN = new RegExp(`^dist-assets/portable-${UUID}$`);
const REVISION_PATTERN = new RegExp(`^${UUID}$`);
const PE_ARCH = new Map([[0x14c, 'ia32'], [0x8664, 'x64'], [0xaa64, 'arm64'], [0x1c4, 'arm'], [0x1c0, 'arm']]);
const MACH_ARCH = new Map([[7, 'ia32'], [0x1000007, 'x64'], [12, 'arm'], [0x100000c, 'arm64']]);

function inside(root, filename, allowRoot = false) {
  const relative = path.relative(root, filename);
  return (allowRoot || relative !== '') && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeName(name) {
  return name && name !== '.' && name !== '..' && !/[\\/:<>"|?*\x00-\x1f\x7f]/.test(name) && !/[. ]$/.test(name) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

function directoryRoot(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('Selecione uma pasta com caminho absoluto.');
  const stat = fs.lstatSync(filename);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('A origem deve ser uma pasta normal, sem ligação simbólica.');
  return fs.realpathSync(filename);
}

function scanTree(sourcePath) {
  const rootPath = directoryRoot(sourcePath);
  const nodes = new Map([['', { relative: '', absolute: rootPath, kind: 'directory', stat: fs.lstatSync(rootPath) }]]);
  const names = new Set();
  let files = 0;
  let bytes = 0;
  function walk(directory, prefix, depth) {
    if (depth > LIMITS.depth) throw new Error('A aplicação excede 64 níveis de pastas.');
    for (const name of fs.readdirSync(directory).sort()) {
      if (!safeName(name)) throw new Error(`Nome incompatível com a importação: ${name}`);
      const relative = prefix ? `${prefix}/${name}` : name;
      const canonical = relative.normalize('NFD').toLowerCase();
      if (names.has(canonical)) throw new Error(`Ficheiros com nomes ambíguos: ${relative}`);
      names.add(canonical);
      if (nodes.size >= LIMITS.entries) throw new Error('A aplicação excede 30000 ficheiros e pastas.');
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null;
      if (!kind) throw new Error(`Tipo de ficheiro não permitido: ${relative}`);
      const node = { relative, absolute, stat, kind };
      nodes.set(relative, node);
      if (kind === 'directory') walk(absolute, relative, depth + 1);
      else if (kind === 'file') {
        files++;
        bytes += stat.size;
        if (stat.size > LIMITS.fileBytes || bytes > LIMITS.totalBytes) throw new Error('A aplicação excede os limites: 2 GB por ficheiro ou 8 GB no total.');
      } else {
        node.link = fs.readlinkSync(absolute);
        if (!node.link || node.link.length > 4096 || path.posix.isAbsolute(node.link) || /[\\:\x00-\x1f\x7f]/.test(node.link)) throw new Error(`Ligação simbólica externa ou inválida: ${relative}`);
      }
    }
  }
  walk(rootPath, '', 0);
  function resolve(relative) {
    const current = [];
    let pending = relative.split('/');
    let links = 0;
    while (pending.length) {
      const part = pending.shift();
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!current.length) throw new Error(`Ligação simbólica fora da aplicação: ${relative}`);
        current.pop();
        continue;
      }
      const lookup = [...current, part].join('/');
      const node = nodes.get(lookup);
      if (!node) throw new Error(`Ligação simbólica com destino inexistente: ${relative}`);
      if (node.kind === 'symlink') {
        if (++links > 64) throw new Error(`Ciclo de ligações simbólicas: ${relative}`);
        pending = [...node.link.split('/'), ...pending];
      } else {
        if (pending.length && node.kind !== 'directory') throw new Error(`Ligação simbólica atravessa um ficheiro: ${relative}`);
        current.push(part);
      }
    }
    return nodes.get(current.join('/'));
  }
  const children = new Map();
  for (const node of nodes.values()) {
    if (!node.relative) continue;
    if (node.kind === 'symlink') node.resolved = resolve(node.relative);
    const parent = path.posix.dirname(node.relative);
    const key = parent === '.' ? '' : parent;
    if (!children.has(key)) children.set(key, []);
    const target = node.kind === 'symlink' ? node.resolved : node;
    if (target.kind === 'directory') children.get(key).push(target.relative);
  }
  const visited = new Set();
  const active = new Set();
  function directoryCycles(relative) {
    if (active.has(relative)) throw new Error('Ciclo de ligações simbólicas entre pastas.');
    if (visited.has(relative)) return;
    active.add(relative);
    for (const child of children.get(relative) || []) directoryCycles(child);
    active.delete(relative);
    visited.add(relative);
  }
  directoryCycles('');
  return { rootPath, nodes, resolve, files, bytes, hasSymlinks: [...nodes.values()].some(node => node.kind === 'symlink') };
}

function nativeHeader(filename, stat) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const actual = fs.fstatSync(fd);
    if (!actual.isFile() || actual.size !== stat.size || actual.ino !== stat.ino) throw new Error('Um ficheiro mudou durante a análise.');
    function read(offset, size) {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > actual.size) return null;
      const data = Buffer.alloc(size);
      return fs.readSync(fd, data, 0, size, offset) === size ? data : null;
    }
    const first = read(0, 64);
    if (first && first[0] === 0x4d && first[1] === 0x5a) {
      const offset = first.readUInt32LE(0x3c);
      const header = offset >= 64 ? read(offset, 26) : null;
      if (!header || header.readUInt32LE(0) !== 0x4550) return null;
      const characteristics = header.readUInt16LE(22);
      const optional = header.readUInt16LE(20);
      const magic = header.readUInt16LE(24);
      const arch = PE_ARCH.get(header.readUInt16LE(4));
      if (!arch || !(characteristics & 2) || (characteristics & 0x2000) || optional < (magic === 0x20b ? 112 : 96) || offset + 24 + optional > actual.size || ![0x10b, 0x20b].includes(magic)) return null;
      if ((['x64', 'arm64'].includes(arch) ? 0x20b : 0x10b) !== magic) return null;
      return { platform: 'windows', kind: 'exe', architectures: [arch] };
    }
    function thin(offset, sliceSize) {
      const head = read(offset, 32);
      if (!head) return null;
      const magic = head.readUInt32BE(0);
      const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
      if (![0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return null;
      const uint = at => little ? head.readUInt32LE(at) : head.readUInt32BE(at);
      const arch = MACH_ARCH.get(uint(4));
      const size = [0xfeedfacf, 0xcffaedfe].includes(magic) ? 32 : 28;
      if (!arch || uint(12) !== 2 || size + uint(20) > sliceSize) return null;
      return arch;
    }
    const magicBytes = read(0, 8);
    if (!magicBytes) return null;
    const magic = magicBytes.readUInt32BE(0);
    if ([0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic)) {
      const little = magic === 0xbebafeca || magic === 0xbfbafeca;
      const fat64 = magic === 0xcafebabf || magic === 0xbfbafeca;
      const uint = (buf, offset) => little ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
      const count = uint(magicBytes, 4);
      if (!count || count > 16) return null;
      const size = fat64 ? 32 : 20;
      const table = read(8, count * size);
      if (!table) return null;
      const arches = [];
      for (let i = 0; i < count; i++) {
        const at = i * size;
        const offset = fat64 ? Number(little ? table.readBigUInt64LE(at + 8) : table.readBigUInt64BE(at + 8)) : uint(table, at + 8);
        const length = fat64 ? Number(little ? table.readBigUInt64LE(at + 16) : table.readBigUInt64BE(at + 16)) : uint(table, at + 12);
        const arch = Number.isSafeInteger(length) && offset >= 8 + count * size && offset + length <= actual.size ? thin(offset, length) : null;
        if (!arch || arch !== MACH_ARCH.get(uint(table, at))) return null;
        arches.push(arch);
      }
      return { platform: 'mac', kind: 'mach-o', architectures: [...new Set(arches)] };
    }
    const arch = thin(0, actual.size);
    return arch ? { platform: 'mac', kind: 'mach-o', architectures: [arch] } : null;
  } finally { fs.closeSync(fd); }
}

function plistExecutable(buffer) {
  if (buffer.subarray(0, 8).toString() !== 'bplist00') {
    const xml = buffer.toString('utf8').replace(/<!--[\s\S]*?-->/g, '');
    if (!/<plist(?:\s[^>]*)?>\s*<dict>/.test(xml)) throw new Error('Info.plist XML sem dicionário principal.');
    const matches = [];
    let depth = 0;
    const tokens = /<dict>|<\/dict>|<key>\s*CFBundleExecutable\s*<\/key>/g;
    for (const token of xml.matchAll(tokens)) {
      if (token[0] === '<dict>') depth++;
      else if (token[0] === '</dict>') depth--;
      else if (depth === 1) {
        const value = xml.slice(token.index + token[0].length).match(/^\s*<string>([^<]*)<\/string>/);
        if (!value) throw new Error('CFBundleExecutable deve ser do tipo string.');
        matches.push(value);
      }
      if (depth < 0) throw new Error('Info.plist XML inválido.');
    }
    if (depth !== 0) throw new Error('Info.plist XML inválido.');
    if (matches.length !== 1) throw new Error('Info.plist deve ter um único CFBundleExecutable do tipo string.');
    return matches[0][1].replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, entity => {
      const known = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
      if (known[entity]) return known[entity];
      const code = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
      return String.fromCodePoint(code);
    });
  }
  // Read only the top-level dictionary and strings required by this feature.
  // No object construction, recursion, code execution or external plist tool.
  if (buffer.length < 40) throw new Error('Info.plist binário inválido.');
  const trailer = buffer.length - 32;
  const offsetSize = buffer[trailer + 6];
  const refSize = buffer[trailer + 7];
  function integer(at, size) {
    if (![1, 2, 4, 8].includes(size) || at < 0 || at + size > buffer.length) throw new Error('Info.plist binário inválido.');
    let value = 0n;
    for (let i = 0; i < size; i++) value = (value << 8n) | BigInt(buffer[at + i]);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Info.plist binário excede os limites.');
    return Number(value);
  }
  const count = integer(trailer + 8, 8);
  const top = integer(trailer + 16, 8);
  const table = integer(trailer + 24, 8);
  if (!count || count > 100000 || top >= count || ![1, 2, 4, 8].includes(offsetSize) || ![1, 2, 4, 8].includes(refSize) || table < 8 || table + count * offsetSize > trailer) throw new Error('Info.plist binário inválido.');
  function object(ref) {
    if (ref >= count) throw new Error('Referência inválida no Info.plist.');
    let at = integer(table + ref * offsetSize, offsetSize);
    if (at < 8 || at >= table) throw new Error('Objeto inválido no Info.plist.');
    const marker = buffer[at++];
    let length = marker & 15;
    if (length === 15) {
      const sizeMarker = buffer[at++];
      if ((sizeMarker >> 4) !== 1 || (sizeMarker & 15) > 3) throw new Error('Comprimento inválido no Info.plist.');
      const size = 1 << (sizeMarker & 15);
      length = integer(at, size);
      at += size;
    }
    return { type: marker >> 4, length, at };
  }
  function string(ref) {
    const item = object(ref);
    const size = item.type === 6 ? item.length * 2 : item.length;
    if (![5, 6].includes(item.type) || item.at + size > table) throw new Error('String inválida no Info.plist.');
    const bytes = Buffer.from(buffer.subarray(item.at, item.at + size));
    return item.type === 6 ? bytes.swap16().toString('utf16le') : bytes.toString('ascii');
  }
  const dict = object(top);
  if (dict.type !== 13 || dict.at + dict.length * refSize * 2 > table) throw new Error('Info.plist sem dicionário principal.');
  let executable;
  for (let i = 0; i < dict.length; i++) {
    if (string(integer(dict.at + i * refSize, refSize)) !== 'CFBundleExecutable') continue;
    if (executable !== undefined) throw new Error('CFBundleExecutable duplicado.');
    executable = string(integer(dict.at + (dict.length + i) * refSize, refSize));
  }
  if (executable === undefined) throw new Error('Info.plist sem CFBundleExecutable.');
  return executable;
}

function inspectFolder(sourcePath) {
  const tree = scanTree(sourcePath);
  const sourceName = path.basename(tree.rootPath);
  const candidates = [];
  const bundles = [...tree.nodes.values()].filter(node => node.kind === 'directory' && /\.app$/i.test(node.relative || sourceName));
  const outerBundles = bundles.filter(node => !bundles.some(parent => parent !== node && (!parent.relative || node.relative.startsWith(`${parent.relative}/`))));
  for (const bundle of outerBundles) {
    if (!bundle.relative && !safeName(sourceName)) throw new Error('O nome do bundle Mac não é compatível com a importação.');
    const prefix = bundle.relative ? `${bundle.relative}/` : '';
    const plist = tree.nodes.get(`${prefix}Contents/Info.plist`);
    if (!plist || plist.kind !== 'file' || plist.stat.size > LIMITS.plistBytes) throw new Error(`A aplicação ${bundle.relative || sourceName} não tem um Info.plist válido.`);
    const fd = fs.openSync(plist.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let plistBytes;
    try {
      const actual = fs.fstatSync(fd);
      if (!actual.isFile() || actual.ino !== plist.stat.ino || actual.size !== plist.stat.size || actual.size > LIMITS.plistBytes) throw new Error('Info.plist mudou durante a análise.');
      plistBytes = Buffer.alloc(actual.size);
      if (fs.readSync(fd, plistBytes, 0, plistBytes.length, 0) !== plistBytes.length) throw new Error('Info.plist mudou durante a análise.');
    } finally { fs.closeSync(fd); }
    const executable = plistExecutable(plistBytes);
    if (!safeName(executable)) throw new Error('CFBundleExecutable não é um nome de ficheiro seguro.');
    let binary;
    try { binary = tree.resolve(`${prefix}Contents/MacOS/${executable}`); } catch (_) { throw new Error(`Executável do bundle em falta: ${executable}`); }
    const native = binary.kind === 'file' ? nativeHeader(binary.absolute, binary.stat) : null;
    if (!native || native.platform !== 'mac') throw new Error(`O executável ${executable} não é um programa Mach-O válido.`);
    candidates.push({ path: bundle.relative || '.', ...native, kind: 'app', label: path.posix.basename(bundle.relative || sourceName), executable: !!(binary.stat.mode & 0o111) });
  }
  for (const node of tree.nodes.values()) {
    if (node.kind !== 'file' || outerBundles.some(bundle => !bundle.relative || node.relative.startsWith(`${bundle.relative}/`))) continue;
    const native = nativeHeader(node.absolute, node.stat);
    if (!native || (native.platform === 'windows' && !/\.exe$/i.test(node.relative))) continue;
    candidates.push({ path: node.relative, ...native, label: path.posix.basename(node.relative), executable: !!(node.stat.mode & 0o111) });
  }
  function rank(candidate) {
    return candidate.path.split('/').length * 10 + (/unins|uninstall|helper|crashpad|updater|crashreport/i.test(candidate.label) ? 100 : 0);
  }
  candidates.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
  return { ...tree, sourceName, candidates };
}

function scanPortableFolder(sourcePath) {
  const { sourceName, candidates, files, bytes, hasSymlinks } = inspectFolder(sourcePath);
  return { sourceName, candidates, files, bytes, hasSymlinks };
}

function selectedEntries(scan, entries) {
  if (!entries || typeof entries !== 'object') throw new Error('Escolha pelo menos um executável Windows ou Mac.');
  const result = {};
  for (const platform of ['windows', 'mac']) {
    const value = entries[platform];
    if (value == null || value === '') result[platform] = null;
    else {
      if (typeof value !== 'string' || !scan.candidates.some(candidate => candidate.platform === platform && candidate.path === value)) throw new Error(`O executável selecionado para ${platform} não é válido.`);
      result[platform] = value;
    }
  }
  if (!result.windows && !result.mac) throw new Error('Escolha pelo menos um executável Windows ou Mac.');
  return result;
}

function copyTree(scan, destination, dereferenceLinks = false) {
  const children = new Map();
  for (const node of scan.nodes.values()) {
    if (!node.relative) continue;
    const parent = path.posix.dirname(node.relative);
    const relative = parent === '.' ? '' : parent;
    if (!children.has(relative)) children.set(relative, []);
    children.get(relative).push(node);
  }
  let count = 0;
  let bytes = 0;
  function copyNode(source, relative) {
    if (++count > LIMITS.entries) throw new Error('A cópia excede o limite de ficheiros e pastas.');
    const filename = relative ? path.join(destination, ...relative.split('/')) : destination;
    const node = dereferenceLinks && source.kind === 'symlink' ? source.resolved : source;
    if (source.kind === 'symlink' && fs.readlinkSync(source.absolute) !== source.link) throw new Error('Uma ligação simbólica mudou durante a cópia.');
    if (node.kind === 'directory') {
      if (relative) fs.mkdirSync(filename, { mode: 0o700 });
      for (const child of children.get(node.relative) || []) {
        const childName = path.posix.basename(child.relative);
        copyNode(child, relative ? `${relative}/${childName}` : childName);
      }
      fs.chmodSync(filename, node.stat.mode & 0o777);
    } else if (node.kind === 'symlink') {
      try { fs.symlinkSync(node.link, filename, node.resolved.kind === 'directory' ? 'dir' : 'file'); }
      catch (error) {
        if (error.code === 'EPERM') throw new Error('Não foi possível preservar as ligações simbólicas. Ative o Modo de Programador do Windows ou importe a aplicação num Mac.');
        throw error;
      }
    } else {
      if ((bytes += node.stat.size) > LIMITS.totalBytes) throw new Error('A cópia excede o limite total de 8 GB.');
      if (!inside(scan.rootPath, fs.realpathSync(node.absolute))) throw new Error('Um ficheiro saiu da pasta da aplicação.');
      const input = fs.openSync(node.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const stat = fs.fstatSync(input);
        if (!stat.isFile() || stat.ino !== node.stat.ino || stat.dev !== node.stat.dev || stat.size !== node.stat.size || stat.mtimeMs !== node.stat.mtimeMs) throw new Error('Um ficheiro mudou durante a cópia.');
        const output = fs.openSync(filename, 'wx', 0o600);
        try {
          const buffer = Buffer.alloc(1024 * 1024);
          let copied = 0;
          while (copied < stat.size) {
            const amount = fs.readSync(input, buffer, 0, Math.min(buffer.length, stat.size - copied), null);
            if (!amount) throw new Error('Um ficheiro mudou durante a cópia.');
            let written = 0;
            while (written < amount) written += fs.writeSync(output, buffer, written, amount - written);
            copied += amount;
          }
          if (fs.readSync(input, buffer, 0, 1, null) || fs.fstatSync(input).mtimeMs !== stat.mtimeMs) throw new Error('Um ficheiro mudou durante a cópia.');
        } finally { fs.closeSync(output); }
        fs.chmodSync(filename, node.stat.mode & 0o777);
      } finally { fs.closeSync(input); }
    }
  }
  copyNode(scan.nodes.get(''), '');
}

function copyPortableTree(sourcePath, destination, { dereferenceLinks = false } = {}) {
  const scan = scanTree(sourcePath);
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('Destino inválido para a cópia da aplicação.');
  const realDestination = path.join(directoryRoot(path.dirname(destination)), path.basename(destination));
  if (inside(scan.rootPath, realDestination, true)) throw new Error('Destino inválido para a cópia da aplicação.');
  fs.mkdirSync(destination, { mode: 0o700 }); // Must be a new directory; never merge.
  try { copyTree(scan, destination, dereferenceLinks === true); return destination; }
  catch (error) { fs.rmSync(destination, { recursive: true, force: true }); throw error; }
}

function importPortableProject({ sourcePath, assetsDir, entries, allowWine = false }) {
  const scan = inspectFolder(sourcePath);
  const selected = selectedEntries(scan, entries);
  const base = directoryRoot(assetsDir);
  if (inside(scan.rootPath, base, true) || inside(base, scan.rootPath, true)) throw new Error('A origem e a pasta de recursos não podem conter-se uma à outra.');
  const root = `dist-assets/portable-${crypto.randomUUID()}`;
  const rootPath = path.join(base, root.slice('dist-assets/'.length));
  fs.mkdirSync(rootPath, { mode: 0o700 });
  try {
    const rootBundle = scan.candidates.some(candidate => candidate.kind === 'app' && candidate.path === '.');
    const destination = rootBundle ? path.join(rootPath, scan.sourceName) : rootPath;
    if (rootBundle) fs.mkdirSync(destination, { mode: 0o700 });
    copyTree(scan, destination);
    if (rootBundle) selected.mac = selected.mac === '.' ? scan.sourceName : selected.mac;
    const imported = inspectFolder(rootPath);
    return { root, sourceName: scan.sourceName, entries: selectedEntries(imported, selected), allowWine: allowWine === true,
      candidates: imported.candidates, revision: crypto.randomUUID() };
  } catch (error) { fs.rmSync(rootPath, { recursive: true, force: true }); throw error; }
}

function managedPath({ data, assetsDir }) {
  if (!data || !ROOT_PATTERN.test(data.root || '')) throw new Error('O diretório da aplicação portátil não é válido.');
  const base = directoryRoot(assetsDir);
  const rootPath = directoryRoot(path.join(base, data.root.slice('dist-assets/'.length)));
  if (!inside(base, rootPath)) throw new Error('A aplicação portátil está fora da pasta de recursos.');
  return rootPath;
}

function validatePortableProject({ data, assetsDir }) {
  const rootPath = managedPath({ data, assetsDir });
  if (!REVISION_PATTERN.test(data.revision || '')) throw new Error('A revisão da aplicação portátil não é válida.');
  const scan = inspectFolder(rootPath);
  const entries = selectedEntries(scan, data.entries);
  return { rootPath, sourceName: typeof data.sourceName === 'string' ? data.sourceName : scan.sourceName,
    entries, launchPaths: Object.fromEntries(Object.entries(entries).map(([target, value]) => [target, value ? path.join(rootPath, ...value.split('/')) : null])),
    allowWine: data.allowWine === true, candidates: scan.candidates, revision: data.revision, files: scan.files, bytes: scan.bytes, hasSymlinks: scan.hasSymlinks };
}

function updatePortableProject({ data, assetsDir, entries, allowWine }) {
  const validated = validatePortableProject({ data, assetsDir });
  return { root: data.root, sourceName: validated.sourceName, entries: selectedEntries(validated, entries),
    allowWine: allowWine === true, candidates: validated.candidates, revision: validated.revision };
}

function removePortableProject({ data, assetsDir }) {
  try { fs.rmSync(managedPath({ data, assetsDir }), { recursive: true, force: true }); return true; }
  catch (error) { if (error.code === 'ENOENT' && data && ROOT_PATTERN.test(data.root || '')) return false; throw error; }
}

function assertPortableTarget({ data, assetsDir, target }) {
  if (!['windows', 'mac'].includes(target)) throw new Error('Destino portátil inválido: selecione Windows ou Mac.');
  const validated = validatePortableProject({ data, assetsDir });
  let selected = validated.entries[target];
  const requiresWine = target === 'mac' && !selected && !!validated.entries.windows && validated.allowWine;
  if (requiresWine) selected = validated.entries.windows;
  if (!selected) throw new Error(target === 'windows' ? 'A aplicação portátil não tem um executável Windows selecionado.' : 'A aplicação portátil não tem uma versão Mac. Selecione uma aplicação Mac ou autorize explicitamente Wine.');
  const candidate = validated.candidates.find(item => item.path === selected && item.platform === (requiresWine ? 'windows' : target));
  if (target === 'mac' && !requiresWine && !candidate.executable) throw new Error('Executável Mac sem permissão de execução. Importe a aplicação num Mac preservando as permissões e volte a exportar.');
  return { ...validated, target, launchPath: path.join(validated.rootPath, ...selected.split('/')), launchKind: candidate.kind,
    architectures: candidate.architectures, requiresWine,
    warnings: requiresWine ? ['Esta aplicação requer Wine instalado no Mac. A compatibilidade não é garantida; não é convertida numa aplicação Mac nativa.'] : [] };
}

module.exports = { LIMITS, copyPortableTree, scanPortableFolder, importPortableProject, validatePortableProject, updatePortableProject, removePortableProject, assertPortableTarget };
