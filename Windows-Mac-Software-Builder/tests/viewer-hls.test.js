'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lock = require('../package-lock.json');
const pkg = require('../package.json');
const Hls = require('../src/viewer/vendor/hls.min.js');

test('Viewer loads the locked HLS browser distribution with its original license', () => {
  const viewer = path.join(__dirname, '../src/viewer');
  const version = lock.packages['node_modules/hls.js'].version;
  assert.equal(pkg.devDependencies['hls.js'], version);
  assert.equal(Hls.version, version);
  assert.match(fs.readFileSync(path.join(viewer, 'index.html'), 'utf8'), /<script src="vendor\/hls\.min\.js"><\/script>/);
  const installed = path.dirname(require.resolve('hls.js/package.json'));
  // Git can convert newlines in vendored text on Windows checkouts.
  const read = filename => fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');
  assert.ok(read(path.join(viewer, 'vendor/hls.min.js')) === read(path.join(installed, 'dist/hls.min.js')),
    'The shipped player must match the distribution installed by npm ci.');
  assert.equal(read(path.join(viewer, 'vendor/hls.LICENSE.txt')), read(path.join(installed, 'LICENSE')));
});

test('Viewer loads the locked MPEG-TS distribution and its upstream notices', () => {
  const installed = path.dirname(require.resolve('mpegts.js/package.json'));
  const viewer = path.join(__dirname, '../src/viewer');
  const version = lock.packages['node_modules/mpegts.js'].version;
  assert.equal(pkg.devDependencies['mpegts.js'], version);
  assert.equal(require('mpegts.js/package.json').version, version);
  assert.match(fs.readFileSync(path.join(viewer, 'index.html'), 'utf8'), /<script src="vendor\/mpegts\.min\.js"><\/script>/);
  const read = filename => fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');
  for (const [local, original] of [['mpegts.min.js', 'dist/mpegts.js'], ['mpegts.LICENSE.txt', 'LICENSE'],
    ['mpegts.js.LICENSE.txt', 'dist/mpegts.js.LICENSE.txt']]) {
    assert.ok(read(path.join(viewer, 'vendor', local)) === read(path.join(installed, original)),
      local + ' must match the locked upstream package.');
  }
});
