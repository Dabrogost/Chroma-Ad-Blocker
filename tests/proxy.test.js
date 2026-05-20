const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const proxyJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'proxy.js'), 'utf8')
  .replace("import { decryptAuth } from '../core/crypto.js';", 'var decryptAuth = globalThis._mockDecryptAuth;')
  .replace("import { recordStatsEvent } from './stats.js';", 'var recordStatsEvent = globalThis._mockRecordStatsEvent || (() => {});')
  .replace("import { clearHealthDiagnostic, recordHealthDiagnostic } from './diagnostics.js';", 'var clearHealthDiagnostic = globalThis._mockClearHealthDiagnostic || (async () => {}); var recordHealthDiagnostic = globalThis._mockRecordHealthDiagnostic || (async () => {});')
  .replace(/^export\s+/gm, '')
  + '\nglobalThis.__proxyExports = { syncProxyState, runProxyTest, findAuthProxyConfig, getProxyString, buildPacDomainConditions, fetchProxyIp, isLikelyIp, PROXY_TEST_DOMAINS, CHROME_SERVICE_BYPASS_DOMAINS };\n';

const PROXY_AUTH_STATS_DELAY_MS = 10000;

function createProxySandbox({
  proxyConfigs = [],
  config = {},
  proxyConfig,
  readStartupStorage = false,
  startupProxyConfigs,
  fetchImpl,
  random = () => 0
} = {}) {
  let authListener = null;
  let storageChangeListener = null;
  const proxySetCalls = [];
  const proxyClearCalls = [];
  const storageSetCalls = [];
  const storageRemoveCalls = [];
  const statsEvents = [];
  const healthDiagnostics = [];
  const clearedHealthDiagnostics = [];
  const fetchCalls = [];
  const timeoutCallbacks = [];
  const storage = {
    proxyConfigs,
    config,
    proxyConfig
  };
  const mockMath = Object.create(Math);
  mockMath.random = random;

  const chrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (Array.isArray(keys)) {
            const result = {};
            for (const key of keys) {
              result[key] = readStartupStorage
                ? (key === 'proxyConfigs' ? startupProxyConfigs : storage[key])
                : undefined;
            }
            return result;
          }
          if (typeof keys === 'string') {
            return { [keys]: storage[keys] };
          }
          return { ...storage };
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
        set: async (args) => {
          proxySetCalls.push(args);
        },
        clear: async (args) => {
          proxyClearCalls.push(args);
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
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      if (fetchImpl) return fetchImpl(url, options, fetchCalls);
      return { ok: true, text: async () => '203.0.113.7\n' };
    },
    _mockDecryptAuth: async (iv, cipher) => ({ username: `user:${iv}`, password: `pass:${cipher}` }),
    _mockRecordStatsEvent: event => { statsEvents.push(event); },
    _mockRecordHealthDiagnostic: (id, entry) => { healthDiagnostics.push({ id, entry }); },
    _mockClearHealthDiagnostic: id => { clearedHealthDiagnostics.push(id); }
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
    assert.strictEqual(harness.proxyClearCalls.length, 1);
  });

  await t.test('uses valid global fallback and clears invalid global state with a guarded write', async () => {
    const valid = createProxySandbox({ config: { globalProxyEnabled: true, globalProxyId: 9 } });

    await valid.syncProxyState([
      baseProxy({ id: 9, host: 'global.example.com', domains: [] })
    ]);

    assert.match(pacData(valid), /return "PROXY global\.example\.com:8080"/);
    assert.strictEqual(valid.storageSetCalls.length, 0);

    const invalid = createProxySandbox({ config: { globalProxyEnabled: true, globalProxyId: 10 } });
    await invalid.syncProxyState([
      baseProxy({ id: 10, host: 'bad.example.com', domains: [], accepted: false })
    ]);

    assert.deepStrictEqual(plain(invalid.storage.config), {
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
    assert.strictEqual(harness.proxyClearCalls.length, 1);

    await harness.syncProxyState([
      baseProxy({ id: 7, host: 'disabled-global.example.com', enabled: true, domains: [] })
    ]);

    assert.match(pacData(harness), /return "PROXY disabled-global\.example\.com:8080"/);
  });

  await t.test('clears global proxy enabled state when the selected proxy is deleted', async () => {
    const harness = createProxySandbox({
      config: { globalProxyEnabled: true, globalProxyId: 7 }
    });

    await harness.storageChangeListener({
      proxyConfigs: {
        oldValue: [baseProxy({ id: 7 })],
        newValue: []
      }
    }, 'local');

    assert.deepStrictEqual(plain(harness.storage.config), {
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

    assert.strictEqual(harness.healthDiagnostics.length, 1);
    assert.strictEqual(harness.healthDiagnostics[0].id, 'proxyPacSync');
    assert.strictEqual(harness.healthDiagnostics[0].entry.area, 'proxy');
    assert.match(harness.healthDiagnostics[0].entry.message, /PAC settings/i);
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
        baseProxy({ id: 1, host: 'first.example.com' }),
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

  await t.test('batches proxy auth challenge stats instead of recording every challenge', async () => {
    const harness = createProxySandbox({
      proxyConfigs: [
        baseProxy({ id: 1, host: 'proxy.example.com', authIv: 'iv1', authCipher: 'cipher1' })
      ]
    });

    for (let i = 0; i < 24; i++) {
      const result = await invokeAuth(harness, {
        isProxy: true,
        requestId: `auth-batch-${i}`,
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

    for (let i = 0; i < 25; i++) {
      await invokeAuth(harness, {
        isProxy: true,
        requestId: `auth-cap-${i}`,
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
        baseProxy({ id: 1, host: 'proxy.example.com', authIv: 'iv1', authCipher: 'cipher1' }),
        baseProxy({ id: 2, host: 'other.example.com', authIv: 'iv2', authCipher: 'cipher2' })
      ]
    });

    const result = await invokeAuth(harness, {
      isProxy: true,
      requestId: 'exact-1',
      challenger: { host: 'OTHER.EXAMPLE.COM.', port: 8080 }
    });

    assert.deepStrictEqual(plain(result), {
      authCredentials: {
        username: 'user:iv2',
        password: 'pass:cipher2'
      }
    });
  });

  await t.test('allows SOCKS port-only auth fallback only when unique', async () => {
    const unique = createProxySandbox({
      proxyConfigs: [
        baseProxy({ id: 1, type: 'SOCKS5', host: 'socks.example.com', port: 1080, authIv: 'iv1', authCipher: 'cipher1' })
      ]
    });

    assert.deepStrictEqual(plain(await invokeAuth(unique, {
      isProxy: true,
      requestId: 'socks-1',
      challenger: { host: 'hidden-proxy-host', port: 1080 }
    })), {
      authCredentials: {
        username: 'user:iv1',
        password: 'pass:cipher1'
      }
    });

    const ambiguous = createProxySandbox({
      proxyConfigs: [
        baseProxy({ id: 1, type: 'SOCKS5', host: 'socks-a.example.com', port: 1080, authIv: 'iv1', authCipher: 'cipher1' }),
        baseProxy({ id: 2, type: 'SOCKS5', host: 'socks-b.example.com', port: 1080, authIv: 'iv2', authCipher: 'cipher2' })
      ]
    });

    assert.deepStrictEqual(plain(await invokeAuth(ambiguous, {
      isProxy: true,
      requestId: 'socks-2',
      challenger: { host: 'hidden-proxy-host', port: 1080 }
    })), { cancel: true });
  });

  await t.test('ignores legacy plaintext-only proxy credentials', async () => {
    const harness = createProxySandbox({
      proxyConfigs: [
        baseProxy({ id: 1, host: 'proxy.example.com', username: 'plain-user', password: 'plain-pass' })
      ]
    });

    assert.deepStrictEqual(plain(await invokeAuth(harness, {
      isProxy: true,
      requestId: 'plain-1',
      challenger: { host: 'proxy.example.com', port: 8080 }
    })), { cancel: true });
  });
});
