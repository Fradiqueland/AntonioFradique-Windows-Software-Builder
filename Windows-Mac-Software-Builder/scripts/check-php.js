#!/usr/bin/env node
'use strict';
const { runtimeDirectory } = require('../build-configs/runtime-resources.cjs');
const target = process.platform === 'darwin' ? 'mac-universal' : 'windows-x64';
const directory = runtimeDirectory('php', target);
console.log(directory ? 'PHP: ' + directory : 'Optional PHP runtime absent for ' + target + '. HTML works; PHP execution/export requires a compatible runtime.');
