#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { layouts, zipTree, inspectTemplate, sha256 } = require('./template-archive');
const root = path.resolve(__dirname, '..');

async function main() {
  const target = process.argv[2];
  const layout = layouts[target];
  if (!layout) throw new Error('Usage: node scripts/package-viewer-template.js windows-x64|mac-universal');
  if (target === 'mac-universal' && process.platform !== 'darwin') throw new Error('Build and validate the signed universal template on macOS.');
  const source = path.join(root, 'dist/viewer', layout.folder);
  if (target === 'mac-universal') {
    for (const [command, args] of [
      ['/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', source]],
      ['/usr/bin/lipo', [path.join(source, 'Contents/MacOS/LaunchBox Viewer'), '-verify_arch', 'x86_64', 'arm64']]
    ]) {
      const result = spawnSync(command, args, { stdio: 'inherit' });
      if (result.error || result.status !== 0) throw new Error('Mac template verification failed: ' + command);
    }
  }
  const output = path.join(root, 'dist/export-templates');
  fs.mkdirSync(output, { recursive: true });
  const archive = path.join(output, target + '.zip');
  const temporary = archive + '.tmp';
  try {
    await zipTree(source, temporary, { includeRoot: target === 'mac-universal' });
    const inspection = await inspectTemplate(temporary, target);
    fs.renameSync(temporary, archive);
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    const manifest = { formatVersion: 1, target, appVersion: require('../package.json').version, sourceCommit: commit.status === 0 ? commit.stdout.trim() : null, sha256: await sha256(archive), ...inspection };
    fs.writeFileSync(path.join(output, target + '.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log('Template created: ' + archive);
    console.log(JSON.stringify(manifest));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
