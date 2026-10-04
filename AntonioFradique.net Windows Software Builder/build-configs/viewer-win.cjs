'use strict';
const base = require('./viewer-template.json');
const { runtimeResources } = require('./runtime-resources.cjs');
module.exports = { ...base, extraResources: [...base.extraResources, ...runtimeResources('windows-x64')] };
