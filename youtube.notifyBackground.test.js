const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

describe('youtube.js notifyBackground integration', () => {
  let mockContext;

  before(async () => {
    const scriptPath = path.resolve(__dirname, 'youtube.js');
    let scriptContent = fs.readFileSync(scriptPath, 'utf8');

    mockContext = {
      __TESTING__: true,
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
      window: {
        location: { hostname: 'youtube.com' }
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
    vm.createContext(mockContext);
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
