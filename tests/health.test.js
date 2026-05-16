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
    ...(options.storage || {})
  };
  const webrtcStatus = options.webrtcStatus || {
    available: true,
    value: 'default',
    levelOfControl: 'controllable_by_this_extension',
    controllable: true,
    protected: false,
    partial: false,
    error: null
  };
  const syncResults = [];
  const browserPrivacySyncResults = [];
  const geolocationSyncResults = [];
  const userScriptSyncResults = [];
  const browserPrivacyStatus = options.browserPrivacyStatus || {
    enabled: storage.config?.browserPrivacyHardening === true,
    available: true,
    active: storage.config?.browserPrivacyHardening === true,
    partial: false,
    hardenedCount: storage.config?.browserPrivacyHardening === true ? 5 : 0,
    totalCount: 5,
    blockedCount: 0,
    settings: []
  };
  const geolocationStatus = options.geolocationStatus || {
    enabled: storage.config?.geolocationProtection === true,
    available: true,
    active: storage.config?.geolocationProtection === true,
    setting: storage.config?.geolocationProtection === true ? 'block' : 'ask',
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
  sandbox._mockGetWebRtcLeakProtectionStatus = async () => webrtcStatus;
  sandbox._mockSyncWebRtcLeakProtection = async (config, proxyConfigs) => {
    syncResults.push({ config, proxyConfigs });
    return options.webrtcSyncResult || { ok: true };
  };
  sandbox._mockGetBrowserPrivacyHardeningStatus = async () => browserPrivacyStatus;
  sandbox._mockSyncBrowserPrivacyHardening = async (config) => {
    browserPrivacySyncResults.push({ config });
    return options.browserPrivacySyncResult || { ok: true };
  };
  sandbox._mockGetGeolocationProtectionStatus = async () => geolocationStatus;
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
      }
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
      }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.subscriptions.total, 2);
    assert.strictEqual(health.subscriptions.enabled, 2);
    assert.strictEqual(health.subscriptions.parsedNetwork, 11);
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
        enabled: true,
        available: true,
        active: true,
        setting: 'block',
        error: null
      }
    });

    const health = await sandbox.getHealthStatus();

    assert.strictEqual(health.master.geolocationProtection, true);
    assert.deepStrictEqual(plain(health.geolocation), {
      enabled: true,
      available: true,
      active: true,
      setting: 'block',
      error: null
    });
    assert.strictEqual(sandbox._geolocationSyncResults.length, 1);
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
      globalProxyConfigured: true
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
      }
    });

    const health = await sandbox.getHealthStatus();

    assert.deepStrictEqual(plain(health.proxy), {
      configuredCount: 1,
      acceptedCount: 1,
      routedDomainCount: 0,
      globalProxyEnabled: true,
      globalProxyConfigured: false
    });
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
