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

const contentJsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8');

// ─── CONTENT SCRIPT GENERIC FUNCTIONALITY ─────
test('Content script generic functionality', async (t) => {
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
        STATS_RESET: 'STATS_RESET',
        SUSPICIOUS_ACTIVITY: 'SUSPICIOUS_ACTIVITY'
      },
      HIDE_SELECTORS: ['.ad-showing', '#masthead-ad'],
      WARNING_SELECTOR_COMBINED: 'ytd-enforcement-message-view-model',
      notifyBackground: () => Promise.resolve()
    };
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
    sandbox.setHideSelectors(['.ad-showing', '#masthead-ad']);

    sandbox.injectAllCSS();
    assert.strictEqual(sandbox.document.adoptedStyleSheets.length, 1, 'Should have exactly 1 stylesheet for cosmetic');
    assert.ok(sandbox.document.adoptedStyleSheets[0].content.includes('display: none'), 'Stylesheet should contain hiding rules');
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
});
