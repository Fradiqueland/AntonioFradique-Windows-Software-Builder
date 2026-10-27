'use strict';

// The Viewer reads projects; icon conversion and PE editing are Builder tasks.
// Remove only the exclusive dependency graph of those two tools. ZIP reading
// and writing and their dependencies remain available to shared source files.
const builderOnlyDependencies = [
  'resedit', 'pe-library', 'png-to-ico', 'pngjs', 'minimist', 'rcedit', 'cross-spawn-windows-exe',
  'cross-spawn', 'is-wsl', 'is-docker', 'path-key', 'shebang-command',
  'shebang-regex', 'which', 'isexe'
];
const windowsIconDependencies = builderOnlyDependencies.filter(name => !['resedit', 'pe-library', 'png-to-ico', 'pngjs', 'minimist'].includes(name));

function builderFiles(files, target) {
  const excludes = ['!node_modules/@types/**', '!node_modules/png-to-ico/node_modules/@types/**'];
  if (target === 'mac-universal') excludes.push(...windowsIconDependencies.map(name => '!node_modules/' + name + '/**'));
  return [...files, ...excludes];
}

function viewerFiles(files) {
  return [...files, ...builderOnlyDependencies.map(name => '!node_modules/' + name + '/**')];
}

module.exports = { viewerFiles, builderFiles, builderOnlyDependencies, windowsIconDependencies };
