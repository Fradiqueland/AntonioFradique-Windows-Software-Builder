'use strict';
const base = require('./viewer-template.json');
const { runtimeResources } = require('./runtime-resources.cjs');
const { viewerFiles } = require('./viewer-files.cjs');
module.exports = { ...base, compression: 'maximum', files: viewerFiles(base.files), extraResources: [...base.extraResources, ...runtimeResources('windows-x64')] };
