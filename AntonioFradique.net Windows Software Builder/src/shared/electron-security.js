const { pathToFileURL } = require('url');

function isTrustedFrame(event, window, entryPath) {
  if (!window || window.isDestroyed()) return false;
  const contents = window.webContents;
  return event.sender === contents && event.senderFrame === contents.mainFrame
    && event.senderFrame.url === pathToFileURL(entryPath).href;
}

function lockGuestPreferences(preferences) {
  delete preferences.preload;
  delete preferences.preloadURL;
  preferences.nodeIntegration = false;
  preferences.nodeIntegrationInWorker = false;
  preferences.nodeIntegrationInSubFrames = false;
  preferences.contextIsolation = true;
  preferences.sandbox = true;
  preferences.webSecurity = true;
  preferences.allowRunningInsecureContent = false;
  preferences.webviewTag = false;
}

module.exports = { isTrustedFrame, lockGuestPreferences };
