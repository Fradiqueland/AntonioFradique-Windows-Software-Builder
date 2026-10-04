'use strict';
// electron-builder 25 does not implement mac.identity: '-' directly. Its
// supported signing hook delegates to the same official Electron signer with
// an explicit ad-hoc identity. This needs no certificate or Apple account.
const { signAsync } = require('@electron/osx-sign');
module.exports = async function signMacAdhoc(options) {
  await signAsync({
    ...options,
    identity: '-',
    identityValidation: false,
    preAutoEntitlements: false,
    optionsForFile: (filePath) => ({ ...options.optionsForFile(filePath), timestamp: 'none' }),
    provisioningProfile: undefined,
    keychain: undefined,
    type: 'development'
  });
};
