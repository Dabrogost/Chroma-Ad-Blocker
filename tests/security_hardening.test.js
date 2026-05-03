const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backgroundJsCodeRaw = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'background.js'), 'utf8');
const backgroundJsCode = backgroundJsCodeRaw
  .replace('const DEBUG = false;', 'var DEBUG = true;')
  .replace("import { getDefaultDynamicRules } from './defaultDynamicRules.js';", "var getDefaultDynamicRules = () => [];")
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\.\/subscriptions\/manager\.js['"];?/s, `
    var initSubscriptions      = async () => {};
    var ensureAlarm             = async () => {};
    var refreshAllStale         = async () => {};
    var refreshSubscription     = async () => ({ ok: true });
    var getSubscriptions        = async () => [];
    var setSubscriptionEnabled  = async () => ({ ok: true });
    var addSubscription         = async () => ({ ok: true });
    var removeSubscription      = async () => ({ ok: true });
  `)
  .replace("import { initScriptletEngine } from '../scriptlets/engine.js';", "var initScriptletEngine = globalThis._mockInitScriptletEngine;")
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\.\/core\/messageTypes\.js['"];?/s, "var MSG = {};")
  .replace(/import\s*\*\s*as\s+router\s+from\s*['"]\.\.\/core\/messageRouter\.js['"];?/s, "var router = { registerHandler: () => {}, markSensitive: () => {}, attachListener: () => {} };")
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/handlers\.js['"];?/s, "var registerAll = () => {};")
  .replace(/import\s*['"]\.\/proxy\.js['"];?/s, "")
  .replace(/^export\s+/gm, "");

const plain = value => JSON.parse(JSON.stringify(value));

const handlersJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'handlers.js'), 'utf8')
  .replace(/import[\s\S]*?from\s+['"][^'"]+['"];?\s*/g, '')
  .replace(/^export\s+/gm, '');

const parserJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'subscriptions', 'parser.js'), 'utf8')
  .replace(/^export\s+/gm, '');

const MSG = {
  CONFIG_GET: 'CONFIG_GET',
  CONFIG_SET: 'CONFIG_SET',
  CONFIG_UPDATE: 'CONFIG_UPDATE',
  STATS_RESET: 'STATS_RESET',
  LOG_GET: 'LOG_GET',
  WHITELIST_GET: 'WHITELIST_GET',
  WHITELIST_ADD: 'WHITELIST_ADD',
  WHITELIST_REMOVE: 'WHITELIST_REMOVE',
  FPR_WHITELIST_GET: 'FPR_WHITELIST_GET',
  FPR_WHITELIST_ADD: 'FPR_WHITELIST_ADD',
  FPR_WHITELIST_REMOVE: 'FPR_WHITELIST_REMOVE',
  SUBSCRIPTION_GET: 'SUBSCRIPTION_GET',
  SUBSCRIPTION_SET: 'SUBSCRIPTION_SET',
  SUBSCRIPTION_REFRESH: 'SUBSCRIPTION_REFRESH',
  SUBSCRIPTION_ADD: 'SUBSCRIPTION_ADD',
  SUBSCRIPTION_REMOVE: 'SUBSCRIPTION_REMOVE',
  UPDATE_CHECK: 'UPDATE_CHECK',
  PROXY_CONFIG_GET: 'PROXY_CONFIG_GET',
  PROXY_CONFIG_SET: 'PROXY_CONFIG_SET',
  PROXY_TEST: 'PROXY_TEST',
  ZAPPER_START: 'ZAPPER_START',
  ZAPPER_SAVE_RULE: 'ZAPPER_SAVE_RULE',
  ZAPPER_RULES_GET: 'ZAPPER_RULES_GET',
  ZAPPER_RULE_REMOVE: 'ZAPPER_RULE_REMOVE',
  ZAPPER_RULE_SET: 'ZAPPER_RULE_SET'
};

function loadHandlers(options = {}) {
  const storage = options.storage || {};
  const sandbox = {
    MSG,
    URL,
    Number,
    encryptAuth: options.encryptAuth || (async (username, password) => ({ iv: `iv:${username}`, ciphertext: `ct:${password}` })),
    syncWhitelistRules: options.syncWhitelistRules || (async () => {}),
    chrome: {
      storage: {
        local: {
          get: options.storageGet || (async (key) => {
            if (typeof key === 'string') return { [key]: storage[key] };
            return {};
          }),
          set: options.storageSet || (async (values) => Object.assign(storage, values))
        }
      },
      tabs: { query: async () => [], sendMessage: async () => {} }
    },
    console
  };
  sandbox._storage = storage;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(handlersJsCode, sandbox);
  return sandbox;
}

function loadParser() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(parserJsCode, sandbox);
  return sandbox;
}

// ─── SECURITY HARDENING - BACKGROUND.JS ─────
test('Security Hardening - background.js', async (t) => {
  const sandbox = {};
  let messageHandler = null;
  let tabsRemoved = [];
  let dynamicRulesAdded = [];
  sandbox._sessionStore = {};

  const chromeMock = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { 
        addListener: (handler) => { messageHandler = handler; } 
      }
    },
    storage: {
      local: {
        get: async (keys) => {
          if (Array.isArray(keys)) {
             const res = {};
             if (keys.includes('dynamicRules')) res.dynamicRules = [];
             return res;
          }
          if (keys === 'dynamicRules') return { dynamicRules: [] };
          return { dynamicRules: [] };
        },
        set: () => Promise.resolve()
      },

      onChanged: { addListener: () => {} }
    },
    declarativeNetRequest: {
      getDynamicRules: () => Promise.resolve([]),
      updateDynamicRules: async (args) => {
        if (args.addRules) dynamicRulesAdded.push(...args.addRules);
        return Promise.resolve();
      },
      onRuleMatchedDebug: { addListener: () => {} }
    },
    tabs: {
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(),
      remove: async (id) => {
        tabsRemoved.push(id);
        return Promise.resolve();
      },
      onCreated: { addListener: () => {} },
      onRemoved: { 
        addListener: (fn) => { sandbox._onRemovedListener = fn; } 
      }
    },
    alarms: {
      create: () => {},
      get: () => Promise.resolve(null),
      onAlarm: { addListener: () => {} }
    },
  };
  sandbox.chrome = chromeMock;
  sandbox.crypto = {
    getRandomValues: (buffer) => {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] = Math.floor(Math.random() * 256);
      }
      return buffer;
    }
  };
  sandbox.console = {
    log: () => {},
    error: () => {},
    warn: () => {}
  };
  sandbox.setInterval = () => {};
  sandbox.setTimeout = setTimeout;
  sandbox.clearInterval = clearInterval;
  sandbox.clearTimeout = clearTimeout;
  sandbox.initScriptletEngine = async () => {};
  sandbox.Promise = Promise;
  sandbox.Object = Object;
  sandbox.Array = Array;
  sandbox.Error = Error;
  sandbox.Date = Date;
  sandbox.Map = Map;
  sandbox.Set = Set;
  sandbox.__CHROMA_INTERNAL_TEST_STRICT__ = true;
  chromeMock.tabs.get = (id) => Promise.resolve({ id, url: 'https://www.youtube.com/' });
  sandbox.globalThis = sandbox;
  sandbox.fetch = async () => ({ ok: false });
  sandbox.DEBUG = true;
  sandbox.__CHROMA_INTERNAL_TEST_STRICT__ = true;
  sandbox._mockInitScriptletEngine = async () => {};
  sandbox._mockDecryptAuth          = async () => ({ username: 'u', password: 'p' });
  sandbox._mockEncryptAuth          = async () => ({ iv: 'iv', ciphertext: 'ct' });
  chromeMock.proxy = {
    settings: {
      set: () => Promise.resolve(),
      get: () => Promise.resolve({})
    }
  };
  chromeMock.webRequest = {
    onAuthRequired: { addListener: () => {} }
  };

  vm.createContext(sandbox);
  vm.runInContext(backgroundJsCode, sandbox);


});

test('Security Hardening - handlers.js', async (t) => {
  await t.test('marks mutating and private-read message types sensitive', () => {
    const sandbox = loadHandlers();
    const marked = [];
    sandbox.registerAll({
      markSensitive: type => marked.push(type),
      registerHandler: () => {}
    });

    for (const type of [
      MSG.CONFIG_GET,
      MSG.CONFIG_SET,
      MSG.STATS_RESET,
      MSG.LOG_GET,
      MSG.PROXY_CONFIG_GET,
      MSG.PROXY_CONFIG_SET,
      MSG.PROXY_TEST,
      MSG.ZAPPER_START,
      MSG.ZAPPER_RULES_GET,
      MSG.ZAPPER_RULE_REMOVE,
      MSG.ZAPPER_RULE_SET,
      MSG.SUBSCRIPTION_SET,
      MSG.SUBSCRIPTION_REFRESH,
      MSG.SUBSCRIPTION_ADD,
      MSG.SUBSCRIPTION_REMOVE,
      MSG.WHITELIST_ADD,
      MSG.WHITELIST_REMOVE,
      MSG.FPR_WHITELIST_ADD,
      MSG.FPR_WHITELIST_REMOVE
    ]) {
      assert.ok(marked.includes(type), `${type} should be sensitive`);
    }
  });

  await t.test('normalizes whitelist and FPR whitelist additions', async () => {
    let syncCount = 0;
    const sandbox = loadHandlers({
      storage: {
        whitelist: [],
        fprWhitelist: []
      },
      syncWhitelistRules: async () => {
        syncCount++;
      }
    });

    await sandbox.handleWhitelistAdd({ domain: 'HTTPS://Example.COM/path' });
    await sandbox.handleWhitelistAdd({ domain: 'bad..example.com' });
    await sandbox.handleFprWhitelistAdd({ domain: '*.Login.Example.COM' });
    await sandbox.handleFprWhitelistAdd({ domain: '-bad.example.com' });

    assert.deepStrictEqual(plain(sandbox._storage.whitelist), ['example.com']);
    assert.deepStrictEqual(plain(sandbox._storage.fprWhitelist), ['login.example.com']);
    assert.strictEqual(syncCount, 1);
  });

  await t.test('normalizes valid proxy configs and drops invalid entries', async () => {
    const sandbox = loadHandlers();
    const result = await sandbox.validateProxyConfigsForStorage([
      {
        id: 10,
        name: 'Main Proxy',
        type: 'PROXY',
        host: 'socks5://Proxy.Example.COM:1080/path',
        port: '80',
        accepted: true,
        credentialAction: 'replace',
        username: 'user',
        password: 'pass',
        domains: [
          { host: 'HTTPS://YouTube.COM/watch', enabled: true },
          { host: 'bad host', enabled: true }
        ],
        extra: 'drop-me'
      },
      { id: 'bad', host: 'example.com', port: 80, accepted: true }
    ]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.configs.length, 1);
    assert.strictEqual(result.droppedCount, 1);
    assert.deepStrictEqual(plain(result.configs[0]), {
      id: 10,
      name: 'Main Proxy',
      host: 'proxy.example.com',
      port: 1080,
      type: 'SOCKS5',
      accepted: true,
      domains: [{ host: 'youtube.com', enabled: true }],
      authIv: 'iv:user',
      authCipher: 'ct:pass'
    });
  });

  await t.test('rejects malformed proxy config payloads', async () => {
    const sandbox = loadHandlers();
    const result = await sandbox.validateProxyConfigsForStorage({ not: 'an array' });

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(plain(result.configs), []);
    assert.match(result.errors[0], /array/);
  });

  await t.test('keeps handler proxy validation strict without breaking HTTP compatibility', async () => {
    const sandbox = loadHandlers();
    const result = await sandbox.validateProxyConfigsForStorage([
      {
        id: 20,
        name: 'HTTP Alias',
        type: 'HTTP',
        host: 'Proxy.Example.com',
        port: '8080',
        accepted: true,
        domains: [
          { host: 'good.example.com', enabled: true },
          { host: 'bad..example.com', enabled: true },
          { host: '-bad.example.com', enabled: true }
        ]
      },
      { id: 20.5, type: 'PROXY', host: 'proxy.example.com', port: 8080, accepted: true },
      { id: 21, type: 'PROXY', host: 'bad..example.com', port: 8080, accepted: true },
      { id: 22, type: 'PROXY', host: '-bad.example.com', port: 8080, accepted: true }
    ]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.configs.length, 1);
    assert.strictEqual(result.droppedCount, 3);
    assert.deepStrictEqual(plain(result.configs[0]), {
      id: 20,
      name: 'HTTP Alias',
      host: 'proxy.example.com',
      port: 8080,
      type: 'PROXY',
      accepted: true,
      domains: [{ host: 'good.example.com', enabled: true }]
    });
  });

  await t.test('rejects non-integer proxy test ids before dispatch', async () => {
    const sandbox = loadHandlers();
    const result = await sandbox.handleProxyTest({ proxyId: 1.25 });

    assert.deepStrictEqual(plain(result), { ok: false, error: 'Invalid proxy ID' });
  });

  await t.test('proxy config get returns credential metadata without secrets', async () => {
    const sandbox = loadHandlers({
      storage: {
        proxyConfigs: [{
          id: 12,
          name: 'Private',
          host: 'proxy.example.com',
          port: 8080,
          type: 'PROXY',
          accepted: true,
          domains: [{ host: 'example.com', enabled: true }],
          authIv: 'iv-secret',
          authCipher: 'cipher-secret'
        }]
      }
    });

    const result = await sandbox.handleProxyConfigGet();

    assert.deepStrictEqual(plain(result), [{
      id: 12,
      name: 'Private',
      host: 'proxy.example.com',
      port: 8080,
      type: 'PROXY',
      accepted: true,
      domains: [{ host: 'example.com', enabled: true }],
      hasCredentials: true
    }]);
    assert.strictEqual('username' in result[0], false);
    assert.strictEqual('password' in result[0], false);
    assert.strictEqual('authIv' in result[0], false);
    assert.strictEqual('authCipher' in result[0], false);
  });

  await t.test('proxy config get recognizes encrypted byte-array credentials', async () => {
    const sandbox = loadHandlers({
      storage: {
        proxyConfigs: [{
          id: 13,
          name: 'Array Auth',
          host: 'proxy.example.com',
          port: 8080,
          type: 'PROXY',
          accepted: true,
          domains: [],
          authIv: [1, 2, 3, 4],
          authCipher: [5, 6, 7, 8]
        }]
      }
    });

    const result = await sandbox.handleProxyConfigGet();

    assert.strictEqual(result[0].hasCredentials, true);
    assert.strictEqual('authIv' in result[0], false);
    assert.strictEqual('authCipher' in result[0], false);
  });

  await t.test('proxy credential preserve keeps encrypted byte-array auth', async () => {
    const existing = [{
      id: 15,
      name: 'Existing Array',
      host: 'proxy.example.com',
      port: 8080,
      type: 'PROXY',
      accepted: true,
      domains: [],
      authIv: [1, 2, 3],
      authCipher: [4, 5, 6]
    }];

    const result = await loadHandlers().validateProxyConfigsForStorage([{
      id: 15,
      name: 'Edited Array',
      host: 'proxy.example.com',
      port: 8080,
      type: 'PROXY',
      accepted: true,
      domains: [],
      credentialAction: 'preserve'
    }], existing);

    assert.deepStrictEqual(plain(result.configs[0].authIv), [1, 2, 3]);
    assert.deepStrictEqual(plain(result.configs[0].authCipher), [4, 5, 6]);
  });

  await t.test('proxy credential actions preserve replace and clear encrypted auth', async () => {
    const existing = [{
      id: 1,
      name: 'Existing',
      host: 'old.example.com',
      port: 8080,
      type: 'PROXY',
      accepted: true,
      domains: [],
      authIv: 'old-iv',
      authCipher: 'old-cipher'
    }];
    const result = await loadHandlers().validateProxyConfigsForStorage([
      {
        id: 1,
        name: 'Preserve',
        host: 'proxy.example.com',
        port: 8080,
        type: 'PROXY',
        accepted: true,
        domains: [],
        credentialAction: 'preserve'
      },
      {
        id: 2,
        name: 'Replace',
        host: 'replace.example.com',
        port: 8081,
        type: 'PROXY',
        accepted: true,
        domains: [],
        credentialAction: 'replace',
        username: 'new-user',
        password: 'new-pass'
      },
      {
        id: 3,
        name: 'Clear',
        host: 'clear.example.com',
        port: 8082,
        type: 'PROXY',
        accepted: true,
        domains: [],
        authIv: 'incoming-iv',
        authCipher: 'incoming-cipher',
        credentialAction: 'clear'
      }
    ], existing);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.droppedCount, 0);
    assert.strictEqual(result.configs[0].authIv, 'old-iv');
    assert.strictEqual(result.configs[0].authCipher, 'old-cipher');
    assert.strictEqual(result.configs[1].authIv, 'iv:new-user');
    assert.strictEqual(result.configs[1].authCipher, 'ct:new-pass');
    assert.strictEqual('authIv' in result.configs[2], false);
    assert.strictEqual('authCipher' in result.configs[2], false);
    for (const config of result.configs) {
      assert.strictEqual('username' in config, false);
      assert.strictEqual('password' in config, false);
    }
  });

  await t.test('does not expose or preserve oversized encrypted proxy auth blobs', async () => {
    const oversized = {
      id: 14,
      name: 'Oversized',
      host: 'proxy.example.com',
      port: 8080,
      type: 'PROXY',
      accepted: true,
      domains: [],
      authIv: 'i'.repeat(129),
      authCipher: 'c'.repeat(2049)
    };
    const sandbox = loadHandlers({ storage: { proxyConfigs: [oversized] } });
    const visible = await sandbox.handleProxyConfigGet();
    const stored = await sandbox.validateProxyConfigsForStorage([{
      id: 14,
      name: 'Oversized',
      host: 'proxy.example.com',
      port: 8080,
      type: 'PROXY',
      accepted: true,
      domains: [],
      credentialAction: 'preserve'
    }], [oversized]);

    assert.strictEqual(visible[0].hasCredentials, false);
    assert.strictEqual('authIv' in stored.configs[0], false);
    assert.strictEqual('authCipher' in stored.configs[0], false);
  });

  await t.test('proxy credential replacement requires complete credentials', async () => {
    const result = await loadHandlers().validateProxyConfigsForStorage([{
      id: 5,
      name: 'Bad Credentials',
      host: 'proxy.example.com',
      port: 8080,
      type: 'PROXY',
      accepted: true,
      domains: [],
      credentialAction: 'replace',
      username: 'user',
      password: ''
    }]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.configs.length, 0);
    assert.strictEqual(result.droppedCount, 1);
    assert.match(result.errors[0], /username and password/);
  });

  await t.test('rejects unsafe custom subscription URLs', () => {
    const sandbox = loadHandlers();

    assert.strictEqual(sandbox.validateCustomSubscriptionInput({
      id: 'custom_1',
      name: 'Local',
      url: 'https://127.0.0.1/list.txt'
    }).ok, false);
    assert.strictEqual(sandbox.validateCustomSubscriptionInput({
      id: 'custom_2',
      name: 'Creds',
      url: 'https://user:pass@example.com/list.txt'
    }).ok, false);
    assert.strictEqual(sandbox.validateCustomSubscriptionInput({
      id: 'custom_3',
      name: 'Alt Port',
      url: 'https://example.com:8443/list.txt'
    }).ok, false);
    assert.strictEqual(sandbox.validateCustomSubscriptionInput({
      id: 'custom_4',
      name: 'IPv6 Local',
      url: 'https://[fc00::1]/list.txt'
    }).ok, false);

    const valid = sandbox.validateCustomSubscriptionInput({
      id: 'custom_5',
      name: 'Public FC Prefix',
      url: 'https://fc-public.example/list.txt'
    });
    assert.strictEqual(valid.ok, true);
    assert.strictEqual(valid.subscription.url, 'https://fc-public.example/list.txt');

    const validExample = sandbox.validateCustomSubscriptionInput({
      id: 'custom_6',
      name: 'Example',
      url: 'https://example.com/list.txt'
    });
    assert.strictEqual(validExample.ok, true);
    assert.strictEqual(validExample.subscription.url, 'https://example.com/list.txt');
  });
});

test('Security Hardening - subscription parser', async (t) => {
  await t.test('parses generic cosmetic rules beginning with ##', () => {
    const { parseList } = loadParser();
    const parsed = parseList('##.ad-banner\n#@#.sponsored');

    assert.strictEqual(parsed.cosmeticRules.length, 2);
    assert.deepStrictEqual(plain(parsed.cosmeticRules[0]), {
      domains: null,
      selector: '.ad-banner',
      isException: false
    });
    assert.deepStrictEqual(plain(parsed.cosmeticRules[1]), {
      domains: null,
      selector: '.sponsored',
      isException: true
    });
  });

  await t.test('drops unsupported negated resource-type network rules', () => {
    const { parseList } = loadParser();
    const parsed = parseList('||ads.example^$~script,third-party\n||img.example^$image');

    assert.strictEqual(parsed.networkRules.length, 1);
    assert.strictEqual(parsed.networkRules[0].condition.urlFilter, '||img.example^');
    assert.deepStrictEqual(plain(parsed.networkRules[0].condition.resourceTypes), ['image']);
  });

  await t.test('keeps commas inside quoted and regex-like scriptlet arguments', () => {
    const { parseList } = loadParser();
    const parsed = parseList([
      'example.com##+js(set-constant, foo.bar, "hello, world")',
      'example.com##+js(no-fetch-if, /adserver,tracking/)',
      'example.com##+js(json-prune, "playerResponse.adPlacements playerAds")',
      'example.com##+js(replace-node-text, script, "/foo,bar/g", "")'
    ].join('\n'));

    assert.strictEqual(parsed.scriptletRules.length, 4);
    assert.deepStrictEqual(plain(parsed.scriptletRules[0].args), ['foo.bar', 'hello, world']);
    assert.deepStrictEqual(plain(parsed.scriptletRules[1].args), ['/adserver,tracking/']);
    assert.deepStrictEqual(plain(parsed.scriptletRules[2].args), ['playerResponse.adPlacements playerAds']);
    assert.deepStrictEqual(plain(parsed.scriptletRules[3].args), ['script', '/foo,bar/g', '']);
  });
});
