#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { layouts, zipTree, inspectTemplate, sha256 } = require('./template-archive');
const { runtimeResources } = require('../build-configs/runtime-resources.cjs');
const asar = require('@electron/asar');
const { builderOnlyDependencies } = require('../build-configs/viewer-files.cjs');
const root = path.resolve(__dirname, '..');

function normalizeAsarEntry(name) {
  // ASAR's listPackage uses the host path.join, including backslashes on Windows.
  return name.replace(/\\/g, '/').replace(/^\/+/, '');
}

function validateViewerDependencies(asarFile) {
  const appEntries = new Set(asar.listPackage(asarFile).map(normalizeAsarEntry));
  for (const name of ['yauzl', 'yazl']) if (!appEntries.has('node_modules/' + name + '/package.json')) throw new Error('Viewer lost required ZIP dependency: ' + name);
  for (const name of builderOnlyDependencies) if (appEntries.has('node_modules/' + name + '/package.json')) throw new Error('Viewer still contains a Builder-only dependency: ' + name);
}

async function main() {
  const target = process.argv[2];
  const layout = layouts[target];
  if (!layout) throw new Error('Usage: node scripts/package-viewer-template.js windows-x64|mac-universal');
  if (target === 'mac-universal' && process.platform !== 'darwin') throw new Error('Build and validate the signed universal template on macOS.');
  const source = path.join(root, 'dist/viewer', layout.folder);
  const appResources = path.join(source, target === 'mac-universal' ? 'Contents/Resources' : 'resources');
  const asarFile = path.join(appResources, 'app.asar');
  validateViewerDependencies(asarFile);
  const packagedVersion = JSON.parse(asar.extractFile(asarFile, 'package.json').toString()).version;
  if (packagedVersion !== require('../package.json').version) throw new Error('Viewer package version mismatch: ' + packagedVersion);
  const companions = [];
  if (target === 'mac-universal') {
    for (const [command, args] of [
      ['/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', source]],
      ['/usr/bin/lipo', [path.join(source, 'Contents/MacOS/LaunchBox Viewer'), '-verify_arch', 'x86_64', 'arm64']]
    ]) {
      const result = spawnSync(command, args, { stdio: 'inherit' });
      if (result.error || result.status !== 0) throw new Error('Mac template verification failed: ' + command);
    }
    const companion = path.join(path.dirname(source), layout.companion);
    fs.rmSync(companion, { recursive: true, force: true });
    fs.mkdirSync(companion, { recursive: true });
    for (const resource of runtimeResources(target)) {
      const destination = path.join(companion, resource.to);
      fs.cpSync(path.join(root, resource.from), destination, {
        recursive: true, preserveTimestamps: true,
        filter: file => !/\.(?:pdb|lib|zip)$/i.test(path.basename(file))
      });
      // A runtime outside the sealed application bundle needs its own ad-hoc
      // signature. No certificate is required and source/licenses are intact.
      const executableNames = resource.to === 'ffmpeg' ? ['ffmpeg', 'ffprobe'] : ['php'];
      for (const name of executableNames) {
        const executable = path.join(destination, name);
        fs.chmodSync(executable, 0o755);
        const architecture = spawnSync('/usr/bin/lipo', [executable, '-verify_arch', 'x86_64', 'arm64'], { stdio: 'inherit' });
        if (architecture.error || architecture.status !== 0) throw new Error('Mac companion runtime must include Intel and Apple Silicon: ' + name);
        for (const args of [['--force', '--sign', '-', '--timestamp=none', executable], ['--verify', '--strict', '--verbose=2', executable]]) {
          const result = spawnSync('/usr/bin/codesign', args, { stdio: 'inherit' });
          if (result.error || result.status !== 0) throw new Error('Mac companion runtime signing failed: ' + name);
        }
      }
    }
    companions.push(companion);
  }
  const output = path.join(root, 'dist/export-templates');
  fs.mkdirSync(output, { recursive: true });
  const archive = path.join(output, target + '.zip');
  const temporary = archive + '.tmp';
  try {
    await zipTree(source, temporary, { includeRoot: target === 'mac-universal', companions });
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
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { normalizeAsarEntry, validateViewerDependencies };
