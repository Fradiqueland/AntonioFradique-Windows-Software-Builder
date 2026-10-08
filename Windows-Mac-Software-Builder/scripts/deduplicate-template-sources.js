#!/usr/bin/env node
'use strict';

// Only identical pinned GPL archive copies are deduplicated. The Builder keeps
// one complete physical source copy and restores it in every IPTV export.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const yazl = require('yazl');
const { inspectTemplate, sha256 } = require('./template-archive');
const { markerPath, sourceMarker, verifySharedSources, FFMPEG_SOURCE_LOCK } = require('./template-sources');
const { runtimeDirectory } = require('../build-configs/runtime-resources.cjs');
const root = path.resolve(__dirname, '..');
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});

async function openEntries(file) {
  const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, result) => error ? reject(error) : resolve(result)));
  const entries = [];
  let failure;
  zip.on('error', error => { failure = error; });
  try {
    await new Promise((resolve, reject) => {
      const names = new Set();
      zip.once('error', reject);
      zip.once('end', resolve);
      zip.on('entry', entry => {
        const key = entry.fileName.normalize('NFD').toLowerCase();
        if (entries.length >= 30000 || names.has(key) || entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) return reject(new Error('Invalid duplicate, encrypted or oversized template entries.'));
        names.add(key); entries.push(entry); zip.readEntry();
      });
      zip.readEntry();
    });
    return { zip, entries, checkError() { if (failure) throw failure; } };
  } catch (error) { zip.close(); throw error; }
}

function entryStream(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, input) => {
    if (error) return reject(error);
    let bytes = 0;
    let crc = 0xffffffff;
    const verified = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > entry.uncompressedSize) return callback(new Error('Template entry exceeds its declared size.'));
        for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ crc >>> 8;
        callback(null, chunk);
      },
      flush(callback) { callback(bytes !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32 ? new Error('Template entry has invalid size or CRC: ' + entry.fileName) : undefined); }
    });
    input.on('error', error => verified.destroy(error));
    verified.on('close', () => input.destroy());
    resolve(input.pipe(verified));
  }));
}

async function deduplicateTemplate({ directory, target, sharedRuntimeSourcesDir }) {
  await verifySharedSources(sharedRuntimeSourcesDir);
  const archivePath = path.join(directory, target + '.zip');
  const manifestPath = path.join(directory, target + '.manifest.json');
  const previousManifest = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(previousManifest);
  if (manifest.formatVersion !== 1 || manifest.target !== target || manifest.appVersion !== require('../package.json').version || manifest.sha256 !== await sha256(archivePath)) throw new Error('Invalid template manifest before source deduplication: ' + target);
  const before = await inspectTemplate(archivePath, target);
  if (target === 'mac-universal' && before.runtimeLayout !== 'external-data-v1') throw new Error('Do not remove sources from a signed Mac application bundle.');
  if (before.sourceLayout === 'shared-in-builder-v1') return { target, unchanged: true, archiveBytes: fs.statSync(archivePath).size };
  const template = await openEntries(archivePath);
  const marker = markerPath(target);
  const removed = new Set(FFMPEG_SOURCE_LOCK.map(entry => marker.replace(/template-sources\.json$/, 'sources/' + entry.file)));
  const temporary = archivePath + '.' + crypto.randomUUID() + '.tmp';
  const temporaryManifest = temporary + '.manifest';
  const backup = temporary + '.original';
  const activeStreams = new Set();
  let archive;
  let completion;
  try {
    for (const expected of FFMPEG_SOURCE_LOCK) {
      const name = marker.replace(/template-sources\.json$/, 'sources/' + expected.file);
      const entry = template.entries.find(item => item.fileName === name);
      const mode = entry && entry.externalFileAttributes >>> 16;
      if (!entry || entry.uncompressedSize !== expected.size || entry.fileName.endsWith('/') || (mode & 0o170000) === 0o120000) throw new Error('Full template lacks its exact pinned source archive: ' + expected.file);
      const hash = crypto.createHash('sha256');
      for await (const chunk of await entryStream(template.zip, entry)) hash.update(chunk);
      if (hash.digest('hex') !== expected.sha256) throw new Error('Template source archive differs from the shared physical source: ' + expected.file);
    }
    archive = new yazl.ZipFile();
    completion = pipeline(archive.outputStream, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    completion.catch(() => {});
    archive.on('error', error => archive.outputStream.destroy(error));
    for (const entry of template.entries) {
      if (removed.has(entry.fileName)) continue;
      const mode = entry.externalFileAttributes >>> 16;
      const options = { mode, mtime: entry.getLastModDate() };
      if (entry.fileName.endsWith('/')) archive.addEmptyDirectory(entry.fileName, options);
      else archive.addReadStreamLazy(entry.fileName, { ...options, size: entry.uncompressedSize, compressionLevel: (mode & 0o170000) === 0o120000 ? 0 : 9 }, callback => {
        entryStream(template.zip, entry).then(stream => {
          activeStreams.add(stream);
          stream.once('close', () => activeStreams.delete(stream));
          stream.once('error', error => archive.outputStream.destroy(error));
          callback(null, stream);
        }, callback);
      });
    }
    archive.addBuffer(Buffer.from(JSON.stringify(sourceMarker(), null, 2) + '\n'), marker, { mode: 0o100644, compressionLevel: 9 });
    archive.end();
    await completion;
    template.checkError();
    const inspection = await inspectTemplate(temporary, target);
    if (inspection.sourceLayout !== 'shared-in-builder-v1') throw new Error('Deduplicated template lost its source restoration marker.');
    await verifySharedSources(sharedRuntimeSourcesDir);
    const nextManifest = { ...manifest, ...inspection, sha256: await sha256(temporary) };
    fs.writeFileSync(temporaryManifest, JSON.stringify(nextManifest, null, 2) + '\n', { flag: 'wx' });
    fs.chmodSync(temporary, fs.statSync(archivePath).mode & 0o777);
    fs.chmodSync(temporaryManifest, fs.statSync(manifestPath).mode & 0o777);
    const previousBytes = fs.statSync(archivePath).size;
    // Closing the reader is essential before renaming the archive on Windows.
    await new Promise(resolve => { template.zip.once('close', resolve); template.zip.close(); });
    fs.renameSync(archivePath, backup);
    try {
      fs.renameSync(temporary, archivePath);
      fs.renameSync(temporaryManifest, manifestPath);
    } catch (error) {
      fs.renameSync(backup, archivePath);
      fs.writeFileSync(manifestPath, previousManifest);
      throw error;
    }
    // The transaction has committed. A backup-cleanup failure must not report
    // a failed transformation after publishing a valid archive and manifest.
    try { fs.rmSync(backup, { force: true }); } catch (_) { /* harmless retained original */ }
    return { target, removedSourceBytes: FFMPEG_SOURCE_LOCK.reduce((sum, entry) => sum + entry.size, 0), previousArchiveBytes: previousBytes, archiveBytes: fs.statSync(archivePath).size };
  } catch (error) {
    if (archive) archive.outputStream.destroy(error);
    if (completion) await completion.catch(() => {});
    throw error;
  } finally {
    for (const stream of activeStreams) stream.destroy();
    template.zip.close();
    fs.rmSync(temporary, { force: true });
    fs.rmSync(temporaryManifest, { force: true });
  }
}

async function deduplicateTemplates({ directory = path.join(root, 'dist/export-templates'), sharedRuntimeSourcesDir } = {}) {
  if (!sharedRuntimeSourcesDir) {
    const target = process.platform === 'darwin' ? 'mac-universal' : 'windows-x64';
    const runtime = runtimeDirectory('ffmpeg', target);
    if (!runtime) throw new Error('Prepare the native Builder FFmpeg runtime before deduplicating template sources.');
    sharedRuntimeSourcesDir = path.join(root, runtime, 'sources');
  }
  await verifySharedSources(sharedRuntimeSourcesDir);
  const results = [];
  for (const target of ['windows-x64', 'mac-universal']) results.push(await deduplicateTemplate({ directory, target, sharedRuntimeSourcesDir }));
  return results;
}

if (require.main === module) deduplicateTemplates().then(results => console.log(JSON.stringify(results, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { deduplicateTemplate, deduplicateTemplates };
