const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const protectionJsCode = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'content', 'protection.js'),
  'utf8'
);

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createProtectionHarness({ hostname = 'www.youtube.com', acceptedToken = 'trusted-ready-token' } = {}) {
  const storageResult = createDeferred();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const documentEvents = [];
  const windowEvents = [];
  const portMessages = [];
  const storageWrites = [];
  const dnrWrites = [];
  const backgroundMessages = [];
  const timers = [];
  const channels = [];
  const randomLengths = [];
  let runtimeListener = null;
  let storageListener = null;
  let randomCounter = 20;

  const addDocumentListener = (type, callback) => {
    const callbacks = documentListeners.get(type) || [];
    callbacks.push(callback);
    documentListeners.set(type, callbacks);
  };
  const removeDocumentListener = (type, callback) => {
    const callbacks = documentListeners.get(type) || [];
    documentListeners.set(type, callbacks.filter(item => item !== callback));
  };
  const dispatchDocument = event => {
    documentEvents.push(event);
    for (const callback of [...(documentListeners.get(event.type) || [])]) callback(event);
    return true;
  };
  const dispatchWindow = event => {
    windowEvents.push(event);
    let stopped = false;
    event.stopImmediatePropagation = () => { stopped = true; };
    for (const callback of [...(windowListeners.get(event.type) || [])]) {
      callback(event);
      if (stopped) break;
    }
    return !event.defaultPrevented;
  };
  const addWindowListener = (type, callback) => {
    const callbacks = windowListeners.get(type) || [];
    callbacks.push(callback);
    windowListeners.set(type, callbacks);
  };
  // Model MAIN's synchronous token check/nonce-listener acceptance. This map
  // harness covers state only; loaded-extension E2E covers real propagation.
  addWindowListener('__CHROMA_CONFIG_DELIVERY__', event => {
    event.stopImmediatePropagation();
    if (event.detail?.readyToken === acceptedToken) event.preventDefault();
  });

  class FakeMessageChannel {
    constructor() {
      this.port1 = {
        postMessage(message) { portMessages.push(message); },
        onmessage: null,
        closed: false,
        close() { this.closed = true; }
      };
      this.port2 = {
        postMessage: message => {
          if (typeof this.port1.onmessage === 'function') {
            this.port1.onmessage({ data: message });
          }
        },
        onmessage: null,
        closed: false,
        close() { this.closed = true; }
      };
      channels.push(this);
    }
  }

  const window = {
    location: { hostname },
    MSG: { CONFIG_UPDATE: 'CONFIG_UPDATE', STATS_EVENT_BATCH: 'STATS_EVENT_BATCH' },
    notifyBackground(message) { backgroundMessages.push(message); },
    addEventListener: addWindowListener,
    removeEventListener(type, callback) {
      windowListeners.set(type, (windowListeners.get(type) || []).filter(item => item !== callback));
    },
    dispatchEvent: dispatchWindow
  };
  const notifyBackground = message => { backgroundMessages.push(message); };
  window.notifyBackground = notifyBackground;
  const sandbox = {
    window,
    document: {
      addEventListener: addDocumentListener,
      removeEventListener: removeDocumentListener,
      dispatchEvent: dispatchDocument
    },
    chrome: {
      storage: {
        local: {
          get: () => storageResult.promise,
          set: value => { storageWrites.push(value); return Promise.resolve(); }
        },
        onChanged: { addListener: callback => { storageListener = callback; } }
      },
      runtime: {
        onMessage: { addListener: callback => { runtimeListener = callback; } }
      },
      declarativeNetRequest: {
        updateDynamicRules: value => { dnrWrites.push(value); return Promise.resolve(); }
      }
    },
    crypto: {
      getRandomValues(values) {
        randomLengths.push(values.length);
        for (let index = 0; index < values.length; index++) values[index] = randomCounter++;
        return values;
      }
    },
    MessageChannel: FakeMessageChannel,
    MessageEvent: class MessageEvent {
      constructor(type, options = {}) { this.type = type; this.ports = options.ports || []; }
    },
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
        this.cancelable = options.cancelable === true;
        this.defaultPrevented = false;
      }
      preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
    },
    Uint32Array,
    Date,
    Object,
    Array,
    Number,
    notifyBackground,
    setTimeout(callback, delay) {
      timers.push({ callback, delay, active: true });
      return timers.length;
    },
    clearTimeout(timerId) {
      if (timers[timerId - 1]) timers[timerId - 1].active = false;
    },
    console
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(protectionJsCode, sandbox);

  return {
    storageResult,
    documentEvents,
    windowEvents,
    portMessages,
    backgroundMessages,
    storageWrites,
    dnrWrites,
    dispatchDocument,
    dispatchWindow,
    sandbox,
    channels,
    randomLengths,
    getListenerCount(type) { return (windowListeners.get(type) || []).length; },
    activeTimers() { return timers.filter(timer => timer.active).length; },
    expireCandidate(nextToken = null) {
      // MAIN owns the deadline; this authenticated signal follows its cleanup.
      const expiredReadyToken = acceptedToken;
      if (nextToken) acceptedToken = nextToken;
      dispatchWindow({ type: '__CHROMA_MAIN_READY__', detail: {
        expiredReadyToken, readyToken: nextToken
      } });
    },
    sendRuntimeMessage(message) { return runtimeListener(message); },
    sendStorageChange(changes, area = 'local') { return storageListener(changes, area); },
    runTimers(delay) {
      for (const timer of timers) {
        if (!timer.active || timer.delay !== delay) continue;
        timer.active = false;
        timer.callback();
      }
    }
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

test('isolated-world secure configuration relay', async t => {
  await t.test('waits for storage and relays exact false values and custom speed', async () => {
    const harness = createProtectionHarness();
    harness.dispatchWindow({
      type: '__CHROMA_MAIN_READY__',
      detail: { readyToken: 'trusted-ready-token' },
      stopImmediatePropagation() {}
    });
    assert.strictEqual(harness.portMessages.length, 0);

    harness.storageResult.resolve({
      config: {
        enabled: false,
        stripping: false,
        acceleration: false,
        accelerationSpeed: 12
      },
      whitelist: []
    });
    await flushPromises();

    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.portMessages)), [{
      type: 'INIT_CHROMA',
      config: {
        enabled: false,
        acceleration: false,
        stripping: false,
        accelerationSpeed: 12
      }
    }]);
    const delivery = harness.windowEvents.find(event => event.type === '__CHROMA_CONFIG_DELIVERY__');
    assert.strictEqual(delivery.detail.readyToken, 'trusted-ready-token');
    assert.ok(delivery.detail.portNonce.startsWith('__CHROMA_PT_'));
    assert.strictEqual(
      harness.documentEvents.some(event => event.type === '__CHROMA_CONFIG_UPDATE__' || event.type === '__EXT_INIT__'),
      false
    );
  });

  await t.test('partial legitimate updates preserve prior master and stripping values', async () => {
    const harness = createProtectionHarness();
    harness.dispatchWindow({
      type: '__CHROMA_MAIN_READY__',
      detail: { readyToken: 'trusted-ready-token' },
      stopImmediatePropagation() {}
    });
    harness.storageResult.resolve({
      config: { enabled: false, stripping: false, acceleration: false, accelerationSpeed: 10 },
      whitelist: []
    });
    await flushPromises();

    harness.sendRuntimeMessage({
      type: 'CONFIG_UPDATE',
      config: { acceleration: true, accelerationSpeed: 4 }
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.portMessages.at(-1))), {
      type: 'BACKGROUND_RESPONSE',
      data: {
        type: 'CONFIG_UPDATE',
        config: {
          enabled: false,
          acceleration: true,
          stripping: false,
          accelerationSpeed: 4
        }
      }
    });
  });

  await t.test('a runtime update during storage loading overlays the older stored snapshot', async () => {
    const harness = createProtectionHarness();
    harness.dispatchWindow({
      type: '__CHROMA_MAIN_READY__',
      detail: { readyToken: 'trusted-ready-token' },
      stopImmediatePropagation() {}
    });
    harness.sendRuntimeMessage({
      type: 'CONFIG_UPDATE',
      config: { enabled: false, stripping: false, accelerationSpeed: 4 }
    });
    harness.storageResult.resolve({
      config: { enabled: true, stripping: true, acceleration: true, accelerationSpeed: 12 },
      whitelist: []
    });
    await flushPromises();

    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.portMessages[0].config)), {
      enabled: false,
      acceleration: true,
      stripping: false,
      accelerationSpeed: 4
    });
  });

  await t.test('forged READY during storage loading cannot permanently displace genuine retries', async () => {
    const harness = createProtectionHarness();
    harness.dispatchWindow({ type: '__CHROMA_MAIN_READY__', detail: { readyToken: 'trusted-ready-token' } });
    for (let index = 0; index < 100; index++) {
      harness.dispatchWindow({ type: '__CHROMA_MAIN_READY__', detail: { readyToken: 'forged-token-' + index } });
    }
    harness.storageResult.resolve({ config: { enabled: true }, whitelist: [] });
    await flushPromises();
    assert.strictEqual(harness.channels.length, 0);
    assert.strictEqual(harness.activeTimers(), 0);
    harness.dispatchWindow({ type: '__CHROMA_MAIN_READY__', detail: { readyToken: 'trusted-ready-token' } });
    assert.strictEqual(harness.channels.length, 1);
    harness.channels[0].port2.postMessage({ type: 'CHROMA_READY' });
    assert.strictEqual(harness.getListenerCount('__CHROMA_MAIN_READY__'), 0);
    assert.strictEqual(harness.activeTimers(), 0);
  });

  await t.test('a storage read failure completes with an inert snapshot', async () => {
    const harness = createProtectionHarness();
    harness.dispatchWindow({
      type: '__CHROMA_MAIN_READY__',
      detail: { readyToken: 'trusted-ready-token' },
      stopImmediatePropagation() {}
    });
    harness.storageResult.reject(new Error('storage unavailable'));
    await flushPromises();

    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.portMessages[0].config)), {
      enabled: false,
      acceleration: false,
      stripping: false,
      accelerationSpeed: 8
    });
  });

  await t.test('forged READY floods allocate no candidates and genuine repeated READY stays usable', async () => {
    const harness = createProtectionHarness();
    harness.storageResult.resolve({ config: { enabled: true }, whitelist: [] });
    await flushPromises();
    for (let round = 0; round < 3; round++) {
      for (let index = 0; index < 100; index++) {
        harness.dispatchWindow({ type: '__CHROMA_MAIN_READY__', detail: { readyToken: 'forged-token-' + index } });
      }
      assert.strictEqual(harness.channels.filter(channel => !channel.port1.closed).length, 0);
      assert.strictEqual(harness.activeTimers(), 0);
      harness.dispatchWindow({ type: '__CHROMA_MAIN_READY__', detail: { readyToken: 'trusted-ready-token' } });
      assert.strictEqual(harness.channels.filter(channel => !channel.port1.closed).length, 1);
      assert.strictEqual(harness.activeTimers(), 0, 'only MAIN owns a handshake deadline');
      // Repeated genuine or forged READY cannot replace an accepted candidate.
      for (let index = 0; index < 20; index++) {
        harness.dispatchWindow({ type: '__CHROMA_MAIN_READY__', detail: { readyToken: 'trusted-ready-token' } });
        harness.dispatchWindow({ type: '__CHROMA_MAIN_READY__', detail: { readyToken: 'forged-ready-token' } });
      }
      assert.strictEqual(harness.channels.length, round + 1);
      if (round < 2) harness.expireCandidate();
    }
    harness.channels.at(-1).port2.postMessage({ type: 'CHROMA_READY' });
    assert.strictEqual(harness.getListenerCount('__CHROMA_MAIN_READY__'), 0);
    assert.strictEqual(harness.activeTimers(), 0);
    assert.strictEqual(harness.channels.filter(channel => !channel.port1.closed).length, 1);
  });

  await t.test('authenticated expiry closes both endpoints and late acknowledgements cannot commit', async () => {
    const harness = createProtectionHarness();
    harness.storageResult.resolve({ config: { enabled: true }, whitelist: [] });
    await flushPromises();
    const ready = { type: '__CHROMA_MAIN_READY__', detail: { readyToken: 'trusted-ready-token' } };
    harness.dispatchWindow(ready);
    const staleHandler = harness.channels[0].port1.onmessage;
    harness.expireCandidate();
    assert.ok(harness.channels[0].port1.closed);
    assert.ok(harness.channels[0].port2.closed);
    assert.strictEqual(harness.channels[0].port1.onmessage, null);
    harness.dispatchWindow(ready);
    staleHandler({ data: { type: 'CHROMA_READY' } });
    assert.strictEqual(harness.getListenerCount('__CHROMA_MAIN_READY__'), 1);
    assert.strictEqual(harness.activeTimers(), 0, 'only MAIN owns a handshake deadline');
    harness.channels[1].port2.postMessage({ type: 'CHROMA_READY' });
    assert.strictEqual(harness.getListenerCount('__CHROMA_MAIN_READY__'), 0);
    assert.strictEqual(harness.activeTimers(), 0);
    assert.strictEqual(harness.channels[1].port1.onmessage, null);
    harness.sendRuntimeMessage({ type: 'CONFIG_UPDATE', config: { enabled: false } });
    assert.strictEqual(harness.portMessages.at(-1).data.config.enabled, false);
  });

  await t.test('only a candidate port acknowledgement completes the handshake', async () => {
    const harness = createProtectionHarness();
    harness.storageResult.resolve({ config: {}, whitelist: [] });
    await flushPromises();
    harness.dispatchWindow({ type: '__CHROMA_MAIN_READY__', detail: { readyToken: 'trusted-ready-token' } });
    harness.dispatchWindow({ type: 'CHROMA_READY' });
    harness.channels[0].port2.postMessage({ type: 'NOT_READY' });
    assert.strictEqual(harness.getListenerCount('__CHROMA_MAIN_READY__'), 1);
    assert.strictEqual(harness.activeTimers(), 0, 'only MAIN owns a handshake deadline');
    harness.channels[0].port2.postMessage({ type: 'CHROMA_READY' });
    assert.strictEqual(harness.getListenerCount('__CHROMA_MAIN_READY__'), 0);
    assert.strictEqual(harness.activeTimers(), 0);
  });

  await t.test('forged expiry cannot cancel a candidate and a delayed port READY remains usable', async () => {
    const harness = createProtectionHarness();
    harness.storageResult.resolve({ config: {}, whitelist: [] });
    await flushPromises();
    harness.dispatchWindow({ type: '__CHROMA_MAIN_READY__', detail: { readyToken: 'trusted-ready-token' } });
    for (let index = 0; index < 100; index++) {
      harness.dispatchWindow({ type: '__CHROMA_MAIN_READY__', detail: {
        readyToken: 'forged-ready-token', expiredReadyToken: 'forged-expiry-' + index
      } });
    }
    harness.runTimers(500);
    assert.strictEqual(harness.channels.length, 1);
    assert.strictEqual(harness.channels[0].port1.closed, false);
    assert.strictEqual(harness.channels[0].port2.closed, false);
    assert.strictEqual(harness.activeTimers(), 0);
    harness.channels[0].port2.postMessage({ type: 'CHROMA_READY' });
    assert.strictEqual(harness.getListenerCount('__CHROMA_MAIN_READY__'), 0);
  });

  await t.test('authenticated expiry immediately retries the rotated challenge and stale expiry is ignored', async () => {
    const harness = createProtectionHarness();
    harness.storageResult.resolve({ config: { enabled: true }, whitelist: [] });
    await flushPromises();
    harness.dispatchWindow({ type: '__CHROMA_MAIN_READY__', detail: { readyToken: 'trusted-ready-token' } });
    harness.expireCandidate('rotated-trusted-token');
    assert.strictEqual(harness.channels.length, 2);
    assert.ok(harness.channels[0].port1.closed && harness.channels[0].port2.closed);
    harness.dispatchWindow({ type: '__CHROMA_MAIN_READY__', detail: {
      readyToken: 'rotated-trusted-token', expiredReadyToken: 'trusted-ready-token'
    } });
    assert.strictEqual(harness.channels.length, 2);
    assert.strictEqual(harness.channels[1].port1.closed, false);
    harness.channels[1].port2.postMessage({ type: 'CHROMA_READY' });
    assert.strictEqual(harness.getListenerCount('__CHROMA_MAIN_READY__'), 0);
  });

  await t.test('nonce uses four cryptographic words and a broken RNG stays inert', async () => {
    const harness = createProtectionHarness();
    harness.storageResult.resolve({ config: {}, whitelist: [] });
    await flushPromises();
    const ready = { type: '__CHROMA_MAIN_READY__', detail: { readyToken: 'trusted-ready-token' } };
    harness.dispatchWindow(ready);
    assert.deepStrictEqual(harness.randomLengths, [4]);
    const delivery = harness.windowEvents.find(event => event.type === '__CHROMA_CONFIG_DELIVERY__');
    assert.match(delivery.detail.portNonce, /^__CHROMA_PT_\d+_\d+_\d+_\d+__$/);
    assert.ok(delivery.cancelable);
    assert.strictEqual(harness.documentEvents.length, 0);
    harness.expireCandidate();
    harness.sandbox.crypto.getRandomValues = () => { throw new Error('RNG unavailable'); };
    harness.dispatchWindow(ready);
    assert.strictEqual(harness.channels.length, 1);
    assert.strictEqual(harness.activeTimers(), 0);
  });

  await t.test('failed transfer closes both ports and a later READY can retry', async () => {
    const harness = createProtectionHarness();
    harness.storageResult.resolve({ config: { enabled: true }, whitelist: [] });
    await flushPromises();
    const dispatch = harness.sandbox.window.dispatchEvent;
    harness.sandbox.window.dispatchEvent = event => {
      if (event.type.startsWith('__CHROMA_PT_')) throw new Error('port transfer failed');
      return dispatch(event);
    };
    const ready = { type: '__CHROMA_MAIN_READY__', detail: { readyToken: 'trusted-ready-token' } };
    harness.dispatchWindow(ready);
    assert.strictEqual(harness.channels.length, 1);
    assert.ok(harness.channels[0].port1.closed);
    assert.ok(harness.channels[0].port2.closed);
    assert.strictEqual(harness.activeTimers(), 0);
    assert.strictEqual(harness.portMessages.length, 0);
    harness.sandbox.window.dispatchEvent = dispatch;
    harness.dispatchWindow(ready);
    harness.channels[1].port2.postMessage({ type: 'CHROMA_READY' });
    assert.strictEqual(harness.getListenerCount('__CHROMA_MAIN_READY__'), 0);
    assert.strictEqual(harness.activeTimers(), 0);
  });

  await t.test('MessageEvent construction failure uses the private CustomEvent port fallback', async () => {
    const harness = createProtectionHarness();
    harness.storageResult.resolve({ config: {}, whitelist: [] });
    await flushPromises();
    harness.sandbox.MessageEvent = class { constructor() { throw new Error('unavailable'); } };
    harness.dispatchWindow({ type: '__CHROMA_MAIN_READY__', detail: { readyToken: 'trusted-ready-token' } });
    const transfer = harness.windowEvents.find(event => event.type.startsWith('__CHROMA_PT_'));
    assert.strictEqual(transfer.detail.port, harness.channels[0].port2);
    transfer.detail.port.postMessage({ type: 'CHROMA_READY' });
    assert.strictEqual(harness.getListenerCount('__CHROMA_MAIN_READY__'), 0);
    assert.strictEqual(harness.activeTimers(), 0);
  });

  await t.test('whitelist changes during storage loading win over its older snapshot', async () => {
    const harness = createProtectionHarness();
    harness.dispatchWindow({ type: '__CHROMA_MAIN_READY__', detail: { readyToken: 'trusted-ready-token' } });
    harness.sendStorageChange({ whitelist: { newValue: ['youtube.com'] } });
    harness.storageResult.resolve({ config: { enabled: true, stripping: true, acceleration: true }, whitelist: [] });
    await flushPromises();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.portMessages[0].config)), {
      enabled: false, acceleration: false, stripping: false, accelerationSpeed: 8
    });
  });

  await t.test('whitelisted initialization and later config updates remain inactive', async () => {
    const harness = createProtectionHarness({ hostname: 'video.example.com' });
    harness.dispatchWindow({
      type: '__CHROMA_MAIN_READY__',
      detail: { readyToken: 'trusted-ready-token' },
      stopImmediatePropagation() {}
    });
    harness.storageResult.resolve({
      config: { enabled: true, stripping: true, acceleration: true, accelerationSpeed: 16 },
      whitelist: ['example.com']
    });
    await flushPromises();

    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.portMessages[0].config)), {
      enabled: false,
      acceleration: false,
      stripping: false,
      accelerationSpeed: 16
    });
    harness.sendRuntimeMessage({
      type: 'CONFIG_UPDATE',
      config: { enabled: true, stripping: true, acceleration: true }
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.portMessages.at(-1).data.config)), {
      enabled: false,
      acceleration: false,
      stripping: false,
      accelerationSpeed: 16
    });
  });

  await t.test('live whitelist changes deactivate and restore stored master state', async () => {
    const harness = createProtectionHarness({ hostname: 'recipes.example.com' });
    harness.dispatchWindow({
      type: '__CHROMA_MAIN_READY__',
      detail: { readyToken: 'trusted-ready-token' },
      stopImmediatePropagation() {}
    });
    harness.storageResult.resolve({
      config: { enabled: true, stripping: true, acceleration: true, accelerationSpeed: 6 },
      whitelist: []
    });
    await flushPromises();

    harness.sendStorageChange({
      whitelist: { oldValue: [], newValue: ['example.com'] }
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.portMessages.at(-1).data.config)), {
      enabled: false,
      acceleration: false,
      stripping: false,
      accelerationSpeed: 6
    });

    harness.sendRuntimeMessage({
      type: 'CONFIG_UPDATE',
      config: { accelerationSpeed: 10, stripping: false }
    });
    harness.sendStorageChange({
      whitelist: { oldValue: ['example.com'], newValue: [] }
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.portMessages.at(-1).data.config)), {
      enabled: true,
      acceleration: true,
      stripping: false,
      accelerationSpeed: 10
    });
  });

  await t.test('forged DOM config events cannot affect privileged state or relay messages', async () => {
    const harness = createProtectionHarness();
    harness.storageResult.resolve({
      config: { enabled: false, stripping: false, acceleration: false },
      whitelist: []
    });
    await flushPromises();
    const messageCount = harness.portMessages.length;

    harness.dispatchDocument({
      type: '__CHROMA_CONFIG_UPDATE__',
      detail: { enabled: true, stripping: true, acceleration: true }
    });
    assert.strictEqual(harness.portMessages.length, messageCount);
    assert.deepStrictEqual(harness.storageWrites, []);
    assert.deepStrictEqual(harness.dnrWrites, []);
  });

  await t.test('MAIN telemetry accepts only a coarse enum and derives no page metadata', async () => {
    const harness = createProtectionHarness();

    harness.dispatchDocument({
      type: '__CHROMA_STATS_EVENT__',
      detail: 'youtube_payload_modified'
    });
    harness.storageResult.resolve({
      config: { enabled: true, stripping: true, acceleration: false },
      whitelist: []
    });
    await flushPromises();

    harness.dispatchDocument({
      type: '__CHROMA_STATS_EVENT__',
      detail: {
        eventType: 'youtube_payload_modified',
        count: 100000,
        ts: 1,
        domain: 'spoofed.example',
        source: 'private-list-id',
        ruleId: 999
      }
    });
    harness.dispatchDocument({
      type: '__CHROMA_STATS_EVENT__',
      detail: 'youtube_payload_modified'
    });
    harness.runTimers(750);

    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.backgroundMessages)), [{
      type: 'STATS_EVENT_BATCH',
      events: [{ eventType: 'youtube_payload_modified' }]
    }]);
  });

  await t.test('MAIN telemetry is feature-gated and bounded per document', async () => {
    const disabled = createProtectionHarness();
    disabled.storageResult.resolve({
      config: { enabled: false, stripping: true, acceleration: false },
      whitelist: []
    });
    await flushPromises();
    disabled.dispatchDocument({ type: '__CHROMA_STATS_EVENT__', detail: 'youtube_payload_modified' });
    disabled.runTimers(750);
    assert.deepStrictEqual(disabled.backgroundMessages, []);

    const strippingOff = createProtectionHarness();
    strippingOff.storageResult.resolve({
      config: { enabled: true, stripping: false, acceleration: false },
      whitelist: []
    });
    await flushPromises();
    strippingOff.dispatchDocument({ type: '__CHROMA_STATS_EVENT__', detail: 'youtube_payload_modified' });
    strippingOff.runTimers(750);
    assert.deepStrictEqual(strippingOff.backgroundMessages, []);

    const active = createProtectionHarness();
    active.storageResult.resolve({
      config: { enabled: true, stripping: true, acceleration: false },
      whitelist: []
    });
    await flushPromises();
    for (let index = 0; index < 1000; index++) {
      active.dispatchDocument({ type: '__CHROMA_STATS_EVENT__', detail: 'youtube_payload_modified' });
    }
    active.runTimers(750);
    const accepted = active.backgroundMessages.flatMap(message => message.events);
    assert.strictEqual(accepted.length, 20);
    assert.ok(accepted.every(event => event.eventType === 'youtube_payload_modified'));
  });

  await t.test('deactivation discards queued MAIN telemetry and resets its document budget', async () => {
    const harness = createProtectionHarness();
    harness.storageResult.resolve({
      config: { enabled: true, stripping: true, acceleration: false },
      whitelist: []
    });
    await flushPromises();

    harness.dispatchDocument({ type: '__CHROMA_STATS_EVENT__', detail: 'youtube_payload_modified' });
    harness.sendRuntimeMessage({
      type: 'CONFIG_UPDATE',
      config: { enabled: false }
    });
    harness.runTimers(750);
    assert.deepStrictEqual(harness.backgroundMessages, []);

    harness.sendRuntimeMessage({
      type: 'CONFIG_UPDATE',
      config: { enabled: true }
    });
    for (let index = 0; index < 20; index++) {
      harness.dispatchDocument({ type: '__CHROMA_STATS_EVENT__', detail: 'youtube_payload_modified' });
    }
    harness.runTimers(750);
    assert.strictEqual(harness.backgroundMessages.flatMap(message => message.events).length, 20);
  });
});
