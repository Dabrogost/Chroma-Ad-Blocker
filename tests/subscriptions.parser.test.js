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

  await t.test('keeps the issue #134 Unbreak exception as a native DNR urlFilter', () => {
    const { parseList } = loadParser();
    const urlFilter = '||estaticos.*/elementosWeb/ew/js/multimedia/player/videojs-contrib-ads/videojs.ads.min.js';
    const domains = [
      'diaridegirona.cat',
      'diariodeibiza.es',
      'diariodemallorca.es',
      'diarioinformacion.com',
      'eldia.es',
      'emporda.info',
      'farodevigo.es',
      'laopinioncoruna.es',
      'laopiniondemalaga.es',
      'laopiniondemurcia.es',
      'laopiniondezamora.es',
      'laprovincia.es',
      'levante-emv.com',
      'lne.es',
      'mallorcazeitung.es',
      'regio7.cat',
      'superdeporte.es'
    ];
    const parsed = parseList(`@@${urlFilter}$xhr,domain=${domains.join('|')}`);

    assert.strictEqual(parsed.networkRules.length, 1);
    assert.strictEqual(parsed.networkRules[0].action.type, 'allow');
    assert.strictEqual(parsed.networkRules[0].priority, 2);
    assert.strictEqual(parsed.networkRules[0].condition.urlFilter, urlFilter);
    assert.strictEqual(parsed.networkRules[0].condition.regexFilter, undefined);
    assert.deepStrictEqual(plain(parsed.networkRules[0].condition.resourceTypes), ['xmlhttprequest']);
    assert.deepStrictEqual(plain(parsed.networkRules[0].condition.initiatorDomains), domains);
    assert.strictEqual(parsed.skipped.unsupportedUrlFilter, 0);
    assert.strictEqual(parsed.stats.translatedRegexFilter, 0);
  });

  await t.test('parses path-based network rules instead of skipping them as regexes', () => {
    const { parseList } = loadParser();
    const parsed = parseList([
      '/ads/banner.js',
      '/pagead/js/adsbygoogle.js$script',
      '@@/ads/allowed.js',
      '/a/b.js$domain=example.com|~sub.example.com',
      '/^https?:\\/\\/ads\\.example\\.com\\//',
      '/^https?:\\/\\/ads\\.example\\.com\\/$/$script'
    ].join('\n'));

    assert.strictEqual(parsed.skipped.regex, 2);
    assert.strictEqual(parsed.networkRules.length, 4);

    assert.deepStrictEqual(plain(parsed.networkRules[0]), {
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: '/ads/banner.js' }
    });
    assert.deepStrictEqual(plain(parsed.networkRules[1]), {
      priority: 1,
      action: { type: 'block' },
      condition: {
        urlFilter: '/pagead/js/adsbygoogle.js',
        resourceTypes: ['script']
      }
    });
    assert.deepStrictEqual(plain(parsed.networkRules[2]), {
      priority: 2,
      action: { type: 'allow' },
      condition: { urlFilter: '/ads/allowed.js' }
    });
    assert.deepStrictEqual(plain(parsed.networkRules[3]), {
      priority: 1,
      action: { type: 'block' },
      condition: {
        urlFilter: '/a/b.js',
        initiatorDomains: ['example.com'],
        excludedInitiatorDomains: ['sub.example.com']
      }
    });
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

  await t.test('preserves leading single-pipe URL-start anchor rules while rejecting bare or mid-pattern pipes', () => {
    const { parseList } = loadParser();
    const parsed = parseList([
      '|https://ads.example.com/banner.js$script',
      '@@|https://good.example.com/sdk.js$script',
      '|https://exact.example/pixel.gif|$image',
      '|$script',
      '|*$script',
      'http://bad|pipe.example/ad.js$script'
    ].join('\n'));

    assert.deepStrictEqual(
      plain(parsed.networkRules.map(rule => ({
        action: rule.action.type,
        urlFilter: rule.condition.urlFilter
      }))),
      [
        { action: 'block', urlFilter: '|https://ads.example.com/banner.js' },
        { action: 'allow', urlFilter: '|https://good.example.com/sdk.js' },
        { action: 'block', urlFilter: '|https://exact.example/pixel.gif|' }
      ]
    );
    assert.strictEqual(parsed.skipped.unsupportedUrlFilter, 3);
    assert.strictEqual(parsed.skipped.malformed, 0);
  });

  await t.test('parses slash-prefixed literal path arguments and regex character-class slashes cleanly', () => {
    const { parseList } = loadParser();
    const parsed = parseList([
      'example.com##+js(remove-node-text, script, /ads, stay, 1)',
      'example.com##+js(prevent-fetch, /ads/banner.js)',
      'example.com##+js(prevent-fetch, /ads/img)',
      "example.com##+js(replace-node-text, script, /ads/sdk.js, '')",
      "example.com##+js(replace-node-text, script, /https?:\\/\\/[^/]{1,2}\\/ads/, '')",
      'example.com##+js(prevent-fetch, /https?:\\/\\/[^/]+\\/ads\\/{1,2}/i)'
    ].join('\n'));

    assert.strictEqual(parsed.skipped.malformed, 0);
    assert.strictEqual(parsed.scriptletRules.length, 6);
    assert.deepStrictEqual(plain(parsed.scriptletRules[0].args), ['script', '/ads', 'stay', '1']);
    assert.deepStrictEqual(plain(parsed.scriptletRules[1].args), ['/ads/banner.js']);
    assert.deepStrictEqual(plain(parsed.scriptletRules[2].args), ['/ads/img']);
    assert.deepStrictEqual(plain(parsed.scriptletRules[3].args), ['script', '/ads/sdk.js', '']);
    assert.deepStrictEqual(plain(parsed.scriptletRules[4].args), ['script', '/https?:\\/\\/[^/]{1,2}\\/ads/', '']);
    assert.deepStrictEqual(plain(parsed.scriptletRules[5].args), ['/https?:\\/\\/[^/]+\\/ads\\/{1,2}/i']);
  });
});
