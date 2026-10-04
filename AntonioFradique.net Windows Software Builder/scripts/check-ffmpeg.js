#!/usr/bin/env node
'use strict';
const { runtimeDirectory } = require('../build-configs/runtime-resources.cjs');
const target = process.platform === 'darwin' ? 'mac-universal' : 'windows-x64';
const directory = runtimeDirectory('ffmpeg', target);
console.log(directory ? 'ffmpeg: ' + directory : 'Optional ffmpeg runtime absent for ' + target + '. The local IPTV retransmission engine will be unavailable.');
