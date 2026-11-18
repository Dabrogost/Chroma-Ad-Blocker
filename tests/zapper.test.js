const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function handlerModuleForVm(file) {
  let source = fs.readFileSync(
    path.join(__dirname, '..', 'extension', 'background', 'handlers', file),
    'utf8'
  );
  const exportNames = [...source.matchAll(/^export\s+(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/gm)]
    .map(match => match[1]);
  source = source
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\r?\n/gm, '')
    .replace(/^export\s+/gm, '');
  return `(() => {\n${source}\nObject.assign(globalThis, { ${exportNames.join(', ')} });\n})();`;
}

const handlersJsCode = ['domainValidation.js', 'zapperHandlers.js']
  .map(handlerModuleForVm)
  .join('\n');

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
  UPDATE_PACKAGE_INSPECT: 'UPDATE_PACKAGE_INSPECT',
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
  const sessionStorage = options.sessionStorage !== undefined ? options.sessionStorage : {};
  const storageDelayMs = options.storageDelayMs || 0;
  let capturedToken = null;
  const scriptingCalls = [];
  const tick = () => (storageDelayMs > 0 ? new Promise(resolve => setTimeout(resolve, storageDelayMs)) : Promise.resolve());

  const makeStorageArea = (backing) => ({
    get: async (key) => {
      await tick();
      if (Array.isArray(key)) {
        const out = {};
        key.forEach(k => {
          out[k] = backing[k] === undefined ? undefined : plain(backing[k]);
        });
        return out;
      }
      if (typeof key === 'string') {
        return { [key]: backing[key] === undefined ? undefined : plain(backing[key]) };
      }
      return {};
    },
    set: async (values) => {
      await tick();
      for (const [k, v] of Object.entries(values)) {
        backing[k] = v === undefined ? undefined : plain(v);
      }
    }
  });

  const chromeStorage = {
    local: makeStorageArea(storage)
  };
  if (sessionStorage !== null) {
    chromeStorage.session = makeStorageArea(sessionStorage);
  }

  const sandbox = {
    MSG,
    URL,
    Number,
    Math,
    Date: options.Date || Date,
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
    syncActionBadge: async () => ({ ok: true }),
    syncDynamicRules: async () => {},
    syncWhitelistRules: async () => {},
    syncBrowserPrivacyHardening: async () => ({}),
    syncGeolocationProtection: async () => ({}),
    checkForUpdate: async () => ({ updateAvailable: false }),
    inspectLatestUpdatePackage: async () => ({ ok: true, updateAvailable: false }),
    resetRequestLog: async () => {},
    getMergedLog: async () => [],
    runProxyTest: async () => ({ ok: true }),
    chrome: {
      storage: chromeStorage,
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

  await t.test('recoverable validation failure preserves the active zapper session token for retry', async () => {
    const { sandbox, storage, getToken } = loadHandlers({ storage: { localCosmeticRules: [] } });
    await sandbox.handleZapperStart({ tabId: 7 });
    const token = getToken();
    const sender = { tab: { id: 7, url: 'https://example.com/page' } };

    const badSelector = await sandbox.handleZapperSaveRule(
      { action: 'save', token, domain: 'example.com', selector: 'bad{' },
      sender
    );
    assert.strictEqual(badSelector.ok, false);

    const tooBroad = await sandbox.handleZapperSaveRule(
      { action: 'save', token, domain: 'example.com', selector: '.six' },
      sender
    );
    assert.strictEqual(tooBroad.ok, false);

    const badDomain = await sandbox.handleZapperSaveRule(
      { action: 'save', token, domain: 'other.test', selector: '.annoying' },
      sender
    );
    assert.strictEqual(badDomain.ok, false);

    const retried = await sandbox.handleZapperSaveRule(
      { action: 'save', token, domain: 'example.com', selector: '.annoying' },
      sender
    );
    assert.strictEqual(retried.ok, true);
    assert.strictEqual(storage.localCosmeticRules.length, 1);

    const reusedAfterSuccess = await sandbox.handleZapperSaveRule(
      { action: 'save', token, domain: 'example.com', selector: '.annoying' },
      sender
    );
    assert.strictEqual(reusedAfterSuccess.ok, false);
    assert.strictEqual(reusedAfterSuccess.error, 'Invalid zapper session');
    assert.strictEqual(storage.localCosmeticRules.length, 1);
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

  await t.test('active zapper session survives service worker restart via session storage and still enforces TTL', async () => {
    const sharedLocal = { localCosmeticRules: [] };
    const sharedSession = {};
    let fakeNow = 10_000;
    const FakeDate = Object.assign(function (...args) { return new Date(...args); }, {
      now: () => fakeNow
    });

    const worker1 = loadHandlers({ storage: sharedLocal, sessionStorage: sharedSession, Date: FakeDate });
    const started = await worker1.sandbox.handleZapperStart({ tabId: 7 });
    assert.strictEqual(started.ok, true);
    const token = worker1.getToken();
    assert.ok(token);

    // Simulate MV3 service worker termination and recreation within the 2-minute TTL.
    fakeNow += 45_000;
    const worker2 = loadHandlers({ storage: sharedLocal, sessionStorage: sharedSession, Date: FakeDate });
    const saved = await worker2.sandbox.handleZapperSaveRule(
      { action: 'save', token, domain: 'example.com', selector: '.annoying' },
      { tab: { id: 7, url: 'https://example.com/page' } }
    );
    assert.strictEqual(saved.ok, true);
    assert.strictEqual(sharedLocal.localCosmeticRules.length, 1);

    // Expired sessions across a restart must still be rejected without relying on in-memory timers.
    const started2 = await worker2.sandbox.handleZapperStart({ tabId: 7 });
    assert.strictEqual(started2.ok, true);
    const token2 = worker2.getToken();
    fakeNow += 2 * 60 * 1000 + 1;
    const worker3 = loadHandlers({ storage: sharedLocal, sessionStorage: sharedSession, Date: FakeDate });
    const expired = await worker3.sandbox.handleZapperSaveRule(
      { action: 'save', token: token2, domain: 'example.com', selector: '.annoying2' },
      { tab: { id: 7, url: 'https://example.com/page' } }
    );
    assert.strictEqual(expired.ok, false);
    assert.strictEqual(expired.error, 'Invalid zapper session');
    assert.strictEqual(sharedLocal.localCosmeticRules.length, 1);
  });

  await t.test('concurrent rule mutations serialize cleanly and reject duplicate save tokens', async () => {
    const storage = {
      localCosmeticRules: [
        { id: 'zapper_1', domain: 'example.com', selector: '.a', enabled: true, createdAt: 1, source: 'zapper' },
        { id: 'zapper_2', domain: 'example.com', selector: '.b', enabled: true, createdAt: 2, source: 'zapper' },
        { id: 'zapper_3', domain: 'example.com', selector: '.c', enabled: true, createdAt: 3, source: 'zapper' }
      ]
    };
    const { sandbox, getToken } = loadHandlers({ storage, storageDelayMs: 5 });
    await sandbox.handleZapperStart({ tabId: 7 });
    const token = getToken();
    const sender = { tab: { id: 7, url: 'https://example.com/page' } };

    const [toggle1, toggle2, removed3, saveA, saveB] = await Promise.all([
      sandbox.handleZapperRuleSet({ id: 'zapper_1', enabled: false }),
      sandbox.handleZapperRuleSet({ id: 'zapper_2', enabled: false }),
      sandbox.handleZapperRuleRemove({ id: 'zapper_3' }),
      sandbox.handleZapperSaveRule({ action: 'save', token, domain: 'example.com', selector: '.d' }, sender),
      sandbox.handleZapperSaveRule({ action: 'save', token, domain: 'example.com', selector: '.d' }, sender)
    ]);

    assert.strictEqual(toggle1.ok, true);
    assert.strictEqual(toggle2.ok, true);
    assert.strictEqual(removed3.ok, true);
    assert.strictEqual([saveA.ok, saveB.ok].filter(Boolean).length, 1);
    assert.strictEqual(storage.localCosmeticRules.find(r => r.id === 'zapper_1')?.enabled, false);
    assert.strictEqual(storage.localCosmeticRules.find(r => r.id === 'zapper_2')?.enabled, false);
    assert.strictEqual(storage.localCosmeticRules.find(r => r.id === 'zapper_3'), undefined);
    assert.strictEqual(storage.localCosmeticRules.filter(r => r.selector === '.d').length, 1);
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

test('re-injecting content zapper cleans up prior session overlays, listeners, and stale tokens', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="ad-box">Ad</div></body></html>', {
    url: 'https://example.com/article'
  });
  const { window } = dom;
  const { document } = window;
  const sentMessages = [];

  const sandbox = vm.createContext({
    window,
    document,
    Node: window.Node,
    Element: window.Element,
    CSS: { escape: value => String(value).replace(/([^\w-])/g, '\\$1') },
    chrome: {
      runtime: {
        sendMessage: async (msg) => {
          sentMessages.push(msg);
          if (msg?.type === 'ZAPPER_SAVE_RULE') {
            return msg.token === 'token-2'
              ? { ok: true }
              : { ok: false, error: 'Invalid zapper session' };
          }
          return { ok: true };
        }
      }
    },
    console,
    Map,
    Set
  });
  sandbox.globalThis = sandbox;

  // Simulate two ZAPPER_START executions on the same tab without clearing first.
  vm.runInContext(zapperJsCode, sandbox);
  sandbox.__CHROMA_START_ZAPPER__('token-1');
  assert.strictEqual(document.querySelectorAll('[data-chroma-zapper]').length, 2);

  vm.runInContext(zapperJsCode, sandbox);
  sandbox.__CHROMA_START_ZAPPER__('token-2');
  assert.strictEqual(
    document.querySelectorAll('[data-chroma-zapper]').length,
    2,
    'expected prior overlay nodes to be removed on re-injection'
  );

  // Click the target element -> save -> confirmSave; only active token-2 should fire.
  const target = document.getElementById('ad-box');
  target.getBoundingClientRect = () => ({ left: 10, top: 10, width: 100, height: 40 });
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));

  const saveBtn = document.querySelector('[data-chroma-zapper-menu] button[data-action="save"]');
  assert.ok(saveBtn, 'expected zapper action menu to open');
  saveBtn.click();

  const confirmBtn = document.querySelector('[data-chroma-zapper-menu] button[data-action="confirmSave"]');
  assert.ok(confirmBtn, 'expected save confirmation button to open');
  confirmBtn.click();

  await new Promise(resolve => setTimeout(resolve, 10));

  const saveMessages = sentMessages.filter(m => m?.type === 'ZAPPER_SAVE_RULE');
  assert.strictEqual(saveMessages.length, 1);
  assert.strictEqual(saveMessages[0].token, 'token-2');
  assert.strictEqual(target.style.getPropertyValue('display'), 'none');
  assert.strictEqual(document.querySelectorAll('[data-chroma-zapper]').length, 0);
});

test('failed zapper save removes confirmation menu and unlocks hover selection for retry', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="ad-box">Ad</div><div id="retry-box">Retry</div></body></html>', {
    url: 'https://example.com/article'
  });
  const { window } = dom;
  const { document } = window;
  let shouldSucceed = false;

  const sandbox = vm.createContext({
    window,
    document,
    Node: window.Node,
    Element: window.Element,
    CSS: { escape: value => String(value).replace(/([^\w-])/g, '\\$1') },
    chrome: {
      runtime: {
        sendMessage: async (msg) => {
          if (msg?.type === 'ZAPPER_SAVE_RULE' && msg.action === 'save') {
            return shouldSucceed
              ? { ok: true }
              : { ok: false, error: 'Could not validate selector on this tab' };
          }
          return { ok: true };
        }
      }
    },
    console,
    Map,
    Set
  });
  sandbox.globalThis = sandbox;
  vm.runInContext(zapperJsCode, sandbox);

  const firstTarget = document.getElementById('ad-box');
  const secondTarget = document.getElementById('retry-box');
  firstTarget.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 40 });
  secondTarget.getBoundingClientRect = () => ({ left: 50, top: 80, width: 120, height: 30 });

  sandbox.__CHROMA_START_ZAPPER__('token-retry');
  firstTarget.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 15, clientY: 25 }));
  document.querySelector('[data-chroma-zapper-menu] button[data-action="save"]').click();
  document.querySelector('[data-chroma-zapper-menu] button[data-action="confirmSave"]').click();
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.strictEqual(document.querySelector('[data-chroma-zapper-menu]'), null);
  const [outlineEl, tooltipEl] = document.querySelectorAll('[data-chroma-zapper="true"]');
  assert.strictEqual(tooltipEl.textContent, 'Could not validate selector on this tab');

  secondTarget.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 60, clientY: 90 }));
  assert.strictEqual(outlineEl.style.left, '50px');
  assert.strictEqual(outlineEl.style.top, '80px');

  shouldSucceed = true;
  secondTarget.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 60, clientY: 90 }));
  document.querySelector('[data-chroma-zapper-menu] button[data-action="save"]').click();
  document.querySelector('[data-chroma-zapper-menu] button[data-action="confirmSave"]').click();
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.strictEqual(secondTarget.style.getPropertyValue('display'), 'none');
  assert.strictEqual(document.querySelectorAll('[data-chroma-zapper]').length, 0);
});

test('Bug 12 zapper and zapperHandlers alignment regressions', async (t) => {
  await t.test('rejects invalid action, malformed sender URL, and deduplicates existing rules cleanly', async () => {
    const existingRule = {
      id: 'zapper_old',
      domain: 'example.com',
      selector: '.annoying',
      enabled: false,
      createdAt: 1,
      source: 'zapper'
    };
    const { sandbox, storage, getToken } = loadHandlers({
      storage: { localCosmeticRules: [existingRule] }
    });
    await sandbox.handleZapperStart({ tabId: 7 });
    const token = getToken();

    const badAction = await sandbox.handleZapperSaveRule(
      { action: 'bogus', token, domain: 'example.com', selector: '.annoying' },
      { tab: { id: 7, url: 'https://example.com/page' } }
    );
    assert.strictEqual(badAction.ok, false);
    assert.match(badAction.error, /Invalid zapper action/);

    const badSenderUrl = await sandbox.handleZapperSaveRule(
      { action: 'save', token, domain: 'example.com', selector: '.annoying' },
      { tab: { id: 7, url: 'not-a-valid-url' } }
    );
    assert.strictEqual(badSenderUrl.ok, false);
    assert.strictEqual(badSenderUrl.error, 'Invalid domain');

    const trailingDot = await sandbox.handleZapperSaveRule(
      { action: 'save', token, domain: 'example.com', selector: '.annoying' },
      { tab: { id: 7, url: 'https://example.com./page' } }
    );
    assert.strictEqual(trailingDot.ok, true);
    assert.strictEqual(storage.localCosmeticRules.length, 1);
    assert.strictEqual(storage.localCosmeticRules[0].enabled, true);
  });

  await t.test('zapper ignores duplicate confirmSave clicks, stale saves after Escape, and cleans up on expired session', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="ad-box">Ad</div></body></html>', {
      url: 'https://example.com/article'
    });
    const { window } = dom;
    const { document } = window;
    let resolveSave;
    const saveCalls = [];

    const sandbox = vm.createContext({
      __CHROMA_INTERNAL_TEST_STRICT__: true,
      window,
      document,
      Node: window.Node,
      Element: window.Element,
      CSS: { escape: value => String(value).replace(/([^\w-])/g, '\\$1') },
      chrome: {
        runtime: {
          sendMessage: async (msg) => {
            if (msg?.type === 'ZAPPER_SAVE_RULE' && msg.action === 'save') {
              saveCalls.push(msg);
              return new Promise(resolve => { resolveSave = resolve; });
            }
            return { ok: true };
          }
        }
      },
      console,
      Map,
      Set
    });
    sandbox.globalThis = sandbox;
    vm.runInContext(zapperJsCode, sandbox);

    const api = sandbox.__CHROMA_ZAPPER_TEST__;
    const target = document.getElementById('ad-box');
    target.getBoundingClientRect = () => ({ left: 10, top: 10, width: 100, height: 40 });
    assert.strictEqual(api.isValidSelector('[data-x="javascript:alert(1)"]', target), false);

    // 1. In-flight save ignores double clicks and ignores late success after Esc cancel.
    sandbox.__CHROMA_START_ZAPPER__('token-inflight');
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 15, clientY: 15 }));
    document.querySelector('[data-chroma-zapper-menu] button[data-action="save"]').click();
    const confirmBtn = document.querySelector('[data-chroma-zapper-menu] button[data-action="confirmSave"]');
    confirmBtn.click();
    confirmBtn.click();
    assert.strictEqual(saveCalls.length, 1, 'duplicate confirmSave while in flight must be ignored');

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    resolveSave({ ok: true });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.notStrictEqual(target.style.getPropertyValue('display'), 'none', 'canceled save must not hide element');

    // 2. Expired session error cleans up zapper overlay cleanly.
    sandbox.__CHROMA_START_ZAPPER__('token-expired');
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 15, clientY: 15 }));
    document.querySelector('[data-chroma-zapper-menu] button[data-action="save"]').click();
    document.querySelector('[data-chroma-zapper-menu] button[data-action="confirmSave"]').click();
    resolveSave({ ok: false, error: 'Invalid zapper session' });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.strictEqual(document.querySelectorAll('[data-chroma-zapper]').length, 0);
  });
});
