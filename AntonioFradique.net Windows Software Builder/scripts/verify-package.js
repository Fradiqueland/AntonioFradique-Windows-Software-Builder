#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const { checkTemplates } = require('./check-viewer-template');

async function main() {
  const root = path.resolve(__dirname, '..');
  const pkg = require('../package.json');
  const mac = process.platform === 'darwin';
  if (!mac && process.platform !== 'win32') throw new Error('Verify packages on their native Windows or Mac runner.');
  const app = mac ? path.join(root, 'dist/builder/mac-universal', pkg.build.productName + '.app') : path.join(root, 'dist/builder/win-unpacked');
  const resources = path.join(app, mac ? 'Contents/Resources' : 'resources');
  const bundledPackage = mac
    ? JSON.parse(asar.extractFile(path.join(resources, 'app.asar'), 'package.json').toString())
    : JSON.parse(fs.readFileSync(path.join(resources, 'app', 'package.json'), 'utf8'));
  if (bundledPackage.version !== '2.0.0') throw new Error('Wrong packaged version: ' + bundledPackage.version);
  if (JSON.parse(fs.readFileSync(path.join(resources, 'app-mode.json'), 'utf8')).mode !== 'builder') throw new Error('The installer must launch in builder mode.');
  await checkTemplates(path.join(resources, 'export-templates'));
  if (mac) {
    for (const [command, args] of [
      ['/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]],
      ['/usr/bin/lipo', [path.join(app, 'Contents/MacOS', pkg.build.productName), '-verify_arch', 'x86_64', 'arm64']]
    ]) {
      const result = spawnSync(command, args, { stdio: 'inherit' });
      if (result.error || result.status !== 0) throw new Error('Packaged Mac verification failed: ' + command);
    }
  } else {
    for (const name of ['7za.exe', '7zsd_All_x64.sfx']) fs.accessSync(path.join(resources, 'sfx', name));
  }
  console.log('Packaged Builder v2 includes both verified export templates.');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
