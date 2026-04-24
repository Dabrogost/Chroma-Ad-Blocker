const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backgroundJsCodeRaw = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
const backgroundJsCode = backgroundJsCodeRaw
  .replace('const DEBUG = false;', 'var DEBUG = true;')
  .replace("import { getDefaultDynamicRules } from './defaultDynamicRules.js';", "var getDefaultDynamicRules = globalThis.getDefaultDynamicRules;")
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/subscriptions\/manager\.js['"];?/s, `
    var initSubscriptions   = globalThis._mockInitSubscriptions;
    var ensureAlarm          = globalThis._mockEnsureAlarm;
    var refreshAllStale      = globalThis._mockRefreshAllStale;
    var refreshSubscription  = globalThis._mockRefreshSubscription;
    var getSubscriptions     = globalThis._mockGetSubscriptions;
    var setSubscriptionEnabled = globalThis._mockSetSubscriptionEnabled;
    var addSubscription      = globalThis._mockAddSubscription;
    var removeSubscription   = globalThis._mockRemoveSubscription;
  `)
  .replace("import { initScriptletEngine } from './scriptlets/engine.js';", "var initScriptletEngine = globalThis._mockInitScriptletEngine;")
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/crypto\.js['"];?/s, "var decryptAuth = globalThis._mockDecryptAuth; var encryptAuth = globalThis._mockEncryptAuth;")
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/messageTypes\.js['"];?/s, "var MSG = {};")
  .replace(/import\s*\*\s*as\s+router\s+from\s*['"]\.\/messageRouter\.js['"];?/s, "var router = { registerHandler: () => {}, markSensitive: () => {}, attachListener: () => {} };")
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/handlers\.js['"];?/s, "var registerAll = () => {};")
  .replace(/import\s*['"]\.\/proxy\.js['"];?/s, "")
  .replace(/^export\s+/gm, "");

const defaultDynamicRulesCodeRaw = fs.readFileSync(path.join(__dirname, '..', 'extension', 'defaultDynamicRules.js'), 'utf8');
const defaultDynamicRulesCode = defaultDynamicRulesCodeRaw.replace('export function getDefaultDynamicRules', 'globalThis.getDefaultDynamicRules = function');

// ─── GETDEFAULTDYNAMICRULES ─────
test('getDefaultDynamicRules', async (t) => {
  const sandbox = {};

  const chromeMock = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: () => {} }
    },
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve()
      },
      session: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve()
      },
      onChanged: { addListener: () => {} }
    },
    declarativeNetRequest: {
      getDynamicRules: () => Promise.resolve([]),
      updateDynamicRules: () => Promise.resolve(),
      onRuleMatchedDebug: { addListener: () => {} }
    },
    tabs: {
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(),
      onCreated: { addListener: () => {} },
      onRemoved: { addListener: () => {} }
    },
    alarms: {
      create: () => {},
      get: () => Promise.resolve(null),
      onAlarm: { addListener: () => {} }
    },
    proxy: {
      settings: {
        set: () => Promise.resolve(),
        get: () => Promise.resolve({})
      }
    },
    webRequest: {
      onAuthRequired: { addListener: () => {} }
    }
  };
  sandbox._mockInitSubscriptions    = async () => {};
  sandbox._mockEnsureAlarm          = async () => {};
  sandbox._mockRefreshAllStale      = async () => {};
  sandbox._mockRefreshSubscription  = async () => ({ ok: true });
  sandbox._mockGetSubscriptions     = async () => [];
  sandbox._mockSetSubscriptionEnabled = async () => ({ ok: true });
  sandbox._mockAddSubscription      = async () => ({ ok: true });
  sandbox._mockRemoveSubscription   = async () => ({ ok: true });
  sandbox._mockInitScriptletEngine  = async () => {};
  sandbox._mockDecryptAuth          = async () => ({ username: 'u', password: 'p' });
  sandbox._mockEncryptAuth          = async () => ({ iv: 'iv', ciphertext: 'ct' });

  sandbox.chrome = chromeMock;
  sandbox.console = console;
  sandbox.setInterval = () => {};
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;

  sandbox.globalThis = sandbox;
  sandbox.fetch = async () => ({ ok: false });
 
  vm.createContext(sandbox);
  vm.runInContext(defaultDynamicRulesCode, sandbox);
  vm.runInContext(backgroundJsCode, sandbox);

  await t.test('returns an array of rules', () => {
    const rules = sandbox.getDefaultDynamicRules();
    assert.ok(Array.isArray(rules), 'Should return an array');
    assert.ok(rules.length > 0, 'Should not be empty');
  });

  await t.test('rules have correct structure', () => {
    const rules = sandbox.getDefaultDynamicRules();
    for (const rule of rules) {
      assert.ok(rule.id, 'Rule must have an id');
      assert.strictEqual(typeof rule.id, 'number', 'Rule id must be a number');
      assert.strictEqual(rule.priority, 4, 'Rule priority should be 4');

      // Match the actual code: action.type is 'allow' for these rules
      assert.strictEqual(rule.action.type, 'allow', 'Rule action should be allow');

      assert.ok(rule.condition, 'Rule must have a condition');
      assert.ok(rule.condition.urlFilter, 'Rule condition must have urlFilter');
      assert.ok(Array.isArray(rule.condition.resourceTypes), 'Rule condition must have resourceTypes array');
    }
  });

  await t.test('rules have unique ids', () => {
    const rules = sandbox.getDefaultDynamicRules();
    const ids = rules.map(r => r.id);
    const uniqueIds = new Set(ids);
    assert.strictEqual(ids.length, uniqueIds.size, 'Rule IDs must be unique');
  });
});

// ─── SYNCDYNAMICRULES SUCCESSFUL SYNCING ─────
test('syncDynamicRules successful syncing', async (t) => {
  const sandbox = {};
  let updateDynamicRulesArgs = null;
  let getDynamicRulesCalled = false;

  const mockExistingRules = [{ id: 1001 }, { id: 1002 }];
  const mockStoredRules = [{ id: 999, action: { type: 'block' } }];

  const chromeMock = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: () => {} }
    },
    storage: {
      local: {
        get: async (key) => {
          if (key === 'dynamicRules') {
            return { dynamicRules: sandbox.mockStorageRules };
          }
          return {};
        },
        set: () => Promise.resolve()
      },
      session: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve()
      },
      onChanged: { addListener: () => {} }
    },
    declarativeNetRequest: {
      getDynamicRules: async () => {
        getDynamicRulesCalled = true;
        return mockExistingRules;
      },
      updateDynamicRules: async (args) => {
        updateDynamicRulesArgs = args;
        return Promise.resolve();
      },
      onRuleMatchedDebug: { addListener: () => {} }
    },
    tabs: {
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(),
      onCreated: { addListener: () => {} },
      onRemoved: { addListener: () => {} }
    },
    alarms: {
      create: () => {},
      get: () => Promise.resolve(null),
      onAlarm: { addListener: () => {} }
    },
    proxy: {
      settings: {
        set: () => Promise.resolve(),
        get: () => Promise.resolve({})
      }
    },
    webRequest: {
      onAuthRequired: { addListener: () => {} }
    }
  };

  sandbox._mockInitSubscriptions    = async () => {};
  sandbox._mockEnsureAlarm          = async () => {};
  sandbox._mockRefreshAllStale      = async () => {};
  sandbox._mockRefreshSubscription  = async () => ({ ok: true });
  sandbox._mockGetSubscriptions     = async () => [];
  sandbox._mockSetSubscriptionEnabled = async () => ({ ok: true });
  sandbox._mockAddSubscription      = async () => ({ ok: true });
  sandbox._mockRemoveSubscription   = async () => ({ ok: true });
  sandbox._mockInitScriptletEngine  = async () => {};
  sandbox._mockDecryptAuth          = async () => ({ username: 'u', password: 'p' });
  sandbox._mockEncryptAuth          = async () => ({ iv: 'iv', ciphertext: 'ct' });

  sandbox.chrome = chromeMock;
  sandbox.console = {
    log: () => {},
    error: () => {},
    warn: () => {}
  };
  sandbox.setInterval = () => {};
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.globalThis = sandbox;
  sandbox.fetch = async () => ({ ok: false });

  vm.createContext(sandbox);
  vm.runInContext(defaultDynamicRulesCode, sandbox);
  vm.runInContext(backgroundJsCode, sandbox);

  await t.test('uses stored rules and removes existing ones', async () => {
    sandbox.mockStorageRules = mockStoredRules;
    updateDynamicRulesArgs = null;
    getDynamicRulesCalled = false;

    await sandbox.syncDynamicRules();

    assert.strictEqual(getDynamicRulesCalled, true, 'getDynamicRules should have been called');
    assert.ok(updateDynamicRulesArgs, 'updateDynamicRules should have been called');
    assert.deepStrictEqual(updateDynamicRulesArgs.removeRuleIds, [1001, 1002], 'Should remove existing rules');
    assert.deepStrictEqual(updateDynamicRulesArgs.addRules, mockStoredRules, 'Should add stored rules');
  });

  await t.test('falls back to default rules when none are stored', async () => {
    sandbox.mockStorageRules = undefined;
    updateDynamicRulesArgs = null;
    getDynamicRulesCalled = false;

    await sandbox.syncDynamicRules();

    assert.strictEqual(getDynamicRulesCalled, true, 'getDynamicRules should have been called');
    assert.ok(updateDynamicRulesArgs, 'updateDynamicRules should have been called');
    assert.deepStrictEqual(updateDynamicRulesArgs.removeRuleIds, [1001, 1002], 'Should remove existing rules');

    // Add rules should match the default rules
    const defaultRules = sandbox.getDefaultDynamicRules();
    assert.deepStrictEqual(updateDynamicRulesArgs.addRules, defaultRules, 'Should add default rules');
  });
});

// ─── SYNCDYNAMICRULES ERROR HANDLING ─────
test('syncDynamicRules error handling', async (t) => {
  const sandbox = {};
  let consoleErrorCalled = false;
  let errorLogged = null;

  const chromeMock = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: () => {} }
    },
    storage: {
      local: {
        get: () => Promise.resolve({ dynamicRules: [] }),
        set: () => Promise.resolve()
      },
      session: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve()
      },
      onChanged: { addListener: () => {} }
    },
    declarativeNetRequest: {
      getDynamicRules: () => Promise.resolve([]),
      updateDynamicRules: () => Promise.reject(new Error('Simulated update error')),
      onRuleMatchedDebug: { addListener: () => {} }
    },
    tabs: {
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(),
      onCreated: { addListener: () => {} },
      onRemoved: { addListener: () => {} }
    },
    alarms: {
      create: () => {},
      get: () => Promise.resolve(null),
      onAlarm: { addListener: () => {} }
    },
    proxy: {
      settings: {
        set: () => Promise.resolve(),
        get: () => Promise.resolve({})
      }
    },
    webRequest: {
      onAuthRequired: { addListener: () => {} }
    }
  };

  sandbox._mockInitSubscriptions    = async () => {};
  sandbox._mockEnsureAlarm          = async () => {};
  sandbox._mockRefreshAllStale      = async () => {};
  sandbox._mockRefreshSubscription  = async () => ({ ok: true });
  sandbox._mockGetSubscriptions     = async () => [];
  sandbox._mockSetSubscriptionEnabled = async () => ({ ok: true });
  sandbox._mockAddSubscription      = async () => ({ ok: true });
  sandbox._mockRemoveSubscription   = async () => ({ ok: true });
  sandbox._mockInitScriptletEngine  = async () => {};
  sandbox._mockDecryptAuth          = async () => ({ username: 'u', password: 'p' });
  sandbox._mockEncryptAuth          = async () => ({ iv: 'iv', ciphertext: 'ct' });

  sandbox.chrome = chromeMock;
  sandbox.console = {
    log: () => {},
    error: (msg, err) => {
      consoleErrorCalled = true;
      errorLogged = err;
    },
    warn: () => {}
  };
  sandbox.setInterval = () => {};
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.DEBUG = true;
  sandbox.globalThis = sandbox;
  sandbox.fetch = async () => ({ ok: false });

  vm.createContext(sandbox);
  vm.runInContext(defaultDynamicRulesCode, sandbox);
  vm.runInContext(backgroundJsCode, sandbox);

  await t.test('catches and logs error when updateDynamicRules fails', async () => {
    await sandbox.syncDynamicRules();

    assert.strictEqual(consoleErrorCalled, true, 'console.error should have been called');
    assert.ok(errorLogged instanceof Error, 'Logged error should be an Error instance');
    assert.strictEqual(errorLogged.message, 'Simulated update error', 'Should log the correct error');
  });
});
