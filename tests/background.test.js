const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backgroundJsCodeRaw = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'background.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
const backgroundJsCode = backgroundJsCodeRaw
  .replace('const DEBUG = false;', 'var DEBUG = true;')
  .replace("import { getDefaultDynamicRules } from './defaultDynamicRules.js';", "var getDefaultDynamicRules = globalThis.getDefaultDynamicRules;")
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\.\/subscriptions\/manager\.js['"];?/s, `
    var initSubscriptions   = globalThis._mockInitSubscriptions;
    var ensureAlarm          = globalThis._mockEnsureAlarm;
    var refreshAllStale      = globalThis._mockRefreshAllStale;
    var refreshSubscription  = globalThis._mockRefreshSubscription;
    var getSubscriptions     = globalThis._mockGetSubscriptions;
    var setSubscriptionEnabled = globalThis._mockSetSubscriptionEnabled;
    var addSubscription      = globalThis._mockAddSubscription;
    var removeSubscription   = globalThis._mockRemoveSubscription;
  `)
  .replace(/import\s*\{[^}]*initScriptletEngine[^}]*\}\s*from\s*['"]\.\.\/scriptlets\/engine\.js['"];?/s, "var initScriptletEngine = globalThis._mockInitScriptletEngine; var recoverUserScriptsIfNeeded = globalThis._mockRecoverUserScriptsIfNeeded || (async () => false);")
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\.\/core\/messageTypes\.js['"];?/s, "var MSG = {};")
  .replace(/import\s*\*\s*as\s+router\s+from\s*['"]\.\.\/core\/messageRouter\.js['"];?/s, "var router = { registerHandler: () => {}, markSensitive: () => {}, attachListener: () => {} };")
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/handlers\.js['"];?/s, "var registerAll = () => {};")
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/stats\.js['"];?/s, "var createDefaultStatsV2 = globalThis._mockCreateDefaultStatsV2 || (() => ({ version: 1, settings: {}, totals: {}, byDay: {}, bySite: {}, byResourceType: {}, byRule: {}, recentEvents: [] })); var recordStatsEvent = globalThis._mockRecordStatsEvent || (() => {});")
  .replace(/import\s*['"]\.\/proxy\.js['"];?/s, "")
  .replace("import { syncWebRtcLeakProtection } from './webrtc.js';", "var syncWebRtcLeakProtection = globalThis._mockSyncWebRtcLeakProtection || (async () => ({}));")
  .replace("import { syncBrowserPrivacyHardening, syncGeolocationProtection } from './browserPrivacy.js';", "var syncBrowserPrivacyHardening = globalThis._mockSyncBrowserPrivacyHardening || (async () => ({})); var syncGeolocationProtection = globalThis._mockSyncGeolocationProtection || (async () => ({}));")
  .replace("import { clearHealthDiagnostic, recordHealthDiagnostic } from './diagnostics.js';", "var clearHealthDiagnostic = globalThis._mockClearHealthDiagnostic || (async () => {}); var recordHealthDiagnostic = globalThis._mockRecordHealthDiagnostic || (async () => {});")
  .replace("import { updateDNRState, syncDynamicRules } from './dnrState.js';", "")
  .replace("import { initRequestLogListener } from './requestLog.js';", "var initRequestLogListener = globalThis._mockInitRequestLogListener || (() => {});")
  .replace(/^export\s+/gm, "");

const defaultDynamicRulesCodeRaw = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'defaultDynamicRules.js'), 'utf8');
const defaultDynamicRulesCode = defaultDynamicRulesCodeRaw.replace('export function getDefaultDynamicRules', 'globalThis.getDefaultDynamicRules = function');

const configStateCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'configState.js'), 'utf8')
  .replace(/^export\s+/gm, '');

const dnrStateCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'dnrState.js'), 'utf8')
  .replace('const DEBUG = false;', 'var DEBUG = false;')
  .replace("import { getDefaultDynamicRules } from './defaultDynamicRules.js';", "var getDefaultDynamicRules = globalThis.getDefaultDynamicRules;")
  .replace("import { clearHealthDiagnostic, recordHealthDiagnostic } from './diagnostics.js';", "var clearHealthDiagnostic = globalThis._mockClearHealthDiagnostic || (async () => {}); var recordHealthDiagnostic = globalThis._mockRecordHealthDiagnostic || (async () => {});")
  .replace(/^export\s+/gm, '');

// ─── GETDEFAULTDYNAMICRULES ─────
test('getDefaultDynamicRules', async (t) => {
  const sandbox = {};

  const chromeMock = {
    runtime: {
      getManifest: () => manifest,
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: () => {} }
    },
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve()
      },
      session: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve()
      },
      onChanged: { addListener: () => {} }
    },
    declarativeNetRequest: {
      getDynamicRules: () => Promise.resolve([]),
      updateDynamicRules: () => Promise.resolve(),
      onRuleMatchedDebug: { addListener: () => {} }
    },
    tabs: {
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(),
      onCreated: { addListener: () => {} },
      onRemoved: { addListener: () => {} }
    },
    alarms: {
      create: () => {},
      get: () => Promise.resolve(null),
      onAlarm: { addListener: () => {} }
    },
    proxy: {
      settings: {
        set: () => Promise.resolve(),
        get: () => Promise.resolve({})
      }
    },
    webRequest: {
      onAuthRequired: { addListener: () => {} }
    }
  };
  sandbox._mockInitSubscriptions    = async () => {};
  sandbox._mockEnsureAlarm          = async () => {};
  sandbox._mockRefreshAllStale      = async () => {};
  sandbox._mockRefreshSubscription  = async () => ({ ok: true });
  sandbox._mockGetSubscriptions     = async () => [];
  sandbox._mockSetSubscriptionEnabled = async () => ({ ok: true });
  sandbox._mockAddSubscription      = async () => ({ ok: true });
  sandbox._mockRemoveSubscription   = async () => ({ ok: true });
  sandbox._mockInitScriptletEngine  = async () => {};
  sandbox._mockDecryptAuth          = async () => ({ username: 'u', password: 'p' });
  sandbox._mockEncryptAuth          = async () => ({ iv: 'iv', ciphertext: 'ct' });

  sandbox.chrome = chromeMock;
  sandbox.console = console;
  sandbox.setInterval = () => {};
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;

  sandbox.globalThis = sandbox;
  sandbox.fetch = async () => ({ ok: false });
 
  vm.createContext(sandbox);
  vm.runInContext(defaultDynamicRulesCode, sandbox);
  vm.runInContext(configStateCode, sandbox);
  vm.runInContext(dnrStateCode, sandbox);
  vm.runInContext(backgroundJsCode, sandbox);

  await t.test('returns an array of rules', () => {
    const rules = sandbox.getDefaultDynamicRules();
    assert.ok(Array.isArray(rules), 'Should return an array');
    assert.ok(rules.length > 0, 'Should not be empty');
  });

  await t.test('rules have correct structure', () => {
    const rules = sandbox.getDefaultDynamicRules();
    for (const rule of rules) {
      assert.ok(rule.id, 'Rule must have an id');
      assert.strictEqual(typeof rule.id, 'number', 'Rule id must be a number');
      assert.strictEqual(rule.priority, 4, 'Rule priority should be 4');

      // Match the actual code: action.type is 'allow' for these rules
      assert.strictEqual(rule.action.type, 'allow', 'Rule action should be allow');

      assert.ok(rule.condition, 'Rule must have a condition');
      assert.ok(rule.condition.urlFilter, 'Rule condition must have urlFilter');
      assert.ok(Array.isArray(rule.condition.resourceTypes), 'Rule condition must have resourceTypes array');
    }
  });

  await t.test('rules have unique ids', () => {
    const rules = sandbox.getDefaultDynamicRules();
    const ids = rules.map(r => r.id);
    const uniqueIds = new Set(ids);
    assert.strictEqual(ids.length, uniqueIds.size, 'Rule IDs must be unique');
  });

  await t.test('config validation accepts only valid WebRTC leak protection modes', () => {
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(sandbox.validateConfig({ webRtcLeakProtection: 'strict' }))),
      { webRtcLeakProtection: 'strict' }
    );
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(sandbox.validateConfig({ webRtcLeakProtection: 'balanced' }))),
      { webRtcLeakProtection: 'balanced' }
    );
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(sandbox.validateConfig({ webRtcLeakProtection: 'auto' }))),
      { webRtcLeakProtection: 'auto' }
    );
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(sandbox.validateConfig({ webRtcLeakProtection: 'off' }))),
      { webRtcLeakProtection: 'off' }
    );
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.validateConfig({ webRtcLeakProtection: 'default' }))), {});
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.validateConfig({ webRtcLeakProtection: true }))), {});
  });

  await t.test('config validation accepts Chrome service proxy bypass booleans only', () => {
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(sandbox.validateConfig({ chromeServiceProxyBypass: true }))),
      { chromeServiceProxyBypass: true }
    );
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(sandbox.validateConfig({ chromeServiceProxyBypass: false }))),
      { chromeServiceProxyBypass: false }
    );
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.validateConfig({ chromeServiceProxyBypass: 'false' }))), {});
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.validateConfig({ chromeServiceProxyBypass: null }))), {});
  });

  await t.test('config validation accepts browser privacy hardening booleans only', () => {
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(sandbox.validateConfig({ browserPrivacyHardening: true }))),
      { browserPrivacyHardening: true }
    );
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(sandbox.validateConfig({ browserPrivacyHardening: false }))),
      { browserPrivacyHardening: false }
    );
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.validateConfig({ browserPrivacyHardening: 'true' }))), {});
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.validateConfig({ browserPrivacyHardening: null }))), {});
  });

  await t.test('config validation accepts geolocation protection booleans only', () => {
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(sandbox.validateConfig({ geolocationProtection: true }))),
      { geolocationProtection: true }
    );
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(sandbox.validateConfig({ geolocationProtection: false }))),
      { geolocationProtection: false }
    );
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.validateConfig({ geolocationProtection: 'true' }))), {});
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.validateConfig({ geolocationProtection: null }))), {});
  });

  await t.test('config validation accepts tracking URL cleanup booleans only', () => {
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(sandbox.validateConfig({ trackingUrlCleanup: true }))),
      { trackingUrlCleanup: true }
    );
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(sandbox.validateConfig({ trackingUrlCleanup: false }))),
      { trackingUrlCleanup: false }
    );
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.validateConfig({ trackingUrlCleanup: 'false' }))), {});
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.validateConfig({ trackingUrlCleanup: null }))), {});
  });

  await t.test('config validation accepts De-AMP booleans only', () => {
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(sandbox.validateConfig({ deAmpLinks: true }))),
      { deAmpLinks: true }
    );
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(sandbox.validateConfig({ deAmpLinks: false }))),
      { deAmpLinks: false }
    );
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.validateConfig({ deAmpLinks: 'true' }))), {});
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.validateConfig({ deAmpLinks: null }))), {});
  });

  await t.test('tracking URL cleanup rule strips known tracking params on top-level navigations only', () => {
    const rules = sandbox.getDefaultDynamicRules({ trackingUrlCleanup: true });
    const cleanupRules = rules.filter(rule => rule.id >= 2000 && rule.id <= 2099);
    assert.ok(cleanupRules.length > 1, 'tracking cleanup should be split into small DNR regex rules');
    const combinedRegex = cleanupRules.map(rule => rule.condition.regexFilter).join('\n');
    for (const cleanupRule of cleanupRules) {
      assert.strictEqual(cleanupRule.action.type, 'redirect');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(cleanupRule.condition.resourceTypes)), ['main_frame']);
      assert.ok(cleanupRule.condition.excludedRequestDomains.includes('accounts.google.com'));
      assert.ok(cleanupRule.condition.excludedRequestDomains.includes('paypal.com'));
      assert.ok(cleanupRule.action.redirect.transform.queryTransform.removeParams.includes('utm_campaign'));
      assert.ok(cleanupRule.action.redirect.transform.queryTransform.removeParams.includes('gclid'));
    }
    assert.ok(combinedRegex.includes('utm_source'));
    assert.ok(combinedRegex.includes('fbclid'));
  });

  await t.test('tracking URL cleanup allowlist accepts fragile-site exclusions', () => {
    const cleanupRule = sandbox.getDefaultDynamicRules({
      trackingUrlCleanup: true,
      trackingUrlCleanupExcludedRequestDomains: ['fragile.example', 'bad/path']
    }).find(rule => rule.id === 2000);
    const excluded = JSON.parse(JSON.stringify(cleanupRule.condition.excludedRequestDomains));
    assert.ok(excluded.includes('fragile.example'));
    assert.strictEqual(excluded.includes('bad/path'), false);
  });

  await t.test('tracking URL cleanup transform removes only listed params', () => {
    const cleanupRule = sandbox.getDefaultDynamicRules({ trackingUrlCleanup: true })
      .find(rule => rule.id === 2000);
    const removeParams = cleanupRule.action.redirect.transform.queryTransform.removeParams;
    const applyTransform = (input) => {
      const url = new URL(input);
      for (const param of removeParams) url.searchParams.delete(param);
      return url.href;
    };

    assert.strictEqual(
      applyTransform('https://example.com/story?id=42&utm_source=newsletter&fbclid=abc&utm_campaign=spring'),
      'https://example.com/story?id=42'
    );
    assert.strictEqual(
      applyTransform('https://example.com/story?product=abc&variant=blue'),
      'https://example.com/story?product=abc&variant=blue'
    );
  });

  await t.test('tracking URL cleanup rule is omitted by default for callers that do not opt in', () => {
    assert.strictEqual(
      sandbox.getDefaultDynamicRules().some(rule => rule.id === 2000),
      false
    );
  });
});

// ─── SYNCDYNAMICRULES SUCCESSFUL SYNCING ─────
test('syncDynamicRules successful syncing', async (t) => {
  const sandbox = {};
  let updateDynamicRulesArgs = null;
  let updateDynamicRulesCalls = [];
  let getDynamicRulesCalled = false;

  const mockExistingRules = [{ id: 1001 }, { id: 1002 }];
  const mockStoredRules = [{ id: 999, action: { type: 'block' } }];
  const defaultStorageGet = async (key) => {
    if (key === 'dynamicRules') {
      return { dynamicRules: sandbox.mockStorageRules };
    }
    return {};
  };

  const chromeMock = {
    runtime: {
      getManifest: () => manifest,
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: () => {} }
    },
    storage: {
      local: {
        get: defaultStorageGet,
        set: () => Promise.resolve()
      },
      session: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve()
      },
      onChanged: { addListener: () => {} }
    },
    declarativeNetRequest: {
      getDynamicRules: async () => {
        getDynamicRulesCalled = true;
        return mockExistingRules;
      },
      updateDynamicRules: async (args) => {
        updateDynamicRulesArgs = args;
        updateDynamicRulesCalls.push(args);
        return Promise.resolve();
      },
      onRuleMatchedDebug: { addListener: () => {} }
    },
    tabs: {
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(),
      onCreated: { addListener: () => {} },
      onRemoved: { addListener: () => {} }
    },
    alarms: {
      create: () => {},
      get: () => Promise.resolve(null),
      onAlarm: { addListener: () => {} }
    },
    proxy: {
      settings: {
        set: () => Promise.resolve(),
        get: () => Promise.resolve({})
      }
    },
    webRequest: {
      onAuthRequired: { addListener: () => {} }
    }
  };

  sandbox._mockInitSubscriptions    = async () => {};
  sandbox._mockEnsureAlarm          = async () => {};
  sandbox._mockRefreshAllStale      = async () => {};
  sandbox._mockRefreshSubscription  = async () => ({ ok: true });
  sandbox._mockGetSubscriptions     = async () => [];
  sandbox._mockSetSubscriptionEnabled = async () => ({ ok: true });
  sandbox._mockAddSubscription      = async () => ({ ok: true });
  sandbox._mockRemoveSubscription   = async () => ({ ok: true });
  sandbox._mockInitScriptletEngine  = async () => {};
  sandbox._mockDecryptAuth          = async () => ({ username: 'u', password: 'p' });
  sandbox._mockEncryptAuth          = async () => ({ iv: 'iv', ciphertext: 'ct' });

  sandbox.chrome = chromeMock;
  sandbox.console = {
    log: () => {},
    error: () => {},
    warn: () => {}
  };
  sandbox.setInterval = () => {};
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.globalThis = sandbox;
  sandbox.fetch = async () => ({ ok: false });

  vm.createContext(sandbox);
  vm.runInContext(defaultDynamicRulesCode, sandbox);
  vm.runInContext(configStateCode, sandbox);
  vm.runInContext(dnrStateCode, sandbox);
  vm.runInContext(backgroundJsCode, sandbox);

  await t.test('uses stored rules and removes existing ones', async () => {
    sandbox.mockStorageRules = mockStoredRules;
    updateDynamicRulesArgs = null;
    updateDynamicRulesCalls = [];
    getDynamicRulesCalled = false;

    await sandbox.syncDynamicRules();

    assert.strictEqual(getDynamicRulesCalled, true, 'getDynamicRules should have been called');
    assert.ok(updateDynamicRulesArgs, 'updateDynamicRules should have been called');
    assert.deepStrictEqual(updateDynamicRulesArgs.removeRuleIds, [1001, 1002], 'Should remove existing rules');
    const expectedTrackingIds = sandbox.getDefaultDynamicRules({ trackingUrlCleanup: true })
      .filter(rule => rule.id >= 2000 && rule.id <= 2099)
      .map(rule => rule.id);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(updateDynamicRulesArgs.addRules.map(rule => rule.id))),
      [999, ...expectedTrackingIds],
      'Should add stored rules plus tracking URL cleanup when enabled'
    );
  });

  await t.test('falls back to default rules when none are stored', async () => {
    sandbox.mockStorageRules = undefined;
    updateDynamicRulesArgs = null;
    updateDynamicRulesCalls = [];
    getDynamicRulesCalled = false;

    await sandbox.syncDynamicRules();

    assert.strictEqual(getDynamicRulesCalled, true, 'getDynamicRules should have been called');
    assert.ok(updateDynamicRulesArgs, 'updateDynamicRules should have been called');
    assert.deepStrictEqual(updateDynamicRulesArgs.removeRuleIds, [1001, 1002], 'Should remove existing rules');

    // Add rules should match the default rules
    const defaultRules = sandbox.getDefaultDynamicRules({ trackingUrlCleanup: true });
    assert.deepStrictEqual(updateDynamicRulesArgs.addRules, defaultRules, 'Should add default rules');
  });

  await t.test('tracking URL cleanup can be disabled without disabling default dynamic rules', async () => {
    chromeMock.storage.local.get = async (key) => {
      if (key === 'config') return { config: { trackingUrlCleanup: false } };
      if (key === 'dynamicRules') return { dynamicRules: undefined };
      return {};
    };
    updateDynamicRulesArgs = null;
    updateDynamicRulesCalls = [];

    await sandbox.syncDynamicRules();

    assert.ok(updateDynamicRulesArgs, 'updateDynamicRules should have been called');
    assert.strictEqual(updateDynamicRulesArgs.addRules.some(rule => rule.id === 2000), false);
    assert.ok(updateDynamicRulesArgs.addRules.some(rule => rule.id === 1001));
  });

  await t.test('acceleration-off rule reversal leaves URL cleanup redirects intact', async () => {
    chromeMock.storage.local.get = async (key) => {
      if (key === 'config') return { config: { acceleration: false, trackingUrlCleanup: true } };
      if (key === 'dynamicRules') return { dynamicRules: undefined };
      return {};
    };
    updateDynamicRulesArgs = null;
    updateDynamicRulesCalls = [];

    await sandbox.syncDynamicRules();

    const allowRule = updateDynamicRulesArgs.addRules.find(rule => rule.id === 1001);
    const cleanupRule = updateDynamicRulesArgs.addRules.find(rule => rule.id === 2000);
    assert.strictEqual(allowRule.action.type, 'block');
    assert.strictEqual(cleanupRule.action.type, 'redirect');
  });

  await t.test('tracking URL cleanup rejection does not block core default dynamic rules', async () => {
    chromeMock.storage.local.get = async (key) => {
      if (key === 'config') return { config: { acceleration: true, trackingUrlCleanup: true } };
      if (key === 'dynamicRules') return { dynamicRules: undefined };
      if (key === 'whitelist') return { whitelist: [] };
      return {};
    };
    updateDynamicRulesArgs = null;
    updateDynamicRulesCalls = [];
    chromeMock.declarativeNetRequest.updateDynamicRules = async (args) => {
      updateDynamicRulesArgs = args;
      updateDynamicRulesCalls.push(args);
      if (args.addRules?.some(rule => rule.id === 2000)) {
        throw new Error('Invalid redirect rule');
      }
    };

    await sandbox.syncDynamicRules();

    assert.strictEqual(updateDynamicRulesCalls.length, 2);
    assert.ok(updateDynamicRulesArgs.addRules.some(rule => rule.id === 1004), 'core default dynamic rules should still be installed');
    assert.strictEqual(updateDynamicRulesArgs.addRules.some(rule => rule.id === 2000), false);
  });

  await t.test('classifies DNR matches without treating all matches as blocks', async () => {
    chromeMock.storage.local.get = defaultStorageGet;
    chromeMock.declarativeNetRequest.updateDynamicRules = async (args) => {
      updateDynamicRulesArgs = args;
      updateDynamicRulesCalls.push(args);
      return Promise.resolve();
    };
    sandbox.mockStorageRules = [
      { id: 1001, action: { type: 'allow' } },
      { id: 1002, action: { type: 'block' } }
    ];
    await sandbox.syncDynamicRules();

    assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.classifyDnrMatch({
      rule: { ruleId: 1, rulesetId: 'oisd_rules_1' }
    }))), {
      type: 'block',
      ruleSource: 'static_ruleset',
      ruleId: 1,
      rulesetId: 'oisd_rules_1'
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.classifyDnrMatch({
      rule: { ruleId: 30014, rulesetId: 'custom_static_rules' }
    }))), {
      type: 'allow',
      ruleSource: 'static_ruleset',
      ruleId: 30014,
      rulesetId: 'custom_static_rules'
    });
    assert.strictEqual(sandbox.classifyDnrMatch({
      rule: { ruleId: 30013, rulesetId: 'custom_static_rules' }
    }).type, 'block');
    assert.strictEqual(sandbox.classifyDnrMatch({ rule: { ruleId: 1001 } }).type, 'allow');
    assert.strictEqual(sandbox.classifyDnrMatch({ rule: { ruleId: 1002 } }).type, 'block');
    assert.strictEqual(sandbox.classifyDnrMatch({ rule: { ruleId: 100000 } }).type, 'block');
    assert.strictEqual(sandbox.classifyDnrMatch({ rule: { ruleId: 9000000 } }).type, 'allow');
    assert.strictEqual(sandbox.classifyDnrMatch({ rule: { ruleId: 42 } }).type, 'match');
  });
});

// ─── SYNCDYNAMICRULES ERROR HANDLING ─────
test('syncDynamicRules error handling', async (t) => {
  const sandbox = {};
  let consoleErrorCalled = false;
  let errorLogged = null;

  const chromeMock = {
    runtime: {
      getManifest: () => manifest,
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: () => {} }
    },
    storage: {
      local: {
        get: () => Promise.resolve({ dynamicRules: [] }),
        set: () => Promise.resolve()
      },
      session: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve()
      },
      onChanged: { addListener: () => {} }
    },
    declarativeNetRequest: {
      getDynamicRules: () => Promise.resolve([]),
      updateDynamicRules: () => Promise.reject(new Error('Simulated update error')),
      onRuleMatchedDebug: { addListener: () => {} }
    },
    tabs: {
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(),
      onCreated: { addListener: () => {} },
      onRemoved: { addListener: () => {} }
    },
    alarms: {
      create: () => {},
      get: () => Promise.resolve(null),
      onAlarm: { addListener: () => {} }
    },
    proxy: {
      settings: {
        set: () => Promise.resolve(),
        get: () => Promise.resolve({})
      }
    },
    webRequest: {
      onAuthRequired: { addListener: () => {} }
    }
  };

  sandbox._mockInitSubscriptions    = async () => {};
  sandbox._mockEnsureAlarm          = async () => {};
  sandbox._mockRefreshAllStale      = async () => {};
  sandbox._mockRefreshSubscription  = async () => ({ ok: true });
  sandbox._mockGetSubscriptions     = async () => [];
  sandbox._mockSetSubscriptionEnabled = async () => ({ ok: true });
  sandbox._mockAddSubscription      = async () => ({ ok: true });
  sandbox._mockRemoveSubscription   = async () => ({ ok: true });
  sandbox._mockInitScriptletEngine  = async () => {};
  sandbox._mockDecryptAuth          = async () => ({ username: 'u', password: 'p' });
  sandbox._mockEncryptAuth          = async () => ({ iv: 'iv', ciphertext: 'ct' });

  sandbox.chrome = chromeMock;
  sandbox.console = {
    log: () => {},
    error: (msg, err) => {
      consoleErrorCalled = true;
      errorLogged = err;
    },
    warn: () => {}
  };
  sandbox.setInterval = () => {};
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.DEBUG = true;
  sandbox.globalThis = sandbox;
  sandbox.fetch = async () => ({ ok: false });

  vm.createContext(sandbox);
  vm.runInContext(defaultDynamicRulesCode, sandbox);
  vm.runInContext(configStateCode, sandbox);
  vm.runInContext(dnrStateCode, sandbox);
  vm.runInContext(backgroundJsCode, sandbox);

  await t.test('catches and logs error when updateDynamicRules fails', async () => {
    await sandbox.syncDynamicRules();

    assert.strictEqual(consoleErrorCalled, true, 'console.error should have been called');
    assert.ok(errorLogged instanceof Error, 'Logged error should be an Error instance');
    assert.strictEqual(errorLogged.message, 'Simulated update error', 'Should log the correct error');
  });
});
