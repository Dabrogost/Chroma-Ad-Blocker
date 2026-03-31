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

const scriptPath = path.join(__dirname, '..', 'extension', 'yt_handler.js');
const youtubeJsCode = fs.readFileSync(scriptPath, 'utf8');

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
        STATS_RESET: 'STATS_RESET',
        SUSPICIOUS_ACTIVITY: 'SUSPICIOUS_ACTIVITY'
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
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => {},
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
      __TESTING__: true,
    };

    sandbox.globalThis = sandbox;

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
        addDocEventListener: (e, f, o) => sandbox.document.addEventListener(e, f, o),
        removeDocEventListener: (e, f, o) => sandbox.document.removeEventListener(e, f, o),
        MutationObserver: sandbox.window.MutationObserver
      },
      config: { enabled: true, acceleration: true, accelerationSpeed: 16 }
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
    assert.strictEqual(sandbox.window.chromaAdSessionActive, true);
    // Acceleration Speed Cap: Maximum browser playback rate.
    assert.strictEqual(mockVideo.playbackRate, 16);
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


    sandbox.window.chromaAdSessionActive = true;
    sandbox.window.lastAdDetectTime = Date.now();
    mockVideo.muted = true;
    mockVideo.dataset.ytChromaMuted = 'true';

    // Debounce Override: Immediate unmute on main content detection.
    sandbox.handleAdAcceleration();
    
    assert.strictEqual(sandbox.window.chromaAdSessionActive, false, 'Session should be deactivated when main content is ready');
    assert.strictEqual(mockVideo.muted, false, 'Video should be unmuted');
  });
});
