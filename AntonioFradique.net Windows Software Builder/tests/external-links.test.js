'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { externalHttpUrl, createExternalLinkGate, configureGuestNavigation } = require('../src/shared/electron-security');

test('external links require absolute HTTP(S) URLs and reject control characters/protocol handlers', () => {
  assert.equal(externalHttpUrl(' HTTPS://Example.com/path?q=1 '), 'https://example.com/path?q=1');
  for (const value of ['', null, '/relative', '//example.com', 'https:example.com', 'javascript:alert(1)', 'file:///tmp/a', 'data:text/html,x', 'mailto:a@example.com', 'https://example.com/\nnext', 'http://[invalid']) {
    assert.equal(externalHttpUrl(value), null, String(value));
  }
});

test('native click activation permits exactly one browser open within its deadline', () => {
  let now = 100;
  const gate = createExternalLinkGate({ now: () => now });
  const url = 'https://chatgpt.com/';
  assert.equal(gate.consume(url), null);
  gate.recordInput({ type: 'mouseMove' });
  assert.equal(gate.consume(url), null);
  gate.recordInput({ type: 'mouseUp' });
  now += 50;
  assert.equal(gate.consume(url), url);
  assert.equal(gate.consume(url), null);
  gate.recordInput({ type: 'gestureTap' });
  now += 1501;
  assert.equal(gate.consume(url), null);
  gate.recordInput({ type: 'mouseUp' });
  now--;
  assert.equal(gate.consume(url), null);
});

test('keyboard activation supports Enter/Space without accepting text entry or autorepeat', () => {
  const gate = createExternalLinkGate();
  const url = 'https://example.com/';
  for (const input of [{ type: 'keyDown', key: 'x' }, { type: 'keyUp', key: 'Enter' }, { type: 'keyDown', key: 'Enter', isAutoRepeat: true }]) {
    gate.recordKeyboard(input);
    assert.equal(gate.consume(url), null);
  }
  for (const key of ['Enter', ' ']) {
    gate.recordKeyboard({ type: 'keyDown', key });
    assert.equal(gate.consume(url), url);
  }
});

function setup(isLocalWeb = true) {
  const guest = new EventEmitter();
  guest.getURL = () => 'http://127.0.0.1:43210/token/index.html';
  guest.setWindowOpenHandler = handler => { guest.popup = handler; };
  const opened = [];
  configureGuestNavigation(guest, { isLocalWeb, allowed: value => /^https?:\/\//i.test(value), openExternal: url => opened.push(url) });
  const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  const click = () => guest.emit('input-event', {}, { type: 'mouseUp' });
  return { guest, opened, event, click };
}

test('imported-page popups reach only the system browser after a click; Electron windows are always denied', async () => {
  const { guest, opened, click } = setup();
  assert.deepEqual(guest.popup({ url: 'https://chatgpt.com/' }), { action: 'deny' });
  click();
  assert.deepEqual(guest.popup({ url: 'https://chatgpt.com/' }), { action: 'deny' });
  guest.popup({ url: 'https://example.com/automatic-second-popup' });
  await Promise.resolve();
  assert.deepEqual(opened, ['https://chatgpt.com/']);
});

test('same-tab external clicks open the browser while local navigation stays inside the module', async () => {
  const { guest, opened, event, click } = setup();
  const local = event();
  guest.emit('will-navigate', local, 'http://127.0.0.1:43210/token/next.html');
  assert.equal(local.prevented, false);
  click();
  const remote = event();
  guest.emit('will-navigate', remote, 'https://antoniofradique.net/');
  assert.equal(remote.prevented, true);
  await Promise.resolve();
  assert.deepEqual(opened, ['https://antoniofradique.net/']);
});

test('automatic navigations, server redirects and unsafe protocols never launch the browser', async () => {
  const { guest, opened, event, click } = setup();
  const automatic = event();
  guest.emit('will-navigate', automatic, 'https://example.com/auto');
  assert.equal(automatic.prevented, true);
  click();
  const redirect = event();
  guest.emit('will-redirect', redirect, 'https://example.com/redirect');
  assert.equal(redirect.prevented, true);
  guest.popup({ url: 'file:///private.txt' });
  guest.popup({ url: 'javascript:alert(1)' });
  await Promise.resolve();
  assert.deepEqual(opened, []);
});

test('navigation resets the guest activation and does not affect another guest', async () => {
  const first = setup();
  const second = setup();
  first.click();
  second.guest.popup({ url: 'https://example.com/' });
  first.guest.emit('did-navigate', {}, first.guest.getURL());
  first.guest.popup({ url: 'https://example.com/' });
  await Promise.resolve();
  assert.deepEqual(first.opened, []);
  assert.deepEqual(second.opened, []);
});
