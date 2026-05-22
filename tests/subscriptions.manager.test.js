const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const managerJsRaw = fs.readFileSync(path.join(__dirname, '..', 'extension', 'subscriptions', 'manager.js'), 'utf8');

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function networkRule(urlFilter, actionType = 'block', overrides = {}) {
  return {
    priority: overrides.priority || (actionType === 'allow' ? 2 : 1),
    action: { type: actionType },
    condition: { urlFilter, ...(overrides.condition || {}) }
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
    TextDecoder,
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
      staticRules: [
        networkRule('||already-static.example^'),
        networkRule('||static-blocked-but-allowed.example^')
      ],
      parseList: () => ({
        networkRules: [
          networkRule('||already-static.example^'),
          networkRule('||fresh.example^'),
          networkRule('||static-blocked-but-allowed.example^', 'allow')
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
    assert.deepStrictEqual(plain(storage.sub_network_rules['sub-a'].map(r => r.condition.urlFilter)), ['||fresh.example^', '||static-blocked-but-allowed.example^']);
    assert.deepStrictEqual(plain(storage.sub_cosmetic_rules['sub-a']), [{ domains: ['example.com'], selector: '.ad', isException: false }]);
    assert.deepStrictEqual(plain(storage.sub_scriptlet_rules['sub-a'].map(r => r.scriptlet)), ['set-constant']);
    assert.deepStrictEqual(manager.appliedRules[0].map(r => ({
      urlFilter: r.condition.urlFilter,
      actionType: r.action.type
    })), [
      { urlFilter: '||fresh.example^', actionType: 'block' },
      { urlFilter: '||static-blocked-but-allowed.example^', actionType: 'allow' }
    ]);
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

  await t.test('refreshSubscription stores validators and sends conditional headers on later refreshes', async () => {
    const storage = {
      subscriptions: [{
        id: 'sub-a',
        name: 'Sub A',
        url: 'https://lists.example/sub-a.txt',
        enabled: true,
        lastUpdated: 0,
        version: null,
        lastError: null
      }]
    };
    const requestHeaders = [];
    let fetchCount = 0;
    const manager = loadManager({
      storage,
      fetch: async (url, init = {}) => {
        if (String(url).startsWith('chrome-extension://')) return { ok: true, json: async () => [] };
        requestHeaders.push(plain(init.headers || {}));
        fetchCount++;
        if (fetchCount === 1) {
          return {
            ok: true,
            headers: {
              get: name => {
                const lower = name.toLowerCase();
                if (lower === 'etag') return '"abc123"';
                if (lower === 'last-modified') return 'Fri, 22 May 2026 00:00:00 GMT';
                return null;
              }
            },
            text: async () => 'first body'
          };
        }
        return {
          ok: true,
          status: 304,
          headers: { get: () => null },
          text: async () => {
            throw new Error('304 body should not be read');
          }
        };
      },
      parseList: () => ({
        networkRules: [networkRule('||fresh.example^')],
        cosmeticRules: [],
        scriptletRules: [],
        skipped: {}
      })
    });

    const first = await manager.refreshSubscription('sub-a');
    assert.deepStrictEqual(plain(first), { ok: true });
    assert.strictEqual(storage.subscriptions[0].etag, '"abc123"');
    assert.strictEqual(storage.subscriptions[0].lastModified, 'Fri, 22 May 2026 00:00:00 GMT');

    const previousUpdated = storage.subscriptions[0].lastUpdated;
    const second = await manager.refreshSubscription('sub-a');
    assert.deepStrictEqual(plain(second), { ok: true, notModified: true });
    assert.deepStrictEqual(requestHeaders[0], {});
    assert.deepStrictEqual(requestHeaders[1], {
      'If-None-Match': '"abc123"',
      'If-Modified-Since': 'Fri, 22 May 2026 00:00:00 GMT'
    });
    assert.ok(storage.subscriptions[0].lastUpdated >= previousUpdated);
    assert.strictEqual(manager.appliedRules.length, 1);
  });

  await t.test('refreshSubscription does not commit parsed rules or success metadata when DNR apply fails', async () => {
    const storage = {
      subscriptions: [{
        id: 'sub-a',
        name: 'Sub A',
        url: 'https://lists.example/sub-a.txt',
        enabled: true,
        lastUpdated: 111,
        version: 'old-version',
        lastError: null,
        ruleCount: { network: 0, cosmetic: 0, scriptlet: 0 }
      }],
      sub_network_rules: {
        'sub-a': [networkRule('||old.example^')]
      },
      sub_cosmetic_rules: {
        'sub-a': [{ domains: null, selector: '.old', isException: false }]
      },
      sub_scriptlet_rules: {
        'sub-a': []
      },
      subscriptionCosmeticRules: [{ domains: null, selector: '.old', isException: false }],
      appliedNetworkRuleCount: 1
    };
    const manager = loadManager({
      storage,
      parseList: () => ({
        networkRules: [networkRule('||new.example^')],
        cosmeticRules: [{ domains: null, selector: '.new', isException: false }],
        scriptletRules: [],
        skipped: {}
      }),
      applySubscriptionRules: async () => {
        throw new Error('DNR apply failed');
      }
    });

    const result = await manager.refreshSubscription('sub-a');

    assert.strictEqual(result.ok, false);
    assert.match(result.error, /DNR apply failed/);
    assert.deepStrictEqual(plain(storage.sub_network_rules['sub-a'].map(r => r.condition.urlFilter)), ['||old.example^']);
    assert.deepStrictEqual(plain(storage.sub_cosmetic_rules['sub-a']), [{ domains: null, selector: '.old', isException: false }]);
    assert.deepStrictEqual(plain(storage.subscriptionCosmeticRules), [{ domains: null, selector: '.old', isException: false }]);
    assert.strictEqual(storage.subscriptions[0].lastUpdated, 111);
    assert.strictEqual(storage.subscriptions[0].version, 'old-version');
    assert.deepStrictEqual(plain(storage.subscriptions[0].ruleCount), { network: 0, cosmetic: 0, scriptlet: 0 });
    assert.match(storage.subscriptions[0].lastError, /DNR apply failed/);
  });

  await t.test('static dedupe keeps semantically distinct subscription rules with the same urlFilter', async () => {
    const storage = {
      subscriptions: [{
        id: 'sub-a',
        name: 'Sub A',
        url: 'https://lists.example/sub-a.txt',
        enabled: true
      }]
    };
    const manager = loadManager({
      storage,
      staticRules: [
        networkRule('||same.example^'),
        networkRule('||resource.example^', 'block', { condition: { resourceTypes: ['script'] } }),
        networkRule('||domain.example^', 'block', { condition: { domainType: 'thirdParty' } }),
        networkRule('||initiator.example^', 'block', { condition: { initiatorDomains: ['example.com'] } }),
        networkRule('||excluded.example^', 'block', { condition: { excludedInitiatorDomains: ['example.com'] } }),
        networkRule('||priority.example^', 'block', { priority: 3 })
      ],
      parseList: () => ({
        networkRules: [
          networkRule('||same.example^'),
          networkRule('||resource.example^', 'block', { condition: { resourceTypes: ['image'] } }),
          networkRule('||domain.example^', 'block', { condition: { domainType: 'firstParty' } }),
          networkRule('||initiator.example^', 'block', { condition: { initiatorDomains: ['news.example'] } }),
          networkRule('||excluded.example^', 'block', { condition: { excludedInitiatorDomains: ['news.example'] } }),
          networkRule('||priority.example^', 'block', { priority: 1 })
        ],
        cosmeticRules: [],
        scriptletRules: [],
        skipped: {}
      })
    });

    const result = await manager.refreshSubscription('sub-a');

    assert.deepStrictEqual(plain(result), { ok: true });
    assert.deepStrictEqual(plain(storage.sub_network_rules['sub-a'].map(r => r.condition.urlFilter)), [
      '||resource.example^',
      '||domain.example^',
      '||initiator.example^',
      '||excluded.example^',
      '||priority.example^'
    ]);
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

  await t.test('refreshSubscription rejects oversized subscription bodies before parsing', async () => {
    for (const scenario of [
      {
        name: 'content-length precheck',
        fetch: async (url) => String(url).startsWith('chrome-extension://')
          ? { ok: true, json: async () => [] }
          : {
              ok: true,
              headers: { get: name => name.toLowerCase() === 'content-length' ? String(11 * 1024 * 1024) : null },
              text: async () => {
                throw new Error('text should not be read after content-length rejection');
              }
            }
      },
      {
        name: 'streaming read cap',
        fetch: async (url) => String(url).startsWith('chrome-extension://')
          ? { ok: true, json: async () => [] }
          : {
              ok: true,
              headers: { get: () => null },
              body: {
                getReader: () => {
                  let remaining = 11;
                  return {
                    async read() {
                      if (remaining-- <= 0) return { done: true };
                      return { done: false, value: Buffer.alloc(1024 * 1024, 65) };
                    },
                    async cancel() {}
                  };
                }
              },
              text: async () => {
                throw new Error('text fallback should not be used for streams');
              }
            }
      }
    ]) {
      const storage = {
        subscriptions: [{ id: scenario.name, name: scenario.name, url: `https://lists.example/${scenario.name}.txt`, enabled: true }]
      };
      let parseCalled = false;
      const manager = loadManager({
        storage,
        fetch: scenario.fetch,
        parseList: () => {
          parseCalled = true;
          return { networkRules: [], cosmeticRules: [], scriptletRules: [], skipped: {} };
        }
      });

      const result = await manager.refreshSubscription(scenario.name);

      assert.strictEqual(result.ok, false, scenario.name);
      assert.match(result.error, /Subscription list too large/, scenario.name);
      assert.match(storage.subscriptions[0].lastError, /Subscription list too large/, scenario.name);
      assert.strictEqual(parseCalled, false, scenario.name);
      assert.strictEqual(manager.appliedRules.length, 0, scenario.name);
    }
  });

  await t.test('refreshSubscription reuses static url filter cache across refreshes', async () => {
    const storage = {
      subscriptions: [
        { id: 'sub-a', name: 'Sub A', url: 'https://lists.example/sub-a.txt', enabled: true },
        { id: 'sub-b', name: 'Sub B', url: 'https://lists.example/sub-b.txt', enabled: true }
      ]
    };
    let staticFetchCount = 0;
    const manager = loadManager({
      storage,
      fetch: async (url) => {
        if (String(url).startsWith('chrome-extension://')) {
          staticFetchCount++;
          return { ok: true, json: async () => [networkRule('||already-static.example^')] };
        }
        return { ok: true, text: async () => 'subscription body' };
      },
      parseList: () => ({
        networkRules: [
          networkRule('||already-static.example^'),
          networkRule('||fresh.example^')
        ],
        cosmeticRules: [],
        scriptletRules: [],
        skipped: {}
      })
    });

    assert.deepStrictEqual(plain(await manager.refreshSubscription('sub-a')), { ok: true });
    assert.deepStrictEqual(plain(await manager.refreshSubscription('sub-b')), { ok: true });

    assert.strictEqual(staticFetchCount, 1);
    assert.deepStrictEqual(plain(storage.sub_network_rules['sub-a'].map(r => r.condition.urlFilter)), ['||fresh.example^']);
    assert.deepStrictEqual(plain(storage.sub_network_rules['sub-b'].map(r => r.condition.urlFilter)), ['||fresh.example^']);
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

  await t.test('initSubscriptions migrates missing defaults while preserving user state and custom lists', async () => {
    const manager = loadManager({
      storage: {
        subscriptions: [
          {
            id: 'default-a',
            name: 'Old Name',
            url: 'https://old.example/list.txt',
            enabled: false,
            intervalHours: 12,
            lastUpdated: 123,
            version: 'v1',
            lastError: 'old error',
            ruleCount: { network: 1, cosmetic: 2, scriptlet: 3 },
            etag: '"old"'
          },
          {
            id: 'custom-a',
            name: 'Custom A',
            url: 'https://custom.example/list.txt',
            enabled: true,
            isCustom: true,
            intervalHours: 48
          }
        ]
      },
      defaultSubscriptions: [
        {
          id: 'default-a',
          name: 'Default A',
          url: 'https://new.example/list.txt',
          enabled: true,
          intervalHours: 24,
          lastUpdated: 0,
          version: null,
          lastError: null,
          ruleCount: { network: 0, cosmetic: 0, scriptlet: 0 }
        },
        {
          id: 'default-b',
          name: 'Default B',
          url: 'https://defaults.example/b.txt',
          enabled: true,
          cosmeticOnly: true,
          intervalHours: 6,
          lastUpdated: 0,
          version: null,
          lastError: null,
          ruleCount: { network: 0, cosmetic: 0, scriptlet: 0 }
        }
      ]
    });

    await manager.initSubscriptions();

    assert.deepStrictEqual(plain(manager.storage.subscriptions.map(sub => sub.id)), ['default-a', 'custom-a', 'default-b']);
    assert.deepStrictEqual(plain(manager.storage.subscriptions[0]), {
      id: 'default-a',
      name: 'Default A',
      url: 'https://new.example/list.txt',
      enabled: false,
      intervalHours: 24,
      lastUpdated: 123,
      version: 'v1',
      lastError: 'old error',
      ruleCount: { network: 1, cosmetic: 2, scriptlet: 3 },
      etag: '"old"'
    });
    assert.strictEqual(manager.storage.subscriptions[1].isCustom, true);
    assert.strictEqual(manager.storage.subscriptions[2].id, 'default-b');
  });
});

function storageSnapshot(value) {
  return plain(value);
}
