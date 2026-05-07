const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const proxyJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'proxy.js'), 'utf8')
  .replace("import { decryptAuth } from '../core/crypto.js';", 'var decryptAuth = globalThis._mockDecryptAuth;')
  .replace("import { recordStatsEvent } from './stats.js';", 'var recordStatsEvent = globalThis._mockRecordStatsEvent || (() => {});')
  .replace(/^export\s+/gm, '')
  + '\nglobalThis.__proxyExports = { syncProxyState, runProxyTest, findAuthProxyConfig, getProxyString };\n';

function createProxySandbox({ proxyConfigs = [], config = {}, proxyConfig, readStartupStorage = false, startupProxyConfigs } = {}) {
  let authListener = null;
  let storageChangeListener = null;
  const proxySetCalls = [];
  const proxyClearCalls = [];
  const storageSetCalls = [];
  const storageRemoveCalls = [];
  const statsEvents = [];
  const storage = {
    proxyConfigs,
    config,
    proxyConfig
  };

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
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    clearTimeout: () => {},
    AbortController,
    fetch: async () => ({ ok: true, text: async () => '203.0.113.7\n' }),
    _mockDecryptAuth: async (iv, cipher) => ({ username: `user:${iv}`, password: `pass:${cipher}` }),
    _mockRecordStatsEvent: event => { statsEvents.push(event); }
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(proxyJsCode, sandbox);

  return {
    storage,
    proxySetCalls,
    proxyClearCalls,
    storageSetCalls,
    storageRemoveCalls,
    statsEvents,
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

    assert.deepStrictEqual(plain(result), { ok: true, proxyId: 2, ip: '203.0.113.7' });
    assert.match(pac, /host === "icanhazip\.com"/);
    assert.match(pac, /return "PROXY second\.example\.com:8080"/);
  });
});

test('Proxy auth matching hardening', async (t) => {
  async function invokeAuth(harness, details) {
    return await new Promise(resolve => {
      harness.authListener(details, resolve);
    });
  }

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
