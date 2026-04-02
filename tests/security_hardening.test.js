const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backgroundJsCodeRaw = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
const backgroundJsCode = backgroundJsCodeRaw
  .replace('const DEBUG = false;', 'var DEBUG = true;')
  .replace("import { getDefaultDynamicRules } from './defaultDynamicRules.js';", "var getDefaultDynamicRules = () => [];")
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/subscriptions\/manager\.js['"];?/s, `
    var initSubscriptions      = async () => {};
    var ensureAlarm             = async () => {};
    var refreshAllStale         = async () => {};
    var refreshSubscription     = async () => ({ ok: true });
    var getSubscriptions        = async () => [];
    var setSubscriptionEnabled  = async () => ({ ok: true });
    var addSubscription         = async () => ({ ok: true });
    var removeSubscription      = async () => ({ ok: true });
  `)
  .replace("import { initScriptletEngine } from './scriptlets/engine.js';", "var initScriptletEngine = async () => {};");

// ─── SECURITY HARDENING - BACKGROUND.JS ─────
test('Security Hardening - background.js', async (t) => {
  const sandbox = {};
  let messageHandler = null;
  let tabsRemoved = [];
  let dynamicRulesAdded = [];
  sandbox._sessionStore = {
    sessionTokens: {},
    tokenRetrievalLocked: {}
  };

  const chromeMock = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { 
        addListener: (handler) => { messageHandler = handler; } 
      }
    },
    storage: {
      local: {
        get: async (keys) => {
          if (Array.isArray(keys)) {
             const res = {};
             if (keys.includes('dynamicRules')) res.dynamicRules = [];
             return res;
          }
          if (keys === 'dynamicRules') return { dynamicRules: [] };
          return { dynamicRules: [] };
        },
        set: () => Promise.resolve()
      },
      session: {
        get: async (keys) => {
          const res = {};
          const store = sandbox._sessionStore || {};
          if (Array.isArray(keys)) keys.forEach(k => res[k] = store[k] || {});
          else res[keys] = store[keys] || {};
          return res;
        },
        set: async (val) => { 
          if (!sandbox._sessionStore) sandbox._sessionStore = {};
          Object.assign(sandbox._sessionStore, val);
          return Promise.resolve();
        }
      },
      onChanged: { addListener: () => {} }
    },
    declarativeNetRequest: {
      getDynamicRules: () => Promise.resolve([]),
      updateDynamicRules: async (args) => {
        if (args.addRules) dynamicRulesAdded.push(...args.addRules);
        return Promise.resolve();
      },
      onRuleMatchedDebug: { addListener: () => {} }
    },
    tabs: {
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(),
      remove: async (id) => {
        tabsRemoved.push(id);
        return Promise.resolve();
      },
      onCreated: { addListener: () => {} },
      onRemoved: { 
        addListener: (fn) => { sandbox._onRemovedListener = fn; } 
      }
    },
    alarms: {
      create: () => {},
      get: () => Promise.resolve(null),
      onAlarm: { addListener: () => {} }
    },
  };
  sandbox.chrome = chromeMock;
  sandbox.crypto = {
    getRandomValues: (buffer) => {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] = Math.floor(Math.random() * 256);
      }
      return buffer;
    }
  };
  sandbox.console = {
    log: () => {},
    error: () => {},
    warn: () => {}
  };
  sandbox.setInterval = () => {};
  sandbox.setTimeout = setTimeout;
  sandbox.clearInterval = clearInterval;
  sandbox.clearTimeout = clearTimeout;
  sandbox.initScriptletEngine = async () => {};
  sandbox.Promise = Promise;
  sandbox.Object = Object;
  sandbox.Array = Array;
  sandbox.Error = Error;
  sandbox.Date = Date;
  sandbox.Map = Map;
  sandbox.Set = Set;
  sandbox.__CHROMA_INTERNAL_TEST_STRICT__ = true;
  chromeMock.tabs.get = (id) => Promise.resolve({ id, url: 'https://www.youtube.com/' });
  sandbox.globalThis = sandbox;
  sandbox.fetch = async () => ({ ok: false });
  sandbox.DEBUG = true;
  sandbox.__CHROMA_INTERNAL_TEST_STRICT__ = true;

  vm.createContext(sandbox);
  vm.runInContext(backgroundJsCode, sandbox);

  await t.test('GET_TOKEN generates and stores a token', async () => {
    const sender = { tab: { id: 123 }, url: 'https://www.youtube.com/watch?v=123' };
    const msg = { type: 'GET_TOKEN' };
    
    let response = null;
    const sendResponse = (res) => { response = res; };

    await messageHandler(msg, sender, sendResponse);

    assert.ok(response && response.token, 'Should return a token');
    // Security Token Length: Hex-encoded 16-byte entropy.
    assert.strictEqual(response.token.length, 32, 'Token should be 32 hex chars (16 bytes)');
  });

  await t.test('GET_TOKEN is locked after first retrieval for a session (documentId)', async () => {
    const sender = { tab: { id: 456 }, documentId: 'doc1', url: 'https://www.youtube.com/watch?v=456' };
    const msg = { type: 'GET_TOKEN' };
    
    let response1 = null;
    await messageHandler(msg, sender, (res) => { response1 = res; });
    assert.ok(response1 && response1.token, 'Should return a token for first request');

    let response2 = null;
    await messageHandler(msg, sender, (res) => { response2 = res; });
    assert.strictEqual(response2.error, 'Locked', 'Subsequent GET_TOKEN for same documentId should be locked');
  });

  await t.test('GET_TOKEN is NOT locked after page refresh (new documentId)', async () => {
    const msg = { type: 'GET_TOKEN' };
    const tabId = 111;

    // First load
    const sender1 = { tab: { id: tabId }, documentId: 'doc_early', url: 'https://www.youtube.com' };
    let res1 = null;
    await messageHandler(msg, sender1, (r) => { res1 = r; });
    assert.ok(res1 && res1.token, 'Should get token for first document instance');

    // Refresh (same tabId, new documentId)
    const sender2 = { tab: { id: tabId }, documentId: 'doc_late', url: 'https://www.youtube.com' };
    let res2 = null;
    await messageHandler(msg, sender2, (r) => { res2 = r; });
    assert.ok(res2 && res2.token, 'Should get a NEW token after refresh');
    assert.notStrictEqual(res1.token, res2.token, 'Tokens should be unique per session');
  });

  await t.test('GET_TOKEN supports multiple frames simultaneously', async () => {
    const msg = { type: 'GET_TOKEN' };
    const tabId = 222;

    const mainFrame = { tab: { id: tabId }, documentId: 'main', frameId: 0, url: 'https://www.youtube.com' };
    const subFrame = { tab: { id: tabId }, documentId: 'sub', frameId: 123, url: 'https://www.youtube.com' };

    let resMain = null;
    await messageHandler(msg, mainFrame, (r) => { resMain = r; });
    
    let resSub = null;
    await messageHandler(msg, subFrame, (r) => { resSub = r; });

    assert.ok(resMain && resMain.token, 'Main frame should get token');
    assert.ok(resSub && resSub.token, 'Sub-frame should get its own token');
  });


  await t.test('onRemoved clears all documents for a tabId', async () => {
    const tabId = 333;
    const msg = { type: 'GET_TOKEN' };

    await messageHandler(msg, { tab: { id: tabId }, documentId: 'doc_alpha', url: 'https://y.com' }, () => {});
    await messageHandler(msg, { tab: { id: tabId }, documentId: 'doc_beta', url: 'https://y.com' }, () => {});

    assert.ok(sandbox._sessionStore.sessionTokens['doc_alpha'], 'Alpha should exist');
    assert.ok(sandbox._sessionStore.sessionTokens['doc_beta'], 'Beta should exist');
    assert.ok(sandbox._sessionStore.tokenRetrievalLocked['doc_alpha'], 'Alpha lock should exist');

    // Trigger onRemoved
    if (sandbox._onRemovedListener) {
      await sandbox._onRemovedListener(tabId);
    } else {
      assert.fail('onRemoved listener not captured');
    }

    assert.ok(!sandbox._sessionStore.sessionTokens['doc_alpha'], 'Alpha should be cleared');
    assert.ok(!sandbox._sessionStore.sessionTokens['doc_beta'], 'Beta should be cleared');
    assert.ok(!sandbox._sessionStore.tokenRetrievalLocked['doc_alpha'], 'Alpha lock should be cleared');
  });
});
