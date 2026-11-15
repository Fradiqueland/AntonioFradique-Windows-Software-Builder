'use strict';
const base = require('../package.json').build;
const { runtimeResources } = require('./runtime-resources.cjs');
const { builderFiles } = require('./viewer-files.cjs');
module.exports = {
  ...base,
  compression: 'maximum',
  files: builderFiles(base.files, 'windows-x64'),
  asar: false, // rcedit.exe is invoked natively when applying a Windows icon.
  extraResources: [...base.extraResources, ...runtimeResources('windows-x64'), { from: 'src/builder/bin', to: 'sfx' }, { from: 'dist/native-launcher/windows-launcher.exe', to: 'sfx/windows-launcher.exe' }, { from: 'dist/native-launcher/windows-launcher.json', to: 'sfx/windows-launcher.json' }]
};
