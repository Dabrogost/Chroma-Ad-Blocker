const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const parserJsCode = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'subscriptions', 'parser.js'),
  'utf8'
).replace(/^export\s+/gm, '');

const plain = value => JSON.parse(JSON.stringify(value));

function loadParser() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(parserJsCode, sandbox);
  return sandbox;
}

test('Subscription parser trust boundary', async (t) => {
  await t.test('drops and counts every unsupported network constraint', () => {
    const { parseList } = loadParser();
    const parsed = parseList([
      '||method.example^$method=GET',
      '||case.example^$match-case',
      '||header.example^$header=X-Test: value',
      '@@||allow.example^$removeparam=tracking',
      '||valid.example^$script'
    ].join('\n'));

    assert.strictEqual(parsed.networkRules.length, 1);
    assert.strictEqual(parsed.networkRules[0].condition.urlFilter, '||valid.example^');
    assert.strictEqual(parsed.skipped.skipOption, 4);
    assert.strictEqual(parsed.skipped.malformed, 0);
  });

  await t.test('never broadens malformed or unsupported restricted exceptions', () => {
    const { parseList } = loadParser();
    const parsed = parseList([
      '@@||bad-domain.example^$domain=valid.example|bad domain',
      '@@||unsupported.example^$method=GET',
      '@@||valid.example^$domain=site.example|~private.site.example'
    ].join('\n'));

    assert.strictEqual(parsed.networkRules.length, 1);
    assert.strictEqual(parsed.networkRules[0].action.type, 'allow');
    assert.deepStrictEqual(plain(parsed.networkRules[0].condition.initiatorDomains), ['site.example']);
    assert.deepStrictEqual(plain(parsed.networkRules[0].condition.excludedInitiatorDomains), ['private.site.example']);
    assert.strictEqual(parsed.skipped.malformed, 1);
    assert.strictEqual(parsed.skipped.skipOption, 1);
  });

  await t.test('keeps exclusion-only network constraints without invalid DNR domain values', () => {
    const { parseList } = loadParser();
    const parsed = parseList([
      '||ads.example^$domain=~example.com',
      '||broken.example^$domain=~',
      '||sibling.example^$image'
    ].join('\n'));

    assert.strictEqual(parsed.networkRules.length, 2);
    assert.strictEqual(parsed.networkRules[0].condition.initiatorDomains, undefined);
    assert.deepStrictEqual(plain(parsed.networkRules[0].condition.excludedInitiatorDomains), ['example.com']);
    assert.strictEqual(parsed.networkRules[1].condition.urlFilter, '||sibling.example^');
    assert.strictEqual(parsed.skipped.malformed, 1);
  });

  await t.test('separates positive and negative cosmetic domains', () => {
    const { parseList } = loadParser();
    const parsed = parseList([
      'news.example,~account.news.example##.ad',
      '~example.com##.global-ad',
      'valid.example,bad domain##.invalid'
    ].join('\n'));

    assert.strictEqual(parsed.cosmeticRules.length, 2);
    assert.deepStrictEqual(plain(parsed.cosmeticRules[0]), {
      domains: ['news.example'],
      excludedDomains: ['account.news.example'],
      selector: '.ad',
      isException: false
    });
    assert.deepStrictEqual(plain(parsed.cosmeticRules[1]), {
      domains: null,
      excludedDomains: ['example.com'],
      selector: '.global-ad',
      isException: false
    });
    assert.strictEqual(parsed.skipped.malformed, 1);
  });

  await t.test('separates positive and negative scriptlet domains', () => {
    const { parseList } = loadParser();
    const parsed = parseList([
      'video.example,~account.video.example##+js(set-constant, ads, false)',
      '~example.com##+js(set-constant, globalAds, false)',
      'valid.example,*.invalid.example##+js(set-constant, ignored, false)'
    ].join('\n'));

    assert.strictEqual(parsed.scriptletRules.length, 2);
    assert.deepStrictEqual(plain(parsed.scriptletRules[0].domains), ['video.example']);
    assert.deepStrictEqual(plain(parsed.scriptletRules[0].excludedDomains), ['account.video.example']);
    assert.strictEqual(parsed.scriptletRules[1].domains, null);
    assert.deepStrictEqual(plain(parsed.scriptletRules[1].excludedDomains), ['example.com']);
    assert.strictEqual(parsed.skipped.malformed, 1);
  });

  await t.test('enforces exact line limits with or without a trailing newline', () => {
    const { parseList } = loadParser();

    assert.doesNotThrow(() => parseList('! one\n! two', { maxLines: 2 }));
    assert.doesNotThrow(() => parseList('! one\n! two\n', { maxLines: 2 }));
    assert.doesNotThrow(() => parseList('', { maxLines: 0 }));
    assert.throws(() => parseList('! one\n! two\n! three', { maxLines: 2 }), /too many lines/);
    assert.throws(() => parseList('! one\n! two\n! three\n', { maxLines: 2 }), /too many lines/);
  });
});
