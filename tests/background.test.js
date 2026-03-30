const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backgroundJsCodeRaw = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
const backgroundJsCode = backgroundJsCodeRaw
  .replace('const DEBUG = false;', 'var DEBUG = true;')
  .replace("import { getDefaultDynamicRules } from './defaultDynamicRules.js';", "var getDefaultDynamicRules = globalThis.getDefaultDynamicRules;");

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
      updateDynamicRules: () => Promise.resolve()
    },
    tabs: {
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(),
      onCreated: { addListener: () => {} },
      onRemoved: { addListener: () => {} }
    }
  };
  sandbox.chrome = chromeMock;
  sandbox.console = console;
  sandbox.setInterval = () => {};

  sandbox.globalThis = sandbox;
 
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
      assert.strictEqual(rule.priority, 1, 'Rule priority should be 1');

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

  const mockExistingRules = [{ id: 101 }, { id: 102 }];
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
      }
    },
    tabs: {
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(),
      onCreated: { addListener: () => {} },
      onRemoved: { addListener: () => {} }
    }
  };

  sandbox.chrome = chromeMock;
  sandbox.console = {
    log: () => {},
    error: () => {},
    warn: () => {}
  };
  sandbox.setInterval = () => {};
  sandbox.globalThis = sandbox;

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
    assert.deepStrictEqual(updateDynamicRulesArgs.removeRuleIds, [101, 102], 'Should remove existing rules');
    assert.deepStrictEqual(updateDynamicRulesArgs.addRules, mockStoredRules, 'Should add stored rules');
  });

  await t.test('falls back to default rules when none are stored', async () => {
    sandbox.mockStorageRules = undefined;
    updateDynamicRulesArgs = null;
    getDynamicRulesCalled = false;

    await sandbox.syncDynamicRules();

    assert.strictEqual(getDynamicRulesCalled, true, 'getDynamicRules should have been called');
    assert.ok(updateDynamicRulesArgs, 'updateDynamicRules should have been called');
    assert.deepStrictEqual(updateDynamicRulesArgs.removeRuleIds, [101, 102], 'Should remove existing rules');

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
      updateDynamicRules: () => Promise.reject(new Error('Simulated update error'))
    },
    tabs: {
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(),
      onCreated: { addListener: () => {} },
      onRemoved: { addListener: () => {} }
    }
  };

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
  sandbox.DEBUG = true;
  sandbox.globalThis = sandbox;

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
