'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { FFMPEG_SOURCE_LOCK } = require('../src/shared/ffmpeg-source-lock');

function markerPath(target) {
  if (!['windows-x64', 'mac-universal'].includes(target)) throw new Error('Unsupported template source target: ' + target);
  return (target === 'windows-x64' ? 'resources' : 'LaunchBox Viewer.data') + '/ffmpeg/template-sources.json';
}

function validateSourceMarker(marker) {
  if (!marker || Array.isArray(marker) || Object.keys(marker).sort().join(',') !== 'schemaVersion,sources' || marker.schemaVersion !== 1 || !Array.isArray(marker.sources) || marker.sources.length !== FFMPEG_SOURCE_LOCK.length) throw new Error('Invalid shared FFmpeg source marker.');
  for (let i = 0; i < FFMPEG_SOURCE_LOCK.length; i++) {
    const entry = marker.sources[i];
    const expected = FFMPEG_SOURCE_LOCK[i];
    if (!entry || Array.isArray(entry) || Object.keys(entry).sort().join(',') !== 'file,sha256,size' || ['file', 'sha256', 'size'].some(key => entry[key] !== expected[key])) throw new Error('Shared FFmpeg source marker differs from the pinned source lock.');
  }
  return marker;
}

function sourceMarker() { return { schemaVersion: 1, sources: FFMPEG_SOURCE_LOCK.map(entry => ({ ...entry })) }; }

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifySharedSources(directory) {
  if (!directory || !path.isAbsolute(directory)) throw new Error('Shared FFmpeg sources require an absolute physical directory.');
  const root = fs.lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Shared FFmpeg source directory must be physical.');
  for (const entry of FFMPEG_SOURCE_LOCK) {
    const file = path.join(directory, entry.file);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size || await hashFile(file) !== entry.sha256) throw new Error('Shared FFmpeg source archive is missing or corrupted: ' + entry.file);
  }
  return sourceMarker();
}

module.exports = { markerPath, validateSourceMarker, sourceMarker, verifySharedSources, FFMPEG_SOURCE_LOCK };
