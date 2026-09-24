const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createMockElement(tag = 'div') {
  return {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    classList: {
      add: function() { this.active = true; },
      remove: function() { this.active = false; },
      contains: function(c) { return !!this.active; }
    },
    style: {
      setProperty: () => {},
      removeProperty: () => {},
      display: '',
      width: '',
      height: '',
      playbackRate: 1
    },
    dataset: {},
    childrenArray: [],
    appendChild: function(child) {
      this.childrenArray.push(child);
      return child;
    },
    attachShadow: function({ mode }) {
      this.shadowRoot = {
        mode,
        childrenArray: [],
        appendChild: function(child) {
          this.childrenArray.push(child);
          return child;
        },
        querySelector: function(sel) {
          return this.childrenArray.find(c => 
            (sel.includes('.') && c.className === sel.split('.')[1]) ||
            (sel.includes('#') && c.id === sel.split('#')[1])
          );
        }
      };
      return this.shadowRoot;
    },
    remove: function() { this.removed = true; },
    closest: (selector) => null,
    contains: (other) => false,
    textContent: '',
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => [],
    parentElement: null,
    getAttribute: () => null,
    setAttribute: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    muted: false,
    volume: 1,
    playbackRate: 1
  };
}

const scriptPath = path.join(__dirname, '..', 'extension', 'content', 'yt_handler.js');
const youtubeJsCode = fs.readFileSync(scriptPath, 'utf8');

// ─── AD FIELD STRIPPING ─────
test('Ad field stripping', async (t) => {
  // Minimal sandbox — stripping functions run synchronously, no DOM needed.
  const createStrippingSandbox = (configOverrides = {}, nativeFetch, hostname = 'www.youtube.com', setupSandbox = null) => {
    const sandbox = {
      window: {
        location: { hostname },
        fetch: nativeFetch || (async () => ({ clone: () => ({ json: async () => ({}) }), status: 200, statusText: 'OK', headers: {} })),
        addEventListener: () => {},
        removeEventListener: () => {},
        innerHeight: 1000, innerWidth: 1000,
        setTimeout: (fn) => fn(),
        setInterval: () => {},
        clearInterval: () => {},
        MutationObserver: class { observe() {} disconnect() {} },
      },
      location: { hostname },
      document: {
        readyState: 'complete',
        createElement: () => ({ style: {}, appendChild: () => {}, attachShadow: () => ({ appendChild: () => {}, querySelector: () => null, childrenArray: [] }) }),
        querySelector: () => null, querySelectorAll: () => [],
        getElementById: () => null,
        head: { appendChild: () => {} },
        body: { style: {}, classList: { add: () => {}, remove: () => {}, contains: () => false } },
        documentElement: { style: {}, classList: { add: () => {}, remove: () => {}, contains: () => false } },
        adoptedStyleSheets: [],
        _listeners: {},
        addEventListener: function(e, cb) { (this._listeners[e] = this._listeners[e] || []).push(cb); },
        removeEventListener: () => {},
        dispatchEvent: function(e) { (this._listeners[e.type] || []).forEach(cb => cb(e)); },
        getElementsByClassName: () => [],
      },
      setInterval: () => {},
      clearInterval: () => {},
      setTimeout: (fn) => fn(),
      requestAnimationFrame: () => {},
      MutationObserver: class { observe() {} disconnect() {} },
      CSSStyleSheet: class { replaceSync() {} },
      CustomEvent: class {
        constructor(type, init = {}) {
          this.type = type;
          this.detail = init.detail;
        }
      },
      Response: class {
        constructor(body, init) { this.body = body; this._init = init; }
        async json() { return JSON.parse(this.body); }
      },
      XMLHttpRequest: class { open() {} send() {} addEventListener() {} },
      console, Object, Array, Number, String, Boolean, Math, Date, Promise, Error, URL, Uint8Array,
      // Give each sandbox its own JSON copy so JSON.parse mutations don't leak between test sandboxes.
      JSON: { parse: JSON.parse, stringify: JSON.stringify },
      __CHROMA_INTERNAL_TEST_STRICT__: true,
    };
    sandbox._nativeJSONParse = sandbox.JSON.parse;
    sandbox._nativeFetch = sandbox.window.fetch;
    sandbox.globalThis = sandbox;
    sandbox.window.__CHROMA_INTERNAL__ = {
      api: {
        querySelector: (s) => sandbox.document.querySelector(s),
        createElement: (t) => sandbox.document.createElement(t),
        setInterval: () => {},
        clearInterval: () => {},
        addDocEventListener: (e, cb) => sandbox.document.addEventListener(e, cb),
        removeDocEventListener: () => {},
        MutationObserver: sandbox.window.MutationObserver,
      },
      config: { enabled: true, stripping: true, acceleration: false, accelerationSpeed: 8, ...configOverrides },
    };
    if (setupSandbox) setupSandbox(sandbox);
    vm.createContext(sandbox);
    vm.runInContext(youtubeJsCode, sandbox);
    return sandbox;
  };

  // ── stripAdFields ──
  await t.test('stripAdFields — returns false for non-objects', (st) => {
    const { stripAdFields } = createStrippingSandbox();
    assert.strictEqual(stripAdFields(null),      false);
    assert.strictEqual(stripAdFields(undefined), false);
    assert.strictEqual(stripAdFields('string'),  false);
    assert.strictEqual(stripAdFields(42),        false);
  });

  await t.test('stripAdFields — returns false when no ad fields present', (st) => {
    const { stripAdFields } = createStrippingSandbox();
    const obj = { title: 'Clean Video', videoDetails: { lengthSeconds: '300' } };
    const result = stripAdFields(obj);
    assert.strictEqual(result, false);
    assert.deepStrictEqual(Object.keys(obj), ['title', 'videoDetails']);
  });

  await t.test('stripAdFields — removes all known ad fields and returns true', (st) => {
    const { stripAdFields } = createStrippingSandbox();
    const obj = {
      adPlacements: [{}],
      adSlots: [{}],
      playerAds: [{}],
      adBreakParams: {},
      adBreakHeartbeatParams: {},
      adInferredBlockingStatus: {},
      videoDetails: { title: 'Keep me' },
    };
    assert.strictEqual(stripAdFields(obj), true);
    assert.strictEqual('adPlacements'              in obj, false);
    assert.strictEqual('adSlots'                   in obj, false);
    assert.strictEqual('playerAds'                 in obj, false);
    assert.strictEqual('adBreakParams'             in obj, false);
    assert.strictEqual('adBreakHeartbeatParams'    in obj, false);
    assert.strictEqual('adInferredBlockingStatus'  in obj, false);
    assert.deepStrictEqual(obj.videoDetails, { title: 'Keep me' });
  });

  await t.test('stripAdFields — returns true when only some ad fields present', (st) => {
    const { stripAdFields } = createStrippingSandbox();
    const obj = { adPlacements: [{}], title: 'Video' };
    assert.strictEqual(stripAdFields(obj), true);
    assert.strictEqual('adPlacements' in obj, false);
    assert.strictEqual(obj.title, 'Video');
  });

  // ── stripResponseAds ──
  await t.test('stripResponseAds — handles null/undefined without throwing', (st) => {
    const { stripResponseAds } = createStrippingSandbox();
    assert.doesNotThrow(() => stripResponseAds(null));
    assert.doesNotThrow(() => stripResponseAds(undefined));
    assert.doesNotThrow(() => stripResponseAds({}));
  });

  await t.test('stripResponseAds — removes promoted items from search results', (st) => {
    const { stripResponseAds } = createStrippingSandbox();
    const data = {
      contents: {
        twoColumnSearchResultsRenderer: {
          primaryContents: {
            sectionListRenderer: {
              contents: [
                { videoRenderer: { videoId: 'abc' } },
                { promotedSparklesTextSearchRenderer: {} },
                { searchPyvRenderer: {} },
                { adSlotRenderer: {} },
                { videoRenderer: { videoId: 'def' } },
              ]
            }
          }
        }
      }
    };
    stripResponseAds(data);
    const contents = data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents;
    assert.strictEqual(contents.length, 2);
    assert.ok(contents.every(c => c.videoRenderer), 'Only clean video items should remain');
  });

  await t.test('stripResponseAds — removes nested richItemRenderer ad slots from browse', (st) => {
    const { stripResponseAds } = createStrippingSandbox();
    const data = {
      contents: {
        twoColumnBrowseResultsRenderer: {
          tabs: [{
            tabRenderer: {
              content: {
                richGridRenderer: {
                  contents: [
                    { richItemRenderer: { content: { videoRenderer: {} } } },
                    { richItemRenderer: { content: { adSlotRenderer: {} } } },
                    { richItemRenderer: { content: { videoRenderer: {} } } },
                  ]
                }
              }
            }
          }]
        }
      }
    };
    stripResponseAds(data);
    const contents = data.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.richGridRenderer.contents;
    assert.strictEqual(contents.length, 2);
    assert.ok(contents.every(c => c.richItemRenderer.content.videoRenderer), 'Ad slot item should be removed');
  });

  const createShortsAdItem = () => ({
    command: {
      reelWatchEndpoint: {
        videoId: 'ad-short',
        adClientParams: { isAd: true },
      },
    },
    adsOverlay: {
      adSlotMetadata: {},
      fulfillmentContent: {
        fulfilledLayout: {
          sequenceItemInPlayerAdLayoutRenderer: {
            adLayoutMetadata: {},
          },
        },
      },
    },
  });

  const createCleanShortsItem = () => ({
    command: {
      reelWatchEndpoint: {
        videoId: 'clean-short',
      },
    },
  });

  await t.test('stripResponseAds — removes sponsored Shorts overlay items from reel responses', (st) => {
    const { stripResponseAds } = createStrippingSandbox();
    const data = {
      continuationContents: {
        reelWatchSequenceContinuation: {
          contents: [
            createShortsAdItem(),
            createCleanShortsItem(),
          ]
        }
      }
    };

    assert.strictEqual(stripResponseAds(data), true);
    const contents = data.continuationContents.reelWatchSequenceContinuation.contents;
    assert.deepStrictEqual(contents, [createCleanShortsItem()]);
  });

  await t.test('stripResponseAds — strips standalone Shorts adsOverlay payloads', (st) => {
    const { stripResponseAds } = createStrippingSandbox();
    const data = createShortsAdItem();

    assert.strictEqual(stripResponseAds(data), true);
    assert.strictEqual('adsOverlay' in data, false);
    assert.deepStrictEqual(data.command.reelWatchEndpoint, {
      videoId: 'ad-short',
      adClientParams: { isAd: true },
    });
  });

  await t.test('fetch rewrites responses when only Shorts overlay items are stripped', async (st) => {
    const payload = {
      continuationContents: {
        reelWatchSequenceContinuation: {
          contents: [
            createShortsAdItem(),
            createCleanShortsItem(),
          ]
        }
      }
    };
    const sandbox = createStrippingSandbox({}, async () => ({
      clone: () => ({ json: async () => JSON.parse(JSON.stringify(payload)) }),
      status: 200,
      statusText: 'OK',
      headers: {}
    }));

    const response = await sandbox.window.fetch('https://www.youtube.com/youtubei/v1/reel/reel_item_watch?prettyPrint=false');
    const body = JSON.parse(response.body);
    const contents = body.continuationContents.reelWatchSequenceContinuation.contents;

    assert.deepStrictEqual(contents, [createCleanShortsItem()]);
  });

  await t.test('fetch stats are emitted only when a YouTube payload is modified', async (st) => {
    const cleanPayload = { videoDetails: { title: 'Clean Video' } };
    const cleanSandbox = createStrippingSandbox({}, async () => ({
      clone: () => ({ json: async () => JSON.parse(JSON.stringify(cleanPayload)) }),
      status: 200,
      statusText: 'OK',
      headers: {}
    }));
    const cleanEvents = [];
    cleanSandbox.document.addEventListener('__CHROMA_STATS_EVENT__', event => cleanEvents.push(event.detail));

    await cleanSandbox.window.fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false');

    assert.deepStrictEqual(cleanEvents, []);

    const adPayload = { adPlacements: [{}], videoDetails: { title: 'Ad Payload' } };
    const modifiedSandbox = createStrippingSandbox({}, async () => ({
      clone: () => ({ json: async () => JSON.parse(JSON.stringify(adPayload)) }),
      status: 200,
      statusText: 'OK',
      headers: {}
    }));
    const modifiedEvents = [];
    modifiedSandbox.document.addEventListener('__CHROMA_STATS_EVENT__', event => modifiedEvents.push(event.detail));

    await modifiedSandbox.window.fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false');

    assert.strictEqual(modifiedEvents.length, 1);
    assert.strictEqual(modifiedEvents[0], 'youtube_payload_modified');
  });

  await t.test('JSON.parse payload prefilter recognizes ad signals cheaply', (st) => {
    const sandbox = createStrippingSandbox({ stripping: true });

    assert.strictEqual(
      sandbox.mightContainYoutubeAdPayloadSignal(JSON.stringify({ videoDetails: { title: 'Clean Video' } })),
      false
    );
    assert.strictEqual(
      sandbox.mightContainYoutubeAdPayloadSignal(JSON.stringify({ playerResponse: { adPlacements: [{}] } })),
      true
    );
    assert.strictEqual(
      sandbox.mightContainYoutubeAdPayloadSignal(JSON.stringify({ contents: [{ adSlotRenderer: {} }] })),
      true
    );
  });

  await t.test('SABR parses framed policy fields without touching media or opaque bytes', () => {
    const { patchSabrBackoff } = createStrippingSandbox();
    // UMP part 35, 9-byte policy: backoff=12000, then a cookie containing
    // another apparent field-4 tag. Only the actual policy field may change.
    const original = Uint8Array.from([35, 9, 32, 224, 93, 58, 4, 32, 136, 39, 0]);
    const before = original.slice();
    assert.deepStrictEqual(patchSabrBackoff(original), Uint8Array.from([35, 9, 32, 228, 0, 58, 4, 32, 136, 39, 0]));
    assert.deepStrictEqual(original, before, 'input bytes remain intact');
    const otherPart = [57, 3, 32, 224, 93];
    assert.deepStrictEqual(patchSabrBackoff(Uint8Array.from([...otherPart, ...original])).slice(0, 5), Uint8Array.from(otherPart));
    // 137-byte payload uses UMP's 2-byte integer, not protobuf's varint.
    const longPolicy = Uint8Array.from([35, 137, 2, 32, 224, 93, 58, 131, 1, ...Array(131).fill(0)]);
    const patched = patchSabrBackoff(longPolicy);
    assert.ok(patched);
    assert.strictEqual(patched.length, longPolicy.length);
    assert.deepStrictEqual(patched.slice(3, 6), Uint8Array.from([32, 228, 0]));
    for (const bytes of [
      [], [35], [35, 9, 32, 224, 93], [35, 3, 0, 224, 93],
      [35, 2, 32, 128], [35, 2, 32, 100], [35, 3, 40, 224, 93],
      [35, 3, 34, 10, 0], [35, 1, 39], [35, 3, 32, 224, 93, 240],
      [21, 3, 32, 224, 93, ...original], [...original, 20, 0],
      [47, 3, 32, 224, 93], Array(1000).fill(0)
    ]) assert.strictEqual(patchSabrBackoff(Uint8Array.from(bytes)), null, `unchanged malformed/non-policy input ${bytes.slice(0, 15)}`);
  });

  const sabrUrl = 'https://rr1.googlevideo.com/videoplayback?sabr=1&rn=1';
  const backoffBytes = Uint8Array.from([35, 3, 32, 224, 93]);
  const createSabrSandbox = (options = {}) => {
    const calls = [], timers = [], requests = [];
    const video = { readyState: 0, currentTime: 0, buffered: { length: 0 } };
    const response = {
      videoDetails: { videoId: '5URefVYaJrA' }, playabilityStatus: { status: 'OK' },
      playerConfig: { playbackStartConfig: { startSeconds: options.startSeconds || 0 } }
    };
    const videoData = {};
    let playlistId = options.playlist ? 'RD5URefVYaJrA' : null;
    const playlistData = { playlistId, currentIndex: 4, contents: [{ videoId: '5URefVYaJrA' }] };
    const manager = {
      getPlaylistData: () => playlistData,
      setPlaylistData: data => { calls.push(['playlist', data]); playlistId = data.playlistId; },
      setPlayerPlaybackControlData: data => calls.push(['playlist-control', data])
    };
    const player = {
      querySelector: () => video,
      classList: { contains: () => false },
      getPlayerState: () => 3,
      getPlayerResponse: () => response,
      getVideoData: () => videoData,
      getPlaylistId: () => playlistId,
      cancelPlayback: () => calls.push(['cancel']),
      loadVideoById: (...args) => { calls.push(['load', ...args]); playlistId = null; }
    };
    let original;
    const sandbox = createStrippingSandbox(options.config || {}, async (...args) => {
      requests.push(args);
      original = options.fetch ? await options.fetch(...args) : new Response(backoffBytes, { headers: { 'content-type': 'application/vnd.yt-ump' } });
      return original;
    }, options.hostname || 'www.youtube.com', s => {
      s.Response = Response;
      s.Request = Request;
      s.Headers = Headers;
      s.DecompressionStream = DecompressionStream;
      s.CompressionStream = CompressionStream;
      s.TextDecoder = TextDecoder;
      s.XMLHttpRequest.prototype.send = function(body) { this.sentBody = body; };
      s.window.location.href = `https://${options.hostname || 'www.youtube.com'}/watch?v=5URefVYaJrA${options.playlist ? '&list=RD5URefVYaJrA&start_radio=1' : ''}`;
      s.window.setTimeout = (fn, ms) => { const timer = { fn, ms, cancelled: false }; timers.push(timer); return timer; };
      s.window.clearTimeout = timer => { timer.cancelled = true; };
      s.document.querySelector = selector => selector === '#movie_player' ? player : selector === 'yt-playlist-manager' ? manager : null;
    });
    return { sandbox, video, player, response, videoData, calls, requests, timers, manager, playlistData,
      original: () => original,
      runRetry: () => timers.filter(t => t.ms === 1000 && !t.cancelled).splice(0).forEach(t => { t.cancelled = true; t.fn(); }) };
  };

  await t.test('SABR startup patches at most two responses and retries one fresh session', async () => {
    const h = createSabrSandbox({ startSeconds: 42 });
    h.video.currentTime = 42; // Pre-start seek at HAVE_NOTHING is not playback.
    const first = await h.sandbox.window.fetch(sabrUrl);
    assert.deepStrictEqual(new Uint8Array(await first.arrayBuffer()), Uint8Array.from([35, 3, 32, 228, 0]));
    assert.strictEqual(first.headers.get('content-type'), 'application/vnd.yt-ump');
    assert.strictEqual(first.url, h.original().url);
    h.runRetry();
    assert.deepStrictEqual(h.calls, [['cancel'], ['load', '5URefVYaJrA', 42]]);
    assert.strictEqual(h.videoData.isInlinePlaybackNoAd, true);
    await h.sandbox.window.fetch(sabrUrl);
    h.runRetry();
    const third = await h.sandbox.window.fetch(sabrUrl);
    assert.strictEqual(third, h.original(), 'budget exhausted: original response returned');
    assert.strictEqual(h.calls.filter(c => c[0] === 'load').length, 1);
  });

  await t.test('SABR intercepts a cued first request before the reported 16-second backoff', async () => {
    // Synthetic envelope matching the report's 104 bytes and part IDs, with
    // inert context payloads instead of the user's private context/cookie data.
    const control = Uint8Array.from([57, 91, ...Array(91).fill(0), 67, 4, 0, 0, 0, 0, 35, 3, 32, 128, 125]);
    assert.strictEqual(control.length, 104);
    for (const responseState of [5, 3]) {
      const h = createSabrSandbox({ playlist: true, fetch: () => {
        h.player.getPlayerState = () => responseState;
        return new Response(control);
      } });
      h.player.getPlayerState = () => 5;
      const response = await h.sandbox.window.fetch(sabrUrl);
      const patched = new Uint8Array(await response.arrayBuffer());
      assert.deepStrictEqual(patched, Uint8Array.from([...control.slice(0, -2), 228, 0]),
        'first response must be intercepted even when request starts in state 5');
      h.runRetry();
      assert.strictEqual(h.calls.filter(c => c[0] === 'load').length, 1);
      assert.strictEqual(h.videoData.isInlinePlaybackNoAd, true);
      assert.deepStrictEqual(h.calls.find(c => c[0] === 'playlist')[1], h.playlistData);
    }
  });

  await t.test('SABR retry preserves radio context and adds no-ad flag only to its own player request', async () => {
    const h = createSabrSandbox({ playlist: true });
    await h.sandbox.window.fetch(sabrUrl);
    h.runRetry();
    assert.deepStrictEqual(h.calls.map(c => c[0]), ['cancel', 'load', 'playlist', 'playlist-control']);
    assert.deepStrictEqual(h.calls[2][1], h.playlistData);
    assert.notStrictEqual(h.calls[2][1], h.playlistData, 'snapshot survives player-owned data mutation');
    assert.deepStrictEqual(h.calls[3][1].playlistPanelRenderer, h.playlistData);
    const body = JSON.stringify({ videoId: '5URefVYaJrA', playbackContext: { contentPlaybackContext: { signatureTimestamp: 123 } } });
    const init = { method: 'POST', body };
    await h.sandbox.window.fetch('/youtubei/v1/player', init);
    const sent = JSON.parse(h.requests.at(-1)[1].body);
    assert.strictEqual(sent.playbackContext.contentPlaybackContext.isInlinePlaybackNoAd, true);
    assert.strictEqual(sent.playbackContext.contentPlaybackContext.signatureTimestamp, 123);
    assert.strictEqual(init.body, body, 'caller-owned options not mutated');
    await h.sandbox.window.fetch('/youtubei/v1/next', init);
    assert.strictEqual(h.requests.at(-1)[1].body, body);
    await h.sandbox.window.fetch('https://example.com/youtubei/v1/player', init);
    assert.strictEqual(h.requests.at(-1)[1].body, body);
    const different = { ...init, body: body.replace('5URefVYaJrA', 'anotherVideo') };
    await h.sandbox.window.fetch('/youtubei/v1/player', different);
    assert.strictEqual(h.requests.at(-1)[1].body, different.body);
    const xhr = new h.sandbox.XMLHttpRequest();
    xhr.open('POST', '/youtubei/v1/player');
    xhr.send(body);
    assert.strictEqual(JSON.parse(xhr.sentBody).playbackContext.contentPlaybackContext.isInlinePlaybackNoAd, true);
    const request = new Request('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST', body, credentials: 'include', headers: { 'content-type': 'application/json' }
    });
    await h.sandbox.window.fetch(request);
    const forwarded = h.requests.at(-1)[0];
    assert.strictEqual(forwarded.credentials, 'include');
    assert.strictEqual(forwarded.headers.get('content-type'), 'application/json');
    assert.strictEqual(JSON.parse(await forwarded.text()).playbackContext.contentPlaybackContext.isInlinePlaybackNoAd, true);
    assert.strictEqual(await request.text(), body, 'original Request body remains readable');
  });

  await t.test('SABR retry adds the hint to gzip WEB requests while preserving their encoding and caller bodies', async () => {
    const { gzipSync, gunzipSync } = require('node:zlib');
    const h = createSabrSandbox();
    const url = 'https://www.youtube.com/youtubei/v1/player';
    const data = { videoId: '5URefVYaJrA', context: { client: { clientName: 'WEB' } }, playbackContext: { contentPlaybackContext: { signatureTimestamp: 123 } } };
    const body = gzipSync(JSON.stringify(data));
    const saved = Buffer.from(body);
    const headers = { 'content-type': 'application/json', 'content-encoding': 'gzip' };
    const init = { method: 'POST', headers, body };
    await h.sandbox.window.fetch(url, init);
    assert.strictEqual(h.requests.at(-1)[1], init, 'ordinary requests are untouched');
    await h.sandbox.window.fetch(sabrUrl);
    h.runRetry();
    for (const payload of [body, new Blob([body]), body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)]) {
      await h.sandbox.window.fetch(url, { ...init, body: payload });
      const forwarded = h.requests.at(-1)[1];
      const sent = JSON.parse(gunzipSync(forwarded.body));
      assert.deepStrictEqual(sent, { ...data, params: 'eAFgAQ', playbackContext: { contentPlaybackContext: { signatureTimestamp: 123, isInlinePlaybackNoAd: true } } });
      assert.strictEqual(forwarded.headers, headers);
    }
    assert.deepStrictEqual(body, saved);
    const request = new Request(url, { ...init, credentials: 'include' });
    await h.sandbox.window.fetch(request);
    const forwarded = h.requests.at(-1)[0];
    assert.strictEqual(forwarded.credentials, 'include');
    assert.strictEqual(forwarded.headers.get('content-encoding'), 'gzip');
    const requestData = JSON.parse(gunzipSync(Buffer.from(await forwarded.arrayBuffer())));
    assert.strictEqual(requestData.playbackContext.contentPlaybackContext.isInlinePlaybackNoAd, true);
    assert.strictEqual(requestData.params, 'eAFgAQ');
    assert.deepStrictEqual(Buffer.from(await request.arrayBuffer()), saved);
  });

  await t.test('SABR experimental params affect only the matching WEB retry request', async () => {
    const h = createSabrSandbox();
    const url = 'https://www.youtube.com/youtubei/v1/player';
    const payload = { videoId: '5URefVYaJrA', context: { client: { clientName: 'WEB' } }, params: 'original', playbackContext: { contentPlaybackContext: { signatureTimestamp: 123 } } };
    const init = { method: 'POST', body: JSON.stringify(payload) };
    await h.sandbox.window.fetch(url, init);
    assert.strictEqual(h.requests.at(-1)[1], init);
    await h.sandbox.window.fetch(sabrUrl);
    h.runRetry();
    await h.sandbox.window.fetch(url, init);
    assert.strictEqual(JSON.parse(h.requests.at(-1)[1].body).params, 'eAFgAQ');
    assert.strictEqual(JSON.parse(init.body).params, 'original', 'caller data is unchanged');
    for (const clientName of ['WEB_REMIX', 'MWEB', 'TVHTML5', undefined]) {
      const body = JSON.stringify({ ...payload, context: { client: { clientName } } });
      await h.sandbox.window.fetch(url, { ...init, body });
      assert.strictEqual(JSON.parse(h.requests.at(-1)[1].body).params, 'original');
    }
    const different = { ...init, body: JSON.stringify({ ...payload, videoId: 'different' }) };
    await h.sandbox.window.fetch(url, different);
    assert.strictEqual(h.requests.at(-1)[1], different);
    await h.sandbox.window.fetch(url.replace('/player', '/next'), init);
    assert.strictEqual(h.requests.at(-1)[1], init);
    h.sandbox.document.dispatchEvent({ type: 'yt-navigate-start' });
    await h.sandbox.window.fetch(url, init);
    assert.strictEqual(h.requests.at(-1)[1], init);
  });

  await t.test('SABR gzip rewriting fails open on invalid, oversized, unrelated and unavailable compression', async () => {
    const { gzipSync } = require('node:zlib');
    const h = createSabrSandbox();
    await h.sandbox.window.fetch(sabrUrl);
    h.runRetry();
    const headers = { 'content-encoding': 'gzip' };
    const valid = gzipSync(JSON.stringify({ videoId: '5URefVYaJrA', playbackContext: { contentPlaybackContext: {} } }));
    const url = 'https://www.youtube.com/youtubei/v1/player';
    for (const [target, body] of [
      [url, Uint8Array.from([31, 139, 8, 0])],
      [url, gzipSync('invalid JSON')],
      [url, gzipSync('x'.repeat(1000001))],
      [url, new Uint8Array(1000001)],
      [url, gzipSync('{"videoId":"different","playbackContext":{"contentPlaybackContext":{}}}')],
      ['https://example.com/youtubei/v1/player', valid],
      ['https://www.youtube.com/youtubei/v1/next', valid],
      [url, new Response(valid).body]
    ]) {
      const init = { method: 'POST', headers, body };
      await h.sandbox.window.fetch(target, init);
      assert.strictEqual(h.requests.at(-1)[1], init);
      if (body.getReader) assert.strictEqual(body.locked, false, 'caller-owned streams are never consumed');
    }
    h.sandbox.DecompressionStream = undefined;
    const init = { method: 'POST', headers, body: valid };
    await h.sandbox.window.fetch(url, init);
    assert.strictEqual(h.requests.at(-1)[1], init);
  });

  await t.test('SABR gzip preparation stops at its deadline or a navigation change', async () => {
    const { gzipSync } = require('node:zlib');
    const init = { method: 'POST', headers: { 'content-encoding': 'gzip' }, body: gzipSync(JSON.stringify({ videoId: '5URefVYaJrA', playbackContext: { contentPlaybackContext: {} } })) };
    for (const reason of ['timeout', 'navigation']) {
      const h = createSabrSandbox();
      await h.sandbox.window.fetch(sabrUrl);
      h.runRetry();
      if (reason === 'timeout') h.sandbox.DecompressionStream = class {
        constructor() { return new TransformStream({ transform() { return new Promise(() => {}); } }); }
      };
      const pending = h.sandbox.window.fetch('https://www.youtube.com/youtubei/v1/player', init);
      if (reason === 'timeout') h.timers.find(timer => timer.ms === 200 && !timer.cancelled).fn();
      else h.sandbox.document.dispatchEvent({ type: 'yt-navigate-start' });
      await pending;
      assert.strictEqual(h.requests.at(-1)[1], init, reason);
    }
  });

  await t.test('SABR skips session reload if radio context cannot be preserved', async () => {
    const h = createSabrSandbox({ playlist: true });
    h.manager.getPlaylistData = () => null;
    await h.sandbox.window.fetch(sabrUrl);
    h.runRetry();
    assert.deepStrictEqual(h.calls, []);
  });

  await t.test('SABR leaves ordinary playback, ads, excluded clients and malformed bodies alone', async () => {
    const cases = [
      h => { h.sandbox.CONFIG.enabled = false; },
      h => { h.sandbox.CONFIG.stripping = false; },
      h => { h.video.currentTime = 10; },
      h => { h.video.readyState = 3; },
      h => { h.video.buffered.length = 1; },
      h => { h.player.getPlayerState = () => 2; },
      h => { h.player.classList.contains = () => true; },
      h => { h.response.videoDetails.isLive = true; },
      h => { h.response.videoDetails.isLiveContent = true; },
      h => { h.response.videoDetails.videoId = 'differentVideo'; },
      h => { h.response.playabilityStatus.status = 'UNPLAYABLE'; },
      h => { h.sandbox.window.location.href = 'https://music.youtube.com/watch?v=5URefVYaJrA'; },
      h => { h.sandbox.window.location.href = 'https://www.youtube.com/shorts/5URefVYaJrA'; },
      h => { h.sandbox.window.ytInitialData = { topbar: { desktopTopbarRenderer: { logo: { topbarLogoRenderer: { iconImage: { iconType: 'YOUTUBE_PREMIUM_LOGO' } } } } } }; }
    ];
    for (const change of cases) {
      const h = createSabrSandbox();
      change(h);
      assert.strictEqual(await h.sandbox.window.fetch(sabrUrl), h.original());
      h.runRetry();
      assert.deepStrictEqual(h.calls, []);
    }
    for (const bytes of [Uint8Array.from([35, 99, 32, 224, 93]), Uint8Array.from([21, 3, 32, 224, 93]), new Uint8Array(2000)]) {
      const h = createSabrSandbox({ fetch: () => new Response(bytes) });
      const result = await h.sandbox.window.fetch(sabrUrl);
      assert.strictEqual(result, h.original());
      assert.deepStrictEqual(new Uint8Array(await result.arrayBuffer()), bytes);
      h.runRetry();
      assert.deepStrictEqual(h.calls, []);
    }
    for (const url of [sabrUrl.replace('sabr=1', 'sabr=0'), sabrUrl.replace('rr1.googlevideo.com', 'googlevideo.com.evil.test'), sabrUrl.replace('/videoplayback', '/other')]) {
      const h = createSabrSandbox();
      assert.strictEqual(await h.sandbox.window.fetch(url), h.original());
    }
  });

  await t.test('SABR cancels stale retry after navigation, config change, or first playback', async () => {
    for (const change of [
      h => h.sandbox.document.dispatchEvent({ type: 'yt-navigate-start' }),
      h => { h.sandbox.CONFIG.enabled = false; },
      h => { h.sandbox.CONFIG.stripping = false; },
      h => h.sandbox.document.dispatchEvent({ type: 'playing', target: h.video }),
      h => { h.video.readyState = 2; }
    ]) {
      const h = createSabrSandbox();
      await h.sandbox.window.fetch(sabrUrl);
      change(h);
      h.runRetry();
      assert.deepStrictEqual(h.calls, []);
    }
  });

  await t.test('SABR times out an incomplete control response and passes its stream through', async () => {
    let source;
    const stream = new ReadableStream({ start(controller) { source = controller; controller.enqueue(Uint8Array.from([35])); } });
    const h = createSabrSandbox({ fetch: () => new Response(stream) });
    const pending = h.sandbox.window.fetch(sabrUrl);
    await new Promise(resolve => setImmediate(resolve));
    h.timers.find(t => t.ms === 100).fn();
    const result = await pending;
    assert.strictEqual(result, h.original());
    source.enqueue(Uint8Array.from([3, 32, 224, 93]));
    source.close();
    assert.deepStrictEqual(new Uint8Array(await result.arrayBuffer()), backoffBytes);
    assert.deepStrictEqual(h.calls, []);
  });

  // ── shouldAccelerate ──
  await t.test('shouldAccelerate — false when acceleration is off', (st) => {
    const sandbox = createStrippingSandbox({ acceleration: false, stripping: false });
    assert.strictEqual(sandbox.shouldAccelerate(), false);
  });

  await t.test('shouldAccelerate — true when acceleration on and stripping off', (st) => {
    const sandbox = createStrippingSandbox({ acceleration: true, stripping: false });
    assert.strictEqual(sandbox.shouldAccelerate(), true);
  });

  await t.test('shouldAccelerate — true when both acceleration and stripping are on', (st) => {
    const sandbox = createStrippingSandbox({ acceleration: true, stripping: true });
    assert.strictEqual(sandbox.shouldAccelerate(), true);
  });

  await t.test('shouldAccelerate — false when stripping on and acceleration off', (st) => {
    const sandbox = createStrippingSandbox({ acceleration: false, stripping: true });
    assert.strictEqual(sandbox.shouldAccelerate(), false);
  });

  // ── JSON.parse interceptor respects stripping flag ──
  await t.test('JSON.parse strips ad fields when stripping is enabled', (st) => {
    const sandbox = createStrippingSandbox({ stripping: true });
    const input = JSON.stringify({ adPlacements: [{}], videoDetails: { title: 'Test' } });
    const result = sandbox.JSON.parse(input);
    assert.strictEqual('adPlacements' in result, false, 'adPlacements should be stripped');
    assert.ok(result.videoDetails, 'non-ad fields should be preserved');
  });

  await t.test('JSON.parse passes through when stripping is disabled', (st) => {
    const sandbox = createStrippingSandbox({ stripping: false });
    const input = JSON.stringify({ adPlacements: [{}], videoDetails: { title: 'Test' } });
    const result = sandbox.JSON.parse(input);
    assert.ok('adPlacements' in result, 'adPlacements should not be stripped when stripping is off');
  });

  await t.test('JSON.parse strips nested playerResponse ad fields', (st) => {
    const sandbox = createStrippingSandbox({ stripping: true });
    const input = JSON.stringify({
      playerResponse: { adPlacements: [{}], playerAds: [{}], streamingData: {} },
      videoId: 'abc'
    });
    const result = sandbox.JSON.parse(input);
    assert.strictEqual('adPlacements' in result.playerResponse, false);
    assert.strictEqual('playerAds'    in result.playerResponse, false);
    assert.ok(result.playerResponse.streamingData, 'non-ad fields inside playerResponse preserved');
  });

  await t.test('non-YouTube host exits before installing broad page hooks', (st) => {
    const sandbox = createStrippingSandbox({ stripping: true }, undefined, 'example.com');
    const result = sandbox.JSON.parse(JSON.stringify({ adPlacements: [{}], videoDetails: { title: 'Test' } }));

    assert.strictEqual(sandbox.JSON.parse, sandbox._nativeJSONParse);
    assert.strictEqual(sandbox.window.fetch, sandbox._nativeFetch);
    assert.ok('adPlacements' in result, 'non-YouTube pages should not get YouTube payload pruning');
    assert.strictEqual(sandbox.CONFIG, undefined, 'test-only exports should not be installed after scope guard exit');
  });
});

// ─── YOUTUBE AD ACCELERATION ─────
test('YouTube ad acceleration', async (t) => {
  const createSandbox = (setupDoc, configOverrides = {}, setupSandbox = null) => {
    const sandbox = {
      chrome: {
        runtime: {
          sendMessage: () => Promise.resolve(),
          onMessage: { addListener: () => {} }
        },
        storage: {
          local: {
            get: () => Promise.resolve({}),
            set: () => Promise.resolve()
          }
        }
      },
      notifyBackground: () => Promise.resolve({ ok: true }),
      MSG: {
        CONFIG_GET: 'CONFIG_GET',
        CONFIG_SET: 'CONFIG_SET',
        CONFIG_UPDATE: 'CONFIG_UPDATE',
        STATS_RESET: 'STATS_RESET'
      },
      document: {
        readyState: 'complete',
        createElement: (tag) => createMockElement(tag),
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        head: createMockElement('head'),
        body: createMockElement('body'),
        documentElement: createMockElement('html'),
        _listeners: {},
        addEventListener: function(evt, cb) {
          if (!this._listeners[evt]) this._listeners[evt] = [];
          this._listeners[evt].push(cb);
        },
        removeEventListener: () => {},
        dispatchEvent: function(e) {
          if (this._listeners[e.type]) this._listeners[e.type].forEach(cb => cb(e));
        },
        getElementsByClassName: () => []
      },
      setInterval: () => {},
      clearInterval: () => {},
      setTimeout: (fn) => fn(),
      requestAnimationFrame: () => {},
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      console: console,
      Object: Object,
      Array: Array,
      Number: Number,
      String: String,
      Boolean: Boolean,
      Math: Math,
      Date: Date,
      Promise: Promise,
      Error: Error,
      window: { 
        location: { hostname: 'www.youtube.com' },
        addEventListener: function() {},
        removeEventListener: function() {},
        requestAnimationFrame: (cb) => cb(),
        // Visibility Calculation Dimensions: Standard 1080p targets.
        innerHeight: 1000,
        innerWidth: 1000,
        setTimeout: function(fn, t) { return setTimeout(fn, t); },
        setInterval: function(fn, t) { return setInterval(fn, t); },
        clearInterval: function(i) { return clearInterval(i); },
        MutationObserver: class {
          observe() {}
          disconnect() {}
        }
      },
      location: { hostname: 'www.youtube.com' },
      XMLHttpRequest: class {
        open() {}
        send() {}
      },
      __CHROMA_INTERNAL_TEST_STRICT__: true,
    };

    sandbox.globalThis = sandbox;

    // Mock browser-native CSSStyleSheet API for adoptedStyleSheets-based session management
    sandbox.CSSStyleSheet = class {
      constructor() { this._css = ''; }
      replaceSync(css) { this._css = css; }
    };
    sandbox.document.adoptedStyleSheets = [];
    if (setupDoc) setupDoc(sandbox.document);

    // VULN-03 Hardening: Sandbox bridge mocking.
    sandbox.window.__CHROMA_INTERNAL__ = {
      api: {
        querySelector: (s) => sandbox.document.querySelector(s),
        getElementById: (id) => sandbox.document.getElementById(id),
        createElement: (t) => sandbox.document.createElement(t),
        addEventListener: (e, f, o) => sandbox.window.addEventListener(e, f, o),
        removeEventListener: (e, f, o) => sandbox.window.removeEventListener(e, f, o),
        setTimeout: (f, t) => sandbox.setTimeout(f, t),
        setInterval: (f, t) => sandbox.setInterval(f, t),
        clearInterval: (i) => sandbox.clearInterval(i),
        dispatchEvent: (e) => sandbox.document.dispatchEvent(e),
        addDocEventListener: (e, f, o) => sandbox.document.addEventListener(e, f),
        removeDocEventListener: (e, f, o) => sandbox.document.removeEventListener(e, f),
        MutationObserver: sandbox.window.MutationObserver
      },
      config: { enabled: true, acceleration: true, accelerationSpeed: 8, ...configOverrides }
    };

    if (setupSandbox) setupSandbox(sandbox);

    vm.createContext(sandbox);
    vm.runInContext(youtubeJsCode, sandbox);
    return sandbox;
  };

  await t.test('initAdOverlay functionality', async (st) => {
    let createdElements = [];
    const sandbox = createSandbox((doc) => {
      const origCreate = doc.createElement;
      doc.createElement = (tag) => {
        const el = origCreate(tag);
        createdElements.push(el);
        return el;
      };
    });

    sandbox.initAdOverlay();
    
    // DOM Detection: Validating host creation with shadow root.
    const host = createdElements.find(el => el.tagName === 'DIV' && el.shadowRoot);
    assert.ok(host, 'adOverlayHost should be created with a shadow root');
    assert.strictEqual(host.shadowRoot.mode, 'closed');
    
    // Check elements inside shadow root
    const shadowChildren = host.shadowRoot.childrenArray;
    assert.ok(shadowChildren.find(el => el.tagName === 'STYLE'), 'Should have style in shadow root');
    
    const screen = shadowChildren.find(el => el.className === 'chroma-screen');
    assert.ok(screen, 'Should have chroma-screen wrapper');
    
    const screenChildren = screen.childrenArray;
    assert.ok(screenChildren.find(el => el.className === 'chroma-spinner'), 'Should have spinner in screen');
    assert.ok(screenChildren.find(el => el.className === 'chroma-title'), 'Should have title in screen');
    assert.ok(screenChildren.find(el => el.className === 'chroma-subtitle'), 'Should have subtitle in screen');
    assert.ok(screenChildren.find(el => el.className === 'chroma-progress-container'), 'Should have progress container in screen');
  });

  await t.test('handleAdAcceleration trigger', async (st) => {
    const mockVideo = createMockElement('video');
    const sandbox = createSandbox((doc) => {
      doc.querySelector = (sel) => {
        if (sel.includes('.ad-showing')) return createMockElement('div');
        if (sel.includes('video')) return mockVideo;
        return null;
      };
      doc.getElementsByClassName = (cls) => {
        if (cls === 'ad-showing') return [createMockElement()];
        return [];
      }
    });

    sandbox.handleAdAcceleration();
    assert.strictEqual(sandbox.__CHROMA_STATE_BRIDGE__.chromaAdSessionActive, true);
    // Acceleration Speed Cap: Maximum browser playback rate.
    assert.strictEqual(mockVideo.playbackRate, 8);
    assert.strictEqual(mockVideo.muted, true);
  });

  await t.test('accepts the same positive fractional speed as background config validation', () => {
    const mockVideo = createMockElement('video');
    const sandbox = createSandbox((doc) => {
      doc.querySelector = (sel) => sel.includes('video') ? mockVideo : null;
      doc.getElementsByClassName = (cls) => cls === 'ad-showing' ? [createMockElement()] : [];
    }, { accelerationSpeed: 0.5 });

    sandbox.handleAdAcceleration();
    assert.strictEqual(mockVideo.playbackRate, 0.5);
  });

  await t.test('disabling acceleration restores Chroma-owned video state only', () => {
    const mockVideo = createMockElement('video');
    const sandbox = createSandbox((doc) => {
      doc.querySelector = (sel) => sel.includes('video') ? mockVideo : null;
      doc.getElementsByClassName = (cls) => cls === 'ad-showing' ? [createMockElement()] : [];
    });

    sandbox.handleAdAcceleration();
    assert.strictEqual(mockVideo.playbackRate, 8);
    assert.strictEqual(mockVideo.muted, true);

    sandbox.window.__CHROMA_INTERNAL__.config = {
      enabled: true,
      stripping: true,
      acceleration: false,
      accelerationSpeed: 8
    };
    sandbox.window.__CHROMA_INTERNAL__.revision = 1;
    sandbox.document.dispatchEvent({ type: '__CHROMA_CONFIG_UPDATE__' });
    assert.strictEqual(mockVideo.playbackRate, 1);
    assert.strictEqual(mockVideo.muted, false);

    sandbox.window.__CHROMA_INTERNAL__.config.acceleration = true;
    sandbox.window.__CHROMA_INTERNAL__.revision = 2;
    sandbox.document.dispatchEvent({ type: '__CHROMA_CONFIG_UPDATE__' });
    sandbox.handleAdAcceleration();
    mockVideo.playbackRate = 2;

    sandbox.window.__CHROMA_INTERNAL__.config.acceleration = false;
    sandbox.window.__CHROMA_INTERNAL__.revision = 3;
    sandbox.document.dispatchEvent({ type: '__CHROMA_CONFIG_UPDATE__' });
    assert.strictEqual(mockVideo.playbackRate, 2, 'cleanup must preserve a later page-owned rate');
  });

  await t.test('unmute when main content starts during debounce', async (st) => {
    const mockVideo = createMockElement('video');
    mockVideo.readyState = 4;
    mockVideo.paused = false;
    mockVideo.currentTime = 1;
    
    const sandbox = createSandbox((doc) => {
      doc.querySelector = (sel) => {
        if (sel.includes('.ad-showing')) return null;
        if (sel.includes('.video-ads')) return null;
        if (sel.includes('.ytp-ad-module')) return null;
        if (sel.includes('.ytp-ad-simple-ad-badge')) return null;
        
        if (sel.includes('#movie_player') || sel.includes('.html5-main-video') || sel === 'video') return mockVideo;
        return null;
      };
      doc.getElementsByClassName = (cls) => {
        if (cls === 'ad-showing') return [];
        return [];
      }
    });


    // Prime the session by running an ad-active cycle first (sets WeakMap state internally)
    const adMock = createMockElement('div');
    sandbox.document.querySelector = (sel) => {
      if (sel.includes('.ad-showing')) return adMock;
      if (sel.includes('video')) return mockVideo;
      return null;
    };
    sandbox.handleAdAcceleration();
    assert.strictEqual(sandbox.__CHROMA_STATE_BRIDGE__.chromaAdSessionActive, true, 'Session should be active after ad detection');
    assert.strictEqual(mockVideo.muted, true, 'Video should be muted during ad');

    // Now switch to no-ad state with main video ready
    sandbox.document.querySelector = (sel) => {
      if (sel.includes('.ad-showing')) return null;
      if (sel.includes('.video-ads')) return null;
      if (sel.includes('.ytp-ad-module')) return null;
      if (sel.includes('.ytp-ad-simple-ad-badge')) return null;
      if (sel.includes('#movie_player') || sel.includes('.html5-main-video') || sel === 'video') return mockVideo;
      return null;
    };

    // Debounce Override: Immediate unmute on main content detection.
    sandbox.handleAdAcceleration();
    
    assert.strictEqual(sandbox.__CHROMA_STATE_BRIDGE__.chromaAdSessionActive, false, 'Session should be deactivated when main content is ready');
    assert.strictEqual(mockVideo.muted, false, 'Video should be unmuted');
  });

  await t.test('YouTube navigation does not start polling when acceleration is off', async () => {
    const sandbox = createSandbox(null, { acceleration: false });
    let intervalsStarted = 0;
    sandbox.setInterval = () => {
      intervalsStarted++;
      return intervalsStarted;
    };

    sandbox.document.dispatchEvent({ type: 'yt-navigate-finish' });
    sandbox.document.dispatchEvent({ type: 'yt-page-data-updated' });

    assert.strictEqual(intervalsStarted, 0, 'Navigation should not start the accelerator timer while acceleration is disabled');
  });

  await t.test('initial load does not start handshake polling when acceleration is already known off', async () => {
    let intervalsStarted = 0;
    createSandbox(null, { acceleration: false }, (sandbox) => {
      sandbox.setInterval = () => {
        intervalsStarted++;
        return intervalsStarted;
      };
    });

    assert.strictEqual(intervalsStarted, 0, 'Known disabled acceleration should not start any accelerator initialization interval');
  });

  await t.test('late bridge upgrades future DOM queries to pristine API', async () => {
    let bridgeQueries = 0;
    const sandbox = createSandbox(null, { acceleration: false }, (sandbox) => {
      delete sandbox.window.__CHROMA_INTERNAL__;
    });

    sandbox.window.__CHROMA_INTERNAL__ = {
      api: {
        querySelector: () => { bridgeQueries++; return null; },
        querySelectorAll: () => [],
        getElementsByClassName: () => [],
        createElement: (tag) => sandbox.document.createElement(tag),
        setInterval: (fn, delay) => sandbox.setInterval(fn, delay),
        clearInterval: (id) => sandbox.clearInterval(id),
        requestAnimationFrame: (fn) => sandbox.requestAnimationFrame(fn),
        addDocEventListener: (evt, cb, opts) => sandbox.document.addEventListener(evt, cb, opts),
        createCssStyleSheet: () => new sandbox.CSSStyleSheet(),
        getAdoptedStyleSheets: () => sandbox.document.adoptedStyleSheets,
        setAdoptedStyleSheets: (sheets) => { sandbox.document.adoptedStyleSheets = sheets; }
      },
      config: { enabled: true, acceleration: true, stripping: true, accelerationSpeed: 8 }
    };
    sandbox.CONFIG.enabled = true;
    sandbox.CONFIG.acceleration = true;

    sandbox.handleAdAcceleration();

    assert.ok(bridgeQueries > 0, 'handler should resolve the bridge after load, not stay pinned to fallback APIs');
  });

  await t.test('Secure Bridge Initialization Flow', async (st) => {
    await st.test('starts inert and ignores forged public config/init details', async () => {
      const sandbox = createSandbox(null, {}, (candidate) => {
        candidate.window.__CHROMA_INTERNAL__.config = null;
        candidate.setInterval = () => 1;
      });

      assert.strictEqual(sandbox.CONFIG.enabled, false);
      assert.strictEqual(sandbox.CONFIG.stripping, false);
      sandbox.document.dispatchEvent({
        type: '__EXT_INIT__',
        detail: { active: true, stripping: true, acceleration: true }
      });
      sandbox.document.dispatchEvent({
        type: '__CHROMA_CONFIG_UPDATE__',
        detail: { enabled: true, stripping: true, acceleration: true }
      });

      assert.strictEqual(sandbox.CONFIG.enabled, false);
      assert.strictEqual(sandbox.CONFIG.stripping, false);
      assert.strictEqual(sandbox.CONFIG.acceleration, false);
    });

    await st.test('a protected bridge snapshot activates on a detail-free notification', async () => {
      const sandbox = createSandbox(null, {}, (candidate) => {
        candidate.window.__CHROMA_INTERNAL__.config = null;
        candidate.setInterval = () => 1;
      });
      sandbox.window.__CHROMA_INTERNAL__.config = {
        enabled: true,
        stripping: false,
        acceleration: true,
        accelerationSpeed: 12
      };
      sandbox.window.__CHROMA_INTERNAL__.revision = 1;
      sandbox.document.dispatchEvent({ type: '__CHROMA_CONFIG_UPDATE__' });

      assert.strictEqual(sandbox.CONFIG.enabled, true);
      assert.strictEqual(sandbox.CONFIG.stripping, false);
      assert.strictEqual(sandbox.CONFIG.acceleration, true);
      assert.strictEqual(sandbox.CONFIG.accelerationSpeed, 12);

      sandbox.window.__CHROMA_INTERNAL__.config = {
        enabled: false,
        stripping: false,
        acceleration: false,
        accelerationSpeed: 12
      };
      sandbox.window.__CHROMA_INTERNAL__.revision = 2;
      sandbox.document.dispatchEvent({ type: '__CHROMA_CONFIG_UPDATE__' });
      assert.strictEqual(sandbox.CONFIG.enabled, false);
      assert.strictEqual(sandbox.CONFIG.acceleration, false);

      sandbox.document.dispatchEvent({
        type: '__CHROMA_CONFIG_UPDATE__',
        detail: { enabled: true, acceleration: true }
      });
      assert.strictEqual(sandbox.CONFIG.enabled, false, 'same-revision forged signals are ignored');
    });
  });
});
