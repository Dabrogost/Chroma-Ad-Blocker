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
  const createSandbox = (setupDoc, options = {}) => {
    const sentMessages = [];
    const documentListeners = {};
    const dispatchedEvents = [];
    const storageChangeListeners = [];
    let runtimeMessageListener = null;
    const location = options.location || { hostname: 'www.youtube.com', href: 'https://www.youtube.com/' };
    const sandbox = {
      chrome: {
        runtime: {
          sendMessage: (msg) => {
            sentMessages.push(msg);
            return Promise.resolve({ ok: true });
          },
          onMessage: { addListener: listener => { runtimeMessageListener = listener; } }
        },
        storage: {
          local: {
            get: () => Promise.resolve(options.storage || {}),
            set: () => Promise.resolve()
          },
          onChanged: {
            addListener: listener => { storageChangeListeners.push(listener); }
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
        addEventListener: (type, fn) => {
          if (!documentListeners[type]) documentListeners[type] = [];
          documentListeners[type].push(fn);
        },
        dispatchEvent: (event) => {
          dispatchedEvents.push(event);
          const listeners = documentListeners[event?.type] || [];
          listeners.forEach(fn => fn(event));
          return true;
        },
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
      URL,
      Promise: Promise,
      Error: Error,
      CustomEvent: class {
        constructor(type, init = {}) {
          this.type = type;
          this.detail = init.detail;
        }
      },
      window: { 
        location,
        addEventListener: () => {},
        removeEventListener: () => {},
        requestAnimationFrame: (cb) => cb(),
        // Visibility Calculation Dimensions: Standard 1080p targets.
        innerHeight: 1000,
        innerWidth: 1000
      },
      location,
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
    sandbox.__dispatchedEvents = dispatchedEvents;
    sandbox.__emitStorageChange = changes => {
      storageChangeListeners.forEach(listener => listener(changes, 'local'));
    };
    sandbox.__sendRuntimeMessage = message => runtimeMessageListener?.(message);
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
    await new Promise(resolve => setImmediate(resolve));

    sandbox.suppressAdblockWarnings();
    sandbox.removeLeftoverAdContainers(adNode);
    sandbox.queueStatsEvent({ layer: 'zapper', type: 'hit', count: 1, domain: 'spoofed.example', ts: 1 });
    sandbox.flushStatsQueue();

    const events = sandbox.__sentMessages
      .filter(msg => msg.type === 'STATS_EVENT_BATCH')
      .flatMap(msg => msg.events);
    assert.ok(events.length > 0, 'expected stats batch events');
    assert.ok(events.some(event => event.eventType === 'warning_suppression'));
    assert.ok(events.some(event => event.eventType === 'cosmetic_hide'));
    assert.ok(events.some(event => event.eventType === 'zapper_hit'));
    assert.ok(events.every(event => Object.keys(event).length === 1));
  });

  await t.test('scriptlet telemetry bridge records only aggregate event type', async (st) => {
    const sandbox = createSandbox();
    await new Promise(resolve => setImmediate(resolve));

    sandbox.document.dispatchEvent({
      type: '__CHROMA_SCRIPTLET_STATS__',
      detail: {
        type: 'error',
        scriptlet: 'set-constant',
        source: 'private-list-id',
        error: 'secret error detail'
      }
    });
    sandbox.flushStatsQueue();

    const event = sandbox.__sentMessages
      .filter(msg => msg.type === 'STATS_EVENT_BATCH')
      .flatMap(msg => msg.events)
      .find(item => item.eventType === 'scriptlet_error');

    assert.ok(event, 'expected scriptlet stats event');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(event)), { eventType: 'scriptlet_error' });
  });

  await t.test('forged scriptlet telemetry is enum-gated, master-gated, and rate bounded', async () => {
    const sandbox = createSandbox();
    await new Promise(resolve => setImmediate(resolve));

    sandbox.document.dispatchEvent({
      type: '__CHROMA_SCRIPTLET_STATS__',
      detail: { type: 'unknown', count: 100000, source: 'private-list-id' }
    });
    for (let index = 0; index < 1000; index++) {
      sandbox.document.dispatchEvent({
        type: '__CHROMA_SCRIPTLET_STATS__',
        detail: { type: 'hit', count: 100000, source: `forged-${index}` }
      });
    }

    let events = sandbox.__sentMessages
      .filter(msg => msg.type === 'STATS_EVENT_BATCH')
      .flatMap(msg => msg.events);
    assert.strictEqual(events.length, 20);
    assert.ok(events.every(event => event.eventType === 'scriptlet_hit'));
    assert.ok(events.every(event => Object.keys(event).length === 1));

    const disabled = createSandbox(null, {
      storage: { config: { enabled: false }, whitelist: [] }
    });
    await new Promise(resolve => setImmediate(resolve));
    disabled.document.dispatchEvent({
      type: '__CHROMA_SCRIPTLET_STATS__',
      detail: { type: 'hit' }
    });
    events = disabled.__sentMessages.filter(msg => msg.type === 'STATS_EVENT_BATCH');
    assert.deepStrictEqual(events, []);

    const whitelisted = createSandbox(null, {
      storage: { config: { enabled: true }, whitelist: ['youtube.com'] }
    });
    await new Promise(resolve => setImmediate(resolve));
    whitelisted.document.dispatchEvent({
      type: '__CHROMA_SCRIPTLET_STATS__',
      detail: { type: 'hit' }
    });
    events = whitelisted.__sentMessages.filter(msg => msg.type === 'STATS_EVENT_BATCH');
    assert.deepStrictEqual(events, []);
  });

  await t.test('publishes quiet console config to MAIN-world quiet layer', async () => {
    const sandbox = createSandbox(null, {
      storage: {
        config: { enabled: true },
        whitelist: []
      }
    });
    await new Promise(resolve => setImmediate(resolve));

    const event = sandbox.__dispatchedEvents.find(item => item?.type === '__CHROMA_QUIET_CONSOLE_CONFIG__');

    assert.ok(event, 'quiet console config event should be dispatched');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(event.detail)), {
      enabled: true,
      quietConsole: false
    });
  });

  await t.test('subscription cosmetics apply globally except on negated domains', async () => {
    const rules = [
      null,
      {
        domains: null,
        excludedDomains: ['example.com'],
        selector: '.global-except-example',
        isException: false
      },
      {
        domains: null,
        excludedDomains: ['bad/domain'],
        selector: '.malformed-must-not-broaden',
        isException: false
      },
      {
        domains: [],
        excludedDomains: null,
        selector: '.empty-inclusion-must-not-be-global',
        isException: false
      },
      {
        domains: null,
        excludedDomains: [],
        selector: '.empty-exclusion-must-not-be-global',
        isException: false
      },
      {
        domains: 'example.com',
        excludedDomains: null,
        selector: '.non-array-inclusion-must-not-apply',
        isException: false
      }
    ];
    const makeStorage = () => ({
      config: { enabled: true, cosmetic: true },
      HIDE_SELECTORS: [],
      whitelist: [],
      subscriptionCosmeticRules: rules
    });

    const included = createSandbox(null, {
      location: { hostname: 'news.test', href: 'https://news.test/' },
      storage: makeStorage()
    });
    const excluded = createSandbox(null, {
      location: { hostname: 'cdn.example.com', href: 'https://cdn.example.com/' },
      storage: makeStorage()
    });
    await new Promise(resolve => setImmediate(resolve));

    const includedCss = included.document.adoptedStyleSheets.map(sheet => sheet.content).join('\n');
    const excludedCss = excluded.document.adoptedStyleSheets.map(sheet => sheet.content).join('\n');
    assert.match(includedCss, /\.global-except-example/);
    assert.doesNotMatch(excludedCss, /\.global-except-example/);
    assert.doesNotMatch(includedCss, /\.malformed-must-not-broaden/);
    assert.doesNotMatch(excludedCss, /\.malformed-must-not-broaden/);
    assert.doesNotMatch(includedCss, /\.empty-inclusion-must-not-be-global/);
    assert.doesNotMatch(includedCss, /\.empty-exclusion-must-not-be-global/);
    assert.doesNotMatch(includedCss, /\.non-array-inclusion-must-not-apply/);
  });

  await t.test('a tab loaded while master-off restores subscription cosmetics live on re-enable', async () => {
    const sandbox = createSandbox(null, {
      location: { hostname: 'news.test', href: 'https://news.test/' },
      storage: {
        config: { enabled: false, cosmetic: true },
        HIDE_SELECTORS: [],
        whitelist: [],
        subscriptionCosmeticRules: []
      }
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(sandbox.document.adoptedStyleSheets.length, 0);

    sandbox.__emitStorageChange({
      subscriptionCosmeticRules: {
        oldValue: [],
        newValue: [{
          domains: null,
          excludedDomains: null,
          selector: '.restored-subscription-ad',
          isException: false
        }]
      }
    });
    assert.strictEqual(sandbox.document.adoptedStyleSheets.length, 0, 'master-off remains inert');

    sandbox.__sendRuntimeMessage({
      type: 'CONFIG_UPDATE',
      config: { enabled: true, cosmetic: true }
    });
    const restoredCss = sandbox.document.adoptedStyleSheets.map(sheet => sheet.content).join('\n');
    assert.match(restoredCss, /\.restored-subscription-ad/);

    sandbox.__sendRuntimeMessage({
      type: 'CONFIG_UPDATE',
      config: { enabled: false }
    });
    assert.strictEqual(sandbox.document.adoptedStyleSheets.length, 0);
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

  await t.test('YouTube and Twitch host checks require exact host or subdomain', async (st) => {
    const fakeYoutube = createSandbox(null, {
      location: { hostname: 'notyoutube.com', href: 'https://notyoutube.com/' }
    });
    fakeYoutube.CONFIG.enabled = true;
    fakeYoutube.CONFIG.cosmetic = true;
    fakeYoutube.CONFIG.suppressWarnings = true;
    fakeYoutube.injectAllCSS();

    const fakeYoutubeCss = fakeYoutube.document.adoptedStyleSheets.map(sheet => sheet.content).join('\n');
    assert.doesNotMatch(fakeYoutubeCss, /ytd-enforcement-dialog-view-model/);

    const fakeTwitch = createSandbox(null, {
      location: { hostname: 'not-twitch.tv', href: 'https://not-twitch.tv/' }
    });
    fakeTwitch.CONFIG.enabled = true;
    fakeTwitch.CONFIG.cosmetic = true;
    fakeTwitch.injectAllCSS();

    const fakeTwitchCss = fakeTwitch.document.adoptedStyleSheets.map(sheet => sheet.content).join('\n');
    assert.doesNotMatch(fakeTwitchCss, /data-a-target="video-ad-label"/);

    const realTwitch = createSandbox(null, {
      location: { hostname: 'clips.twitch.tv', href: 'https://clips.twitch.tv/' }
    });
    realTwitch.CONFIG.enabled = true;
    realTwitch.CONFIG.cosmetic = true;
    realTwitch.injectAllCSS();

    const realTwitchCss = realTwitch.document.adoptedStyleSheets.map(sheet => sheet.content).join('\n');
    assert.match(realTwitchCss, /data-a-target="video-ad-label"/);
  });

  await t.test('De-AMP URL transforms only supported AMP viewer URLs', () => {
    const sandbox = createSandbox();

    assert.strictEqual(
      sandbox.getDeAmpRedirectUrl('https://www.google.com/amp/s/example.com/story'),
      'https://example.com/story'
    );
    assert.strictEqual(
      sandbox.getDeAmpRedirectUrl('https://google.com/amp/example.com/story'),
      'http://example.com/story'
    );
    assert.strictEqual(
      sandbox.getDeAmpRedirectUrl('https://example-com.cdn.ampproject.org/c/s/example.com/story'),
      'https://example.com/story'
    );
    assert.strictEqual(
      sandbox.getDeAmpRedirectUrl('https://publisher.example/amp/story'),
      null
    );
    assert.strictEqual(
      sandbox.getDeAmpRedirectUrl('https://google.evil.com/amp/s/example.com/story'),
      null
    );
  });

  await t.test('De-AMP skips current and target whitelisted domains', () => {
    const sandbox = createSandbox();
    const target = 'https://example.com/story';

    assert.strictEqual(
      sandbox.shouldSkipDeAmpRedirect(target, 'www.google.com', ['example.com']),
      true
    );
    assert.strictEqual(
      sandbox.shouldSkipDeAmpRedirect(target, 'www.google.com', ['google.com']),
      true
    );
    assert.strictEqual(
      sandbox.shouldSkipDeAmpRedirect(target, 'www.google.com', ['other.example']),
      false
    );
    assert.strictEqual(
      sandbox.shouldSkipDeAmpRedirect(target, 'www.google.com', ['bad/path', '-bad.example.com']),
      false
    );
  });

  await t.test('De-AMP redirects only when the opt-in toggle is enabled', async () => {
    const redirects = [];
    const location = {
      hostname: 'www.google.com',
      href: 'https://www.google.com/amp/s/example.com/story',
      replace: url => redirects.push(url)
    };

    createSandbox(null, {
      location,
      storage: {
        config: { enabled: true, deAmpLinks: true },
        whitelist: []
      }
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepStrictEqual(redirects, ['https://example.com/story']);

    redirects.length = 0;
    createSandbox(null, {
      location,
      storage: {
        config: { enabled: true, deAmpLinks: false },
        whitelist: []
      }
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepStrictEqual(redirects, []);
  });
});
