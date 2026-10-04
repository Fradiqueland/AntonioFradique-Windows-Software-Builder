'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// Native runtimes are optional. In particular, a Windows executable must never
// accidentally become the runtime of a Mac application.
function runtimeDirectory(runtime, target) {
  if (!['windows-x64', 'mac-universal'].includes(target)) throw new Error('Unsupported target: ' + target);
  const executable = runtime + (target === 'windows-x64' ? '.exe' : '');
  const candidates = [path.join('vendor', runtime, target)];
  if (target === 'windows-x64') candidates.push(path.join('vendor', runtime));
  return candidates.find((relative) => fs.existsSync(path.join(root, relative, executable))) || null;
}

function runtimeResources(target) {
  return ['php', 'ffmpeg'].flatMap((runtime) => {
    const from = runtimeDirectory(runtime, target);
    return from ? [{ from, to: runtime, filter: ['**/*', '!**/*.pdb', '!**/*.lib', '!**/*.zip', '!windows-x64/**', '!mac-universal/**'] }] : [];
  });
}

module.exports = { runtimeDirectory, runtimeResources };
