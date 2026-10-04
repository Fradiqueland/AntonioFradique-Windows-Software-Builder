#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const expected = {
  '7za.exe': 'fbb3dadcc29bcbc5460484d858c5f33f99e5317f5f6cd8d9c83f4dd8c39b3e30',
  '7zsd_All_x64.sfx': '56642f9ed03cd60fd9a69695f098957767d9570ffe1d5d970b38ba6b6b1a2936'
};
for (const [name, sha256] of Object.entries(expected)) {
  const file = path.join(__dirname, '..', 'src', 'builder', 'bin', name);
  if (!fs.existsSync(file)) throw new Error('Missing SFX binary: ' + file + '. Restore the version tracked in Git.');
  if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== sha256) {
    throw new Error('SFX binary checksum does not match src/builder/bin/README.md: ' + name);
  }
}
console.log('Windows SFX binaries verified.');
