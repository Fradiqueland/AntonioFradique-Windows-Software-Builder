#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { checkFFmpeg } = require('./check-ffmpeg');

// Keep this list equal to package-ffmpeg-runtime.js and the workflow hashFiles.
const recipeFiles = Object.freeze([
  'scripts/build-ffmpeg.sh',
  'scripts/prepare-ffmpeg-sources.js',
  'scripts/package-ffmpeg-runtime.js',
  'scripts/check-ffmpeg.js',
  'build-configs/ffmpeg-sources.json',
  'build-configs/runtime-resources.cjs'
]);
const root = path.resolve(__dirname, '..');
const nativeTargets = new Set(['windows-x64', 'mac-x64', 'mac-arm64']);

function runTar(args, cwd) {
  const result = spawnSync('tar', args, {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 120000,
    maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' }
  });
  if (result.error || result.status !== 0) throw new Error('Native FFmpeg cache: tar failed: ' + String(result.stderr || result.error?.message || result.status).trim());
  return String(result.stdout || '');
}

function safeArchive(directory) {
  // Both GNU tar (MSYS2) and bsdtar (Windows/macOS runners) expose physical
  // entry types in verbose listings. Reject links before anything is extracted.
  // Relative -f paths also work with GNU tar on Windows, where C: otherwise
  // looks like a remote host name. This mirrors install-ffmpeg-runtime.js.
  const names = runTar(['-tzf', 'runtime.tar.gz'], directory).split(/\r?\n/).filter(Boolean);
  const descriptions = runTar(['-tvzf', 'runtime.tar.gz'], directory).split(/\r?\n/).filter(Boolean);
  if (!names.length || names.length > 512 || descriptions.length !== names.length || descriptions.some(line => !/^[-d]/.test(line) || /\s(?:link to|->)\s/.test(line))) {
    throw new Error('Native FFmpeg cache: archive must contain only physical files and directories.');
  }
  const seen = new Set();
  for (const name of names) {
    const normalized = name.replace(/^\.\//, '').replace(/\/$/, '');
    if (!normalized) { if (name === './') continue; throw new Error('Native FFmpeg cache: unsafe archive root.'); }
    const parts = normalized.split('/');
    if (parts.some(part => !/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || seen.has(normalized.toLowerCase())) {
      throw new Error('Native FFmpeg cache: unsafe or duplicate archive path: ' + name);
    }
    seen.add(normalized.toLowerCase());
  }
}

function physicalFile(base, relative) {
  let current = base;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error('Native FFmpeg cache: recipe must be a physical file: ' + relative);
    }
  }
  return current;
}

function verifyNativeCache(target, archive, { projectRoot = root, checker = checkFFmpeg } = {}) {
  if (!nativeTargets.has(target)) throw new Error('Native FFmpeg cache: unsupported native target: ' + target);
  const stat = fs.lstatSync(archive);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 512 * 1024 * 1024) throw new Error('Native FFmpeg cache: invalid physical archive.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-native-cache-'));
  try {
    // List and extract the same private snapshot, never a changing cache path.
    const snapshot = path.join(temporary, 'runtime.tar.gz');
    fs.copyFileSync(archive, snapshot);
    safeArchive(temporary);
    const directory = path.join(temporary, 'runtime');
    fs.mkdirSync(directory);
    runTar(['--no-same-owner', '-xzf', 'runtime.tar.gz', '-C', 'runtime'], temporary);
    const changedInputs = [];
    for (const file of recipeFiles) {
      const current = fs.readFileSync(physicalFile(projectRoot, file));
      const cached = fs.readFileSync(physicalFile(directory, 'sources/recipe/' + file));
      if (!current.equals(cached)) changedInputs.push(file);
    }
    // A different complete recipe is a cache miss. Missing files, unsafe tar,
    // altered sources/binaries or a failed CPU test are corruption and throw.
    if (changedInputs.length) return { reusable: false, changedInputs };
    checker(directory, { target, smoke: true, verifyBinaryHashes: true });
    return { reusable: true, changedInputs: [] };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const [target, suppliedArchive, flag] = process.argv.slice(2);
    if (flag && flag !== '--require-current-recipe') throw new Error('Unknown native cache option: ' + flag);
    const archive = suppliedArchive ? path.resolve(suppliedArchive) : path.join(root, 'dist/runtime-native', target + '.tar.gz');
    const result = verifyNativeCache(target, archive);
    if (flag && !result.reusable) throw new Error('New native runtime recipe differs from checkout: ' + result.changedInputs.join(', '));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'reusable=' + result.reusable + '\n');
    console.log(result.reusable
      ? 'Native FFmpeg cache verified: exact recipe, source and binary SHA-256, GPL licenses, architecture and native CPU H.264/AAC test.'
      : 'Native FFmpeg recipe changed; compile from verified sources: ' + result.changedInputs.join(', '));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { recipeFiles, verifyNativeCache };
