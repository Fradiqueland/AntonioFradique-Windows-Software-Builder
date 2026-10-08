'use strict';
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
const base = require('./viewer-template.json');
const { runtimeResources } = require('./runtime-resources.cjs');
const { viewerFiles } = require('./viewer-files.cjs');
module.exports = {
  ...base,
  compression: 'maximum',
  files: viewerFiles(base.files),
  // Optional runtimes live in a sibling .data folder. Removing an unused
  // runtime during export must never alter the signed universal app bundle.
  extraResources: [...base.extraResources, ...runtimeResources('mac-universal', { exclude: ['php', 'ffmpeg'] })]
};
