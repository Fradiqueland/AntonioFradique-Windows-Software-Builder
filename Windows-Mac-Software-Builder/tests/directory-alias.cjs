'use strict';
const fs = require('node:fs');

// Windows can permit either a directory symlink or a junction, depending on
// the filesystem and the account. Both exercise path canonicalisation.
function createDirectoryAlias(target, alias) {
  try { fs.symlinkSync(target, alias, 'dir'); }
  catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    fs.symlinkSync(target, alias, 'junction');
  }
}
module.exports = { createDirectoryAlias };
