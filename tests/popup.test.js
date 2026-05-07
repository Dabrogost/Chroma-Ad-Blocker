const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const componentsJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'components.js'), 'utf8');
const appJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'app.js'), 'utf8');
const proxyUiJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'proxy-ui.js'), 'utf8');
const popupJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'popup.js'), 'utf8');
const settingsJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'settings.js'), 'utf8');
const uiScriptsCode = [componentsJsCode, appJsCode, proxyUiJsCode, popupJsCode].join('\n');
const popupHtmlCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'popup.html'), 'utf8');
const settingsHtmlCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'settings.html'), 'utf8');

async function settlePopupAsyncWork(turns = 20) {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

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
      statsV2: null,
      dynamicRules: []
    };

    const chromeMock = {
      runtime: {
        optionsOpened: 0,
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
          if (msg.type === 'STATS_GET') {
            return {
              settings: { mode: 'aggregated', retentionDays: 90, storeFullUrls: false },
              totals: {
                protectionEvents: 100242,
                networkBlocks: 5,
                cosmeticHides: 2,
                scriptletHits: 1,
                youtubePayloadCleans: 1,
                warningSuppressions: 0,
                zapperHits: 0,
                proxyTests: 2,
                proxyAuthChallenges: 1
              },
              ranges: {
                today: { protectionEvents: 1 },
                last7Days: { protectionEvents: 3 },
                last30Days: { protectionEvents: 7 },
                allTime: { protectionEvents: 100242 }
              },
              bySite: {},
              byRule: {},
              byDay: {},
              recentEvents: [],
              timeSavedSeconds: 25
            };
          }
          if (msg.type === 'STATS_EXPORT') {
            return { exportedAt: Date.now(), stats: { totals: { protectionEvents: 9 } } };
          }
          if (msg.type === 'STATS_SETTINGS_SET') {
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
        getManifest: () => ({ version: '1.0.0' }),
        getURL: (path) => `chrome-extension://test/${path}`,
        openOptionsPage: () => { chromeMock.runtime.optionsOpened++; }
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
        created: [],
        query: async () => [{ url: 'https://www.youtube.com/', id: 1, hostname: 'www.youtube.com' }],
        create: async (info) => { chromeMock.tabs.created.push(info); return { id: 99, ...info }; }
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
        STATS_GET: 'STATS_GET',
        STATS_EVENT_BATCH: 'STATS_EVENT_BATCH',
        STATS_RESET: 'STATS_RESET',
        STATS_EXPORT: 'STATS_EXPORT',
        STATS_SETTINGS_SET: 'STATS_SETTINGS_SET',
        PROXY_CONFIG_GET: 'PROXY_CONFIG_GET',
        PROXY_CONFIG_SET: 'PROXY_CONFIG_SET',
        PROXY_TEST: 'PROXY_TEST',
        ZAPPER_START: 'ZAPPER_START',
        ZAPPER_RULES_GET: 'ZAPPER_RULES_GET',
        ZAPPER_RULE_REMOVE: 'ZAPPER_RULE_REMOVE',
        ZAPPER_RULE_SET: 'ZAPPER_RULE_SET',
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
      location: { pathname: '/ui/popup.html', hash: '' },
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
    getElement('statProtectionEvents');
    getElement('statBreakdownNetwork');
    getElement('statBreakdownCleanup');
    getElement('statBreakdownScriptlets');
    getElement('statBreakdownProxy');
    getElement('cardNetwork');
    getElement('settingsIcon');
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

  await t.test('initializes with correct config and protection stats', async () => {
    const { sandbox, elements, messages } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(uiScriptsCode, sandbox);

    await settlePopupAsyncWork();

    assert.strictEqual(elements['toggleAcceleration'].checked, false);
    assert.strictEqual(elements['toggleCosmetic'].checked, true);
    assert.strictEqual(elements['toggleWarnings'].checked, false);

    assert.strictEqual(elements['statProtectionEvents'].textContent, '100.2k');
    assert.strictEqual(elements['statBreakdownNetwork'].textContent, '5');
    assert.strictEqual(elements['statBreakdownCleanup'].textContent, '3');
    assert.strictEqual(elements['statBreakdownProxy'].textContent, '3');

    assert.ok(messages.some(m => m.type === 'CONFIG_GET'));
    assert.ok(messages.some(m => m.type === 'STATS_GET'));
  });

  await t.test('toggle event listeners trigger SET_CONFIG', async () => {
    const { sandbox, elements, messages } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(uiScriptsCode, sandbox);
    await settlePopupAsyncWork();

    messages.length = 0;

    elements['toggleAcceleration'].checked = true;
    await elements['toggleAcceleration'].dispatchEvent('change');

    assert.ok(messages.some(m => m.type === 'CONFIG_SET' && m.config.acceleration === true));
  });

  await t.test('reset stats button triggers scoped stats reset and reloads UI', async () => {
    const { sandbox, elements, messages } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(uiScriptsCode, sandbox);
    await settlePopupAsyncWork();

    messages.length = 0;

    await elements['resetStats'].dispatchEvent('click');

    assert.ok(messages.some(m => m.type === 'STATS_RESET' && m.scope === 'all'));
    assert.ok(messages.some(m => m.type === 'STATS_GET'));
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
    vm.runInContext(uiScriptsCode, sandbox);
    await settlePopupAsyncWork();

    // Based on TOGGLES in popup.js, acceleration defaults to false, others true
    assert.strictEqual(elements['toggleAcceleration'].checked, false);
    assert.strictEqual(elements['toggleCosmetic'].checked, true);
    assert.strictEqual(elements['toggleWarnings'].checked, true);

    assert.strictEqual(elements['statProtectionEvents'].textContent, '0');
  });

  await t.test('notifyBackground wrapper function - passes message correctly', async () => {
    const { sandbox, messages } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(uiScriptsCode, sandbox);

    await settlePopupAsyncWork();
    messages.length = 0;

    const testMsg = { type: 'TEST_PING', data: 123 };
    await sandbox.notifyBackground(testMsg);

    assert.strictEqual(messages.length, 1);
    assert.deepStrictEqual(messages[0], testMsg);
  });

  await t.test('notifyBackground wrapper function - returns response correctly', async () => {
    const { sandbox, chromeMock } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(uiScriptsCode, sandbox);

    await settlePopupAsyncWork();

    const mockResponse = { success: true, data: { status: 'ok' } };
    chromeMock.runtime.sendMessage = async () => mockResponse;

    const result = await sandbox.notifyBackground({ type: 'TEST_REPLY' });
    assert.deepStrictEqual(result, mockResponse);
  });

  await t.test('notifyBackground wrapper function - propagates errors correctly', async () => {
    const { sandbox, chromeMock } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(uiScriptsCode, sandbox);

    await settlePopupAsyncWork();

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

  await t.test('popup proxy manage helper opens settings hash without saving credentials', async () => {
    const { sandbox, elements, messages, chromeMock } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(uiScriptsCode, sandbox);
    await settlePopupAsyncWork();

    messages.length = 0;
    assert.strictEqual(typeof sandbox.openProxySettings, 'function');
    await sandbox.openProxySettings();

    assert.strictEqual(chromeMock.tabs.created.at(-1)?.url, 'chrome-extension://test/ui/settings.html#proxy');
    assert.strictEqual(messages.some(m =>
      m.type === 'PROXY_CONFIG_SET' &&
      JSON.stringify(m).match(/username|password|credentialAction":"replace/)
    ), false);
  });

  await t.test('protection events card opens settings', async () => {
    const { sandbox, elements, chromeMock } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(uiScriptsCode, sandbox);
    await settlePopupAsyncWork();

    await elements['cardNetwork'].dispatchEvent('click');

    assert.strictEqual(chromeMock.runtime.optionsOpened, 1);
    assert.match(elements['cardNetwork'].classList.current, /stat-card--clickable/);
  });
});

test('UI hardening copy', () => {
  assert.match(componentsJsCode, /changes anti-detection network behavior/);
  assert.match(componentsJsCode, /Protection Events/);
  assert.match(componentsJsCode, /Protection Intelligence/);
  assert.doesNotMatch(componentsJsCode, /Ads Blocked/);
  assert.match(popupHtmlCode, /<div id="appShell"><\/div>/);
  assert.match(popupHtmlCode, /<script src="\.\.\/core\/messaging\.js"><\/script>\s*<script src="components\.js"><\/script>\s*<script src="app\.js"><\/script>/);
  assert.match(popupHtmlCode, /<script src="proxy-ui\.js"><\/script>/);
  assert.match(popupHtmlCode, /<script src="popup\.js"><\/script>/);
  assert.match(settingsHtmlCode, /<div id="appShell"><\/div>/);
  assert.match(settingsHtmlCode, /<script src="\.\.\/core\/messaging\.js"><\/script>\s*<script src="components\.js"><\/script>\s*<script src="app\.js"><\/script>/);
  assert.match(settingsHtmlCode, /<script src="proxy-ui\.js"><\/script>/);
  assert.match(settingsHtmlCode, /<script src="settings\.js"><\/script>/);
  assert.doesNotMatch(popupHtmlCode, /<header>|Protection Layers|Filter Lists|Request Log/);
  assert.doesNotMatch(settingsHtmlCode, /<header>|Protection Layers|Filter Lists|Request Log|Local Zapper Rules/);
  assert.doesNotMatch(popupHtmlCode, /style="/);
  assert.doesNotMatch(settingsHtmlCode, /style="/);
  assert.doesNotMatch(componentsJsCode, /style="/);
  assert.doesNotMatch(appJsCode, /style="/);
  assert.doesNotMatch(proxyUiJsCode, /style="/);
  assert.doesNotMatch(proxyUiJsCode, /style\.cssText/);
  assert.doesNotMatch(popupHtmlCode, /proxyUser|proxyPass|proxyHost|proxyPort/);
  assert.match(appJsCode, /function openProxySettings\(\)/);
  assert.match(appJsCode, /ui\/settings\.html#proxy/);
  assert.match(proxyUiJsCode, /if \(!settingsMode\)/);
  assert.match(proxyUiJsCode, /\.filter\(pc => pc\.accepted === true\)/);
  assert.match(proxyUiJsCode, /Manage proxies/);
  assert.doesNotMatch(popupHtmlCode, /id="addProxyServerBtn"/);
  assert.match(componentsJsCode, /id="addProxyServerBtn"/);
  assert.match(proxyUiJsCode, /Leave fields blank to keep them/);
  assert.match(proxyUiJsCode, /readCredentialAction/);
  assert.match(proxyUiJsCode, /Enter both username and password, or leave both blank to keep saved credentials\./);
  assert.match(proxyUiJsCode, /Clear credentials/);
  assert.match(proxyUiJsCode, /SOCKS username\/password auth is not supported by Chrome here/);
  assert.match(proxyUiJsCode, /Global proxy mode can route all browser traffic through this proxy when no domain-specific route matches\. Enable it\?/);
  assert.match(componentsJsCode, /id="proxySection"/);
  assert.match(settingsJsCode, /scrollToProxyHash/);
  assert.match(appJsCode, /location\?\.hash !== '#proxy'/);
  assert.doesNotMatch(proxyUiJsCode, /pagehide[\s\S]{0,120}saveAllConfigs/);
  assert.doesNotMatch(proxyUiJsCode, /stageCredentialsFromInputs/);
});

