#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const expected = {
  '7za.exe': 'dd3757f31c97e33776f2590317d4fb12f2da075db3dbb1e3f94d0f2a01d84ffa',
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
