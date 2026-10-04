'use strict';
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
const base = require('./viewer-template.json');
const { runtimeResources } = require('./runtime-resources.cjs');
module.exports = { ...base, extraResources: [...base.extraResources, ...runtimeResources('mac-universal')] };
