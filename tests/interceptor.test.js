const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const interceptorJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'interceptor.js'), 'utf8');

const makeNative = (fn) => {
  fn.toString = () => 'function () { [native code] }';
  return fn;
};

const createSandbox = () => {
  const sandbox = {
    console: console,
    DEBUG: true,
    Date: { now: () => Date.now() },
    String: String,
    Object: Object,
    Promise: Promise,
    Error: Error,
    postMessages: [],
    CustomEvent: class CustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options?.detail;
      }
    },
    DOMException: class DOMException extends Error {
      constructor(message, name) { super(message); this.name = name; }
    }
  };

  const listeners = { window: {}, document: {} };
  const addListener = (target) => (type, cb, useCapture) => {
    if (!listeners[target][type]) listeners[target][type] = [];
    listeners[target][type].push(cb);
  };
  const dispatch = (target) => (event) => {
    const type = typeof event === 'string' ? event : event.type;
    const e = typeof event === 'string' ? { type } : event;
    if (listeners[target][type]) {
      listeners[target][type].forEach(cb => cb(e));
    }
  };

  // Integrity Layer: Native function signature mocking.
  const mockedFunctions = new Set();
  const makeNative = (fn) => {
    mockedFunctions.add(fn);
    return fn;
  };

  sandbox.window = {
    open: makeNative(function() { return {}; }),
    focus: makeNative(function() {}),
    blur: makeNative(function() {}),
    fetch: makeNative(() => Promise.resolve({})),
    setTimeout: (cb) => { try { cb(); } catch(e) {} },
    clearTimeout: () => {},
    setInterval: (cb) => { sandbox._pingInterval = cb; return 1; },
    clearInterval: () => { sandbox._pingInterval = null; },
    addEventListener: addListener('window'),
    removeEventListener: () => {},
    dispatchEvent: dispatch('window'),
    postMessage: function(msg, origin, ports) {
      sandbox.postMessages.push({ msg, origin, ports });
    },
    Notification: makeNative(function() {}),
    location: { hostname: 'www.youtube.com' },
    __CHROMA_TEST_ENVIRONMENT__: true
  };

  sandbox.document = {
    documentElement: { 
      dataset: { },
      getAttribute: (name) => null
    },
    addEventListener: addListener('document'),
    removeEventListener: () => {},
    dispatchEvent: makeNative(dispatch('document')),
    createElement: makeNative(() => ({ style: {} })),
    getElementById: () => null,
    querySelector: () => null
  };
  
  sandbox.window.Notification.requestPermission = makeNative(() => Promise.resolve('default'));
  sandbox.window.Notification.permission = 'default';
  
  // Integrity Layer: Pre-capture global initialization.
  sandbox.setTimeout = sandbox.window.setTimeout;
  sandbox.clearTimeout = sandbox.window.clearTimeout;
  sandbox.setInterval = sandbox.window.setInterval;
  sandbox.clearInterval = sandbox.window.clearInterval;
  sandbox.fetch = sandbox.window.fetch;
  sandbox.Notification = sandbox.window.Notification;

  sandbox.ServiceWorkerRegistration = function() {};
  sandbox.ServiceWorkerRegistration.prototype = {
    // Push Interception Mocking: Standard ServiceWorkerRegistration object.
    showNotification: () => Promise.resolve(),
    pushManager: {}
  };
  sandbox.navigator = {
    permissions: { query: (p) => Promise.resolve({ state: 'prompt', name: p.name }) }
  };
  sandbox.PushManager = function() {};
  sandbox.PushManager.prototype = {
    // Push Interception Mocking: Standard PushManager object.
    subscribe: () => Promise.resolve({})
  };

  /** @param {string} token @param {Object} selectors */
  sandbox.simulateHandshake = (token = 'test-token', selectors = {}) => {
    dispatch('document')('__CHROMA_TOKEN_DELIVERY__');
    
    // VULN-01 Patch: MessagePort transfer via CustomEvent.
    const port = { 
      postMessage: (m) => {
        // Echo back for tests if needed, but primarily we act as Isolated World here
        sandbox.postMessages.push({ msg: m, viaPort: true });
      },
      onmessage: null
    };

    sandbox.window.dispatchEvent({
      type: '__CHROMA_PORT_TRANSFER__',
      ports: [port],
      detail: { port: port },
      stopImmediatePropagation: () => {}
    });

    if (port.onmessage) {
      port.onmessage({
        data: {
          type: 'INIT_CHROMA',
          token: token,
          selectors: { HIDE_SELECTORS: [], WARNING_SELECTORS: [], ...selectors }
        }
      });
    }
  };

  return sandbox;
};

// ─── MAIN-WORLD INTERCEPTOR INITIALIZATION ─────
test('main-world interceptor initialization', async (t) => {
  const sandbox = createSandbox();
  vm.createContext(sandbox);
  vm.runInContext(interceptorJsCode, sandbox);
  sandbox.simulateHandshake();

  await t.test('intercepts Notification as secondary protection', () => {
    assert.ok(sandbox.window.Notification !== Function.prototype, 'Notification should be shadowed');
  });
});


// ─── PUSH NOTIFICATION BLOCKING ─────
test('Push Notification Blocking - ACTIVE', async (t) => {
  const sandbox = createSandbox();
  vm.createContext(sandbox);
  vm.runInContext(interceptorJsCode, sandbox);
  sandbox.simulateHandshake();

  await t.test('Notification.requestPermission is blocked', async () => {
    sandbox.postMessages = [];
    const result = await sandbox.window.Notification.requestPermission();

    assert.strictEqual(result, 'denied', 'Should return denied');
    const portMessages = sandbox.postMessages.filter(m => m.viaPort);
    assert.strictEqual(portMessages.length, 1, 'Should trigger postMessage via port');
    assert.strictEqual(portMessages[0].msg.type, 'NOTIFICATION_ATTEMPT');
  });

  await t.test('Notification constructor is blocked', () => {
    sandbox.postMessages = [];
    const notif = new sandbox.window.Notification('Test Notif', { body: 'body' });

    assert.strictEqual(notif.title, 'Test Notif');
    const portMessages = sandbox.postMessages.filter(m => m.viaPort);
    assert.strictEqual(portMessages.length, 1);
  });
});

// ─── SECURITY HARDENING ─────
test('Security Hardening - Bridge Lockdown', async (t) => {
  await t.test('Bridge is created on trusted domain (YouTube)', () => {
    const sandbox = createSandbox();
    sandbox.window.location.hostname = 'www.youtube.com';
    vm.createContext(sandbox);
    vm.runInContext(interceptorJsCode, sandbox);
    sandbox.simulateHandshake();

    assert.ok(sandbox.window.__CHROMA_INTERNAL__, 'Bridge should exist on YouTube');
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.token, undefined, 'Token should NOT be exposed');
  });

  await t.test('Bridge is NOT created on untrusted domain (example.com)', () => {
    const sandbox = createSandbox();
    sandbox.window.location.hostname = 'example.com';
    vm.createContext(sandbox);
    vm.runInContext(interceptorJsCode, sandbox);
    sandbox.simulateHandshake();

    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__, undefined, 'Bridge should NOT exist on example.com');
  });
});

