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
    }
  };
  sandbox.chrome = chromeMock;
  sandbox.console = console;

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

      // We need to match the actual object properties since objects created inside VM might fail deepStrictEqual
      assert.strictEqual(rule.action.type, 'block', 'Rule action should be block');

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
