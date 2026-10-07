#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lock = require('../build-configs/ffmpeg-sources.json');
const { hashFile } = require('./prepare-ffmpeg-sources');
const root = path.resolve(__dirname, '..');

function packageRuntime(target) {
  if (!['windows-x64', 'mac-x64', 'mac-arm64'].includes(target)) throw new Error('Unsupported native target: ' + target);
  const base = path.join(root, 'dist/ffmpeg-build', target);
  const destination = path.join(root, 'vendor/ffmpeg', target);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  const copy = (source, relative) => {
    const output = path.join(destination, relative);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(source, output);
  };
  const binaries = {};
  for (const name of ['ffmpeg', 'ffprobe']) {
    const file = name + (target === 'windows-x64' ? '.exe' : '');
    copy(path.join(base, 'prefix/bin', file), file);
    fs.chmodSync(path.join(destination, file), 0o755);
    binaries[name] = { file, sha256: hashFile(path.join(destination, file)) };
  }
  for (const source of lock.sources) {
    copy(path.join(root, 'dist/ffmpeg-sources', source.file), 'sources/' + source.file);
    const sourceDir = path.join(base, source.directory);
    if (source.name === 'ffmpeg') {
      for (const license of ['COPYING.GPLv2', 'COPYING.GPLv3', 'COPYING.LGPLv2.1', 'COPYING.LGPLv3', 'LICENSE.md']) copy(path.join(sourceDir, license), 'licenses/ffmpeg/' + license);
      for (const config of ['config.h', 'ffbuild/config.mak', 'ffbuild/config.log']) copy(path.join(sourceDir, config), 'build-info/ffmpeg/' + path.basename(config));
    } else {
      copy(path.join(sourceDir, 'COPYING'), 'licenses/x264/COPYING');
      for (const config of ['config.h', 'config.mak']) copy(path.join(sourceDir, config), 'build-info/x264/' + config);
    }
  }
  for (const file of ['scripts/build-ffmpeg.sh', 'scripts/prepare-ffmpeg-sources.js', 'scripts/package-ffmpeg-runtime.js', 'scripts/check-ffmpeg.js', 'build-configs/ffmpeg-sources.json', 'build-configs/runtime-resources.cjs']) copy(path.join(root, file), 'sources/recipe/' + file);
  const version = spawnSync(path.join(destination, binaries.ffmpeg.file), ['-version'], { encoding: 'utf8' });
  if (version.error || version.status !== 0) throw new Error('Built FFmpeg cannot run: ' + (version.stderr || version.error));
  const compiler = spawnSync(process.platform === 'win32' ? 'gcc' : 'clang', ['--version'], { encoding: 'utf8' });
  const manifest = {
    schemaVersion: 1, target, license: lock.license, sources: lock.sources, binaries,
    build: { platform: process.platform, arch: process.arch, compiler: compiler.stdout || '', ffmpeg: version.stdout, recipe: 'sources/recipe/scripts/build-ffmpeg.sh' }
  };
  fs.writeFileSync(path.join(destination, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(destination, 'README-SOURCES.txt'), [
    'FFmpeg and x264: GPL-2.0-or-later. These are separate command-line executables.',
    'The exact unmodified corresponding source archives accompany these binaries in sources/.',
    'Licenses are in licenses/. Source URLs, immutable versions and SHA-256 checksums are in runtime-manifest.json.',
    'Build configuration and compiler information are in build-info/ and runtime-manifest.json.',
    'To rebuild, copy sources/recipe/ to an empty writable project directory.',
    'Install Node.js22+, curl, Git, tar, bzip2, make, pkg-config and NASM; use Apple clang on macOS, or MSYS2 MINGW64 gcc on Windows.',
    'Run bash scripts/build-ffmpeg.sh ' + target + ' on the corresponding native architecture.',
    'The recipe downloads only the pinned source archives and validates their SHA-256 before extraction.',
    'If the x264 archive endpoint is unavailable, official Git at the exact pinned commit recreates the same archive bytes; its SHA-256 must still match.',
    'The shipped archives may instead be placed in dist/ffmpeg-sources/ for an offline source build.',
    'No changes were made to upstream FFmpeg or x264 source code.', ''
  ].join('\n'));
  return manifest;
}
if (require.main === module) {
  try { packageRuntime(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { packageRuntime };
