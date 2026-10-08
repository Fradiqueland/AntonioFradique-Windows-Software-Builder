'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getAndroidRuntimeStatus, assertAPKExport } = require('../src/shared/android-runtime');

test('Android execution remains unavailable without a validated incorporated runtime', () => {
  for (const audience of ['creator', 'viewer']) {
    for (const locale of ['pt-PT', 'en-US']) {
      const status = getAndroidRuntimeStatus({ audience, locale });
      assert.equal(status.available, false);
      assert.equal(status.code, 'ANDROID_RUNTIME_NOT_INCLUDED');
      assert.ok(status.message.length > 0);
      assert.ok(status.requirements.length > 0);
      assert.ok(Object.isFrozen(status));
    }
  }
});

test('manual APK project references cannot produce an unusable exported application', () => {
  for (const type of ['apk', 'android-apk']) {
    assert.throws(() => assertAPKExport({ content: [{ type, data: { ready: true, runtime: '/external/emulator' } }] }), {
      code: 'ANDROID_RUNTIME_NOT_INCLUDED'
    });
    assert.throws(() => assertAPKExport([{ type }], { locale: 'en' }), {
      code: 'ANDROID_RUNTIME_NOT_INCLUDED'
    });
  }
});

test('ordinary modules and APK mentions in prose retain their existing export behavior', () => {
  assert.doesNotThrow(() => assertAPKExport({ content: [
    { type: 'text', title: 'How to use an APK' },
    { type: 'local-web', data: {} },
    { type: 'portable', data: {} }
  ] }));
  assert.doesNotThrow(() => assertAPKExport({ content: [] }));
});
