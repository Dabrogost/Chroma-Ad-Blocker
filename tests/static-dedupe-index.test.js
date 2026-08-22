const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildStaticDedupeIndexFromRules,
  canonicalDomainBlockDomain,
  checkStaticDedupeIndexFreshness,
  classifyStaticRule,
  networkRuleDedupeKey,
  serializeStaticDedupeIndex,
  writeStaticDedupeIndex
} = require('../scripts/build-static-dedupe-index');

function domainBlockRule(domain, id = 1) {
  return {
    id,
    priority: 1,
    action: { type: 'block' },
    condition: { urlFilter: `||${domain}^` }
  };
}

test('static dedupe index compacts only the exact canonical domain-block shape', () => {
  const canonical = domainBlockRule('ads.example');
  const constrained = {
    ...canonical,
    condition: {
      ...canonical.condition,
      resourceTypes: ['script']
    }
  };

  assert.strictEqual(canonicalDomainBlockDomain(canonical), 'ads.example');
  assert.deepStrictEqual(classifyStaticRule(canonical), {
    type: 'domainBlockDomain',
    value: 'ads.example'
  });
  assert.strictEqual(canonicalDomainBlockDomain(constrained), null);
  assert.deepStrictEqual(classifyStaticRule(constrained), {
    type: 'otherRuleKey',
    value: networkRuleDedupeKey(constrained)
  });
  assert.strictEqual(classifyStaticRule({ action: { type: 'block' }, condition: {} }), null);
});

test('static dedupe index is deterministic and preserves complete semantic-key parity', () => {
  const canonical = domainBlockRule('ads.example');
  const canonicalDuplicate = domainBlockRule('ads.example', 2);
  const constrained = {
    id: 3,
    priority: 2,
    action: { type: 'allow' },
    condition: {
      urlFilter: '||ads.example^',
      resourceTypes: ['script', 'image'],
      initiatorDomains: ['site-b.example', 'site-a.example']
    }
  };
  const ignored = { id: 4, priority: 1, action: { type: 'block' }, condition: {} };
  const rules = [canonical, canonicalDuplicate, constrained, ignored];
  const index = buildStaticDedupeIndexFromRules(rules, { sourceResourceCount: 2 });
  const reversed = buildStaticDedupeIndexFromRules([...rules].reverse(), { sourceResourceCount: 2 });

  assert.deepStrictEqual(index, reversed);
  assert.deepStrictEqual(index.domainBlockDomains, ['ads.example']);
  assert.deepStrictEqual(index.otherRuleKeys, [networkRuleDedupeKey(constrained)]);
  assert.deepStrictEqual(index.metadata, {
    sourceDigest: index.metadata.sourceDigest,
    sourceResourceCount: 2,
    sourceRuleCount: 4,
    indexedRuleCount: 3,
    uniqueKeyCount: 2,
    domainBlockDomainCount: 1,
    otherRuleKeyCount: 1
  });
  assert.match(index.metadata.sourceDigest, /^[a-f0-9]{64}$/);

  const expandedKeys = new Set(index.otherRuleKeys);
  for (const domain of index.domainBlockDomains) {
    expandedKeys.add(networkRuleDedupeKey(domainBlockRule(domain)));
  }
  assert.deepStrictEqual(
    expandedKeys,
    new Set([networkRuleDedupeKey(canonical), networkRuleDedupeKey(constrained)])
  );
  assert.deepStrictEqual(JSON.parse(serializeStaticDedupeIndex(index)), index);
});

test('static dedupe index freshness detects missing and changed generated output', t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chroma-static-index-'));
  const outputPath = path.join(tempDir, 'static_dedupe_index.json');
  const index = buildStaticDedupeIndexFromRules([domainBlockRule('ads.example')]);
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  assert.strictEqual(checkStaticDedupeIndexFreshness({ index, outputPath }).fresh, false);
  writeStaticDedupeIndex({ index, outputPath });
  assert.strictEqual(checkStaticDedupeIndexFreshness({ index, outputPath }).fresh, true);
  fs.appendFileSync(outputPath, ' ');
  assert.strictEqual(checkStaticDedupeIndexFreshness({ index, outputPath }).fresh, false);
});

test('committed static dedupe index is fresh for every manifest ruleset', () => {
  const freshness = checkStaticDedupeIndexFreshness();

  assert.strictEqual(freshness.fresh, true, 'run `npm run rules:index`');
  assert.strictEqual(freshness.expectedIndex.metadata.sourceRuleCount, 300000);
  assert.strictEqual(freshness.expectedIndex.metadata.sourceResourceCount, 12);
});
