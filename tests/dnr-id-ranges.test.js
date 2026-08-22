const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
const staticRulesetIds = manifest.declarative_net_request.rule_resources.map(resource => resource.id);

const budgetCode = '{\n' + fs.readFileSync(path.join(__dirname, '..', 'extension', 'subscriptions', 'budget.js'), 'utf8')
  .replace(/^export\s+/gm, '')
  + '\nglobalThis.__budget = { allocate, SUBSCRIPTION_ID_START, SUBSCRIPTION_ID_END };\n}\n';

const subscriptionDnrCode = '{\n' + fs.readFileSync(path.join(__dirname, '..', 'extension', 'subscriptions', 'dnr.js'), 'utf8')
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/budget\.js['"];?/, `
    var allocate = globalThis.__budget.allocate;
    var SUBSCRIPTION_ID_START = globalThis.__budget.SUBSCRIPTION_ID_START;
    var SUBSCRIPTION_ID_END = globalThis.__budget.SUBSCRIPTION_ID_END;
  `)
  .replace(/^export\s+/gm, '')
  + '\nglobalThis.__subscriptionDnr = { buildSubscriptionRuleApplication, prepareSubscriptionRules };\n}\n';

const dnrStateCode = '{\n' + fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'dnrState.js'), 'utf8')
  .replace('const DEBUG = false;', 'var DEBUG = false;')
  .replace("import { getDefaultDynamicRules } from './defaultDynamicRules.js';", 'var getDefaultDynamicRules = globalThis._getDefaultDynamicRules;')
  .replace("import { clearHealthDiagnostic, recordHealthDiagnostic } from './diagnostics.js';", 'var clearHealthDiagnostic = globalThis._clearHealthDiagnostic || (async () => {}); var recordHealthDiagnostic = globalThis._recordHealthDiagnostic || (async () => {});')
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*['"]\.\.\/subscriptions\/dnr\.js['"];?/, `
    var buildSubscriptionRuleApplication = globalThis.__subscriptionDnr.buildSubscriptionRuleApplication;
    var prepareSubscriptionRules = globalThis.__subscriptionDnr.prepareSubscriptionRules;
  `)
  .replace(/^export\s+/gm, '')
  + `
    globalThis.__dnrState = {
      classifyDnrMatch,
      isNetworkProtectionActive,
      reconcileNetworkDnr,
      updateDNRState,
      syncDynamicRules,
      syncWhitelistRules
    };
  `
  + '\n}\n';

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function subscriptionRule(index) {
  return {
    priority: 1,
    action: { type: 'block' },
    condition: { urlFilter: `||subscription-${String(index).padStart(5, '0')}.example^` },
    _listPosition: index
  };
}

function regexSubscriptionRule(regexFilter, { action = 'block', priority = 1, position = 0 } = {}) {
  return {
    priority,
    action: { type: action },
    condition: { regexFilter },
    _listPosition: position
  };
}

function conditionMatchesRequest(condition, request) {
  if (condition.resourceTypes && !condition.resourceTypes.includes(request.resourceType)) return false;
  if (condition.requestDomains && !condition.requestDomains.includes(request.requestDomain)) return false;
  if (condition.initiatorDomains && !condition.initiatorDomains.includes(request.initiatorDomain)) return false;
  return true;
}

function loadDnrState({
  storage = {},
  existingRules = [],
  existingEnabledRulesets = staticRulesetIds,
  beforeGetDynamicRules,
  beforeDynamicUpdate,
  beforeEnabledRulesetsUpdate,
  regexSupport = async () => ({ isSupported: true }),
  maxRegexRules = 1000,
  onClearHealthDiagnostic,
  onRecordHealthDiagnostic,
  onBudgetAllocate
} = {}) {
  let dynamicRules = plain(existingRules);
  let enabledRulesets = new Set(existingEnabledRulesets);
  const clearedHealthDiagnostics = [];
  const recordedHealthDiagnostics = [];
  const getDynamicRulesCalls = [];
  const updateDynamicRulesCalls = [];
  const getEnabledRulesetsCalls = [];
  const updateEnabledRulesetsAttempts = [];
  const updateEnabledRulesetsCalls = [];
  const chrome = {
    runtime: {
      getManifest: () => manifest
    },
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
        set: async (values) => Object.assign(storage, plain(values))
      }
    },
    declarativeNetRequest: {
      MAX_NUMBER_OF_REGEX_RULES: maxRegexRules,
      ...(typeof regexSupport === 'function' ? { isRegexSupported: regexSupport } : {}),
      getDynamicRules: async () => {
        const callIndex = getDynamicRulesCalls.length;
        getDynamicRulesCalls.push({});
        if (beforeGetDynamicRules) await beforeGetDynamicRules(callIndex);
        return plain(dynamicRules);
      },
      updateDynamicRules: async (args) => {
        if (beforeDynamicUpdate) await beforeDynamicUpdate(args, updateDynamicRulesCalls.length);
        updateDynamicRulesCalls.push(plain(args));
        const remove = new Set(args.removeRuleIds || []);
        dynamicRules = dynamicRules.filter(rule => !remove.has(rule.id));
        dynamicRules.push(...plain(args.addRules || []));
      },
      getEnabledRulesets: async () => {
        getEnabledRulesetsCalls.push({});
        return [...enabledRulesets];
      },
      updateEnabledRulesets: async (args) => {
        const callIndex = updateEnabledRulesetsAttempts.length;
        updateEnabledRulesetsAttempts.push(plain(args));
        if (beforeEnabledRulesetsUpdate) {
          await beforeEnabledRulesetsUpdate(args, callIndex);
        }
        updateEnabledRulesetsCalls.push(plain(args));
        for (const id of args.disableRulesetIds || []) enabledRulesets.delete(id);
        for (const id of args.enableRulesetIds || []) enabledRulesets.add(id);
      }
    }
  };
  const sandbox = {
    chrome,
    console,
    _clearHealthDiagnostic: async id => {
      clearedHealthDiagnostics.push(id);
      if (onClearHealthDiagnostic) await onClearHealthDiagnostic(id);
    },
    _recordHealthDiagnostic: async (id, entry) => {
      recordedHealthDiagnostics.push({ id, entry: plain(entry) });
      if (onRecordHealthDiagnostic) await onRecordHealthDiagnostic(id, entry);
    },
    _getDefaultDynamicRules: ({ trackingUrlCleanup = true } = {}) => [
      { id: 1000, priority: 4, action: { type: 'allow' }, condition: { urlFilter: '||default.example^' } },
      ...(trackingUrlCleanup
        ? [{ id: 2000, priority: 1, action: { type: 'redirect' }, condition: { regexFilter: '^https://example\\.com/' } }]
        : [])
    ]
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(budgetCode, sandbox);
  if (onBudgetAllocate) {
    const nativeAllocate = sandbox.__budget.allocate;
    sandbox.__budget.allocate = (rules, cap) => {
      onBudgetAllocate({ candidateCount: rules.length, cap });
      return nativeAllocate(rules, cap);
    };
  }
  vm.runInContext(subscriptionDnrCode, sandbox);
  vm.runInContext(dnrStateCode, sandbox);

  return {
    ...sandbox.__dnrState,
    subscriptionDnr: sandbox.__subscriptionDnr,
    storage,
    clearedHealthDiagnostics,
    recordedHealthDiagnostics,
    getDynamicRules: () => plain(dynamicRules),
    getEnabledRulesets: () => [...enabledRulesets],
    getDynamicRulesCalls,
    updateDynamicRulesCalls,
    getEnabledRulesetsCalls,
    updateEnabledRulesetsAttempts,
    updateEnabledRulesetsCalls
  };
}

test('Network DNR reconciliation', async (t) => {
  await t.test('subscription preparation assigns isolated deterministic IDs and rejects invalid rules', () => {
    const dnr = loadDnrState();
    const prepared = dnr.subscriptionDnr.prepareSubscriptionRules([
      subscriptionRule(0),
      subscriptionRule(1)
    ]);
    assert.deepStrictEqual(plain(prepared.map(rule => rule.id)), [100000, 100001]);

    assert.throws(
      () => dnr.subscriptionDnr.prepareSubscriptionRules([
        { priority: 1, action: { type: 'redirect' }, condition: { urlFilter: '||bad.example^' } }
      ]),
      /unsupported action/
    );
    assert.throws(
      () => dnr.subscriptionDnr.prepareSubscriptionRules([
        { priority: 1, action: { type: 'block' }, condition: { regexFilter: '[' } }
      ]),
      /does not compile/
    );
  });

  await t.test('a malformed cached domain constraint cannot poison valid sibling DNR rules', async () => {
    const dnr = loadDnrState();
    const subscriptions = [{ id: 'list-a', enabled: true }];
    const application = await dnr.subscriptionDnr.buildSubscriptionRuleApplication(subscriptions, {
      'list-a': [
        subscriptionRule(0),
        {
          priority: 1,
          action: { type: 'block' },
          condition: {
            urlFilter: '||malformed.example^',
            excludedInitiatorDomains: ['~example.com']
          }
        },
        {
          priority: 1,
          action: { type: 'block' },
          condition: {
            urlFilter: '||invalid-ip.example^',
            initiatorDomains: ['999.1.1.1']
          }
        },
        subscriptionRule(1)
      ]
    });

    assert.strictEqual(application.appliedNetworkRuleCount, 2);
    assert.deepStrictEqual(plain(application.appliedNetworkRulesPerSub), { 'list-a': 2 });
    assert.deepStrictEqual(
      plain(application.networkRules.map(rule => rule.condition.urlFilter)),
      ['||subscription-00000.example^', '||subscription-00001.example^']
    );
    assert.deepStrictEqual(
      plain(dnr.subscriptionDnr.prepareSubscriptionRules(application.networkRules).map(rule => rule.id)),
      [100000, 100001]
    );
  });

  await t.test('non-ASCII cached filters are dropped individually before browser reconciliation', async () => {
    const regexChecks = [];
    const dnr = loadDnrState({
      regexSupport: async details => {
        regexChecks.push(plain(details));
        return { isSupported: true };
      }
    });
    const application = await dnr.subscriptionDnr.buildSubscriptionRuleApplication(
      [{ id: 'legacy-list', enabled: true }],
      {
        'legacy-list': [
          subscriptionRule(0),
          {
            priority: 1,
            action: { type: 'block' },
            condition: { urlFilter: '||cdn.example/caf\u00e9.js' }
          },
          regexSubscriptionRule('^https://cdn\\.example/\u5e7f\u544a\\.js$'),
          regexSubscriptionRule('^https://cdn\\.example/encoded\\.js$'),
          subscriptionRule(1)
        ]
      }
    );

    assert.deepStrictEqual(regexChecks.map(check => check.regex), [
      '^https://cdn\\.example/encoded\\.js$'
    ], 'only the structurally valid regex should reach browser preflight');
    assert.strictEqual(application.appliedNetworkRuleCount, 3);
    assert.deepStrictEqual(plain(application.appliedNetworkRulesPerSub), { 'legacy-list': 3 });
    assert.strictEqual(application.subscriptionStats['legacy-list'].structurallySkippedNetworkRuleCount, 2);
    assert.deepStrictEqual(
      plain(application.networkRules.map(rule => rule.condition.urlFilter).filter(Boolean)),
      ['||subscription-00000.example^', '||subscription-00001.example^']
    );
    assert.deepStrictEqual(
      plain(application.networkRules.map(rule => rule.condition.regexFilter).filter(Boolean)),
      ['^https://cdn\\.example/encoded\\.js$']
    );
  });

  await t.test('browser-incompatible regex is dropped only from its owner and valid sibling lists still commit', async () => {
    const checks = [];
    const storage = {
      config: { enabled: true, networkBlocking: true, trackingUrlCleanup: false },
      subscriptions: [
        { id: 'unbreak-like', enabled: true, version: 'u1' },
        { id: 'quick-like', enabled: true, version: 'q1' }
      ],
      sub_network_rules: {
        'unbreak-like': [
          subscriptionRule(1),
          regexSubscriptionRule('^https?://(?:[^/?#:]+\\.)*unsupported\\.example/')
        ],
        'quick-like': [subscriptionRule(2)]
      }
    };
    const dnr = loadDnrState({
      storage,
      regexSupport: async details => {
        checks.push(plain(details));
        return details.regex.includes('unsupported')
          ? { isSupported: false, reason: 'memoryLimitExceeded' }
          : { isSupported: true };
      }
    });

    await dnr.reconcileNetworkDnr('subscription-refresh');

    const installed = dnr.getDynamicRules().filter(rule => rule.id >= 100000 && rule.id < 9000000);
    assert.deepStrictEqual(installed.map(rule => rule.condition.urlFilter), [
      '||subscription-00001.example^',
      '||subscription-00002.example^'
    ]);
    assert.strictEqual(checks.length, 1);
    assert.deepStrictEqual(checks[0], {
      regex: '^https?://(?:[^/?#:]+\\.)*unsupported\\.example/',
      isCaseSensitive: false,
      requireCapturing: false
    });
    assert.strictEqual(storage.appliedNetworkStateVersion, 1);
    assert.deepStrictEqual(storage.appliedNetworkRulesPerSub, {
      'unbreak-like': 1,
      'quick-like': 1
    });
    assert.deepStrictEqual(storage.browserUnsupportedRegexRulesPerSub, {
      'unbreak-like': 1,
      'quick-like': 0
    });
    assert.strictEqual(storage.subscriptionNetworkRuntime.perSub['unbreak-like'].sourceVersion, 'u1');
    assert.strictEqual(
      storage.subscriptionNetworkRuntime.perSub['unbreak-like'].browserUnsupportedRegexRuleCount,
      1
    );
    assert.strictEqual(storage.subscriptionNetworkRuntime.perSub['quick-like'].appliedNetworkRuleCount, 1);
  });

  await t.test('regex preflight is deduplicated and runs before budget allocation so valid rules backfill', async () => {
    let checkCount = 0;
    const checker = async ({ regex }) => {
      checkCount++;
      return regex === '^unsupported$'
        ? { isSupported: false, reason: 'memoryLimitExceeded' }
        : { isSupported: true };
    };
    const dnr = loadDnrState({ regexSupport: checker });
    const application = await dnr.subscriptionDnr.buildSubscriptionRuleApplication(
      [
        { id: 'list-a', enabled: true },
        { id: 'list-b', enabled: true }
      ],
      {
        'list-a': [
          regexSubscriptionRule('^unsupported$', { action: 'allow' }),
          subscriptionRule(10),
          regexSubscriptionRule('^shared$')
        ],
        'list-b': [
          subscriptionRule(11),
          regexSubscriptionRule('^shared$')
        ]
      },
      { isRegexSupported: checker, ruleLimit: 4 }
    );

    assert.strictEqual(checkCount, 2, 'two distinct regexes should produce two browser checks');
    assert.strictEqual(application.appliedNetworkRuleCount, 4);
    assert.strictEqual(application.networkRules.some(rule => rule.condition.regexFilter === '^unsupported$'), false);
    assert.deepStrictEqual(plain(application.browserUnsupportedRegexRulesPerSub), {
      'list-a': 1,
      'list-b': 0
    });
    assert.deepStrictEqual(plain(application.appliedNetworkRulesPerSub), {
      'list-a': 2,
      'list-b': 2
    });
  });

  await t.test('regex preflight work stays bounded for a large cache and compatible URL rules still apply', async () => {
    let checkCount = 0;
    const checker = async () => {
      checkCount++;
      return { isSupported: true };
    };
    const dnr = loadDnrState({ regexSupport: checker });
    const rules = [
      ...Array.from({ length: 10000 }, (_, index) =>
        regexSubscriptionRule(`^bounded-work-${index}$`, { position: index })
      ),
      subscriptionRule(70000),
      subscriptionRule(70001)
    ];

    const application = await dnr.subscriptionDnr.buildSubscriptionRuleApplication(
      [{ id: 'large-legacy-cache', enabled: true }],
      { 'large-legacy-cache': rules },
      { isRegexSupported: checker, regexRuleLimit: 1000 }
    );

    assert.strictEqual(checkCount, 1000, 'compatible top-priority candidates should fill the quota immediately');
    assert.strictEqual(checkCount <= 2000, true, 'browser checks must remain strictly bounded');
    assert.strictEqual(application.appliedNetworkRuleCount, 1002);
    assert.strictEqual(application.regexQuotaTrimCount, 9000);
    assert.deepStrictEqual(
      plain(application.networkRules.filter(rule => rule.condition.urlFilter).map(rule => rule.condition.urlFilter)),
      ['||subscription-70000.example^', '||subscription-70001.example^']
    );
    assert.deepStrictEqual(plain(application.appliedNetworkRulesPerSub), {
      'large-legacy-cache': 1002
    });
  });

  await t.test('regex backfill ranks an unbounded cache only once before using its bounded work pool', async () => {
    let checkCount = 0;
    const allocationCalls = [];
    const checker = async ({ regex }) => {
      checkCount++;
      return { isSupported: regex.startsWith('^supported-priority-') };
    };
    const dnr = loadDnrState({
      regexSupport: checker,
      onBudgetAllocate: call => allocationCalls.push(call)
    });
    const rules = [
      ...Array.from({ length: 1000 }, (_, index) =>
        regexSubscriptionRule(
          index === 999 ? '^unsupported-priority$' : `^supported-priority-${index}$`,
          { action: 'allow', position: index }
        )
      ),
      ...Array.from({ length: 9000 }, (_, index) =>
        regexSubscriptionRule(`^unsupported-reserve-${index}$`, { position: 1000 + index })
      )
    ];

    const application = await dnr.subscriptionDnr.buildSubscriptionRuleApplication(
      [{ id: 'large-backfill-cache', enabled: true }],
      { 'large-backfill-cache': rules },
      { isRegexSupported: checker, regexRuleLimit: 1000 }
    );

    assert.strictEqual(checkCount, 2000, 'backfill must stop at the bounded work limit');
    assert.strictEqual(application.appliedNetworkRuleCount, 999);
    assert.deepStrictEqual(
      allocationCalls.filter(call => call.candidateCount > 2000),
      [{ candidateCount: 10000, cap: 2000 }],
      'only the one-time work-pool selection may rank the unbounded cache'
    );
  });

  await t.test('unsupported priority regexes are attributed and bounded preflight backfills their slots', async () => {
    let checkCount = 0;
    const checker = async ({ regex }) => {
      checkCount++;
      return regex === '^unsupported-priority$'
        ? { isSupported: false, reason: 'memoryLimitExceeded' }
        : { isSupported: true };
    };
    const dnr = loadDnrState({ regexSupport: checker });
    const application = await dnr.subscriptionDnr.buildSubscriptionRuleApplication(
      [{ id: 'backfill-list', enabled: true }],
      {
        'backfill-list': [
          regexSubscriptionRule('^unsupported-priority$', { action: 'allow', position: 0 }),
          regexSubscriptionRule('^supported-one$', { position: 1 }),
          regexSubscriptionRule('^supported-two$', { position: 2 })
        ]
      },
      { isRegexSupported: checker, regexRuleLimit: 2 }
    );

    assert.strictEqual(checkCount, 3);
    assert.strictEqual(application.appliedNetworkRuleCount, 2);
    assert.strictEqual(application.browserUnsupportedRegexRuleCount, 1);
    assert.deepStrictEqual(plain(application.browserUnsupportedRegexRulesPerSub), {
      'backfill-list': 1
    });
    assert.strictEqual(application.regexQuotaTrimCount, 0);
    assert.deepStrictEqual(
      plain(application.networkRules.map(rule => rule.condition.regexFilter)),
      ['^supported-one$', '^supported-two$']
    );
  });

  await t.test('subscription regex quota is deterministic, owner-attributed, and reserves valid URL rules', async () => {
    const dnr = loadDnrState({ maxRegexRules: 2 });
    const storage = dnr.storage;
    Object.assign(storage, {
      config: { enabled: true, networkBlocking: true, trackingUrlCleanup: false },
      subscriptions: [{ id: 'quota-list', enabled: true }],
      sub_network_rules: {
        'quota-list': [
          regexSubscriptionRule('^ordinary-one$', { position: 0 }),
          regexSubscriptionRule('^ordinary-two$', { position: 1 }),
          regexSubscriptionRule('^allow-priority$', { action: 'allow', position: 2 }),
          subscriptionRule(20)
        ]
      }
    });

    await dnr.reconcileNetworkDnr('regex-quota');

    const installed = dnr.getDynamicRules().filter(rule => rule.id >= 100000 && rule.id < 9000000);
    assert.strictEqual(installed.length, 3);
    assert.ok(installed.some(rule => rule.condition.regexFilter === '^allow-priority$'));
    assert.ok(installed.some(rule => rule.condition.urlFilter === '||subscription-00020.example^'));
    assert.strictEqual(storage.regexQuotaTrimCount, 1);
    assert.deepStrictEqual(storage.regexQuotaTrimmedRulesPerSub, { 'quota-list': 1 });
    assert.strictEqual(storage.subscriptionNetworkRuntime.perSub['quota-list'].regexQuotaTrimCount, 1);
  });

  await t.test('subscription regex quota reserves capacity for default dynamic regex rules', async () => {
    const storage = {
      config: { enabled: true, networkBlocking: true, trackingUrlCleanup: true },
      subscriptions: [{ id: 'quota-list', enabled: true }],
      sub_network_rules: {
        'quota-list': [
          regexSubscriptionRule('^subscription-one$'),
          regexSubscriptionRule('^subscription-two$', { position: 1 })
        ]
      }
    };
    const dnr = loadDnrState({ storage, maxRegexRules: 2 });

    await dnr.reconcileNetworkDnr('regex-quota-default-reservation');

    const installedRegexRules = dnr.getDynamicRules().filter(rule => rule.condition?.regexFilter);
    assert.strictEqual(installedRegexRules.length, 2, 'one default and one subscription regex should fit');
    assert.strictEqual(installedRegexRules.filter(rule => rule.id >= 100000).length, 1);
    assert.strictEqual(storage.regexQuotaTrimCount, 1);
  });

  await t.test('tracking cleanup fallback reallocates its freed regex quota to subscription rules', async () => {
    let commitAttempts = 0;
    const storage = {
      config: { enabled: true, networkBlocking: true, trackingUrlCleanup: true },
      subscriptions: [{ id: 'quota-list', enabled: true }],
      sub_network_rules: {
        'quota-list': [
          regexSubscriptionRule('^subscription-one$'),
          regexSubscriptionRule('^subscription-two$', { position: 1 })
        ]
      }
    };
    const dnr = loadDnrState({
      storage,
      existingEnabledRulesets: [],
      maxRegexRules: 2,
      beforeDynamicUpdate: async () => {
        commitAttempts++;
        if (commitAttempts === 1) throw new Error('tracking cleanup rejected');
      }
    });

    await dnr.reconcileNetworkDnr('tracking-cleanup-fallback');

    const installed = dnr.getDynamicRules();
    const installedSubscriptionRegexes = installed.filter(rule =>
      rule.id >= 100000 && typeof rule.condition?.regexFilter === 'string'
    );
    assert.strictEqual(commitAttempts, 2);
    assert.strictEqual(installed.some(rule => rule.id === 2000), false);
    assert.strictEqual(installedSubscriptionRegexes.length, 2);
    assert.strictEqual(storage.appliedNetworkRuleCount, 2);
    assert.deepStrictEqual(storage.appliedNetworkRulesPerSub, { 'quota-list': 2 });
    assert.strictEqual(storage.regexQuotaTrimCount, 0);
    assert.deepStrictEqual(storage.regexQuotaTrimmedRulesPerSub, { 'quota-list': 0 });
    assert.strictEqual(storage.subscriptionNetworkRuntime.perSub['quota-list'].eligibleNetworkRuleCount, 2);
    assert.strictEqual(storage.subscriptionNetworkRuntime.perSub['quota-list'].appliedNetworkRuleCount, 2);
    assert.deepStrictEqual(dnr.getEnabledRulesets(), staticRulesetIds);
  });

  await t.test('post-commit diagnostic clear failure cannot trigger tracking cleanup fallback', async () => {
    let commitAttempts = 0;
    const storage = {
      config: { enabled: true, networkBlocking: true, trackingUrlCleanup: true }
    };
    const dnr = loadDnrState({
      storage,
      existingEnabledRulesets: [],
      beforeDynamicUpdate: async () => { commitAttempts++; },
      onClearHealthDiagnostic: async id => {
        if (id === 'trackingUrlCleanupSync') {
          throw new Error('diagnostic storage unavailable');
        }
      }
    });

    const result = await dnr.reconcileNetworkDnr('diagnostic-clear-failure');

    assert.strictEqual(result.ok, true);
    assert.strictEqual(commitAttempts, 1);
    assert.strictEqual(dnr.getDynamicRules().some(rule => rule.id === 2000), true);
    assert.deepStrictEqual(dnr.getEnabledRulesets(), staticRulesetIds);
    assert.strictEqual(storage.subscriptionNetworkRuntime.protectionActive, true);
  });

  await t.test('post-fallback diagnostic record failure cannot hide the committed runtime image', async () => {
    let commitAttempts = 0;
    const storage = {
      config: { enabled: true, networkBlocking: true, trackingUrlCleanup: true },
      subscriptions: [{ id: 'cached', enabled: true }],
      sub_network_rules: { cached: [subscriptionRule(88)] }
    };
    const dnr = loadDnrState({
      storage,
      beforeDynamicUpdate: async () => {
        commitAttempts++;
        if (commitAttempts === 1) throw new Error('tracking cleanup rejected');
      },
      onRecordHealthDiagnostic: async id => {
        if (id === 'trackingUrlCleanupSync') {
          throw new Error('diagnostic storage unavailable');
        }
      }
    });

    const result = await dnr.reconcileNetworkDnr('diagnostic-record-failure');

    assert.strictEqual(result.ok, true);
    assert.strictEqual(commitAttempts, 2);
    assert.strictEqual(dnr.getDynamicRules().some(rule => rule.id === 2000), false);
    assert.strictEqual(dnr.getDynamicRules().some(rule => rule.id === 100000), true);
    assert.strictEqual(dnr.classifyDnrMatch({ rule: { ruleId: 100000 } }).type, 'block');
    assert.strictEqual(storage.appliedNetworkRuleCount, 1);
    assert.deepStrictEqual(storage.appliedNetworkRulesPerSub, { cached: 1 });
    assert.strictEqual(storage.subscriptionNetworkRuntime.perSub.cached.appliedNetworkRuleCount, 1);
    assert.strictEqual(dnr.recordedHealthDiagnostics[0].id, 'trackingUrlCleanupSync');
  });

  await t.test('missing browser regex validation is a global failure and preserves the prior runtime and counters', async () => {
    const existingRules = [
      { id: 100000, priority: 1, action: { type: 'block' }, condition: { urlFilter: '||prior.example^' } }
    ];
    const storage = {
      config: { enabled: true, networkBlocking: true, trackingUrlCleanup: false },
      subscriptions: [{ id: 'legacy', enabled: true }],
      sub_network_rules: { legacy: [regexSubscriptionRule('^legacy$')] },
      appliedNetworkRuleCount: 7,
      appliedNetworkRulesPerSub: { prior: 7 }
    };
    const dnr = loadDnrState({ storage, existingRules, regexSupport: null });

    await assert.rejects(
      dnr.reconcileNetworkDnr('missing-regex-api'),
      /isRegexSupported is unavailable/
    );

    assert.deepStrictEqual(dnr.getDynamicRules(), existingRules);
    assert.strictEqual(dnr.updateDynamicRulesCalls.length, 0);
    assert.strictEqual(storage.appliedNetworkRuleCount, 7);
    assert.deepStrictEqual(storage.appliedNetworkRulesPerSub, { prior: 7 });
  });

  await t.test('a thrown browser regex validation error is global and does not mutate DNR', async () => {
    const dnr = loadDnrState({
      storage: {
        config: { enabled: true, networkBlocking: true, trackingUrlCleanup: false },
        subscriptions: [{ id: 'legacy', enabled: true }],
        sub_network_rules: { legacy: [regexSubscriptionRule('^legacy$')] }
      },
      regexSupport: async () => {
        throw new Error('simulated compiler failure');
      }
    });

    await assert.rejects(
      dnr.reconcileNetworkDnr('regex-api-error'),
      /Browser regex compatibility check failed: simulated compiler failure/
    );
    assert.strictEqual(dnr.updateDynamicRulesCalls.length, 0);
  });

  await t.test('off-to-on dynamic failure restores the prior static and dynamic image', async () => {
    const priorRules = [
      { id: 100000, priority: 1, action: { type: 'block' }, condition: { urlFilter: '||prior.example^' } }
    ];
    const dnr = loadDnrState({
      storage: {
        config: { enabled: true, networkBlocking: true, trackingUrlCleanup: false },
        subscriptions: [{ id: 'cached', enabled: true }],
        sub_network_rules: { cached: [subscriptionRule(4)] }
      },
      existingRules: priorRules,
      existingEnabledRulesets: [],
      beforeDynamicUpdate: async () => {
        throw new Error('simulated dynamic activation failure');
      }
    });

    await assert.rejects(
      dnr.updateDNRState(),
      /simulated dynamic activation failure/
    );

    assert.deepStrictEqual(dnr.getEnabledRulesets(), []);
    assert.deepStrictEqual(dnr.getDynamicRules(), priorRules);
    assert.strictEqual(dnr.updateEnabledRulesetsCalls.length, 2);
    assert.ok(dnr.clearedHealthDiagnostics.includes('dnrStaticCompensation'));
  });

  await t.test('on-to-off dynamic removal failure restores the prior static and dynamic image', async () => {
    const priorRules = [
      { id: 1000, priority: 4, action: { type: 'allow' }, condition: { urlFilter: '||prior.example^' } }
    ];
    const dnr = loadDnrState({
      storage: { config: { enabled: true, networkBlocking: false } },
      existingRules: priorRules,
      existingEnabledRulesets: staticRulesetIds,
      beforeDynamicUpdate: async () => {
        throw new Error('simulated dynamic removal failure');
      }
    });

    await assert.rejects(
      dnr.updateDNRState(),
      /simulated dynamic removal failure/
    );

    assert.deepStrictEqual(dnr.getEnabledRulesets(), staticRulesetIds);
    assert.deepStrictEqual(dnr.getDynamicRules(), priorRules);
    assert.strictEqual(dnr.updateEnabledRulesetsCalls.length, 2);
    assert.ok(dnr.clearedHealthDiagnostics.includes('dnrStaticCompensation'));
  });

  await t.test('dynamic snapshot failure leaves both DNR APIs untouched', async () => {
    const priorRules = [
      { id: 100000, priority: 1, action: { type: 'block' }, condition: { urlFilter: '||prior.example^' } }
    ];
    const dnr = loadDnrState({
      storage: { config: { enabled: true, networkBlocking: true, trackingUrlCleanup: false } },
      existingRules: priorRules,
      existingEnabledRulesets: [],
      beforeGetDynamicRules: async () => {
        throw new Error('simulated dynamic snapshot failure');
      }
    });

    await assert.rejects(
      dnr.updateDNRState(),
      /simulated dynamic snapshot failure/
    );

    assert.deepStrictEqual(dnr.getEnabledRulesets(), []);
    assert.deepStrictEqual(dnr.getDynamicRules(), priorRules);
    assert.strictEqual(dnr.updateEnabledRulesetsCalls.length, 0);
    assert.strictEqual(dnr.updateDynamicRulesCalls.length, 0);
  });

  await t.test('static update failure leaves the prior dynamic image untouched', async () => {
    const priorRules = [
      { id: 1000, priority: 4, action: { type: 'allow' }, condition: { urlFilter: '||prior.example^' } }
    ];
    const dnr = loadDnrState({
      storage: { config: { enabled: true, networkBlocking: false } },
      existingRules: priorRules,
      existingEnabledRulesets: staticRulesetIds,
      beforeEnabledRulesetsUpdate: async () => {
        throw new Error('simulated static update failure');
      }
    });

    await assert.rejects(
      dnr.updateDNRState(),
      /simulated static update failure/
    );

    assert.deepStrictEqual(dnr.getEnabledRulesets(), staticRulesetIds);
    assert.deepStrictEqual(dnr.getDynamicRules(), priorRules);
    assert.strictEqual(dnr.updateDynamicRulesCalls.length, 0);
  });

  await t.test('compensation failure is diagnosed without hiding the dynamic-stage error', async () => {
    const priorRules = [
      { id: 100000, priority: 1, action: { type: 'block' }, condition: { urlFilter: '||prior.example^' } }
    ];
    const dnr = loadDnrState({
      storage: { config: { enabled: true, networkBlocking: true, trackingUrlCleanup: false } },
      existingRules: priorRules,
      existingEnabledRulesets: [],
      beforeDynamicUpdate: async () => {
        throw new Error('original dynamic-stage failure');
      },
      beforeEnabledRulesetsUpdate: async (_args, callIndex) => {
        if (callIndex === 1) throw new Error('simulated static compensation failure');
      }
    });

    await assert.rejects(
      dnr.updateDNRState(),
      /original dynamic-stage failure/
    );

    assert.deepStrictEqual(dnr.getEnabledRulesets(), staticRulesetIds);
    assert.deepStrictEqual(dnr.getDynamicRules(), priorRules);
    assert.strictEqual(dnr.updateEnabledRulesetsAttempts.length, 2);
    const compensationDiagnostic = dnr.recordedHealthDiagnostics.find(
      diagnostic => diagnostic.id === 'dnrStaticCompensation'
    );
    assert.ok(compensationDiagnostic);
    assert.match(
      String(compensationDiagnostic.entry.error),
      /simulated static compensation failure/
    );
  });

  await t.test('a failed tracking-cleanup fallback restores the exact partial static preimage', async () => {
    const priorEnabledRulesets = [staticRulesetIds[1], staticRulesetIds[7]];
    const priorRules = [
      { id: 1000, priority: 4, action: { type: 'allow' }, condition: { urlFilter: '||prior.example^' } }
    ];
    let dynamicAttempts = 0;
    const dnr = loadDnrState({
      storage: { config: { enabled: true, networkBlocking: true, trackingUrlCleanup: true } },
      existingRules: priorRules,
      existingEnabledRulesets: priorEnabledRulesets,
      beforeDynamicUpdate: async () => {
        dynamicAttempts++;
        throw new Error(dynamicAttempts === 1
          ? 'tracking cleanup rejected'
          : 'fallback dynamic commit failed');
      }
    });

    await assert.rejects(
      dnr.updateDNRState(),
      /fallback dynamic commit failed/
    );

    assert.strictEqual(dynamicAttempts, 2);
    assert.deepStrictEqual(dnr.getEnabledRulesets(), priorEnabledRulesets);
    assert.deepStrictEqual(dnr.getDynamicRules(), priorRules);
  });

  await t.test('a retry after compensated activation failure converges to the requested image', async () => {
    let dynamicAttempts = 0;
    const storage = {
      config: { enabled: true, networkBlocking: true, trackingUrlCleanup: false },
      subscriptions: [{ id: 'cached', enabled: true }],
      sub_network_rules: { cached: [subscriptionRule(9)] }
    };
    const dnr = loadDnrState({
      storage,
      existingEnabledRulesets: [],
      beforeDynamicUpdate: async () => {
        dynamicAttempts++;
        if (dynamicAttempts === 1) throw new Error('one-shot dynamic failure');
      }
    });

    await assert.rejects(dnr.updateDNRState(), /one-shot dynamic failure/);
    assert.deepStrictEqual(dnr.getEnabledRulesets(), []);
    assert.deepStrictEqual(dnr.getDynamicRules(), []);

    const result = await dnr.updateDNRState();

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(dnr.getEnabledRulesets(), staticRulesetIds);
    assert.strictEqual(
      dnr.getDynamicRules().some(rule => rule.condition?.urlFilter === '||subscription-00009.example^'),
      true
    );
    assert.ok(dnr.clearedHealthDiagnostics.includes('dnrStaticCompensation'));
  });

  await t.test('a generation superseded during the static commit restores its preimage', async () => {
    const storage = {
      config: { enabled: true, networkBlocking: true, trackingUrlCleanup: false }
    };
    let queuedDisable = null;
    let dnr;
    dnr = loadDnrState({
      storage,
      existingEnabledRulesets: [],
      beforeEnabledRulesetsUpdate: async (_args, callIndex) => {
        if (callIndex !== 0) return;
        storage.config.networkBlocking = false;
        queuedDisable = dnr.updateDNRState();
      }
    });

    const staleResult = await dnr.reconcileNetworkDnr('superseded-activation');
    await queuedDisable;

    assert.strictEqual(staleResult.stale, true);
    assert.deepStrictEqual(dnr.getEnabledRulesets(), []);
    assert.deepStrictEqual(dnr.getDynamicRules(), []);
    assert.strictEqual(dnr.updateDynamicRulesCalls.length, 0);
    assert.strictEqual(dnr.updateEnabledRulesetsCalls.length, 2);
  });

  await t.test('inactive protection disables static rules and removes every dynamic rule', async () => {
    const dnr = loadDnrState({
      storage: { config: { enabled: true, networkBlocking: false } },
      existingRules: [{ id: 1000 }, { id: 100000 }, { id: 9000000 }]
    });

    await dnr.updateDNRState();

    assert.deepStrictEqual(dnr.getDynamicRules(), []);
    assert.deepStrictEqual(dnr.updateEnabledRulesetsCalls[0].disableRulesetIds, staticRulesetIds);
    assert.strictEqual(dnr.storage.appliedNetworkRuleCount, 0);
    assert.deepStrictEqual(dnr.storage.appliedNetworkRulesPerSub, {});
    assert.ok(dnr.clearedHealthDiagnostics.includes('dnrWakeRecovery'));
  });

  await t.test('off to on restores exactly 25,000 cached subscription rules', async () => {
    const cachedRules = Array.from({ length: 25000 }, (_, index) => subscriptionRule(index));
    const storage = {
      config: { enabled: true, networkBlocking: false, trackingUrlCleanup: false },
      subscriptions: [{ id: 'cached', enabled: true }],
      sub_network_rules: { cached: cachedRules },
      whitelist: []
    };
    const dnr = loadDnrState({ storage });

    await dnr.updateDNRState();
    assert.strictEqual(dnr.getDynamicRules().length, 0);

    storage.config.networkBlocking = true;
    await dnr.updateDNRState();
    const restored = dnr.getDynamicRules().filter(rule => rule.id >= 100000 && rule.id <= 8999999);

    assert.strictEqual(restored.length, 25000);
    assert.strictEqual(restored[0].id, 100000);
    assert.strictEqual(restored[24999].id, 124999);
    assert.strictEqual(restored[0].condition.urlFilter, '||subscription-00000.example^');
    assert.strictEqual(restored[24999].condition.urlFilter, '||subscription-24999.example^');
    assert.strictEqual(storage.appliedNetworkRuleCount, 25000);
    assert.ok(dnr.clearedHealthDiagnostics.includes('dnrWakeRecovery'));
  });

  await t.test('active reconciliation repairs missing runtime subscription rules from cache', async () => {
    const storage = {
      config: { enabled: true, networkBlocking: true, trackingUrlCleanup: false },
      subscriptions: [{ id: 'cached', enabled: true }],
      sub_network_rules: { cached: [subscriptionRule(7)] }
    };
    const dnr = loadDnrState({ storage, existingRules: [] });

    await dnr.reconcileNetworkDnr('subscription-not-modified');

    const restored = dnr.getDynamicRules().find(rule => rule.id === 100000);
    assert.strictEqual(restored.condition.urlFilter, '||subscription-00007.example^');
    assert.strictEqual(storage.appliedNetworkRuleCount, 1);
    assert.ok(dnr.clearedHealthDiagnostics.includes('dnrWakeRecovery'));
  });

  await t.test('failed active reconciliation preserves the wake recovery diagnostic', async () => {
    const previousRuntime = {
      schemaVersion: 1,
      protectionActive: true,
      committedAt: 123,
      appliedTotal: 3,
      perSub: { prior: { enabledAtCommit: true, appliedNetworkRuleCount: 3 } }
    };
    const dnr = loadDnrState({
      storage: {
        config: { enabled: true, networkBlocking: true, trackingUrlCleanup: false },
        appliedNetworkRuleCount: 3,
        appliedNetworkRulesPerSub: { prior: 3 },
        subscriptionNetworkRuntime: previousRuntime
      },
      existingRules: [
        { id: 100000, priority: 1, action: { type: 'block' }, condition: { urlFilter: '||prior.example^' } }
      ],
      beforeDynamicUpdate: async () => {
        throw new Error('Simulated DNR commit failure');
      }
    });

    await assert.rejects(
      dnr.updateDNRState(),
      /Simulated DNR commit failure/
    );
    assert.strictEqual(dnr.clearedHealthDiagnostics.includes('dnrWakeRecovery'), false);
    assert.strictEqual(dnr.storage.appliedNetworkRuleCount, 3);
    assert.deepStrictEqual(dnr.storage.appliedNetworkRulesPerSub, { prior: 3 });
    assert.deepStrictEqual(dnr.storage.subscriptionNetworkRuntime, previousRuntime);
    assert.strictEqual(dnr.getDynamicRules()[0].condition.urlFilter, '||prior.example^');
  });

  await t.test('whitelist uses destination main-frame and initiator subresource rules', async () => {
    const dnr = loadDnrState({
      storage: {
        config: { enabled: true, networkBlocking: true, trackingUrlCleanup: false },
        whitelist: ['example.com']
      }
    });

    await dnr.syncWhitelistRules();
    const whitelistRules = dnr.getDynamicRules().filter(rule => rule.id >= 9000000);

    assert.strictEqual(whitelistRules.length, 2);
    assert.deepStrictEqual(whitelistRules[0].condition, {
      requestDomains: ['example.com'],
      resourceTypes: ['main_frame']
    });
    assert.deepStrictEqual(whitelistRules[1].condition.initiatorDomains, ['example.com']);
    assert.ok(whitelistRules[1].condition.resourceTypes.includes('sub_frame'));
    assert.ok(whitelistRules[1].condition.resourceTypes.includes('script'));
    assert.strictEqual(whitelistRules[1].condition.resourceTypes.includes('main_frame'), false);

    for (const scenario of [
      { name: 'direct navigation', requestDomain: 'example.com', resourceType: 'main_frame' },
      { name: 'external navigation', requestDomain: 'example.com', initiatorDomain: 'external.test', resourceType: 'main_frame' },
      { name: 'new-tab navigation', requestDomain: 'example.com', resourceType: 'main_frame' },
      { name: 'same-site navigation', requestDomain: 'example.com', initiatorDomain: 'example.com', resourceType: 'main_frame' }
    ]) {
      assert.strictEqual(conditionMatchesRequest(whitelistRules[0].condition, scenario), true, scenario.name);
    }
    for (const scenario of [
      { name: 'subframe from whitelisted document', requestDomain: 'frame.test', initiatorDomain: 'example.com', resourceType: 'sub_frame' },
      { name: 'subresource from whitelisted document', requestDomain: 'cdn.test', initiatorDomain: 'example.com', resourceType: 'script' }
    ]) {
      assert.strictEqual(conditionMatchesRequest(whitelistRules[1].condition, scenario), true, scenario.name);
    }
    assert.strictEqual(conditionMatchesRequest(whitelistRules[1].condition, {
      requestDomain: 'example.com',
      initiatorDomain: 'external.test',
      resourceType: 'sub_frame'
    }), false, 'external documents do not gain an allow just by embedding the whitelisted destination');
  });

  await t.test('whitelist edits while inactive cannot create allow rules', async () => {
    const dnr = loadDnrState({
      storage: {
        config: { enabled: false, networkBlocking: true },
        whitelist: ['example.com']
      }
    });

    await dnr.syncWhitelistRules();
    assert.deepStrictEqual(dnr.getDynamicRules(), []);
  });

  await t.test('disable requested during async regex preflight prevents the stale active commit', async () => {
    let releasePreflight;
    const preflightBlocked = new Promise(resolve => { releasePreflight = resolve; });
    let signalPreflight;
    const preflightReached = new Promise(resolve => { signalPreflight = resolve; });
    const storage = {
      config: { enabled: true, networkBlocking: true, trackingUrlCleanup: false },
      subscriptions: [{ id: 'cached', enabled: true }],
      sub_network_rules: { cached: [regexSubscriptionRule('^preflight-race$')] }
    };
    const dnr = loadDnrState({
      storage,
      regexSupport: async () => {
        signalPreflight();
        await preflightBlocked;
        return { isSupported: true };
      }
    });

    const activeRun = dnr.reconcileNetworkDnr('refresh-completion');
    await preflightReached;
    storage.config.networkBlocking = false;
    const disableRun = dnr.updateDNRState();
    releasePreflight();
    await Promise.all([activeRun, disableRun]);

    assert.deepStrictEqual(dnr.getDynamicRules(), []);
    assert.strictEqual(storage.appliedNetworkRuleCount, 0);
    assert.deepStrictEqual(storage.appliedNetworkRulesPerSub, {});
  });

  await t.test('disable during an in-flight active commit wins and leaves DNR empty', async () => {
    let releaseFirstCommit;
    const firstCommitBlocked = new Promise(resolve => { releaseFirstCommit = resolve; });
    let firstCommitReached;
    const reached = new Promise(resolve => { firstCommitReached = resolve; });
    const storage = {
      config: { enabled: true, networkBlocking: true, trackingUrlCleanup: false },
      subscriptions: [{ id: 'cached', enabled: true }],
      sub_network_rules: { cached: [subscriptionRule(0)] }
    };
    const dnr = loadDnrState({
      storage,
      beforeDynamicUpdate: async (_args, callIndex) => {
        if (callIndex !== 0) return;
        firstCommitReached();
        await firstCommitBlocked;
      }
    });

    const activeRun = dnr.reconcileNetworkDnr('refresh-completion');
    await reached;
    storage.config.networkBlocking = false;
    const disableRun = dnr.updateDNRState();
    releaseFirstCommit();
    await Promise.all([activeRun, disableRun]);

    assert.deepStrictEqual(dnr.getDynamicRules(), []);
    assert.strictEqual(storage.appliedNetworkRuleCount, 0);
  });

  await t.test('rapid toggles converge to the final requested state', async () => {
    const storage = {
      config: { enabled: true, networkBlocking: true, trackingUrlCleanup: false },
      subscriptions: [{ id: 'cached', enabled: true }],
      sub_network_rules: { cached: [subscriptionRule(0)] }
    };
    const dnr = loadDnrState({ storage });

    const onOne = dnr.updateDNRState();
    storage.config.networkBlocking = false;
    const off = dnr.updateDNRState();
    storage.config.networkBlocking = true;
    const onTwo = dnr.updateDNRState();
    await Promise.all([onOne, off, onTwo]);
    assert.strictEqual(dnr.getDynamicRules().some(rule => rule.id === 100000), true);

    storage.config.networkBlocking = false;
    const offOne = dnr.updateDNRState();
    storage.config.networkBlocking = true;
    const on = dnr.updateDNRState();
    storage.config.networkBlocking = false;
    const offTwo = dnr.updateDNRState();
    await Promise.all([offOne, on, offTwo]);
    assert.deepStrictEqual(dnr.getDynamicRules(), []);
  });
});
