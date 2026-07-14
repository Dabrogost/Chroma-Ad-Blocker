const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const healthJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'health.js'), 'utf8')
  .replace(/import\s*\{[\s\S]*?getWebRtcLeakProtectionStatus,[\s\S]*?syncWebRtcLeakProtection[\s\S]*?\}\s*from\s*'\.\/webrtc\.js';/, `
    var getWebRtcLeakProtectionStatus = globalThis._mockGetWebRtcLeakProtectionStatus;
    var syncWebRtcLeakProtection = globalThis._mockSyncWebRtcLeakProtection;
  `)
  .replace(/import\s*\{[\s\S]*?getBrowserPrivacyHardeningStatus,[\s\S]*?getGeolocationProtectionStatus,[\s\S]*?syncBrowserPrivacyHardening,[\s\S]*?syncGeolocationProtection[\s\S]*?\}\s*from\s*'\.\/browserPrivacy\.js';/, `
    var getBrowserPrivacyHardeningStatus = globalThis._mockGetBrowserPrivacyHardeningStatus;
    var getGeolocationProtectionStatus = globalThis._mockGetGeolocationProtectionStatus;
    var syncBrowserPrivacyHardening = globalThis._mockSyncBrowserPrivacyHardening;
    var syncGeolocationProtection = globalThis._mockSyncGeolocationProtection;
  `)
  .replace("import { syncUserScripts } from '../scriptlets/engine.js';", "var syncUserScripts = globalThis._mockSyncUserScripts || (async () => {});")
  .replace("import { getProxyRoutingStatus } from './proxy.js';", "var getProxyRoutingStatus = globalThis._mockGetProxyRoutingStatus;")
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

function fullUserScriptsApi(overrides = {}) {
  return {
    getScripts: async () => [],
    register: async () => {},
    unregister: async () => {},
    ...overrides
  };
}

function loadHealthSandbox(options = {}) {
  let storageGetCount = 0;
  const storage = {
    config: {
      enabled: true,
      networkBlocking: true,
      cosmetic: true,
      stripping: true,
      acceleration: false,
      fingerprintRandomization: false,
      browserPrivacyHardening: false,
      geolocationProtection: false,
      deAmpLinks: false,
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
    statsV2: { version: 1, totals: { protectionEvents: 0 } },
    requestLog: [],
    appliedNetworkRuleCount: 0,
    healthDiagnostics: {},
    ...(options.storage || {})
  };
  const activeProxyConfigs = (storage.proxyConfigs || []).filter(proxy =>
    proxy?.accepted === true && proxy?.enabled !== false
  );
  const hasValidGlobalProxy = storage.config?.globalProxyEnabled === true &&
    activeProxyConfigs.some(proxy => proxy.id === storage.config?.globalProxyId);
  const requestedWebRtcMode = ['off', 'auto', 'balanced', 'strict'].includes(storage.config?.webRtcLeakProtection)
    ? storage.config.webRtcLeakProtection
    : 'auto';
  const defaultWebRtcRequested = requestedWebRtcMode === 'strict' ||
    requestedWebRtcMode === 'balanced' ||
    (requestedWebRtcMode === 'auto' && hasValidGlobalProxy);
  const defaultWebRtcEnabled = storage.config?.enabled !== false && defaultWebRtcRequested;
  const suppliedWebRtcStatus = options.webrtcStatus || {};
  const desiredWebRtcValue = requestedWebRtcMode === 'balanced'
    ? 'default_public_interface_only'
    : 'disable_non_proxied_udp';
  const webrtcStatus = {
    available: true,
    mode: requestedWebRtcMode,
    requestedMode: requestedWebRtcMode,
    requested: defaultWebRtcRequested,
    enabled: defaultWebRtcEnabled,
    masterEnabled: storage.config?.enabled !== false,
    desiredAction: defaultWebRtcEnabled ? 'set' : 'clear',
    value: 'default',
    levelOfControl: 'controllable_by_this_extension',
    controllable: true,
    controlledByThisExtension: false,
    effective: false,
    released: !defaultWebRtcEnabled,
    protected: false,
    partial: false,
    recommended: defaultWebRtcRequested,
    error: null,
    ...suppliedWebRtcStatus
  };
  if (!Object.prototype.hasOwnProperty.call(suppliedWebRtcStatus, 'requested')) {
    webrtcStatus.requested = defaultWebRtcRequested;
  }
  if (!Object.prototype.hasOwnProperty.call(suppliedWebRtcStatus, 'enabled')) {
    webrtcStatus.enabled = defaultWebRtcEnabled;
  }
  if (!Object.prototype.hasOwnProperty.call(suppliedWebRtcStatus, 'controlledByThisExtension')) {
    webrtcStatus.controlledByThisExtension = webrtcStatus.levelOfControl === 'controlled_by_this_extension';
  }
  if (!Object.prototype.hasOwnProperty.call(suppliedWebRtcStatus, 'effective')) {
    webrtcStatus.effective = webrtcStatus.enabled && webrtcStatus.value === desiredWebRtcValue;
  }
  const syncResults = [];
  const browserPrivacySyncResults = [];
  const geolocationSyncResults = [];
  const userScriptSyncResults = [];
  const browserPrivacyRequested = storage.config?.browserPrivacyHardening === true;
  const browserPrivacyEnabled = storage.config?.enabled !== false && browserPrivacyRequested;
  const browserPrivacyStatus = options.browserPrivacyStatus || {
    requested: browserPrivacyRequested,
    enabled: browserPrivacyEnabled,
    available: true,
    active: browserPrivacyEnabled,
    effective: browserPrivacyEnabled,
    controlled: browserPrivacyEnabled,
    partial: false,
    hardenedCount: browserPrivacyEnabled ? 5 : 0,
    controlledCount: browserPrivacyEnabled ? 5 : 0,
    totalCount: 5,
    blockedCount: 0,
    settings: []
  };
  const geolocationRequested = storage.config?.geolocationProtection === true;
  const geolocationEnabled = storage.config?.enabled !== false && geolocationRequested;
  const geolocationStatus = options.geolocationStatus || {
    requested: geolocationRequested,
    enabled: geolocationEnabled,
    available: true,
    active: geolocationEnabled,
    effective: geolocationEnabled,
    controlled: null,
    setting: geolocationEnabled ? 'block' : 'ask',
    error: null
  };
  const requestedProxyRouting = activeProxyConfigs.some(proxy =>
    (proxy.domains || []).some(domain => domain?.enabled !== false)
  ) || (
    storage.config?.globalProxyEnabled === true &&
    activeProxyConfigs.some(proxy => proxy.id === storage.config?.globalProxyId)
  );
  const effectiveGlobalProxy = storage.config?.globalProxyEnabled === true &&
    activeProxyConfigs.some(proxy => proxy.id === storage.config?.globalProxyId);
  const proxyRuntimeStatus = options.proxyRuntimeStatus || {
    available: true,
    levelOfControl: requestedProxyRouting
      ? 'controlled_by_this_extension'
      : 'controllable_by_this_extension',
    controlledByThisExtension: requestedProxyRouting,
    conflict: false,
    requested: { active: requestedProxyRouting, routeCount: requestedProxyRouting ? 1 : 0 },
    effective: { active: requestedProxyRouting, routeCount: requestedProxyRouting ? 1 : 0, global: effectiveGlobalProxy },
    mode: requestedProxyRouting ? 'pac_script' : 'system',
    error: null
  };
  const enabledRulesets = options.enabledRulesets || ['static_a', 'static_b'];
  const dynamicRules = options.dynamicRules || [{ id: 2000 }];
  const dnr = options.noDnr
    ? undefined
    : {
      getEnabledRulesets: async () => enabledRulesets,
      getDynamicRules: async () => dynamicRules
    };
  if (dnr && options.debugLogging !== false) {
    dnr.onRuleMatchedDebug = { addListener: () => {} };
  }
  const userScripts = Object.prototype.hasOwnProperty.call(options, 'userScripts')
    ? options.userScripts
    : fullUserScriptsApi();

  const sandbox = {
    chrome: {
      runtime: {
        getManifest: () => manifest
      },
      storage: {
        local: {
          get: async (keys) => {
            storageGetCount++;
            if (typeof options.onStorageGet === 'function') {
              await options.onStorageGet({ keys, count: storageGetCount, storage });
            }
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
      userScripts,
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
  sandbox._mockGetWebRtcLeakProtectionStatus = async (...args) =>
    typeof options.getWebRtcStatus === 'function' ? options.getWebRtcStatus(storage, ...args) : webrtcStatus;
  sandbox._mockGetProxyRoutingStatus = async () => proxyRuntimeStatus;
  sandbox._mockSyncWebRtcLeakProtection = async (config, proxyConfigs) => {
    syncResults.push({ config, proxyConfigs });
    return options.webrtcSyncResult || { ok: true };
  };
  sandbox._mockGetBrowserPrivacyHardeningStatus = async (...args) =>
    typeof options.getBrowserPrivacyStatus === 'function'
      ? options.getBrowserPrivacyStatus(storage, ...args)
      : browserPrivacyStatus;
  sandbox._mockSyncBrowserPrivacyHardening = async (config) => {
    browserPrivacySyncResults.push({ config });
    return options.browserPrivacySyncResult || { ok: true };
  };
  sandbox._mockGetGeolocationProtectionStatus = async (...args) =>
    typeof options.getGeolocationStatus === 'function'
      ? options.getGeolocationStatus(storage, ...args)
      : geolocationStatus;
  sandbox._mockSyncGeolocationProtection = async (config) => {
    geolocationSyncResults.push({ config });
    return options.geolocationSyncResult || { ok: true };
  };
  sandbox._mockSyncUserScripts = async () => {
    userScriptSyncResults.push({ ts: Date.now() });
    if (typeof options.onUserScriptSync === 'function') {
      await options.onUserScriptSync();
    }
    return options.userScriptSyncResult || undefined;
  };
  sandbox._webrtcSyncResults = syncResults;
  sandbox._browserPrivacySyncResults = browserPrivacySyncResults;
  sandbox._geolocationSyncResults = geolocationSyncResults;
  sandbox._userScriptSyncResults = userScriptSyncResults;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(healthJsCode, sandbox);
  return sandbox;
}

test('health diagnostics', async (t) => {
  await t.test('master disabled returns overall disabled', async () => {
    const sandbox = loadHealthSandbox({
      storage: { config: { enabled: false, networkBlocking: true } }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.overall.status, 'disabled');
    assert.strictEqual(health.master.enabled, false);
  });

  await t.test('master-off reports preserved proxy and subscription requests as paused without mismatch warnings', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        config: {
          enabled: false,
          networkBlocking: true,
          globalProxyEnabled: true,
          globalProxyId: 7
        },
        proxyConfigs: [{
          id: 7,
          host: 'proxy.example.com',
          port: 8080,
          type: 'PROXY',
          accepted: true,
          enabled: true,
          domains: [{ host: 'media.example.com', enabled: true }]
        }],
        subscriptions: [{
          id: 'third-party',
          enabled: true,
          ruleCount: { network: 20, cosmetic: 10, scriptlet: 2 }
        }],
        sub_scriptlet_rules: {
          'third-party': [
            { scriptlet: 'set-constant', args: ['first', 'true'] },
            { scriptlet: 'set-constant', args: ['second', 'true'] }
          ]
        },
        appliedNetworkRuleCount: 20
      },
      enabledRulesets: [],
      dynamicRules: [],
      proxyRuntimeStatus: {
        available: true,
        levelOfControl: 'controllable_by_this_extension',
        controlledByThisExtension: false,
        conflict: false,
        requested: { active: false, routeCount: 0 },
        effective: { active: false, routeCount: 0, global: false },
        mode: 'system',
        error: null
      }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.overall.status, 'disabled');
    assert.strictEqual(health.proxy.requestedRouting, true);
    assert.strictEqual(health.proxy.effectiveRouting, false);
    assert.strictEqual(health.proxy.conflict, false);
    assert.strictEqual(health.subscriptions.enabled, 1);
    assert.strictEqual(health.subscriptions.appliedNetwork, 0);
    assert.strictEqual(health.scriptlets.subscriptionStoredRuleCount, 2);
    assert.strictEqual(health.scriptlets.subscriptionRuntimeRuleCount, 0);
    assert.strictEqual(health.overall.issues.some(issue => issue.area === 'proxy'), false);
  });

  await t.test('master-off stored scriptlets do not retry registration or report missing runtime scripts', async () => {
    for (const userScripts of [undefined, fullUserScriptsApi({ getScripts: async () => [] })]) {
      const sandbox = loadHealthSandbox({
        storage: {
          config: { enabled: false, networkBlocking: true },
          subscriptions: [{ id: 'third-party', enabled: true }],
          sub_scriptlet_rules: {
            'third-party': [{ scriptlet: 'set-constant', args: ['x', 'true'] }]
          },
          subscriptionScriptletRules: [],
          userScriptletRules: [{ scriptlet: 'advanced-resource', args: [] }]
        },
        userScripts
      });

      const health = await sandbox.getHealthStatus();

      assert.strictEqual(health.overall.status, 'disabled');
      assert.strictEqual(sandbox._userScriptSyncResults.length, 0);
      assert.strictEqual(health.overall.issues.some(issue => issue.area === 'scriptlets'), false);
    }
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
    assert.ok(health.overall.issues.some(issue =>
      issue.area === 'scriptlets' &&
      issue.severity === 'warning' &&
      /1 subscription scriptlet rule cannot be registered/i.test(issue.message)
    ));
  });

  await t.test('user scriptlet resource errors return degraded without raw URLs', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        userScriptletRules: [{ scriptlet: 'custom-scriptlet', args: [], domains: ['example.com'] }],
        userScriptletResources: {
          'custom-scriptlet': {
            name: 'custom-scriptlet',
            sourceId: 'usr_test',
            code: '(function(){})();'
          }
        },
        userScriptletSources: [{
          id: 'usr_test',
          name: 'Custom',
          url: 'https://cdn.example.com/resources.js',
          lastError: 'HTTP 503 at https://cdn.example.com/resources.js'
        }]
      },
      userScripts: fullUserScriptsApi({ getScripts: async () => [{ id: 'user_scriptlet_1' }] })
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.overall.status, 'degraded');
    assert.strictEqual(health.scriptlets.storedRuleCount, 1);
    assert.strictEqual(health.scriptlets.userStoredRuleCount, 1);
    assert.strictEqual(health.scriptlets.userResourceCount, 1);
    assert.strictEqual(health.scriptlets.userResourceErrorCount, 1);
    const issue = health.overall.issues.find(item => /user scriptlet resource has refresh errors/i.test(item.message));
    assert.ok(issue);
    assert.strictEqual(JSON.stringify(health).includes('cdn.example.com'), false);
  });

  await t.test('userScripts unavailable consolidates scriptlet registration diagnostics', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        subscriptionScriptletRules: [
          { scriptlet: 'set-constant', args: ['x', 'true'] },
          { scriptlet: 'json-prune', args: ['adPlacements'] }
        ],
        healthDiagnostics: {
          scriptletRegistration: {
            area: 'scriptlets',
            severity: 'warning',
            message: 'Subscription scriptlets could not be registered because the UserScripts API is unavailable.',
            action: 'Open Chrome extension details and enable Allow User Scripts.',
            error: 'UserScripts API unavailable',
            ts: 1234
          }
        }
      },
      userScripts: undefined
    });

    const health = await sandbox.getHealthStatus();
    const scriptletIssues = health.overall.issues.filter(issue => issue.area === 'scriptlets');

    assert.strictEqual(health.overall.status, 'degraded');
    assert.strictEqual(scriptletIssues.length, 1);
    assert.match(scriptletIssues[0].message, /2 subscription scriptlet rules cannot be registered/i);
  });

  await t.test('userScripts unavailable is visible without degrading when no scriptlet rules are stored', async () => {
    const sandbox = loadHealthSandbox({
      userScripts: undefined
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.overall.status, 'healthy');
    assert.strictEqual(health.scriptlets.apiAvailable, false);
    assert.strictEqual(health.scriptlets.registrationStatus, 'unavailable');
    assert.strictEqual(health.overall.issues.some(issue => issue.area === 'scriptlets'), false);
  });

  await t.test('partial userScripts API is reported unavailable', async () => {
    for (const userScripts of [
      { register: async () => {} },
      { getScripts: async () => [], register: async () => {} },
      { getScripts: async () => [], unregister: async () => {} },
      { getScripts: true, register: async () => {}, unregister: async () => {} }
    ]) {
      const sandbox = loadHealthSandbox({
        storage: {
          subscriptionScriptletRules: [{ scriptlet: 'set-constant', args: ['x', 'true'] }]
        },
        userScripts
      });

      const health = await sandbox.getHealthStatus();

      assert.strictEqual(health.scriptlets.apiAvailable, false);
      assert.strictEqual(health.scriptlets.registrationStatus, 'unavailable');
    }
  });

  await t.test('complete userScripts API is reported available', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        subscriptionScriptletRules: [{ scriptlet: 'set-constant', args: ['x', 'true'] }]
      },
      userScripts: fullUserScriptsApi({
        getScripts: async () => [{ id: 'scriptlet_1' }]
      })
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.scriptlets.apiAvailable, true);
    assert.strictEqual(health.scriptlets.registeredUserScriptCount, 1);
    assert.strictEqual(health.scriptlets.registrationStatus, 'active');
  });

  await t.test('stored scriptlets self-heal when userScripts becomes available but registry is empty', async () => {
    const registered = [];
    const sandbox = loadHealthSandbox({
      storage: {
        subscriptionScriptletRules: [{ scriptlet: 'set-constant', args: ['x', 'true'] }]
      },
      userScripts: fullUserScriptsApi({
        getScripts: async () => registered
      }),
      onUserScriptSync: async () => {
        registered.push({ id: 'scriptlet_1' });
      }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(sandbox._userScriptSyncResults.length, 1);
    assert.strictEqual(health.overall.status, 'healthy');
    assert.strictEqual(health.scriptlets.apiAvailable, true);
    assert.strictEqual(health.scriptlets.registeredUserScriptCount, 1);
    assert.strictEqual(health.scriptlets.registrationStatus, 'active');
  });

  await t.test('empty userScripts registry remains degraded when retry cannot register parsed scriptlets', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        subscriptionScriptletRules: [{ scriptlet: 'set-constant', args: ['x', 'true'] }]
      },
      userScripts: fullUserScriptsApi({
        getScripts: async () => []
      })
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(sandbox._userScriptSyncResults.length, 1);
    assert.strictEqual(health.overall.status, 'degraded');
    assert.strictEqual(health.scriptlets.apiAvailable, true);
    assert.strictEqual(health.scriptlets.registeredUserScriptCount, 0);
    assert.ok(health.overall.issues.some(issue =>
      issue.area === 'scriptlets' &&
      /not registered/i.test(issue.message)
    ));
  });

  await t.test('fingerprint randomization reports active registered surfaces', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        config: {
          enabled: true,
          networkBlocking: true,
          fingerprintRandomization: true
        }
      },
      scripting: {
        getRegisteredContentScripts: async () => [{ id: 'chroma_fpr' }]
      }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.overall.status, 'healthy');
    assert.strictEqual(health.fpr.enabled, true);
    assert.strictEqual(health.fpr.active, true);
    assert.strictEqual(health.fpr.registrationStatus, 'active');
    assert.ok(health.fpr.protectedSurfaces.includes('Language APIs'));
  });

  await t.test('fingerprint randomization warns when enabled but not registered', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        config: {
          enabled: true,
          networkBlocking: true,
          fingerprintRandomization: true
        }
      },
      scripting: {
        getRegisteredContentScripts: async () => []
      }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.overall.status, 'degraded');
    assert.strictEqual(health.fpr.enabled, true);
    assert.strictEqual(health.fpr.active, false);
    assert.strictEqual(health.fpr.registrationStatus, 'missing');
    assert.ok(health.overall.issues.some(issue => issue.area === 'fingerprint'));
  });

  await t.test('userScripts inspection failure reports Allow User Scripts diagnostic', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        subscriptionScriptletRules: [{ scriptlet: 'set-constant', args: ['x', 'true'] }]
      },
      userScripts: fullUserScriptsApi({
        getScripts: async () => {
          throw new Error('User Scripts permission is not enabled');
        }
      })
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.overall.status, 'degraded');
    assert.strictEqual(health.scriptlets.apiAvailable, false);
    assert.strictEqual(health.scriptlets.registrationStatus, 'unavailable');
    assert.match(health.scriptlets.error, /permission is not enabled/i);
    assert.ok(health.overall.issues.some(issue =>
      issue.area === 'scriptlets' &&
      /Allow User Scripts/i.test(issue.message)
    ));
  });

  await t.test('network enabled with missing static ruleset returns error', async () => {
    const sandbox = loadHealthSandbox({
      enabledRulesets: ['static_a']
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
      }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.overall.status, 'degraded');
    assert.strictEqual(health.subscriptions.withErrors, 1);
    assert.strictEqual(health.subscriptions.errors[0].error.includes('https://example.com'), false);
  });

  await t.test('request logging unavailable is diagnostic only', async () => {
    const sandbox = loadHealthSandbox({
      debugLogging: false
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.overall.status, 'healthy');
    assert.strictEqual(health.requestLog.available, false);
    assert.match(health.requestLog.note, /blocking can still work/i);
    assert.ok(health.overall.issues.some(issue => issue.area === 'requestLog' && issue.severity === 'info'));
  });

  await t.test('persisted background diagnostics are surfaced without raw hosts', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        healthDiagnostics: {
          proxyPacSync: {
            area: 'proxy',
            severity: 'warning',
            message: 'Proxy PAC settings could not be applied.',
            action: 'Check proxy settings.',
            error: 'Failed to proxy proxy.example.com via https://proxy.example.com/pac',
            ts: 1234
          }
        }
      }
    });

    const health = await sandbox.getHealthStatus();
    const serialized = JSON.stringify(plain(health));

    assert.strictEqual(health.overall.status, 'degraded');
    assert.strictEqual(health.diagnostics.length, 1);
    assert.strictEqual(health.diagnostics[0].area, 'proxy');
    assert.match(health.diagnostics[0].error, /\[host\]|\[url\]/);
    assert.strictEqual(serialized.includes('proxy.example.com'), false);
    assert.ok(health.overall.issues.some(issue =>
      issue.area === 'proxy' &&
      /PAC settings/i.test(issue.message)
    ));
  });

  await t.test('persisted error diagnostics move health to error', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        healthDiagnostics: {
          dnrDynamicRules: {
            area: 'dnr',
            severity: 'error',
            message: 'Dynamic DNR rules could not be synchronized.',
            action: 'Reload the extension.',
            error: 'updateDynamicRules failed',
            ts: 1234
          }
        }
      }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.overall.status, 'error');
    assert.ok(health.overall.issues.some(issue =>
      issue.area === 'dnr' &&
      issue.severity === 'error' &&
      /Dynamic DNR/i.test(issue.message)
    ));
  });

  await t.test('De-AMP status is reported as an opt-in master protection', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        config: {
          enabled: true,
          networkBlocking: false,
          deAmpLinks: true
        }
      }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.master.deAmpLinks, true);
    assert.strictEqual(health.overall.status, 'disabled');
  });

  await t.test('Tracking URL Cleanup warns when enabled but its dynamic rule is missing', async () => {
    const sandbox = loadHealthSandbox({
      dynamicRules: [],
      storage: {
        config: {
          enabled: true,
          networkBlocking: true,
          trackingUrlCleanup: true
        }
      }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.overall.status, 'degraded');
    assert.strictEqual(health.master.trackingUrlCleanup, true);
    assert.strictEqual(health.dnr.trackingUrlCleanupRuleCount, 0);
    assert.strictEqual(health.dnr.trackingUrlCleanupActive, false);
    assert.ok(health.overall.issues.some(issue =>
      issue.area === 'trackingUrlCleanup' &&
      /not registered/i.test(issue.message)
    ));
  });

  await t.test('Geolocation Protection status is reported as browser privacy', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        config: {
          enabled: true,
          networkBlocking: true,
          geolocationProtection: true
        }
      },
      geolocationStatus: {
        requested: true,
        enabled: true,
        available: true,
        active: true,
        effective: true,
        controlled: null,
        setting: 'block',
        error: null
      }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.master.geolocationProtection, true);
    assert.deepStrictEqual(plain(health.geolocation), {
      requested: true,
      enabled: true,
      available: true,
      active: true,
      effective: true,
      controlled: null,
      setting: 'block',
      error: null,
      released: false,
      reconciliationError: null
    });
    assert.strictEqual(sandbox._geolocationSyncResults.length, 1);
  });

  await t.test('master-off privacy requests are reported as paused and ineffective', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        config: {
          enabled: false,
          networkBlocking: true,
          browserPrivacyHardening: true,
          geolocationProtection: true,
          webRtcLeakProtection: 'strict'
        }
      }
    });

    const health = await sandbox.getHealthStatus();
    assert.strictEqual(health.browserPrivacy.requested, true);
    assert.strictEqual(health.browserPrivacy.enabled, false);
    assert.strictEqual(health.browserPrivacy.effective, false);
    assert.strictEqual(health.geolocation.requested, true);
    assert.strictEqual(health.geolocation.enabled, false);
    assert.strictEqual(health.geolocation.effective, false);
    assert.strictEqual(health.webrtc.requested, true);
    assert.strictEqual(health.webrtc.enabled, false);
    assert.strictEqual(health.webrtc.effective, false);
    assert.strictEqual(health.overall.status, 'disabled');
    assert.strictEqual(health.overall.issues.some(issue =>
      ['browserPrivacy', 'geolocation', 'webrtc'].includes(issue.area) && issue.severity === 'warning'
    ), false);
  });

  await t.test('Health retries when privacy config changes during reconciliation', async () => {
    const makeBrowserStatus = storage => {
      const requested = storage.config?.browserPrivacyHardening === true;
      const enabled = storage.config?.enabled !== false && requested;
      return {
        requested,
        enabled,
        available: true,
        active: enabled,
        effective: enabled,
        controlled: enabled,
        partial: false,
        hardenedCount: enabled ? 5 : 0,
        controlledCount: enabled ? 5 : 0,
        totalCount: 5,
        blockedCount: 0,
        settings: []
      };
    };
    const sandbox = loadHealthSandbox({
      storage: {
        config: {
          enabled: true,
          networkBlocking: true,
          browserPrivacyHardening: true,
          geolocationProtection: true,
          webRtcLeakProtection: 'strict'
        }
      },
      onStorageGet: ({ count, storage }) => {
        if (count === 2) storage.config = { ...storage.config, enabled: false };
      },
      getBrowserPrivacyStatus: storage => makeBrowserStatus(storage),
      getGeolocationStatus: storage => {
        const requested = storage.config?.geolocationProtection === true;
        const enabled = storage.config?.enabled !== false && requested;
        return {
          requested,
          enabled,
          available: true,
          active: enabled,
          effective: enabled,
          controlled: null,
          setting: enabled ? 'block' : 'ask',
          error: null
        };
      },
      getWebRtcStatus: storage => ({
        available: true,
        mode: 'strict',
        requestedMode: 'strict',
        requested: true,
        enabled: storage.config?.enabled !== false,
        masterEnabled: storage.config?.enabled !== false,
        desiredAction: storage.config?.enabled !== false ? 'set' : 'clear',
        value: 'default',
        levelOfControl: 'controllable_by_this_extension',
        controllable: true,
        controlledByThisExtension: false,
        effective: false,
        released: true,
        protected: false,
        partial: false,
        recommended: true,
        error: null
      })
    });

    const health = await sandbox.getHealthStatus();
    assert.strictEqual(health.master.enabled, false);
    assert.strictEqual(health.browserPrivacy.requested, true);
    assert.strictEqual(health.browserPrivacy.enabled, false);
    assert.strictEqual(health.geolocation.enabled, false);
    assert.strictEqual(health.webrtc.enabled, false);
    assert.strictEqual(health.overall.status, 'disabled');
  });

  await t.test('master-off geolocation clear failure is visible as an incomplete release', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        config: {
          enabled: false,
          networkBlocking: true,
          geolocationProtection: true
        }
      },
      geolocationSyncResult: { ok: false, error: 'clear failed' }
    });

    const health = await sandbox.getHealthStatus();
    assert.strictEqual(health.geolocation.requested, true);
    assert.strictEqual(health.geolocation.enabled, false);
    assert.strictEqual(health.geolocation.released, false);
    assert.strictEqual(health.geolocation.reconciliationError, 'Geolocation reconciliation failed');
    assert.ok(health.overall.issues.some(issue =>
      issue.area === 'geolocation' && /could not release/i.test(issue.message)
    ));
  });

  await t.test('master-off lingering ChromeSetting ownership is reported as incomplete release', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        config: {
          enabled: false,
          networkBlocking: true,
          browserPrivacyHardening: true,
          webRtcLeakProtection: 'strict'
        }
      },
      browserPrivacyStatus: {
        requested: true,
        enabled: false,
        available: true,
        active: false,
        effective: false,
        controlled: true,
        partial: false,
        hardenedCount: 5,
        controlledCount: 5,
        totalCount: 5,
        blockedCount: 0,
        settings: []
      },
      webrtcStatus: {
        available: true,
        requested: true,
        enabled: false,
        value: 'disable_non_proxied_udp',
        levelOfControl: 'controlled_by_this_extension',
        controllable: true,
        controlledByThisExtension: true,
        effective: false,
        released: false,
        protected: true,
        partial: false,
        error: 'WebRTC privacy setting remains controlled after release'
      }
    });

    const health = await sandbox.getHealthStatus();
    assert.ok(health.overall.issues.some(issue =>
      issue.area === 'browserPrivacy' && /remain controlled/i.test(issue.message)
    ));
    assert.ok(health.overall.issues.some(issue =>
      issue.area === 'webrtc' && /remains controlled/i.test(issue.message)
    ));
  });

  await t.test('externally controlled browser privacy is degraded even when observed values match', async () => {
    const settings = ['thirdPartyCookiesAllowed', 'doNotTrackEnabled', 'adMeasurementEnabled', 'topicsEnabled', 'fledgeEnabled']
      .map(key => ({
        key,
        available: true,
        value: false,
        levelOfControl: 'controlled_by_other_extensions',
        controllable: false,
        controlledByThisExtension: false,
        hardened: true,
        effective: true,
        error: 'Chrome privacy setting is controlled elsewhere'
      }));
    const sandbox = loadHealthSandbox({
      storage: {
        config: { enabled: true, networkBlocking: true, browserPrivacyHardening: true }
      },
      browserPrivacyStatus: {
        requested: true,
        enabled: true,
        available: true,
        active: true,
        effective: true,
        controlled: false,
        partial: false,
        hardenedCount: 5,
        controlledCount: 0,
        totalCount: 5,
        blockedCount: 5,
        settings
      }
    });

    const health = await sandbox.getHealthStatus();
    assert.strictEqual(health.browserPrivacy.effective, true);
    assert.strictEqual(health.browserPrivacy.controlled, false);
    assert.strictEqual(health.overall.status, 'degraded');
    assert.ok(health.overall.issues.some(issue =>
      issue.area === 'browserPrivacy' && /controlled/i.test(issue.message)
    ));
  });

  await t.test('controllable but unapplied Chrome privacy state is distinct from external control', async () => {
    const settings = ['thirdPartyCookiesAllowed', 'doNotTrackEnabled', 'adMeasurementEnabled', 'topicsEnabled', 'fledgeEnabled']
      .map(key => ({
        key,
        available: true,
        value: false,
        levelOfControl: 'controllable_by_this_extension',
        controllable: true,
        controlledByThisExtension: false,
        hardened: true,
        effective: true,
        error: null
      }));
    const sandbox = loadHealthSandbox({
      storage: {
        config: {
          enabled: true,
          networkBlocking: true,
          browserPrivacyHardening: true,
          webRtcLeakProtection: 'strict'
        }
      },
      browserPrivacyStatus: {
        requested: true,
        enabled: true,
        available: true,
        active: true,
        effective: true,
        controlled: false,
        partial: false,
        hardenedCount: 5,
        controlledCount: 0,
        totalCount: 5,
        blockedCount: 0,
        settings
      },
      webrtcStatus: {
        available: true,
        requested: true,
        enabled: true,
        value: 'default',
        levelOfControl: 'controllable_by_this_extension',
        controllable: true,
        controlledByThisExtension: false,
        effective: false,
        protected: false,
        partial: false,
        error: null
      }
    });

    const health = await sandbox.getHealthStatus();
    const browserIssue = health.overall.issues.find(issue => issue.area === 'browserPrivacy');
    const webRtcIssue = health.overall.issues.find(issue => issue.area === 'webrtc');
    assert.match(browserIssue.message, /not fully controlled by Chroma/i);
    assert.doesNotMatch(browserIssue.message, /another extension/i);
    assert.match(webRtcIssue.message, /not controlled by Chroma/i);
    assert.doesNotMatch(webRtcIssue.message, /another extension/i);
  });

  await t.test('requested geolocation with a non-blocking effective setting is degraded', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        config: { enabled: true, networkBlocking: true, geolocationProtection: true }
      },
      geolocationStatus: {
        requested: true,
        enabled: true,
        available: true,
        active: false,
        effective: false,
        controlled: null,
        setting: 'ask',
        error: null
      }
    });

    const health = await sandbox.getHealthStatus();
    assert.strictEqual(health.overall.status, 'degraded');
    assert.ok(health.overall.issues.some(issue =>
      issue.area === 'geolocation' && /not blocked/i.test(issue.message)
    ));
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
      }
    });

    const health = await sandbox.getHealthStatus();
    const serialized = JSON.stringify(plain(health));

    assert.deepStrictEqual(plain(health.proxy), {
      configuredCount: 1,
      acceptedCount: 1,
      routedDomainCount: 1,
      globalProxyEnabled: true,
      globalProxyConfigured: true,
      globalProxyRouteEnabled: true,
      requestedRouting: true,
      effectiveRouting: true,
      effectiveGlobalProxy: true,
      effectiveRouteCount: 1,
      levelOfControl: 'controlled_by_this_extension',
      controlledByThisExtension: true,
      conflict: false,
      error: null
    });
    assert.strictEqual(serialized.includes('proxy.example.com'), false);
    assert.strictEqual(serialized.includes('media.example.com'), false);
    assert.strictEqual(serialized.includes('user-secret'), false);
    assert.strictEqual(serialized.includes('pass-secret'), false);
    assert.strictEqual(serialized.includes('iv-secret'), false);
    assert.strictEqual(serialized.includes('cipher-secret'), false);
  });

  await t.test('disabled proxy domains and global selection are not reported as active routing', async () => {
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
          name: 'Paused',
          host: 'proxy.example.com',
          port: 8080,
          type: 'PROXY',
          accepted: true,
          enabled: false,
          domains: [{ host: 'media.example.com', enabled: true }]
        }]
      },
      webrtcStatus: {
        available: false,
        value: null,
        levelOfControl: null,
        controllable: false,
        protected: false,
        partial: false,
        error: null
      }
    });

    const health = await sandbox.getHealthStatus();

    assert.deepStrictEqual(plain(health.proxy), {
      configuredCount: 1,
      acceptedCount: 1,
      routedDomainCount: 0,
      globalProxyEnabled: true,
      globalProxyConfigured: true,
      globalProxyRouteEnabled: false,
      requestedRouting: false,
      effectiveRouting: false,
      effectiveGlobalProxy: false,
      effectiveRouteCount: 0,
      levelOfControl: 'controllable_by_this_extension',
      controlledByThisExtension: false,
      conflict: false,
      error: null
    });
    assert.strictEqual(health.webrtc.recommended, false);
    assert.strictEqual(health.overall.issues.some(issue => issue.area === 'webrtc'), false);
  });

  await t.test('external proxy control reports requested routing as ineffective and degraded', async () => {
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
          host: 'proxy.example.com',
          port: 8080,
          type: 'PROXY',
          accepted: true,
          domains: []
        }],
        healthDiagnostics: {
          proxyControl: {
            area: 'proxy',
            severity: 'warning',
            message: 'Proxy routing is requested but Chrome proxy settings are controlled elsewhere.'
          }
        }
      },
      proxyRuntimeStatus: {
        available: true,
        levelOfControl: 'controlled_by_other_extensions',
        controlledByThisExtension: false,
        conflict: false,
        requested: { active: true, routeCount: 1 },
        effective: { active: false, routeCount: 0 },
        mode: 'fixed_servers',
        error: null
      }
    });

    const health = await sandbox.getHealthStatus();
    assert.strictEqual(health.proxy.requestedRouting, true);
    assert.strictEqual(health.proxy.effectiveRouting, false);
    assert.strictEqual(health.proxy.levelOfControl, 'controlled_by_other_extensions');
    assert.strictEqual(health.proxy.conflict, true);
    assert.strictEqual(health.overall.status, 'degraded');
    const proxyIssues = health.overall.issues.filter(issue => issue.area === 'proxy');
    assert.strictEqual(proxyIssues.length, 1);
    assert.match(proxyIssues[0].message, /controlled elsewhere/i);
    assert.strictEqual(health.diagnostics.some(diagnostic => diagnostic.id === 'proxyControl'), false);
    assert.strictEqual(JSON.stringify(plain(health)).includes('proxy.example.com'), false);
  });

  await t.test('failed proxy release is degraded without exposing runtime error details', async () => {
    const secretError = 'PAC still points to secret-proxy.example.com with token=private';
    const sandbox = loadHealthSandbox({
      storage: {
        config: { enabled: true, networkBlocking: true },
        proxyConfigs: [{
          id: 7,
          host: 'secret-proxy.example.com',
          port: 8080,
          type: 'PROXY',
          accepted: true,
          enabled: false,
          domains: []
        }],
        healthDiagnostics: {
          proxyControl: {
            area: 'proxy',
            severity: 'warning',
            message: 'Chroma proxy settings were not fully released.',
            error: secretError
          }
        }
      },
      proxyRuntimeStatus: {
        available: true,
        levelOfControl: 'controlled_by_this_extension',
        controlledByThisExtension: true,
        conflict: false,
        requested: { active: false, routeCount: 0 },
        effective: { active: false, routeCount: 0, global: false },
        mode: 'pac_script',
        error: secretError
      }
    });

    const health = await sandbox.getHealthStatus();
    const serialized = JSON.stringify(plain(health));
    assert.strictEqual(health.proxy.requestedRouting, false);
    assert.strictEqual(health.proxy.effectiveRouting, false);
    assert.strictEqual(health.proxy.error, 'Proxy routing status mismatch');
    assert.strictEqual(health.overall.status, 'degraded');
    assert.strictEqual(health.overall.issues.filter(issue => issue.area === 'proxy').length, 1);
    assert.strictEqual(health.diagnostics.some(diagnostic => diagnostic.id === 'proxyControl'), false);
    assert.strictEqual(serialized.includes('secret-proxy.example.com'), false);
    assert.strictEqual(serialized.includes('token=private'), false);
  });

  await t.test('global proxy configured with WebRTC strict has no WebRTC warning', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        config: {
          enabled: true,
          networkBlocking: true,
          globalProxyEnabled: true,
          globalProxyId: 7,
          webRtcLeakProtection: 'auto'
        },
        proxyConfigs: [{
          id: 7,
          host: 'proxy.example.com',
          port: 8080,
          accepted: true
        }]
      },
      webrtcStatus: {
        available: true,
        value: 'disable_non_proxied_udp',
        levelOfControl: 'controlled_by_this_extension',
        controllable: true,
        protected: true,
        partial: false,
        error: null
      }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.webrtc.protected, true);
    assert.strictEqual(health.overall.issues.some(issue => issue.area === 'webrtc'), false);
    assert.strictEqual(sandbox._webrtcSyncResults.length, 1);
  });

  await t.test('global proxy configured with WebRTC off/default creates warning', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        config: {
          enabled: true,
          networkBlocking: true,
          globalProxyEnabled: true,
          globalProxyId: 7,
          webRtcLeakProtection: 'off'
        },
        proxyConfigs: [{
          id: 7,
          host: 'proxy.example.com',
          port: 8080,
          accepted: true
        }]
      },
      webrtcStatus: {
        available: true,
        value: 'default',
        levelOfControl: 'controllable_by_this_extension',
        controllable: true,
        protected: false,
        partial: false,
        error: null
      }
    });

    const health = await sandbox.getHealthStatus();

    assert.ok(health.overall.issues.some(issue => issue.area === 'webrtc' && issue.severity === 'warning'));
  });

  await t.test('privacy API unavailable with global proxy enabled creates warning', async () => {
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
          host: 'proxy.example.com',
          port: 8080,
          accepted: true
        }]
      },
      webrtcStatus: {
        available: false,
        value: null,
        levelOfControl: null,
        controllable: false,
        protected: false,
        partial: false,
        error: 'Chrome privacy WebRTC setting unavailable'
      }
    });

    const health = await sandbox.getHealthStatus();

    assert.ok(health.overall.issues.some(issue => issue.area === 'webrtc' && /could not inspect/i.test(issue.message)));
  });

  await t.test('controlled_by_other_extensions with global proxy enabled creates warning', async () => {
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
          host: 'proxy.example.com',
          port: 8080,
          accepted: true
        }]
      },
      webrtcStatus: {
        available: true,
        value: 'default',
        levelOfControl: 'controlled_by_other_extensions',
        controllable: false,
        protected: false,
        partial: false,
        error: 'WebRTC privacy setting is controlled elsewhere'
      }
    });

    const health = await sandbox.getHealthStatus();

    assert.ok(health.overall.issues.some(issue => issue.area === 'webrtc' && /controlled/i.test(issue.message)));
  });

  await t.test('explicit strict WebRTC request is degraded under external control without a proxy', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        config: {
          enabled: true,
          networkBlocking: true,
          globalProxyEnabled: false,
          globalProxyId: null,
          webRtcLeakProtection: 'strict'
        }
      },
      webrtcStatus: {
        available: true,
        value: 'disable_non_proxied_udp',
        levelOfControl: 'controlled_by_other_extensions',
        controllable: false,
        controlledByThisExtension: false,
        effective: true,
        protected: true,
        partial: false,
        error: 'WebRTC privacy setting is controlled elsewhere'
      }
    });

    const health = await sandbox.getHealthStatus();
    assert.strictEqual(health.webrtc.requested, true);
    assert.strictEqual(health.webrtc.effective, true);
    assert.strictEqual(health.webrtc.controlledByThisExtension, false);
    assert.strictEqual(health.overall.status, 'degraded');
    assert.ok(health.overall.issues.some(issue => issue.area === 'webrtc' && /controlled/i.test(issue.message)));
  });

  await t.test('global proxy disabled with WebRTC off has no WebRTC warning', async () => {
    const sandbox = loadHealthSandbox({
      storage: {
        config: {
          enabled: true,
          networkBlocking: true,
          globalProxyEnabled: false,
          globalProxyId: null,
          webRtcLeakProtection: 'off'
        }
      },
      webrtcStatus: {
        available: true,
        value: 'default',
        levelOfControl: 'controllable_by_this_extension',
        controllable: true,
        protected: false,
        partial: false,
        error: null
      }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.overall.issues.some(issue => issue.area === 'webrtc'), false);
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
      storage: { appliedNetworkRuleCount: 2 }
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
