'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// PHP is optional; FFmpeg is required in release packages. A Windows executable
// must never accidentally become the runtime of a Mac application.
function runtimeDirectory(runtime, target) {
  if (!['windows-x64', 'mac-universal'].includes(target)) throw new Error('Unsupported target: ' + target);
  const executable = runtime + (target === 'windows-x64' ? '.exe' : '');
  const candidates = [path.join('vendor', runtime, target)];
  if (target === 'windows-x64' && runtime === 'php') candidates.push(path.join('vendor', runtime));
  return candidates.find((relative) => fs.existsSync(path.join(root, relative, executable))) || null;
}

function runtimeResources(target) {
  return ['php', 'ffmpeg'].flatMap((runtime) => {
    const from = runtimeDirectory(runtime, target);
    if (!from && runtime === 'ffmpeg') throw new Error('Required FFmpeg runtime absent for ' + target + '. Build/install the pinned runtime before packaging.');
    return from ? [{ from, to: runtime, filter: ['**/*', '!**/*.pdb', '!**/*.lib', '!**/*.zip', '!windows-x64/**', '!mac-universal/**'] }] : [];
  });
}

module.exports = { runtimeDirectory, runtimeResources };
