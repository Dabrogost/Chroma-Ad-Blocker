const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

describe('youtube.js notifyBackground integration', () => {
  let mockContext;

  before(async () => {
    const messagingPath = path.resolve(__dirname, 'messaging.js');
    let messagingContent = fs.readFileSync(messagingPath, 'utf8');
    const scriptPath = path.resolve(__dirname, 'youtube.js');
    let scriptContent = fs.readFileSync(scriptPath, 'utf8');

    mockContext = {
      __TESTING__: true,
      MSG: {},
      console: console,
      setTimeout: setTimeout,
      setInterval: () => {},
      clearInterval: () => {},
      requestAnimationFrame: () => {},
      document: {
        getElementById: () => null,
        createElement: () => ({
          appendChild: () => {},
          classList: { add: () => {}, remove: () => {}, contains: () => false },
          style: { setProperty: () => {} },
          querySelector: () => null,
          textContent: ''
        }),
        addEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
        documentElement: { style: { setProperty: () => {} } },
        head: { appendChild: () => {} },
        body: { classList: { add: () => {}, remove: () => {} }, style: { removeProperty: () => {} } }
      },
      location: { hostname: 'youtube.com', protocol: 'https:' },
      window: {
        location: { hostname: 'youtube.com', protocol: 'https:' }
      },
      MSG: {
        CONFIG_GET: 'CONFIG_GET',
        CONFIG_SET: 'CONFIG_SET',
        CONFIG_UPDATE: 'CONFIG_UPDATE',
        STATS_GET: 'STATS_GET',
        STATS_RESET: 'STATS_RESET',
        STATS_UPDATE: 'STATS_UPDATE',
        DYNAMIC_RULE_ADD: 'DYNAMIC_RULE_ADD',
        WINDOW_OPEN_NOTIFY: 'WINDOW_OPEN_NOTIFY',
        SUSPICIOUS_ACTIVITY: 'SUSPICIOUS_ACTIVITY'
      },
      chrome: {
        runtime: {
          sendMessage: () => Promise.resolve(),
          onMessage: {
            addListener: () => {}
          }
        },
        storage: {
          local: {
            get: () => Promise.resolve({ config: {} })
          }
        }
      },
      MutationObserver: class { observe() {} disconnect() {} }
    };
    mockContext.globalThis = mockContext;
    mockContext.window = mockContext;
    vm.createContext(mockContext);
    vm.runInContext(messagingContent, mockContext);
    vm.runInContext(scriptContent, mockContext);
  });

  test('notifyBackground is exported correctly', () => {
    assert.strictEqual(typeof mockContext.notifyBackground, 'function');
  });

  test('notifyBackground calls chrome.runtime.sendMessage', () => {
    let captured = null;
    mockContext.chrome.runtime.sendMessage = (msg) => {
      captured = msg;
      return Promise.resolve();
    };
    mockContext.notifyBackground({ test: 'msg' });
    assert.deepStrictEqual(captured, { test: 'msg' });
  });

  test('notifyBackground swallows sync error', () => {
    mockContext.chrome.runtime.sendMessage = () => {
      throw new Error('sync');
    };
    assert.doesNotThrow(() => mockContext.notifyBackground({ test: 1 }));
  });

  test('notifyBackground swallows async error', async () => {
    mockContext.chrome.runtime.sendMessage = () => {
      return Promise.reject(new Error('async'));
    };
    assert.doesNotThrow(() => mockContext.notifyBackground({ test: 1 }));
    // Wait for the promise catch to be executed
    await new Promise(resolve => setTimeout(resolve, 10));
  });
});
