const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'background', 'configCoordinator.js'),
  'utf8'
)
  .replace(/^export\s+/gm, '')
  + '\nglobalThis.__configCoordinator = { serializeConfigMutation, allowNestedConfigMutations, mutateStoredConfig };\n';

function loadCoordinator(initialConfig) {
  const storage = { config: { ...initialConfig } };
  const sandbox = {
    chrome: {
      storage: {
        local: {
          get: async () => ({ config: { ...storage.config } }),
          set: async values => Object.assign(storage, values)
        }
      }
    },
    Promise
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { ...sandbox.__configCoordinator, storage };
}

test('shared config mutation coordinator preserves newer master state across proxy cleanup', async () => {
  const coordinator = loadCoordinator({
    enabled: true,
    networkBlocking: true,
    globalProxyEnabled: true,
    globalProxyId: 7
  });

  const masterDisable = coordinator.serializeConfigMutation(async () => {
    const config = { ...coordinator.storage.config };
    await Promise.resolve();
    coordinator.storage.config = { ...config, enabled: false, networkBlocking: false };
  });
  const proxyCleanup = coordinator.mutateStoredConfig(config => ({
    ...config,
    globalProxyEnabled: false,
    globalProxyId: null
  }));

  await Promise.all([masterDisable, proxyCleanup]);

  assert.deepStrictEqual(JSON.parse(JSON.stringify(coordinator.storage.config)), {
    enabled: false,
    networkBlocking: false,
    globalProxyEnabled: false,
    globalProxyId: null
  });
});

test('allowNestedConfigMutations runs nested mutateStoredConfig without deadlocking queued top-level mutations', async () => {
  const coordinator = loadCoordinator({
    enabled: true,
    globalProxyEnabled: false,
    globalProxyId: null
  });

  let syncQueue = Promise.resolve();
  function simulatedSyncProxyState() {
    syncQueue = syncQueue.then(async () => {
      if (coordinator.storage.config.globalProxyEnabled && coordinator.storage.config.globalProxyId === 999) {
        await coordinator.mutateStoredConfig(config => ({
          ...config,
          globalProxyEnabled: false,
          globalProxyId: null
        }));
      }
    });
    return syncQueue;
  }

  const order = [];
  const first = coordinator.serializeConfigMutation(async () => {
    order.push('first:start');
    coordinator.storage.config = {
      ...coordinator.storage.config,
      globalProxyEnabled: true,
      globalProxyId: 999
    };
    await coordinator.allowNestedConfigMutations(() => simulatedSyncProxyState());
    order.push('first:end');
  });

  const second = coordinator.serializeConfigMutation(async () => {
    order.push('second:start');
    coordinator.storage.config = { ...coordinator.storage.config, enabled: false };
    await coordinator.allowNestedConfigMutations(() => simulatedSyncProxyState());
    order.push('second:end');
  });

  let timer;
  try {
    await Promise.race([
      Promise.all([first, second]),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Deadlocked during nested mutateStoredConfig')), 1000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }

  assert.deepStrictEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(coordinator.storage.config)), {
    enabled: false,
    globalProxyEnabled: false,
    globalProxyId: null
  });
});

test('drains external mutateStoredConfig inside allowNestedConfigMutations to prevent AB-BA lock inversion', async () => {
  const coordinator = loadCoordinator({
    enabled: true,
    globalProxyEnabled: true,
    globalProxyId: 999
  });

  let syncQueue = Promise.resolve();
  function simulatedSyncProxyState() {
    syncQueue = syncQueue.then(async () => {
      if (coordinator.storage.config.globalProxyEnabled && coordinator.storage.config.globalProxyId === 999) {
        await coordinator.mutateStoredConfig(config => ({
          ...config,
          globalProxyEnabled: false,
          globalProxyId: null
        }));
      }
    });
    return syncQueue;
  }

  let notifyOpStarted;
  const opStarted = new Promise(resolve => { notifyOpStarted = resolve; });
  let releasePreSyncWork;
  const preSyncGate = new Promise(resolve => { releasePreSyncWork = resolve; });

  const op = coordinator.serializeConfigMutation(async () => {
    const snapshot = { ...coordinator.storage.config };
    notifyOpStarted();
    await preSyncGate;
    coordinator.storage.config = { ...snapshot, enabled: false };
    await coordinator.allowNestedConfigMutations(() => simulatedSyncProxyState());
  });

  await opStarted;
  // External sync acquires syncQueue before op reaches allowNestedConfigMutations, then waits for mutateStoredConfig.
  const externalSync = simulatedSyncProxyState();
  await Promise.resolve();
  releasePreSyncWork();

  let timer;
  try {
    await Promise.race([
      Promise.all([op, externalSync]),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Deadlocked on AB-BA lock inversion')), 1000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }

  assert.deepStrictEqual(JSON.parse(JSON.stringify(coordinator.storage.config)), {
    enabled: false,
    globalProxyEnabled: false,
    globalProxyId: null
  });
});

test('handleConfigSet + syncProxyState + configCoordinator settles and cleans invalid globalProxyId without deadlocking', async () => {
  const storage = {
    config: { enabled: true, globalProxyEnabled: false, globalProxyId: null },
    proxyConfigs: []
  };
  const sentMessages = [];

  const proxySettings = { levelOfControl: 'controllable_by_this_extension', value: { mode: 'system' } };
  const chrome = {
    storage: {
      local: {
        get: async keys => {
          if (typeof keys === 'string') return { [keys]: storage[keys] };
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map(k => [k, storage[k]]));
          }
          return { ...storage };
        },
        set: async values => Object.assign(storage, values),
        remove: async key => { delete storage[key]; }
      },
      onChanged: { addListener: () => {} }
    },
    proxy: {
      settings: {
        get: async () => ({ ...proxySettings }),
        set: async args => { proxySettings.value = args.value; proxySettings.levelOfControl = 'controlled_by_this_extension'; },
        clear: async () => { proxySettings.value = { mode: 'system' }; proxySettings.levelOfControl = 'controllable_by_this_extension'; },
        onChange: { addListener: () => {} }
      }
    },
    webRequest: { onAuthRequired: { addListener: () => {} } },
    tabs: {
      query: async () => [{ id: 1 }],
      sendMessage: async (tabId, message) => { sentMessages.push({ tabId, message }); }
    }
  };

  const sandbox = {
    chrome,
    console,
    Promise,
    Set,
    Map,
    Math,
    Number,
    Object,
    Array,
    URL,
    setTimeout,
    clearTimeout,
    MSG: { CONFIG_UPDATE: 'CONFIG_UPDATE' },
    decryptAuth: async () => null,
    recordStatsEvent: () => {},
    clearHealthDiagnostic: async () => {},
    recordHealthDiagnostic: async () => {},
    reconcileSubscriptionRuntimeState: async () => {},
    syncUserScripts: async () => {},
    isNetworkProtectionActive: () => true,
    syncActionBadge: async () => ({ ok: true }),
    updateDNRState: async () => {},
    syncWebRtcLeakProtection: async () => {},
    syncBrowserPrivacyHardening: async () => {},
    syncGeolocationProtection: async () => {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const coordCode = fs.readFileSync(
    path.join(__dirname, '..', 'extension', 'background', 'configCoordinator.js'),
    'utf8'
  ).replace(/^export\s+/gm, '');

  const configStateCode = fs.readFileSync(
    path.join(__dirname, '..', 'extension', 'background', 'configState.js'),
    'utf8'
  ).replace(/^export\s+/gm, '');

  const proxyCode = fs.readFileSync(
    path.join(__dirname, '..', 'extension', 'background', 'proxy.js'),
    'utf8'
  )
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\r?\n/gm, '')
    .replace(/^export\s+/gm, '');

  const configHandlersCode = fs.readFileSync(
    path.join(__dirname, '..', 'extension', 'background', 'handlers', 'configHandlers.js'),
    'utf8'
  )
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\r?\n/gm, '')
    .replace(/^export\s+/gm, '');

  vm.runInContext(
    `${coordCode}\n${configStateCode}\n${proxyCode}\n${configHandlersCode}\nglobalThis.__integration = { handleConfigSet };`,
    sandbox
  );

  // Allow proxy.js top-level startup initialization to complete before invoking handleConfigSet.
  await new Promise(resolve => setImmediate(resolve));

  let timer;
  let res;
  try {
    res = await Promise.race([
      sandbox.__integration.handleConfigSet({
        config: { globalProxyEnabled: true, globalProxyId: 999 }
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('handleConfigSet deadlocked with syncProxyState')), 1000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }

  assert.deepStrictEqual(JSON.parse(JSON.stringify(res)), { ok: true });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(storage.config)), {
    enabled: true,
    globalProxyEnabled: false,
    globalProxyId: null
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sentMessages)), [{
    tabId: 1,
    message: {
      type: 'CONFIG_UPDATE',
      config: {
        enabled: true,
        globalProxyEnabled: false,
        globalProxyId: null
      }
    }
  }]);
});

test('handleProxyConfigSet serializes through configCoordinator so concurrent saves preserve credentials', async () => {
  const storage = {
    proxyConfigs: [{
      id: 1,
      name: 'P1',
      host: '1.2.3.4',
      port: 8080,
      type: 'PROXY',
      accepted: true,
      enabled: true,
      domains: []
    }]
  };

  let notifyEncryptStarted;
  const encryptStarted = new Promise(resolve => { notifyEncryptStarted = resolve; });
  let releaseEncrypt;
  const encryptGate = new Promise(resolve => { releaseEncrypt = resolve; });

  const chrome = {
    storage: {
      local: {
        get: async key => {
          if (typeof key === 'string') return { [key]: JSON.parse(JSON.stringify(storage[key])) };
          if (Array.isArray(key)) {
            return Object.fromEntries(key.map(k => [k, JSON.parse(JSON.stringify(storage[k]))]));
          }
          return JSON.parse(JSON.stringify(storage));
        },
        set: async values => Object.assign(storage, JSON.parse(JSON.stringify(values)))
      }
    }
  };

  const sandbox = {
    chrome,
    console,
    Promise,
    Set,
    Map,
    Math,
    Number,
    Object,
    Array,
    URL,
    setTimeout,
    clearTimeout,
    runProxyTest: async () => ({ ok: true }),
    encryptAuth: async (username, password) => {
      notifyEncryptStarted();
      await encryptGate;
      return { iv: `iv:${username}`, ciphertext: `ct:${password}` };
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const wrapModule = (relPath, exportsList) => {
    const src = fs.readFileSync(path.join(__dirname, '..', ...relPath), 'utf8')
      .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\r?\n/gm, '')
      .replace(/^export\s+/gm, '');
    return `(() => {\n${src}\nObject.assign(globalThis, { ${exportsList.join(', ')} });\n})();`;
  };

  vm.runInContext(
    [
      wrapModule(['extension', 'background', 'configCoordinator.js'], ['serializeConfigMutation']),
      wrapModule(['extension', 'background', 'handlers', 'domainValidation.js'], ['isValidHostname', 'normalizeDomain']),
      wrapModule(['extension', 'background', 'handlers', 'proxyHandlers.js'], ['handleProxyConfigSet'])
    ].join('\n'),
    sandbox
  );

  const credentialSave = sandbox.handleProxyConfigSet({
    proxyConfigs: [{
      id: 1,
      name: 'P1',
      host: '1.2.3.4',
      port: 8080,
      type: 'PROXY',
      accepted: true,
      enabled: true,
      domains: [],
      credentialAction: 'replace',
      username: 'alice',
      password: 'secret'
    }]
  });

  await encryptStarted;

  const domainSave = sandbox.handleProxyConfigSet({
    proxyConfigs: [{
      id: 1,
      name: 'P1',
      host: '1.2.3.4',
      port: 8080,
      type: 'PROXY',
      accepted: true,
      enabled: true,
      domains: [{ host: 'youtube.com', enabled: true }],
      credentialAction: 'preserve'
    }]
  });

  releaseEncrypt();
  const [res1, res2] = await Promise.all([credentialSave, domainSave]);

  assert.strictEqual(res1.ok, true);
  assert.strictEqual(res2.ok, true);
  assert.strictEqual(storage.proxyConfigs[0].authIv, 'iv:alice');
  assert.strictEqual(storage.proxyConfigs[0].authCipher, 'ct:secret');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(storage.proxyConfigs[0].domains)), [
    { host: 'youtube.com', enabled: true }
  ]);
});
