const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const mainWorldCode = fs.readFileSync(path.join(__dirname, '..', 'main-world.js'), 'utf8');

const createSandbox = () => {
  const sandbox = {
    console: {
      log: () => {},
      warn: () => {},
      error: () => {}
    },
    setTimeout: (cb) => {
      try { cb(); } catch(e) {}
    },
    Date: {
      now: () => Date.now()
    },
    String: String,
    Object: Object,
    Promise: Promise,
    Error: Error,
    DOMException: class DOMException extends Error {
      constructor(message, name) {
        super(message);
        this.name = name;
      }
    }
  };

  sandbox.document = {
    documentElement: {
      dataset: { ytChromaPopActive: 'true', ytChromaPushActive: 'true' }
    }
  };

  sandbox.window = {
    open: function() { return {}; },
    focus: function() {},
    blur: function() {},
    postMessage: function(msg, origin) {
      if (!sandbox.postMessages) sandbox.postMessages = [];
      sandbox.postMessages.push(msg);
    }
  };

  sandbox.Notification = function(title, options) {
    this.title = title;
  };
  sandbox.Notification.requestPermission = function() {
    return Promise.resolve('default');
  };
  sandbox.Notification.permission = 'default';

  sandbox.ServiceWorkerRegistration = function() {};
  sandbox.ServiceWorkerRegistration.prototype = {
    showNotification: function() {
      return Promise.resolve();
    },
    pushManager: {}
  };

  sandbox.navigator = {
    permissions: {
      query: function(params) {
        return Promise.resolve({ state: 'prompt', name: params.name });
      }
    }
  };

  sandbox.PushManager = function() {};
  sandbox.PushManager.prototype = {
    subscribe: function() {
      return Promise.resolve({});
    }
  };

  return sandbox;
};

test('main-world interceptor initialization', async (t) => {
  const sandbox = createSandbox();
  vm.createContext(sandbox);
  vm.runInContext(mainWorldCode, sandbox);

  await t.test('intercepts window.open', () => {
    assert.ok(sandbox.window.open !== Function.prototype, 'window.open should be shadowed');
  });
});

test('window.open functionality', async (t) => {
  let originalOpenCalled = false;
  let originalOpenArgs = null;
  const originalOpen = function() {
    originalOpenCalled = true;
    originalOpenArgs = Array.from(arguments);
    return 'fake-window';
  };

  const createSandbox = () => {
    const sandbox = {
      console: { log: () => {}, warn: () => {}, error: () => {} },
      setTimeout: (cb) => { try { cb(); } catch(e) {} },
      Date: { now: () => Date.now() },
      String: String,
      Object: Object,
      Promise: Promise,
      Error: Error,
      DOMException: class DOMException extends Error {
        constructor(message, name) {
          super(message);
          this.name = name;
        }
      },
      document: { documentElement: { dataset: { ytChromaPopActive: 'true', ytChromaPushActive: 'true' } } },
      postMessages: [],
      navigator: { permissions: { query: () => Promise.resolve({ state: 'prompt' }) } },
      PushManager: function() {},
      Notification: function() {}
    };
    sandbox.PushManager.prototype = { subscribe: () => Promise.resolve() };
    sandbox.Notification.requestPermission = () => Promise.resolve();
    sandbox.ServiceWorkerRegistration = function() {};
    sandbox.ServiceWorkerRegistration.prototype = { showNotification: () => Promise.resolve() };

    sandbox.window = {
      open: originalOpen,
      focus: function() {},
      blur: function() {},
      postMessage: function(msg, origin) {
        sandbox.postMessages.push({ msg, origin });
      },
      Notification: sandbox.Notification
    };
    return sandbox;
  };

  const sandbox = createSandbox();
  vm.createContext(sandbox);
  vm.runInContext(mainWorldCode, sandbox);

  await t.test('calls original open and posts a message', () => {
    const result = sandbox.window.open('https://example.com', '_blank', 'width=500');

    assert.strictEqual(originalOpenCalled, true, 'Original open should be called');
    assert.deepStrictEqual(originalOpenArgs, ['https://example.com', '_blank', 'width=500'], 'Args should be passed to original open');
    assert.strictEqual(result, 'fake-window', 'Result should be returned from original open');

    const msgs = sandbox.postMessages;
    assert.strictEqual(msgs.length, 1, 'One postMessage should be triggered');
    const msg = msgs[0].msg;
    assert.strictEqual(msg.source, 'yt-chroma-main-world');
    assert.strictEqual(msg.type, 'WINDOW_OPEN_ATTEMPT');
    assert.strictEqual(msg.url, 'https://example.com');
    assert.strictEqual(msg.name, '_blank');
    assert.strictEqual(msg.specs, 'width=500');
    assert.ok(msg.stack, 'Stack trace should be captured');
  });
});

test('window.focus and window.blur functionality', async (t) => {
  let currentTime = 10000;

  const createSandbox = () => {
    const sandbox = {
      console: { log: () => {}, warn: () => {}, error: () => {} },
      setTimeout: (cb) => { try { cb(); } catch(e) {} },
      Date: { now: () => currentTime },
      String: String,
      Object: Object,
      Promise: Promise,
      Error: Error,
      DOMException: class DOMException extends Error {},
      document: { documentElement: { dataset: { ytChromaPopActive: 'true', ytChromaPushActive: 'true' } } },
      postMessages: [],
      navigator: { permissions: { query: () => Promise.resolve({ state: 'prompt' }) } },
      PushManager: function() {},
      Notification: function() {}
    };
    sandbox.PushManager.prototype = { subscribe: () => Promise.resolve() };
    sandbox.Notification.requestPermission = () => Promise.resolve();
    sandbox.ServiceWorkerRegistration = function() {};
    sandbox.ServiceWorkerRegistration.prototype = { showNotification: () => Promise.resolve() };

    sandbox.window = {
      open: function() {},
      focus: function() {},
      blur: function() {},
      postMessage: function(msg, origin) {
        sandbox.postMessages.push({ msg, origin });
      },
      Notification: sandbox.Notification
    };
    return sandbox;
  };

  await t.test('detects focus called shortly after window.open', () => {
    currentTime = 10000;
    const sandbox = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(mainWorldCode, sandbox);

    // Simulate window.open
    sandbox.window.open('https://example.com');
    // Clear initial postMessage from window.open
    sandbox.postMessages = [];

    // Simulate focus quickly after open
    currentTime = 10500;
    sandbox.window.focus();

    assert.strictEqual(sandbox.postMessages.length, 1);
    assert.strictEqual(sandbox.postMessages[0].msg.type, 'SUSPICIOUS_FOCUS_ATTEMPT');
  });

  await t.test('ignores focus called long after window.open', () => {
    currentTime = 10000;
    const sandbox = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(mainWorldCode, sandbox);

    sandbox.window.open('https://example.com');
    sandbox.postMessages = [];

    currentTime = 12000; // 2 seconds later
    sandbox.window.focus();

    assert.strictEqual(sandbox.postMessages.length, 0);
  });

  await t.test('detects blur called shortly after window.open', () => {
    currentTime = 10000;
    const sandbox = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(mainWorldCode, sandbox);

    sandbox.window.open('https://example.com');
    sandbox.postMessages = [];

    currentTime = 10500;
    sandbox.window.blur();

    assert.strictEqual(sandbox.postMessages.length, 1);
    assert.strictEqual(sandbox.postMessages[0].msg.type, 'SUSPICIOUS_BLUR_ATTEMPT');
  });

  await t.test('ignores blur called long after window.open', () => {
    currentTime = 10000;
    const sandbox = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(mainWorldCode, sandbox);

    sandbox.window.open('https://example.com');
    sandbox.postMessages = [];

    currentTime = 12000; // 2 seconds later
    sandbox.window.blur();

    assert.strictEqual(sandbox.postMessages.length, 0);
  });
});

test('Push Notification Blocking - ACTIVE', async (t) => {
  const createSandbox = () => {
    const sandbox = {
      console: { log: () => {}, warn: () => {}, error: () => {} },
      setTimeout: (cb) => { try { cb(); } catch(e) {} },
      Date: { now: () => Date.now() },
      String: String,
      Object: Object,
      Promise: Promise,
      Error: Error,
      DOMException: class DOMException extends Error {
        constructor(message, name) {
          super(message);
          this.name = name;
        }
      },
      document: {
        documentElement: {
          dataset: { ytChromaPushActive: 'true' }
        }
      },
      postMessages: [],
      navigator: { permissions: { query: () => Promise.resolve({ state: 'prompt' }) } },
      PushManager: function() {},
      Notification: function(title, options) {
        this.title = title;
        this.options = options;
      }
    };
    sandbox.PushManager.prototype = { subscribe: () => Promise.resolve('real-sub') };
    sandbox.Notification.requestPermission = () => Promise.resolve('real-perm');
    sandbox.Notification.permission = 'default';
    sandbox.ServiceWorkerRegistration = function() {};
    sandbox.ServiceWorkerRegistration.prototype = {
      showNotification: () => Promise.resolve('real-show'),
      pushManager: {} // Important for the check!
    };

    sandbox.window = {
      open: function() {},
      focus: function() {},
      blur: function() {},
      postMessage: function(msg, origin) {
        sandbox.postMessages.push({ msg, origin });
      },
      Notification: sandbox.Notification
    };
    return sandbox;
  };

  const sandbox = createSandbox();
  vm.createContext(sandbox);
  vm.runInContext(mainWorldCode, sandbox);

  await t.test('Notification.requestPermission is blocked', async () => {
    sandbox.postMessages = [];
    const result = await sandbox.window.Notification.requestPermission();

    assert.strictEqual(result, 'denied', 'Should return denied');
    assert.strictEqual(sandbox.postMessages.length, 1, 'Should trigger postMessage');
    assert.strictEqual(sandbox.postMessages[0].msg.type, 'NOTIFICATION_ATTEMPT');
  });

  await t.test('Notification constructor is blocked', () => {
    sandbox.postMessages = [];
    const notif = new sandbox.window.Notification('Test Notif', { body: 'body' });

    assert.strictEqual(notif.title, 'Test Notif');
    assert.strictEqual(notif.body, 'body');
    // Ensure it's a dummy object with close method
    assert.strictEqual(typeof notif.close, 'function');

    assert.strictEqual(sandbox.postMessages.length, 1);
    assert.strictEqual(sandbox.postMessages[0].msg.type, 'NOTIFICATION_ATTEMPT');
  });

  await t.test('Notification.permission returns denied', () => {
    assert.strictEqual(sandbox.window.Notification.permission, 'denied');
  });

  await t.test('ServiceWorkerRegistration.prototype.showNotification is blocked', async () => {
    sandbox.postMessages = [];
    const swr = new sandbox.ServiceWorkerRegistration();
    const result = await swr.showNotification('SW Notif');

    assert.strictEqual(result, undefined, 'Promise should resolve with undefined');
    assert.strictEqual(sandbox.postMessages.length, 1);
    assert.strictEqual(sandbox.postMessages[0].msg.type, 'NOTIFICATION_ATTEMPT');
  });

  await t.test('navigator.permissions.query for notifications is blocked', async () => {
    const result = await sandbox.navigator.permissions.query({ name: 'notifications' });
    assert.strictEqual(result.state, 'denied');
    assert.strictEqual(result.name, 'notifications');
  });

  await t.test('navigator.permissions.query for other permissions is not blocked', async () => {
    const result = await sandbox.navigator.permissions.query({ name: 'geolocation' });
    assert.strictEqual(result.state, 'prompt');
  });

  await t.test('PushManager.prototype.subscribe is blocked', async () => {
    const pm = new sandbox.PushManager();
    let errorThrown = false;
    try {
      await pm.subscribe();
    } catch (e) {
      errorThrown = true;
      assert.strictEqual(e.name, 'AbortError');
    }
    assert.strictEqual(errorThrown, true, 'Should have thrown an error');
  });
});

test('Push Notification Blocking - INACTIVE', async (t) => {
  const createSandbox = () => {
    const sandbox = {
      console: { log: () => {}, warn: () => {}, error: () => {} },
      setTimeout: (cb) => { try { cb(); } catch(e) {} },
      Date: { now: () => Date.now() },
      String: String,
      Object: Object,
      Promise: Promise,
      Error: Error,
      DOMException: class DOMException extends Error {},
      document: {
        documentElement: {
          dataset: { ytChromaPushActive: 'false' } // INACTIVE
        }
      },
      postMessages: [],
      navigator: { permissions: { query: () => Promise.resolve({ state: 'prompt' }) } },
      PushManager: function() {},
      Notification: function(title, options) {
        this.title = title;
        this.options = options;
      }
    };
    sandbox.PushManager.prototype = { subscribe: () => Promise.resolve('real-sub') };
    sandbox.Notification.requestPermission = () => Promise.resolve('real-perm');
    sandbox.Notification.permission = 'default';
    sandbox.ServiceWorkerRegistration = function() {};
    sandbox.ServiceWorkerRegistration.prototype = {
      showNotification: () => Promise.resolve('real-show'),
      pushManager: {}
    };

    sandbox.window = {
      open: function() {},
      focus: function() {},
      blur: function() {},
      postMessage: function(msg, origin) {
        sandbox.postMessages.push({ msg, origin });
      },
      Notification: sandbox.Notification
    };
    return sandbox;
  };

  const sandbox = createSandbox();
  vm.createContext(sandbox);
  vm.runInContext(mainWorldCode, sandbox);

  await t.test('Notification.requestPermission is NOT blocked', async () => {
    sandbox.postMessages = [];
    const result = await sandbox.window.Notification.requestPermission();

    assert.strictEqual(result, 'real-perm', 'Should return real result');
    assert.strictEqual(sandbox.postMessages.length, 0, 'Should not trigger postMessage');
  });

  await t.test('Notification constructor is NOT blocked', () => {
    sandbox.postMessages = [];
    const notif = new sandbox.window.Notification('Test Notif', { body: 'body' });

    assert.strictEqual(notif.title, 'Test Notif');
    assert.strictEqual(notif.options.body, 'body');
    assert.strictEqual(sandbox.postMessages.length, 0);
  });

  await t.test('Notification.permission returns default', () => {
    assert.strictEqual(sandbox.window.Notification.permission, 'default');
  });

  await t.test('ServiceWorkerRegistration.prototype.showNotification is NOT blocked', async () => {
    sandbox.postMessages = [];
    const swr = new sandbox.ServiceWorkerRegistration();
    const result = await swr.showNotification('SW Notif');

    assert.strictEqual(result, 'real-show');
    assert.strictEqual(sandbox.postMessages.length, 0);
  });

  await t.test('navigator.permissions.query for notifications is NOT blocked', async () => {
    const result = await sandbox.navigator.permissions.query({ name: 'notifications' });
    // From original mock
    assert.strictEqual(result.state, 'prompt');
  });

  await t.test('PushManager.prototype.subscribe is NOT blocked', async () => {
    const pm = new sandbox.PushManager();
    const result = await pm.subscribe();
    assert.strictEqual(result, 'real-sub');
  });
});
