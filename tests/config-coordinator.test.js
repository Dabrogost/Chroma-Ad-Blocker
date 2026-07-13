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
  + '\nglobalThis.__configCoordinator = { serializeConfigMutation, mutateStoredConfig };\n';

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
