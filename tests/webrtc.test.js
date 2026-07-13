const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const webrtcJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'webrtc.js'), 'utf8')
  .replace(/^export\s+/gm, '')
  + '\nglobalThis.__webrtcExports = { resolveWebRtcPolicy, getWebRtcLeakProtectionStatus, syncWebRtcLeakProtection, recoverWebRtcLeakProtection };\n';

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
  storageGetError = null,
  emitOwnChanges = false,
  storage = {}
} = {}) {
  const setCalls = [];
  const clearCalls = [];
  let storedValue = value;
  let controlLevel = levelOfControl;
  let settingChangeListener = null;
  let storageChangeListener = null;
  const setting = hasPrivacyApi
    ? (callbackApi ? {
      get: (details, callback) => {
        callback({ value: storedValue, levelOfControl: controlLevel });
      },
      set: (args, callback) => {
        setCalls.push(args);
        if (!lastErrorMessage) {
          storedValue = args.value;
          controlLevel = 'controlled_by_this_extension';
          if (emitOwnChanges) settingChangeListener?.({ value: storedValue, levelOfControl: controlLevel });
        }
        callback();
      },
      clear: (args, callback) => {
        clearCalls.push(args);
        if (!lastErrorMessage) {
          if (controlLevel !== 'controlled_by_other_extensions' && controlLevel !== 'not_controllable') {
            storedValue = 'default';
            controlLevel = 'controllable_by_this_extension';
            if (emitOwnChanges) settingChangeListener?.({ value: storedValue, levelOfControl: controlLevel });
          }
        }
        callback();
      },
      onChange: {
        addListener: listener => { settingChangeListener = listener; }
      }
    } : {
      get: async () => ({ value: storedValue, levelOfControl: controlLevel }),
      set: async (args) => {
        setCalls.push(args);
        storedValue = args.value;
        controlLevel = 'controlled_by_this_extension';
        if (emitOwnChanges) settingChangeListener?.({ value: storedValue, levelOfControl: controlLevel });
      },
      clear: async (args) => {
        clearCalls.push(args);
        if (controlLevel !== 'controlled_by_other_extensions' && controlLevel !== 'not_controllable') {
          storedValue = 'default';
          controlLevel = 'controllable_by_this_extension';
          if (emitOwnChanges) settingChangeListener?.({ value: storedValue, levelOfControl: controlLevel });
        }
      },
      onChange: {
        addListener: listener => { settingChangeListener = listener; }
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
            if (storageGetError) throw storageGetError;
            if (Array.isArray(keys)) {
              const out = {};
              for (const key of keys) out[key] = storage[key];
              return out;
            }
            return { [keys]: storage[keys] };
          }
        },
        onChanged: {
          addListener: listener => { storageChangeListener = listener; }
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
    get levelOfControl() {
      return controlLevel;
    },
    storage,
    emitSettingChange({ value: nextValue = storedValue, levelOfControl: nextLevel = controlLevel } = {}) {
      storedValue = nextValue;
      controlLevel = nextLevel;
      settingChangeListener?.({ value: storedValue, levelOfControl: controlLevel });
    },
    emitStorageChange(changes) {
      storageChangeListener?.(changes, 'local');
    },
    ...sandbox.__webrtcExports
  };
}

async function flushAsyncWork(turns = 12) {
  for (let index = 0; index < turns; index++) {
    await new Promise(resolve => setImmediate(resolve));
  }
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

  await t.test('master off preserves the requested mode but resolves to clear', () => {
    const harness = createWebRtcSandbox();
    assert.deepStrictEqual(
      plain(harness.resolveWebRtcPolicy({ enabled: false, webRtcLeakProtection: 'strict' }, [])),
      { mode: 'strict', action: 'clear', value: null, recommended: true }
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

  await t.test('not_controllable clear removes any dormant Chroma preference without setting', async () => {
    const harness = createWebRtcSandbox({ levelOfControl: 'not_controllable' });
    const result = await harness.syncWebRtcLeakProtection({ webRtcLeakProtection: 'off' }, []);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(harness.setCalls.length, 0);
    assert.strictEqual(harness.clearCalls.length, 1);
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

  await t.test('master off clears a requested strict policy and re-enable restores it', async () => {
    const harness = createWebRtcSandbox({
      value: 'disable_non_proxied_udp',
      levelOfControl: 'controlled_by_this_extension'
    });
    const off = await harness.syncWebRtcLeakProtection({
      enabled: false,
      webRtcLeakProtection: 'strict'
    }, []);
    assert.strictEqual(off.requested, true);
    assert.strictEqual(off.enabled, false);
    assert.strictEqual(off.released, true);
    assert.strictEqual(harness.storedValue, 'default');
    assert.strictEqual(harness.clearCalls.length, 1);

    const on = await harness.syncWebRtcLeakProtection({
      enabled: true,
      webRtcLeakProtection: 'strict'
    }, []);
    assert.strictEqual(on.ok, true);
    assert.strictEqual(on.enabled, true);
    assert.strictEqual(on.controlledByThisExtension, true);
    assert.strictEqual(harness.storedValue, 'disable_non_proxied_udp');
    assert.strictEqual(harness.setCalls.length, 1);
  });

  await t.test('status separates requested, controlled, and effective WebRTC state', async () => {
    const harness = createWebRtcSandbox({
      value: 'disable_non_proxied_udp',
      levelOfControl: 'controlled_by_other_extensions'
    });
    const status = await harness.getWebRtcLeakProtectionStatus({
      enabled: true,
      webRtcLeakProtection: 'strict'
    }, []);
    assert.strictEqual(status.requested, true);
    assert.strictEqual(status.enabled, true);
    assert.strictEqual(status.effective, true);
    assert.strictEqual(status.controlledByThisExtension, false);
    assert.match(status.error, /controlled elsewhere/i);

    const paused = await harness.getWebRtcLeakProtectionStatus({
      enabled: false,
      webRtcLeakProtection: 'strict'
    }, []);
    assert.strictEqual(paused.requested, true);
    assert.strictEqual(paused.enabled, false);
    assert.strictEqual(paused.effective, false);
  });

  await t.test('releasing external WebRTC control automatically reapplies stored policy', async () => {
    const storage = {
      config: { enabled: true, webRtcLeakProtection: 'strict' },
      proxyConfigs: []
    };
    const harness = createWebRtcSandbox({
      value: 'default',
      levelOfControl: 'controlled_by_other_extensions',
      storage
    });
    const blocked = await harness.syncWebRtcLeakProtection(storage.config, []);
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(harness.setCalls.length, 0);

    harness.emitSettingChange({
      value: 'default',
      levelOfControl: 'controllable_by_this_extension'
    });
    await flushAsyncWork();

    assert.strictEqual(harness.storedValue, 'disable_non_proxied_udp');
    assert.strictEqual(harness.levelOfControl, 'controlled_by_this_extension');
    assert.strictEqual(harness.setCalls.length, 1);

    harness.emitSettingChange({
      value: 'disable_non_proxied_udp',
      levelOfControl: 'controlled_by_this_extension'
    });
    await flushAsyncWork();
    assert.strictEqual(harness.setCalls.length, 1, 'own matching onChange event must be idempotent');
  });

  await t.test('master off clears a dormant WebRTC preference while another controller is active', async () => {
    const storage = {
      config: { enabled: false, webRtcLeakProtection: 'strict' },
      proxyConfigs: []
    };
    const harness = createWebRtcSandbox({
      value: 'default_public_interface_only',
      levelOfControl: 'controlled_by_other_extensions',
      storage
    });

    const result = await harness.syncWebRtcLeakProtection(storage.config, []);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.requested, true);
    assert.strictEqual(result.enabled, false);
    assert.strictEqual(harness.clearCalls.length, 1);

    harness.emitSettingChange({
      value: 'default',
      levelOfControl: 'controllable_by_this_extension'
    });
    await flushAsyncWork();
    assert.strictEqual(harness.setCalls.length, 0);
    assert.strictEqual(harness.storedValue, 'default');
  });

  await t.test('own WebRTC onChange events do not stale the foreground reconciliation', async () => {
    const storage = {
      config: { enabled: true, webRtcLeakProtection: 'strict' },
      proxyConfigs: []
    };
    const harness = createWebRtcSandbox({ storage, emitOwnChanges: true });
    const result = await harness.syncWebRtcLeakProtection(storage.config, []);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.stale, false);
    assert.strictEqual(result.controlledByThisExtension, true);
    assert.strictEqual(harness.setCalls.length, 1);
    await flushAsyncWork();
    assert.strictEqual(harness.setCalls.length, 1);
  });

  await t.test('recovery storage failure cannot clear an existing requested policy', async () => {
    const harness = createWebRtcSandbox({
      value: 'disable_non_proxied_udp',
      levelOfControl: 'controlled_by_this_extension',
      storageGetError: new Error('storage unavailable')
    });

    await assert.rejects(() => harness.recoverWebRtcLeakProtection(), /storage unavailable/);
    assert.strictEqual(harness.clearCalls.length, 0);
    assert.strictEqual(harness.storedValue, 'disable_non_proxied_udp');
  });

  await t.test('rapid WebRTC toggles converge to the latest master state', async () => {
    const harness = createWebRtcSandbox({
      value: 'disable_non_proxied_udp',
      levelOfControl: 'controlled_by_this_extension'
    });
    await Promise.all([
      harness.syncWebRtcLeakProtection({ enabled: true, webRtcLeakProtection: 'strict' }, []),
      harness.syncWebRtcLeakProtection({ enabled: false, webRtcLeakProtection: 'strict' }, [])
    ]);
    assert.strictEqual(harness.storedValue, 'default');
    assert.strictEqual(harness.levelOfControl, 'controllable_by_this_extension');
  });

  await t.test('ordinary recovery reads stored state before reconciling', async () => {
    const storage = {
      config: { enabled: true, webRtcLeakProtection: 'balanced' },
      proxyConfigs: []
    };
    const harness = createWebRtcSandbox({ storage });
    const result = await harness.recoverWebRtcLeakProtection();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(harness.storedValue, 'default_public_interface_only');
    assert.strictEqual(harness.levelOfControl, 'controlled_by_this_extension');
  });
});
