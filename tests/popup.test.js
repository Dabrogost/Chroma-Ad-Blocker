const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const popupJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'popup.js'), 'utf8');
const popupHtmlCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'popup.html'), 'utf8');
const settingsHtmlCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'settings.html'), 'utf8');

// ─── POPUP.JS FUNCTIONALITY ─────
test('popup.js functionality', async (t) => {
  function createSandbox() {
    const elements = {};
    const getElement = (id) => {
      if (!elements[id]) {
        const parent = {
          classList: { add: () => {}, remove: () => {} },
          parentElement: { 
            classList: { add: () => {}, remove: () => {} } 
          }
        };
        elements[id] = {
          id,
          checked: false,
          textContent: '',
          listeners: {},
          dataset: {},
          classList: {
            add: (cls) => { if (!elements[id].classList.current.includes(cls)) elements[id].classList.current += ' ' + cls; },
            remove: (cls) => { elements[id].classList.current = elements[id].classList.current.replace(cls, '').trim(); },
            toggle: (cls, force) => {
              const has = elements[id].classList.current.includes(cls);
              const want = force !== undefined ? force : !has;
              if (want && !has) elements[id].classList.current += ' ' + cls;
              else if (!want && has) elements[id].classList.current = elements[id].classList.current.replace(cls, '').trim();
            },
            current: ''
          },
          style: { display: '' },
          parentElement: parent,
          appendChild: (child) => {},
          querySelector: (sel) => getElement('temp-child-' + Math.random()),
          querySelectorAll: (sel) => [],
          title: '',
          addEventListener(event, fn) {
            if (!this.listeners[event]) this.listeners[event] = [];
            this.listeners[event].push(fn);
          },
          async dispatchEvent(event) {
            const type = typeof event === 'string' ? event : event.type;
            if (this.listeners[type]) {
              await Promise.all(this.listeners[type].map(fn => fn({ target: this })));
            }
          }
        };
      }
      return elements[id];
    };

    const messages = [];
    const storageState = {
      stats: { networkBlocked: 5 },
      dynamicRules: []
    };

    const chromeMock = {
      runtime: {
        sendMessage: async (msg) => {
          messages.push(msg);
          if (msg.type === 'CONFIG_GET') {
            return {
              acceleration: false,
              cosmetic: true,
              suppressWarnings: false,
              enabled: true
            };
          }
          if (msg.type === 'CONFIG_SET') {
            return { ok: true };
          }
          if (msg.type === 'STATS_RESET') {
            return { ok: true };
          }
          if (msg.type === 'PROXY_CONFIG_GET') {
            return [{ id: 1, name: 'Main', host: '1.2.3.4', port: '80', hasCredentials: true, domains: [], accepted: false }];
          }
          if (msg.type === 'PROXY_CONFIG_SET') {
            return { ok: true };
          }
          if (msg.type === 'PROXY_TEST') {
            return { ok: true, ip: '1.2.3.4' };
          }
          if (msg.type === 'WHITELIST_GET') {
            return { whitelist: [] };
          }
          if (msg.type === 'SUBSCRIPTION_GET') {
            return [];
          }
          if (msg.type === 'UPDATE_CHECK') {
            return { updateAvailable: false };
          }
        },
        getManifest: () => ({ version: '1.0.0' })
      },
      storage: {
        local: {
          get: async (keys) => {
            if (typeof keys === 'string') return { [keys]: storageState[keys] };
            if (Array.isArray(keys)) {
              const res = {};
              keys.forEach(k => res[k] = storageState[k]);
              return res;
            }
            return storageState;
          },
          set: async (val) => { Object.assign(storageState, val); }
        },
        onChanged: { addListener: () => {} }
      },
      tabs: {
        query: async () => [{ url: 'https://www.youtube.com/', id: 1, hostname: 'www.youtube.com' }]
      }
    };

    const sandbox = {
      chrome: chromeMock,
      document: {
        getElementById: getElement,
        createElement: (tag) => {
          const el = getElement('temp-' + Math.random());
          el.tagName = tag.toUpperCase();
          el.appendChild = (child) => {};
          el.querySelector = (sel) => getElement('temp-child-' + Math.random());
          el.querySelectorAll = (sel) => [];
          return el;
        },
        querySelector: (sel) => {
          if (sel.startsWith('#')) return getElement(sel.slice(1));
          if (sel === '.section-title') return getElement('sectionTitle');
          return null;
        },
        querySelectorAll: () => []
      },
      MutationObserver: class {
        constructor() {}
        observe() {}
        disconnect() {}
      },
      console: console,
      Object: Object,
      Promise: Promise,
      Error: Error,
      setTimeout: setTimeout,
      MSG: {
        CONFIG_GET: 'CONFIG_GET',
        CONFIG_SET: 'CONFIG_SET',
        CONFIG_UPDATE: 'CONFIG_UPDATE',
        STATS_RESET: 'STATS_RESET',
        PROXY_CONFIG_GET: 'PROXY_CONFIG_GET',
        PROXY_CONFIG_SET: 'PROXY_CONFIG_SET',
        PROXY_TEST: 'PROXY_TEST',
        WHITELIST_GET: 'WHITELIST_GET',
        WHITELIST_ADD: 'WHITELIST_ADD',
        WHITELIST_REMOVE: 'WHITELIST_REMOVE',
        SUBSCRIPTION_GET: 'SUBSCRIPTION_GET',
        SUBSCRIPTION_SET: 'SUBSCRIPTION_SET',
        SUBSCRIPTION_REFRESH: 'SUBSCRIPTION_REFRESH',
        UPDATE_CHECK: 'UPDATE_CHECK'
      },
      window: {
        addEventListener: (type, fn) => {},
        removeEventListener: (type, fn) => {}
      },
      notifyBackground: (msg) => chromeMock.runtime.sendMessage(msg).catch(() => null)
    };


    getElement('toggleEnabled');
    getElement('statusDot');
    getElement('toggleNetwork');
    getElement('toggleAcceleration');
    getElement('toggleCosmetic');
    getElement('toggleShorts');
    getElement('toggleMerch');
    getElement('toggleOffers');
    getElement('toggleWarnings');
    getElement('statNetworkBlocked');
    getElement('resetStats');
    getElement('toggleWhitelist');
    getElement('subscriptionList');
    getElement('proxyRouterContainer');
    getElement('addProxyServerBtn');
    getElement('proxyActiveGroup');
    getElement('proxyActiveText');
    getElement('proxyAcceptBtn');
    getElement('proxyClearSettingsBtn');
    getElement('proxyHost');
    getElement('proxyPort');
    getElement('proxyUser');
    getElement('proxyPass');
    getElement('proxyDomainInput');
    getElement('proxyAddDomainBtn');
    getElement('proxyDomainList');
    getElement('logToggleRow');
    getElement('logToggleBtn');
    getElement('logEntries');

    return { sandbox, elements, messages, chromeMock };
  }

  await t.test('initializes with correct config and stats', async () => {
    const { sandbox, elements, messages } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(popupJsCode, sandbox);

    // Initialization Cooldown: Async DOM settling delay.
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.strictEqual(elements['toggleAcceleration'].checked, false);
    assert.strictEqual(elements['toggleCosmetic'].checked, true);
    assert.strictEqual(elements['toggleWarnings'].checked, false);

    assert.strictEqual(elements['statNetworkBlocked'].textContent, 5);

    assert.ok(messages.some(m => m.type === 'CONFIG_GET'));
  });

  await t.test('toggle event listeners trigger SET_CONFIG', async () => {
    const { sandbox, elements, messages } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(popupJsCode, sandbox);
    // Initialization Cooldown: Async DOM settling delay.
    await new Promise(resolve => setTimeout(resolve, 50));

    messages.length = 0;

    elements['toggleAcceleration'].checked = true;
    await elements['toggleAcceleration'].dispatchEvent('change');

    assert.ok(messages.some(m => m.type === 'CONFIG_SET' && m.config.acceleration === true));
  });

  await t.test('reset stats button triggers RESET_STATS and updates UI', async () => {
    const { sandbox, elements, messages } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(popupJsCode, sandbox);
    // Initialization Cooldown: Async DOM settling delay.
    await new Promise(resolve => setTimeout(resolve, 50));

    messages.length = 0;

    await elements['resetStats'].dispatchEvent('click');

    assert.ok(messages.some(m => m.type === 'STATS_RESET'));

    assert.strictEqual(elements['statNetworkBlocked'].textContent, '0');
  });

  await t.test('handles missing config/stats defaults gracefully', async () => {
    const { sandbox, elements, messages, chromeMock } = createSandbox();

    chromeMock.runtime.sendMessage = async (msg) => {
      messages.push(msg);
      if (msg.type === 'PROXY_CONFIG_GET') return [];
      return null;
    };
    chromeMock.storage.local.get = async () => ({}); // Simulate empty storage

    vm.createContext(sandbox);
    vm.runInContext(popupJsCode, sandbox);
    // Initialization Cooldown: Async DOM settling delay.
    await new Promise(resolve => setTimeout(resolve, 50));

    // Based on TOGGLES in popup.js, acceleration defaults to false, others true
    assert.strictEqual(elements['toggleAcceleration'].checked, false);
    assert.strictEqual(elements['toggleCosmetic'].checked, true);
    assert.strictEqual(elements['toggleWarnings'].checked, true);

    assert.strictEqual(elements['statNetworkBlocked'].textContent, 0);
  });

  await t.test('notifyBackground wrapper function - passes message correctly', async () => {
    const { sandbox, messages } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(popupJsCode, sandbox);

    // Wait for initial init() calls to finish
    // Initialization Cooldown: Async DOM settling delay.
    await new Promise(resolve => setTimeout(resolve, 50));
    messages.length = 0;

    const testMsg = { type: 'TEST_PING', data: 123 };
    await sandbox.notifyBackground(testMsg);

    assert.strictEqual(messages.length, 1);
    assert.deepStrictEqual(messages[0], testMsg);
  });

  await t.test('notifyBackground wrapper function - returns response correctly', async () => {
    const { sandbox, chromeMock } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(popupJsCode, sandbox);

    // Wait for initial init() calls to finish
    // Initialization Cooldown: Async DOM settling delay.
    await new Promise(resolve => setTimeout(resolve, 50));

    const mockResponse = { success: true, data: { status: 'ok' } };
    chromeMock.runtime.sendMessage = async () => mockResponse;

    const result = await sandbox.notifyBackground({ type: 'TEST_REPLY' });
    assert.deepStrictEqual(result, mockResponse);
  });

  await t.test('notifyBackground wrapper function - propagates errors correctly', async () => {
    const { sandbox, chromeMock } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(popupJsCode, sandbox);

    // Wait for initial init() calls to finish
    // Initialization Cooldown: Async DOM settling delay.
    await new Promise(resolve => setTimeout(resolve, 50));

    const testError = new Error('Background script failed');
    const originalSendMessage = chromeMock.runtime.sendMessage;
    chromeMock.runtime.sendMessage = async (msg) => {
      if (msg.type === 'TEST_ERROR') {
        throw testError;
      }
      return originalSendMessage(msg);
    };

    const result = await sandbox.notifyBackground({ type: 'TEST_ERROR' });
    assert.strictEqual(result, null, 'Should return null on messaging error');
  });
});

test('UI hardening copy', () => {
  assert.match(popupHtmlCode, /changes anti-detection network behavior/);
  assert.match(settingsHtmlCode, /changes anti-detection network behavior/);
  assert.match(settingsHtmlCode, /<script src="popup\.js"><\/script>/);
  assert.match(popupJsCode, /Leave fields blank to keep them/);
  assert.match(popupJsCode, /const action = pc\.credentialAction \|\| 'preserve'/);
  assert.match(popupJsCode, /\.filter\(pc => pc\.accepted === true\)/);
  assert.match(popupJsCode, /out\.credentialAction === 'replace'/);
  assert.match(popupJsCode, /applyAuthVisibility\(true\)/);
  assert.doesNotMatch(popupJsCode, /\[typeSelect, hostInput, portInput\][\s\S]{0,220}saveAllConfigs\(\)/);
  assert.match(popupJsCode, /clearBtn\.addEventListener\('click', async \(\) => \{[\s\S]*?pc\.accepted = false;[\s\S]*?await saveAllConfigs\(true\);/);
  assert.match(popupJsCode, /Global proxy mode can route all browser traffic/);
});
