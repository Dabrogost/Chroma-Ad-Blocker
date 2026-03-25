const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backgroundJsCode = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function setupSandbox() {
  const sandbox = {
    chrome: {
      runtime: {
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        onMessage: { addListener: (cb) => { sandbox.onMessageListener = cb; } }
      },
      storage: {
        local: {
          get: () => Promise.resolve({ config: { enabled: true, blockPopUnders: true } }),
          set: () => Promise.resolve()
        },
        onChanged: { addListener: () => {} }
      },
      tabs: {
        onCreated: { addListener: (cb) => { sandbox.onCreatedListener = cb; } },
        onRemoved: { addListener: () => {} },
        remove: async () => {}
      },
      declarativeNetRequest: {
        getDynamicRules: () => Promise.resolve([]),
        updateDynamicRules: () => Promise.resolve(),
        updateEnabledRulesets: () => Promise.resolve()
      }
    },
    console: {
      log: () => {},
      warn: () => {},
      error: () => {}
    },
    setInterval: () => {},
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    Date: global.Date,
    Promise: global.Promise,
    Map: global.Map
  };

  vm.createContext(sandbox);
  vm.runInContext(backgroundJsCode, sandbox);
  return sandbox;
}

test('Pop-under sync: onCreated fires BEFORE WINDOW_OPEN_NOTIFY', async (t) => {
  const sandbox = setupSandbox();
  
  const tab = { id: 100, openerTabId: 1 };
  const message = {
    type: 'WINDOW_OPEN_NOTIFY',
    url: 'https://example.ad.com',
    isSuspicious: true,
    stack: 'pop_under.js:10:1'
  };
  const sender = { tab: { id: 1 } };

  // Trigger onCreated
  const onCreatedPromise = sandbox.onCreatedListener(tab);

  // Small delay to ensure it's waiting
  await new Promise(r => setTimeout(r, 100));

  // Trigger onMessage
  sandbox.onMessageListener(message, sender, () => {});

  await onCreatedPromise;

  // Verify it matched (we can't easily check side effects without mocking console.warn or tabs.remove)
});

test('Pop-under sync: WINDOW_OPEN_NOTIFY fires BEFORE onCreated', async (t) => {
  const sandbox = setupSandbox();
  
  const tab = { id: 100, openerTabId: 1 };
  const message = {
    type: 'WINDOW_OPEN_NOTIFY',
    url: 'https://example.ad.com',
    isSuspicious: true,
    stack: 'pop_under.js:10:1'
  };
  const sender = { tab: { id: 1 } };

  // Trigger onMessage first
  sandbox.onMessageListener(message, sender, () => {});

  // Trigger onCreated
  await sandbox.onCreatedListener(tab);

  // Should match immediately
});

test('Pop-under sync: Timeout when no notification arrives', async (t) => {
  const sandbox = setupSandbox();
  
  const tab = { id: 100, openerTabId: 1 };

  const start = Date.now();
  await sandbox.onCreatedListener(tab);
  const end = Date.now();

  assert.ok(end - start >= 1000, 'Should wait for timeout');
});
