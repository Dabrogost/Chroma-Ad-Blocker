const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const interceptorJsCode = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'content', 'interceptor.js'),
  'utf8'
);

function createSandbox({ hostname = 'www.youtube.com', modifiedPrimitive = null } = {}) {
  const listeners = { window: new Map(), document: new Map() };
  const events = [];
  const timeouts = new Map();
  const storageWrites = [];
  const dnrWrites = [];
  const scrollCalls = [];
  let randomCounter = 100;
  let nextTimer = 1;
  let nextNonce = 100;

  // Proxy-backed test primitives exercise the production native-source check;
  // production code contains no VM-specific integrity bypass.
  const native = fn => new Proxy(fn, {});
  class MockEvent {
    constructor(type, options = {}) {
      this.type = type;
      this._cancelable = options.cancelable === true;
      this._bubbles = options.bubbles === true;
      this._composed = options.composed === true;
      this.defaultPrevented = false;
    }
  }
  Object.defineProperties(MockEvent.prototype, {
    cancelable: { configurable: true, get: native(function() { return this._cancelable; }) },
    stopImmediatePropagation: { configurable: true, value: native(function() { this._stopped = true; }) },
    preventDefault: { configurable: true, value: native(function() {
      if (this._cancelable) this.defaultPrevented = true;
    }) }
  });
  class MockCustomEvent extends MockEvent {
    constructor(type, options = {}) {
      super(type, options);
      this._eventKind = 'custom';
      this._detail = options.detail;
    }
  }
  Object.defineProperty(MockCustomEvent.prototype, 'detail', {
    configurable: true,
    get: native(function() {
      if (this._eventKind !== 'custom') throw new TypeError('Not a CustomEvent');
      return this._detail;
    })
  });
  class MockMessageEvent extends MockEvent {
    constructor(type, options = {}) {
      super(type, options);
      this._eventKind = 'message';
      this._ports = options.ports || [];
      this._data = options.data;
    }
  }
  Object.defineProperties(MockMessageEvent.prototype, {
    ports: { configurable: true, get: native(function() {
      if (this._eventKind !== 'message') throw new TypeError('Not a MessageEvent');
      return this._ports;
    }) },
    data: { configurable: true, get: native(function() {
      return this._eventKind === 'message' ? this._data : this.data;
    }) }
  });
  class MockMessagePort {
    constructor() { this.closed = false; this._onmessage = null; }
  }
  Object.defineProperties(MockMessagePort.prototype, {
    onmessage: {
      configurable: true,
      get() { return this._onmessage; },
      set: native(function(callback) {
        if (!(this instanceof MockMessagePort)) throw new TypeError('Not a MessagePort');
        this._onmessage = callback;
      })
    },
    postMessage: { configurable: true, value: native(function(message) {
      if (this.throwOnPost) throw new Error('Port post failed');
      sandbox.portReplies.push(message);
    }) },
    close: { configurable: true, value: native(function() { this.closed = true; }) }
  });

  const addListener = target => (type, callback) => {
    const callbacks = listeners[target].get(type) || [];
    callbacks.push(callback);
    listeners[target].set(type, callbacks);
  };
  const removeListener = target => (type, callback) => {
    const callbacks = listeners[target].get(type) || [];
    listeners[target].set(type, callbacks.filter(item => item !== callback));
  };
  const dispatch = target => event => {
    events.push(event);
    const callbacks = [...(listeners[target].get(event.type) || [])];
    for (const callback of callbacks) {
      callback(event);
      if (event._stopped) break;
    }
    return !event.defaultPrevented;
  };

  const document = {
    length: 0,
    documentElement: {},
    adoptedStyleSheets: [],
    createElement: modifiedPrimitive === 'createElement' ? function createElement() { return {}; } : Object,
    dispatchEvent: modifiedPrimitive === 'dispatchEvent' ? function dispatchEvent() { return true; } : native(dispatch('document')),
    addEventListener: addListener('document'),
    removeEventListener: removeListener('document'),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByClassName: () => []
  };
  if (modifiedPrimitive === 'createElement') {
    document.createElement.toString = () => 'function createElement() { [native code] }';
  }
  if (modifiedPrimitive === 'dispatchEvent') {
    document.dispatchEvent.toString = () => 'function dispatchEvent() { [native code] }';
  }

  const window = {
    location: { hostname },
    pageYOffset: 0,
    scrollTo(...args) { scrollCalls.push({ method: 'scrollTo', args }); },
    scroll(...args) { scrollCalls.push({ method: 'scroll', args }); },
    setTimeout: native((callback, delay) => {
      if (sandbox.failSetTimeout) throw new Error('Native-looking timer failed');
      const id = nextTimer++;
      timeouts.set(id, { callback, delay });
      return id;
    }),
    clearTimeout: native(id => { timeouts.delete(id); }),
    setInterval: native(callback => { window._ping = callback; return nextTimer++; }),
    clearInterval: native(() => { window._ping = null; }),
    requestAnimationFrame: callback => { window._raf = callback; return 1; },
    cancelAnimationFrame() {},
    addEventListener: native(addListener('window')),
    removeEventListener: native(removeListener('window')),
    dispatchEvent: native(dispatch('window'))
  };

  const sandbox = {
    console,
    window,
    document,
    performance: { now: () => 0 },
    crypto: {
      getRandomValues: native(function(values) {
        if (sandbox.failRandom) throw new Error('Cryptographic randomness unavailable');
        // Native RNG does not consult a page-defined typed-array length getter.
        for (let index = 0; index < 4; index++) values[index] = randomCounter++;
        return values;
      })
    },
    Event: MockEvent,
    CustomEvent: native(MockCustomEvent),
    MessageEvent: MockMessageEvent,
    MessagePort: MockMessagePort,
    CSSStyleSheet: class CSSStyleSheet { replaceSync() {} },
    Element: class Element {},
    HTMLElement: class HTMLElement {},
    Uint32Array,
    chrome: {
      storage: { local: { set: value => storageWrites.push(value) } },
      declarativeNetRequest: { updateDynamicRules: value => dnrWrites.push(value) }
    },
    portReplies: [],
    __CHROMA_INTERNAL_TEST_STRICT__: true
  };
  sandbox.globalThis = sandbox;
  sandbox.setTimeout = window.setTimeout;
  sandbox.clearTimeout = window.clearTimeout;
  sandbox.setInterval = window.setInterval;
  sandbox.clearInterval = window.clearInterval;
  Object.defineProperty(sandbox.Element.prototype, 'scrollTop', {
    configurable: true,
    enumerable: true,
    get() { return this._scrollTop || 0; },
    set(value) { this._scrollTop = value; }
  });

  const originalScrollTo = window.scrollTo;
  const originalScroll = window.scroll;

  sandbox.dispatchDocument = event => dispatch('document')(new MockCustomEvent(event.type, event));
  sandbox.dispatchWindow = event => dispatch('window')(new MockCustomEvent(event.type, event));
  sandbox.getNativeEvents = () => events.slice();
  sandbox.getListenerCount = (target, type) => (listeners[target].get(type) || []).length;
  sandbox.getNonceListenerCount = () => [...listeners.window].filter(([type]) => type.startsWith('__CHROMA_PT_'))
    .reduce((count, [, callbacks]) => count + callbacks.length, 0);
  sandbox.getTimeoutCount = () => timeouts.size;
  sandbox.getTimeoutCallbacks = () => [...timeouts.values()].map(timer => timer.callback);
  sandbox.runTimeouts = (delay = 500) => {
    for (const [id, timer] of [...timeouts]) {
      if (timer.delay !== delay) continue;
      timeouts.delete(id);
      timer.callback();
    }
  };
  sandbox.getScrollCalls = () => scrollCalls.slice();
  sandbox.originalScrollTo = originalScrollTo;
  sandbox.originalScroll = originalScroll;

  sandbox.readReadyToken = () => {
    window._ping();
    const readyEvent = sandbox.getNativeEvents().findLast(event => event.type === '__CHROMA_MAIN_READY__');
    assert.ok(readyEvent?.detail?.readyToken, 'MAIN ready challenge should be generated');
    return readyEvent.detail.readyToken;
  };
  sandbox.deliverConfig = (readyToken, portNonce, cancelable = true) => sandbox.dispatchWindow({
      type: '__CHROMA_CONFIG_DELIVERY__',
      cancelable,
      detail: { portNonce, readyToken }
  });
  sandbox.createPort = () => new MockMessagePort();
  sandbox.deliverPort = (portNonce, port) => dispatch('window')(new MockMessageEvent(portNonce, { ports: [port] }));
  sandbox.receiveMessage = (port, data) => port.onmessage(new MockMessageEvent('message', { data }));
  sandbox.beginCandidate = () => {
    const readyToken = sandbox.readReadyToken();
    const portNonce = `__CHROMA_PT_${nextNonce++}_123456789_987654321_77777777__`;
    assert.strictEqual(sandbox.deliverConfig(readyToken, portNonce), false, 'MAIN acknowledges authenticated delivery');
    return { readyToken, portNonce };
  };
  sandbox.simulateHandshake = config => {
    const { portNonce } = sandbox.beginCandidate();
    const port = sandbox.createPort();
    sandbox.deliverPort(portNonce, port);
    assert.strictEqual(typeof port.onmessage, 'function');
    sandbox.receiveMessage(port, { type: 'INIT_CHROMA', config });
    sandbox._lastPort = port;
    return port;
  };

  vm.createContext(sandbox);
  if (modifiedPrimitive === 'CustomEvent') sandbox.CustomEvent = MockCustomEvent;
  if (modifiedPrimitive === 'getRandomValues') sandbox.crypto.getRandomValues = function() { return []; };
  if (modifiedPrimitive === 'windowDispatchEvent') window.dispatchEvent = dispatch('window');
  if (modifiedPrimitive === 'portPostMessage') {
    Object.defineProperty(MockMessagePort.prototype, 'postMessage', { value() {} });
  }
  if (modifiedPrimitive === 'customEventDetail') {
    Object.defineProperty(MockCustomEvent.prototype, 'detail', { get() { return this._detail; } });
  }
  if (modifiedPrimitive === 'bind') {
    vm.runInContext(`
      const __nativeBind = Function.prototype.bind;
      Function.prototype.bind = function bind() {
        return Reflect.apply(__nativeBind, this, arguments);
      };
    `, sandbox);
  }
  if (modifiedPrimitive === 'bindThrows') {
    vm.runInContext(`
      Function.prototype.bind = function bind() {
        throw new Error('bind compromised');
      };
    `, sandbox);
  }
  if (modifiedPrimitive === 'proxiedBindThrows') {
    vm.runInContext(`
      const __nativeBind = Function.prototype.bind;
      Function.prototype.bind = new Proxy(__nativeBind, {
        apply() {
          throw new Error('proxied bind compromised');
        }
      });
    `, sandbox);
  }
  vm.runInContext(interceptorJsCode, sandbox);
  return { sandbox, storageWrites, dnrWrites };
}

test('main-world interceptor secure configuration bridge', async t => {
  await t.test('ordinary native primitives pass the production integrity branch', () => {
    const { sandbox } = createSandbox();
    assert.strictEqual(sandbox.__CHROMA_STATE_BRIDGE__.isEnvironmentCompromised, false);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.window.__CHROMA_INTERNAL__.config)), {
      enabled: false,
      stripping: false,
      acceleration: false
    });
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.revision, 0);
    assert.strictEqual(sandbox.__CHROMA_STATE_BRIDGE__.isInitialized, false);
    const descriptor = Object.getOwnPropertyDescriptor(sandbox.window, '__CHROMA_INTERNAL__');
    assert.strictEqual(descriptor.configurable, false);
    assert.strictEqual(descriptor.writable, false);
  });

  for (const modifiedPrimitive of [
    'createElement', 'dispatchEvent', 'bind', 'bindThrows', 'proxiedBindThrows',
    'CustomEvent', 'getRandomValues', 'windowDispatchEvent', 'portPostMessage', 'customEventDetail'
  ]) {
    await t.test(`modified ${modifiedPrimitive} yields an inert bridge`, () => {
      const { sandbox } = createSandbox({ modifiedPrimitive });
      assert.strictEqual(sandbox.__CHROMA_STATE_BRIDGE__.isEnvironmentCompromised, true);
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(sandbox.window.__CHROMA_INTERNAL__.config)),
        { enabled: false, stripping: false, acceleration: false }
      );
      assert.strictEqual(sandbox.window._ping, undefined);

      sandbox.dispatchDocument({
        type: '__CHROMA_CONFIG_UPDATE__',
        detail: { enabled: true, stripping: true, acceleration: true }
      });
      assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.enabled, false);
    });
  }

  await t.test('initial authenticated off state advances beyond the pending bridge revision', () => {
    const { sandbox } = createSandbox({ hostname: 'www.yahoo.com' });
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.revision, 0);
    sandbox.simulateHandshake({ enabled: false, stripping: false, acceleration: false });
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.revision, 1);
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.enabled, false);
  });

  await t.test('initial bridge snapshot exactly preserves authenticated stored values', () => {
    const { sandbox } = createSandbox();
    sandbox.simulateHandshake({
      enabled: false,
      stripping: false,
      acceleration: true,
      accelerationSpeed: 12
    });

    const bridge = sandbox.window.__CHROMA_INTERNAL__;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(bridge.config)), {
      enabled: false,
      stripping: false,
      acceleration: true,
      accelerationSpeed: 12
    });
    assert.strictEqual(Object.isFrozen(bridge.config), true);
    assert.notStrictEqual(bridge.config, bridge.config);
    assert.strictEqual(bridge.revision, 1);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.portReplies)), [{ type: 'CHROMA_READY' }]);
  });

  await t.test('forged public events cannot change bridge, storage, or DNR state', () => {
    const { sandbox, storageWrites, dnrWrites } = createSandbox();
    sandbox.simulateHandshake({
      enabled: false,
      stripping: false,
      acceleration: false,
      accelerationSpeed: 8
    });
    const before = JSON.stringify(sandbox.window.__CHROMA_INTERNAL__.config);

    sandbox.dispatchDocument({
      type: '__CHROMA_CONFIG_UPDATE__',
      detail: {
        enabled: true,
        stripping: true,
        acceleration: true,
        accelerationSpeed: 16
      }
    });

    assert.strictEqual(JSON.stringify(sandbox.window.__CHROMA_INTERNAL__.config), before);
    assert.deepStrictEqual(storageWrites, []);
    assert.deepStrictEqual(dnrWrites, []);
  });

  await t.test('legitimate port updates are validated and notify without values', () => {
    const { sandbox } = createSandbox();
    const port = sandbox.simulateHandshake({
      enabled: false,
      stripping: false,
      acceleration: false,
      accelerationSpeed: 8
    });

    port.onmessage({
      data: {
        type: 'BACKGROUND_RESPONSE',
        data: {
          type: 'CONFIG_UPDATE',
          config: {
            enabled: true,
            stripping: true,
            acceleration: true,
            accelerationSpeed: 6,
            checkIntervalMs: 250,
            unknown: true
          }
        }
      }
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.window.__CHROMA_INTERNAL__.config)), {
      enabled: true,
      stripping: true,
      acceleration: true,
      accelerationSpeed: 6,
      checkIntervalMs: 250
    });

    port.onmessage({
      data: {
        type: 'BACKGROUND_RESPONSE',
        data: {
          type: 'CONFIG_UPDATE',
          config: { acceleration: false, enabled: 'yes', accelerationSpeed: 99 }
        }
      }
    });
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.enabled, true);
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.acceleration, false);
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.accelerationSpeed, 6);

    const notifications = sandbox.getNativeEvents().filter(event => event.type === '__CHROMA_CONFIG_UPDATE__');
    assert.ok(notifications.length >= 2);
    assert.ok(notifications.every(event => event.detail === undefined));
  });

  await t.test('a forged delivery without the MAIN challenge cannot seize the port', () => {
    const { sandbox } = createSandbox();
    assert.strictEqual(sandbox.dispatchWindow({
      type: '__CHROMA_CONFIG_DELIVERY__',
      cancelable: true,
      detail: {
        portNonce: '__CHROMA_PT_attacker_123456789__',
        readyToken: 'attacker-token'
      }
    }), true, 'wrong challenge must not be acknowledged');
    assert.strictEqual(sandbox.getNonceListenerCount(), 0);
    assert.strictEqual(sandbox.getTimeoutCount(), 0);
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.enabled, false);
    sandbox.simulateHandshake({ enabled: false, stripping: false, acceleration: false });
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.enabled, false);
  });

  await t.test('YouTube scroll protection follows authenticated master state reversibly', () => {
    const { sandbox } = createSandbox();
    const { window, document } = sandbox;
    assert.strictEqual(window.scrollTo, sandbox.originalScrollTo);
    assert.strictEqual(window.scroll, sandbox.originalScroll);
    assert.strictEqual(sandbox.getListenerCount('document', 'wheel'), 0);
    assert.strictEqual(document.adoptedStyleSheets.length, 0);

    sandbox.dispatchDocument({
      type: '__CHROMA_CONFIG_UPDATE__',
      detail: { enabled: true }
    });
    assert.strictEqual(window.scrollTo, sandbox.originalScrollTo, 'forged notifications stay inert');

    const port = sandbox.simulateHandshake({
      enabled: true,
      stripping: false,
      acceleration: false
    });
    assert.notStrictEqual(window.scrollTo, sandbox.originalScrollTo);
    assert.notStrictEqual(window.scroll, sandbox.originalScroll);
    assert.strictEqual(sandbox.getListenerCount('document', 'wheel'), 1);
    assert.strictEqual(document.adoptedStyleSheets.length, 1);
    const ownedSheet = document.adoptedStyleSheets[0];

    window.pageYOffset = 120;
    sandbox.dispatchDocument({ type: 'wheel' });
    window.scrollTo(0, 0);
    assert.strictEqual(sandbox.getScrollCalls().length, 0, 'recent-wheel reset should be suppressed');
    window.scrollTo(0, 40);
    assert.deepStrictEqual(sandbox.getScrollCalls(), [{ method: 'scrollTo', args: [0, 40] }]);

    port.onmessage({
      data: {
        type: 'BACKGROUND_RESPONSE',
        data: { type: 'CONFIG_UPDATE', config: { enabled: false } }
      }
    });
    assert.strictEqual(window.scrollTo, sandbox.originalScrollTo);
    assert.strictEqual(window.scroll, sandbox.originalScroll);
    assert.strictEqual(sandbox.getListenerCount('document', 'wheel'), 0);
    assert.strictEqual(document.adoptedStyleSheets.length, 0);

    port.onmessage({
      data: {
        type: 'BACKGROUND_RESPONSE',
        data: { type: 'CONFIG_UPDATE', config: { enabled: true } }
      }
    });
    assert.strictEqual(sandbox.getListenerCount('document', 'wheel'), 1);
    assert.strictEqual(document.adoptedStyleSheets.length, 1);
    assert.strictEqual(document.adoptedStyleSheets[0], ownedSheet, 're-enable reuses the owned sheet');
  });

  await t.test('YouTube cleanup preserves page replacements and disables buried wrappers', () => {
    const { sandbox } = createSandbox();
    const port = sandbox.simulateHandshake({ enabled: true, stripping: true, acceleration: false });
    const { window, document } = sandbox;
    const staleScrollToWrapper = window.scrollTo;
    const staleScrollTopDescriptor = Object.getOwnPropertyDescriptor(document.documentElement, 'scrollTop');
    const ownedSheet = document.adoptedStyleSheets[0];
    const pageSheet = { owner: 'page' };
    const pageScrollTo = () => 'page-scroll-to';
    const pageScroll = () => 'page-scroll';
    const pageScrollTopDescriptor = {
      configurable: true,
      get() { return 91; },
      set() {}
    };
    window.scrollTo = pageScrollTo;
    window.scroll = pageScroll;
    Object.defineProperty(document.documentElement, 'scrollTop', pageScrollTopDescriptor);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, pageSheet];

    port.onmessage({
      data: {
        type: 'BACKGROUND_RESPONSE',
        data: { type: 'CONFIG_UPDATE', config: { enabled: false } }
      }
    });

    assert.strictEqual(window.scrollTo, pageScrollTo);
    assert.strictEqual(window.scroll, pageScroll);
    assert.strictEqual(
      Object.getOwnPropertyDescriptor(document.documentElement, 'scrollTop').get,
      pageScrollTopDescriptor.get
    );
    assert.strictEqual(document.adoptedStyleSheets.length, 1);
    assert.strictEqual(document.adoptedStyleSheets[0], pageSheet);
    assert.ok(!document.adoptedStyleSheets.includes(ownedSheet));
    assert.strictEqual(sandbox.getListenerCount('document', 'wheel'), 0);

    staleScrollToWrapper(3, 4);
    assert.deepStrictEqual(sandbox.getScrollCalls().at(-1), { method: 'scrollTo', args: [3, 4] });
    staleScrollTopDescriptor.set.call(document.documentElement, 27);
    assert.strictEqual(document.documentElement._scrollTop, 27);
  });

  await t.test('recipe hosts receive the bridge without YouTube scroll patches', () => {
    const { sandbox } = createSandbox({ hostname: 'www.allrecipes.com' });
    assert.ok(sandbox.window.__CHROMA_INTERNAL__);
    sandbox.simulateHandshake({ enabled: true, stripping: true, acceleration: false });
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.enabled, true);
    assert.strictEqual(sandbox.window.scrollTo, sandbox.originalScrollTo);
    assert.strictEqual(sandbox.getListenerCount('document', 'wheel'), 0);
    assert.strictEqual(sandbox.document.adoptedStyleSheets.length, 0);
  });

  await t.test('non-bridge domains do not expose the bridge', () => {
    const { sandbox } = createSandbox({ hostname: 'example.com' });
    sandbox.simulateHandshake({ enabled: true, stripping: true, acceleration: false });
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__, undefined);
  });

  await t.test('Yahoo homepage bridge is limited to the two supported hosts', () => {
    for (const hostname of ['yahoo.com', 'www.yahoo.com']) {
      const { sandbox } = createSandbox({ hostname });
      sandbox.simulateHandshake({ enabled: true, stripping: true, acceleration: false });
      assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.enabled, true);
      assert.strictEqual(sandbox.window.scrollTo, sandbox.originalScrollTo);
    }
    for (const hostname of ['mail.yahoo.com', 'finance.yahoo.com', 'notyahoo.com', 'www.yahoo.com.example.com']) {
      const { sandbox } = createSandbox({ hostname });
      assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__, undefined, hostname);
    }
  });
});

test('production source contains no page-controlled integrity bypass', () => {
  assert.doesNotMatch(interceptorJsCode, /__CHROMA_TEST_ENVIRONMENT__/);
});

test('MAIN handshake retries and consumes each candidate exactly once', async t => {
  await t.test('missing port expires without disabling READY or delivery and retry commits', () => {
    const { sandbox } = createSandbox();
    const first = sandbox.beginCandidate();
    assert.strictEqual(sandbox.getNonceListenerCount(), 1);
    assert.strictEqual(sandbox.getTimeoutCount(), 1);
    assert.strictEqual(sandbox.getListenerCount('window', '__CHROMA_CONFIG_DELIVERY__'), 1);
    assert.strictEqual(typeof sandbox.window._ping, 'function');
    assert.strictEqual(sandbox.__CHROMA_STATE_BRIDGE__.isInitialized, false);
    sandbox.runTimeouts();
    assert.strictEqual(sandbox.getNonceListenerCount(), 0);
    assert.strictEqual(sandbox.getTimeoutCount(), 0);
    const expiry = sandbox.getNativeEvents().findLast(event => event.type === '__CHROMA_MAIN_READY__').detail;
    assert.strictEqual(expiry.expiredReadyToken, first.readyToken);
    assert.notStrictEqual(expiry.readyToken, first.readyToken);
    assert.strictEqual(Object.getPrototypeOf(expiry), null);
    assert.notStrictEqual(sandbox.readReadyToken(), first.readyToken);
    sandbox.simulateHandshake({ enabled: true, stripping: false, acceleration: false });
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.enabled, true);
    assert.strictEqual(sandbox.getListenerCount('window', '__CHROMA_CONFIG_DELIVERY__'), 0);
    assert.strictEqual(sandbox.getNonceListenerCount(), 0);
    assert.strictEqual(sandbox.getTimeoutCount(), 0);
    assert.strictEqual(sandbox.window._ping, null);
  });

  await t.test('uninitialized port closes and its queued messages cannot revive a stale attempt', () => {
    const { sandbox } = createSandbox();
    const first = sandbox.beginCandidate();
    const stalePort = sandbox.createPort();
    sandbox.deliverPort(first.portNonce, stalePort);
    const queuedCallback = stalePort.onmessage;
    for (const config of [undefined, null, [], 'invalid', 1]) {
      sandbox.receiveMessage(stalePort, { type: 'INIT_CHROMA', config });
    }
    sandbox.receiveMessage(stalePort, { type: 'BACKGROUND_RESPONSE', data: {
      type: 'CONFIG_UPDATE', config: { enabled: true }
    } });
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.enabled, false);
    assert.strictEqual(sandbox.portReplies.length, 0);
    assert.strictEqual(sandbox.getNonceListenerCount(), 0, 'port arrival removes nonce listener');
    assert.strictEqual(sandbox.getTimeoutCount(), 1, 'initialization deadline remains active');
    sandbox.runTimeouts();
    assert.strictEqual(stalePort.closed, true);
    assert.strictEqual(stalePort.onmessage, null);
    queuedCallback({ data: { type: 'INIT_CHROMA', config: { enabled: true } } });
    assert.strictEqual(sandbox.__CHROMA_STATE_BRIDGE__.isInitialized, false);
    sandbox.simulateHandshake({ enabled: false, stripping: true, acceleration: false });
    queuedCallback({ data: { type: 'BACKGROUND_RESPONSE', data: {
      type: 'CONFIG_UPDATE', config: { enabled: true }
    } } });
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.enabled, false);
  });

  await t.test('expiration closes the old candidate before synchronously accepting a replacement', () => {
    const { sandbox } = createSandbox();
    const first = sandbox.beginCandidate();
    const oldPort = sandbox.createPort();
    sandbox.deliverPort(first.portNonce, oldPort);
    let replacementPort;
    sandbox.window.addEventListener('__CHROMA_MAIN_READY__', event => {
      if (event.detail.expiredReadyToken !== first.readyToken) return;
      assert.strictEqual(oldPort.closed, true);
      assert.strictEqual(oldPort.onmessage, null);
      assert.strictEqual(sandbox.getTimeoutCount(), 0);
      const nonce = '__CHROMA_PT_retry_123_456_789__';
      assert.strictEqual(sandbox.deliverConfig(event.detail.readyToken, nonce), false);
      replacementPort = sandbox.createPort();
      sandbox.deliverPort(nonce, replacementPort);
      sandbox.receiveMessage(replacementPort, { type: 'INIT_CHROMA', config: { enabled: true } });
    });
    sandbox.runTimeouts();
    assert.ok(replacementPort);
    assert.strictEqual(replacementPort.closed, false);
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.enabled, true);
    assert.strictEqual(sandbox.getTimeoutCount(), 0);
    assert.strictEqual(sandbox.window._ping, null);
  });

  await t.test('INIT before a queued deadline preserves the committed port for delayed READY receipt', () => {
    const { sandbox } = createSandbox();
    const attempt = sandbox.beginCandidate();
    const queuedDeadline = sandbox.getTimeoutCallbacks()[0];
    const port = sandbox.createPort();
    sandbox.deliverPort(attempt.portNonce, port);
    sandbox.receiveMessage(port, { type: 'INIT_CHROMA', config: { enabled: true } });
    const readyEventsBefore = sandbox.getNativeEvents().filter(event => event.type === '__CHROMA_MAIN_READY__').length;
    // Posting READY queues another task in the real browser. Even if an already
    // queued deadline runs first, it must not invalidate the acknowledged port.
    queuedDeadline();
    assert.strictEqual(port.closed, false);
    assert.strictEqual(sandbox.getNativeEvents().filter(event => event.type === '__CHROMA_MAIN_READY__').length, readyEventsBefore);
    assert.strictEqual(sandbox.getTimeoutCount(), 0);
    assert.strictEqual(sandbox.window._ping, null);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.portReplies)), [{ type: 'CHROMA_READY' }]);
  });

  await t.test('RNG failure during expiration releases the old candidate and stops inert', () => {
    const { sandbox } = createSandbox();
    const attempt = sandbox.beginCandidate();
    const port = sandbox.createPort();
    sandbox.deliverPort(attempt.portNonce, port);
    sandbox.failRandom = true;
    sandbox.runTimeouts();
    const expiry = sandbox.getNativeEvents().findLast(event => event.type === '__CHROMA_MAIN_READY__').detail;
    assert.strictEqual(expiry.expiredReadyToken, attempt.readyToken);
    assert.strictEqual(expiry.readyToken, null);
    assert.strictEqual(port.closed, true);
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.enabled, false);
    assert.strictEqual(sandbox.__CHROMA_STATE_BRIDGE__.isEnvironmentCompromised, true);
    assert.strictEqual(sandbox.getTimeoutCount(), 0);
    assert.strictEqual(sandbox.getNonceListenerCount(), 0);
    assert.strictEqual(sandbox.getListenerCount('window', '__CHROMA_CONFIG_DELIVERY__'), 0);
    assert.strictEqual(sandbox.window._ping, null);
  });

  await t.test('a failed captured deadline primitive stops inert without recursively retrying', () => {
    const { sandbox } = createSandbox();
    const token = sandbox.readReadyToken();
    sandbox.failSetTimeout = true;
    let retrySignals = 0;
    sandbox.window.addEventListener('__CHROMA_MAIN_READY__', event => {
      if (event.detail.readyToken) {
        retrySignals++;
        sandbox.deliverConfig(event.detail.readyToken, '__CHROMA_PT_retry_123_456_789__');
      }
    });
    assert.strictEqual(sandbox.deliverConfig(token, '__CHROMA_PT_123_456_789_000__'), true);
    assert.strictEqual(retrySignals, 0);
    assert.strictEqual(sandbox.getNonceListenerCount(), 0);
    assert.strictEqual(sandbox.getTimeoutCount(), 0);
    assert.strictEqual(sandbox.getListenerCount('window', '__CHROMA_CONFIG_DELIVERY__'), 0);
    assert.strictEqual(sandbox.window._ping, null);
    assert.strictEqual(sandbox.__CHROMA_STATE_BRIDGE__.isEnvironmentCompromised, true);
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.enabled, false);
  });

  await t.test('expired delivery and stale nonce cannot claim a later channel', () => {
    const { sandbox } = createSandbox();
    const first = sandbox.beginCandidate();
    sandbox.runTimeouts();
    assert.strictEqual(sandbox.deliverConfig(first.readyToken, first.portNonce), true);
    assert.strictEqual(sandbox.getNonceListenerCount(), 0);
    const stalePort = sandbox.createPort();
    sandbox.deliverPort(first.portNonce, stalePort);
    assert.strictEqual(stalePort.onmessage, null);
    const second = sandbox.beginCandidate();
    sandbox.deliverPort(first.portNonce, stalePort);
    assert.strictEqual(stalePort.onmessage, null);
    const port = sandbox.createPort();
    sandbox.deliverPort(second.portNonce, port);
    sandbox.receiveMessage(port, { type: 'INIT_CHROMA', config: { enabled: true } });
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.enabled, true);
    sandbox.deliverPort(second.portNonce, stalePort);
    assert.strictEqual(stalePort.onmessage, null, 'committed nonce cannot initialize another channel');
  });

  await t.test('wrong-token traffic cannot allocate resources or be acknowledged by a later page listener', () => {
    const { sandbox } = createSandbox();
    let observedDeliveries = 0;
    sandbox.window.addEventListener('__CHROMA_CONFIG_DELIVERY__', event => {
      observedDeliveries++;
      event.preventDefault();
    }, true);
    for (let index = 0; index < 200; index++) {
      assert.strictEqual(sandbox.deliverConfig(`forged-${index}`, `__CHROMA_PT_fake_${index}__`), true);
    }
    assert.strictEqual(observedDeliveries, 0);
    assert.strictEqual(sandbox.getNonceListenerCount(), 0);
    assert.strictEqual(sandbox.getTimeoutCount(), 0);
    sandbox.simulateHandshake({ enabled: true });
    assert.strictEqual(observedDeliveries, 0);
  });

  await t.test('duplicate delivery retains one candidate and noncancelable delivery does not allocate', () => {
    const { sandbox } = createSandbox();
    const readyToken = sandbox.readReadyToken();
    const nonce = '__CHROMA_PT_111_222_333_444__';
    assert.strictEqual(sandbox.deliverConfig(readyToken, nonce, false), true);
    assert.strictEqual(sandbox.getTimeoutCount(), 0);
    assert.strictEqual(sandbox.deliverConfig(readyToken, nonce), false);
    for (let index = 0; index < 20; index++) {
      assert.strictEqual(sandbox.deliverConfig(readyToken, `${nonce}${index}`), true);
    }
    assert.strictEqual(sandbox.getNonceListenerCount(), 1);
    assert.strictEqual(sandbox.getTimeoutCount(), 1);
    const nonPort = { onmessage: null };
    sandbox.deliverPort(nonce, nonPort);
    assert.strictEqual(nonPort.onmessage, null);
    assert.strictEqual(sandbox.getNonceListenerCount(), 1);
    const port = sandbox.createPort();
    sandbox.deliverPort(nonce, port);
    sandbox.receiveMessage(port, { type: 'INIT_CHROMA', config: { enabled: false } });
    assert.strictEqual(sandbox.getTimeoutCount(), 0);
  });

  await t.test('duplicate INIT is ignored and committed cleanup precedes public notification', () => {
    const { sandbox } = createSandbox();
    let notifications = 0;
    sandbox.document.addEventListener('__CHROMA_CONFIG_UPDATE__', () => {
      notifications++;
      assert.strictEqual(sandbox.portReplies.length, 1);
      assert.strictEqual(sandbox.getNonceListenerCount(), 0);
      assert.strictEqual(sandbox.getTimeoutCount(), 0);
      assert.strictEqual(sandbox.getListenerCount('window', '__CHROMA_CONFIG_DELIVERY__'), 0);
      assert.strictEqual(sandbox.window._ping, null);
    });
    const port = sandbox.simulateHandshake({ enabled: false, stripping: false });
    sandbox.receiveMessage(port, { type: 'INIT_CHROMA', config: { enabled: true, stripping: true } });
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.enabled, false);
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.revision, 1);
    assert.strictEqual(sandbox.portReplies.length, 1);
    assert.strictEqual(notifications, 1);
    assert.strictEqual(port.closed, false, 'accepted private port stays open for updates');
    sandbox.runTimeouts();
    assert.strictEqual(port.closed, false);
  });

  await t.test('failed READY post closes candidate, restores inert state, and permits retry', () => {
    const { sandbox } = createSandbox();
    const first = sandbox.beginCandidate();
    const brokenPort = sandbox.createPort();
    brokenPort.throwOnPost = true;
    sandbox.deliverPort(first.portNonce, brokenPort);
    sandbox.receiveMessage(brokenPort, { type: 'INIT_CHROMA', config: { enabled: true } });
    assert.strictEqual(brokenPort.closed, true);
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.enabled, false);
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.revision, 0);
    assert.strictEqual(sandbox.__CHROMA_STATE_BRIDGE__.isInitialized, false);
    assert.strictEqual(sandbox.window.scrollTo, sandbox.originalScrollTo);
    assert.strictEqual(sandbox.getTimeoutCount(), 0);
    sandbox.simulateHandshake({ enabled: true });
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.enabled, true);
  });
});

test('MAIN uses captured handshake primitives after page replacements', async t => {
  await t.test('replacing CustomEvent and crypto after startup cannot observe initial or retried challenges', () => {
    const { sandbox } = createSandbox();
    let calls = 0;
    sandbox.CustomEvent = function() { calls++; throw new Error('Page constructor'); };
    sandbox.crypto.getRandomValues = function() { calls++; throw new Error('Page RNG'); };
    sandbox.beginCandidate();
    sandbox.runTimeouts();
    sandbox.simulateHandshake({ enabled: true });
    assert.strictEqual(calls, 0);
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.enabled, true);
  });

  await t.test('page event and port prototype replacements cannot inspect delivery or channel messages', () => {
    const { sandbox } = createSandbox();
    const readyToken = sandbox.readReadyToken();
    let intercepted = 0;
    const trap = () => { intercepted++; throw new Error('Page prototype trap'); };
    Object.defineProperty(sandbox.CustomEvent.prototype, 'detail', { get: trap });
    Object.defineProperty(sandbox.MessageEvent.prototype, 'ports', { get: trap });
    Object.defineProperty(sandbox.MessageEvent.prototype, 'data', { get: trap });
    Object.defineProperty(sandbox.Event.prototype, 'cancelable', { get: trap });
    Object.defineProperty(sandbox.Event.prototype, 'preventDefault', { value: trap });
    Object.defineProperty(sandbox.Event.prototype, 'stopImmediatePropagation', { value: trap });
    Object.defineProperty(sandbox.MessagePort.prototype, 'onmessage', { set: trap });
    Object.defineProperty(sandbox.MessagePort.prototype, 'postMessage', { value: trap });
    Object.defineProperty(sandbox.MessagePort.prototype, 'close', { value: trap });
    sandbox.window.dispatchEvent = trap;
    sandbox.window.addEventListener = trap;
    sandbox.window.removeEventListener = trap;
    const nonce = '__CHROMA_PT_123_456_789_999__';
    assert.strictEqual(sandbox.deliverConfig(readyToken, nonce), false);
    const stalePort = sandbox.createPort();
    sandbox.deliverPort(nonce, stalePort);
    sandbox.runTimeouts();
    assert.strictEqual(stalePort.closed, true);
    sandbox.window._ping();
    const nextToken = sandbox.getNativeEvents().findLast(event => event.type === '__CHROMA_MAIN_READY__')._detail.readyToken;
    assert.strictEqual(sandbox.deliverConfig(nextToken, `${nonce}retry`), false);
    const port = sandbox.createPort();
    sandbox.deliverPort(`${nonce}retry`, port);
    sandbox.receiveMessage(port, { type: 'INIT_CHROMA', config: { enabled: true } });
    sandbox.receiveMessage(port, { type: 'BACKGROUND_RESPONSE', data: {
      type: 'CONFIG_UPDATE', config: { enabled: false }
    } });
    assert.strictEqual(sandbox.window.__CHROMA_INTERNAL__.config.enabled, false);
    assert.strictEqual(intercepted, 0);
  });

  await t.test('inherited WebIDL dictionary fields and typed-array length cannot reveal retry secrets', () => {
    const { sandbox } = createSandbox();
    sandbox.beginCandidate();
    vm.runInContext(`
      globalThis.secretGetterCalls = 0;
      Object.defineProperty(Object.prototype, 'bubbles', {
        configurable: true,
        get() { globalThis.secretGetterCalls++; return false; }
      });
    `, sandbox);
    const previousLength = Object.getOwnPropertyDescriptor(Uint32Array.prototype, 'length');
    let arrayLengthReads = 0;
    Object.defineProperty(Uint32Array.prototype, 'length', {
      configurable: true,
      get() { arrayLengthReads++; return 4; }
    });
    try {
      sandbox.runTimeouts();
      sandbox.simulateHandshake({ enabled: true });
      assert.strictEqual(sandbox.secretGetterCalls, 0);
      assert.strictEqual(arrayLengthReads, 0);
    } finally {
      if (previousLength) Object.defineProperty(Uint32Array.prototype, 'length', previousLength);
      else delete Uint32Array.prototype.length;
      vm.runInContext('delete Object.prototype.bubbles;', sandbox);
    }
  });
});
