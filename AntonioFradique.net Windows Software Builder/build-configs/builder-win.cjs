'use strict';
const base = require('../package.json').build;
const { runtimeResources } = require('./runtime-resources.cjs');
module.exports = {
  ...base,
  asar: false, // rcedit.exe is invoked natively when applying a Windows icon.
  extraResources: [...base.extraResources, ...runtimeResources('windows-x64'), { from: 'src/builder/bin', to: 'sfx' }]
};
