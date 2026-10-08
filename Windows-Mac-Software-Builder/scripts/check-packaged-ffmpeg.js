#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { checkFFmpeg } = require('./check-ffmpeg');
const root = path.resolve(__dirname, '..');
const kind = process.argv[2];
try {
  if (!['viewer', 'builder'].includes(kind)) throw new Error('Choose viewer or builder.');
  if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Check packaged runtimes on their native platform.');
  const mac = process.platform === 'darwin';
  const appName = kind === 'viewer' ? 'LaunchBox Viewer' : require('../package.json').build.productName;
  const resources = mac
    ? path.join(root, 'dist', kind, 'mac-universal', kind === 'viewer' ? appName + '.data' : appName + '.app/Contents/Resources')
    : path.join(root, 'dist', kind, 'win-unpacked/resources');
  // Ad-hoc signing legitimately changes Mach-O bytes after the native manifest
  // was created. The signed app itself is verified separately by packaging.
  checkFFmpeg(path.join(resources, 'ffmpeg'), { target: mac ? 'mac-universal' : 'windows-x64', smoke: true, verifyBinaryHashes: !mac });
  console.log('Packaged ' + kind + ' includes executable FFmpeg, ffprobe and corresponding sources.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
