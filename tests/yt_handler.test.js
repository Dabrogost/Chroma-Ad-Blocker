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
  const createStrippingSandbox = (configOverrides = {}) => {
    const sandbox = {
      window: {
        location: { hostname: 'www.youtube.com' },
        fetch: async () => ({ clone: () => ({ json: async () => ({}) }), status: 200, statusText: 'OK', headers: {} }),
        addEventListener: () => {},
        removeEventListener: () => {},
        innerHeight: 1000, innerWidth: 1000,
        setTimeout: (fn) => fn(),
        setInterval: () => {},
        clearInterval: () => {},
        MutationObserver: class { observe() {} disconnect() {} },
      },
      location: { hostname: 'www.youtube.com' },
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
      Response: class {
        constructor(body, init) { this.body = body; this._init = init; }
        async json() { return JSON.parse(this.body); }
      },
      XMLHttpRequest: class { open() {} send() {} addEventListener() {} },
      console, Object, Array, Number, String, Boolean, Math, Date, Promise, Error,
      // Give each sandbox its own JSON copy so JSON.parse mutations don't leak between test sandboxes.
      JSON: { parse: JSON.parse, stringify: JSON.stringify },
      __CHROMA_INTERNAL_TEST_STRICT__: true,
    };
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
});

// ─── YOUTUBE AD ACCELERATION ─────
test('YouTube ad acceleration', async (t) => {
  const createSandbox = (setupDoc) => {
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
      config: { enabled: true, acceleration: true, accelerationSpeed: 8 }
    };

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

  await t.test('Event-Driven Initialization Flow', async (st) => {
    await st.test('aborts initialization when __EXT_INIT__ activates kill switch', async () => {
      let intervalFns = [];
      const sandbox = createSandbox();
      sandbox.window.__CHROMA_INTERNAL__.config = null;
      sandbox.setInterval = (fn) => intervalFns.push(fn);
      // Run yt_handler again so it picks up the null config state
      vm.runInContext(youtubeJsCode, sandbox);

      sandbox.document.dispatchEvent({ type: '__EXT_INIT__', detail: { active: false } });
      intervalFns.forEach(fn => fn());

      assert.strictEqual(sandbox.CONFIG.enabled, false, 'Kill switch should prevent enabling');
    });

    await st.test('wakes up normally when __EXT_INIT__ fires true', async () => {
      let intervalFns = [];
      const sandbox = createSandbox();
      sandbox.window.__CHROMA_INTERNAL__.config = null;
      sandbox.setInterval = (fn) => intervalFns.push(fn);
      vm.runInContext(youtubeJsCode, sandbox);
      
      sandbox.document.dispatchEvent({ type: '__EXT_INIT__', detail: { active: true } });
      intervalFns.forEach(fn => fn());

      assert.strictEqual(sandbox.CONFIG.enabled, true, 'Should enable when active');
    });
  });
});
