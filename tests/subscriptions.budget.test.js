const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const budgetJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'subscriptions', 'budget.js'), 'utf8')
  .replace(/^export\s+/gm, '')
  + '\nglobalThis.__budgetExports = { allocate, SUBSCRIPTION_ID_START, SUBSCRIPTION_ID_END };\n';

function loadBudget() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(budgetJsCode, sandbox);
  return sandbox.__budgetExports;
}

function networkRule(overrides = {}) {
  return {
    priority: overrides.priority || 1,
    action: overrides.action || { type: 'block' },
    condition: overrides.condition || { urlFilter: overrides.urlFilter || '||ads.example^' },
    _listPosition: overrides._listPosition
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('Subscription budget allocator', async (t) => {
  await t.test('under cap preserves all rules and strips list positions', () => {
    const { allocate } = loadBudget();
    const input = [
      networkRule({ urlFilter: '||one.example^', _listPosition: 1 }),
      networkRule({ urlFilter: '||two.example^', _listPosition: 2 })
    ];

    const result = allocate(input, 10);

    assert.strictEqual(result.trimCount, 0);
    assert.deepStrictEqual(result.allocated.map(r => r.condition.urlFilter), ['||one.example^', '||two.example^']);
    assert.ok(result.allocated.every(rule => !('_listPosition' in rule)), '_listPosition should never reach DNR');
  });

  await t.test('over cap trims exactly the overflow count', () => {
    const { allocate } = loadBudget();
    const result = allocate([
      networkRule({ urlFilter: '||one.example^' }),
      networkRule({ urlFilter: '||two.example^' }),
      networkRule({ urlFilter: '||three.example^' })
    ], 2);

    assert.strictEqual(result.allocated.length, 2);
    assert.strictEqual(result.trimCount, 1);
  });

  await t.test('allow rules score highest', () => {
    const { allocate } = loadBudget();
    const result = allocate([
      networkRule({ urlFilter: '||block.example^', _listPosition: 0 }),
      networkRule({ action: { type: 'allow' }, urlFilter: '||allow.example^', _listPosition: 1000 })
    ], 1);

    assert.strictEqual(result.allocated[0].action.type, 'allow');
  });

  await t.test('important, domain-specific, and resource-specific rules outrank broader normal rules', () => {
    const { allocate } = loadBudget();

    assert.strictEqual(allocate([
      networkRule({ urlFilter: '||normal.example^', _listPosition: 0 }),
      networkRule({ priority: 3, urlFilter: '||important.example^', _listPosition: 1000 })
    ], 1).allocated[0].condition.urlFilter, '||important.example^');

    assert.strictEqual(allocate([
      networkRule({ urlFilter: '||generic.example^', _listPosition: 0 }),
      networkRule({
        urlFilter: '||domain.example^',
        _listPosition: 1000,
        condition: { urlFilter: '||domain.example^', initiatorDomains: ['example.com'] }
      })
    ], 1).allocated[0].condition.urlFilter, '||domain.example^');

    assert.strictEqual(allocate([
      networkRule({ urlFilter: '||broad.example^', _listPosition: 0 }),
      networkRule({
        urlFilter: '||script.example^',
        _listPosition: 1000,
        condition: { urlFilter: '||script.example^', resourceTypes: ['script'] }
      })
    ], 1).allocated[0].condition.urlFilter, '||script.example^');
  });

  await t.test('earlier list position only breaks structural ties', () => {
    const { allocate } = loadBudget();

    assert.strictEqual(allocate([
      networkRule({ urlFilter: '||later.example^', _listPosition: 50 }),
      networkRule({ urlFilter: '||earlier.example^', _listPosition: 1 })
    ], 1).allocated[0].condition.urlFilter, '||earlier.example^');

    assert.strictEqual(allocate([
      networkRule({ priority: 3, urlFilter: '||important.example^', _listPosition: 99999 }),
      networkRule({ urlFilter: '||early-normal.example^', _listPosition: 0 })
    ], 1).allocated[0].condition.urlFilter, '||important.example^');
  });

  await t.test('output order is deterministic', () => {
    const { allocate } = loadBudget();
    const rules = Array.from({ length: 100 }, (_, index) => networkRule({
      urlFilter: `||deterministic-${index}.example^`,
      _listPosition: index,
      condition: index % 2 === 0
        ? { urlFilter: `||deterministic-${index}.example^`, resourceTypes: ['script'] }
        : { urlFilter: `||deterministic-${index}.example^` }
    }));

    const first = allocate(plain(rules), 25);
    const second = allocate(plain(rules), 25);

    assert.deepStrictEqual(second, first);
  });

  await t.test('stress allocation remains deterministic for 50,000 rules', () => {
    const { allocate } = loadBudget();
    const rules = Array.from({ length: 50000 }, (_, index) => networkRule({
      priority: index % 997 === 0 ? 3 : 1,
      action: index % 1231 === 0 ? { type: 'allow' } : { type: 'block' },
      _listPosition: index,
      condition: {
        urlFilter: `||stress-${index}.example^`,
        ...(index % 5 === 0 ? { resourceTypes: ['script'] } : {}),
        ...(index % 7 === 0 ? { initiatorDomains: [`site-${index}.example`] } : {})
      }
    }));

    const started = Date.now();
    const first = allocate(plain(rules), 25000);
    const elapsedMs = Date.now() - started;
    const second = allocate(plain(rules), 25000);

    assert.strictEqual(first.allocated.length, 25000);
    assert.strictEqual(first.trimCount, 25000);
    assert.deepStrictEqual(second, first);
    assert.ok(elapsedMs < 3000, `allocation should remain fast enough for refresh paths, took ${elapsedMs}ms`);
  });
});
