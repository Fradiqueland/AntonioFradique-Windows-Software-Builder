#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkFFmpeg } = require('./check-ffmpeg');
const { hashFile } = require('./prepare-ffmpeg-sources');
const root = path.resolve(__dirname, '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(command + ' failed: ' + (result.error || result.status));
}
function install(target, archiveDir = path.join(root, 'dist/runtime-native')) {
  if (!['windows-x64', 'mac-universal'].includes(target)) throw new Error('Unsupported runtime target: ' + target);
  if (target === 'mac-universal' && process.platform !== 'darwin') throw new Error('Assemble the universal FFmpeg runtime on macOS.');
  const nativeTargets = target === 'windows-x64' ? [target] : ['mac-x64', 'mac-arm64'];
  const stage = fs.mkdtempSync(path.join(root, 'vendor/ffmpeg/.install-'));
  try {
    const manifests = [];
    for (const native of nativeTargets) {
      const directory = path.join(stage, native);
      fs.mkdirSync(directory);
      run('tar', ['--no-same-owner', '-xzf', native + '.tar.gz', '-C', path.relative(archiveDir, directory).split(path.sep).join('/')], { cwd: archiveDir });
      checkFFmpeg(directory, { target: native, smoke: false, verifyBinaryHashes: true });
      manifests.push(JSON.parse(fs.readFileSync(path.join(directory, 'runtime-manifest.json'), 'utf8')));
    }
    const ready = path.join(stage, 'ready');
    fs.cpSync(path.join(stage, nativeTargets[0]), ready, { recursive: true, preserveTimestamps: true });
    if (target === 'mac-universal') {
      if (JSON.stringify(manifests[0].sources) !== JSON.stringify(manifests[1].sources)) throw new Error('Mac runtime source versions differ.');
      const manifest = { ...manifests[0], target, build: { nativeBuilds: manifests.map((item) => ({ target: item.target, ...item.build })), universalRecipe: 'sources/recipe/scripts/install-ffmpeg-runtime.js' } };
      for (const name of ['ffmpeg', 'ffprobe']) {
        run('/usr/bin/lipo', ['-create', path.join(stage, 'mac-x64', name), path.join(stage, 'mac-arm64', name), '-output', path.join(ready, name)]);
        fs.chmodSync(path.join(ready, name), 0o755);
        manifest.binaries[name] = { file: name, sha256: hashFile(path.join(ready, name)) };
      }
      fs.cpSync(path.join(stage, 'mac-arm64/build-info'), path.join(ready, 'build-info/mac-arm64'), { recursive: true });
      fs.writeFileSync(path.join(ready, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      fs.appendFileSync(path.join(ready, 'README-SOURCES.txt'), '\nUniversal macOS binaries combine independently built and tested mac-x64 and mac-arm64 slices.\nBuild each native runtime using the included recipe, then run install-ffmpeg-runtime.js mac-universal on macOS with both native tar.gz archives in dist/runtime-native/.\n');
    }
    fs.copyFileSync(__filename, path.join(ready, 'sources/recipe/scripts/install-ffmpeg-runtime.js'));
    checkFFmpeg(ready, { target, smoke: true, verifyBinaryHashes: true });
    const output = path.join(root, 'vendor/ffmpeg', target);
    fs.rmSync(output, { recursive: true, force: true });
    fs.renameSync(ready, output);
    console.log('Installed verified FFmpeg runtime: ' + output);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
if (require.main === module) {
  try {
    fs.mkdirSync(path.join(root, 'vendor/ffmpeg'), { recursive: true });
    install(process.argv[2], process.argv[3] ? path.resolve(process.argv[3]) : undefined);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { install };
