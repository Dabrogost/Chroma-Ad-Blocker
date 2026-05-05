const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const handlersJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'handlers.js'), 'utf8')
  .replace(/import[\s\S]*?from\s+['"][^'"]+['"];?\s*/g, '')
  .replace(/^export\s+/gm, '');

const contentJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content', 'content.js'), 'utf8');
const zapperJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content', 'zapper.js'), 'utf8');

const MSG = {
  CONFIG_GET: 'CONFIG_GET',
  CONFIG_SET: 'CONFIG_SET',
  STATS_RESET: 'STATS_RESET',
  LOG_GET: 'LOG_GET',
  WHITELIST_GET: 'WHITELIST_GET',
  WHITELIST_ADD: 'WHITELIST_ADD',
  WHITELIST_REMOVE: 'WHITELIST_REMOVE',
  FPR_WHITELIST_GET: 'FPR_WHITELIST_GET',
  FPR_WHITELIST_ADD: 'FPR_WHITELIST_ADD',
  FPR_WHITELIST_REMOVE: 'FPR_WHITELIST_REMOVE',
  SUBSCRIPTION_GET: 'SUBSCRIPTION_GET',
  SUBSCRIPTION_SET: 'SUBSCRIPTION_SET',
  SUBSCRIPTION_REFRESH: 'SUBSCRIPTION_REFRESH',
  SUBSCRIPTION_ADD: 'SUBSCRIPTION_ADD',
  SUBSCRIPTION_REMOVE: 'SUBSCRIPTION_REMOVE',
  UPDATE_CHECK: 'UPDATE_CHECK',
  PROXY_CONFIG_GET: 'PROXY_CONFIG_GET',
  PROXY_CONFIG_SET: 'PROXY_CONFIG_SET',
  PROXY_TEST: 'PROXY_TEST',
  ZAPPER_START: 'ZAPPER_START',
  ZAPPER_SAVE_RULE: 'ZAPPER_SAVE_RULE',
  ZAPPER_RULES_GET: 'ZAPPER_RULES_GET',
  ZAPPER_RULE_REMOVE: 'ZAPPER_RULE_REMOVE',
  ZAPPER_RULE_SET: 'ZAPPER_RULE_SET'
};

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadHandlers(options = {}) {
  const storage = options.storage || {};
  let capturedToken = null;
  const scriptingCalls = [];

  const sandbox = {
    MSG,
    URL,
    Number,
    Math,
    Date,
    Uint8Array,
    Map,
    Set,
    crypto: {
      getRandomValues: (buffer) => {
        for (let i = 0; i < buffer.length; i++) buffer[i] = i + 1;
        return buffer;
      }
    },
    encryptAuth: async () => ({ iv: 'iv', ciphertext: 'ct' }),
    getSubscriptions: async () => [],
    setSubscriptionEnabled: async () => ({ ok: true }),
    refreshSubscription: async () => ({ ok: true }),
    addSubscription: async () => ({ ok: true }),
    removeSubscription: async () => ({ ok: true }),
    validateConfig: cfg => cfg || {},
    updateDNRState: async () => {},
    syncDynamicRules: async () => {},
    syncWhitelistRules: async () => {},
    checkForUpdate: async () => ({ updateAvailable: false }),
    resetRequestLog: async () => {},
    getMergedLog: async () => [],
    runProxyTest: async () => ({ ok: true }),
    chrome: {
      storage: {
        local: {
          get: async (key) => {
            if (Array.isArray(key)) {
              const out = {};
              key.forEach(k => { out[k] = storage[k]; });
              return out;
            }
            if (typeof key === 'string') return { [key]: storage[key] };
            return {};
          },
          set: async (values) => Object.assign(storage, values)
        }
      },
      tabs: {
        get: async id => ({ id, url: 'https://example.com/page' }),
        query: async () => [{ id: 7, url: 'https://example.com/page' }],
        sendMessage: async () => {}
      },
      scripting: {
        executeScript: async details => {
          scriptingCalls.push(details);
          if (details.files) return [{}];
          if (details.func && details.args?.length === 1) {
            capturedToken = details.args[0];
            return [{}];
          }
          if (details.func && details.args?.length === 2) {
            const selector = details.args[0];
            if (selector === '.too-many') return [{ result: { ok: false, count: 1001 } }];
            if (selector === '.six') return [{ result: { ok: false, count: 6 } }];
            return [{ result: { ok: selector !== '.missing', count: selector === '.missing' ? 0 : 1 } }];
          }
          return [{}];
        }
      }
    },
    setTimeout: () => 123,
    clearTimeout: () => {},
    console
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(handlersJsCode, sandbox);
  return { sandbox, storage, scriptingCalls, getToken: () => capturedToken };
}

function createContentSandbox({ hostname = 'example.com', config = {}, whitelist = [], localCosmeticRules = [] } = {}) {
  const sandbox = {
    chrome: {
      runtime: {
        sendMessage: () => Promise.resolve(),
        onMessage: { addListener: () => {} }
      },
      storage: {
        local: {
          get: async () => ({
            config: {
              enabled: true,
              cosmetic: true,
              hideMerch: false,
              hideOffers: false,
              hideShorts: false,
              suppressWarnings: false,
              ...config
            },
            HIDE_SELECTORS: [],
            WARNING_SELECTORS: [],
            whitelist,
            subscriptionCosmeticRules: [],
            localCosmeticRules
          })
        },
        onChanged: { addListener: () => {} }
      }
    },
    CSSStyleSheet: class {
      replaceSync(content) { this.content = content; }
    },
    document: {
      documentElement: { appendChild: () => {} },
      querySelector: () => ({}),
      querySelectorAll: () => [],
      addEventListener: () => {},
      _adoptedStyleSheets: [],
      get adoptedStyleSheets() { return this._adoptedStyleSheets; },
      set adoptedStyleSheets(value) { this._adoptedStyleSheets = value; }
    },
    window: {
      location: { hostname },
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    location: { hostname },
    Node: { ELEMENT_NODE: 1 },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: cb => cb(),
    setTimeout: cb => cb(),
    console,
    __CHROMA_INTERNAL_TEST_STRICT__: true
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(contentJsCode, sandbox);
  return sandbox;
}

test('zapper selector generator', async (t) => {
  function createElement(tag, attrs = {}) {
    const el = {
      nodeType: 1,
      localName: tag.toLowerCase(),
      tagName: tag.toUpperCase(),
      id: attrs.id || '',
      classList: attrs.classList || [],
      parentElement: null,
      previousElementSibling: null,
      removeAttribute(name) {
        if (name === 'id') this.id = '';
      }
    };
    return el;
  }

  function loadZapperHarness(querySelectorAll) {
    const root = createElement('html');
    const sandbox = {
      __CHROMA_INTERNAL_TEST_STRICT__: true,
      Node: { ELEMENT_NODE: 1 },
      document: {
        documentElement: root,
        querySelectorAll
      },
      chrome: { runtime: { sendMessage: async () => ({ ok: true }) } },
      globalThis: null
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(zapperJsCode, sandbox);
    return sandbox.__CHROMA_ZAPPER_TEST__;
  }

  await t.test('prefers stable id', () => {
    const el = createElement('div', { id: 'adBanner' });
    const api = loadZapperHarness(selector => selector === '#adBanner' ? [el] : []);
    assert.strictEqual(api.generateSelector(el), '#adBanner');
  });

  await t.test('uses stable class selector', () => {
    const el = createElement('div', { classList: ['annoying-banner', 'x9f8e7d6c5'] });
    const api = loadZapperHarness(selector => selector === 'div.annoying-banner' ? [el] : []);
    assert.strictEqual(api.generateSelector(el), 'div.annoying-banner');
  });

  await t.test('returns match count for save confirmation', () => {
    const el = createElement('div', { classList: ['shared-ad'] });
    const other = createElement('div', { classList: ['shared-ad'] });
    const api = loadZapperHarness(selector => selector === 'div.shared-ad' ? [el, other] : []);
    assert.deepStrictEqual(plain(api.generateSelectorInfo(el)), {
      ok: true,
      selector: 'div.shared-ad',
      count: 2
    });
  });

  await t.test('falls back to nth-of-type chain', () => {
    const section = createElement('section');
    const sibling = createElement('p');
    const el = createElement('p', { id: 'targetless' });
    sibling.parentElement = section;
    el.parentElement = section;
    el.previousElementSibling = sibling;
    el.removeAttribute('id');
    const api = loadZapperHarness(selector => selector.includes('nth-of-type') ? [el] : []);
    assert.match(api.generateSelector(el), /nth-of-type/);
  });

  await t.test('rejects invalid and too-long selectors', () => {
    const el = createElement('div', { classList: ['target'] });
    const api = loadZapperHarness(selector => {
      if (selector === 'bad{') throw new Error('invalid');
      return [el];
    });
    assert.strictEqual(api.isValidSelector('bad{', el), false);
    assert.strictEqual(api.isValidSelector('a'.repeat(513), el), false);
  });
});

test('zapper background handlers', async (t) => {
  await t.test('token-gated save stores a local rule', async () => {
    const { sandbox, storage, getToken } = loadHandlers({ storage: { localCosmeticRules: [] } });
    const started = await sandbox.handleZapperStart({ tabId: 7 });

    assert.strictEqual(started.ok, true);
    assert.ok(getToken(), 'start should create an injected token');

    const saved = await sandbox.handleZapperSaveRule(
      { action: 'save', token: getToken(), domain: 'example.com', selector: '.annoying' },
      { tab: { id: 7, url: 'https://example.com/page' } }
    );

    assert.strictEqual(saved.ok, true);
    assert.strictEqual(storage.localCosmeticRules.length, 1);
    assert.deepStrictEqual(plain(storage.localCosmeticRules[0]), {
      id: storage.localCosmeticRules[0].id,
      domain: 'example.com',
      selector: '.annoying',
      enabled: true,
      createdAt: storage.localCosmeticRules[0].createdAt,
      source: 'zapper'
    });
  });

  await t.test('invalid token is rejected', async () => {
    const { sandbox, storage } = loadHandlers({ storage: { localCosmeticRules: [] } });
    await sandbox.handleZapperStart({ tabId: 7 });

    const saved = await sandbox.handleZapperSaveRule(
      { action: 'save', token: 'wrong', domain: 'example.com', selector: '.annoying' },
      { tab: { id: 7, url: 'https://example.com/page' } }
    );

    assert.strictEqual(saved.ok, false);
    assert.strictEqual(storage.localCosmeticRules.length, 0);
  });

  await t.test('invalid selector is rejected', async () => {
    const { sandbox, storage, getToken } = loadHandlers({ storage: { localCosmeticRules: [] } });
    await sandbox.handleZapperStart({ tabId: 7 });

    const saved = await sandbox.handleZapperSaveRule(
      { action: 'save', token: getToken(), domain: 'example.com', selector: 'bad{' },
      { tab: { id: 7, url: 'https://example.com/page' } }
    );

    assert.strictEqual(saved.ok, false);
    assert.strictEqual(storage.localCosmeticRules.length, 0);
  });

  await t.test('selector matching more than five elements is rejected', async () => {
    const { sandbox, storage, getToken } = loadHandlers({ storage: { localCosmeticRules: [] } });
    await sandbox.handleZapperStart({ tabId: 7 });

    const saved = await sandbox.handleZapperSaveRule(
      { action: 'save', token: getToken(), domain: 'example.com', selector: '.six' },
      { tab: { id: 7, url: 'https://example.com/page' } }
    );

    assert.strictEqual(saved.ok, false);
    assert.strictEqual(storage.localCosmeticRules.length, 0);
  });

  await t.test('disable and delete update local rules', async () => {
    const rule = {
      id: 'zapper_1',
      domain: 'example.com',
      selector: '.annoying',
      enabled: true,
      createdAt: 1,
      source: 'zapper'
    };
    const { sandbox, storage } = loadHandlers({ storage: { localCosmeticRules: [rule] } });

    await sandbox.handleZapperRuleSet({ id: 'zapper_1', enabled: false });
    assert.strictEqual(storage.localCosmeticRules[0].enabled, false);

    await sandbox.handleZapperRuleRemove({ id: 'zapper_1' });
    assert.deepStrictEqual(storage.localCosmeticRules, []);
  });
});

test('content local zapper rules', async (t) => {
  const rule = {
    id: 'zapper_1',
    domain: 'example.com',
    selector: '.annoying',
    enabled: true,
    createdAt: 1,
    source: 'zapper'
  };

  await t.test('applies only on matching domain', async () => {
    const matching = createContentSandbox({ hostname: 'www.example.com', localCosmeticRules: [rule] });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(matching.document.adoptedStyleSheets.some(sheet => sheet.content.includes('.annoying')));

    const other = createContentSandbox({ hostname: 'other.test', localCosmeticRules: [rule] });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(other.document.adoptedStyleSheets.some(sheet => sheet.content.includes('.annoying')), false);
  });

  await t.test('whitelist skips local cosmetic rules', async () => {
    const sandbox = createContentSandbox({
      hostname: 'example.com',
      whitelist: ['example.com'],
      localCosmeticRules: [rule]
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(sandbox.document.adoptedStyleSheets.length, 0);
  });

  await t.test('disabled cosmetic mode skips local cosmetic rules', async () => {
    const sandbox = createContentSandbox({
      hostname: 'example.com',
      config: { cosmetic: false },
      localCosmeticRules: [rule]
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(sandbox.document.adoptedStyleSheets.some(sheet => sheet.content.includes('.annoying')), false);
  });
});
