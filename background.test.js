const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backgroundJsCode = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');

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
  sandbox.setInterval = () => {}; // Mock setInterval to avoid background activity

  vm.createContext(sandbox);
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
