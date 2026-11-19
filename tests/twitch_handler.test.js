const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const handlerCode = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'content', 'twitch_handler.js'),
  'utf8'
);

function createTwitchHarness({ hostname = 'www.twitch.tv', fetchImpl } = {}) {
  const fetchCalls = [];
  const listeners = new Map();
  const bcChannels = new Map();
  const blobStore = new Map();
  let nextBlobId = 1;

  class MockBlob {
    constructor(parts = [], opts = {}) {
      this._text = parts.map(p => (p instanceof MockBlob ? p._text : String(p))).join('');
      this.type = opts.type || '';
      this.size = Buffer.byteLength(this._text);
    }
  }

  class MockURL extends URL {
    static createObjectURL(blob) {
      const url = `blob:https://${hostname}/id-${nextBlobId++}`;
      blobStore.set(url, blob instanceof MockBlob ? blob._text : String(blob));
      return url;
    }
    static revokeObjectURL(url) {
      blobStore.delete(String(url));
    }
  }

  class MockBroadcastChannel {
    constructor(name) {
      this.name = name;
      this.onmessage = null;
      if (!bcChannels.has(name)) bcChannels.set(name, new Set());
      bcChannels.get(name).add(this);
    }
    postMessage(data) {
      for (const peer of bcChannels.get(this.name) || []) {
        if (peer !== this && typeof peer.onmessage === 'function') peer.onmessage({ data });
      }
    }
  }

  const baseFetch = async (input, init) => {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : String(input);
    const headersObj = {};
    new Headers(init?.headers || req?.headers).forEach((v, k) => { headersObj[k] = v; });
    const body = typeof init?.body === 'string' ? init.body : (req ? await req.clone().text() : undefined);
    fetchCalls.push({ url, method: init?.method || req?.method || 'GET', headers: headersObj, body });
    if (fetchImpl) return fetchImpl({ url, headers: headersObj, body });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  class MockWorker {
    constructor(scriptURL) {
      const code = blobStore.get(String(scriptURL)) || '';
      const self = {
        fetch: baseFetch, Request, Headers, Response, URL: MockURL,
        BroadcastChannel: MockBroadcastChannel,
        location: { href: String(scriptURL) }
      };
      self.self = self;
      vm.runInNewContext(code, { self, URL: MockURL, Request, Headers, Response, BroadcastChannel: MockBroadcastChannel });
      this.workerScope = self;
    }
  }

  const windowObj = {
    location: { hostname, href: `https://${hostname}/directory` },
    fetch: baseFetch,
    Worker: MockWorker,
    URL: MockURL,
    Blob: MockBlob,
    Request, Headers, Response, CustomEvent, BroadcastChannel: MockBroadcastChannel,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    dispatchEvent(ev) {
      for (const fn of listeners.get(ev.type) || []) fn(ev);
      return !ev.defaultPrevented;
    }
  };
  windowObj.window = windowObj;
  windowObj.globalThis = windowObj;
  vm.createContext(windowObj);
  vm.runInContext(handlerCode, windowObj);

  return { window: windowObj, baseFetch, MockWorker, fetchCalls, runHandlerAgain: () => vm.runInContext(handlerCode, windowObj) };
}

test('Smart Twitch handler', async (t) => {
  await t.test('exits cleanly on non-Twitch hosts without hooking fetch or Worker', () => {
    for (const hostname of ['example.com', 'evil-twitch.tv']) {
      const h = createTwitchHarness({ hostname });
      assert.strictEqual(h.window.fetch, h.baseFetch);
      assert.strictEqual(h.window.Worker, h.MockWorker);
    }
  });

  await t.test('strips Authorization strictly on PlaybackAccessToken requests without mutating caller inputs', async () => {
    const h = createTwitchHarness();
    const callerHeaders = {
      Authorization: 'OAuth secret-token',
      'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
      'Client-Integrity': 'integrity-jwt',
      'X-Device-Id': 'device-123'
    };
    const callerInit = {
      method: 'POST',
      headers: callerHeaders,
      body: JSON.stringify({ operationName: 'PlaybackAccessToken_Template', variables: { login: 'x' } })
    };

    await h.window.fetch('https://gql.twitch.tv/gql', callerInit);
    assert.strictEqual(callerHeaders.Authorization, 'OAuth secret-token');
    assert.strictEqual(h.fetchCalls[0].headers.authorization, undefined);
    assert.strictEqual(h.fetchCalls[0].headers['client-id'], 'kimne78kx3ncx6brgo4mv6wki5h1ko');
    assert.strictEqual(h.fetchCalls[0].headers['client-integrity'], 'integrity-jwt');
    assert.strictEqual(h.fetchCalls[0].headers['x-device-id'], 'device-123');

    // Request object with query body fallback
    const req = new Request('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: callerHeaders,
      body: JSON.stringify({ query: 'query { streamPlaybackAccessToken(channelName: "x") { value } }' })
    });
    await h.window.fetch(req);
    assert.strictEqual(h.fetchCalls[1].headers.authorization, undefined);
    assert.strictEqual(h.fetchCalls[1].headers['client-integrity'], 'integrity-jwt');
  });

  await t.test('preserves Authorization on non-playback GQL operations and unrelated URLs', async () => {
    const h = createTwitchHarness();
    const headers = { Authorization: 'OAuth chat-token', 'Client-Id': 'cid' };
    await h.window.fetch('https://gql.twitch.tv/gql', {
      method: 'POST', headers, body: JSON.stringify({ operationName: 'ChatList_Badges', variables: {} })
    });
    await h.window.fetch('https://gql.twitch.tv/integrity', {
      method: 'POST', headers, body: JSON.stringify({ operationName: 'PlaybackAccessToken' })
    });
    assert.strictEqual(h.fetchCalls[0].headers.authorization, 'OAuth chat-token');
    assert.strictEqual(h.fetchCalls[1].headers.authorization, 'OAuth chat-token');
  });

  await t.test('splits mixed GraphQL batches and merges responses in original order', async () => {
    const h = createTwitchHarness({
      fetchImpl: ({ headers, body }) => {
        const ops = JSON.parse(body);
        const reply = ops.map(op => ({ op: op.operationName, hadAuth: Boolean(headers.authorization) }));
        return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });
    const res = await h.window.fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { Authorization: 'OAuth batch-tok', 'Client-Id': 'cid' },
      body: JSON.stringify([
        { operationName: 'ChatOp' },
        { operationName: 'PlaybackAccessToken_Template' },
        { operationName: 'DropOp' }
      ])
    });
    assert.deepStrictEqual(await res.json(), [
      { op: 'ChatOp', hadAuth: true },
      { op: 'PlaybackAccessToken_Template', hadAuth: false },
      { op: 'DropOp', hadAuth: true }
    ]);
  });

  await t.test('wraps blob Workers across immediate revoke and tracks live enable/disable toggles', async () => {
    const h = createTwitchHarness();
    const blobUrl = h.window.URL.createObjectURL(new h.window.Blob(['/* twitch worker */'], { type: 'application/javascript' }));
    const worker = new h.window.Worker(blobUrl);
    h.window.URL.revokeObjectURL(blobUrl);

    const gqlBody = JSON.stringify({ operationName: 'PlaybackAccessToken' });
    const headers = { Authorization: 'OAuth worker-tok', 'Client-Id': 'cid' };

    await worker.workerScope.fetch('https://gql.twitch.tv/gql', { method: 'POST', headers, body: gqlBody });
    assert.strictEqual(h.fetchCalls[0].headers.authorization, undefined);

    // Disable live via state event -> both main fetch and running worker preserve auth, new Worker passes through
    h.window.dispatchEvent(new CustomEvent('__CHROMA_TWITCH_PROXY_STATE__', { detail: { active: false }, cancelable: true }));
    await h.window.fetch('https://gql.twitch.tv/gql', { method: 'POST', headers, body: gqlBody });
    await worker.workerScope.fetch('https://gql.twitch.tv/gql', { method: 'POST', headers, body: gqlBody });
    assert.strictEqual(h.fetchCalls[1].headers.authorization, 'OAuth worker-tok');
    assert.strictEqual(h.fetchCalls[2].headers.authorization, 'OAuth worker-tok');

    // Re-injecting handler re-activates cleanly without double-wrapping fetch
    const wrappedFetch = h.window.fetch;
    h.runHandlerAgain();
    assert.strictEqual(h.window.fetch, wrappedFetch);
    await worker.workerScope.fetch('https://gql.twitch.tv/gql', { method: 'POST', headers, body: gqlBody });
    assert.strictEqual(h.fetchCalls[3].headers.authorization, undefined);
  });
});
