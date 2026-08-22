const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backgroundJsCodeRaw = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'background.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
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
    var reconcileSubscriptionRuntimeState = async () => ({ ok: true });
  `)
  .replace(/import\s*\{[^}]*initScriptletEngine[^}]*\}\s*from\s*['"]\.\.\/scriptlets\/engine\.js['"];?/s, "var initScriptletEngine = globalThis._mockInitScriptletEngine; var recoverUserScriptsIfNeeded = globalThis._mockRecoverUserScriptsIfNeeded || (async () => false);")
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\.\/core\/messageTypes\.js['"];?/s, "var MSG = {};")
  .replace(/import\s*\*\s*as\s+router\s+from\s*['"]\.\.\/core\/messageRouter\.js['"];?/s, "var router = { registerHandler: () => {}, attachListener: () => {} };")
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/handlers\/index\.js['"];?/s, "var registerAll = () => {};")
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/stats\.js['"];?/s, "var createDefaultStatsV2 = () => ({ version: 1, settings: {}, totals: {}, byDay: {}, bySite: {}, byResourceType: {}, byRule: {}, recentEvents: [] }); var recordStatsEvent = () => {};")
  .replace(/import\s*['"]\.\/proxy\.js['"];?/s, "")
  .replace("import { syncWebRtcLeakProtection } from './webrtc.js';", "var syncWebRtcLeakProtection = async () => ({});")
  .replace("import { syncBrowserPrivacyHardening, syncGeolocationProtection } from './browserPrivacy.js';", "var syncBrowserPrivacyHardening = async () => ({}); var syncGeolocationProtection = async () => ({});")
  .replace("import { clearHealthDiagnostic, recordHealthDiagnostic } from './diagnostics.js';", "var clearHealthDiagnostic = async () => {}; var recordHealthDiagnostic = async () => {};")
  .replace("import { updateDNRState, syncDynamicRules } from './dnrState.js';", "var updateDNRState = async () => {}; var syncDynamicRules = async () => {};")
  .replace("import { initRequestLogListener } from './requestLog.js';", "var initRequestLogListener = () => {};")
  .replace(/^export\s+/gm, "");

const plain = value => JSON.parse(JSON.stringify(value));
const cloneStorageValue = value => value === undefined ? undefined : structuredClone(value);

const SETTINGS_IMPORT_STORAGE_KEYS = [
  'config',
  'whitelist',
  'fprWhitelist',
  'proxyConfigs',
  'subscriptions',
  'sub_network_rules',
  'sub_cosmetic_rules',
  'sub_scriptlet_rules',
  'subscriptionCosmeticRules',
  'subscriptionScriptletRules',
  'userScriptletSources',
  'userScriptletResources',
  'userScriptletRuleText',
  'userScriptletRules'
];
const DNR_DERIVED_STORAGE_KEYS = [
  'appliedNetworkStateVersion',
  'appliedNetworkRuleCount',
  'appliedNetworkRulesPerSub',
  'browserUnsupportedRegexRuleCount',
  'browserUnsupportedRegexRulesPerSub',
  'regexQuotaTrimCount',
  'regexQuotaTrimmedRulesPerSub',
  'subscriptionNetworkRuntime'
];
const CONFIG_KEYS = [
  'networkBlocking', 'stripping', 'acceleration', 'cosmetic', 'hideShorts',
  'hideMerch', 'hideOffers', 'suppressWarnings', 'accelerationSpeed', 'enabled',
  'globalProxyEnabled', 'globalProxyId', 'chromeServiceProxyBypass',
  'webRtcLeakProtection', 'fingerprintRandomization', 'browserPrivacyHardening',
  'geolocationProtection', 'trackingUrlCleanup', 'deAmpLinks', 'quietConsole'
];

function defaultStageCustomSubscriptions(subscriptions, current = {}) {
  const imported = Array.isArray(subscriptions) ? subscriptions : [];
  return {
    ok: true,
    importedCount: imported.length,
    changed: true,
    storage: {
      subscriptions: imported,
      sub_network_rules: {},
      sub_cosmetic_rules: {},
      sub_scriptlet_rules: {},
      subscriptionCosmeticRules: [],
      subscriptionScriptletRules: []
    }
  };
}

function defaultStageUserScriptletSettings(payload = {}) {
  const sources = Array.isArray(payload?.sources)
    ? payload.sources.map((source, index) => ({
        id: `imported-${index}`,
        name: source.name || '',
        url: source.url
      }))
    : [];
  const ruleText = typeof payload?.ruleText === 'string' ? payload.ruleText : '';
  const rules = ruleText ? [{ scriptlet: 'imported-scriptlet' }] : [];
  return {
    ok: true,
    importedSources: sources.length,
    importedRules: rules.length,
    storage: {
      userScriptletSources: sources,
      userScriptletResources: {},
      userScriptletRuleText: ruleText,
      userScriptletRules: rules
    }
  };
}

function makeSettingsImportPayload(overrides = {}) {
  return {
    schema: 'chroma-settings',
    version: 1,
    config: { enabled: false, networkBlocking: true, acceleration: true },
    whitelist: ['imported.example'],
    fprWhitelist: ['login.imported.example'],
    proxyConfigs: [],
    subscriptions: [{
      id: 'custom-imported',
      name: 'Imported list',
      url: 'https://lists.example.com/imported.txt',
      enabled: true,
      isCustom: true
    }],
    userScriptlets: {
      sources: [{ name: 'Imported', url: 'https://cdn.example.com/imported.js' }],
      ruleText: 'imported.example##+js(imported-scriptlet)'
    },
    ...overrides
  };
}

function makeSettingsImportStorage({ omit = [] } = {}) {
  const storage = {
    config: { enabled: true, networkBlocking: true, acceleration: false },
    whitelist: ['old.example'],
    fprWhitelist: ['login.old.example'],
    proxyConfigs: [],
    subscriptions: [{
      id: 'custom-old',
      name: 'Old list',
      url: 'https://lists.example.com/old.txt',
      enabled: true,
      isCustom: true
    }],
    sub_network_rules: { 'custom-old': [{ id: 'old-network' }] },
    sub_cosmetic_rules: { 'custom-old': [{ selector: '.old-ad' }] },
    sub_scriptlet_rules: { 'custom-old': [{ scriptlet: 'old-scriptlet' }] },
    subscriptionCosmeticRules: [{ selector: '.old-ad', sourceId: 'custom-old' }],
    subscriptionScriptletRules: [{ scriptlet: 'old-scriptlet', sourceId: 'custom-old' }],
    userScriptletSources: [{ id: 'old-source', url: 'https://cdn.example.com/old.js' }],
    userScriptletResources: { old: { code: 'old executable code' } },
    userScriptletRuleText: 'old.example##+js(old-scriptlet)',
    userScriptletRules: [{ scriptlet: 'old-scriptlet' }],
    unrelatedSetting: { preserve: true }
  };
  for (const key of omit) delete storage[key];
  return storage;
}

function makeDnrDerivedStorage(label, applied = 1) {
  return {
    appliedNetworkStateVersion: 1,
    appliedNetworkRuleCount: applied,
    appliedNetworkRulesPerSub: { [label]: applied },
    browserUnsupportedRegexRuleCount: applied + 1,
    browserUnsupportedRegexRulesPerSub: { [label]: applied + 1 },
    regexQuotaTrimCount: applied + 2,
    regexQuotaTrimmedRulesPerSub: { [label]: applied + 2 },
    subscriptionNetworkRuntime: {
      schemaVersion: 1,
      protectionActive: true,
      committedAt: applied * 100,
      appliedTotal: applied,
      perSub: { [label]: { enabledAtCommit: true, appliedNetworkRuleCount: applied } }
    }
  };
}

const HANDLER_MODULE_FILES = [
  'domainValidation.js',
  'proxyHandlers.js',
  'subscriptionHandlers.js',
  'configHandlers.js',
  'whitelistHandlers.js',
  'settingsTransferHandlers.js',
  'zapperHandlers.js',
  'userScriptletHandlers.js',
  'diagnosticHandlers.js',
  'index.js'
];

function handlerModuleForVm(file) {
  let source = fs.readFileSync(
    path.join(__dirname, '..', 'extension', 'background', 'handlers', file),
    'utf8'
  );
  const exportNames = [...source.matchAll(/^export\s+(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/gm)]
    .map(match => match[1]);
  source = source
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\r?\n/gm, '')
    .replace(/^export\s+/gm, '');
  return `(() => {\n${source}\nObject.assign(globalThis, { ${exportNames.join(', ')} });\n})();`;
}

const handlersJsCode = HANDLER_MODULE_FILES.map(handlerModuleForVm).join('\n');

const remoteUrlJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'core', 'remoteUrl.js'), 'utf8')
  .replace(/^export\s+/gm, '');

const parserJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'subscriptions', 'parser.js'), 'utf8')
  .replace(/^export\s+/gm, '');

const MSG = {
  CONFIG_GET: 'CONFIG_GET',
  CONFIG_SET: 'CONFIG_SET',
  CONFIG_EXPORT: 'CONFIG_EXPORT',
  CONFIG_IMPORT: 'CONFIG_IMPORT',
  CONFIG_UPDATE: 'CONFIG_UPDATE',
  STATS_GET: 'STATS_GET',
  STATS_EVENT_BATCH: 'STATS_EVENT_BATCH',
  STATS_RESET: 'STATS_RESET',
  STATS_EXPORT: 'STATS_EXPORT',
  STATS_SETTINGS_SET: 'STATS_SETTINGS_SET',
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
  USER_SCRIPTLETS_GET: 'USER_SCRIPTLETS_GET',
  USER_SCRIPTLET_SOURCE_ADD: 'USER_SCRIPTLET_SOURCE_ADD',
  USER_SCRIPTLET_SOURCE_REFRESH: 'USER_SCRIPTLET_SOURCE_REFRESH',
  USER_SCRIPTLET_SOURCE_REMOVE: 'USER_SCRIPTLET_SOURCE_REMOVE',
  USER_SCRIPTLET_RULES_SET: 'USER_SCRIPTLET_RULES_SET',
  HEALTH_GET: 'HEALTH_GET',
  UPDATE_CHECK: 'UPDATE_CHECK',
  UPDATE_PACKAGE_INSPECT: 'UPDATE_PACKAGE_INSPECT',
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
  let configMutationTail = Promise.resolve();
  const sandbox = {
    MSG,
    CONFIG_KEYS,
    URL,
    Number,
    encryptAuth: options.encryptAuth || (async (username, password) => ({ iv: `iv:${username}`, ciphertext: `ct:${password}` })),
    validateConfig: options.validateConfig || ((config) => config || {}),
    serializeConfigMutation: task => {
      const run = configMutationTail.then(task);
      configMutationTail = run.catch(() => {});
      return run;
    },
    isNetworkProtectionActive: options.isNetworkProtectionActive || (config => config?.enabled !== false && config?.networkBlocking !== false),
    updateDNRState: options.updateDNRState || (async () => {}),
    syncWhitelistRules: options.syncWhitelistRules || (async () => {}),
    checkForUpdate: options.checkForUpdate || (async () => ({ updateAvailable: false })),
    resetRequestLog: options.resetRequestLog || (async () => {}),
    getMergedLog: options.getMergedLog || (async () => []),
    runProxyTest: options.runProxyTest || (async () => ({ ok: true })),
    syncProxyState: options.syncProxyState || (async () => ({ ok: true })),
    getHealthStatus: options.getHealthStatus || (async () => ({ ok: true })),
    exportStats: options.exportStats || (async () => ({})),
    getSubscriptions: options.getSubscriptions || (async () => []),
    stageCustomSubscriptions: options.stageCustomSubscriptions || defaultStageCustomSubscriptions,
    reconcileSubscriptionRuntimeState: options.reconcileSubscriptionRuntimeState || (async () => ({ ok: true })),
    getUserScriptletSettings: options.getUserScriptletSettings || (async () => ({ sources: [], ruleText: '', parsedRuleCount: 0 })),
    addUserScriptletSource: options.addUserScriptletSource || (async () => ({ ok: true })),
    refreshUserScriptletSource: options.refreshUserScriptletSource || (async () => ({ ok: true })),
    removeUserScriptletSource: options.removeUserScriptletSource || (async () => ({ ok: true })),
    setUserScriptletRuleText: options.setUserScriptletRuleText || (async () => ({ ok: true, parsedRuleCount: 0 })),
    exportUserScriptletSettings: options.exportUserScriptletSettings || (async () => ({ sources: [], ruleText: '' })),
    stageUserScriptletSettings: options.stageUserScriptletSettings || defaultStageUserScriptletSettings,
    syncUserScripts: options.syncUserScripts || (async () => {}),
    getStatsSnapshot: options.getStatsSnapshot || (async () => ({})),
    recordContentStatsEvents: options.recordContentStatsEvents || (async () => ({ ok: true, accepted: 0 })),
    resetStats: options.resetStats || (async () => {}),
    setStatsSettings: options.setStatsSettings || (async () => ({})),
    syncWebRtcLeakProtection: options.syncWebRtcLeakProtection || (async () => ({})),
    syncBrowserPrivacyHardening: options.syncBrowserPrivacyHardening || (async () => ({})),
    syncGeolocationProtection: options.syncGeolocationProtection || (async () => ({})),
    inspectLatestUpdatePackage: options.inspectLatestUpdatePackage || (async () => ({ ok: true, updateAvailable: false })),
    chrome: {
      storage: {
        local: {
          get: options.storageGet || (async (key) => {
            if (typeof key === 'string') {
              return Object.prototype.hasOwnProperty.call(storage, key)
                ? { [key]: cloneStorageValue(storage[key]) }
                : {};
            }
            if (Array.isArray(key)) {
              return Object.fromEntries(key
                .filter(name => Object.prototype.hasOwnProperty.call(storage, name))
                .map(name => [name, cloneStorageValue(storage[name])]));
            }
            return cloneStorageValue(storage);
          }),
          set: options.storageSet || (async (values) => Object.assign(storage, cloneStorageValue(values))),
          remove: options.storageRemove || (async (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
          })
        }
      },
      tabs: { query: async () => [], sendMessage: async () => {} }
    },
    console
  };
  sandbox._storage = storage;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(remoteUrlJsCode, sandbox);
  vm.runInContext(handlersJsCode, sandbox);
  return sandbox;
}

function loadTransactionalImportHarness(options = {}) {
  const storage = options.storage || makeSettingsImportStorage({ omit: options.omit || [] });
  const calls = {
    get: 0,
    set: 0,
    remove: 0,
    dnr: 0,
    subscriptionRuntime: 0,
    userScripts: 0,
    proxy: 0,
    webRtc: 0,
    browserPrivacy: 0,
    geolocation: 0,
    dnrDerivedWrites: 0
  };
  const commitImages = [];
  const runtimeSnapshots = [];
  const runtimeState = {
    dnr: 'custom-old',
    subscriptionRuntime: 'custom-old',
    userScripts: 'custom-old',
    proxy: 'custom-old',
    webRtc: 'custom-old',
    browserPrivacy: 'custom-old',
    geolocation: 'custom-old'
  };
  let rollbackBegan = false;
  const staleReturned = new Set();

  const runtimeStep = name => async () => {
    calls[name]++;
    runtimeSnapshots.push({
      name,
      rollback: rollbackBegan,
      config: plain(storage.config || null),
      subscriptions: plain(storage.subscriptions || null),
      userScriptletRuleText: storage.userScriptletRuleText
    });
    const forwardFailure = !rollbackBegan && options.failRuntime === name;
    if (!rollbackBegan && options.staleRuntimeOnce === name && !staleReturned.has(name)) {
      staleReturned.add(name);
      return { ok: false, stale: true };
    }
    if (!rollbackBegan && options.failRuntimeResult === name) {
      return { ok: false, error: `${name} semantic failure` };
    }
    if (forwardFailure && options.failRuntimeTiming !== 'after') {
      throw new Error(`${name} forward failure`);
    }
    if (rollbackBegan && options.failRollbackRuntime === name) {
      throw new Error(`${name} rollback failure`);
    }
    if (name === 'dnr' && options.mutateDnrDerived === true) {
      calls.dnrDerivedWrites++;
      Object.assign(storage, makeDnrDerivedStorage(
        rollbackBegan ? 'rollback-runtime' : 'forward-runtime',
        rollbackBegan ? 92 : 91
      ));
    }
    runtimeState[name] = storage.subscriptions?.[0]?.id || 'none';
    if (forwardFailure) throw new Error(`${name} forward failure after mutation`);
  };

  const sandbox = loadHandlers({
    storage,
    validateConfig: options.validateConfig,
    stageCustomSubscriptions: options.stageCustomSubscriptions || defaultStageCustomSubscriptions,
    stageUserScriptletSettings: options.stageUserScriptletSettings || defaultStageUserScriptletSettings,
    storageGet: async keys => {
      calls.get++;
      if (options.failSnapshotRead) throw new Error('snapshot read failed');
      if (typeof keys === 'string') {
        return Object.prototype.hasOwnProperty.call(storage, keys)
          ? { [keys]: cloneStorageValue(storage[keys]) }
          : {};
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys
          .filter(key => Object.prototype.hasOwnProperty.call(storage, key))
          .map(key => [key, cloneStorageValue(storage[key])]));
      }
      return cloneStorageValue(storage);
    },
    storageSet: async values => {
      calls.set++;
      if (calls.set === 1) {
        commitImages.push(plain(values));
        if (options.commitFailure === 'before') throw new Error('commit failed before write');
        Object.assign(storage, cloneStorageValue(values));
        if (options.commitFailure === 'after') throw new Error('commit failed after write');
        return;
      }
      rollbackBegan = true;
      if (options.failRollbackStorage === 'set') throw new Error('rollback set failed');
      Object.assign(storage, cloneStorageValue(values));
    },
    storageRemove: async keys => {
      calls.remove++;
      rollbackBegan = true;
      if (options.failRollbackStorage === 'remove') throw new Error('rollback remove failed');
      for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
    },
    updateDNRState: runtimeStep('dnr'),
    reconcileSubscriptionRuntimeState: runtimeStep('subscriptionRuntime'),
    syncUserScripts: runtimeStep('userScripts'),
    syncProxyState: runtimeStep('proxy'),
    syncWebRtcLeakProtection: runtimeStep('webRtc'),
    syncBrowserPrivacyHardening: runtimeStep('browserPrivacy'),
    syncGeolocationProtection: runtimeStep('geolocation')
  });

  return { sandbox, storage, calls, commitImages, runtimeSnapshots, runtimeState };
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
      getManifest: () => manifest,
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

test('Security Hardening - background handlers', async (t) => {
  await t.test('registers only audited content-script message exceptions', () => {
    const sandbox = loadHandlers();
    const registrations = new Map();
    sandbox.registerAll({
      registerHandler: (type, handler, options) => {
        registrations.set(type, { handler, options: options || {} });
      }
    });

    const expectedTypes = Object.values(MSG)
      .filter(type => type !== MSG.CONFIG_UPDATE)
      .sort();
    assert.deepStrictEqual([...registrations.keys()].sort(), expectedTypes);

    const contentScriptTypes = [...registrations]
      .filter(([, registration]) => registration.options.allowContentScripts === true)
      .map(([type]) => type)
      .sort();
    assert.deepStrictEqual(contentScriptTypes, [MSG.STATS_EVENT_BATCH, MSG.ZAPPER_SAVE_RULE].sort());

    for (const [type, registration] of registrations) {
      assert.strictEqual(typeof registration.handler, 'function', `${type} should have a handler`);
      if (!contentScriptTypes.includes(type)) {
        assert.strictEqual(registration.options.allowContentScripts, undefined, `${type} should default to extension pages`);
      }
    }
  });

  await t.test('delegates content telemetry to the authoritative stats ingress', async () => {
    let captured = null;
    const sandbox = loadHandlers({
      recordContentStatsEvents: async (events, sender) => {
        captured = { events, sender };
        return { ok: true, accepted: 1 };
      }
    });
    const events = [{ eventType: 'cosmetic_hide', count: 100000 }];
    const sender = { tab: { id: 7, url: 'https://example.test/' } };

    const result = await sandbox.handleStatsEventBatch({ events }, sender);

    assert.deepStrictEqual(plain(result), { ok: true, accepted: 1 });
    assert.strictEqual(captured.events, events);
    assert.strictEqual(captured.sender, sender);
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

  await t.test('whitelist changes use one gated reconciliation when network blocking is disabled', async () => {
    let syncCount = 0;
    const sandbox = loadHandlers({
      storage: {
        config: { networkBlocking: false },
        whitelist: []
      },
      syncWhitelistRules: async () => {
        syncCount++;
      }
    });

    await sandbox.handleWhitelistAdd({ domain: 'example.com' });

    assert.deepStrictEqual(plain(sandbox._storage.whitelist), ['example.com']);
    assert.strictEqual(syncCount, 1);
  });

  await t.test('concurrent whitelist mutations preserve every requested edit', async () => {
    const sandbox = loadHandlers({ storage: { whitelist: ['remove.example'] } });

    await Promise.all([
      sandbox.handleWhitelistAdd({ domain: 'first.example' }),
      sandbox.handleWhitelistAdd({ domain: 'second.example' }),
      sandbox.handleWhitelistRemove({ domain: 'remove.example' })
    ]);

    assert.deepStrictEqual(plain(sandbox._storage.whitelist), ['first.example', 'second.example']);
  });

  await t.test('concurrent FPR whitelist mutations preserve every requested edit', async () => {
    const sandbox = loadHandlers({ storage: { fprWhitelist: ['remove.example'] } });

    await Promise.all([
      sandbox.handleFprWhitelistAdd({ domain: 'first.example' }),
      sandbox.handleFprWhitelistAdd({ domain: 'second.example' }),
      sandbox.handleFprWhitelistRemove({ domain: 'remove.example' })
    ]);

    assert.deepStrictEqual(plain(sandbox._storage.fprWhitelist), ['first.example', 'second.example']);
  });

  await t.test('settings import serializes with main and FPR whitelist mutations', async () => {
    const storage = makeSettingsImportStorage();
    let releaseImportCommit;
    let markImportCommitStarted;
    const importCommitGate = new Promise(resolve => { releaseImportCommit = resolve; });
    const importCommitStarted = new Promise(resolve => { markImportCommitStarted = resolve; });
    const sandbox = loadHandlers({
      storage,
      storageSet: async values => {
        const isImportCommit = Object.prototype.hasOwnProperty.call(values, 'config') &&
          Object.prototype.hasOwnProperty.call(values, 'whitelist') &&
          Object.prototype.hasOwnProperty.call(values, 'fprWhitelist');
        if (isImportCommit) {
          markImportCommitStarted();
          await importCommitGate;
        }
        Object.assign(storage, cloneStorageValue(values));
      }
    });

    const importResult = sandbox.handleConfigImport({ settings: makeSettingsImportPayload() });
    await importCommitStarted;

    const mainAdd = sandbox.handleWhitelistAdd({ domain: 'after-import.example' });
    const fprAdd = sandbox.handleFprWhitelistAdd({ domain: 'login.after-import.example' });
    await new Promise(resolve => setImmediate(resolve));
    releaseImportCommit();

    const [imported] = await Promise.all([importResult, mainAdd, fprAdd]);

    assert.strictEqual(imported.ok, true);
    assert.deepStrictEqual(plain(storage.whitelist), ['imported.example', 'after-import.example']);
    assert.deepStrictEqual(plain(storage.fprWhitelist), [
      'login.imported.example',
      'login.after-import.example'
    ]);
  });

  await t.test('rapid config toggles are stored and reconciled in request order', async () => {
    const storage = { config: { enabled: true, networkBlocking: true } };
    const reconciledStates = [];
    const sandbox = loadHandlers({
      storage,
      updateDNRState: async () => {
        reconciledStates.push(storage.config.enabled !== false && storage.config.networkBlocking !== false);
      }
    });

    await Promise.all([
      sandbox.handleConfigSet({ config: { networkBlocking: false } }),
      sandbox.handleConfigSet({ config: { networkBlocking: true } })
    ]);
    assert.strictEqual(storage.config.networkBlocking, true);
    assert.deepStrictEqual(reconciledStates, [false, true]);

    reconciledStates.length = 0;
    await Promise.all([
      sandbox.handleConfigSet({ config: { networkBlocking: false } }),
      sandbox.handleConfigSet({ config: { networkBlocking: true } }),
      sandbox.handleConfigSet({ config: { networkBlocking: false } })
    ]);
    assert.strictEqual(storage.config.networkBlocking, false);
    assert.deepStrictEqual(reconciledStates, [false, true, false]);
  });

  await t.test('master config changes await subscription, userScripts, and proxy synchronization', async () => {
    const storage = { config: { enabled: true, networkBlocking: true } };
    const subscriptionRuntimeStates = [];
    const scriptletSyncStates = [];
    const proxySyncStates = [];
    const webRtcSyncStates = [];
    const browserPrivacySyncStates = [];
    const geolocationSyncStates = [];
    const sandbox = loadHandlers({
      storage,
      reconcileSubscriptionRuntimeState: async () => {
        subscriptionRuntimeStates.push(storage.config.enabled !== false);
      },
      syncUserScripts: async () => {
        scriptletSyncStates.push(storage.config.enabled !== false);
      },
      syncProxyState: async () => {
        proxySyncStates.push(storage.config.enabled !== false);
      },
      syncWebRtcLeakProtection: async config => { webRtcSyncStates.push(config.enabled !== false); },
      syncBrowserPrivacyHardening: async config => { browserPrivacySyncStates.push(config.enabled !== false); },
      syncGeolocationProtection: async config => { geolocationSyncStates.push(config.enabled !== false); }
    });

    await Promise.all([
      sandbox.handleConfigSet({ config: { enabled: false } }),
      sandbox.handleConfigSet({ config: { enabled: true } })
    ]);

    assert.strictEqual(storage.config.enabled, true);
    assert.deepStrictEqual(subscriptionRuntimeStates, [false, true]);
    assert.deepStrictEqual(scriptletSyncStates, [false, true]);
    assert.deepStrictEqual(proxySyncStates, [false, true]);
    assert.deepStrictEqual(webRtcSyncStates, [false, true]);
    assert.deepStrictEqual(browserPrivacySyncStates, [false, true]);
    assert.deepStrictEqual(geolocationSyncStates, [false, true]);
  });

  await t.test('settings import stores the global gate before subscription reconciliation', async () => {
    const storage = { config: { enabled: true, networkBlocking: true }, proxyConfigs: [] };
    let activeWhenDnrReconciled = null;
    const sandbox = loadHandlers({
      storage,
      updateDNRState: async () => {
        activeWhenDnrReconciled = storage.config.enabled !== false && storage.config.networkBlocking !== false;
      }
    });

    const result = await sandbox.handleConfigImport({
      settings: {
        schema: 'chroma-settings',
        version: 1,
        config: { enabled: false, networkBlocking: true },
        whitelist: [],
        fprWhitelist: [],
        proxyConfigs: [],
        subscriptions: [{
          id: 'custom-off',
          name: 'Custom Off',
          url: 'https://lists.example.com/off.txt',
          enabled: true
        }],
        userScriptlets: { sources: [], ruleText: '' }
      }
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(activeWhenDnrReconciled, false);
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
      enabled: true,
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
      enabled: true,
      domains: [{ host: 'good.example.com', enabled: true }]
    });
  });

  await t.test('proxy config validation preserves disabled proxy state', async () => {
    const result = await loadHandlers().validateProxyConfigsForStorage([{
      id: 30,
      name: 'Paused Media',
      host: 'proxy.example.com',
      port: 8080,
      type: 'PROXY',
      accepted: true,
      enabled: false,
      domains: [{ host: 'youtube.com', enabled: true }]
    }]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.configs.length, 1);
    assert.strictEqual(result.configs[0].enabled, false);
    assert.deepStrictEqual(plain(result.configs[0].domains), [{ host: 'youtube.com', enabled: true }]);
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
          enabled: false,
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
      enabled: false,
      domains: [{ host: 'example.com', enabled: true }],
      hasCredentials: true
    }]);
    assert.strictEqual('username' in result[0], false);
    assert.strictEqual('password' in result[0], false);
    assert.strictEqual('authIv' in result[0], false);
    assert.strictEqual('authCipher' in result[0], false);
  });

  await t.test('proxy config get recognizes stored byte-array credentials', async () => {
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

  await t.test('settings export omits proxy credentials and import clears credential blobs', async () => {
    const storage = {
      config: { enabled: true, acceleration: true },
      whitelist: ['HTTPS://Example.COM/path', 'bad..example.com'],
      fprWhitelist: ['*.Login.Example.COM'],
      proxyConfigs: [{
        id: 3,
        name: 'Secure',
        type: 'PROXY',
        host: 'proxy.example.com',
        port: 8080,
        accepted: true,
        enabled: true,
        domains: [{ host: 'youtube.com', enabled: true }],
        authIv: 'iv-secret',
        authCipher: 'cipher-secret'
      }]
    };
    const handlers = {};
    const dnrUpdates = [];
    const sandbox = loadHandlers({
      storage,
      updateDNRState: async (enabled) => { dnrUpdates.push(enabled); },
      getSubscriptions: async () => [
        {
          id: 'custom_news',
          name: 'News',
          url: 'https://lists.example.com/news.txt',
          enabled: true,
          isCustom: true,
          intervalHours: 24
        },
        {
          id: 'custom_pending_removal',
          name: 'Already removed',
          url: 'https://lists.example.com/pending.txt',
          enabled: true,
          isCustom: true,
          pendingRemoval: true,
          intervalHours: 24
        }
      ],
      exportUserScriptletSettings: async () => ({
        sources: [{ name: 'Custom', url: 'https://cdn.example.com/resources.js' }],
        ruleText: 'example.com##+js(custom-scriptlet)'
      })
    });
    sandbox.registerAll({
      registerHandler: (type, fn) => { handlers[type] = fn; }
    });

    const exported = await handlers.CONFIG_EXPORT();
    assert.strictEqual(exported.schema, 'chroma-settings');
    assert.strictEqual(exported.version, 1);
    assert.deepStrictEqual(Object.keys(exported).sort(), [
      'config',
      'exportedAt',
      'fprWhitelist',
      'proxyConfigs',
      'schema',
      'subscriptions',
      'userScriptlets',
      'version',
      'whitelist'
    ]);
    for (const key of DNR_DERIVED_STORAGE_KEYS) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(exported, key), false, key);
    }
    assert.strictEqual(exported.proxyConfigs[0].authIv, undefined);
    assert.strictEqual(exported.proxyConfigs[0].authCipher, undefined);
    assert.deepStrictEqual(plain(exported.whitelist), ['example.com']);
    assert.deepStrictEqual(plain(exported.fprWhitelist), ['login.example.com']);
    assert.strictEqual(exported.subscriptions.length, 1);
    assert.strictEqual(exported.subscriptions[0].id, 'custom_news');
    assert.deepStrictEqual(plain(exported.userScriptlets.sources), [{
      name: 'Custom',
      url: 'https://cdn.example.com/resources.js'
    }]);
    assert.strictEqual(exported.userScriptlets.ruleText, 'example.com##+js(custom-scriptlet)');
    assert.strictEqual(JSON.stringify(exported).includes('function()'), false);

    const imported = await handlers.CONFIG_IMPORT({
      settings: {
        schema: 'chroma-settings',
        version: 1,
        config: { enabled: false, accelerationSpeed: 12 },
        whitelist: ['example.org'],
        fprWhitelist: ['login.example.org'],
        proxyConfigs: [{
          id: 4,
          name: 'Imported',
          type: 'PROXY',
          host: 'imported.example.com',
          port: 8081,
          accepted: true,
          enabled: true,
          domains: [{ host: 'twitch.tv', enabled: true }],
          authIv: 'must-drop',
          authCipher: 'must-drop'
        }],
        subscriptions: [{
          id: 'custom_import',
          name: 'Import',
          url: 'https://lists.example.com/import.txt',
          enabled: false,
          isCustom: true
        }],
        userScriptlets: {
          sources: [{ name: 'Imported Scriptlets', url: 'https://cdn.example.com/imported.js' }],
          ruleText: 'example.org##+js(imported-scriptlet)'
        }
      }
    });

    assert.strictEqual(imported.ok, true);
    assert.strictEqual(storage.proxyConfigs[0].authIv, undefined);
    assert.strictEqual(storage.proxyConfigs[0].authCipher, undefined);
    assert.deepStrictEqual(plain(storage.whitelist), ['example.org']);
    assert.strictEqual(storage.subscriptions.some(sub => sub.id === 'custom_import'), true);
    assert.strictEqual(storage.userScriptletRuleText, 'example.org##+js(imported-scriptlet)');
    assert.strictEqual(storage.userScriptletRules.length, 1);
    assert.deepStrictEqual(dnrUpdates, [undefined]);
  });

  await t.test('settings import rejects unsupported versions and malformed staged sections before mutation', async () => {
    for (const version of [undefined, 0, 2, '1']) {
      const stageCalls = { subscriptions: 0, userScriptlets: 0 };
      const { sandbox, storage, calls } = loadTransactionalImportHarness({
        stageCustomSubscriptions: (...args) => {
          stageCalls.subscriptions++;
          return defaultStageCustomSubscriptions(...args);
        },
        stageUserScriptletSettings: (...args) => {
          stageCalls.userScriptlets++;
          return defaultStageUserScriptletSettings(...args);
        }
      });
      const before = plain(storage);
      const result = await sandbox.handleConfigImport({
        settings: makeSettingsImportPayload({ version })
      });

      assert.strictEqual(result.ok, false, String(version));
      assert.strictEqual(result.phase, 'validation', String(version));
      assert.strictEqual(result.rollback?.attempted, false, String(version));
      assert.deepStrictEqual(stageCalls, { subscriptions: 0, userScriptlets: 0 }, String(version));
      assert.strictEqual(calls.get, 0, String(version));
      assert.strictEqual(calls.set, 0, String(version));
      assert.strictEqual(calls.remove, 0, String(version));
      assert.strictEqual(calls.dnr + calls.userScripts, 0, String(version));
      assert.deepStrictEqual(plain(storage), before, String(version));
    }

    for (const scenario of [
      {
        name: 'malformed config value',
        options: { validateConfig: () => ({}) },
        payload: makeSettingsImportPayload({ config: { enabled: 'false' } })
      },
      {
        name: 'unknown config key',
        options: {},
        payload: makeSettingsImportPayload({ config: { enabled: false, futureToggle: true } })
      },
      {
        name: 'subscription staging',
        options: {
          stageCustomSubscriptions: () => ({ ok: false, error: 'Malformed subscriptions' })
        },
        payload: makeSettingsImportPayload()
      },
      {
        name: 'user-scriptlet parsing',
        options: {
          stageUserScriptletSettings: () => ({
            ok: false,
            error: 'Invalid user-scriptlet rule at line 1',
            errors: [{ line: 1, message: 'Invalid scriptlet rule' }]
          })
        },
        payload: makeSettingsImportPayload({
          userScriptlets: { sources: [], ruleText: 'example.test##+js(' }
        })
      }
    ]) {
      const { sandbox, storage, calls } = loadTransactionalImportHarness(scenario.options);
      const before = plain(storage);
      const result = await sandbox.handleConfigImport({ settings: scenario.payload });

      assert.strictEqual(result.ok, false, scenario.name);
      assert.strictEqual(result.phase, 'validation', scenario.name);
      assert.strictEqual(result.rollback?.attempted, false, scenario.name);
      assert.strictEqual(calls.set, 0, scenario.name);
      assert.strictEqual(calls.remove, 0, scenario.name);
      assert.strictEqual(calls.dnr + calls.userScripts, 0, scenario.name);
      assert.deepStrictEqual(plain(storage), before, scenario.name);
    }
  });

  await t.test('settings import commits one complete storage image before reconciling runtime state', async () => {
    const { sandbox, storage, calls, commitImages, runtimeSnapshots } = loadTransactionalImportHarness();
    const result = await sandbox.handleConfigImport({ settings: makeSettingsImportPayload() });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls.set, 1);
    assert.strictEqual(calls.remove, 0);
    assert.strictEqual(commitImages.length, 1);
    assert.deepStrictEqual(
      Object.keys(commitImages[0]).sort(),
      SETTINGS_IMPORT_STORAGE_KEYS.slice().sort()
    );
    assert.deepStrictEqual(plain(storage.config), {
      enabled: false,
      networkBlocking: true,
      acceleration: true
    });
    assert.deepStrictEqual(plain(storage.whitelist), ['imported.example']);
    assert.deepStrictEqual(plain(storage.subscriptions.map(sub => sub.id)), ['custom-imported']);
    assert.deepStrictEqual(plain(storage.sub_network_rules), {});
    assert.strictEqual(storage.userScriptletRuleText, 'imported.example##+js(imported-scriptlet)');
    assert.deepStrictEqual(plain(storage.userScriptletResources), {});
    assert.deepStrictEqual(plain(storage.unrelatedSetting), { preserve: true });
    assert.deepStrictEqual(
      plain({
        dnr: calls.dnr,
        subscriptionRuntime: calls.subscriptionRuntime,
        userScripts: calls.userScripts,
        proxy: calls.proxy,
        webRtc: calls.webRtc,
        browserPrivacy: calls.browserPrivacy,
        geolocation: calls.geolocation
      }),
      {
        dnr: 1,
        subscriptionRuntime: 1,
        userScripts: 1,
        proxy: 1,
        webRtc: 1,
        browserPrivacy: 1,
        geolocation: 1
      }
    );
    assert.strictEqual(runtimeSnapshots.every(snapshot => (
      snapshot.config?.enabled === false &&
      snapshot.subscriptions?.[0]?.id === 'custom-imported' &&
      snapshot.userScriptletRuleText === 'imported.example##+js(imported-scriptlet)'
    )), true);
  });

  await t.test('settings import reports snapshot read failures without mutation or rollback', async () => {
    const { sandbox, storage, calls } = loadTransactionalImportHarness({ failSnapshotRead: true });
    const before = plain(storage);
    const result = await sandbox.handleConfigImport({ settings: makeSettingsImportPayload() });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.phase, 'commit');
    assert.strictEqual(result.step, 'storage-snapshot');
    assert.strictEqual(result.rollback?.attempted, false);
    assert.strictEqual(result.rollback?.succeeded, true);
    assert.strictEqual(calls.set, 0);
    assert.strictEqual(calls.remove, 0);
    assert.strictEqual(calls.dnr + calls.userScripts, 0);
    assert.deepStrictEqual(plain(storage), before);
  });

  await t.test('settings import restores the exact snapshot when the commit fails before or after mutation', async () => {
    for (const commitFailure of ['before', 'after']) {
      const { sandbox, storage, calls, runtimeSnapshots } = loadTransactionalImportHarness({
        commitFailure,
        omit: ['subscriptionScriptletRules', 'userScriptletResources']
      });
      const before = plain(storage);
      const result = await sandbox.handleConfigImport({ settings: makeSettingsImportPayload() });

      assert.strictEqual(result.ok, false, commitFailure);
      assert.strictEqual(result.phase, 'commit', commitFailure);
      assert.strictEqual(typeof result.step, 'string', commitFailure);
      assert.strictEqual(result.rollback?.attempted, true, commitFailure);
      assert.strictEqual(result.rollback?.succeeded, true, commitFailure);
      assert.strictEqual(result.rollback?.storageRestored, true, commitFailure);
      assert.strictEqual(result.rollback?.runtimeRestored, true, commitFailure);
      assert.deepStrictEqual(plain(result.rollback?.errors), [], commitFailure);
      assert.strictEqual(calls.set >= 2, true, commitFailure);
      assert.strictEqual(calls.remove >= 1, true, commitFailure);
      assert.deepStrictEqual(plain(storage), before, commitFailure);
      assert.strictEqual(runtimeSnapshots.filter(snapshot => snapshot.rollback).every(snapshot => (
        snapshot.config?.enabled === true &&
        snapshot.subscriptions?.[0]?.id === 'custom-old' &&
        snapshot.userScriptletRuleText === 'old.example##+js(old-scriptlet)'
      )), true, commitFailure);
    }
  });

  await t.test('settings import rollback keeps DNR-derived state aligned with the last committed runtime image', async () => {
    const presentStorage = makeSettingsImportStorage();
    Object.assign(presentStorage, makeDnrDerivedStorage('prior-runtime', 17));
    const presentHarness = loadTransactionalImportHarness({
      storage: presentStorage,
      failRuntime: 'userScripts',
      mutateDnrDerived: true
    });
    const presentBefore = plain(presentStorage);
    const presentResult = await presentHarness.sandbox.handleConfigImport({
      settings: makeSettingsImportPayload()
    });

    assert.strictEqual(presentResult.ok, false);
    assert.strictEqual(presentResult.rollback?.succeeded, true);
    assert.strictEqual(presentHarness.calls.dnrDerivedWrites, 2);
    const rollbackProjection = makeDnrDerivedStorage('rollback-runtime', 92);
    for (const key of SETTINGS_IMPORT_STORAGE_KEYS) {
      assert.deepStrictEqual(plain(presentStorage[key]), presentBefore[key], key);
    }
    for (const key of DNR_DERIVED_STORAGE_KEYS) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(presentStorage, key), true, key);
      assert.deepStrictEqual(plain(presentStorage[key]), plain(rollbackProjection[key]), key);
    }

    const absentStorage = makeSettingsImportStorage();
    const absentHarness = loadTransactionalImportHarness({
      storage: absentStorage,
      failRuntime: 'userScripts',
      mutateDnrDerived: true
    });
    const absentBefore = plain(absentStorage);
    const absentResult = await absentHarness.sandbox.handleConfigImport({
      settings: makeSettingsImportPayload()
    });

    assert.strictEqual(absentResult.ok, false);
    assert.strictEqual(absentResult.rollback?.succeeded, true);
    assert.strictEqual(absentHarness.calls.dnrDerivedWrites, 2);
    for (const key of SETTINGS_IMPORT_STORAGE_KEYS) {
      assert.deepStrictEqual(plain(absentStorage[key]), absentBefore[key], key);
    }
    for (const key of DNR_DERIVED_STORAGE_KEYS) {
      assert.deepStrictEqual(plain(absentStorage[key]), plain(rollbackProjection[key]), key);
    }

    const failedRollbackStorage = makeSettingsImportStorage();
    Object.assign(failedRollbackStorage, makeDnrDerivedStorage('prior-runtime', 17));
    const failedRollbackHarness = loadTransactionalImportHarness({
      storage: failedRollbackStorage,
      failRuntime: 'userScripts',
      failRollbackRuntime: 'dnr',
      mutateDnrDerived: true
    });
    const failedRollbackResult = await failedRollbackHarness.sandbox.handleConfigImport({
      settings: makeSettingsImportPayload()
    });

    assert.strictEqual(failedRollbackResult.ok, false);
    assert.strictEqual(failedRollbackResult.phase, 'rollback');
    assert.strictEqual(failedRollbackResult.rollback?.runtimeRestored, false);
    assert.strictEqual(failedRollbackHarness.calls.dnrDerivedWrites, 1);
    const retainedForwardProjection = makeDnrDerivedStorage('forward-runtime', 91);
    for (const key of DNR_DERIVED_STORAGE_KEYS) {
      assert.deepStrictEqual(
        plain(failedRollbackStorage[key]),
        plain(retainedForwardProjection[key]),
        key
      );
    }
  });

  await t.test('every failed runtime reconciliation rolls storage and runtime back to the prior image', async () => {
    for (const failRuntime of [
      'dnr',
      'subscriptionRuntime',
      'userScripts',
      'proxy',
      'webRtc',
      'browserPrivacy',
      'geolocation'
    ]) {
      for (const failRuntimeTiming of ['before', 'after']) {
        const label = `${failRuntime}:${failRuntimeTiming}`;
        const { sandbox, storage, calls, runtimeSnapshots, runtimeState } = loadTransactionalImportHarness({
          failRuntime,
          failRuntimeTiming,
          omit: ['subscriptionCosmeticRules', 'userScriptletResources', 'userScriptletRules']
        });
        const before = plain(storage);
        const result = await sandbox.handleConfigImport({ settings: makeSettingsImportPayload() });

        assert.strictEqual(result.ok, false, label);
        assert.strictEqual(result.phase, 'reconciliation', label);
        assert.strictEqual(typeof result.step, 'string', label);
        assert.strictEqual(result.rollback?.attempted, true, label);
        assert.strictEqual(result.rollback?.succeeded, true, label);
        assert.strictEqual(result.rollback?.storageRestored, true, label);
        assert.strictEqual(result.rollback?.runtimeRestored, true, label);
        assert.deepStrictEqual(plain(result.rollback?.errors), [], label);
        assert.deepStrictEqual(plain(storage), before, label);
        assert.strictEqual(calls.remove >= 1, true, label);
        assert.strictEqual(Object.values(runtimeState).every(value => value === 'custom-old'), true, label);

        const rollbackSnapshots = runtimeSnapshots.filter(snapshot => snapshot.rollback);
        assert.strictEqual(rollbackSnapshots.length >= 7, true, label);
        assert.strictEqual(rollbackSnapshots.every(snapshot => (
          snapshot.config?.enabled === true &&
          snapshot.subscriptions?.[0]?.id === 'custom-old' &&
          snapshot.userScriptletRuleText === 'old.example##+js(old-scriptlet)'
        )), true, label);
      }
    }
  });

  await t.test('fulfilled semantic reconciliation failures also trigger rollback', async () => {
    for (const failRuntimeResult of [
      'dnr',
      'subscriptionRuntime',
      'userScripts',
      'proxy',
      'webRtc',
      'browserPrivacy',
      'geolocation'
    ]) {
      const { sandbox, storage } = loadTransactionalImportHarness({ failRuntimeResult });
      const before = plain(storage);
      const result = await sandbox.handleConfigImport({ settings: makeSettingsImportPayload() });

      assert.strictEqual(result.ok, false, failRuntimeResult);
      assert.strictEqual(result.phase, 'reconciliation', failRuntimeResult);
      assert.strictEqual(result.rollback?.succeeded, true, failRuntimeResult);
      assert.deepStrictEqual(plain(storage), before, failRuntimeResult);
    }
  });

  await t.test('stale reconciliations retry against the committed authoritative image', async () => {
    for (const staleRuntimeOnce of [
      'dnr',
      'subscriptionRuntime',
      'userScripts',
      'proxy',
      'webRtc',
      'browserPrivacy',
      'geolocation'
    ]) {
      const { sandbox, storage, calls } = loadTransactionalImportHarness({ staleRuntimeOnce });
      const result = await sandbox.handleConfigImport({ settings: makeSettingsImportPayload() });

      assert.strictEqual(result.ok, true, staleRuntimeOnce);
      assert.strictEqual(calls[staleRuntimeOnce], 2, staleRuntimeOnce);
      assert.strictEqual(storage.config.enabled, false, staleRuntimeOnce);
    }
  });

  await t.test('settings import surfaces storage and runtime rollback failures', async () => {
    const storageRollback = loadTransactionalImportHarness({
      failRuntime: 'dnr',
      failRollbackStorage: 'set'
    });
    const storageResult = await storageRollback.sandbox.handleConfigImport({
      settings: makeSettingsImportPayload()
    });
    assert.strictEqual(storageResult.ok, false);
    assert.strictEqual(storageResult.phase, 'rollback');
    assert.strictEqual(storageResult.failedPhase, 'reconciliation');
    assert.strictEqual(storageResult.rollback?.attempted, true);
    assert.strictEqual(storageResult.rollback?.succeeded, false);
    assert.strictEqual(storageResult.rollback?.storageRestored, false);
    assert.strictEqual(storageResult.rollback?.errors.some(error => /rollback set failed/i.test(
      typeof error === 'string' ? error : (error?.error || error?.message || '')
    )), true);

    const runtimeRollback = loadTransactionalImportHarness({
      failRuntime: 'dnr',
      failRollbackRuntime: 'userScripts'
    });
    const runtimeResult = await runtimeRollback.sandbox.handleConfigImport({
      settings: makeSettingsImportPayload()
    });
    assert.strictEqual(runtimeResult.ok, false);
    assert.strictEqual(runtimeResult.phase, 'rollback');
    assert.strictEqual(runtimeResult.failedPhase, 'reconciliation');
    assert.strictEqual(runtimeResult.rollback?.attempted, true);
    assert.strictEqual(runtimeResult.rollback?.succeeded, false);
    assert.strictEqual(runtimeResult.rollback?.storageRestored, true);
    assert.strictEqual(runtimeResult.rollback?.runtimeRestored, false);
    assert.strictEqual(runtimeResult.rollback?.errors.some(error => /userScripts rollback failure/i.test(
      typeof error === 'string' ? error : (error?.error || error?.message || '')
    )), true);
  });

  await t.test('advanced user scriptlet mutations sync registered scripts after successful changes', async () => {
    let syncCallCount = 0;
    const sandbox = loadHandlers({
      addUserScriptletSource: async () => ({ ok: true }),
      refreshUserScriptletSource: async () => ({ ok: true }),
      removeUserScriptletSource: async () => ({ ok: true }),
      setUserScriptletRuleText: async (ruleText) => (
        ruleText === 'bad'
          ? { ok: false, error: 'Invalid user scriptlet rules' }
          : { ok: true, parsedRuleCount: ruleText ? 1 : 0 }
      ),
      syncUserScripts: async () => {
        syncCallCount++;
      }
    });

    assert.deepStrictEqual(plain(await sandbox.handleUserScriptletSourceAdd({ source: { url: 'https://cdn.example.com/resources.js' } })), { ok: true });
    assert.strictEqual(syncCallCount, 1);

    assert.deepStrictEqual(plain(await sandbox.handleUserScriptletSourceRefresh({ id: 'usr_valid' })), { ok: true });
    assert.strictEqual(syncCallCount, 2);

    assert.deepStrictEqual(plain(await sandbox.handleUserScriptletSourceRemove({ id: 'usr_valid' })), { ok: true });
    assert.strictEqual(syncCallCount, 3);

    assert.deepStrictEqual(plain(await sandbox.handleUserScriptletRulesSet({ ruleText: '' })), { ok: true, parsedRuleCount: 0 });
    assert.strictEqual(syncCallCount, 4);

    assert.strictEqual((await sandbox.handleUserScriptletSourceRemove({ id: '../bad' })).ok, false);
    assert.strictEqual((await sandbox.handleUserScriptletRulesSet({ ruleText: 'bad' })).ok, false);
    assert.strictEqual(syncCallCount, 4);
  });

  await t.test('proxy credential preserve keeps stored byte-array auth', async () => {
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

  await t.test('proxy credential actions preserve replace and clear stored auth', async () => {
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

  await t.test('does not expose or preserve oversized stored proxy auth blobs', async () => {
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
      excludedDomains: null,
      selector: '.ad-banner',
      isException: false
    });
    assert.deepStrictEqual(plain(parsed.cosmeticRules[1]), {
      domains: null,
      excludedDomains: null,
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
    assert.strictEqual(parsed.skipped.skipOption, 1);
    assert.strictEqual(parsed.skipped.malformed, 0);
  });

  await t.test('counts unsupported network skip reasons precisely', () => {
    const { parseList } = loadParser();
    const parsed = parseList([
      '/adserver\\d+/$script',
      '||redirect.example^$redirect=noopjs',
      '@@/allow-regex/$image',
      '||ads.example^'
    ].join('\n'));

    assert.strictEqual(parsed.networkRules.length, 1);
    assert.strictEqual(parsed.networkRules[0].condition.urlFilter, '||ads.example^');
    assert.strictEqual(parsed.skipped.regex, 2);
    assert.strictEqual(parsed.skipped.skipOption, 1);
    assert.strictEqual(parsed.skipped.malformed, 0);
  });

  await t.test('preserves safe wildcard-host network rules as DNR urlFilter values', () => {
    const { parseList } = loadParser();
    const temptationFilter = '||temptation.*/temptation.js';
    const loaderFilter = '||loader.*.com/prod/*/loader.min.js';
    const parsed = parseList([
      `${temptationFilter}$script,~third-party,domain=ad.nl|hln.be`,
      `${loaderFilter}$script`
    ].join('\n'));

    assert.strictEqual(parsed.networkRules.length, 2);
    assert.strictEqual(parsed.skipped.unsupportedUrlFilter, 0);
    assert.strictEqual(parsed.stats.translatedRegexFilter, 0);
    assert.strictEqual(parsed.networkRules[0].condition.urlFilter, temptationFilter);
    assert.strictEqual(parsed.networkRules[0].condition.regexFilter, undefined);
    assert.deepStrictEqual(plain(parsed.networkRules[0].condition.resourceTypes), ['script']);
    assert.strictEqual(parsed.networkRules[0].condition.domainType, 'firstParty');
    assert.deepStrictEqual(plain(parsed.networkRules[0].condition.initiatorDomains), ['ad.nl', 'hln.be']);
    assert.strictEqual(parsed.networkRules[1].condition.urlFilter, loaderFilter);
    assert.strictEqual(parsed.networkRules[1].condition.regexFilter, undefined);
  });

  await t.test('keeps unsafe wildcard-host shapes outside the DNR trust boundary', () => {
    const { parseList } = loadParser();
    const parsed = parseList([
      '||*/ad.js$script',
      '||bad*host/ad.js$script',
      '||bad.[host]*/ad.js$script',
      '||bad.*/path|middle$script',
      '||bad.*/path with space$script',
      '||good.*/ad.js$script'
    ].join('\n'));

    assert.strictEqual(parsed.networkRules.length, 1);
    assert.strictEqual(parsed.networkRules[0].condition.urlFilter, '||good.*/ad.js');
    assert.strictEqual(parsed.networkRules[0].condition.regexFilter, undefined);
    assert.strictEqual(parsed.skipped.unsupportedUrlFilter, 5);
    assert.strictEqual(parsed.stats.translatedRegexFilter, 0);
  });

  await t.test('drops non-ASCII DNR urlFilter patterns while preserving encoded siblings', () => {
    const { parseList } = loadParser();
    const parsed = parseList([
      '||cdn.*/caf\u00e9.js$script',
      '||static.example/\u5e7f\u544a.js$script',
      '||cdn.*/caf%C3%A9.js$script',
      '||static.example/%E5%B9%BF%E5%91%8A.js$script'
    ].join('\n'));

    assert.deepStrictEqual(
      plain(parsed.networkRules.map(rule => rule.condition.urlFilter)),
      ['||cdn.*/caf%C3%A9.js', '||static.example/%E5%B9%BF%E5%91%8A.js']
    );
    assert.strictEqual(parsed.skipped.unsupportedUrlFilter, 2);
    assert.strictEqual(parsed.skipped.malformed, 0);
  });

  await t.test('drops unsupported DNR urlFilter shapes without rejecting the list', () => {
    const { parseList } = loadParser();
    const parsed = parseList([
      '||bad host.example/ad.js$script',
      '||bad[host]/ad.js$script',
      'bad|anchor.example/ad.js$script',
      '||ads.example^'
    ].join('\n'));

    assert.strictEqual(parsed.networkRules.length, 1);
    assert.strictEqual(parsed.networkRules[0].condition.urlFilter, '||ads.example^');
    assert.strictEqual(parsed.skipped.unsupportedUrlFilter, 3);
    assert.strictEqual(parsed.stats.translatedRegexFilter, 0);
    assert.strictEqual(parsed.skipped.malformed, 0);
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

  await t.test('drops scriptlet rules with malformed regex arguments', () => {
    const { parseList } = loadParser();
    const parsed = parseList([
      'example.com##+js(m3u-prune, /ad[segment/, /playlist\\.m3u8/)',
      'example.com##+js(m3u-prune, ad-segment, /playlist\\.m3u8/zz)',
      'example.com##+js(replace-node-text, script, "/foo[/", "")',
      'example.com##+js(no-fetch-if, /adserver,tracking/)',
      'example.com##+js(m3u-prune, ad-segment, /playlist\\.m3u8/)'
    ].join('\n'));

    assert.strictEqual(parsed.scriptletRules.length, 2);
    assert.strictEqual(parsed.skipped.malformed, 3);
    assert.deepStrictEqual(plain(parsed.scriptletRules.map(rule => rule.scriptlet)), ['no-fetch-if', 'm3u-prune']);
  });

  await t.test('skips absurdly long filter lines without rejecting the whole list', () => {
    const { parseList } = loadParser();
    const parsed = parseList([
      `||${'a'.repeat(32768)}.example^`,
      '||ads.example^'
    ].join('\n'));

    assert.strictEqual(parsed.skipped.overlong, 1);
    assert.strictEqual(parsed.networkRules.length, 1);
    assert.strictEqual(parsed.networkRules[0].condition.urlFilter, '||ads.example^');
  });

  await t.test('rejects lists that exceed parser line budget', () => {
    const { parseList } = loadParser();
    const list = Array.from({ length: 250001 }, () => '! comment').join('\n');
    assert.throws(
      () => parseList(list),
      /too many lines/
    );
  });

  await t.test('truncates excessive stored network, cosmetic, and scriptlet rules without failing refresh', () => {
    const { parseList } = loadParser();

    const networkList = Array.from({ length: 3 }, (_, index) => `||ads-${index}.example^`).join('\n');
    const parsedNetwork = parseList(networkList, { maxNetworkRules: 2 });
    assert.strictEqual(parsedNetwork.networkRules.length, 2);
    assert.strictEqual(parsedNetwork.skipped.networkLimit, 1);

    const cosmeticList = Array.from({ length: 3 }, (_, index) => `example.com##.ad-${index}`).join('\n');
    const parsedCosmetic = parseList(cosmeticList, { maxCosmeticRules: 2 });
    assert.strictEqual(parsedCosmetic.cosmeticRules.length, 2);
    assert.strictEqual(parsedCosmetic.skipped.cosmeticLimit, 1);

    const scriptletList = Array.from({ length: 3 }, (_, index) => `example.com##+js(set-constant, foo${index}, true)`).join('\n');
    const parsedScriptlet = parseList(scriptletList, { maxScriptletRules: 2 });
    assert.strictEqual(parsedScriptlet.scriptletRules.length, 2);
    assert.strictEqual(parsedScriptlet.skipped.scriptletLimit, 1);
  });

  await t.test('malformed subscription content is counted without crashing', () => {
    const { parseList } = loadParser();
    const parsed = parseList([
      'example.com##+js(',
      '##',
      '||ads.example^'
    ].join('\n'));

    assert.strictEqual(parsed.skipped.malformed, 2);
    assert.strictEqual(parsed.networkRules.length, 1);
    assert.strictEqual(parsed.networkRules[0].condition.urlFilter, '||ads.example^');
  });
});
