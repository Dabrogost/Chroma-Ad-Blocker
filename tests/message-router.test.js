const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadRouter() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'core', 'messageRouter.js'), 'utf8')
    .replace(/import\s+\{\s*MSG\s*\}\s+from\s+['"]\.\/messageTypes\.js['"];?/,
      "const MSG = { STATS_EVENT_BATCH: 'STATS_EVENT_BATCH' };")
    .replace(/export\s+function\s+/g, 'function ');

  let listener = null;
  const sandbox = {
    chrome: {
      runtime: {
        id: 'ext-id',
        onMessage: {
          addListener: fn => { listener = fn; }
        }
      }
    },
    console,
    URL,
    Map,
    Set,
    Promise,
    globalThis: null,
    __CHROMA_INTERNAL_TEST_STRICT__: true
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(`${source}\nglobalThis.__router = { registerHandler, markSensitive, attachListener };`, sandbox);
  sandbox.__router.attachListener();
  sandbox.__listener = listener;
  return sandbox;
}

async function dispatch(sandbox, msg, sender) {
  let response;
  await sandbox.__listener(msg, sender, value => {
    response = value;
  });
  return JSON.parse(JSON.stringify(response));
}

test('message router returns structured errors for unauthorized and unknown messages', async () => {
  const sandbox = loadRouter();
  sandbox.__router.markSensitive('PRIVATE_GET');
  sandbox.__router.registerHandler('PRIVATE_GET', async () => ({ ok: true }));

  assert.deepStrictEqual(
    await dispatch(sandbox, { type: 'PRIVATE_GET' }, { id: 'ext-id', url: 'https://example.com/content.js' }),
    { ok: false, code: 'unauthorized', error: 'Unauthorized message sender' }
  );

  assert.deepStrictEqual(
    await dispatch(sandbox, { type: 'NO_SUCH_MESSAGE' }, { origin: 'chrome-extension://ext-id' }),
    { ok: false, code: 'unknown_message', error: 'Unknown message type' }
  );
});

test('message router allows extension pages and own content stats batches', async () => {
  const sandbox = loadRouter();
  sandbox.__router.markSensitive('PRIVATE_GET');
  sandbox.__router.markSensitive('STATS_EVENT_BATCH');
  sandbox.__router.registerHandler('PRIVATE_GET', async () => ({ ok: true, value: 1 }));
  sandbox.__router.registerHandler('STATS_EVENT_BATCH', async () => ({ ok: true, accepted: 1 }));

  assert.deepStrictEqual(
    await dispatch(sandbox, { type: 'PRIVATE_GET' }, { origin: 'chrome-extension://ext-id' }),
    { ok: true, value: 1 }
  );

  assert.deepStrictEqual(
    await dispatch(sandbox, { type: 'STATS_EVENT_BATCH' }, { id: 'ext-id', url: 'https://example.com/content.js' }),
    { ok: true, accepted: 1 }
  );
});

test('message router reports handler failures without throwing into callers', async () => {
  const sandbox = loadRouter();
  sandbox.__router.registerHandler('BROKEN', async () => {
    throw new Error('boom');
  });

  assert.deepStrictEqual(
    await dispatch(sandbox, { type: 'BROKEN' }, { origin: 'chrome-extension://ext-id' }),
    { ok: false, code: 'handler_error', error: 'Message handler failed' }
  );
});
