const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadRouter() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'core', 'messageRouter.js'), 'utf8')
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
  vm.runInContext(`${source}\nglobalThis.__router = { registerHandler, attachListener };`, sandbox);
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

test('message router defaults registered handlers to extension-page callers', async () => {
  const sandbox = loadRouter();
  let calls = 0;
  sandbox.__router.registerHandler('PRIVATE_GET', async () => {
    calls++;
    return { ok: true };
  });

  assert.deepStrictEqual(
    await dispatch(sandbox, { type: 'PRIVATE_GET' }, {
      id: 'ext-id',
      origin: 'https://example.com',
      url: 'https://example.com/content.js',
      tab: { id: 1 }
    }),
    { ok: false, code: 'unauthorized', error: 'Unauthorized message sender' }
  );
  assert.strictEqual(calls, 0);

  assert.deepStrictEqual(
    await dispatch(sandbox, { type: 'PRIVATE_GET' }, { id: 'ext-id', origin: 'chrome-extension://ext-id' }),
    { ok: true }
  );
  assert.strictEqual(calls, 1);

  assert.deepStrictEqual(
    await dispatch(sandbox, { type: 'NO_SUCH_MESSAGE' }, { id: 'ext-id', origin: 'chrome-extension://ext-id' }),
    { ok: false, code: 'unknown_message', error: 'Unknown message type' }
  );
});

test('message router allows own content scripts only through explicit registration policy', async () => {
  const sandbox = loadRouter();
  sandbox.__router.registerHandler(
    'CONTENT_ALLOWED',
    async () => ({ ok: true, accepted: 1 }),
    { allowContentScripts: true }
  );

  assert.deepStrictEqual(
    await dispatch(sandbox, { type: 'CONTENT_ALLOWED' }, {
      id: 'ext-id',
      url: 'https://example.com/content.js',
      tab: { id: 1 }
    }),
    { ok: true, accepted: 1 }
  );

  assert.deepStrictEqual(
    await dispatch(sandbox, { type: 'CONTENT_ALLOWED' }, {
      id: 'other-extension',
      url: 'https://example.com/content.js',
      tab: { id: 1 }
    }),
    { ok: false, code: 'unauthorized', error: 'Unauthorized message sender' }
  );

  assert.deepStrictEqual(
    await dispatch(sandbox, { type: 'CONTENT_ALLOWED' }, {
      url: 'https://example.com/content.js',
      tab: { id: 1 }
    }),
    { ok: false, code: 'unauthorized', error: 'Unauthorized message sender' }
  );

  assert.deepStrictEqual(
    await dispatch(sandbox, { type: 'CONTENT_ALLOWED' }, {
      id: 'ext-id',
      url: 'https://example.com/content.js'
    }),
    { ok: false, code: 'unauthorized', error: 'Unauthorized message sender' }
  );

  assert.deepStrictEqual(
    await dispatch(sandbox, { type: 'CONTENT_ALLOWED' }, { id: 'ext-id', origin: 'chrome-extension://ext-id' }),
    { ok: true, accepted: 1 }
  );
});

test('message router rejects invalid and duplicate registrations', () => {
  const sandbox = loadRouter();
  const handler = async () => ({ ok: true });

  assert.throws(
    () => sandbox.__router.registerHandler('', handler),
    /type must be a non-empty string/
  );
  assert.throws(
    () => sandbox.__router.registerHandler('NOT_A_FUNCTION', null),
    /must be a function/
  );
  assert.throws(
    () => sandbox.__router.registerHandler('BAD_OPTIONS', handler, { allowContentScript: true }),
    /Invalid message handler options/
  );
  assert.throws(
    () => sandbox.__router.registerHandler('BAD_POLICY', handler, { allowContentScripts: 'yes' }),
    /Invalid message handler options/
  );

  sandbox.__router.registerHandler('DUPLICATE', handler);
  assert.throws(
    () => sandbox.__router.registerHandler('DUPLICATE', handler, { allowContentScripts: true }),
    /already registered/
  );
});

test('message router reports handler failures without throwing into callers', async () => {
  const sandbox = loadRouter();
  sandbox.__router.registerHandler('BROKEN', async () => {
    throw new Error('boom');
  });

  assert.deepStrictEqual(
    await dispatch(sandbox, { type: 'BROKEN' }, { id: 'ext-id', origin: 'chrome-extension://ext-id' }),
    { ok: false, code: 'handler_error', error: 'Message handler failed' }
  );
});
