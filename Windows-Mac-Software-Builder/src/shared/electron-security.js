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

function externalHttpUrl(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) return null;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname
      ? parsed.href : null;
  } catch (_) { return null; }
}

// Feed this gate only from the guest WebContents' native input events in main,
// never from page IPC or DOM messages. A click/key activation grants one short-
// lived external navigation; automatic popups and repeated opens stay blocked.
function createExternalLinkGate({ now = Date.now, maxAgeMs = 1500 } = {}) {
  let activatedAt = null;
  function recordInput(input) {
    if (input && (input.type === 'mouseUp' || input.type === 'gestureTap')) activatedAt = now();
  }
  function recordKeyboard(input) {
    if (input && input.type === 'keyDown' && !input.isAutoRepeat
        && (input.key === 'Enter' || input.key === ' ')) activatedAt = now();
  }
  function consume(value) {
    const url = externalHttpUrl(value);
    if (!url || activatedAt === null) return null;
    const age = now() - activatedAt;
    activatedAt = null;
    return age >= 0 && age <= maxAgeMs ? url : null;
  }
  function reset() { activatedAt = null; }
  return { recordInput, recordKeyboard, consume, reset };
}

function configureGuestNavigation(guest, { isLocalWeb = false, allowed, openExternal, onError = () => {} }) {
  const gate = createExternalLinkGate();
  guest.on('input-event', (_event, input) => gate.recordInput(input));
  guest.on('before-input-event', (_event, input) => gate.recordKeyboard(input));
  const openFromActivation = (value) => {
    const url = gate.consume(value);
    if (url) Promise.resolve().then(() => openExternal(url)).catch(onError);
  };
  const sameLocalOrigin = (value) => {
    try {
      const current = new URL(guest.getURL());
      const destination = new URL(value);
      return current.protocol === 'http:' && current.hostname === '127.0.0.1'
        && current.origin === destination.origin;
    } catch (_) { return false; }
  };
  guest.on('will-navigate', (event, url) => {
    if (isLocalWeb && !sameLocalOrigin(url)) {
      event.preventDefault();
      openFromActivation(url);
    } else if (!allowed(url)) event.preventDefault();
  });
  guest.on('will-redirect', (event, url) => {
    // A server redirect is not a fresh click; never launch the system browser.
    if (!allowed(url) || (isLocalWeb && !sameLocalOrigin(url))) {
      event.preventDefault();
      gate.reset();
    }
  });
  guest.setWindowOpenHandler(({ url }) => {
    openFromActivation(url);
    return { action: 'deny' };
  });
  guest.on('did-navigate', () => gate.reset());
  guest.on('destroyed', () => gate.reset());
}

module.exports = { isTrustedFrame, lockGuestPreferences, externalHttpUrl, createExternalLinkGate, configureGuestNavigation };
