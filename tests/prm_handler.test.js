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
    playbackRate: 1,
    muted: false,
    volume: 1,
    src: '',
    videoWidth: 1920,
    videoHeight: 1080,
    offsetWidth: 1920,
    offsetHeight: 1080,
    readyState: 4,
    style: { 
      display: '',
      setProperty: function(prop, val) { this[prop] = val; }
    },
    dataset: {},
    offsetParent: {}, // Mock offsetParent to simulate visibility
    children: [],
    appendChild: function(child) {
      this.children = this.children || [];
      this.children.push(child);
      child.parentElement = this;
      return child;
    },
    attachShadow: function({ mode }) {
      this.shadowRoot = {
        mode,
        children: [],
        appendChild: function(child) {
          this.children.push(child);
          return child;
        },
        querySelector: function(sel) {
          const find = (nodes, sel) => {
            for (const c of nodes) {
              if ((sel.includes('.') && c.className === sel.split('.')[1]) ||
                  (sel.includes('#') && c.id === sel.split('#')[1])) {
                return c;
              }
              if (c.children) {
                const found = find(c.children, sel);
                if (found) return found;
              }
            }
            return null;
          };
          return find(this.children, sel);
        }
      };
      return this.shadowRoot;
    },
    remove: () => {},
    querySelector: function(sel) {
      this.children = this.children || [];
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        for (const child of this.children) {
          if (child.className === cls) return child;
          const found = child.querySelector(sel);
          if (found) return found;
        }
      }
      if (sel.startsWith('#')) {
        const id = sel.slice(1);
        for (const child of this.children) {
          if (child.id === id) return child;
          const found = child.querySelector(sel);
          if (found) return found;
        }
      }
      return null;
    },
    querySelectorAll: () => [],
    textContent: '',
    get innerText() { return this._innerText !== undefined ? this._innerText : this.textContent; },
    set innerText(val) { this._innerText = val; },
    getAttribute: () => null,
    setAttribute: () => {},
    click: function() { this.clicked = true; },
    closest: function() { return this.parentElement || this.mockParent || null; },
    addEventListener: () => {},
    removeEventListener: () => {},
    getClientRects: function() { return (this.offsetParent !== null) ? [{ width: 100, height: 100 }] : []; }, 
    classList: {
      add: function(cls) { this.classes = this.classes || new Set(); this.classes.add(cls); },
      remove: function(cls) { this.classes = this.classes || new Set(); this.classes.delete(cls); },
      contains: function(cls) { return this.classes ? this.classes.has(cls) : false; }
    },
    get childNodes() { return this.children || []; },
    contains: function(child) {
      this.children = this.children || [];
      return this.children.includes(child);
    }
  };
}

function createMockQuerySelector(baseSelection = {}, container = null) {
  return (sel) => {
    if (sel === 'video') return baseSelection.video || null;
    
    // 1. Handle Container Detection
    const partList = sel.split(',').map(s => s.trim());
    const containers = [
      '.atvwebplayersdk-player-container',
      '.webPlayerUIContainer',
      '.templateContainer',
      '.dv-player-fullscreen',
      '.amazon-video-player',
      '.av-player-container',
      '#dv-web-player',
      '[data-testid="video-player"]'
    ];
    if (container && partList.some(p => containers.includes(p))) return container;

    // 2. Handle specific selectors
    for (const [key, val] of Object.entries(baseSelection)) {
        if (sel === key || partList.includes(key)) {
            return typeof val === 'function' ? val() : val;
        }
    }

    // 3. Handle shadow root lookups
    if (sel.startsWith('.chroma-') && container && container.shadowRoot) {
        return container.shadowRoot.querySelector(sel);
    }

    return null;
  };
}

const primeJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content', 'prm_handler.js'), 'utf8');
const messagingJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'core', 'messaging.js'), 'utf8');

// ─── AMAZON PRIME VIDEO AD ACCELERATION ─────
test('Amazon Prime Video ad acceleration', async (t) => {
  const chromeMock = {
    runtime: {
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener: () => {} }
    },
    storage: {
      local: {
        // Acceleration Speed Cap: Maximum browser playback rate.
        get: () => Promise.resolve({ config: { enabled: true, accelerationSpeed: 8 } })
      }
    }
  };

  const sandbox = {
    chrome: chromeMock,
    document: {
      createElement: (tag) => createMockElement(tag),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: (sel) => {
        if (sel === 'video') {
         const v = createMockElement('video');
         v.playbackRate = 1;
         return [v];
        }
        return [];
      },
      documentElement: createMockElement('html'),
      body: createMockElement('body'),
      addEventListener: () => {},
      createTreeWalker: function(root, whatToShow) {
        const nodes = [];
        function traverse(node) {
          if (whatToShow === 4) {
            if (node.textContent && (!node.children || node.children.length === 0)) {
              nodes.push(node);
            }
          }
          if (node.children) {
            node.children.forEach(traverse);
          }
        }
        traverse(root);
        let index = -1;
        return {
          nextNode: () => {
            index++;
            return nodes[index] || null;
          }
        };
      }
    },
    NodeFilter: {
      // DOM Filtering: NodeFilter SHOW_TEXT bitmask.
      SHOW_TEXT: 4
    },
    setInterval: () => {},
    clearInterval: () => {},
    setTimeout: global.setTimeout,
    console: console,
    Math: Math,
    Date: Date,
    requestAnimationFrame: () => {},
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() {}
      disconnect() {}
    },
    getComputedStyle: () => ({ position: 'relative' }),
    globalThis: { __CHROMA_INTERNAL_TEST_STRICT__: true },
    addEventListener: () => {},
    removeEventListener: () => {},
    // Mock browser-native CSSStyleSheet API for adoptedStyleSheets-based session management
    CSSStyleSheet: class {
      constructor() { this._css = ''; }
      replaceSync(css) { this._css = css; }
    }
  };
  sandbox.document.adoptedStyleSheets = [];
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__CHROMA_INTERNAL_TEST_STRICT__ = true;

  // VULN-03 Hardening: Sandbox bridge mocking.
  sandbox.window.__CHROMA_INTERNAL__ = {
    api: {
      querySelector: (s) => sandbox.document.querySelector(s),
      getElementById: (id) => sandbox.document.getElementById(id),
      createElement: (t) => sandbox.document.createElement(t),
      addEventListener: (e, f, o) => sandbox.addEventListener(e, f, o),
      removeEventListener: (e, f, o) => sandbox.removeEventListener(e, f, o),
      setTimeout: (f, t) => sandbox.setTimeout(f, t),
      setInterval: (f, t) => sandbox.setInterval(f, t),
      clearInterval: (i) => sandbox.clearInterval(i),
      dispatchEvent: (e) => {},
      addDocEventListener: (e, f, o) => sandbox.document.addEventListener(e, f, o),
      removeDocEventListener: (e, f, o) => sandbox.document.removeEventListener(e, f, o),
      MutationObserver: sandbox.MutationObserver
    },
    config: {}
  };

  vm.createContext(sandbox);
  vm.runInContext(messagingJsCode, sandbox);
  vm.runInContext(primeJsCode, sandbox);
  
  // Ensure enabled for all tests to avoid waiting for handshake timeout
  if (sandbox.CONFIG) sandbox.CONFIG.enabled = true;
  if (sandbox.CONFIG) sandbox.CONFIG.acceleration = true;

  await t.test('should accelerate when ad container is present', () => {
    // Reset state from previous tests
    sandbox.document.querySelector = () => null;
    sandbox.document.querySelectorAll = () => [];
    for (let i = 0; i < 5; i++) sandbox.handlePrimeAdAcceleration();

    const mockVideo = createMockElement('video');
    const playerContainer = createMockElement('div');
    playerContainer.className = 'atvwebplayersdk-player-container';
    
    const adContainer = createMockElement('div');
    adContainer.className = 'atvwebplayersdk-ad-container';
    adContainer.textContent = '0:15';
    sandbox.document.querySelector = createMockQuerySelector({
      '.atvwebplayersdk-ad-container': adContainer,
      'video': mockVideo
    }, playerContainer);
    
    mockVideo.playbackRate = 1;
    sandbox.document.querySelectorAll = (sel) => {
      if (sel === 'video') return [mockVideo];
      if (sel.includes('.atvwebplayersdk-player-container')) return [playerContainer];
      return [];
    };

    sandbox.handlePrimeAdAcceleration();
    // Acceleration Speed Cap: Maximum browser playback rate.
    assert.strictEqual(mockVideo.playbackRate, 8, 'Playback rate should be 8 during ad');
  });

  await t.test('should accelerate when ad-related text is present', () => {
    // Reset state from previous tests
    sandbox.document.querySelector = () => null;
    sandbox.document.querySelectorAll = () => [];
    for (let i = 0; i < 5; i++) sandbox.handlePrimeAdAcceleration();

    const mockVideo = createMockElement('video');
    const playerContainer = createMockElement('div');
    playerContainer.className = 'atvwebplayersdk-player-container';
    playerContainer.innerText = 'Ad 0:15';

    sandbox.document.querySelector = createMockQuerySelector({
      'video': mockVideo
    }, playerContainer);
    
    sandbox.document.querySelectorAll = (sel) => {
      if (sel === 'video') return [mockVideo];
      if (sel.includes('.atvwebplayersdk-player-container')) return [playerContainer];
      return [];
    };

    sandbox.handlePrimeAdAcceleration();
    // Acceleration Speed Cap: Maximum browser playback rate.
    assert.strictEqual(mockVideo.playbackRate, 8, 'Should accelerate based on innerText');
  });

  await t.test('should target the visible video element if multiple exist', () => {
    // Reset state from previous tests
    sandbox.document.querySelector = () => null;
    sandbox.document.querySelectorAll = () => [];
    for (let i = 0; i < 5; i++) sandbox.handlePrimeAdAcceleration();

    const hiddenVideo = createMockElement('video');
    hiddenVideo.offsetParent = null;
    const visibleVideo = createMockElement('video');
    visibleVideo.offsetParent = {};
    visibleVideo.getClientRects = () => [{ width: 1920, height: 1080 }];
    visibleVideo.src = 'blob:video-source';
    
    hiddenVideo.offsetParent = null;
    hiddenVideo.getClientRects = () => [];

    sandbox.document.querySelectorAll = (sel) => {
      if (sel === 'video') return [hiddenVideo, visibleVideo];
      return [];
    };
    const adContainer = createMockElement('div');
    adContainer.className = 'atvwebplayersdk-ad-container';
    adContainer.textContent = '0:15';
    sandbox.document.querySelector = createMockQuerySelector({
      '.atvwebplayersdk-ad-container': adContainer
    });

    sandbox.handlePrimeAdAcceleration();
    // Acceleration Speed Cap: Maximum browser playback rate.
    assert.strictEqual(visibleVideo.playbackRate, 8, 'Visible video should be accelerated');
    assert.strictEqual(hiddenVideo.playbackRate, 1, 'Hidden video should remain normal');
  });
  await t.test('should create and activate visual overlay during ad', () => {
    // Reset state from previous tests
    sandbox.document.querySelector = () => null;
    sandbox.document.querySelectorAll = () => [];
    for (let i = 0; i < 5; i++) sandbox.handlePrimeAdAcceleration();

    const mockVideo = createMockElement('video');
    mockVideo.currentTime = 5;
    mockVideo.duration = 10;
    const container = createMockElement('div');
    container.className = 'atvwebplayersdk-player-container';
    
    mockVideo.closest = () => container;
    
    let createdOverlay = null;
    container.appendChild = (child) => {
      if (child.id && child.id.startsWith('chroma-host-')) createdOverlay = child;
    };
    container.contains = (child) => child === createdOverlay;

    sandbox.document.querySelectorAll = (sel) => {
      if (sel === 'video') return [mockVideo];
      if (sel.includes('.atvwebplayersdk-ad-container')) return [createMockElement('div')];
      return [];
    };
    
    const adContainer = createMockElement('div');
    adContainer.className = 'atvwebplayersdk-ad-container';
    adContainer.textContent = '0:15';
    sandbox.document.querySelector = createMockQuerySelector({
      '.atvwebplayersdk-ad-container': adContainer,
      'video': mockVideo
    }, container);

    sandbox.document.getElementById = (id) => {
      if (id && id.startsWith('chroma-host-')) return createdOverlay;
      return null;
    };

    sandbox.handlePrimeAdAcceleration();
    
    assert.ok(createdOverlay, 'Overlay should be created');
    assert.strictEqual(createdOverlay.classList.contains('active'), true, 'Overlay should be active');
    
    const progressBar = createdOverlay && createdOverlay.shadowRoot ? createdOverlay.shadowRoot.querySelector('.chroma-progress-bar') : null;
    assert.ok(progressBar, 'Progress bar should exist');
    assert.strictEqual(progressBar.style.width, '50%', 'Progress bar width should be 50%');
    assert.ok(sandbox.document.adoptedStyleSheets.length > 0, 'Session sheet should be adopted during ad');
  });

  await t.test('should NOT detect ad if only chroma overlay text is present', () => {
    const mockVideo = createMockElement('video');
    const container = createMockElement('div');
    container.className = 'atvwebplayersdk-player-container';
    
    const overlay = createMockElement('div');
    overlay.id = 'chroma-host-12345';
    // Loop Prevention: Chroma overlay detection exclusion.
    overlay.textContent = 'Accelerating Prime Ad...';
    container.appendChild(overlay);

    sandbox.document.querySelectorAll = (sel) => {
      if (sel === 'video') return [mockVideo];
      if (sel.includes('.atvwebplayersdk-overlays-container')) return [container];
      return [];
    };
    
    sandbox.document.querySelector = createMockQuerySelector({
      'video': mockVideo
    }, container);

    const isAd = sandbox.isAdShowing();
    assert.strictEqual(isAd, false, 'Should not detect ad based on chroma overlay text');
  });

  await t.test('should estimate progress from ad timer or native duration', () => {
    // Reset state from previous tests
    sandbox.document.querySelector = () => null;
    sandbox.document.querySelectorAll = () => [createMockElement('video')];
    for (let i = 0; i < 5; i++) sandbox.handlePrimeAdAcceleration();

    const mockVideo = createMockElement('video');
    mockVideo.duration = 60; // Use realistic ad duration
    
    const adTimer = createMockElement('div');
    adTimer.className = 'atvwebplayersdk-ad-timer';
    adTimer.textContent = 'Ad 0:57'; // First tick sets up percentage via string or fallback
    
    let createdOverlay = null;
    sandbox.document.querySelectorAll = (sel) => {
      if (sel === 'video') return [mockVideo];
      if (sel.includes('.atvwebplayersdk-ad-timer')) return [adTimer];
      return [];
    };
    
    const playerContainer = createMockElement('div');
    playerContainer.className = 'atvwebplayersdk-player-container';
    playerContainer.appendChild = (child) => { if (child.id && child.id.startsWith('chroma-host-')) createdOverlay = child; return child; };
    mockVideo.closest = () => playerContainer;

    sandbox.document.querySelector = createMockQuerySelector({
      '.atvwebplayersdk-ad-timer': adTimer,
      'video': mockVideo
    }, playerContainer);

    // After tick, createdOverlay is initialized
    sandbox.handlePrimeAdAcceleration();
    
    const progressBar = createdOverlay && createdOverlay.shadowRoot ? createdOverlay.shadowRoot.querySelector('.chroma-progress-bar') : null;
    assert.ok(progressBar, 'Progress bar should be found in shadow root');

    // Second tick: use native duration to bypass test-state pollution across vm contexts
    mockVideo.currentTime = 30;
    sandbox.handlePrimeAdAcceleration();
  });

  await t.test('should accelerate multiple consecutive ads in the same session', async () => {
    // Reset state from previous tests
    sandbox.document.querySelector = () => null;
    sandbox.document.querySelectorAll = () => [createMockElement('video')];
    for (let i = 0; i < 5; i++) sandbox.handlePrimeAdAcceleration();

    const mockVideo = createMockElement('video');
    const container = createMockElement('div');
    container.className = 'webPlayerUIContainer';
    mockVideo.parentElement = container;
    container.children = [mockVideo];

    sandbox.document.querySelectorAll = (sel) => {
      if (sel === 'video') return [mockVideo];
      if (sel.includes('.webPlayerUIContainer')) return [container];
      return [];
    };

    sandbox.document.querySelector = createMockQuerySelector({
      'video': mockVideo
    }, container);

    // 1. First Ad Starts
    const adIndicator = createMockElement('span');
    adIndicator.textContent = 'Ad 0:15';
    container.children.push(adIndicator);
    container.innerText = 'Ad 0:15'; // Simulate aggregated innerText
    
    sandbox.handlePrimeAdAcceleration();
    // Acceleration Speed Cap: Maximum browser playback rate.
    assert.strictEqual(mockVideo.playbackRate, 8, 'First ad should be accelerated');
    
    // The overlay is now injected into container
    const overlay = container.children.find(c => c.id && c.id.startsWith('chroma-host-'));
    assert.ok(overlay, 'Overlay should be injected into container');

    // Ad Detection Debounce: Consecutive detection threshold.
    container.children = container.children.filter(c => c !== adIndicator);
    container.innerText = '';
    
    // Call 4 times to satisfy the debounce logic
    // Ad Detection Debounce: Completion confirmation threshold.
    for (let i = 0; i < 4; i++) {
        sandbox.handlePrimeAdAcceleration();
    }
    assert.strictEqual(mockVideo.playbackRate, 1, 'Restored to 1x after 4 consecutive false detections');

    // 3. Second Ad Starts
    const adIndicator2 = createMockElement('span');
    adIndicator2.textContent = 'Ad 0:20';
    container.children.push(adIndicator2);
    container.innerText = 'Ad 0:20';
    
    sandbox.handlePrimeAdAcceleration();
    // Acceleration Speed Cap: Maximum browser playback rate.
    assert.strictEqual(mockVideo.playbackRate, 8, 'Second ad should be accelerated even with overlay present');
  });

  await t.test('should reset state when video source changes without an active ad', () => {
    // Reset state from previous tests
    sandbox.document.querySelector = () => null;
    sandbox.document.querySelectorAll = () => [];
    for (let i = 0; i < 5; i++) sandbox.handlePrimeAdAcceleration();

    const mockVideo = createMockElement('video');
    mockVideo.src = 'ad-source-1';
    const container = createMockElement('div');
    container.className = 'atvwebplayersdk-player-container';
    
    sandbox.document.querySelectorAll = (sel) => {
      if (sel === 'video') return [mockVideo];
      return [];
    };

    // 1. Start an ad
    const adContainer = createMockElement('div');
    adContainer.className = 'atvwebplayersdk-ad-container';
    adContainer.textContent = '0:15';
    sandbox.document.querySelector = createMockQuerySelector({
      '.atvwebplayersdk-ad-container': adContainer,
      'video': mockVideo
    }, container);
    
    sandbox.handlePrimeAdAcceleration();
    assert.strictEqual(sandbox.__CHROMA_STATE_BRIDGE__.isAdActive, true, 'Ad should be active');
    // Acceleration Speed Cap: Maximum browser playback rate.
    assert.strictEqual(mockVideo.playbackRate, 8, 'Accelerated');

    // 2. Ad ends (indicator gone), but source changes to something else (e.g. main video)
    sandbox.document.querySelector = createMockQuerySelector({
      'video': mockVideo
    }, container);
    mockVideo.src = 'main-video-source';

    sandbox.handlePrimeAdAcceleration();
    assert.strictEqual(sandbox.__CHROMA_STATE_BRIDGE__.isAdActive, false, 'Ad state should reset due to src change detection');
    assert.strictEqual(mockVideo.playbackRate, 1, 'Restored to 1x');
  });
});

test('Prime Event-Driven Initialization Flow', async (t) => {
  const createInitSandbox = () => {
    let listeners = {};
    const sandbox = {
      chrome: { runtime: { sendMessage: () => Promise.resolve(), onMessage: { addListener: () => {} } }, storage: { local: { get: () => Promise.resolve({ config: {} }) } } },
      document: {
        createElement: (tag) => createMockElement(tag),
        querySelector: () => null,
        querySelectorAll: () => [],
        documentElement: createMockElement('html'),
        body: createMockElement('body'),
        addEventListener: function(evt, cb) {
          if (!listeners[evt]) listeners[evt] = [];
          listeners[evt].push(cb);
        },
        removeEventListener: () => {},
        dispatchEvent: function(e) {
          if (listeners[e.type]) listeners[e.type].forEach(cb => cb(e));
        },
        adoptedStyleSheets: []
      },
      CSSStyleSheet: class {
        constructor() { this._css = ''; }
        replaceSync(css) { this._css = css; }
      },
      setInterval: () => 999,
      clearInterval: () => {},
      setTimeout: global.setTimeout,
      console: console,
      Math: Math,
      Date: Date,
      requestAnimationFrame: () => {},
      MutationObserver: class { observe() {} disconnect() {} },
      window: {},
      __CHROMA_INTERNAL_TEST_STRICT__: true
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    sandbox.window.__CHROMA_INTERNAL__ = {
      api: {
        querySelector: (s) => sandbox.document.querySelector(s),
        getElementById: () => null,
        createElement: (t) => sandbox.document.createElement(t),
        addEventListener: () => {},
        removeEventListener: () => {},
        setTimeout: (f, t) => sandbox.setTimeout(f, t),
        setInterval: (f, t) => sandbox.setInterval(f, t),
        clearInterval: (i) => sandbox.clearInterval(i),
        dispatchEvent: (e) => sandbox.document.dispatchEvent(e),
        addDocEventListener: (e, f, o) => sandbox.document.addEventListener(e, f, o),
        removeDocEventListener: () => {},
        MutationObserver: sandbox.MutationObserver
      },
      config: null // Force polling
    };
    
    return sandbox;
  };

  await t.test('aborts initialization when __EXT_INIT__ activates kill switch', async () => {
    let intervalFns = [];
    const sandbox = createInitSandbox();
    sandbox.setInterval = (fn) => intervalFns.push(fn);

    vm.createContext(sandbox);
    vm.runInContext(messagingJsCode, sandbox);
    vm.runInContext(primeJsCode, sandbox);

    sandbox.document.dispatchEvent({ type: '__EXT_INIT__', detail: { active: false } });
    intervalFns.forEach(fn => fn());

    assert.strictEqual(sandbox.CONFIG.enabled, false, 'Kill switch should prevent enabling');
  });

  await t.test('wakes up normally when __EXT_INIT__ fires true', async () => {
    let intervalFns = [];
    const sandbox = createInitSandbox();
    sandbox.setInterval = (fn) => intervalFns.push(fn);

    vm.createContext(sandbox);
    vm.runInContext(messagingJsCode, sandbox);
    vm.runInContext(primeJsCode, sandbox);

    sandbox.document.dispatchEvent({ type: '__EXT_INIT__', detail: { active: true } });
    intervalFns.forEach(fn => fn());

    assert.strictEqual(sandbox.CONFIG.enabled, true, 'Should enable when active');
  });
});
