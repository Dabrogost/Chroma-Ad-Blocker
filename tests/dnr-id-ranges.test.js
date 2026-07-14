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
  .replace("import { clearHealthDiagnostic, recordHealthDiagnostic } from './diagnostics.js';", 'var clearHealthDiagnostic = async () => {}; var recordHealthDiagnostic = async () => {};')
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

function conditionMatchesRequest(condition, request) {
  if (condition.resourceTypes && !condition.resourceTypes.includes(request.resourceType)) return false;
  if (condition.requestDomains && !condition.requestDomains.includes(request.requestDomain)) return false;
  if (condition.initiatorDomains && !condition.initiatorDomains.includes(request.initiatorDomain)) return false;
  return true;
}

function loadDnrState({ storage = {}, existingRules = [], beforeDynamicUpdate } = {}) {
  let dynamicRules = plain(existingRules);
  const updateDynamicRulesCalls = [];
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
      getDynamicRules: async () => plain(dynamicRules),
      updateDynamicRules: async (args) => {
        if (beforeDynamicUpdate) await beforeDynamicUpdate(args, updateDynamicRulesCalls.length);
        updateDynamicRulesCalls.push(plain(args));
        const remove = new Set(args.removeRuleIds || []);
        dynamicRules = dynamicRules.filter(rule => !remove.has(rule.id));
        dynamicRules.push(...plain(args.addRules || []));
      },
      updateEnabledRulesets: async (args) => {
        updateEnabledRulesetsCalls.push(plain(args));
      }
    }
  };
  const sandbox = {
    chrome,
    console,
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
  vm.runInContext(subscriptionDnrCode, sandbox);
  vm.runInContext(dnrStateCode, sandbox);

  return {
    ...sandbox.__dnrState,
    subscriptionDnr: sandbox.__subscriptionDnr,
    storage,
    getDynamicRules: () => plain(dynamicRules),
    updateDynamicRulesCalls,
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

  await t.test('a malformed cached domain constraint cannot poison valid sibling DNR rules', () => {
    const dnr = loadDnrState();
    const subscriptions = [{ id: 'list-a', enabled: true }];
    const application = dnr.subscriptionDnr.buildSubscriptionRuleApplication(subscriptions, {
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
