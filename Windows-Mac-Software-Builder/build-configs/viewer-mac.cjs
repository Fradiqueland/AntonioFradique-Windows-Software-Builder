'use strict';
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
const base = require('./viewer-template.json');
const { runtimeResources } = require('./runtime-resources.cjs');
module.exports = {
  ...base,
  // These two files are already universal and validated before packaging.
  mac: { ...base.mac, x64ArchFiles: 'Contents/Resources/ffmpeg/{ffmpeg,ffprobe}' },
  extraResources: [...base.extraResources, ...runtimeResources('mac-universal')]
};
