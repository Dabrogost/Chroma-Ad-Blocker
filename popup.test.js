const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const popupJsCode = fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8');

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
          if (msg.type === 'GET_CONFIG') {
            return {
              acceleration: false,
              cosmetic: true,
              suppressWarnings: false,
            };
          }
          if (msg.type === 'GET_STATS') {
            return {
              accelerated: 10,
              blocked: 5,
            };
          }
          if (msg.type === 'SET_CONFIG') {
            return true;
          }
          if (msg.type === 'RESET_STATS') {
            return true;
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

    assert.strictEqual(elements['statAccelerated'].textContent, 10);
    assert.strictEqual(elements['statBlocked'].textContent, 5);

    assert.ok(messages.some(m => m.type === 'GET_CONFIG'));
    assert.ok(messages.some(m => m.type === 'GET_STATS'));
  });

  await t.test('toggle event listeners trigger SET_CONFIG', async () => {
    const { sandbox, elements, messages } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(popupJsCode, sandbox);
    await new Promise(resolve => setTimeout(resolve, 50));

    messages.length = 0;

    elements['toggleAcceleration'].checked = true;
    await elements['toggleAcceleration'].listeners['change']({ target: elements['toggleAcceleration'] });

    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].type, 'SET_CONFIG');
    assert.strictEqual(messages[0].config.acceleration, true);
  });

  await t.test('reset stats button triggers RESET_STATS and updates UI', async () => {
    const { sandbox, elements, messages } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(popupJsCode, sandbox);
    await new Promise(resolve => setTimeout(resolve, 50));

    messages.length = 0;

    await elements['resetStats'].listeners['click']();

    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].type, 'RESET_STATS');

    assert.strictEqual(elements['statAccelerated'].textContent, '0');
    assert.strictEqual(elements['statBlocked'].textContent, '0');
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

    assert.strictEqual(elements['toggleAcceleration'].checked, true);
    assert.strictEqual(elements['toggleCosmetic'].checked, true);
    assert.strictEqual(elements['toggleWarnings'].checked, true);

    assert.strictEqual(elements['statAccelerated'].textContent, 0);
    assert.strictEqual(elements['statBlocked'].textContent, 0);
  });
});
