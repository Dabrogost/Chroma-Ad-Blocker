const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const healthJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'health.js'), 'utf8')
  .replace(/^export\s+/gm, '');

const manifest = {
  version: '1.2.3',
  minimum_chrome_version: '122',
  declarative_net_request: {
    rule_resources: [
      { id: 'static_a', path: 'rules/a.json', enabled: true },
      { id: 'static_b', path: 'rules/b.json', enabled: true }
    ]
  }
};

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadHealthSandbox(options = {}) {
  const storage = {
    config: {
      enabled: true,
      networkBlocking: true,
      cosmetic: true,
      stripping: true,
      acceleration: false,
      fingerprintRandomization: false,
      globalProxyEnabled: false,
      globalProxyId: null
    },
    subscriptions: [],
    subscriptionCosmeticRules: [],
    localCosmeticRules: [],
    subscriptionScriptletRules: [],
    proxyConfigs: [],
    whitelist: [],
    fprWhitelist: [],
    stats: { networkBlocked: 0 },
    requestLog: [],
    appliedNetworkRuleCount: 0,
    ...(options.storage || {})
  };
  const enabledRulesets = options.enabledRulesets || ['static_a', 'static_b'];
  const dynamicRules = options.dynamicRules || [];
  const dnr = options.noDnr
    ? undefined
    : {
      getEnabledRulesets: async () => enabledRulesets,
      getDynamicRules: async () => dynamicRules
    };
  if (dnr && options.debugLogging !== false) {
    dnr.onRuleMatchedDebug = { addListener: () => {} };
  }

  const sandbox = {
    chrome: {
      runtime: {
        getManifest: () => manifest
      },
      storage: {
        local: {
          get: async (keys) => {
            if (Array.isArray(keys)) {
              const out = {};
              for (const key of keys) out[key] = storage[key];
              return out;
            }
            if (typeof keys === 'string') return { [keys]: storage[keys] };
            return { ...storage };
          }
        }
      },
      declarativeNetRequest: dnr,
      userScripts: options.userScripts,
      scripting: options.scripting || {
        getRegisteredContentScripts: async () => []
      }
    },
    Date,
    Number,
    String,
    Array,
    Object,
    Set,
    console
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(healthJsCode, sandbox);
  return sandbox;
}

test('health diagnostics', async (t) => {
  await t.test('master disabled returns overall disabled', async () => {
    const sandbox = loadHealthSandbox({
      storage: { config: { enabled: false, networkBlocking: true } },
      userScripts: { register: async () => {}, getScripts: async () => [] }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.overall.status, 'disabled');
    assert.strictEqual(health.master.enabled, false);
  });

  await t.test('userScripts unavailable with stored scriptlet rules returns degraded', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        subscriptionScriptletRules: [{ scriptlet: 'set-constant', args: ['x', 'true'] }]
      },
      userScripts: undefined
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.overall.status, 'degraded');
    assert.strictEqual(health.scriptlets.apiAvailable, false);
    assert.strictEqual(health.scriptlets.storedRuleCount, 1);
    assert.ok(health.overall.issues.some(issue => issue.area === 'scriptlets' && issue.severity === 'warning'));
  });

  await t.test('network enabled with missing static ruleset returns error', async () => {
    const sandbox = loadHealthSandbox({
      enabledRulesets: ['static_a'],
      userScripts: { register: async () => {}, getScripts: async () => [] }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.overall.status, 'error');
    assert.strictEqual(health.dnr.staticRulesetsOk, false);
  });

  await t.test('subscription errors return degraded', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        subscriptions: [{
          id: 'custom_1',
          name: 'Custom List',
          enabled: true,
          lastError: 'HTTP 500 from https://example.com/list.txt',
          ruleCount: { network: 10, cosmetic: 2, scriptlet: 1 }
        }]
      },
      userScripts: { register: async () => {}, getScripts: async () => [] }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.overall.status, 'degraded');
    assert.strictEqual(health.subscriptions.withErrors, 1);
    assert.strictEqual(health.subscriptions.errors[0].error.includes('https://example.com'), false);
  });

  await t.test('empty chroma hotfix list is excluded from user-facing subscription totals', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        subscriptions: [
          {
            id: 'oisd',
            name: 'OISD',
            enabled: true,
            ruleCount: { network: 10, cosmetic: 2, scriptlet: 0 }
          },
          {
            id: 'chroma-hotfix',
            name: 'Chroma Hotfix',
            enabled: true,
            ruleCount: { network: 0, cosmetic: 0, scriptlet: 0 }
          }
        ]
      },
      userScripts: { register: async () => {}, getScripts: async () => [] }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.subscriptions.total, 1);
    assert.strictEqual(health.subscriptions.enabled, 1);
    assert.strictEqual(health.subscriptions.parsedNetwork, 10);
  });

  await t.test('chroma hotfix list is included once it contains rules', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        subscriptions: [
          {
            id: 'oisd',
            name: 'OISD',
            enabled: true,
            ruleCount: { network: 10, cosmetic: 2, scriptlet: 0 }
          },
          {
            id: 'chroma-hotfix',
            name: 'Chroma Hotfix',
            enabled: true,
            ruleCount: { network: 1, cosmetic: 0, scriptlet: 0 }
          }
        ]
      },
      userScripts: { register: async () => {}, getScripts: async () => [] }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.subscriptions.total, 2);
    assert.strictEqual(health.subscriptions.enabled, 2);
    assert.strictEqual(health.subscriptions.parsedNetwork, 11);
  });

  await t.test('request logging unavailable is diagnostic only', async () => {
    const sandbox = loadHealthSandbox({
      debugLogging: false,
      userScripts: { register: async () => {}, getScripts: async () => [] }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.overall.status, 'healthy');
    assert.strictEqual(health.requestLog.available, false);
    assert.match(health.requestLog.note, /blocking can still work/i);
    assert.ok(health.overall.issues.some(issue => issue.area === 'requestLog' && issue.severity === 'info'));
  });

  await t.test('proxy health never exposes auth fields or proxy hosts', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        config: {
          enabled: true,
          networkBlocking: true,
          globalProxyEnabled: true,
          globalProxyId: 7
        },
        proxyConfigs: [{
          id: 7,
          name: 'Private',
          host: 'proxy.example.com',
          port: 8080,
          type: 'PROXY',
          accepted: true,
          domains: [{ host: 'media.example.com', enabled: true }],
          username: 'user-secret',
          password: 'pass-secret',
          authIv: 'iv-secret',
          authCipher: 'cipher-secret'
        }]
      },
      userScripts: { register: async () => {}, getScripts: async () => [] }
    });

    const health = await sandbox.getHealthStatus();
    const serialized = JSON.stringify(plain(health));

    assert.deepStrictEqual(plain(health.proxy), {
      configuredCount: 1,
      acceptedCount: 1,
      routedDomainCount: 1,
      globalProxyEnabled: true,
      globalProxyConfigured: true
    });
    assert.strictEqual(serialized.includes('proxy.example.com'), false);
    assert.strictEqual(serialized.includes('media.example.com'), false);
    assert.strictEqual(serialized.includes('user-secret'), false);
    assert.strictEqual(serialized.includes('pass-secret'), false);
    assert.strictEqual(serialized.includes('iv-secret'), false);
    assert.strictEqual(serialized.includes('cipher-secret'), false);
  });

  await t.test('dynamic rules are counted by documented ID ranges', async () => {
    const sandbox = loadHealthSandbox({
      dynamicRules: [
        { id: 1000 },
        { id: 99999 },
        { id: 100000 },
        { id: 8999999 },
        { id: 9000000 }
      ],
      storage: { appliedNetworkRuleCount: 2 },
      userScripts: { register: async () => {}, getScripts: async () => [] }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.dnr.dynamicRuleCount, 5);
    assert.strictEqual(health.dnr.defaultDynamicRuleCount, 2);
    assert.strictEqual(health.dnr.subscriptionDynamicRuleCount, 2);
    assert.strictEqual(health.dnr.whitelistRuleCount, 1);
    assert.strictEqual(health.dnr.appliedNetworkRuleCount, 5);
    assert.strictEqual(health.subscriptions.appliedNetwork, 2);
  });
});
