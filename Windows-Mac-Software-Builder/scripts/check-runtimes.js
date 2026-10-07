#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runtimeDirectory } = require('../build-configs/runtime-resources.cjs');
const { checkFFmpeg } = require('./check-ffmpeg');
const root = path.resolve(__dirname, '..');
const target = process.argv[2] || (process.platform === 'darwin' ? 'mac-universal' : 'windows-x64');
for (const name of ['php', 'ffmpeg']) {
  const directory = runtimeDirectory(name, target);
  if (!directory) {
    if (name === 'ffmpeg') throw new Error('Required FFmpeg runtime absent for ' + target + '. Run the pinned source build or install its CI artifact.');
    console.warn('Optional ' + name + ' runtime absent for ' + target + '; the corresponding feature will be unavailable.');
    continue;
  }
  const executable = path.join(root, directory, name + (target === 'windows-x64' ? '.exe' : ''));
  if (name === 'ffmpeg') {
    checkFFmpeg(path.join(root, directory), { target, smoke: true, verifyBinaryHashes: true });
    continue;
  }
  if (target === 'mac-universal') {
    if (process.platform !== 'darwin') throw new Error('Validate native Mac runtimes on macOS.');
    fs.accessSync(executable, fs.constants.X_OK);
    const result = spawnSync('/usr/bin/lipo', [executable, '-verify_arch', 'x86_64', 'arm64'], { encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(name + ' must include both Intel and Apple Silicon slices: ' + (result.stderr || result.error));
  }
  console.log('Optional ' + name + ' included from ' + directory);
}
