#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./template-archive');

async function main() {
  const directory = path.join(__dirname, '..', 'dist', 'builder');
  const names = fs.readdirSync(directory).filter((name) => /^Windows-Mac-Software-Builder-.*\.(exe|dmg)$/.test(name)).sort();
  if (!names.length) throw new Error('No Windows or Mac installers found.');
  const lines = [];
  for (const name of names) lines.push(await sha256(path.join(directory, name)) + '  ' + name);
  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
