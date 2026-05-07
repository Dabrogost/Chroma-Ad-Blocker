const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const managerJsRaw = fs.readFileSync(path.join(__dirname, '..', 'extension', 'subscriptions', 'manager.js'), 'utf8');

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function networkRule(urlFilter, actionType = 'block') {
  return {
    priority: actionType === 'allow' ? 2 : 1,
    action: { type: actionType },
    condition: { urlFilter }
  };
}

function loadManager(options = {}) {
  const storage = options.storage || {};
  const appliedRules = [];
  const clearedRules = [];
  const alarmsCreated = [];
  const parseList = options.parseList || (() => ({
    networkRules: [],
    cosmeticRules: [],
    scriptletRules: [],
    skipped: {}
  }));
  const managerJsCode = managerJsRaw
    .replace(/import\s*\{\s*DEFAULT_SUBSCRIPTIONS\s*\}\s*from\s*['"]\.\/lists\.js['"];?/, 'var DEFAULT_SUBSCRIPTIONS = globalThis._DEFAULT_SUBSCRIPTIONS;')
    .replace(/import\s*\{\s*parseList\s*\}\s*from\s*['"]\.\/parser\.js['"];?/, 'var parseList = globalThis._parseList;')
    .replace(/import\s*\{\s*allocate\s*\}\s*from\s*['"]\.\/budget\.js['"];?/, 'var allocate = globalThis._allocate;')
    .replace(/import\s*\{\s*applySubscriptionRules,\s*clearSubscriptionRules\s*\}\s*from\s*['"]\.\/dnr\.js['"];?/, `
      var applySubscriptionRules = globalThis._applySubscriptionRules;
      var clearSubscriptionRules = globalThis._clearSubscriptionRules;
    `)
    .replace(/import\s*\{\s*SCRIPTLET_MAP\s*\}\s*from\s*['"]\.\.\/scriptlets\/lib\.js['"];?/, 'var SCRIPTLET_MAP = globalThis._SCRIPTLET_MAP;')
    .replace('const FETCH_TIMEOUT  = 30000;', `const FETCH_TIMEOUT  = ${options.fetchTimeout || 30000};`)
    .replace(/^export\s+/gm, '')
    + `
      globalThis.__managerExports = {
        initSubscriptions,
        ensureAlarm,
        refreshAllStale,
        refreshSubscription,
        getSubscriptions,
        setSubscriptionEnabled,
        addSubscription,
        removeSubscription
      };
    `;

  const chrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (Array.isArray(keys)) {
            const result = {};
            for (const key of keys) result[key] = storage[key];
            return result;
          }
          if (typeof keys === 'string') return { [keys]: storage[keys] };
          return { ...storage };
        },
        set: async (values) => {
          Object.assign(storage, values);
        }
      }
    },
    alarms: {
      get: async (name) => options.existingAlarm ? { name } : null,
      create: (name, info) => {
        alarmsCreated.push({ name, info });
      }
    },
    runtime: {
      getManifest: () => ({
        declarative_net_request: {
          rule_resources: options.ruleResources || [
            { id: 'static_test_rules', enabled: true, path: 'rules/rules_oisd_1.json' }
          ]
        }
      }),
      getURL: file => `chrome-extension://chroma/${file}`
    }
  };

  const sandbox = {
    chrome,
    console,
    fetch: options.fetch || (async (url) => {
      if (String(url).startsWith('chrome-extension://')) {
        return { ok: true, json: async () => options.staticRules || [] };
      }
      return { ok: true, text: async () => options.fetchText || '' };
    }),
    setTimeout,
    clearTimeout,
    AbortController,
    Date: options.Date || Date,
    _DEFAULT_SUBSCRIPTIONS: options.defaultSubscriptions || [],
    _parseList: parseList,
    _allocate: options.allocate || ((rules) => ({
      allocated: rules.map(({ _listPosition, ...rule }) => rule),
      trimCount: 0
    })),
    _applySubscriptionRules: options.applySubscriptionRules || (async (rules) => {
      appliedRules.push(plain(rules));
    }),
    _clearSubscriptionRules: options.clearSubscriptionRules || (async () => {
      clearedRules.push(true);
    }),
    _SCRIPTLET_MAP: options.scriptletMap || new Map([['set-constant', () => {}], ['json-prune', () => {}]])
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(managerJsCode, sandbox);

  return {
    ...sandbox.__managerExports,
    storage,
    appliedRules,
    clearedRules,
    alarmsCreated
  };
}

test('Subscription lifecycle manager', async (t) => {
  await t.test('refreshSubscription success stores parsed rules, filters static duplicates, and updates metadata', async () => {
    const storage = {
      subscriptions: [{
        id: 'sub-a',
        name: 'Sub A',
        url: 'https://lists.example/sub-a.txt',
        enabled: true,
        lastUpdated: 0,
        version: null,
        lastError: 'old error',
        ruleCount: { network: 0, cosmetic: 0, scriptlet: 0 }
      }]
    };
    const manager = loadManager({
      storage,
      staticRules: [networkRule('||already-static.example^')],
      parseList: () => ({
        networkRules: [
          networkRule('||already-static.example^'),
          networkRule('||fresh.example^'),
          networkRule('||allow.example^', 'allow')
        ],
        cosmeticRules: [{ domains: ['example.com'], selector: '.ad', isException: false }],
        scriptletRules: [
          { domains: ['example.com'], scriptlet: 'set-constant', args: ['foo', 'true'], runAt: 'document_start' },
          { domains: ['example.com'], scriptlet: 'missing-scriptlet', args: [], runAt: 'document_start' }
        ],
        skipped: {}
      })
    });

    const result = await manager.refreshSubscription('sub-a');

    assert.deepStrictEqual(plain(result), { ok: true });
    assert.deepStrictEqual(plain(storage.sub_network_rules['sub-a'].map(r => r.condition.urlFilter)), ['||fresh.example^', '||allow.example^']);
    assert.deepStrictEqual(plain(storage.sub_cosmetic_rules['sub-a']), [{ domains: ['example.com'], selector: '.ad', isException: false }]);
    assert.deepStrictEqual(plain(storage.sub_scriptlet_rules['sub-a'].map(r => r.scriptlet)), ['set-constant']);
    assert.deepStrictEqual(manager.appliedRules[0].map(r => r.condition.urlFilter), ['||fresh.example^']);
    assert.deepStrictEqual(plain(storage.subscriptionCosmeticRules), [{ domains: ['example.com'], selector: '.ad', isException: false }]);
    assert.deepStrictEqual(plain(storage.subscriptionScriptletRules.map(r => ({
      scriptlet: r.scriptlet,
      sourceId: r.sourceId
    }))), [{ scriptlet: 'set-constant', sourceId: 'sub-a' }]);
    assert.deepStrictEqual(plain(storage.subscriptions[0].ruleCount), { network: 2, cosmetic: 1, scriptlet: 1 });
    assert.strictEqual(storage.subscriptions[0].lastError, null);
    assert.ok(storage.subscriptions[0].lastUpdated > 0);
    assert.ok(/^\d+$/.test(storage.subscriptions[0].version));
  });

  await t.test('refreshSubscription reports missing and disabled subscriptions without fetch side effects', async () => {
    let fetchCount = 0;
    const manager = loadManager({
      storage: {
        subscriptions: [{ id: 'disabled', name: 'Disabled', url: 'https://lists.example/disabled.txt', enabled: false }]
      },
      fetch: async () => {
        fetchCount++;
        return { ok: true, text: async () => '' };
      }
    });

    assert.deepStrictEqual(plain(await manager.refreshSubscription('missing')), { ok: false, error: 'Subscription not found' });
    assert.deepStrictEqual(plain(await manager.refreshSubscription('disabled')), { ok: false, error: 'Subscription disabled' });
    assert.strictEqual(fetchCount, 0);
  });

  await t.test('refreshSubscription stores lastError on HTTP, timeout, and parse failures', async () => {
    for (const scenario of [
      {
        name: 'HTTP failure',
        fetch: async (url) => String(url).startsWith('chrome-extension://')
          ? { ok: true, json: async () => [] }
          : { ok: false, status: 503, text: async () => '' },
        parseList: undefined,
        pattern: /HTTP 503/
      },
      {
        name: 'timeout',
        fetchTimeout: 5,
        fetch: async (url, init = {}) => {
          if (String(url).startsWith('chrome-extension://')) return { ok: true, json: async () => [] };
          return new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('AbortError')));
          });
        },
        parseList: undefined,
        pattern: /AbortError/
      },
      {
        name: 'parse failure',
        fetch: async (url) => String(url).startsWith('chrome-extension://')
          ? { ok: true, json: async () => [] }
          : { ok: true, text: async () => 'bad list' },
        parseList: () => {
          throw new Error('parse exploded');
        },
        pattern: /parse exploded/
      }
    ]) {
      const storage = {
        subscriptions: [{ id: scenario.name, name: scenario.name, url: `https://lists.example/${scenario.name}.txt`, enabled: true }]
      };
      const manager = loadManager({
        storage,
        fetch: scenario.fetch,
        parseList: scenario.parseList,
        fetchTimeout: scenario.fetchTimeout
      });

      const result = await manager.refreshSubscription(scenario.name);

      assert.strictEqual(result.ok, false, scenario.name);
      assert.match(result.error, scenario.pattern, scenario.name);
      assert.match(storage.subscriptions[0].lastError, scenario.pattern, scenario.name);
      assert.strictEqual(manager.appliedRules.length, 0, scenario.name);
    }
  });

  await t.test('setSubscriptionEnabled rebuilds combined stores and clears DNR when all subscriptions are disabled', async () => {
    const storage = {
      subscriptions: [
        { id: 'sub-a', enabled: true },
        { id: 'sub-b', enabled: true }
      ],
      sub_network_rules: {
        'sub-a': [networkRule('||a.example^')],
        'sub-b': [networkRule('||b.example^')]
      },
      sub_cosmetic_rules: {
        'sub-a': [{ domains: null, selector: '.dup', isException: false }],
        'sub-b': [{ domains: null, selector: '.dup', isException: false }]
      },
      sub_scriptlet_rules: {
        'sub-a': [{ scriptlet: 'set-constant', args: [], runAt: 'document_start' }],
        'sub-b': [{ scriptlet: 'json-prune', args: [], runAt: 'document_start' }]
      }
    };
    const manager = loadManager({ storage });

    assert.deepStrictEqual(plain(await manager.setSubscriptionEnabled('sub-a', false)), { ok: true });
    assert.deepStrictEqual(manager.appliedRules[0].map(r => r.condition.urlFilter), ['||b.example^']);
    assert.deepStrictEqual(plain(storage.subscriptionCosmeticRules), [{ domains: null, selector: '.dup', isException: false }]);
    assert.deepStrictEqual(plain(storage.subscriptionScriptletRules.map(r => ({
      scriptlet: r.scriptlet,
      sourceId: r.sourceId
    }))), [{ scriptlet: 'json-prune', sourceId: 'sub-b' }]);
    assert.strictEqual(manager.clearedRules.length, 0);

    assert.deepStrictEqual(plain(await manager.setSubscriptionEnabled('sub-b', false)), { ok: true });
    assert.deepStrictEqual(manager.appliedRules[1], []);
    assert.strictEqual(manager.clearedRules.length, 1);
  });

  await t.test('removeSubscription deletes per-subscription stores and rebuilds remaining rules', async () => {
    const storage = {
      subscriptions: [
        { id: 'sub-a', enabled: true },
        { id: 'sub-b', enabled: true }
      ],
      sub_network_rules: {
        'sub-a': [networkRule('||a.example^')],
        'sub-b': [networkRule('||b.example^')]
      },
      sub_cosmetic_rules: {
        'sub-a': [{ domains: null, selector: '.a', isException: false }],
        'sub-b': [{ domains: null, selector: '.b', isException: false }]
      },
      sub_scriptlet_rules: {
        'sub-a': [{ scriptlet: 'set-constant', args: [], runAt: 'document_start' }],
        'sub-b': [{ scriptlet: 'json-prune', args: [], runAt: 'document_start' }]
      }
    };
    const manager = loadManager({ storage });

    assert.deepStrictEqual(plain(await manager.removeSubscription('sub-a')), { ok: true });
    assert.deepStrictEqual(plain(storage.subscriptions.map(s => s.id)), ['sub-b']);
    assert.strictEqual('sub-a' in storage.sub_network_rules, false);
    assert.strictEqual('sub-a' in storage.sub_cosmetic_rules, false);
    assert.strictEqual('sub-a' in storage.sub_scriptlet_rules, false);
    assert.deepStrictEqual(manager.appliedRules[0].map(r => r.condition.urlFilter), ['||b.example^']);
    assert.deepStrictEqual(plain(storage.subscriptionCosmeticRules), [{ domains: null, selector: '.b', isException: false }]);
    assert.deepStrictEqual(plain(storage.subscriptionScriptletRules.map(r => ({
      scriptlet: r.scriptlet,
      sourceId: r.sourceId
    }))), [{ scriptlet: 'json-prune', sourceId: 'sub-b' }]);
  });

  await t.test('initSubscriptions and ensureAlarm preserve restart-safe subscription alarm', async () => {
    const manager = loadManager({
      storage: {},
      defaultSubscriptions: [{ id: 'default-sub', enabled: true }]
    });

    await manager.initSubscriptions();
    await manager.ensureAlarm();

    assert.deepStrictEqual(storageSnapshot(manager.storage.subscriptions), [{ id: 'default-sub', enabled: true }]);
    assert.deepStrictEqual(plain(manager.alarmsCreated), [
      { name: 'chroma-subscription-check', info: { periodInMinutes: 60 } },
      { name: 'chroma-subscription-check', info: { periodInMinutes: 60 } }
    ]);
  });
});

function storageSnapshot(value) {
  return plain(value);
}
