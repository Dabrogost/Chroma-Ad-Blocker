const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const proxyJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'proxy.js'), 'utf8')
  .replace("import { decryptAuth } from '../core/crypto.js';", 'var decryptAuth = globalThis._mockDecryptAuth;')
  .replace("import { recordStatsEvent } from './stats.js';", 'var recordStatsEvent = globalThis._mockRecordStatsEvent || (() => {});')
  .replace("import { clearHealthDiagnostic, recordHealthDiagnostic } from './diagnostics.js';", 'var clearHealthDiagnostic = globalThis._mockClearHealthDiagnostic || (async () => {}); var recordHealthDiagnostic = globalThis._mockRecordHealthDiagnostic || (async () => {});')
  .replace("import { mutateStoredConfig } from './configCoordinator.js';", 'var mutateStoredConfig = globalThis._mockMutateStoredConfig;')
  .replace(/^export\s+/gm, '')
  + '\nglobalThis.__proxyExports = { syncProxyState, runProxyTest, findAuthProxyConfig, getProxyRoutingStatus, getProxyAuthAttemptCount: () => _authAttempts.size, getProxyString, buildPacDomainConditions, fetchProxyIp, isLikelyIp, PROXY_TEST_DOMAINS, CHROME_SERVICE_BYPASS_DOMAINS };\n';

const PROXY_AUTH_STATS_DELAY_MS = 10000;

function createProxySandbox({
  proxyConfigs = [],
  config = {},
  proxyConfig,
  readStartupStorage = false,
  startupProxyConfigs,
  fetchImpl,
  decryptImpl,
  random = () => 0,
  proxyLevelOfControl = 'controllable_by_this_extension',
  proxySettingValue = { mode: 'system' },
  proxySetError = null,
  proxyClearError = null,
  proxySetTakesEffect = true,
  proxyClearTakesEffect = true
} = {}) {
  let authListener = null;
  let storageChangeListener = null;
  let proxySettingsChangeListener = null;
  const proxySetCalls = [];
  const proxyClearCalls = [];
  const storageSetCalls = [];
  const storageRemoveCalls = [];
  const statsEvents = [];
  const healthDiagnostics = [];
  const clearedHealthDiagnostics = [];
  const fetchCalls = [];
  const proxyGetCalls = [];
  const decryptCalls = [];
  const timeoutCallbacks = [];
  const storage = {
    proxyConfigs,
    config,
    proxyConfig
  };
  const proxySetting = {
    levelOfControl: proxyLevelOfControl,
    value: proxySettingValue
  };
  const mockMath = Object.create(Math);
  mockMath.random = random;

  const chrome = {
    storage: {
      local: {
        get: (keys) => {
          if (Array.isArray(keys)) {
            const result = {};
            for (const key of keys) {
              result[key] = readStartupStorage
                ? (key === 'proxyConfigs' ? startupProxyConfigs : storage[key])
                : undefined;
            }
            // Run module bootstrap deterministically before the harness is
            // returned; later string-key reads still use ordinary promises.
            return { then: callback => Promise.resolve(callback(result)) };
          }
          if (typeof keys === 'string') {
            return Promise.resolve({ [keys]: storage[keys] });
          }
          return Promise.resolve({ ...storage });
        },
        set: async (values) => {
          Object.assign(storage, values);
          storageSetCalls.push(values);
        },
        remove: async (key) => {
          delete storage[key];
          storageRemoveCalls.push(key);
        }
      },
      onChanged: {
        addListener: (listener) => {
          storageChangeListener = listener;
        }
      }
    },
    proxy: {
      settings: {
        get: async (args) => {
          proxyGetCalls.push(args);
          return { levelOfControl: proxySetting.levelOfControl, value: proxySetting.value };
        },
        set: async (args) => {
          if (proxySetError) throw proxySetError;
          proxySetCalls.push(args);
          if (proxySetTakesEffect) {
            proxySetting.value = args.value;
            proxySetting.levelOfControl = 'controlled_by_this_extension';
          }
        },
        clear: async (args) => {
          if (proxyClearError) throw proxyClearError;
          proxyClearCalls.push(args);
          if (proxyClearTakesEffect && proxySetting.levelOfControl !== 'controlled_by_other_extensions' &&
              proxySetting.levelOfControl !== 'not_controllable') {
            proxySetting.value = { mode: 'system' };
            proxySetting.levelOfControl = 'controllable_by_this_extension';
          }
        },
        onChange: {
          addListener: listener => { proxySettingsChangeListener = listener; }
        }
      }
    },
    webRequest: {
      onAuthRequired: {
        addListener: (listener) => {
          authListener = listener;
        }
      }
    }
  };

  const sandbox = {
    chrome,
    console,
    setInterval: () => {},
    setTimeout: (fn, delay) => {
      if (delay === PROXY_AUTH_STATS_DELAY_MS) {
        timeoutCallbacks.push(fn);
        return timeoutCallbacks.length;
      }
      fn();
      return 1;
    },
    clearTimeout: () => {},
    Math: mockMath,
    Date,
    AbortController,
    URL,
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      if (fetchImpl) return fetchImpl(url, options, fetchCalls);
      return { ok: true, text: async () => '203.0.113.7\n' };
    },
    _mockDecryptAuth: async (iv, cipher) => {
      decryptCalls.push({ iv, cipher });
      if (decryptImpl) return decryptImpl(iv, cipher, decryptCalls);
      return { username: `user:${iv}`, password: `pass:${cipher}` };
    },
    _mockRecordStatsEvent: event => { statsEvents.push(event); },
    _mockRecordHealthDiagnostic: (id, entry) => { healthDiagnostics.push({ id, entry }); },
    _mockClearHealthDiagnostic: id => { clearedHealthDiagnostics.push(id); },
    _mockMutateStoredConfig: async mutator => {
      const nextConfig = await mutator(storage.config || {});
      if (!nextConfig) return { changed: false, config: storage.config || {} };
      storage.config = nextConfig;
      storageSetCalls.push({ config: nextConfig });
      return { changed: true, config: nextConfig };
    }
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(proxyJsCode, sandbox);

  return {
    chrome,
    storage,
    proxySetCalls,
    proxyClearCalls,
    storageSetCalls,
    storageRemoveCalls,
    statsEvents,
    healthDiagnostics,
    clearedHealthDiagnostics,
    fetchCalls,
    proxyGetCalls,
    proxySetting,
    decryptCalls,
    runPendingTimers: () => {
      const callbacks = timeoutCallbacks.splice(0);
      callbacks.forEach(fn => fn());
    },
    get authListener() {
      return authListener;
    },
    get storageChangeListener() {
      return storageChangeListener;
    },
    get proxySettingsChangeListener() {
      return proxySettingsChangeListener;
    },
    ...sandbox.__proxyExports
  };
}

function pacData(proxyHarness) {
  const last = proxyHarness.proxySetCalls.at(-1);
  return last?.value?.pacScript?.data || '';
}

function evaluatePac(pac, host) {
  const sandbox = {
    dnsDomainIs: (candidate, domain) => String(candidate).endsWith(domain)
  };
  vm.createContext(sandbox);
  vm.runInContext(`${pac}\nglobalThis.__pacResult = FindProxyForURL('https://${host}/', ${JSON.stringify(host)});`, sandbox);
  return sandbox.__pacResult;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function flushAsyncWork() {
  for (let index = 0; index < 4; index++) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

function baseProxy(overrides = {}) {
  return {
    id: 1,
    accepted: true,
    type: 'PROXY',
    host: 'proxy.example.com',
    port: 8080,
    domains: [{ host: 'example.com', enabled: true }],
    ...overrides
  };
}

test('Proxy PAC hardening', async (t) => {
  await t.test('generates canonical PAC proxy strings and safe domain checks', async () => {
    const harness = createProxySandbox();

    await harness.syncProxyState([
      baseProxy(),
      baseProxy({ id: 2, type: 'HTTPS', host: 'secure.example.com', port: 8443, domains: [{ host: 'secure.example.com', enabled: true }] }),
      baseProxy({ id: 3, type: 'SOCKS5', host: 'socks.example.com', port: 1080, domains: [{ host: 'socks.example.com', enabled: true }] })
    ]);

    const pac = pacData(harness);
    assert.match(pac, /function FindProxyForURL\(url, host\)/);
    assert.match(pac, /host === "example\.com"/);
    assert.match(pac, /dnsDomainIs\(host, "\.example\.com"\)/);
    assert.match(pac, /return "PROXY proxy\.example\.com:8080"/);
    assert.match(pac, /return "HTTPS secure\.example\.com:8443"/);
    assert.match(pac, /return "SOCKS5 socks\.example\.com:1080"/);
    assert.doesNotMatch(pac, /undefined|\[object Object\]/);
  });

  await t.test('filters unusual stored domain strings before PAC routing', async () => {
    const harness = createProxySandbox();

    await harness.syncProxyState([
      baseProxy({
        domains: [
          { host: 'good.example.com', enabled: true },
          { host: 'bad..example.com', enabled: true },
          { host: 'bad"quote.example.com', enabled: true }
        ]
      })
    ]);

    const pac = pacData(harness);
    assert.match(pac, /good\.example\.com/);
    assert.doesNotMatch(pac, /bad\.\.example\.com|bad"quote\.example\.com/);
  });

  await t.test('expands YouTube smart-link routing to playback and API hosts', async () => {
    const harness = createProxySandbox({ config: { chromeServiceProxyBypass: false } });

    await harness.syncProxyState([
      baseProxy({ domains: [{ host: 'youtube.com', enabled: true }] })
    ]);

    const pac = pacData(harness);
    const escapeDomain = domain => domain.replace(/\./g, '\\.');
    for (const domain of [
      'youtube.com',
      'googlevideo.com',
      'ytimg.com',
      'ggpht.com',
      'youtube-nocookie.com',
      'youtu.be',
      'youtubei.googleapis.com',
      'youtube.googleapis.com'
    ]) {
      assert.match(pac, new RegExp(`host === "${escapeDomain(domain)}"`));
      assert.match(pac, new RegExp(`dnsDomainIs\\(host, "\\.${escapeDomain(domain)}"\\)`));
    }

    assert.doesNotMatch(pac, /www\.googleapis\.com|googleusercontent\.com|gstatic\.com/);
  });

  await t.test('enables Chrome browser service DIRECT bypass by default', async () => {
    const harness = createProxySandbox({ config: { globalProxyEnabled: true, globalProxyId: 9 } });

    await harness.syncProxyState([
      baseProxy({ id: 9, host: 'global.example.com', domains: [] })
    ]);

    const pac = pacData(harness);
    assert.match(pac, /host === "optimizationguide-pa\.googleapis\.com"/);
    assert.match(pac, /host === "gemini\.google\.com"/);
    assert.match(pac, /host === "generativelanguage\.googleapis\.com"/);
    assert.match(pac, /host === "accounts\.google\.com"/);
    assert.match(pac, /host = String\(host \|\| ''\)\.toLowerCase\(\)\.replace\(\/\\\.\$\/, ''\);/);
    assert.match(pac, /host === "edgedl\.me\.gvt1\.com"/);
    assert.match(pac, /host === "storage\.googleapis\.com"/);
    assert.match(pac, /host === "aratea-pa\.googleapis\.com"/);
    assert.match(pac, /dnsDomainIs\(host, "\.googleusercontent\.com"\)/);
    assert.match(pac, /return 'DIRECT';/);
  });

  await t.test('Chrome browser service bypass matches uppercase and trailing-dot hosts', async () => {
    const harness = createProxySandbox({ config: { globalProxyEnabled: true, globalProxyId: 9 } });

    await harness.syncProxyState([
      baseProxy({ id: 9, host: 'global.example.com', domains: [] })
    ]);

    const pac = pacData(harness);
    assert.strictEqual(evaluatePac(pac, 'OptimizationGuide-PA.GoogleAPIs.com.'), 'DIRECT');
    assert.strictEqual(evaluatePac(pac, 'Gemini.Google.com.'), 'DIRECT');
    assert.strictEqual(evaluatePac(pac, 'GenerativeLanguage.GoogleAPIs.com.'), 'DIRECT');
    assert.strictEqual(evaluatePac(pac, 'download.edgedl.me.gvt1.com.'), 'DIRECT');
    assert.strictEqual(evaluatePac(pac, 'regular.example.com'), 'PROXY global.example.com:8080');
  });

  await t.test('enables Chrome browser service DIRECT bypass when explicitly true', async () => {
    const harness = createProxySandbox({
      config: { globalProxyEnabled: true, globalProxyId: 9, chromeServiceProxyBypass: true }
    });

    await harness.syncProxyState([
      baseProxy({ id: 9, host: 'global.example.com', domains: [] })
    ]);

    assert.match(pacData(harness), /host === "update\.googleapis\.com"[\s\S]*return 'DIRECT';/);
  });

  await t.test('omits Chrome browser service DIRECT bypass when explicitly false', async () => {
    const harness = createProxySandbox({
      config: { globalProxyEnabled: true, globalProxyId: 9, chromeServiceProxyBypass: false }
    });

    await harness.syncProxyState([
      baseProxy({ id: 9, host: 'global.example.com', domains: [] })
    ]);

    const pac = pacData(harness);
    assert.doesNotMatch(pac, /optimizationguide-pa\.googleapis\.com|googleusercontent\.com|gstatic\.com/);
    assert.match(pac, /return "PROXY global\.example\.com:8080"/);
  });

  await t.test('Chrome browser service bypass is evaluated before global fallback', async () => {
    const harness = createProxySandbox({ config: { globalProxyEnabled: true, globalProxyId: 9 } });

    await harness.syncProxyState([
      baseProxy({ id: 9, host: 'global.example.com', domains: [] })
    ]);

    const pac = pacData(harness);
    const bypassIndex = pac.indexOf('optimizationguide-pa.googleapis.com');
    const fallbackIndex = pac.lastIndexOf('return "PROXY global.example.com:8080"');
    assert.ok(bypassIndex > -1, 'expected Chrome service bypass');
    assert.ok(fallbackIndex > -1, 'expected global fallback');
    assert.ok(bypassIndex < fallbackIndex, 'Chrome service bypass must be evaluated before global fallback');
  });

  await t.test('skips invalid stored configs and releases proxy settings when none remain', async () => {
    const harness = createProxySandbox();

    await harness.syncProxyState([
      baseProxy({ id: 1, accepted: false }),
      baseProxy({ id: 2, type: 'HTTP' }),
      baseProxy({ id: 3, port: 70000 }),
      baseProxy({ id: 4, host: 'bad..example.com' }),
      baseProxy({ id: 5, host: '.bad.example.com' }),
      baseProxy({ id: 6, host: 'bad"quote.example.com' })
    ]);

    assert.strictEqual(harness.proxySetCalls.length, 0);
    assert.strictEqual(harness.proxyClearCalls.length, 0);
  });

  await t.test('rejects malformed stored proxy IDs from global and domain routes', async () => {
    for (const { label, id } of [
      { label: 'fractional', id: 1.5 },
      { label: 'unsafe', id: Number.MAX_SAFE_INTEGER + 1 },
      { label: 'NaN', id: Number.NaN }
    ]) {
      const malformed = baseProxy({
        id,
        host: `${label.toLowerCase()}-proxy.example.com`,
        domains: [{ host: `${label.toLowerCase()}-route.example.com`, enabled: true }]
      });
      const valid = baseProxy({
        id: 7,
        host: 'valid-proxy.example.com',
        domains: [{ host: 'valid-route.example.com', enabled: true }]
      });
      const harness = createProxySandbox({
        config: { globalProxyEnabled: true, globalProxyId: id },
        proxyConfigs: [malformed, valid]
      });

      const status = await harness.syncProxyState(harness.storage.proxyConfigs);
      const pac = pacData(harness);

      assert.deepStrictEqual(plain(harness.storage.config), {
        globalProxyEnabled: false,
        globalProxyId: null
      }, `${label} global selection should be cleared`);
      assert.strictEqual(status.requested.global, false, `${label} global selection should fail closed`);
      assert.match(pac, /valid-route\.example\.com/);
      assert.doesNotMatch(pac, new RegExp(`${label.toLowerCase()}-(?:proxy|route)\\.example\\.com`));
      assert.strictEqual(evaluatePac(pac, 'valid-route.example.com'), 'PROXY valid-proxy.example.com:8080');
      assert.strictEqual(evaluatePac(pac, `${label.toLowerCase()}-route.example.com`), 'DIRECT');
      assert.strictEqual(evaluatePac(pac, 'unrelated.example.com'), 'DIRECT');
    }
  });

  await t.test('uses valid global fallback and clears invalid global state with a guarded write', async () => {
    const valid = createProxySandbox({ config: { globalProxyEnabled: true, globalProxyId: 9 } });

    await valid.syncProxyState([
      baseProxy({ id: 9, host: 'global.example.com', domains: [] })
    ]);

    assert.match(pacData(valid), /return "PROXY global\.example\.com:8080"/);
    assert.strictEqual(valid.storageSetCalls.length, 0);

    const invalid = createProxySandbox({
      config: { enabled: false, networkBlocking: false, globalProxyEnabled: true, globalProxyId: 10 }
    });
    await invalid.syncProxyState([
      baseProxy({ id: 10, host: 'bad.example.com', domains: [], accepted: false })
    ]);

    assert.deepStrictEqual(plain(invalid.storage.config), {
      enabled: false,
      networkBlocking: false,
      globalProxyEnabled: false,
      globalProxyId: null
    });
    assert.strictEqual(invalid.proxySetCalls.length, 0);
  });

  await t.test('disabled proxy with enabled domains does not generate domain PAC rules', async () => {
    const harness = createProxySandbox({ config: { globalProxyEnabled: true, globalProxyId: 2 } });

    await harness.syncProxyState([
      baseProxy({ id: 1, host: 'media.example.com', enabled: false, domains: [{ host: 'youtube.com', enabled: true }] }),
      baseProxy({ id: 2, host: 'global.example.com', domains: [] })
    ]);

    const pac = pacData(harness);
    assert.doesNotMatch(pac, /youtube\.com|googlevideo\.com/);
    assert.match(pac, /return "PROXY global\.example\.com:8080"/);
  });

  await t.test('enabled proxy with enabled domains still generates domain PAC rules', async () => {
    const harness = createProxySandbox();

    await harness.syncProxyState([
      baseProxy({ enabled: true, domains: [{ host: 'youtube.com', enabled: true }] })
    ]);

    const pac = pacData(harness);
    assert.match(pac, /host === "youtube\.com"/);
    assert.match(pac, /host === "googlevideo\.com"/);
  });

  await t.test('stress-tests PAC generation for large proxy domain lists', async () => {
    const harness = createProxySandbox({ config: { chromeServiceProxyBypass: false } });
    const largeDomains = Array.from({ length: 2500 }, (_, index) => ({
      host: `media-${String(index).padStart(4, '0')}.large.example`,
      enabled: true
    }));

    await harness.syncProxyState([
      baseProxy({
        host: 'bulk.example.com',
        domains: largeDomains
      })
    ]);

    const firstPac = pacData(harness);
    assert.match(firstPac, /function FindProxyForURL\(url, host\)/);
    assert.match(firstPac, /host === "media-0000\.large\.example"/);
    assert.match(firstPac, /host === "media-2499\.large\.example"/);
    assert.doesNotMatch(firstPac, /undefined|\[object Object\]/);
    assert.strictEqual(evaluatePac(firstPac, 'media-0000.large.example'), 'PROXY bulk.example.com:8080');
    assert.strictEqual(evaluatePac(firstPac, 'cdn.media-2499.large.example'), 'PROXY bulk.example.com:8080');
    assert.strictEqual(evaluatePac(firstPac, 'unrelated.example'), 'DIRECT');

    await harness.syncProxyState([
      baseProxy({
        host: 'bulk.example.com',
        domains: largeDomains
      })
    ]);

    assert.strictEqual(pacData(harness), firstPac);
  });

  await t.test('domain-specific routes stay before and override global fallback', async () => {
    const harness = createProxySandbox({ config: { globalProxyEnabled: true, globalProxyId: 1 } });

    await harness.syncProxyState([
      baseProxy({ id: 1, host: 'vpn.example.com', domains: [] }),
      baseProxy({ id: 2, host: 'bz1.example.com', domains: [{ host: 'youtube.com', enabled: true }] })
    ]);

    const pac = pacData(harness);
    const domainRuleIndex = pac.indexOf('return "PROXY bz1.example.com:8080"');
    const globalFallbackIndex = pac.lastIndexOf('return "PROXY vpn.example.com:8080"');
    assert.ok(domainRuleIndex > -1, 'expected BZ1 domain rule');
    assert.ok(globalFallbackIndex > -1, 'expected VPN global fallback');
    assert.ok(domainRuleIndex < globalFallbackIndex, 'domain-specific rule must be evaluated before global fallback');
  });

  await t.test('Chrome browser service bypass is evaluated before domain-specific routes', async () => {
    const harness = createProxySandbox({ config: { globalProxyEnabled: true, globalProxyId: 1 } });

    await harness.syncProxyState([
      baseProxy({ id: 1, host: 'vpn.example.com', domains: [] }),
      baseProxy({ id: 2, host: 'media.example.com', domains: [{ host: 'googleusercontent.com', enabled: true }] })
    ]);

    const pac = pacData(harness);
    const bypassIndex = pac.indexOf("return 'DIRECT';");
    const domainRuleIndex = pac.indexOf('return "PROXY media.example.com:8080"');
    assert.ok(bypassIndex > -1, 'expected Chrome service bypass');
    assert.ok(domainRuleIndex > -1, 'expected domain-specific route');
    assert.ok(bypassIndex < domainRuleIndex, 'Chrome service bypass must be evaluated before domain-specific routes');
  });

  await t.test('disabled selected-global proxy is ignored without clearing stored global state', async () => {
    const harness = createProxySandbox({ config: { globalProxyEnabled: true, globalProxyId: 7 } });

    await harness.syncProxyState([
      baseProxy({ id: 7, host: 'disabled-global.example.com', enabled: false, domains: [] })
    ]);

    assert.deepStrictEqual(plain(harness.storage.config), {
      globalProxyEnabled: true,
      globalProxyId: 7
    });
    assert.strictEqual(harness.proxySetCalls.length, 0);
    assert.strictEqual(harness.proxyClearCalls.length, 0);

    await harness.syncProxyState([
      baseProxy({ id: 7, host: 'disabled-global.example.com', enabled: true, domains: [] })
    ]);

    assert.match(pacData(harness), /return "PROXY disabled-global\.example\.com:8080"/);
  });

  await t.test('clears global proxy enabled state when the selected proxy is deleted', async () => {
    const harness = createProxySandbox({
      config: { enabled: false, networkBlocking: false, globalProxyEnabled: true, globalProxyId: 7 }
    });

    await harness.storageChangeListener({
      proxyConfigs: {
        oldValue: [baseProxy({ id: 7 })],
        newValue: []
      }
    }, 'local');

    assert.deepStrictEqual(plain(harness.storage.config), {
      enabled: false,
      networkBlocking: false,
      globalProxyEnabled: false,
      globalProxyId: null
    });
  });

  await t.test('resyncs PAC when Chrome browser service bypass config changes', async () => {
    const harness = createProxySandbox({
      config: { globalProxyEnabled: true, globalProxyId: 7 },
      proxyConfigs: [baseProxy({ id: 7, host: 'global.example.com', domains: [] })]
    });

    await harness.storageChangeListener({
      config: {
        oldValue: { globalProxyEnabled: true, globalProxyId: 7, chromeServiceProxyBypass: true },
        newValue: { globalProxyEnabled: true, globalProxyId: 7, chromeServiceProxyBypass: false }
      }
    }, 'local');
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(harness.proxySetCalls.length, 1);
    assert.match(pacData(harness), /return "PROXY global\.example\.com:8080"/);
  });

  await t.test('master-off releases proxy control without changing requested proxy settings', async () => {
    const proxy = baseProxy({ id: 7, host: 'global.example.com', domains: [] });
    const config = { enabled: false, globalProxyEnabled: true, globalProxyId: 7 };
    const harness = createProxySandbox({
      config,
      proxyConfigs: [proxy],
      proxyLevelOfControl: 'controlled_by_this_extension',
      proxySettingValue: {
        mode: 'pac_script',
        pacScript: { data: 'function FindProxyForURL(){return "PROXY stale.invalid:8080";}' }
      }
    });

    const status = await harness.syncProxyState([proxy]);

    assert.strictEqual(harness.proxySetCalls.length, 0);
    assert.strictEqual(harness.proxyClearCalls.length, 1);
    assert.deepStrictEqual(plain(status.requested), { active: false, routeCount: 0, global: false, test: false });
    assert.deepStrictEqual(plain(status.effective), { active: false, routeCount: 0, global: false });
    assert.deepStrictEqual(plain(harness.storage.config), config);
    assert.deepStrictEqual(plain(harness.storage.proxyConfigs), [proxy]);
  });

  await t.test('master toggle releases and restores stored proxy routes', async () => {
    const proxy = baseProxy({ id: 7, host: 'global.example.com', domains: [] });
    const enabledConfig = { enabled: true, globalProxyEnabled: true, globalProxyId: 7 };
    const disabledConfig = { ...enabledConfig, enabled: false };
    const harness = createProxySandbox({ config: enabledConfig, proxyConfigs: [proxy] });

    await harness.syncProxyState([proxy]);
    assert.strictEqual(harness.proxySetCalls.length, 1);

    harness.storage.config = disabledConfig;
    await harness.storageChangeListener({
      config: { oldValue: enabledConfig, newValue: disabledConfig }
    }, 'local');
    await flushAsyncWork();

    let status = await harness.getProxyRoutingStatus({ refresh: true });
    assert.strictEqual(harness.proxyClearCalls.length, 1);
    assert.strictEqual(status.requested.active, false);
    assert.strictEqual(status.effective.active, false);
    assert.deepStrictEqual(plain(harness.storage.config), disabledConfig);
    assert.deepStrictEqual(plain(harness.storage.proxyConfigs), [proxy]);

    harness.storage.config = enabledConfig;
    await harness.storageChangeListener({
      config: { oldValue: disabledConfig, newValue: enabledConfig }
    }, 'local');
    await flushAsyncWork();

    status = await harness.getProxyRoutingStatus({ refresh: true });
    assert.strictEqual(harness.proxySetCalls.length, 2);
    assert.strictEqual(status.requested.active, true);
    assert.strictEqual(status.effective.active, true);
    assert.match(pacData(harness), /return "PROXY global\.example\.com:8080"/);
  });

  await t.test('PAC domain helper JSON-stringifies unsafe domain text', () => {
    const harness = createProxySandbox();
    const unsafeDomain = 'quote"and\\slash.example.com';
    const expected = `host === ${JSON.stringify(unsafeDomain)} || dnsDomainIs(host, ${JSON.stringify('.' + unsafeDomain)})`;

    assert.strictEqual(harness.buildPacDomainConditions([unsafeDomain]), expected);
  });

  await t.test('drops legacy single proxy config instead of storing non-canonical migration data', async () => {
    const harness = createProxySandbox({
      proxyConfig: { host: 'https://legacy.example.com:8443', port: 80, accepted: true },
      readStartupStorage: true
    });

    await new Promise(resolve => setImmediate(resolve));

    assert.deepStrictEqual(harness.storageRemoveCalls, ['proxyConfig']);
    assert.strictEqual(harness.storage.proxyConfig, undefined);
    assert.strictEqual(harness.storageSetCalls.length, 0);
  });

  await t.test('records a health diagnostic when PAC settings fail', async () => {
    const harness = createProxySandbox();
    harness.storage.config = {};
    harness.proxySetCalls.length = 0;
    harness.proxyClearCalls.length = 0;
    harness.chrome.proxy.settings.set = async () => {
      throw new Error('PAC write failed for proxy.example.com');
    };

    await harness.syncProxyState([
      baseProxy()
    ]);

    const pacDiagnostic = harness.healthDiagnostics.find(entry => entry.id === 'proxyPacSync');
    assert.ok(pacDiagnostic);
    assert.strictEqual(pacDiagnostic.entry.area, 'proxy');
    assert.match(pacDiagnostic.entry.message, /PAC settings/i);
  });
});

test('Proxy test runner hardening', async (t) => {
  await t.test('does not fall back to the first proxy when a stale id is supplied', async () => {
    const harness = createProxySandbox({
      proxyConfigs: [baseProxy({ id: 1 })]
    });

    const result = await harness.runProxyTest(999);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(harness.proxySetCalls.length, 0);
  });

  await t.test('routes only the selected safe proxy for proxy tests and returns its id', async () => {
    const harness = createProxySandbox({
      proxyConfigs: [
        baseProxy({ id: 1, host: 'first.example.com', domains: [{ host: 'checkip.amazonaws.com', enabled: true }] }),
        baseProxy({ id: 2, host: 'second.example.com', domains: [] })
      ]
    });

    const result = await harness.runProxyTest(2);
    const pac = harness.proxySetCalls[0]?.value?.pacScript?.data || '';

    assert.deepStrictEqual(plain(result), {
      ok: true,
      proxyId: 2,
      ip: '203.0.113.7',
      providerId: 'aws-checkip'
    });
    assert.match(pac, /return "PROXY second\.example\.com:8080"/);
    assert.strictEqual(evaluatePac(pac, 'checkip.amazonaws.com'), 'PROXY second.example.com:8080');

    for (const domain of harness.PROXY_TEST_DOMAINS) {
      const escaped = domain.replace(/\./g, '\\.');
      assert.match(pac, new RegExp(`host === "${escaped}"`));
      assert.match(pac, new RegExp(`dnsDomainIs\\(host, "\\.${escaped}"\\)`));
    }
  });

  await t.test('succeeds when the first verification endpoint fails and the second succeeds', async () => {
    let callCount = 0;
    const harness = createProxySandbox({
      proxyConfigs: [baseProxy({ id: 1 })],
      fetchImpl: async () => {
        callCount++;
        if (callCount === 1) {
          return { ok: false, status: 503, text: async () => '' };
        }
        return { ok: true, text: async () => '{"ip":"2001:db8::7"}' };
      }
    });

    const result = await harness.runProxyTest(1);

    assert.deepStrictEqual(plain(result), {
      ok: true,
      proxyId: 1,
      ip: '2001:db8::7',
      providerId: 'ipify'
    });
    assert.strictEqual(harness.fetchCalls.length, 2);
    assert.deepStrictEqual(harness.fetchCalls.map(call => call.url), [
      'https://checkip.amazonaws.com/',
      'https://api64.ipify.org?format=json'
    ]);
  });

  await t.test('stops calling verification providers after the first success', async () => {
    const harness = createProxySandbox({
      proxyConfigs: [baseProxy({ id: 1 })]
    });

    const result = await harness.runProxyTest(1);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(harness.fetchCalls.length, 1);
  });

  await t.test('returns a fresh cached success without issuing another fetch', async () => {
    const harness = createProxySandbox({
      proxyConfigs: [baseProxy({ id: 1 })]
    });

    const first = await harness.runProxyTest(1);
    const fetchCountAfterFirst = harness.fetchCalls.length;
    const proxySetCountAfterFirst = harness.proxySetCalls.length;
    const second = await harness.runProxyTest(1);

    assert.deepStrictEqual(plain(second), plain(first));
    assert.strictEqual(harness.fetchCalls.length, fetchCountAfterFirst);
    assert.strictEqual(harness.proxySetCalls.length, proxySetCountAfterFirst);
  });

  await t.test('does not reuse cached success after proxy connection details change', async () => {
    let callCount = 0;
    const harness = createProxySandbox({
      proxyConfigs: [baseProxy({ id: 1, type: 'HTTPS' })],
      fetchImpl: async () => {
        callCount++;
        return { ok: true, text: async () => `198.51.100.${callCount}\n` };
      }
    });

    const first = await harness.runProxyTest(1);
    harness.storage.proxyConfigs = [baseProxy({ id: 1, type: 'PROXY' })];
    const second = await harness.runProxyTest(1);

    assert.deepStrictEqual(plain(first), {
      ok: true,
      proxyId: 1,
      ip: '198.51.100.1',
      providerId: 'aws-checkip'
    });
    assert.deepStrictEqual(plain(second), {
      ok: true,
      proxyId: 1,
      ip: '198.51.100.2',
      providerId: 'aws-checkip'
    });
    assert.strictEqual(harness.fetchCalls.length, 2);
  });

  await t.test('does not cache verification failures', async () => {
    let callCount = 0;
    const harness = createProxySandbox({
      proxyConfigs: [baseProxy({ id: 1 })],
      fetchImpl: async () => {
        callCount++;
        if (callCount <= 2) {
          return { ok: false, status: 503, text: async () => '' };
        }
        return { ok: true, text: async () => '198.51.100.44\n' };
      }
    });

    const first = await harness.runProxyTest(1);
    const second = await harness.runProxyTest(1);

    assert.deepStrictEqual(plain(first), { ok: false, error: 'ipify: HTTP 503' });
    assert.deepStrictEqual(plain(second), {
      ok: true,
      proxyId: 1,
      ip: '198.51.100.44',
      providerId: 'aws-checkip'
    });
    assert.strictEqual(harness.fetchCalls.length, 3);
  });

  await t.test('rejects invalid IP responses from verification providers', async () => {
    const harness = createProxySandbox({
      proxyConfigs: [baseProxy({ id: 1 })],
      fetchImpl: async (url) => {
        if (url.includes('ipify')) {
          return { ok: true, text: async () => '{"ip":"not an ip"}' };
        }
        return { ok: true, text: async () => 'not an ip\n' };
      }
    });

    const result = await harness.runProxyTest(1);

    assert.deepStrictEqual(plain(result), { ok: false, error: 'ipify: invalid IP response' });
    assert.strictEqual(harness.fetchCalls.length, 2);
  });

  await t.test('resets test routing and syncs PAC again after endpoint failures', async () => {
    const harness = createProxySandbox({
      proxyConfigs: [baseProxy({ id: 1 })],
      fetchImpl: async () => ({ ok: false, status: 502, text: async () => '' })
    });

    const result = await harness.runProxyTest(1);
    const testPac = harness.proxySetCalls[0]?.value?.pacScript?.data || '';
    const cleanupPac = harness.proxySetCalls[1]?.value?.pacScript?.data || '';

    assert.deepStrictEqual(plain(result), { ok: false, error: 'ipify: HTTP 502' });
    assert.match(testPac, /cloudflare\.com|checkip\.amazonaws\.com|api64\.ipify\.org|icanhazip\.com/);
    assert.doesNotMatch(cleanupPac, /cloudflare\.com|checkip\.amazonaws\.com|api64\.ipify\.org|icanhazip\.com/);
    assert.match(cleanupPac, /example\.com/);
  });

  await t.test('releases the proxy test lock and cleans up routing after timeout', async () => {
    let callCount = 0;
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const harness = createProxySandbox({
      proxyConfigs: [baseProxy({ id: 1 })],
      fetchImpl: async () => {
        callCount++;
        if (callCount === 1) throw abortError;
        return { ok: true, text: async () => '198.51.100.55\n' };
      }
    });

    const first = await harness.runProxyTest(1);
    const second = await harness.runProxyTest(1);

    assert.deepStrictEqual(plain(first), { ok: false, error: 'Timeout' });
    assert.deepStrictEqual(plain(second), {
      ok: true,
      proxyId: 1,
      ip: '198.51.100.55',
      providerId: 'aws-checkip'
    });
    assert.ok(harness.proxySetCalls.length >= 4, 'expected test and cleanup syncs for both runs');
  });
});

test('Proxy auth matching hardening', async (t) => {
  async function invokeAuth(harness, details) {
    return await new Promise(resolve => {
      harness.authListener(details, resolve);
    });
  }

  async function activateStoredRoutes(harness) {
    return harness.syncProxyState(harness.storage.proxyConfigs || []);
  }

  await t.test('ordinary website authentication never receives proxy credentials', async () => {
    const harness = createProxySandbox({
      proxyConfigs: [baseProxy({ authIv: 'iv1', authCipher: 'cipher1' })]
    });
    await activateStoredRoutes(harness);
    const beforeAttempts = harness.getProxyAuthAttemptCount();

    const result = await invokeAuth(harness, {
      isProxy: false,
      requestId: 'website-auth',
      url: 'https://example.com/',
      challenger: { host: 'proxy.example.com', port: 8080 }
    });

    assert.deepStrictEqual(plain(result), {});
    assert.strictEqual(harness.decryptCalls.length, 0);
    assert.strictEqual(harness.getProxyAuthAttemptCount(), beforeAttempts);
  });

  await t.test('batches proxy auth challenge stats instead of recording every challenge', async () => {
    const harness = createProxySandbox({
      proxyConfigs: [
        baseProxy({ id: 1, host: 'proxy.example.com', authIv: 'iv1', authCipher: 'cipher1' })
      ]
    });
    await activateStoredRoutes(harness);

    for (let i = 0; i < 24; i++) {
      const result = await invokeAuth(harness, {
        isProxy: true,
        requestId: `auth-batch-${i}`,
        url: 'https://example.com/video',
        challenger: { host: 'proxy.example.com', port: 8080 }
      });
      assert.deepStrictEqual(plain(result), {
        authCredentials: {
          username: 'user:iv1',
          password: 'pass:cipher1'
        }
      });
    }

    assert.deepStrictEqual(harness.statsEvents, []);

    harness.runPendingTimers();

    assert.deepStrictEqual(plain(harness.statsEvents), [
      { layer: 'proxy', type: 'auth_challenge', count: 24 }
    ]);
  });

  await t.test('flushes proxy auth challenge stats when the batch cap is reached', async () => {
    const harness = createProxySandbox({
      proxyConfigs: [
        baseProxy({ id: 1, host: 'proxy.example.com', authIv: 'iv1', authCipher: 'cipher1' })
      ]
    });
    await activateStoredRoutes(harness);

    for (let i = 0; i < 25; i++) {
      await invokeAuth(harness, {
        isProxy: true,
        requestId: `auth-cap-${i}`,
        url: 'https://example.com/video',
        challenger: { host: 'proxy.example.com', port: 8080 }
      });
    }

    assert.deepStrictEqual(plain(harness.statsEvents), [
      { layer: 'proxy', type: 'auth_challenge', count: 25 }
    ]);
  });

  await t.test('prefers exact host and port credentials', async () => {
    const harness = createProxySandbox({
      proxyConfigs: [
        baseProxy({ id: 1, host: 'proxy.example.com', domains: [{ host: 'first.example', enabled: true }], authIv: 'iv1', authCipher: 'cipher1' }),
        baseProxy({ id: 2, host: 'other.example.com', domains: [{ host: 'second.example', enabled: true }], authIv: 'iv2', authCipher: 'cipher2' })
      ]
    });
    await activateStoredRoutes(harness);

    const result = await invokeAuth(harness, {
      isProxy: true,
      requestId: 'exact-1',
      url: 'https://second.example/resource',
      challenger: { host: 'OTHER.EXAMPLE.COM.', port: 8080 }
    });

    assert.deepStrictEqual(plain(result), {
      authCredentials: {
        username: 'user:iv2',
        password: 'pass:cipher2'
      }
    });
  });

  await t.test('disabled, unrouted, deleted, and stale routes cannot release credentials', async () => {
    const scenarios = [
      baseProxy({ enabled: false, authIv: 'disabled-iv', authCipher: 'disabled-cipher' }),
      baseProxy({ domains: [{ host: 'example.com', enabled: false }], authIv: 'unrouted-iv', authCipher: 'unrouted-cipher' })
    ];
    for (const [index, proxy] of scenarios.entries()) {
      const harness = createProxySandbox({ proxyConfigs: [proxy] });
      await activateStoredRoutes(harness);
      const result = await invokeAuth(harness, {
        isProxy: true,
        requestId: `inactive-${index}`,
        url: 'https://example.com/video',
        challenger: { host: 'proxy.example.com', port: 8080 }
      });
      assert.deepStrictEqual(plain(result), { cancel: true });
      assert.strictEqual(harness.decryptCalls.length, 0);
    }

    const stale = createProxySandbox({
      proxyConfigs: [baseProxy({ authIv: 'stale-iv', authCipher: 'stale-cipher' })]
    });
    await activateStoredRoutes(stale);
    stale.storage.proxyConfigs = [];
    const pendingRemoval = stale.syncProxyState([]);
    assert.deepStrictEqual(plain(await invokeAuth(stale, {
      isProxy: true,
      requestId: 'deleted-route',
      url: 'https://example.com/video',
      challenger: { host: 'proxy.example.com', port: 8080 }
    })), { cancel: true });
    await pendingRemoval;
    assert.strictEqual(stale.decryptCalls.length, 0);
  });

  await t.test('the exact effective route receives credentials once and loops are canceled', async () => {
    const harness = createProxySandbox({
      proxyConfigs: [baseProxy({
        type: 'HTTPS',
        host: 'Proxy.Example.com.',
        port: '8080',
        authIv: 'iv1',
        authCipher: 'cipher1'
      })]
    });
    await activateStoredRoutes(harness);
    const details = {
      isProxy: true,
      requestId: 'one-auth-attempt',
      url: 'https://example.com/video',
      challenger: { host: 'PROXY.EXAMPLE.COM.', port: 8080 }
    };

    assert.deepStrictEqual(plain(await invokeAuth(harness, details)), {
      authCredentials: { username: 'user:iv1', password: 'pass:cipher1' }
    });
    assert.deepStrictEqual(plain(await invokeAuth(harness, details)), { cancel: true });
    assert.strictEqual(harness.decryptCalls.length, 1);

    const concurrentDetails = { ...details, requestId: 'concurrent-auth-attempt' };
    const concurrent = await Promise.all([
      invokeAuth(harness, concurrentDetails),
      invokeAuth(harness, concurrentDetails)
    ]);
    assert.strictEqual(concurrent.filter(result => result.authCredentials).length, 1);
    assert.strictEqual(concurrent.filter(result => result.cancel === true).length, 1);
    assert.strictEqual(harness.decryptCalls.length, 2);
  });

  await t.test('an exact selected global route can authenticate an arbitrary routed URL', async () => {
    const proxy = baseProxy({ domains: [], authIv: 'global-iv', authCipher: 'global-cipher' });
    const harness = createProxySandbox({
      config: { globalProxyEnabled: true, globalProxyId: proxy.id },
      proxyConfigs: [proxy]
    });
    await activateStoredRoutes(harness);

    assert.deepStrictEqual(plain(await invokeAuth(harness, {
      isProxy: true,
      requestId: 'global-route-auth',
      url: 'https://arbitrary.example.net/resource',
      challenger: { host: 'PROXY.EXAMPLE.COM.', port: '8080' }
    })), {
      authCredentials: { username: 'user:global-iv', password: 'pass:global-cipher' }
    });

    assert.deepStrictEqual(plain(await invokeAuth(harness, {
      isProxy: true,
      requestId: 'global-route-bypass',
      url: 'https://accounts.google.com/login',
      challenger: { host: 'proxy.example.com', port: 8080 }
    })), { cancel: true });
    assert.strictEqual(harness.decryptCalls.length, 1);
  });

  await t.test('a temporary proxy-test route can authenticate only while its PAC is authoritative', async () => {
    const proxy = baseProxy({ domains: [], authIv: 'test-iv', authCipher: 'test-cipher' });
    let harness;
    let duringTestAuth = null;
    harness = createProxySandbox({
      proxyConfigs: [proxy],
      fetchImpl: async url => {
        duringTestAuth = await invokeAuth(harness, {
          isProxy: true,
          requestId: 'temporary-test-route',
          url,
          challenger: { host: 'proxy.example.com', port: 8080 }
        });
        return { ok: true, text: async () => '198.51.100.41\n' };
      }
    });

    const result = await harness.runProxyTest(proxy.id);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(plain(duringTestAuth), {
      authCredentials: { username: 'user:test-iv', password: 'pass:test-cipher' }
    });
    assert.deepStrictEqual(plain(await invokeAuth(harness, {
      isProxy: true,
      requestId: 'after-temporary-test-route',
      url: 'https://checkip.amazonaws.com/',
      challenger: { host: 'proxy.example.com', port: 8080 }
    })), { cancel: true });
    assert.strictEqual(harness.decryptCalls.length, 1);
  });

  await t.test('route invalidation during credential decryption fails closed and preserves the request bound', async () => {
    let resolveDecrypt;
    let markDecryptStarted;
    const decryptStarted = new Promise(resolve => { markDecryptStarted = resolve; });
    const proxy = baseProxy({ authIv: 'deferred-iv', authCipher: 'deferred-cipher' });
    const harness = createProxySandbox({
      proxyConfigs: [proxy],
      decryptImpl: () => new Promise(resolve => {
        resolveDecrypt = resolve;
        markDecryptStarted();
      })
    });
    await activateStoredRoutes(harness);
    const details = {
      isProxy: true,
      requestId: 'deferred-route-auth',
      url: 'https://example.com/video',
      challenger: { host: 'proxy.example.com', port: 8080 }
    };

    const pendingAuth = invokeAuth(harness, details);
    await decryptStarted;
    const disable = harness.syncProxyState([]);
    resolveDecrypt({ username: 'late-user', password: 'late-password' });
    assert.deepStrictEqual(plain(await pendingAuth), { cancel: true });
    await disable;

    await harness.syncProxyState([proxy]);
    assert.deepStrictEqual(plain(await invokeAuth(harness, details)), { cancel: true });
    assert.strictEqual(harness.decryptCalls.length, 1);
  });

  await t.test('an unrelated active proxy on the same port cannot answer another route challenge', async () => {
    const harness = createProxySandbox({
      proxyConfigs: [
        baseProxy({ id: 1, host: 'first-proxy.example', domains: [{ host: 'first.example', enabled: true }], authIv: 'iv1', authCipher: 'cipher1' }),
        baseProxy({ id: 2, host: 'second-proxy.example', domains: [{ host: 'second.example', enabled: true }], authIv: 'iv2', authCipher: 'cipher2' })
      ]
    });
    await activateStoredRoutes(harness);

    assert.deepStrictEqual(plain(await invokeAuth(harness, {
      isProxy: true,
      requestId: 'same-port-unrelated',
      url: 'https://first.example/video',
      challenger: { host: 'second-proxy.example', port: 8080 }
    })), { cancel: true });
    assert.deepStrictEqual(plain(await invokeAuth(harness, {
      isProxy: true,
      requestId: 'wrong-port-exact-host',
      url: 'https://first.example/video',
      challenger: { host: 'first-proxy.example', port: 8081 }
    })), { cancel: true });
    assert.strictEqual(harness.decryptCalls.length, 0);
  });

  await t.test('authentication attempt tracking has a hard cap', async () => {
    const harness = createProxySandbox({ proxyConfigs: [] });
    await harness.syncProxyState([]);
    for (let index = 0; index < 1030; index++) {
      await invokeAuth(harness, {
        isProxy: true,
        requestId: `bounded-${index}`,
        url: 'https://example.com/',
        challenger: { host: 'proxy.example.com', port: 8080 }
      });
    }
    assert.strictEqual(harness.getProxyAuthAttemptCount(), 1024);
    assert.deepStrictEqual(plain(await invokeAuth(harness, {
      isProxy: true,
      requestId: 'bounded-0',
      url: 'https://example.com/',
      challenger: { host: 'proxy.example.com', port: 8080 }
    })), { cancel: true });
    assert.deepStrictEqual(plain(await invokeAuth(harness, {
      isProxy: true,
      requestId: 'bounded-over-cap',
      url: 'https://example.com/',
      challenger: { host: 'proxy.example.com', port: 8080 }
    })), { cancel: true });
    assert.strictEqual(harness.getProxyAuthAttemptCount(), 1024);
  });

  await t.test('SOCKS routes never release credentials by exact or port-only matching', async () => {
    const unique = createProxySandbox({
      proxyConfigs: [
        baseProxy({ id: 1, type: 'SOCKS5', host: 'socks.example.com', port: 1080, authIv: 'iv1', authCipher: 'cipher1' })
      ]
    });
    await activateStoredRoutes(unique);

    assert.deepStrictEqual(plain(await invokeAuth(unique, {
      isProxy: true,
      requestId: 'socks-1',
      url: 'https://example.com/video',
      challenger: { host: 'hidden-proxy-host', port: 1080 }
    })), { cancel: true });
    assert.deepStrictEqual(plain(await invokeAuth(unique, {
      isProxy: true,
      requestId: 'socks-exact',
      url: 'https://example.com/video',
      challenger: { host: 'socks.example.com', port: 1080 }
    })), { cancel: true });
    assert.strictEqual(unique.decryptCalls.length, 0);

    const ambiguous = createProxySandbox({
      proxyConfigs: [
        baseProxy({ id: 1, type: 'SOCKS5', host: 'socks-a.example.com', port: 1080, authIv: 'iv1', authCipher: 'cipher1' }),
        baseProxy({ id: 2, type: 'SOCKS5', host: 'socks-b.example.com', port: 1080, authIv: 'iv2', authCipher: 'cipher2' })
      ]
    });
    await activateStoredRoutes(ambiguous);

    assert.deepStrictEqual(plain(await invokeAuth(ambiguous, {
      isProxy: true,
      requestId: 'socks-2',
      url: 'https://example.com/video',
      challenger: { host: 'hidden-proxy-host', port: 1080 }
    })), { cancel: true });
  });

  await t.test('ignores legacy plaintext-only proxy credentials', async () => {
    const harness = createProxySandbox({
      proxyConfigs: [
        baseProxy({ id: 1, host: 'proxy.example.com', username: 'plain-user', password: 'plain-pass' })
      ]
    });
    await activateStoredRoutes(harness);

    assert.deepStrictEqual(plain(await invokeAuth(harness, {
      isProxy: true,
      requestId: 'plain-1',
      url: 'https://example.com/video',
      challenger: { host: 'proxy.example.com', port: 8080 }
    })), { cancel: true });
  });
});

test('Proxy ownership and effective routing', async t => {
  async function invokeAuth(harness, details) {
    return new Promise(resolve => harness.authListener(details, resolve));
  }

  await t.test('external control reports requested separately from effective and denies credentials', async () => {
    const proxy = baseProxy({ authIv: 'iv1', authCipher: 'cipher1' });
    const harness = createProxySandbox({
      proxyConfigs: [proxy],
      proxyLevelOfControl: 'controlled_by_other_extensions',
      proxySettingValue: { mode: 'fixed_servers' }
    });

    const status = await harness.syncProxyState([proxy]);
    assert.deepStrictEqual(plain(status.requested), {
      active: true,
      routeCount: 1,
      global: false,
      test: false
    });
    assert.deepStrictEqual(plain(status.effective), { active: false, routeCount: 0, global: false });
    assert.strictEqual(status.conflict, true);
    assert.strictEqual(status.levelOfControl, 'controlled_by_other_extensions');
    assert.strictEqual(harness.proxySetCalls.length, 0);
    assert.strictEqual(harness.proxyClearCalls.length, 1);
    assert.ok(harness.healthDiagnostics.some(entry => entry.id === 'proxyControl'));

    assert.deepStrictEqual(plain(await invokeAuth(harness, {
      isProxy: true,
      requestId: 'externally-controlled-auth',
      url: 'https://example.com/video',
      challenger: { host: 'proxy.example.com', port: 8080 }
    })), { cancel: true });
    assert.strictEqual(harness.decryptCalls.length, 0);
  });

  await t.test('reconciliation is idempotent for an exact PAC and an already released setting', async () => {
    const proxy = baseProxy();
    const active = createProxySandbox({ proxyConfigs: [proxy] });
    await active.syncProxyState([proxy]);
    await active.syncProxyState([proxy]);
    assert.strictEqual(active.proxySetCalls.length, 1);

    const released = createProxySandbox({ proxyConfigs: [] });
    await released.syncProxyState([]);
    await released.syncProxyState([]);
    assert.strictEqual(released.proxyClearCalls.length, 0);
  });

  await t.test('a successful set call that does not become effective publishes no credential authority', async () => {
    const proxy = baseProxy({ authIv: 'iv1', authCipher: 'cipher1' });
    const harness = createProxySandbox({
      proxyConfigs: [proxy],
      proxySetTakesEffect: false
    });

    const status = await harness.syncProxyState([proxy]);
    assert.strictEqual(harness.proxySetCalls.length, 1);
    assert.strictEqual(status.requested.active, true);
    assert.strictEqual(status.effective.active, false);
    assert.ok(harness.healthDiagnostics.some(entry => entry.id === 'proxyControl'));
    assert.deepStrictEqual(plain(await invokeAuth(harness, {
      isProxy: true,
      requestId: 'semantic-set-failure',
      url: 'https://example.com/video',
      challenger: { host: 'proxy.example.com', port: 8080 }
    })), { cancel: true });
    assert.strictEqual(harness.decryptCalls.length, 0);
  });

  await t.test('a successful clear call that leaves a stale PAC reports an incomplete release', async () => {
    const harness = createProxySandbox({
      proxyLevelOfControl: 'controlled_by_this_extension',
      proxySettingValue: {
        mode: 'pac_script',
        pacScript: { data: 'function FindProxyForURL(){return "PROXY stale.invalid:8080";}' }
      },
      proxyClearTakesEffect: false
    });

    const status = await harness.syncProxyState([]);
    assert.strictEqual(harness.proxyClearCalls.length, 1);
    assert.strictEqual(status.requested.active, false);
    assert.strictEqual(status.effective.active, false);
    assert.strictEqual(status.controlledByThisExtension, true);
    assert.match(status.error, /still reports a Chroma-controlled PAC route/i);
    assert.ok(harness.healthDiagnostics.some(entry => entry.id === 'proxyControl'));
  });

  await t.test('proxy tests refuse ineffective routing without contacting verification endpoints', async () => {
    const proxy = baseProxy();
    const harness = createProxySandbox({
      proxyConfigs: [proxy],
      proxyLevelOfControl: 'controlled_by_other_extensions',
      proxySettingValue: { mode: 'fixed_servers' }
    });

    assert.deepStrictEqual(plain(await harness.runProxyTest(proxy.id)), {
      ok: false,
      error: 'Proxy route is not effective'
    });
    assert.strictEqual(harness.fetchCalls.length, 0);
  });

  await t.test('external takeover during verification cannot create a cached success', async () => {
    const proxy = baseProxy();
    let harness;
    let takeOver = true;
    harness = createProxySandbox({
      proxyConfigs: [proxy],
      fetchImpl: async () => {
        if (takeOver) {
          harness.proxySetting.levelOfControl = 'controlled_by_other_extensions';
          harness.proxySetting.value = { mode: 'fixed_servers' };
          harness.proxySettingsChangeListener({
            levelOfControl: 'controlled_by_other_extensions',
            value: { mode: 'fixed_servers' }
          });
        }
        return { ok: true, text: async () => '198.51.100.72\n' };
      }
    });

    const takenOver = await harness.runProxyTest(proxy.id);
    assert.deepStrictEqual(plain(takenOver), {
      ok: false,
      error: 'Proxy route lost control during test'
    });
    assert.strictEqual(harness.fetchCalls.length, 1);

    takeOver = false;
    harness.proxySetting.levelOfControl = 'controllable_by_this_extension';
    harness.proxySetting.value = { mode: 'system' };
    harness.proxySettingsChangeListener({
      levelOfControl: 'controllable_by_this_extension',
      value: { mode: 'system' }
    });
    await flushAsyncWork();

    const retried = await harness.runProxyTest(proxy.id);
    assert.strictEqual(retried.ok, true);
    assert.strictEqual(harness.fetchCalls.length, 2, 'failed verification must not populate the success cache');
  });

  await t.test('a cached proxy-test success is rejected after external takeover', async () => {
    const proxy = baseProxy();
    const harness = createProxySandbox({ proxyConfigs: [proxy] });
    const first = await harness.runProxyTest(proxy.id);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(harness.fetchCalls.length, 1);

    harness.proxySetting.levelOfControl = 'controlled_by_other_extensions';
    harness.proxySetting.value = { mode: 'fixed_servers' };
    harness.proxySettingsChangeListener({
      levelOfControl: 'controlled_by_other_extensions',
      value: { mode: 'fixed_servers' }
    });
    await flushAsyncWork();

    assert.deepStrictEqual(plain(await harness.runProxyTest(proxy.id)), {
      ok: false,
      error: 'Proxy route is not effective'
    });
    assert.strictEqual(harness.fetchCalls.length, 1);
  });

  await t.test('rapid route reconciliations publish only the latest requested state', async () => {
    const proxy = baseProxy({ authIv: 'iv1', authCipher: 'cipher1' });
    const offWins = createProxySandbox({ proxyConfigs: [proxy] });
    const staleOn = offWins.syncProxyState([proxy]);
    const latestOff = offWins.syncProxyState([]);
    await Promise.all([staleOn, latestOff]);
    let status = await offWins.getProxyRoutingStatus({ refresh: true });
    assert.strictEqual(status.requested.active, false);
    assert.strictEqual(status.effective.active, false);
    assert.strictEqual(offWins.proxySetCalls.length, 0);

    const onWins = createProxySandbox({ proxyConfigs: [proxy] });
    const staleOff = onWins.syncProxyState([]);
    const latestOn = onWins.syncProxyState([proxy]);
    await Promise.all([staleOff, latestOn]);
    status = await onWins.getProxyRoutingStatus({ refresh: true });
    assert.strictEqual(status.requested.active, true);
    assert.strictEqual(status.effective.active, true);
    assert.strictEqual(onWins.proxySetCalls.length, 1);
  });

  await t.test('releasing external control automatically reconciles the requested route', async () => {
    const proxy = baseProxy({ authIv: 'iv1', authCipher: 'cipher1' });
    const harness = createProxySandbox({
      proxyConfigs: [proxy],
      proxyLevelOfControl: 'controlled_by_other_extensions',
      proxySettingValue: { mode: 'fixed_servers' }
    });
    await harness.syncProxyState([proxy]);

    harness.proxySetting.levelOfControl = 'controllable_by_this_extension';
    harness.proxySetting.value = { mode: 'system' };
    harness.proxySettingsChangeListener({
      levelOfControl: 'controllable_by_this_extension',
      value: { mode: 'system' }
    });
    await flushAsyncWork();

    const status = await harness.getProxyRoutingStatus({ refresh: true });
    assert.strictEqual(harness.proxySetCalls.length, 1);
    assert.strictEqual(status.controlledByThisExtension, true);
    assert.deepStrictEqual(plain(status.effective), { active: true, routeCount: 1, global: false });

    harness.proxySetting.levelOfControl = 'controlled_by_other_extensions';
    harness.proxySetting.value = { mode: 'fixed_servers' };
    harness.proxySettingsChangeListener({
      levelOfControl: 'controlled_by_other_extensions',
      value: { mode: 'fixed_servers' }
    });
    await flushAsyncWork();
    const takenOver = await harness.getProxyRoutingStatus();
    assert.strictEqual(takenOver.effective.active, false);
    assert.strictEqual(takenOver.conflict, true);
  });

  await t.test('control changes during recovery trigger another reconciliation pass', async () => {
    const first = baseProxy({ id: 1, host: 'first-proxy.example', domains: [{ host: 'first.example', enabled: true }] });
    const second = baseProxy({ id: 2, host: 'second-proxy.example', domains: [{ host: 'second.example', enabled: true }] });
    const harness = createProxySandbox({
      proxyConfigs: [first],
      proxyLevelOfControl: 'controlled_by_other_extensions',
      proxySettingValue: { mode: 'fixed_servers' }
    });
    await harness.syncProxyState([first]);

    const originalGet = harness.chrome.storage.local.get;
    let releaseFirstRecoveryRead;
    let signalFirstRecoveryRead;
    const firstRecoveryReadStarted = new Promise(resolve => { signalFirstRecoveryRead = resolve; });
    const firstRecoveryReadGate = new Promise(resolve => { releaseFirstRecoveryRead = resolve; });
    let intercepted = false;
    harness.chrome.storage.local.get = async keys => {
      const result = await originalGet(keys);
      if (!intercepted && keys === 'proxyConfigs') {
        intercepted = true;
        signalFirstRecoveryRead();
        await firstRecoveryReadGate;
      }
      return result;
    };

    harness.proxySetting.levelOfControl = 'controllable_by_this_extension';
    harness.proxySetting.value = { mode: 'system' };
    harness.proxySettingsChangeListener({
      levelOfControl: 'controllable_by_this_extension',
      value: { mode: 'system' }
    });
    await firstRecoveryReadStarted;

    harness.storage.proxyConfigs = [second];
    harness.proxySettingsChangeListener({
      levelOfControl: 'controllable_by_this_extension',
      value: { mode: 'system' }
    });
    releaseFirstRecoveryRead();
    await flushAsyncWork();
    await flushAsyncWork();

    assert.strictEqual(harness.proxySetCalls.length, 2);
    assert.match(pacData(harness), /second-proxy\.example:8080/);
    assert.doesNotMatch(pacData(harness), /first-proxy\.example:8080/);
  });

  await t.test('route changes during external control cannot resurrect the prior PAC', async () => {
    const first = baseProxy({ id: 1, host: 'first-proxy.example', domains: [{ host: 'first.example', enabled: true }] });
    const second = baseProxy({ id: 2, host: 'second-proxy.example', domains: [{ host: 'second.example', enabled: true }] });
    const harness = createProxySandbox({ proxyConfigs: [first] });
    await harness.syncProxyState([first]);

    harness.proxySetting.levelOfControl = 'controlled_by_other_extensions';
    harness.proxySetting.value = { mode: 'fixed_servers' };
    harness.proxySettingsChangeListener({
      levelOfControl: 'controlled_by_other_extensions',
      value: { mode: 'fixed_servers' }
    });
    await flushAsyncWork();

    harness.storage.proxyConfigs = [second];
    await harness.storageChangeListener({
      proxyConfigs: { oldValue: [first], newValue: [second] }
    }, 'local');
    await flushAsyncWork();
    assert.ok(harness.proxyClearCalls.length >= 1, 'dormant Chroma PAC should be cleared during takeover');

    harness.proxySetting.levelOfControl = 'controllable_by_this_extension';
    harness.proxySetting.value = { mode: 'system' };
    harness.proxySettingsChangeListener({
      levelOfControl: 'controllable_by_this_extension',
      value: { mode: 'system' }
    });
    await flushAsyncWork();

    const latestPac = pacData(harness);
    assert.match(latestPac, /second-proxy\.example/);
    assert.doesNotMatch(latestPac, /first-proxy\.example/);
    const status = await harness.getProxyRoutingStatus({ refresh: true });
    assert.strictEqual(status.effective.active, true);
  });

  await t.test('turning routes off during external control clears dormant Chroma state', async () => {
    const proxy = baseProxy();
    const harness = createProxySandbox({ proxyConfigs: [proxy] });
    await harness.syncProxyState([proxy]);
    harness.proxySetting.levelOfControl = 'controlled_by_other_extensions';
    harness.proxySetting.value = { mode: 'fixed_servers' };
    harness.proxySettingsChangeListener({
      levelOfControl: 'controlled_by_other_extensions',
      value: { mode: 'fixed_servers' }
    });
    await flushAsyncWork();

    harness.storage.proxyConfigs = [];
    await harness.storageChangeListener({
      proxyConfigs: { oldValue: [proxy], newValue: [] }
    }, 'local');
    await flushAsyncWork();
    assert.ok(harness.proxyClearCalls.length >= 1);

    harness.proxySetting.levelOfControl = 'controllable_by_this_extension';
    harness.proxySetting.value = { mode: 'system' };
    harness.proxySettingsChangeListener({
      levelOfControl: 'controllable_by_this_extension',
      value: { mode: 'system' }
    });
    await flushAsyncWork();
    const status = await harness.getProxyRoutingStatus({ refresh: true });
    assert.strictEqual(status.requested.active, false);
    assert.strictEqual(status.effective.active, false);
  });

  await t.test('startup with no stored routes releases a stale Chroma PAC', async () => {
    const harness = createProxySandbox({
      readStartupStorage: true,
      startupProxyConfigs: [],
      proxyLevelOfControl: 'controlled_by_this_extension',
      proxySettingValue: {
        mode: 'pac_script',
        pacScript: { data: 'function FindProxyForURL(){return "PROXY stale.invalid:8080";}' }
      }
    });
    await flushAsyncWork();

    assert.strictEqual(harness.proxyClearCalls.length, 1);
    const status = await harness.getProxyRoutingStatus({ refresh: true });
    assert.strictEqual(status.requested.active, false);
    assert.strictEqual(status.effective.active, false);
    assert.strictEqual(status.levelOfControl, 'controllable_by_this_extension');
  });
});
