const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const popupJsCode = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

test('popup.js functionality', async (t) => {
  function createSandbox() {
    const elements = {};
    const getElement = (id) => {
      if (!elements[id]) {
        elements[id] = {
          id,
          checked: false,
          textContent: '',
          listeners: {},
          classList: {
            add: (cls) => { elements[id].classList.current = cls; },
            remove: (cls) => { if (elements[id].classList.current === cls) elements[id].classList.current = ''; },
            current: ''
          },
          title: '',
          addEventListener(event, fn) {
            this.listeners[event] = fn;
          }
        };
      }
      return elements[id];
    };

    const messages = [];
    const chromeMock = {
      runtime: {
        sendMessage: async (msg) => {
          messages.push(msg);
          if (msg.type === 'CONFIG_GET') {
            return {
              acceleration: false,
              cosmetic: true,
              suppressWarnings: false,
              blockPopUnders: true,
              blockPushNotifications: false,
              enabled: true
            };
          }
          if (msg.type === 'STATS_GET') {
            return {
              accelerated: 10,
              networkBlocked: 5,
            };
          }
          if (msg.type === 'CONFIG_SET') {
            return { ok: true };
          }
          if (msg.type === 'STATS_RESET') {
            return { ok: true };
          }
        }
      }
    };

    const sandbox = {
      chrome: chromeMock,
      document: {
        getElementById: getElement
      },
      console: console,
      Object: Object,
      Promise: Promise,
      Error: Error,
      setTimeout: setTimeout
    };

    return { sandbox, elements, messages, chromeMock };
  }

  await t.test('initializes with correct config and stats', async () => {
    const { sandbox, elements, messages } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(popupJsCode, sandbox);

    await new Promise(resolve => setTimeout(resolve, 50));

    assert.strictEqual(elements['toggleAcceleration'].checked, false);
    assert.strictEqual(elements['toggleCosmetic'].checked, true);
    assert.strictEqual(elements['toggleWarnings'].checked, false);
    assert.strictEqual(elements['togglePopUnders'].checked, true);
    assert.strictEqual(elements['togglePush'].checked, false);

    assert.strictEqual(elements['statAccelerated'].textContent, 10);
    assert.strictEqual(elements['statNetworkBlocked'].textContent, 5);

    assert.ok(messages.some(m => m.type === 'CONFIG_GET'));
    assert.ok(messages.some(m => m.type === 'STATS_GET'));
  });

  await t.test('toggle event listeners trigger SET_CONFIG', async () => {
    const { sandbox, elements, messages } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(popupJsCode, sandbox);
    await new Promise(resolve => setTimeout(resolve, 50));

    messages.length = 0;

    elements['toggleAcceleration'].checked = true;
    await elements['toggleAcceleration'].listeners['change']({ target: elements['toggleAcceleration'] });

    assert.ok(messages.some(m => m.type === 'CONFIG_SET' && m.config.acceleration === true));
  });

  await t.test('reset stats button triggers RESET_STATS and updates UI', async () => {
    const { sandbox, elements, messages } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(popupJsCode, sandbox);
    await new Promise(resolve => setTimeout(resolve, 50));

    messages.length = 0;

    await elements['resetStats'].listeners['click']();

    assert.ok(messages.some(m => m.type === 'STATS_RESET'));

    assert.strictEqual(elements['statAccelerated'].textContent, '0');
    assert.strictEqual(elements['statNetworkBlocked'].textContent, '0');
  });

  await t.test('handles missing config/stats defaults gracefully', async () => {
    const { sandbox, elements, messages, chromeMock } = createSandbox();

    chromeMock.runtime.sendMessage = async (msg) => {
      messages.push(msg);
      return null;
    };

    vm.createContext(sandbox);
    vm.runInContext(popupJsCode, sandbox);
    await new Promise(resolve => setTimeout(resolve, 50));

    // Based on lines 11-18 in popup.js, it should default to true for these
    assert.strictEqual(elements['toggleAcceleration'].checked, true);
    assert.strictEqual(elements['toggleCosmetic'].checked, true);
    assert.strictEqual(elements['toggleWarnings'].checked, true);
    assert.strictEqual(elements['togglePopUnders'].checked, true);
    assert.strictEqual(elements['togglePush'].checked, true);

    assert.strictEqual(elements['statAccelerated'].textContent, 0);
    assert.strictEqual(elements['statNetworkBlocked'].textContent, 0);
  });

  await t.test('sendBg wrapper function - passes message correctly', async () => {
    const { sandbox, messages } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(popupJsCode, sandbox);

    // Wait for initial init() calls to finish
    await new Promise(resolve => setTimeout(resolve, 50));
    messages.length = 0;

    const testMsg = { type: 'TEST_PING', data: 123 };
    await sandbox.sendBg(testMsg);

    assert.strictEqual(messages.length, 1);
    assert.deepStrictEqual(messages[0], testMsg);
  });

  await t.test('sendBg wrapper function - returns response correctly', async () => {
    const { sandbox, chromeMock } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(popupJsCode, sandbox);

    // Wait for initial init() calls to finish
    await new Promise(resolve => setTimeout(resolve, 50));

    const mockResponse = { success: true, data: { status: 'ok' } };
    chromeMock.runtime.sendMessage = async () => mockResponse;

    const result = await sandbox.sendBg({ type: 'TEST_REPLY' });
    assert.deepStrictEqual(result, mockResponse);
  });

  await t.test('sendBg wrapper function - propagates errors correctly', async () => {
    const { sandbox, chromeMock } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(popupJsCode, sandbox);

    // Wait for initial init() calls to finish
    await new Promise(resolve => setTimeout(resolve, 50));

    const testError = new Error('Background script failed');
    const originalSendMessage = chromeMock.runtime.sendMessage;
    chromeMock.runtime.sendMessage = async (msg) => {
      if (msg.type === 'TEST_ERROR') {
        throw testError;
      }
      return originalSendMessage(msg);
    };

    const result = await sandbox.sendBg({ type: 'TEST_ERROR' });
    assert.strictEqual(result, null, 'Should return null on messaging error');
  });
});
