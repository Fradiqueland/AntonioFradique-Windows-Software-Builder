#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const mode = process.argv[2];
const target = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : null;
if (!target || !['viewer', 'builder', 'all'].includes(mode)) {
  console.error('Builds require Windows or macOS. Use the GitHub Actions workflow to create both installers.');
  process.exit(1);
}
const steps = mode === 'all' ? ['viewer', 'builder'] : [mode];
for (const step of steps) {
  // npm supplies npm_execpath on all supported hosts. Avoid shell quoting of
  // paths and product names containing spaces or ampersands.
  const npmPath = process.env.npm_execpath;
  if (!npmPath) throw new Error('Run this script through npm run build:' + mode);
  const result = spawnSync(process.execPath, [npmPath, 'run', 'build:' + step + ':' + target], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
