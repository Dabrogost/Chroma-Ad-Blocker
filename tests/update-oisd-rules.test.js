const test = require('node:test');
const assert = require('node:assert');

const {
  compareStableDomains,
  countEligibleDomains,
  parseOisd,
  requireFullCapacity,
  selectDomainsForBudget,
  stableDomainRank,
  toRules
} = require('../scripts/update-oisd-rules');

test('OISD parser normalizes supported domain formats and rejects exceptions', () => {
  const parsed = parseOisd([
    '[Adblock Plus]',
    '! comment',
    '||Ads.Example^',
    '0.0.0.0 tracker.example',
    'plain.example',
    '@@||allowed.example^',
    '||ads.example^'
  ].join('\n'));

  assert.deepStrictEqual(parsed.domains, [
    'ads.example',
    'tracker.example',
    'plain.example'
  ]);
  assert.strictEqual(parsed.skipped, 1);
});

test('OISD overflow ordering is deterministic and distributed by a stable hash', () => {
  const domains = [
    'alpha.example',
    'bravo.example',
    'charlie.example',
    'delta.example',
    'echo.example'
  ];
  const forward = [...domains].sort(compareStableDomains);
  const reverse = [...domains].reverse().sort(compareStableDomains);

  assert.deepStrictEqual(forward, reverse);
  assert.notDeepStrictEqual(forward, [...domains].sort());
  for (const domain of domains) {
    const rank = stableDomainRank(domain);
    assert.ok(Number.isInteger(rank) && rank >= 0 && rank <= 0xffffffff);
  }
});

test('OISD selection preserves source precedence and uses NSFW only for remaining slots', () => {
  const sources = [
    {
      label: 'small',
      domains: ['small.example', 'shared.example'],
      skipped: 0
    },
    {
      label: 'big',
      domains: ['shared.example', 'big.example', 'protected.example'],
      skipped: 1
    },
    {
      label: 'nsfw-fill',
      domains: ['adult-one.example', 'adult-two.example'],
      skipped: 0
    }
  ];
  const protectedFilters = new Set(['||protected.example^']);
  const selection = selectDomainsForBudget(sources, protectedFilters, 4);

  assert.deepStrictEqual(selection.selectedFilters, [
    '||small.example^',
    '||shared.example^',
    '||big.example^',
    '||adult-one.example^'
  ]);
  assert.strictEqual(selection.combinedDomainCount, 6);
  assert.strictEqual(selection.protectedOverlap, 1);
  assert.strictEqual(selection.omittedForCap, 1);
  assert.strictEqual(selection.skipped, 1);
  assert.strictEqual(selection.generatedBySource.get('small'), 2);
  assert.strictEqual(selection.generatedBySource.get('big'), 1);
  assert.strictEqual(selection.generatedBySource.get('nsfw-fill'), 2);
  assert.strictEqual(selection.selectedBySource.get('nsfw-fill'), 1);
  assert.strictEqual(countEligibleDomains(sources, protectedFilters), 5);
});

test('OISD generation rejects underfill and preserves exact count while skipping reserved ids', () => {
  assert.doesNotThrow(() => requireFullCapacity(4, 4));
  assert.throws(
    () => requireFullCapacity(3, 4),
    /filled only 3\/4 generated slots/
  );

  const rules = toRules(
    ['||one.example^', '||two.example^', '||three.example^'],
    1,
    new Set([1, 3])
  );
  assert.deepStrictEqual(rules.map(rule => rule.id), [2, 4, 5]);
  assert.strictEqual(rules.length, 3);
});
