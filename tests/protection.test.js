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

function createProtectionHarness({ hostname = 'www.youtube.com' } = {}) {
  const storageResult = createDeferred();
  const documentListeners = new Map();
  const documentEvents = [];
  const windowEvents = [];
  const portMessages = [];
  const storageWrites = [];
  const dnrWrites = [];
  const backgroundMessages = [];
  const timers = [];
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

  class FakeMessageChannel {
    constructor() {
      this.port1 = {
        postMessage(message) { portMessages.push(message); },
        onmessage: null,
        close() {}
      };
      this.port2 = {
        postMessage: message => {
          if (typeof this.port1.onmessage === 'function') {
            this.port1.onmessage({ data: message });
          }
        },
        onmessage: null,
        close() {}
      };
    }
  }

  const window = {
    location: { hostname },
    MSG: { CONFIG_UPDATE: 'CONFIG_UPDATE', STATS_EVENT_BATCH: 'STATS_EVENT_BATCH' },
    notifyBackground(message) { backgroundMessages.push(message); },
    dispatchEvent(event) { windowEvents.push(event); return true; }
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
        for (let index = 0; index < values.length; index++) values[index] = randomCounter++;
        return values;
      }
    },
    MessageChannel: FakeMessageChannel,
    MessageEvent: class MessageEvent {
      constructor(type, options = {}) { this.type = type; this.ports = options.ports || []; }
    },
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
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
    harness.dispatchDocument({
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
    const delivery = harness.documentEvents.find(event => event.type === '__CHROMA_CONFIG_DELIVERY__');
    assert.strictEqual(delivery.detail.readyToken, 'trusted-ready-token');
    assert.ok(delivery.detail.portNonce.startsWith('__CHROMA_PT_'));
    assert.strictEqual(
      harness.documentEvents.some(event => event.type === '__CHROMA_CONFIG_UPDATE__' || event.type === '__EXT_INIT__'),
      false
    );
  });

  await t.test('partial legitimate updates preserve prior master and stripping values', async () => {
    const harness = createProtectionHarness();
    harness.dispatchDocument({
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
    harness.dispatchDocument({
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

  await t.test('forged ready notifications cannot consume the genuine handshake attempt', async () => {
    const harness = createProtectionHarness();
    harness.dispatchDocument({
      type: '__CHROMA_MAIN_READY__',
      detail: { readyToken: 'genuine-ready-token' },
      stopImmediatePropagation() {}
    });
    harness.dispatchDocument({
      type: '__CHROMA_MAIN_READY__',
      detail: { readyToken: 'forged-ready-token' },
      stopImmediatePropagation() {}
    });
    harness.storageResult.resolve({
      config: { enabled: false, stripping: false, acceleration: false },
      whitelist: []
    });
    await flushPromises();

    const attemptedTokens = harness.documentEvents
      .filter(event => event.type === '__CHROMA_CONFIG_DELIVERY__')
      .map(event => event.detail.readyToken);
    assert.deepStrictEqual(attemptedTokens.sort(), [
      'forged-ready-token',
      'genuine-ready-token'
    ]);
    assert.strictEqual(harness.portMessages.filter(message => message.type === 'INIT_CHROMA').length, 2);

    const genuineIndex = harness.documentEvents
      .filter(event => event.type === '__CHROMA_CONFIG_DELIVERY__')
      .findIndex(event => event.detail.readyToken === 'genuine-ready-token');
    const transferEvents = harness.windowEvents.filter(event => Array.isArray(event.ports));
    transferEvents[genuineIndex].ports[0].postMessage({ type: 'CHROMA_READY' });
    const deliveryCount = harness.documentEvents
      .filter(event => event.type === '__CHROMA_CONFIG_DELIVERY__').length;
    harness.dispatchDocument({
      type: '__CHROMA_MAIN_READY__',
      detail: { readyToken: 'post-ack-forged-token' },
      stopImmediatePropagation() {}
    });
    assert.strictEqual(
      harness.documentEvents.filter(event => event.type === '__CHROMA_CONFIG_DELIVERY__').length,
      deliveryCount,
      'acknowledgement should close the ready-event surface'
    );
  });

  await t.test('a storage read failure completes with an inert snapshot', async () => {
    const harness = createProtectionHarness();
    harness.dispatchDocument({
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

  await t.test('forged ready floods keep candidate resources bounded', async () => {
    const harness = createProtectionHarness();
    harness.storageResult.resolve({
      config: { enabled: false, stripping: false, acceleration: false },
      whitelist: []
    });
    await flushPromises();

    for (let index = 0; index < 100; index++) {
      harness.dispatchDocument({
        type: '__CHROMA_MAIN_READY__',
        detail: { readyToken: `forged-ready-token-${index}` },
        stopImmediatePropagation() {}
      });
    }
    assert.strictEqual(
      harness.documentEvents.filter(event => event.type === '__CHROMA_CONFIG_DELIVERY__').length,
      4
    );
    assert.strictEqual(harness.portMessages.filter(message => message.type === 'INIT_CHROMA').length, 4);
  });

  await t.test('whitelisted initialization and later config updates remain inactive', async () => {
    const harness = createProtectionHarness({ hostname: 'video.example.com' });
    harness.dispatchDocument({
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
    harness.dispatchDocument({
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
