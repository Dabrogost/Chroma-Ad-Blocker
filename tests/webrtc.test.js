const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const webrtcJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'webrtc.js'), 'utf8')
  .replace(/^export\s+/gm, '')
  + '\nglobalThis.__webrtcExports = { resolveWebRtcPolicy, getWebRtcLeakProtectionStatus, syncWebRtcLeakProtection };\n';

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function validProxy(overrides = {}) {
  return {
    id: 7,
    accepted: true,
    host: 'proxy.example.com',
    port: 8080,
    ...overrides
  };
}

function createWebRtcSandbox({
  hasPrivacyApi = true,
  value = 'default',
  levelOfControl = 'controllable_by_this_extension',
  callbackApi = false,
  lastErrorMessage = null,
  storage = {}
} = {}) {
  const setCalls = [];
  const clearCalls = [];
  let storedValue = value;
  const setting = hasPrivacyApi
    ? (callbackApi ? {
      get: (details, callback) => {
        callback({ value: storedValue, levelOfControl });
      },
      set: (args, callback) => {
        setCalls.push(args);
        if (!lastErrorMessage) storedValue = args.value;
        callback();
      },
      clear: (args, callback) => {
        clearCalls.push(args);
        if (!lastErrorMessage) storedValue = 'default';
        callback();
      }
    } : {
      get: async () => ({ value: storedValue, levelOfControl }),
      set: async (args) => {
        setCalls.push(args);
        storedValue = args.value;
      },
      clear: async (args) => {
        clearCalls.push(args);
        storedValue = 'default';
      }
    })
    : undefined;

  const sandbox = {
    chrome: {
      runtime: {
        get lastError() {
          return lastErrorMessage ? { message: lastErrorMessage } : undefined;
        }
      },
      privacy: hasPrivacyApi ? { network: { webRTCIPHandlingPolicy: setting } } : undefined,
      storage: {
        local: {
          get: async (keys) => {
            if (Array.isArray(keys)) {
              const out = {};
              for (const key of keys) out[key] = storage[key];
              return out;
            }
            return { [keys]: storage[keys] };
          }
        },
        onChanged: {
          addListener: () => {}
        }
      }
    },
    console
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(webrtcJsCode, sandbox);

  return {
    setCalls,
    clearCalls,
    get storedValue() {
      return storedValue;
    },
    ...sandbox.__webrtcExports
  };
}

test('WebRTC policy resolution', async (t) => {
  await t.test('off resolves to clear', () => {
    const harness = createWebRtcSandbox();
    assert.deepStrictEqual(plain(harness.resolveWebRtcPolicy({ webRtcLeakProtection: 'off' }, [])), {
      mode: 'off',
      action: 'clear',
      value: null,
      recommended: false
    });
  });

  await t.test('balanced resolves to default_public_interface_only', () => {
    const harness = createWebRtcSandbox();
    assert.strictEqual(
      harness.resolveWebRtcPolicy({ webRtcLeakProtection: 'balanced' }, []).value,
      'default_public_interface_only'
    );
  });

  await t.test('strict resolves to disable_non_proxied_udp', () => {
    const harness = createWebRtcSandbox();
    assert.strictEqual(
      harness.resolveWebRtcPolicy({ webRtcLeakProtection: 'strict' }, []).value,
      'disable_non_proxied_udp'
    );
  });

  await t.test('auto without global proxy clears', () => {
    const harness = createWebRtcSandbox();
    assert.strictEqual(
      harness.resolveWebRtcPolicy({ webRtcLeakProtection: 'auto', globalProxyEnabled: false }, [validProxy()]).action,
      'clear'
    );
  });

  await t.test('auto with globalProxyEnabled true but no globalProxyId clears', () => {
    const harness = createWebRtcSandbox();
    assert.strictEqual(
      harness.resolveWebRtcPolicy({ webRtcLeakProtection: 'auto', globalProxyEnabled: true }, [validProxy()]).action,
      'clear'
    );
  });

  await t.test('auto with missing selected proxy clears', () => {
    const harness = createWebRtcSandbox();
    assert.strictEqual(
      harness.resolveWebRtcPolicy({ webRtcLeakProtection: 'auto', globalProxyEnabled: true, globalProxyId: 99 }, [validProxy()]).action,
      'clear'
    );
  });

  await t.test('auto with selected proxy not accepted clears', () => {
    const harness = createWebRtcSandbox();
    assert.strictEqual(
      harness.resolveWebRtcPolicy({ webRtcLeakProtection: 'auto', globalProxyEnabled: true, globalProxyId: 7 }, [validProxy({ accepted: false })]).action,
      'clear'
    );
  });

  await t.test('auto with selected proxy disabled clears', () => {
    const harness = createWebRtcSandbox();
    assert.strictEqual(
      harness.resolveWebRtcPolicy({ webRtcLeakProtection: 'auto', globalProxyEnabled: true, globalProxyId: 7 }, [validProxy({ enabled: false })]).action,
      'clear'
    );
  });

  await t.test('auto with accepted configured selected proxy sets strict', () => {
    const harness = createWebRtcSandbox();
    assert.deepStrictEqual(plain(harness.resolveWebRtcPolicy(
      { webRtcLeakProtection: 'auto', globalProxyEnabled: true, globalProxyId: 7 },
      [validProxy()]
    )), {
      mode: 'auto',
      action: 'set',
      value: 'disable_non_proxied_udp',
      recommended: true
    });
  });

  await t.test('auto accepts legacy numeric string ports for stored global proxies', () => {
    const harness = createWebRtcSandbox();
    assert.strictEqual(
      harness.resolveWebRtcPolicy(
        { webRtcLeakProtection: 'auto', globalProxyEnabled: true, globalProxyId: 7 },
        [validProxy({ port: '8080' })]
      ).value,
      'disable_non_proxied_udp'
    );
  });

  await t.test('invalid stored mode falls back to auto behavior', () => {
    const harness = createWebRtcSandbox();
    assert.strictEqual(
      harness.resolveWebRtcPolicy(
        { webRtcLeakProtection: 'enabled', globalProxyEnabled: true, globalProxyId: 7 },
        [validProxy()]
      ).value,
      'disable_non_proxied_udp'
    );
  });
});

test('WebRTC privacy setting sync', async (t) => {
  await t.test('missing chrome privacy API returns unavailable', async () => {
    const harness = createWebRtcSandbox({ hasPrivacyApi: false });
    const result = await harness.syncWebRtcLeakProtection({ webRtcLeakProtection: 'strict' }, []);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.available, false);
  });

  await t.test('controlled_by_other_extensions does not call set or clear', async () => {
    const harness = createWebRtcSandbox({ levelOfControl: 'controlled_by_other_extensions' });
    const result = await harness.syncWebRtcLeakProtection({ webRtcLeakProtection: 'strict' }, []);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(harness.setCalls.length, 0);
    assert.strictEqual(harness.clearCalls.length, 0);
  });

  await t.test('not_controllable does not call set or clear', async () => {
    const harness = createWebRtcSandbox({ levelOfControl: 'not_controllable' });
    const result = await harness.syncWebRtcLeakProtection({ webRtcLeakProtection: 'off' }, []);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(harness.setCalls.length, 0);
    assert.strictEqual(harness.clearCalls.length, 0);
  });

  await t.test('controllable strict sets disable_non_proxied_udp', async () => {
    const harness = createWebRtcSandbox({ value: 'default' });
    const result = await harness.syncWebRtcLeakProtection({ webRtcLeakProtection: 'strict' }, []);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(plain(harness.setCalls), [
      { scope: 'regular', value: 'disable_non_proxied_udp' }
    ]);
  });

  await t.test('controlled_by_this_extension off clears', async () => {
    const harness = createWebRtcSandbox({
      value: 'disable_non_proxied_udp',
      levelOfControl: 'controlled_by_this_extension'
    });
    const result = await harness.syncWebRtcLeakProtection({ webRtcLeakProtection: 'off' }, []);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(plain(harness.clearCalls), [{ scope: 'regular' }]);
  });

  await t.test('already-correct value avoids unnecessary set', async () => {
    const harness = createWebRtcSandbox({
      value: 'disable_non_proxied_udp',
      levelOfControl: 'controlled_by_this_extension'
    });
    const result = await harness.syncWebRtcLeakProtection({ webRtcLeakProtection: 'strict' }, []);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(harness.setCalls.length, 0);
  });

  await t.test('auto mode clears when selected global proxy becomes invalid', async () => {
    const harness = createWebRtcSandbox({
      value: 'disable_non_proxied_udp',
      levelOfControl: 'controlled_by_this_extension'
    });
    const result = await harness.syncWebRtcLeakProtection(
      { webRtcLeakProtection: 'auto', globalProxyEnabled: true, globalProxyId: 7 },
      [validProxy({ accepted: false })]
    );
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(plain(harness.clearCalls), [{ scope: 'regular' }]);
  });

  await t.test('callback-style ChromeSetting set is awaited and applies strict', async () => {
    const harness = createWebRtcSandbox({ callbackApi: true, value: 'default' });
    const result = await harness.syncWebRtcLeakProtection({ webRtcLeakProtection: 'strict' }, []);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(harness.storedValue, 'disable_non_proxied_udp');
    assert.deepStrictEqual(plain(harness.setCalls), [
      { scope: 'regular', value: 'disable_non_proxied_udp' }
    ]);
  });

  await t.test('callback-style ChromeSetting lastError is reported', async () => {
    const harness = createWebRtcSandbox({
      callbackApi: true,
      value: 'default',
      lastErrorMessage: 'set failed'
    });
    const result = await harness.syncWebRtcLeakProtection({ webRtcLeakProtection: 'strict' }, []);

    assert.strictEqual(result.ok, false);
    assert.match(result.error, /set failed/);
  });
});
