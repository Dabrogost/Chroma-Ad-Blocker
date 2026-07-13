const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('node:crypto');

const parserJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'subscriptions', 'parser.js'), 'utf8')
  .replace(/^export\s+/gm, '');

const remoteUrlJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'core', 'remoteUrl.js'), 'utf8')
  .replace(/^export\s+/gm, '')
  + '\n globalThis.__validateRemoteHttpsUrl = validateRemoteHttpsUrl;';

const userResourcesJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'scriptlets', 'userResources.js'), 'utf8')
  .replace("import { parseScriptletRule } from '../subscriptions/parser.js';", 'var parseScriptletRule = globalThis._parseScriptletRule;')
  .replace("import { validateRemoteHttpsUrl } from '../core/remoteUrl.js';", 'var validateRemoteHttpsUrl = globalThis._validateRemoteHttpsUrl;')
  .replace(/^export\s+/gm, '')
  + `
    globalThis.__userResourcesExports = {
      USER_SCRIPTLET_STORAGE_KEYS,
      validateUserScriptletSourceUrl,
      normalizeUserScriptletName,
      parseUserScriptletResourceText,
      parseUserScriptletRuleText,
      getUserScriptletSettings,
      addUserScriptletSource,
      refreshUserScriptletSource,
      removeUserScriptletSource,
      setUserScriptletRuleText,
      exportUserScriptletSettings,
      stageUserScriptletSettings
    };
  `;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadParser() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(parserJsCode, sandbox);
  return sandbox;
}

function makeHeaders(values = {}) {
  const lower = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    get: name => lower[String(name).toLowerCase()] || null
  };
}

function loadUserResources(options = {}) {
  const storage = options.storage || {};
  const parser = loadParser();
  const fetchCalls = [];
  const sandbox = {
    _parseScriptletRule: parser.parseScriptletRule,
    chrome: {
      storage: {
        local: {
          get: async (keys) => {
            if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, storage[key]]));
            if (typeof keys === 'string') return { [keys]: storage[keys] };
            return { ...storage };
          },
          set: async (values) => Object.assign(storage, values)
        }
      }
    },
    fetch: options.fetch || (async (url) => {
      fetchCalls.push({ url });
      return {
        ok: true,
        status: 200,
        headers: makeHeaders({ etag: '"v1"', 'last-modified': 'Fri, 19 Jun 2026 12:00:00 GMT' }),
        text: async () => options.fetchText || ''
      };
    }),
    URL,
    TextEncoder,
    TextDecoder,
    AbortController,
    Uint8Array,
    Date: options.Date || Date,
    Math,
    console,
    setTimeout,
    clearTimeout,
    crypto: options.crypto || webcrypto
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(remoteUrlJsCode, sandbox);
  sandbox._validateRemoteHttpsUrl = sandbox.__validateRemoteHttpsUrl;
  vm.runInContext(userResourcesJsCode, sandbox);
  return { api: sandbox.__userResourcesExports, storage, fetchCalls };
}

test('user scriptlet resource parser', async (t) => {
  await t.test('parses one-line uBO resources and normalizes .js names', () => {
    const { api } = loadUserResources();
    const parsed = api.parseUserScriptletResourceText(
      'resource-name.js text/javascript (function() { window.__resourceLoaded = true; })();'
    );

    assert.strictEqual(parsed.resources.length, 1);
    assert.strictEqual(parsed.resources[0].name, 'resource-name');
    assert.strictEqual(parsed.resources[0].displayName, 'resource-name.js');
    assert.deepStrictEqual(plain(parsed.resources[0].aliases), ['resource-name.js', 'resource-name']);
    assert.match(parsed.resources[0].code, /__resourceLoaded/);
  });

  await t.test('parses user rules with existing subscription scriptlet syntax', () => {
    const { api } = loadUserResources();
    const parsed = api.parseUserScriptletRuleText([
      '! comment',
      'example.com##+js(resource-name.js)',
      'example.com##+js(custom-resource, "hello, world")',
      '~example.net##+js(global-resource)'
    ].join('\n'));

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.rules.length, 3);
    assert.deepStrictEqual(plain(parsed.rules[0]), {
      domains: ['example.com'],
      excludedDomains: null,
      scriptlet: 'resource-name',
      args: [],
      runAt: 'document_start',
      source: 'user'
    });
    assert.deepStrictEqual(plain(parsed.rules[1].args), ['hello, world']);
    assert.deepStrictEqual(plain(parsed.rules[2]), {
      domains: null,
      excludedDomains: ['example.net'],
      scriptlet: 'global-resource',
      args: [],
      runAt: 'document_start',
      source: 'user'
    });
  });

  await t.test('rejects non-JavaScript resources', () => {
    const { api } = loadUserResources();
    assert.throws(
      () => api.parseUserScriptletResourceText('not-code text/plain alert(1)'),
      /No JavaScript scriptlet resources found/
    );
  });
});

test('user scriptlet resource storage manager', async (t) => {
  const resourceText = 'resource-name.js text/javascript (function() { window.__resourceLoaded = true; })();';

  await t.test('adds a source, stores cached code, and exposes only safe settings metadata', async () => {
    const { api, storage } = loadUserResources({ fetchText: resourceText });
    const added = await api.addUserScriptletSource({
      name: 'Example Resources',
      url: 'https://cdn.example.com/scriptlet-resources.js#ignored'
    });

    assert.strictEqual(added.ok, true);
    assert.strictEqual(storage.userScriptletSources.length, 1);
    assert.strictEqual(storage.userScriptletSources[0].url.endsWith('#ignored'), false);
    assert.strictEqual(storage.userScriptletSources[0].resourceCount, 1);
    assert.match(storage.userScriptletResources['resource-name'].code, /__resourceLoaded/);

    const rules = await api.setUserScriptletRuleText('example.com##+js(resource-name)');
    assert.deepStrictEqual(plain(rules), { ok: true, parsedRuleCount: 1 });
    assert.strictEqual(storage.userScriptletRules[0].scriptlet, 'resource-name');

    const settings = await api.getUserScriptletSettings();
    assert.strictEqual(JSON.stringify(settings).includes('__resourceLoaded'), false);
    assert.deepStrictEqual(plain(settings.availableResourceNames), ['resource-name.js']);
  });

  await t.test('rejects unsafe source URLs before fetch', async () => {
    const { api, fetchCalls } = loadUserResources({ fetchText: resourceText });

    const unsafeUrls = [
      'https://localhost/resource.js',
      'https://localhost./resource.js',
      'https://source.localhost./resource.js',
      'https://0.0.0.0/resource.js',
      'https://10.0.0.1/resource.js',
      'https://100.64.0.1/resource.js',
      'https://127.0.0.1/resource.js',
      'https://169.254.1.1/resource.js',
      'https://172.16.0.1/resource.js',
      'https://192.0.0.1/resource.js',
      'https://192.0.2.1/resource.js',
      'https://192.88.99.1/resource.js',
      'https://192.168.0.1/resource.js',
      'https://198.18.0.1/resource.js',
      'https://198.51.100.1/resource.js',
      'https://203.0.113.1/resource.js',
      'https://224.0.0.1/resource.js',
      'https://240.0.0.1/resource.js',
      'https://2130706433/resource.js',
      'https://0x7f000001/resource.js',
      'https://[::]/resource.js',
      'https://[::1]/resource.js',
      'https://[::ffff:127.0.0.1]/resource.js',
      'https://[::ffff:192.168.1.1]/resource.js',
      'https://[fc00::1]/resource.js',
      'https://[fd00::1]/resource.js',
      'https://[fe80::1]/resource.js',
      'https://[ff02::1]/resource.js',
      'https://[4000::1]/resource.js',
      'https://user:pass@example.com/resource.js',
      'https://example.com:8443/resource.js'
    ];
    for (const url of unsafeUrls) {
      assert.strictEqual(api.validateUserScriptletSourceUrl(url).ok, false, url);
    }

    assert.strictEqual(api.validateUserScriptletSourceUrl('https://example.com/resource.js').ok, true);
    assert.strictEqual(api.validateUserScriptletSourceUrl('https://93.184.216.34/resource.js').ok, true);
    assert.strictEqual(api.validateUserScriptletSourceUrl('https://[2606:4700:4700::1111]/resource.js').ok, true);
    assert.strictEqual(api.validateUserScriptletSourceUrl('https://[::ffff:8.8.8.8]/resource.js').ok, true);

    const added = await api.addUserScriptletSource({ url: 'https://127.0.0.1/resource.js' });
    assert.strictEqual(added.ok, false);
    assert.strictEqual(fetchCalls.length, 0);
  });

  await t.test('rejects a public-to-private resource redirect before accepting its body', async () => {
    let bodyRead = false;
    const { api, storage } = loadUserResources({
      fetch: async () => ({
        url: 'https://[::ffff:10.0.0.8]/resources.js',
        ok: true,
        status: 200,
        headers: makeHeaders(),
        text: async () => {
          bodyRead = true;
          return resourceText;
        }
      })
    });

    const added = await api.addUserScriptletSource({ url: 'https://cdn.example.com/resources.js' });

    assert.strictEqual(added.ok, false);
    assert.match(added.error, /Unsafe resource redirect/);
    assert.strictEqual(bodyRead, false);
    assert.strictEqual(storage.userScriptletSources, undefined);
    assert.strictEqual(storage.userScriptletResources, undefined);
  });

  await t.test('revalidates a stored resource URL before refresh fetch', async () => {
    let fetchCalled = false;
    const storage = {
      userScriptletSources: [{
        id: 'legacy-private',
        name: 'Legacy private',
        url: 'https://[fd00::5]/resources.js',
        lastError: null
      }],
      userScriptletResources: {}
    };
    const { api } = loadUserResources({
      storage,
      fetch: async () => {
        fetchCalled = true;
        throw new Error('must not fetch');
      }
    });

    const result = await api.refreshUserScriptletSource('legacy-private');

    assert.strictEqual(result.ok, false);
    assert.match(result.error, /Unsafe resource URL/);
    assert.strictEqual(fetchCalled, false);
    assert.match(storage.userScriptletSources[0].lastError, /Unsafe resource URL/);
  });

  await t.test('refresh errors preserve last good cached resources and store coarse error state', async () => {
    const storage = {};
    const first = loadUserResources({ storage, fetchText: resourceText });
    const added = await first.api.addUserScriptletSource({ url: 'https://cdn.example.com/resources.js' });
    assert.strictEqual(added.ok, true);
    const id = storage.userScriptletSources[0].id;
    const cachedCode = storage.userScriptletResources['resource-name'].code;

    const second = loadUserResources({
      storage,
      fetch: async () => ({
        ok: false,
        status: 503,
        headers: makeHeaders(),
        text: async () => ''
      })
    });
    const refreshed = await second.api.refreshUserScriptletSource(id);

    assert.strictEqual(refreshed.ok, false);
    assert.match(refreshed.error, /HTTP 503/);
    assert.strictEqual(storage.userScriptletResources['resource-name'].code, cachedCode);
    assert.match(storage.userScriptletSources[0].lastError, /HTTP 503/);
  });

  await t.test('not-modified refresh preserves cached resources', async () => {
    const storage = {};
    const first = loadUserResources({ storage, fetchText: resourceText });
    const added = await first.api.addUserScriptletSource({ url: 'https://cdn.example.com/resources.js' });
    assert.strictEqual(added.ok, true);
    const id = storage.userScriptletSources[0].id;
    const cachedCode = storage.userScriptletResources['resource-name'].code;

    const second = loadUserResources({
      storage,
      fetch: async () => ({
        ok: false,
        status: 304,
        headers: makeHeaders({ etag: '"v1"' }),
        text: async () => ''
      })
    });
    const refreshed = await second.api.refreshUserScriptletSource(id);

    assert.deepStrictEqual(plain(refreshed), { ok: true, notModified: true });
    assert.strictEqual(storage.userScriptletResources['resource-name'].code, cachedCode);
    assert.strictEqual(storage.userScriptletSources[0].lastError, null);
  });

  await t.test('duplicate resource names across sources are rejected atomically', async () => {
    const storage = {};
    const first = loadUserResources({ storage, fetchText: resourceText });
    const firstAdd = await first.api.addUserScriptletSource({ url: 'https://cdn.example.com/one.js' });
    assert.strictEqual(firstAdd.ok, true);

    const second = loadUserResources({ storage, fetchText: resourceText });
    const secondAdd = await second.api.addUserScriptletSource({ url: 'https://cdn.example.com/two.js' });

    assert.strictEqual(secondAdd.ok, false);
    assert.match(secondAdd.error, /already exists/);
    assert.strictEqual(storage.userScriptletSources.length, 1);
    assert.strictEqual(Object.keys(storage.userScriptletResources).length, 1);
  });

  await t.test('removing a source clears cached resources and matching user rules', async () => {
    const storage = {};
    const { api } = loadUserResources({
      storage,
      fetch: async (url) => {
        const isSecond = String(url).includes('/two.js');
        const name = isSecond ? 'beta.js' : 'alpha.js';
        return {
          ok: true,
          status: 200,
          headers: makeHeaders(),
          text: async () => `${name} text/javascript (function() { window.__${name.slice(0, -3)} = true; })();`
        };
      }
    });

    const alpha = await api.addUserScriptletSource({ url: 'https://cdn.example.com/one.js' });
    const beta = await api.addUserScriptletSource({ url: 'https://cdn.example.com/two.js' });
    assert.strictEqual(alpha.ok, true);
    assert.strictEqual(beta.ok, true);

    const alphaId = storage.userScriptletSources[0].id;
    const betaId = storage.userScriptletSources[1].id;
    const saved = await api.setUserScriptletRuleText([
      '! keep comment',
      'example.com##+js(alpha)',
      'twitch.tv##+js(beta)'
    ].join('\n'));
    assert.deepStrictEqual(plain(saved), { ok: true, parsedRuleCount: 2 });

    const removedAlpha = await api.removeUserScriptletSource(alphaId);
    assert.deepStrictEqual(plain(removedAlpha), { ok: true });
    assert.strictEqual(storage.userScriptletResources.alpha, undefined);
    assert.ok(storage.userScriptletResources.beta);
    assert.doesNotMatch(storage.userScriptletRuleText, /alpha/);
    assert.match(storage.userScriptletRuleText, /beta/);
    assert.deepStrictEqual(plain(storage.userScriptletRules.map(rule => rule.scriptlet)), ['beta']);

    const removedBeta = await api.removeUserScriptletSource(betaId);
    assert.deepStrictEqual(plain(removedBeta), { ok: true });
    assert.deepStrictEqual(plain(storage.userScriptletResources), {});
    assert.strictEqual(storage.userScriptletRuleText, '');
    assert.deepStrictEqual(plain(storage.userScriptletRules), []);
  });

  await t.test('stages a complete deterministic storage image without mutation', () => {
    const storage = {
      userScriptletSources: [{ id: 'old-source' }],
      userScriptletResources: { old: { code: 'old code' } },
      userScriptletRuleText: 'old.example##+js(old)',
      userScriptletRules: [{ scriptlet: 'old' }]
    };
    const before = plain(storage);
    const { api } = loadUserResources({ storage });
    const payload = {
      sources: [{ name: 'Imported', url: 'https://cdn.example.com/resources.js#ignored' }],
      ruleText: 'example.org##+js(imported-scriptlet.js)'
    };

    const first = api.stageUserScriptletSettings(payload, { importedAt: 1234 });
    const second = api.stageUserScriptletSettings(payload, { importedAt: 1234 });

    assert.strictEqual(first.ok, true);
    assert.deepStrictEqual(plain(storage), before);
    assert.deepStrictEqual(plain(first), plain(second));
    assert.strictEqual(first.storage.userScriptletSources.length, 1);
    assert.strictEqual(first.storage.userScriptletSources[0].addedAt, 1234);
    assert.strictEqual(first.storage.userScriptletSources[0].url, 'https://cdn.example.com/resources.js');
    assert.match(first.storage.userScriptletSources[0].id, /^usr_import_/);
    assert.deepStrictEqual(plain(first.storage.userScriptletResources), {});
    assert.strictEqual(first.storage.userScriptletRuleText, payload.ruleText);
    assert.strictEqual(first.storage.userScriptletRules[0].scriptlet, 'imported-scriptlet');
    assert.strictEqual(first.importedSources, 1);
    assert.strictEqual(first.importedRules, 1);
  });

  await t.test('malformed imported rule text is rejected without erasing stored state', async () => {
    const storage = {
      userScriptletSources: [{ id: 'old-source', url: 'https://cdn.example.com/old.js' }],
      userScriptletResources: { old: { name: 'old', code: 'function oldCode() {}' } },
      userScriptletRuleText: 'old.example##+js(old)',
      userScriptletRules: [{ scriptlet: 'old' }]
    };
    const before = plain(storage);
    const { api } = loadUserResources({ storage });
    const payload = {
      sources: [{ name: 'Imported', url: 'https://cdn.example.com/imported.js' }],
      ruleText: 'example.org##+js('
    };

    const staged = api.stageUserScriptletSettings(payload);
    assert.strictEqual(staged.ok, false);
    assert.match(staged.error, /Invalid user-scriptlet rule at line 1/);
    assert.strictEqual(staged.storage, undefined);
    assert.deepStrictEqual(plain(storage), before);

  });

  await t.test('invalid or duplicate imported sources fail validation instead of being dropped', () => {
    const { api } = loadUserResources();

    const unsafe = api.stageUserScriptletSettings({
      sources: [{ url: 'https://127.0.0.1/resources.js' }],
      ruleText: ''
    });
    assert.strictEqual(unsafe.ok, false);
    assert.match(unsafe.error, /Invalid user-scriptlet source URL/);

    const duplicate = api.stageUserScriptletSettings({
      sources: [
        { url: 'https://cdn.example.com/resources.js#one' },
        { url: 'https://cdn.example.com/resources.js#two' }
      ],
      ruleText: ''
    });
    assert.strictEqual(duplicate.ok, false);
    assert.match(duplicate.error, /Duplicate user-scriptlet source URL/);
  });
});
