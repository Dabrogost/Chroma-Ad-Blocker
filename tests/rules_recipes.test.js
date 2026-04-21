const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('Recipes DNR Rules validation', async (t) => {
  const rulesPath = path.join(__dirname, '..', 'extension', 'rules', 'rules_recipes.json');
  
  await t.test('file exists and is valid JSON', () => {
    assert.ok(fs.existsSync(rulesPath), 'rules_recipes.json should exist');
    const content = fs.readFileSync(rulesPath, 'utf8');
    let rules;
    assert.doesNotThrow(() => {
      rules = JSON.parse(content);
    }, 'rules_recipes.json should be valid JSON');
    assert.ok(Array.isArray(rules), 'rules_recipes.json should contain an array of rules');
  });

  await t.test('each rule has correct MV3 DNR structure', () => {
    const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    const ids = new Set();

    rules.forEach((rule, index) => {
      assert.ok(rule.id && typeof rule.id === 'number', `Rule at index ${index} must have a numeric "id"`);
      assert.ok(!ids.has(rule.id), `Rule at index ${index} has a duplicate id: ${rule.id}`);
      ids.add(rule.id);

      assert.ok(rule.priority && typeof rule.priority === 'number', `Rule ${rule.id} must have a numeric "priority"`);
      
      assert.ok(rule.action && typeof rule.action === 'object', `Rule ${rule.id} must have an "action" object`);
      assert.ok(rule.action.type, `Rule ${rule.id} action must specify a "type"`);
      
      assert.ok(rule.condition && typeof rule.condition === 'object', `Rule ${rule.id} must have a "condition" object`);
    });
  });
});
