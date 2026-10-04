'use strict';
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
const base = require('../package.json').build;
const { runtimeResources } = require('./runtime-resources.cjs');
module.exports = { ...base, extraResources: [...base.extraResources, ...runtimeResources('mac-universal')] };
