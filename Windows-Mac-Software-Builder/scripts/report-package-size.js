#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const previous = {
  'windows-x64.zip': { bytes: 183790075, label: 'v2.1.1 export template' },
  'mac-universal.zip': { bytes: 261857055, label: 'v2.1.1 export template' },
  windowsInstallerArtifact: { bytes: 578141345, label: 'v2.1.1 GitHub installer artifact ZIP' },
  macInstallerArtifact: { bytes: 701994078, label: 'v2.1.1 GitHub installer artifact ZIP' }
};

function directoryBytes(directory) {
  let bytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += directoryBytes(name);
    else if (entry.isFile()) bytes += fs.statSync(name).size;
  }
  return bytes;
}

function report(directory = path.join(root, 'dist')) {
  const items = [];
  function add(file, baseline) {
    if (!fs.existsSync(file)) return;
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return;
    const bytes = stat.isDirectory() ? directoryBytes(file) : stat.size;
    const item = { path: path.relative(root, file).split(path.sep).join('/'), bytes, MiB: Number((bytes / 1048576).toFixed(2)) };
    if (baseline) Object.assign(item, { baselineBytes: baseline.bytes, baselineLabel: baseline.label, reductionPercent: Number((100 * (baseline.bytes - bytes) / baseline.bytes).toFixed(2)) });
    items.push(item);
  }
  for (const name of ['windows-x64.zip', 'mac-universal.zip']) add(path.join(directory, 'export-templates', name), previous[name]);
  const installers = path.join(directory, 'builder');
  if (fs.existsSync(installers)) for (const name of fs.readdirSync(installers).sort()) if (/\.(?:exe|dmg)$/.test(name)) add(path.join(installers, name));
  const productName = require('../package.json').build.productName;
  for (const [kind, name] of [['builder', productName], ['viewer', 'LaunchBox Viewer']]) {
    const candidates = [path.join(directory, kind, 'win-unpacked'), path.join(directory, kind, 'mac-universal', name + '.app')];
    for (const app of candidates) add(app);
    if (kind === 'viewer') add(path.join(directory, kind, 'mac-universal', name + '.data'));
  }
  return { version: require('../package.json').version, measuredAt: new Date().toISOString(), items,
    installerArtifactBaselines: [previous.windowsInstallerArtifact, previous.macInstallerArtifact],
    note: 'Installer files and GitHub artifact ZIPs are different measurements. Archive compression is lossless; application content is not re-encoded.' };
}

if (require.main === module) {
  try {
    const result = report(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
    const destination = path.join(root, 'dist/package-size-report.json');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { report, directoryBytes };
