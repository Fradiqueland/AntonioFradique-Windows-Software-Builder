'use strict';
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
const base = require('../package.json').build;
const { runtimeResources } = require('./runtime-resources.cjs');
const { builderFiles } = require('./viewer-files.cjs');
module.exports = {
  ...base,
  compression: 'maximum',
  files: builderFiles(base.files, 'mac-universal'),
  // @electron/universal 2 requires this explicit exception for identical
  // binaries that were already merged and checked with lipo before packaging.
  mac: { ...base.mac, x64ArchFiles: 'Contents/Resources/ffmpeg/{ffmpeg,ffprobe}' },
  extraResources: [...base.extraResources, ...runtimeResources('mac-universal')]
};
