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
  const storageWrites = [];
  const dnrWrites = [];
  const scrollCalls = [];
  let randomCounter = 100;

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
    const callbacks = [...(listeners[target].get(event.type) || [])];
    for (const callback of callbacks) callback(event);
    return true;
  };

  const document = {
    length: 0,
    documentElement: {},
    adoptedStyleSheets: [],
    createElement: modifiedPrimitive === 'createElement' ? function createElement() { return {}; } : Object,
    dispatchEvent: modifiedPrimitive === 'dispatchEvent' ? function dispatchEvent() { return true; } : Array.prototype.push,
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
    setTimeout: callback => { callback(); return 1; },
    clearTimeout() {},
    setInterval: callback => { window._ping = callback; return 1; },
    clearInterval: () => { window._ping = null; },
    requestAnimationFrame: callback => { window._raf = callback; return 1; },
    cancelAnimationFrame() {},
    addEventListener: addListener('window'),
    removeEventListener: removeListener('window'),
    dispatchEvent: dispatch('window')
  };

  const sandbox = {
    console,
    window,
    document,
    performance: { now: () => 0 },
    crypto: {
      getRandomValues(values) {
        for (let index = 0; index < values.length; index++) values[index] = randomCounter++;
        return values;
      }
    },
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
      }
    },
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

  sandbox.dispatchDocument = event => dispatch('document')({
    stopImmediatePropagation() {},
    ...event
  });

  sandbox.getNativeEvents = () => {
    const events = [];
    for (let index = 0; index < document.length; index++) events.push(document[index]);
    return events;
  };
  sandbox.getListenerCount = (target, type) => (listeners[target].get(type) || []).length;
  sandbox.getScrollCalls = () => scrollCalls.slice();
  sandbox.originalScrollTo = originalScrollTo;
  sandbox.originalScroll = originalScroll;

  sandbox.simulateHandshake = config => {
    window._ping();
    const readyEvent = sandbox.getNativeEvents().findLast(event => event.type === '__CHROMA_MAIN_READY__');
    assert.ok(readyEvent?.detail?.readyToken, 'MAIN ready challenge should be generated');
    const portNonce = '__CHROMA_PT_123456789_987654321__';
    sandbox.dispatchDocument({
      type: '__CHROMA_CONFIG_DELIVERY__',
      detail: { portNonce, readyToken: readyEvent.detail.readyToken }
    });

    const port = {
      onmessage: null,
      postMessage(message) { sandbox.portReplies.push(message); }
    };
    dispatch('window')({
      type: portNonce,
      ports: [port],
      stopImmediatePropagation() {}
    });
    assert.strictEqual(typeof port.onmessage, 'function');
    port.onmessage({ data: { type: 'INIT_CHROMA', config } });
    sandbox._lastPort = port;
    return port;
  };

  vm.createContext(sandbox);
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

  for (const modifiedPrimitive of ['createElement', 'dispatchEvent', 'bind', 'bindThrows', 'proxiedBindThrows']) {
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
    sandbox.dispatchDocument({
      type: '__CHROMA_CONFIG_DELIVERY__',
      detail: {
        portNonce: '__CHROMA_PT_attacker_123456789__',
        readyToken: 'attacker-token'
      }
    });
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
});

test('production source contains no page-controlled integrity bypass', () => {
  assert.doesNotMatch(interceptorJsCode, /__CHROMA_TEST_ENVIRONMENT__/);
});
