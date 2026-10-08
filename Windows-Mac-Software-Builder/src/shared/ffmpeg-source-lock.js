'use strict';

// Identical corresponding-source archives accompany every pinned FFmpeg/x264
// runtime. Builder templates may reference this common copy, but exported apps
// always regain the full archives with these exact bytes.
const FFMPEG_SOURCE_LOCK = Object.freeze([
  Object.freeze({
    file: 'ffmpeg-8.1.3.tar.xz',
    sha256: '7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3',
    size: 11732036
  }),
  Object.freeze({
    file: 'x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.bz2',
    sha256: '6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224',
    size: 848719
  })
]);

module.exports = { FFMPEG_SOURCE_LOCK };
