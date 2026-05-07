const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createMockElement(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    classList: {
      add: () => {},
      remove: () => {},
      contains: () => false,
      toggle: () => {}
    },
    style: {
      setProperty: () => {},
      removeProperty: () => {},
      display: '',
      width: '',
      height: ''
    },
    dataset: {},
    appendChild: (child) => child,
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
    matches: () => false
  };
  return el;
}

const contentJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content', 'content.js'), 'utf8');

// ─── CONTENT SCRIPT GENERIC FUNCTIONALITY ─────
test('Content script generic functionality', async (t) => {
  const createSandbox = (setupDoc) => {
    const sentMessages = [];
    const sandbox = {
      chrome: {
        runtime: {
          sendMessage: (msg) => {
            sentMessages.push(msg);
            return Promise.resolve({ ok: true });
          },
          onMessage: { addListener: () => {} }
        },
        storage: {
          local: {
            get: () => Promise.resolve({}),
            set: () => Promise.resolve()
          }
        }
      },
      CSSStyleSheet: class {
        constructor() {
          this.content = '';
        }
        replaceSync(content) {
          this.content = content;
        }
      },
      document: {
        readyState: 'complete',
        createElement: (tag) => createMockElement(tag),
        getElementById: () => null,
        querySelector: () => createMockElement(),
        querySelectorAll: () => [],
        head: createMockElement('head'),
        body: createMockElement('body'),
        documentElement: createMockElement('html'),
        addEventListener: () => {},
        getElementsByClassName: () => [],
        _adoptedStyleSheets: [],
        get adoptedStyleSheets() { return this._adoptedStyleSheets; },
        set adoptedStyleSheets(val) { this._adoptedStyleSheets = val; }
      },
      setInterval: () => {},
      clearInterval: () => {},
      setTimeout: (fn) => fn(),
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      requestAnimationFrame: (cb) => cb(),
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
        addEventListener: () => {},
        removeEventListener: () => {},
        requestAnimationFrame: (cb) => cb(),
        // Visibility Calculation Dimensions: Standard 1080p targets.
        innerHeight: 1000,
        innerWidth: 1000
      },
      location: { hostname: 'www.youtube.com' },
      __CHROMA_INTERNAL_TEST_STRICT__: true,
      Node: { ELEMENT_NODE: 1 },
      MSG: {
        CONFIG_GET: 'CONFIG_GET',
        CONFIG_SET: 'CONFIG_SET',
        CONFIG_UPDATE: 'CONFIG_UPDATE',
        STATS_RESET: 'STATS_RESET'
      },
      HIDE_SELECTORS: ['.ad-showing', '#masthead-ad'],
      WARNING_SELECTOR_COMBINED: 'ytd-enforcement-message-view-model',
      notifyBackground: () => Promise.resolve()
    };
    sandbox.__sentMessages = sentMessages;
    sandbox.globalThis = sandbox;

    if (setupDoc) setupDoc(sandbox.document);

    vm.createContext(sandbox);
    vm.runInContext(contentJsCode, sandbox);
    return sandbox;
  };

  await t.test('injectAllCSS functionality', async (st) => {
    const sandbox = createSandbox();
    
    sandbox.CONFIG.enabled = true;
    sandbox.CONFIG.cosmetic = true;
    sandbox.CONFIG.hideMerch = false;
    sandbox.CONFIG.hideOffers = false;
    sandbox.CONFIG.hideShorts = false;
    sandbox.CONFIG.suppressWarnings = false;
    sandbox.setHideSelectors(['.ad-showing', '#masthead-ad']);

    sandbox.injectAllCSS();
    assert.strictEqual(sandbox.document.adoptedStyleSheets.length, 1, 'Should have exactly 1 stylesheet for cosmetic');
    assert.ok(sandbox.document.adoptedStyleSheets[0].content.includes('display: none'), 'Stylesheet should contain hiding rules');
  });

  await t.test('invalid cosmetic selectors do not drop the whole hide sheet', async (st) => {
    const sandbox = createSandbox((doc) => {
      const originalQuerySelector = doc.querySelector;
      doc.querySelector = (sel) => {
        if (sel === 'BAD[') throw new Error('Invalid selector');
        return originalQuerySelector(sel);
      };
    });

    sandbox.CONFIG.enabled = true;
    sandbox.CONFIG.cosmetic = true;
    sandbox.CONFIG.hideMerch = false;
    sandbox.CONFIG.hideOffers = false;
    sandbox.CONFIG.hideShorts = false;
    sandbox.CONFIG.suppressWarnings = false;
    sandbox.setHideSelectors(['.ad-showing', 'BAD[', '#masthead-ad']);

    sandbox.injectAllCSS();

    assert.strictEqual(sandbox.document.adoptedStyleSheets.length, 1, 'Should keep the cosmetic stylesheet');
    const css = sandbox.document.adoptedStyleSheets[0].content;
    assert.match(css, /\.ad-showing\s*\{/);
    assert.match(css, /#masthead-ad\s*\{/);
    assert.doesNotMatch(css, /BAD\[/);
  });

  await t.test('injectAllCSS refreshes cosmetic CSS when hide selectors change', async (st) => {
    const sandbox = createSandbox();

    sandbox.CONFIG.enabled = true;
    sandbox.CONFIG.cosmetic = true;
    sandbox.CONFIG.hideMerch = false;
    sandbox.CONFIG.hideOffers = false;
    sandbox.CONFIG.hideShorts = false;
    sandbox.CONFIG.suppressWarnings = false;

    sandbox.setHideSelectors(['.first-ad']);
    sandbox.injectAllCSS();
    const firstSheet = sandbox.document.adoptedStyleSheets[0];

    sandbox.setHideSelectors(['.second-ad']);
    sandbox.injectAllCSS();

    assert.notStrictEqual(sandbox.document.adoptedStyleSheets[0], firstSheet, 'Should replace stale cosmetic sheet');
    assert.match(sandbox.document.adoptedStyleSheets[0].content, /\.second-ad\s*\{/);
    assert.doesNotMatch(sandbox.document.adoptedStyleSheets[0].content, /\.first-ad\s*\{/);
  });

  await t.test('suppressAdblockWarnings functionality', async (st) => {
    let removed = false;
    const warning = createMockElement();
    warning.remove = () => { removed = true; };
    warning.matches = () => true;

    const sandbox = createSandbox((doc) => {
      doc.querySelectorAll = () => [warning];
    });
    
    sandbox.setWarningSelector('ytd-enforcement-message-view-model');

    sandbox.suppressAdblockWarnings();
    assert.strictEqual(removed, true);
  });

  await t.test('removeLeftoverAdContainers functionality', async (st) => {
    const adChild = createMockElement();
    adChild.id = 'ad-slot-test';
    const sandbox = createSandbox((doc) => {
      doc.querySelectorAll = (sel) => {
        if (sel.includes('ad-slot')) return [adChild];
        return [];
      };
    });

    sandbox.removeLeftoverAdContainers();
    assert.strictEqual(adChild.style.display, 'none');
  });

  await t.test('removeLeftoverAdContainers respects disabled cosmetic filtering', async (st) => {
    const adNode = createMockElement();
    adNode.nodeType = 1;
    adNode.id = 'ad-slot-test';
    adNode.querySelectorAll = () => [];
    const sandbox = createSandbox();

    sandbox.CONFIG.enabled = true;
    sandbox.CONFIG.cosmetic = false;
    sandbox.CONFIG.suppressWarnings = false;

    sandbox.removeLeftoverAdContainers(adNode);

    assert.notStrictEqual(adNode.removed, true);
    assert.notStrictEqual(adNode.style.display, 'none');
  });

  await t.test('removeLeftoverAdContainers runs when cosmetic filtering is enabled', async (st) => {
    const adNode = createMockElement();
    adNode.nodeType = 1;
    adNode.id = 'ad-slot-test';
    adNode.querySelectorAll = () => [];
    const sandbox = createSandbox();

    sandbox.CONFIG.enabled = true;
    sandbox.CONFIG.cosmetic = true;

    sandbox.removeLeftoverAdContainers(adNode);

    assert.strictEqual(adNode.removed, true);
    assert.strictEqual(adNode.style.display, 'none');
  });

  await t.test('content stats events batch cosmetic, warning, and zapper events', async (st) => {
    const adNode = createMockElement();
    adNode.nodeType = 1;
    adNode.id = 'ad-slot-test';
    adNode.querySelectorAll = () => [];
    const warning = createMockElement();
    warning.remove = () => { warning.removed = true; };
    warning.matches = () => true;

    const sandbox = createSandbox((doc) => {
      doc.querySelectorAll = (sel) => {
        if (sel === 'ytd-enforcement-message-view-model') return [warning];
        return [];
      };
    });

    sandbox.setWarningSelector('ytd-enforcement-message-view-model');
    sandbox.CONFIG.enabled = true;
    sandbox.CONFIG.cosmetic = true;
    sandbox.CONFIG.suppressWarnings = true;

    sandbox.suppressAdblockWarnings();
    sandbox.removeLeftoverAdContainers(adNode);
    sandbox.queueStatsEvent({ layer: 'zapper', type: 'hit', count: 1, domain: 'spoofed.example', ts: 1 });
    sandbox.flushStatsQueue();

    const events = sandbox.__sentMessages
      .filter(msg => msg.type === 'STATS_EVENT_BATCH')
      .flatMap(msg => msg.events);
    assert.ok(events.length > 0, 'expected stats batch events');
    assert.ok(events.some(event => event.layer === 'warning' && event.type === 'suppression'));
    assert.ok(events.some(event => event.layer === 'cosmetic' && event.subtype === 'leftover_ad_container'));
    assert.ok(events.some(event => event.layer === 'zapper'));
    assert.ok(events.every(event => event.domain === 'www.youtube.com'));
    assert.ok(events.every(event => event.ts !== 1));
  });

  await t.test('disabled cosmetic mode does not record cleanup events', async (st) => {
    const adNode = createMockElement();
    adNode.nodeType = 1;
    adNode.id = 'ad-slot-test';
    adNode.querySelectorAll = () => [];
    const sandbox = createSandbox();

    sandbox.CONFIG.enabled = true;
    sandbox.CONFIG.cosmetic = false;
    sandbox.removeLeftoverAdContainers(adNode);
    sandbox.flushStatsQueue();

    const batch = sandbox.__sentMessages.find(msg => msg.type === 'STATS_EVENT_BATCH');
    assert.strictEqual(batch, undefined);
  });

  await t.test('disabled cosmetic mode does not hide or count optional cosmetic sections', async (st) => {
    const shortsShelf = createMockElement();
    const sandbox = createSandbox((doc) => {
      doc.querySelectorAll = (sel) => {
        if (sel === 'ytd-reel-shelf-renderer') return [shortsShelf];
        return [];
      };
    });

    sandbox.CONFIG.enabled = true;
    sandbox.CONFIG.cosmetic = false;
    sandbox.CONFIG.hideShorts = true;
    sandbox.CONFIG.hideMerch = false;
    sandbox.CONFIG.hideOffers = false;
    sandbox.CONFIG.suppressWarnings = false;
    sandbox.injectAllCSS();
    sandbox.flushStatsQueue();

    assert.strictEqual(sandbox.document.adoptedStyleSheets.length, 0);
    const batch = sandbox.__sentMessages.find(msg => msg.type === 'STATS_EVENT_BATCH');
    assert.strictEqual(batch, undefined);
  });
});
