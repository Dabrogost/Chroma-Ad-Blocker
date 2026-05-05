const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backgroundJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'background.js'), 'utf8')
  .replace('const DEBUG = false;', 'var DEBUG = false;')
  .replace("import { getDefaultDynamicRules } from './defaultDynamicRules.js';", 'var getDefaultDynamicRules = globalThis._getDefaultDynamicRules;')
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\.\/subscriptions\/manager\.js['"];?/s, `
    var initSubscriptions = async () => {};
    var ensureAlarm = async () => {};
    var refreshAllStale = async () => {};
    var refreshSubscription = async () => ({ ok: true });
    var getSubscriptions = async () => [];
    var setSubscriptionEnabled = async () => ({ ok: true });
    var addSubscription = async () => ({ ok: true });
    var removeSubscription = async () => ({ ok: true });
  `)
  .replace("import { initScriptletEngine } from '../scriptlets/engine.js';", 'var initScriptletEngine = async () => {};')
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\.\/core\/messageTypes\.js['"];?/s, 'var MSG = {};')
  .replace(/import\s*\*\s*as\s+router\s+from\s*['"]\.\.\/core\/messageRouter\.js['"];?/s, 'var router = { registerHandler: () => {}, markSensitive: () => {}, attachListener: () => {} };')
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/handlers\.js['"];?/s, 'var registerAll = () => {};')
  .replace(/import\s*['"]\.\/proxy\.js['"];?/s, '')
  .replace(/^export\s+/gm, '')
  + '\nglobalThis.__backgroundExports = { updateDNRState, syncDynamicRules, syncWhitelistRules };\n';

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
const staticRulesetIds = manifest.declarative_net_request.rule_resources.map(resource => resource.id);

const subscriptionDnrCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'subscriptions', 'dnr.js'), 'utf8')
  .replace("import { SUBSCRIPTION_ID_START, SUBSCRIPTION_ID_END } from './budget.js';", `
    var SUBSCRIPTION_ID_START = 100000;
    var SUBSCRIPTION_ID_END = 8999999;
  `)
  .replace(/^export\s+/gm, '')
  + '\nglobalThis.__subscriptionDnrExports = { applySubscriptionRules, clearSubscriptionRules };\n';

function loadBackground({ storage = {}, existingRules = [] } = {}) {
  const updateDynamicRulesCalls = [];
  const updateEnabledRulesetsCalls = [];
  const chrome = {
    runtime: {
      getManifest: () => manifest,
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: () => {} }
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
        set: async (values) => Object.assign(storage, values)
      },
      session: {
        get: async () => ({}),
        set: async () => {}
      },
      onChanged: { addListener: () => {} }
    },
    declarativeNetRequest: {
      getDynamicRules: async () => existingRules,
      updateDynamicRules: async (args) => updateDynamicRulesCalls.push(args),
      updateEnabledRulesets: async (args) => updateEnabledRulesetsCalls.push(args),
      onRuleMatchedDebug: { addListener: () => {} }
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => {},
      onCreated: { addListener: () => {} },
      onRemoved: { addListener: () => {} }
    },
    alarms: {
      create: () => {},
      get: async () => null,
      onAlarm: { addListener: () => {} }
    },
    proxy: {
      settings: {
        set: async () => {},
        get: async () => ({})
      }
    },
    webRequest: {
      onAuthRequired: { addListener: () => {} }
    }
  };
  const sandbox = {
    chrome,
    console,
    fetch: async () => ({ ok: false }),
    setInterval: () => {},
    setTimeout,
    clearTimeout,
    _getDefaultDynamicRules: () => [
      { id: 1000, priority: 4, action: { type: 'allow' }, condition: { urlFilter: '||default-one.example^' } },
      { id: 1001, priority: 4, action: { type: 'allow' }, condition: { urlFilter: '||default-two.example^' } }
    ]
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(backgroundJsCode, sandbox);
  return {
    ...sandbox.__backgroundExports,
    updateDynamicRulesCalls,
    updateEnabledRulesetsCalls
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadSubscriptionDnr(existingRules = []) {
  const updateDynamicRulesCalls = [];
  const sandbox = {
    chrome: {
      declarativeNetRequest: {
        getDynamicRules: async () => existingRules,
        updateDynamicRules: async (args) => updateDynamicRulesCalls.push(args)
      }
    },
    console
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(subscriptionDnrCode, sandbox);
  return {
    ...sandbox.__subscriptionDnrExports,
    updateDynamicRulesCalls
  };
}

test('DNR dynamic ID ranges stay isolated', async (t) => {
  await t.test('default dynamic sync removes only default IDs', async () => {
    const bg = loadBackground({
      storage: { config: { acceleration: true } },
      existingRules: [{ id: 999 }, { id: 1000 }, { id: 99999 }, { id: 100000 }, { id: 9000000 }]
    });

    await bg.syncDynamicRules();

    assert.deepStrictEqual(bg.updateDynamicRulesCalls[0].removeRuleIds, [1000, 99999]);
    assert.deepStrictEqual(bg.updateDynamicRulesCalls[0].addRules.map(r => r.id), [1000, 1001]);
  });

  await t.test('subscription apply removes only subscription IDs and assigns non-overlapping IDs', async () => {
    const dnr = loadSubscriptionDnr([{ id: 1000 }, { id: 100000 }, { id: 100005 }, { id: 9000000 }]);

    await dnr.applySubscriptionRules([
      { priority: 1, action: { type: 'block' }, condition: { urlFilter: '||sub-one.example^' } },
      { priority: 1, action: { type: 'block' }, condition: { urlFilter: '||sub-two.example^' } }
    ]);

    assert.deepStrictEqual(dnr.updateDynamicRulesCalls[0].removeRuleIds, [100000, 100005]);
    assert.deepStrictEqual(dnr.updateDynamicRulesCalls[0].addRules.map(r => r.id), [100000, 100001]);
    assert.ok(dnr.updateDynamicRulesCalls[0].addRules.every(r => r.id > 99999 && r.id < 9000000));
  });

  await t.test('whitelist sync removes only whitelist IDs and never overlaps subscription IDs', async () => {
    const bg = loadBackground({
      storage: { whitelist: ['example.com', 'news.example'] },
      existingRules: [{ id: 1000 }, { id: 100000 }, { id: 8999999 }, { id: 9000000 }, { id: 9000003 }]
    });

    await bg.syncWhitelistRules();

    assert.deepStrictEqual(bg.updateDynamicRulesCalls[0].removeRuleIds, [9000000, 9000003]);
    assert.deepStrictEqual(bg.updateDynamicRulesCalls[0].addRules.map(r => r.id), [9000000, 9000001]);
    assert.ok(bg.updateDynamicRulesCalls[0].addRules.every(r => r.id >= 9000000));
  });

  await t.test('clearing subscription rules leaves default and whitelist ranges alone', async () => {
    const dnr = loadSubscriptionDnr([{ id: 1000 }, { id: 100000 }, { id: 8999999 }, { id: 9000000 }]);

    await dnr.clearSubscriptionRules();

    assert.deepStrictEqual(dnr.updateDynamicRulesCalls[0].removeRuleIds, [100000, 8999999]);
  });

  await t.test('disabling network blocking removes all dynamic rules', async () => {
    const bg = loadBackground({
      existingRules: [{ id: 1000 }, { id: 100000 }, { id: 9000000 }]
    });

    await bg.updateDNRState(false);

    assert.deepStrictEqual(plain(bg.updateEnabledRulesetsCalls[0].disableRulesetIds), [
      ...staticRulesetIds
    ]);
    assert.deepStrictEqual(plain(bg.updateDynamicRulesCalls[0].removeRuleIds), [1000, 100000, 9000000]);
  });

  await t.test('re-enabling restores default and whitelist rules without removing subscription range', async () => {
    const bg = loadBackground({
      storage: { config: { acceleration: true }, whitelist: ['example.com'] },
      existingRules: [{ id: 1000 }, { id: 100000 }, { id: 9000000 }]
    });

    await bg.updateDNRState(true);

    assert.deepStrictEqual(plain(bg.updateEnabledRulesetsCalls[0].enableRulesetIds), staticRulesetIds);
    assert.deepStrictEqual(bg.updateDynamicRulesCalls[0].removeRuleIds, [1000]);
    assert.deepStrictEqual(bg.updateDynamicRulesCalls[0].addRules.map(r => r.id), [1000, 1001]);
    assert.deepStrictEqual(bg.updateDynamicRulesCalls[1].removeRuleIds, [9000000]);
    assert.deepStrictEqual(bg.updateDynamicRulesCalls[1].addRules.map(r => r.id), [9000000]);
  });
});
