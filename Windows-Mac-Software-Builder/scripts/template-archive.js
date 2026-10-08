'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const yazl = require('yazl');
const { markerPath, validateSourceMarker } = require('./template-sources');

const layouts = {
  'windows-x64': {
    folder: 'win-unpacked',
    required: ['LaunchBox Viewer.exe', 'resources/app.asar', 'resources/app-mode.json', 'LICENSES.chromium.html', 'LICENSE.electron.txt']
  },
  'mac-universal': {
    folder: 'mac-universal/LaunchBox Viewer.app',
    companion: 'LaunchBox Viewer.data',
    required: ['LaunchBox Viewer.app/Contents/MacOS/LaunchBox Viewer', 'LaunchBox Viewer.app/Contents/Info.plist', 'LaunchBox Viewer.app/Contents/Resources/app.asar', 'LaunchBox Viewer.app/Contents/Resources/app-mode.json', 'LaunchBox Viewer.app/Contents/_CodeSignature/CodeResources']
  }
};

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function zipTree(source, destination, { includeRoot = true, companions = [] } = {}) {
  if (!Array.isArray(companions) || !includeRoot && companions.length) throw new Error('Companion trees require explicit archive roots.');
  const roots = [source, ...companions].map(file => path.resolve(file));
  if (new Set(roots.map(file => path.basename(file).toLowerCase())).size !== roots.length) throw new Error('Duplicate template root name.');
  const zip = new yazl.ZipFile();
  const writing = pipeline(zip.outputStream, fs.createWriteStream(destination));
  zip.on('error', (error) => zip.outputStream.destroy(error));
  function visit(file, treeRoot, parent) {
    const stat = fs.lstatSync(file);
    const relative = path.relative(parent, file).split(path.sep).join('/');
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(file);
      const resolved = path.resolve(path.dirname(file), link);
      if (path.isAbsolute(link) || !resolved.startsWith(treeRoot + path.sep)) throw new Error('Symlink escapes the template tree: ' + relative);
      zip.addBuffer(Buffer.from(link), relative, { mode: stat.mode, mtime: stat.mtime, compress: false });
    } else if (stat.isDirectory()) {
      zip.addEmptyDirectory(relative, { mode: stat.mode, mtime: stat.mtime });
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), treeRoot, parent);
    } else if (stat.isFile()) {
      zip.addFile(file, relative, { mode: stat.mode, mtime: stat.mtime, compressionLevel: 9 });
    } else {
      throw new Error('Unsupported template file type: ' + relative);
    }
  }
  try {
    for (const treeRoot of roots) {
      const parent = includeRoot ? path.dirname(treeRoot) : treeRoot;
      if (includeRoot) visit(treeRoot, treeRoot, parent);
      else for (const name of fs.readdirSync(treeRoot).sort()) visit(path.join(treeRoot, name), treeRoot, parent);
    }
    zip.end();
  } catch (error) { zip.outputStream.destroy(error); }
  return writing;
}

function inspectTemplate(archive, target) {
  const layout = layouts[target];
  if (!layout) return Promise.reject(new Error('Unsupported template target: ' + target));
  return new Promise((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true, strictFileNames: true }, (error, zip) => {
      if (error) return reject(error);
      const found = new Set();
      let symlinks = 0;
      let validExecutable = target === 'windows-x64';
      let mode;
      let sharedSources;
      const fail = (err) => { zip.close(); reject(err); };
      zip.on('error', fail);
      zip.on('entry', (entry) => {
        const name = entry.fileName;
        if (found.has(name)) return fail(new Error('Duplicate template entry: ' + name));
        if (target === 'mac-universal' && !name.startsWith('LaunchBox Viewer.app/') && !/^LaunchBox Viewer\.data\/(?:$|(?:ffmpeg|php)(?:\/|$))/.test(name)) return fail(new Error('Unexpected Mac template root: ' + name));
        found.add(name);
        const unixMode = entry.externalFileAttributes >>> 16;
        if ((unixMode & 0o170000) === 0o120000) symlinks++;
        if (name === 'LaunchBox Viewer.app/Contents/MacOS/LaunchBox Viewer') validExecutable = !!(unixMode & 0o111);
        const isSourceMarker = name === markerPath(target);
        if (name === layout.required[3] && target === 'mac-universal' || name === 'resources/app-mode.json' || isSourceMarker) {
          if (isSourceMarker && (unixMode & 0o170000) === 0o120000) return fail(new Error('Shared source marker must be a physical file.'));
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return fail(streamError);
            const buffers = [];
            let size = 0;
            stream.on('data', (buffer) => {
              size += buffer.length;
              if (size > 4096) stream.destroy(new Error('Invalid template metadata size'));
              else buffers.push(buffer);
            });
            stream.on('error', fail);
            stream.on('end', () => {
              try {
                const metadata = JSON.parse(Buffer.concat(buffers).toString('utf8'));
                if (isSourceMarker) sharedSources = validateSourceMarker(metadata).sources;
                else mode = metadata;
              } catch (jsonError) { return fail(jsonError); }
              zip.readEntry();
            });
          });
        } else zip.readEntry();
      });
      zip.on('end', () => {
        const missing = layout.required.filter((name) => !found.has(name));
        if (missing.length) return reject(new Error('Incomplete ' + target + ' template: ' + missing.join(', ')));
        if (mode?.mode !== 'viewer') return reject(new Error('Template must use viewer mode: ' + archive));
        if (!validExecutable || target === 'mac-universal' && !symlinks) return reject(new Error('Mac archive lost executable permissions or framework symlinks.'));
        const companionRuntimes = target === 'mac-universal' ? ['ffmpeg', 'php'].filter(runtime => [...found].some(name => name.startsWith(layout.companion + '/' + runtime + '/'))) : [];
        const runtimeLayout = companionRuntimes.length ? 'external-data-v1' : 'bundled-v1';
        for (const runtime of companionRuntimes) if (!found.has(layout.companion + '/' + runtime + '/' + runtime)) return reject(new Error('Companion runtime has no executable: ' + runtime));
        if (sharedSources) for (const entry of sharedSources) {
          const file = markerPath(target).replace(/template-sources\.json$/, 'sources/' + entry.file);
          if (found.has(file)) return reject(new Error('Template contains both shared and duplicated source archives: ' + file));
        }
        resolve({ entries: found.size, symlinks, mode: mode.mode, runtimeLayout, companionRuntimes, sourceLayout: sharedSources ? 'shared-in-builder-v1' : 'bundled-v1', ...(sharedSources ? { sharedSources } : {}) });
      });
      zip.readEntry();
    });
  });
}

module.exports = { layouts, sha256, zipTree, inspectTemplate };
