'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const yazl = require('yazl');

const layouts = {
  'windows-x64': {
    folder: 'win-unpacked',
    required: ['LaunchBox Viewer.exe', 'resources/app.asar', 'resources/app-mode.json', 'LICENSES.chromium.html', 'LICENSE.electron.txt']
  },
  'mac-universal': {
    folder: 'mac-universal/LaunchBox Viewer.app',
    required: ['LaunchBox Viewer.app/Contents/MacOS/LaunchBox Viewer', 'LaunchBox Viewer.app/Contents/Info.plist', 'LaunchBox Viewer.app/Contents/Resources/app.asar', 'LaunchBox Viewer.app/Contents/Resources/app-mode.json', 'LaunchBox Viewer.app/Contents/_CodeSignature/CodeResources']
  }
};

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function zipTree(source, destination, { includeRoot = true } = {}) {
  const zip = new yazl.ZipFile();
  const parent = includeRoot ? path.dirname(source) : source;
  const writing = pipeline(zip.outputStream, fs.createWriteStream(destination));
  zip.on('error', (error) => zip.outputStream.destroy(error));
  function visit(file) {
    const stat = fs.lstatSync(file);
    const relative = path.relative(parent, file).split(path.sep).join('/');
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(file);
      const resolved = path.resolve(path.dirname(file), link);
      if (path.isAbsolute(link) || !resolved.startsWith(source + path.sep)) throw new Error('Symlink escapes the app bundle: ' + relative);
      zip.addBuffer(Buffer.from(link), relative, { mode: stat.mode, mtime: stat.mtime, compress: false });
    } else if (stat.isDirectory()) {
      zip.addEmptyDirectory(relative, { mode: stat.mode, mtime: stat.mtime });
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
    } else if (stat.isFile()) {
      zip.addFile(file, relative, { mode: stat.mode, mtime: stat.mtime });
    } else {
      throw new Error('Unsupported template file type: ' + relative);
    }
  }
  try {
    if (includeRoot) visit(source);
    else for (const name of fs.readdirSync(source).sort()) visit(path.join(source, name));
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
      const fail = (err) => { zip.close(); reject(err); };
      zip.on('error', fail);
      zip.on('entry', (entry) => {
        const name = entry.fileName;
        found.add(name);
        const unixMode = entry.externalFileAttributes >>> 16;
        if ((unixMode & 0o170000) === 0o120000) symlinks++;
        if (name === 'LaunchBox Viewer.app/Contents/MacOS/LaunchBox Viewer') validExecutable = !!(unixMode & 0o111);
        if (name === layout.required[3] && target === 'mac-universal' || name === 'resources/app-mode.json') {
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return fail(streamError);
            const buffers = [];
            let size = 0;
            stream.on('data', (buffer) => {
              size += buffer.length;
              if (size > 4096) stream.destroy(new Error('Invalid app-mode.json size'));
              else buffers.push(buffer);
            });
            stream.on('error', fail);
            stream.on('end', () => {
              try { mode = JSON.parse(Buffer.concat(buffers).toString('utf8')); } catch (jsonError) { return fail(jsonError); }
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
        resolve({ entries: found.size, symlinks, mode: mode.mode });
      });
      zip.readEntry();
    });
  });
}

module.exports = { layouts, sha256, zipTree, inspectTemplate };
