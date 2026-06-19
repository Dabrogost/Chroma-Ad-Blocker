const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('node:crypto');

const parserJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'subscriptions', 'parser.js'), 'utf8')
  .replace(/^export\s+/gm, '');

const userResourcesJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'scriptlets', 'userResources.js'), 'utf8')
  .replace("import { parseScriptletRule } from '../subscriptions/parser.js';", 'var parseScriptletRule = globalThis._parseScriptletRule;')
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
      importUserScriptletSettings
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
      'example.com##+js(custom-resource, "hello, world")'
    ].join('\n'));

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.rules.length, 2);
    assert.deepStrictEqual(plain(parsed.rules[0]), {
      domains: ['example.com'],
      scriptlet: 'resource-name',
      args: [],
      runAt: 'document_start',
      source: 'user'
    });
    assert.deepStrictEqual(plain(parsed.rules[1].args), ['hello, world']);
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

    assert.strictEqual(api.validateUserScriptletSourceUrl('https://127.0.0.1/resource.js').ok, false);
    assert.strictEqual(api.validateUserScriptletSourceUrl('https://0.0.0.0/resource.js').ok, false);
    assert.strictEqual(api.validateUserScriptletSourceUrl('https://224.0.0.1/resource.js').ok, false);
    assert.strictEqual(api.validateUserScriptletSourceUrl('https://[::1]/resource.js').ok, false);
    assert.strictEqual(api.validateUserScriptletSourceUrl('https://[::ffff:127.0.0.1]/resource.js').ok, false);
    assert.strictEqual(api.validateUserScriptletSourceUrl('https://user:pass@example.com/resource.js').ok, false);
    assert.strictEqual(api.validateUserScriptletSourceUrl('https://example.com:8443/resource.js').ok, false);

    const added = await api.addUserScriptletSource({ url: 'https://127.0.0.1/resource.js' });
    assert.strictEqual(added.ok, false);
    assert.strictEqual(fetchCalls.length, 0);
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

  await t.test('settings import stores setup only and clears cached executable code', async () => {
    const { api, storage } = loadUserResources({
      storage: {
        userScriptletResources: {
          old: { name: 'old', code: 'function oldCode() {}' }
        }
      }
    });

    const imported = await api.importUserScriptletSettings({
      sources: [{ name: 'Imported', url: 'https://cdn.example.com/imported.js' }],
      ruleText: 'example.org##+js(imported-scriptlet)'
    });

    assert.deepStrictEqual(plain(imported), { ok: true, importedSources: 1, importedRules: 1 });
    assert.strictEqual(storage.userScriptletSources.length, 1);
    assert.strictEqual(storage.userScriptletSources[0].lastUpdated, 0);
    assert.deepStrictEqual(plain(storage.userScriptletResources), {});
    assert.strictEqual(storage.userScriptletRules[0].scriptlet, 'imported-scriptlet');
    assert.strictEqual(JSON.stringify(storage).includes('oldCode'), false);
  });
});
