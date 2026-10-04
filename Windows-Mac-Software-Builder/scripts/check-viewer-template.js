#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { inspectTemplate, sha256 } = require('./template-archive');
const version = require('../package.json').version;

async function checkTemplates(directory = path.join(__dirname, '..', 'dist', 'export-templates')) {
  for (const target of ['windows-x64', 'mac-universal']) {
    const archive = path.join(directory, target + '.zip');
    const manifestPath = path.join(directory, target + '.manifest.json');
    if (!fs.existsSync(archive) || !fs.existsSync(manifestPath)) {
      throw new Error('Missing ' + target + ' template. Run both native viewer builds, then copy both ZIP files and manifests into dist/export-templates. GitHub Actions automates this.');
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.formatVersion !== 1 || manifest.target !== target || manifest.appVersion !== version) throw new Error('Template version/target mismatch: ' + manifestPath);
    if (await sha256(archive) !== manifest.sha256) throw new Error('Template checksum mismatch: ' + archive);
    await inspectTemplate(archive, target);
    console.log('Verified export template: ' + target + ' v' + version);
  }
}
module.exports = { checkTemplates };
if (require.main === module) checkTemplates().catch((error) => { console.error(error.message); process.exitCode = 1; });
