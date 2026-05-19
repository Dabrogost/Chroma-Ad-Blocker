const test   = require('node:test');
const assert = require('node:assert');
const vm     = require('vm');

// ─── SCRIPTLET FUNCTION EXTRACTION ─────
// The scriptlet functions are pure JS — no chrome APIs, no imports at runtime.
// We extract them from the ES module by stripping the export keywords,
// then evaluate them in a vm context to test in isolation.

const fs   = require('fs');
const path = require('path');

const engineCode = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'scriptlets', 'engine.js'), 'utf8'
)
  .replace(/import[\s\S]*?from\s+['"][^'"]+['"];?\s*/g, '')
  .replace(/^export\s+/gm, '');

const fingerprintRandomizationCode = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'scriptlets', 'fingerprintRandomization.js'), 'utf8'
);

const plain = value => JSON.parse(JSON.stringify(value));

const libCode = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'scriptlets', 'lib.js'), 'utf8'
)
  .replace(/^export\s+function/gm, 'function')
  .replace(/^export\s+const\s+SCRIPTLET_MAP.*/ms, ''); // Strip Map export — not needed for unit tests

function makeWindow() {
  return {
    setTimeout:    (fn, d) => { try { fn(); } catch(e) {} return 1; },
    setInterval:   () => 1,
    clearTimeout:  () => {},
    clearInterval: () => {},
    fetch:         () => Promise.resolve({ ok: true }),
    Response:      class { constructor(b, o) { this.blob=b; this.status=o.status; } },
    Blob:          class { constructor(p, o) { this.parts=p; this.type=o.type; } },
    XMLHttpRequest: class { open() {} send() {} },
    eval:          (code) => code,
    location:      { hostname: 'test.example.com' },
    document: {
      querySelectorAll: () => [],
      documentElement: { setAttribute: () => {}, getAttribute: () => null }
    },
    MutationObserver: class { observe() {} }
  };
}

function runScriptlet(name, args, windowOverrides = {}) {
  const win = { ...makeWindow(), ...windowOverrides, console };
  win.window = win;
  const sandbox = win;
  vm.createContext(sandbox);
  vm.runInContext(libCode, sandbox);
  vm.runInContext(`${name}(${JSON.stringify(args)})`, sandbox);
  return sandbox;
}

function runFingerprintRandomization({
  language = 'en-US',
  languages = ['en-US', 'en'],
  hostname = 'www.example.com',
  saltBytes = [1, 2, 3, 4, 5, 6, 7, 8],
  exposeSeedForTest = false
} = {}) {
  const storage = new Map();
  const storageAccesses = [];
  const sandbox = {
    console,
    location: { hostname },
    sessionStorage: {
      getItem: key => {
        storageAccesses.push(['getItem', key]);
        return storage.get(key) || null;
      },
      setItem: (key, value) => {
        storageAccesses.push(['setItem', key]);
        storage.set(key, String(value));
      }
    },
    crypto: {
      getRandomValues: buffer => {
        for (let i = 0; i < buffer.length; i++) buffer[i] = saltBytes[i % saltBytes.length];
        return buffer;
      }
    },
    Uint8Array,
    Uint8ClampedArray
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__storageAccesses = storageAccesses;
  vm.createContext(sandbox);
  vm.runInContext(`
    const initialLanguage = ${JSON.stringify(language)};
    const initialLanguages = ${JSON.stringify(languages)};
    function Navigator() {}
    function getLanguage() { return initialLanguage; }
    function getLanguages() { return initialLanguages.slice(); }
    Object.defineProperty(Navigator.prototype, 'language', {
      get: getLanguage,
      configurable: true,
      enumerable: true
    });
    Object.defineProperty(Navigator.prototype, 'languages', {
      get: getLanguages,
      configurable: true,
      enumerable: true
    });
    self.Navigator = Navigator;
    self.navigator = new Navigator();
  `, sandbox);
  const code = exposeSeedForTest
    ? fingerprintRandomizationCode.replace(
      'const seed = fnv1a(seedScope + \'|\' + salt);',
      'const seed = fnv1a(seedScope + \'|\' + salt); self.__chromaFprTestSeedScope = seedScope; self.__chromaFprTestSeed = seed;'
    )
    : fingerprintRandomizationCode;
  vm.runInContext(code, sandbox);
  return sandbox;
}

// ─── ABORT-ON-PROPERTY-READ ─────
test('abort-on-property-read', async (t) => {
  await t.test('throws when target property is accessed', () => {
    const sandbox = runScriptlet('abortOnPropertyRead', ['adsbygoogle']);
    assert.throws(() => {
      vm.runInContext('window.adsbygoogle', sandbox);
    }, /ReferenceError/);
  });

  await t.test('does not throw for unrelated properties', () => {
    const sandbox = runScriptlet('abortOnPropertyRead', ['adsbygoogle']);
    assert.doesNotThrow(() => {
      vm.runInContext('window.location', sandbox);
    });
  });
});

// ─── ABORT-ON-PROPERTY-WRITE ─────
test('abort-on-property-write', async (t) => {
  await t.test('throws when target property is written', () => {
    const sandbox = runScriptlet('abortOnPropertyWrite', ['adblock_detected']);
    assert.throws(() => {
      vm.runInContext('window.adblock_detected = true', sandbox);
    }, /ReferenceError/);
  });
});

// ─── SET-CONSTANT ─────
test('set-constant', async (t) => {
  await t.test('sets boolean true', () => {
    const sandbox = runScriptlet('setConstant', ['myFlag', 'true']);
    const val = vm.runInContext('window.myFlag', sandbox);
    assert.strictEqual(val, true);
  });

  await t.test('sets boolean false', () => {
    const sandbox = runScriptlet('setConstant', ['myFlag', 'false']);
    const val = vm.runInContext('window.myFlag', sandbox);
    assert.strictEqual(val, false);
  });

  await t.test('sets numeric value', () => {
    const sandbox = runScriptlet('setConstant', ['myCount', '42']);
    const val = vm.runInContext('window.myCount', sandbox);
    assert.strictEqual(val, 42);
  });

  await t.test('value cannot be overwritten after set', () => {
    const sandbox = runScriptlet('setConstant', ['myFlag', 'false']);
    vm.runInContext('window.myFlag = true', sandbox); // Should be silently ignored
    const val = vm.runInContext('window.myFlag', sandbox);
    assert.strictEqual(val, false);
  });

  await t.test('sets noopFunc as a function', () => {
    const sandbox = runScriptlet('setConstant', ['myFunc', 'noopFunc']);
    const type = vm.runInContext('typeof window.myFunc', sandbox);
    assert.strictEqual(type, 'function');
  });
});

// ─── NO-SETTIMEOUT-IF ─────
test('no-setTimeout-if', async (t) => {
  await t.test('blocks matching setTimeout handler', () => {
    let callCount = 0;
    const win = makeWindow();
    win.setTimeout = (fn, d) => {
      callCount++;
      try { fn(); } catch(e) {}
      return 1;
    };
    const sandbox = runScriptlet('noSetTimeoutIf', ['adblockCheck'], win);
    vm.runInContext('window.setTimeout(function adblockCheck() {}, 1000)', sandbox);
    assert.strictEqual(callCount, 0, 'Matching setTimeout should be blocked');
  });

  await t.test('allows non-matching setTimeout handler', () => {
    let callCount = 0;
    const win = makeWindow();
    win.setTimeout = (fn, d) => { callCount++; return 1; };
    const sandbox = runScriptlet('noSetTimeoutIf', ['adblockCheck'], win);
    vm.runInContext('window.setTimeout(function unrelated() {}, 1000)', sandbox);
    assert.strictEqual(callCount, 1, 'Non-matching setTimeout should pass through');
  });
});

// ─── PREVENT-FETCH ─────
test('prevent-fetch', async (t) => {
  await t.test('blocks fetch to matching URL', async () => {
    let fetchCalled = false;
    const win = makeWindow();
    win.fetch = (url) => { fetchCalled = true; return Promise.resolve({}); };
    const sandbox = runScriptlet('preventFetch', ['analytics.example.com'], win);
    await vm.runInContext('window.fetch("https://analytics.example.com/track")', sandbox);
    assert.strictEqual(fetchCalled, false, 'Original fetch should not be called');
  });

  await t.test('allows fetch to non-matching URL', async () => {
    let fetchCalled = false;
    const win = makeWindow();
    win.fetch = (url) => { fetchCalled = true; return Promise.resolve({}); };
    const sandbox = runScriptlet('preventFetch', ['analytics.example.com'], win);
    await vm.runInContext('window.fetch("https://cdn.other.com/asset.js")', sandbox);
    assert.strictEqual(fetchCalled, true, 'Non-matching fetch should pass through');
  });
});

// ─── NO-EVAL-IF ─────
test('no-eval-if', async (t) => {
  await t.test('blocks eval containing pattern', () => {
    let evalCalled = false;
    const win = makeWindow();
    win.eval = (code) => { evalCalled = true; return code; };
    const sandbox = runScriptlet('noEvalIf', ['adblock'], win);
    const result = vm.runInContext('window.eval("checkadblock()")', sandbox);
    assert.strictEqual(evalCalled, false);
    assert.strictEqual(result, undefined);
  });

  await t.test('allows eval not containing pattern', () => {
    let evalCalled = false;
    const win = makeWindow();
    win.eval = (code) => { evalCalled = true; return code; };
    const sandbox = runScriptlet('noEvalIf', ['adblock'], win);
    vm.runInContext('window.eval("doSomethingElse()")', sandbox);
    assert.strictEqual(evalCalled, true);
  });
});

test('scriptlet native wrapper camouflage', async (t) => {
  await t.test('preserves function names for patched globals', () => {
    const cases = [
      {
        scriptlet: 'noSetTimeoutIf',
        args: ['adblockCheck'],
        win: {
          setTimeout: function setTimeout(fn) { try { fn(); } catch (e) {} return 1; }
        },
        expr: 'window.setTimeout.name',
        expected: 'setTimeout'
      },
      {
        scriptlet: 'noSetIntervalIf',
        args: ['adblockCheck'],
        win: {
          setInterval: function setInterval() { return 1; }
        },
        expr: 'window.setInterval.name',
        expected: 'setInterval'
      },
      {
        scriptlet: 'preventFetch',
        args: ['analytics.example.com'],
        win: {
          fetch: function fetch() { return Promise.resolve({}); }
        },
        expr: 'window.fetch.name',
        expected: 'fetch'
      },
      {
        scriptlet: 'preventWindowOpen',
        args: ['ads.example.com'],
        win: {
          open: function open() { return { focus() {} }; }
        },
        expr: 'window.open.name',
        expected: 'open'
      },
      {
        scriptlet: 'preventRequestAnimationFrame',
        args: ['adblockCheck'],
        win: {
          requestAnimationFrame: function requestAnimationFrame() { return 1; }
        },
        expr: 'window.requestAnimationFrame.name',
        expected: 'requestAnimationFrame'
      },
      {
        scriptlet: 'noEvalIf',
        args: ['adblock'],
        win: {
          eval: function evalNative(code) { return code; }
        },
        expr: 'window.eval.name',
        expected: 'evalNative'
      }
    ];

    for (const c of cases) {
      const sandbox = runScriptlet(c.scriptlet, c.args, c.win);
      assert.strictEqual(vm.runInContext(c.expr, sandbox), c.expected, c.scriptlet);
    }
  });

  await t.test('preserves XMLHttpRequest constructor name and source', () => {
    const win = makeWindow();
    win.XMLHttpRequest = class XMLHttpRequest { open() {} send() {} };
    const origSource = win.XMLHttpRequest.toString();

    const sandbox = runScriptlet('preventXhr', ['analytics.example.com'], win);

    assert.strictEqual(vm.runInContext('window.XMLHttpRequest.name', sandbox), 'XMLHttpRequest');
    assert.strictEqual(vm.runInContext('window.XMLHttpRequest.toString()', sandbox), origSource);
    assert.strictEqual(vm.runInContext('new window.XMLHttpRequest().open.name', sandbox), 'open');
    assert.strictEqual(vm.runInContext('new window.XMLHttpRequest().send.name', sandbox), 'send');
  });

  await t.test('preserves m3u-prune patched fetch and XHR names', () => {
    const win = makeWindow();
    win.fetch = function fetch() {
      return Promise.resolve({ clone() {}, text() {} });
    };
    win.XMLHttpRequest = class XMLHttpRequest {
      open() {}
      send() {}
      addEventListener() {}
    };

    const sandbox = runScriptlet('m3uPrune', ['ad-segment'], win);

    assert.strictEqual(vm.runInContext('window.fetch.name', sandbox), 'fetch');
    assert.strictEqual(vm.runInContext('window.XMLHttpRequest.name', sandbox), 'XMLHttpRequest');
    assert.strictEqual(vm.runInContext('new window.XMLHttpRequest().open.name', sandbox), 'open');
  });

  await t.test('preserves patched prototype method names', () => {
    function EventTarget() {}
    EventTarget.prototype.addEventListener = function addEventListener() {};

    function Element() {}
    Element.prototype.setAttribute = function setAttribute() {};
    Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    };

    function HTMLImageElement() {}
    HTMLImageElement.prototype = Object.create(Element.prototype);
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      get() { return this._src || ''; },
      set(value) { this._src = value; },
      configurable: true
    });

    let sandbox = runScriptlet('preventAddEventListener', ['click'], { EventTarget });
    assert.strictEqual(vm.runInContext('EventTarget.prototype.addEventListener.name', sandbox), 'addEventListener');

    sandbox = runScriptlet('preventElementSrcLoading', ['img', 'ad.png'], { Element, HTMLImageElement });
    assert.strictEqual(vm.runInContext('Element.prototype.setAttribute.name', sandbox), 'setAttribute');

    sandbox = runScriptlet('spoofCss', ['*', 'width', '10'], { Element });
    assert.strictEqual(vm.runInContext('Element.prototype.getBoundingClientRect.name', sandbox), 'getBoundingClientRect');
  });

  await t.test('preserves JSON.parse wrapper name', () => {
    const sandbox = runScriptlet('jsonPrune', ['adSlots']);
    assert.strictEqual(vm.runInContext('JSON.parse.name', sandbox), 'parse');
  });
});

test('reddit-promoted-ads', async (t) => {
  await t.test('crawls from promoted marker and hides the containing post', () => {
    const makeElement = ({ tag = 'div', id = '', className = '', text = '' } = {}) => ({
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id,
      className,
      textContent: text,
      parentElement: null,
      children: [],
      attrs: {},
      style: {
        display: '',
        setProperty(name, value) {
          if (name === 'display') this.display = value;
        }
      },
      appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
      },
      getAttribute(name) {
        return this.attrs[name] || null;
      },
      setAttribute(name, value) {
        this.attrs[name] = String(value);
      },
      matches(selector) {
        return selector === '.promoted-name-container, [class*="promoted-name-container"]'
          && this.className.includes('promoted-name-container');
      },
      closest(selector) {
        let current = this;
        while (current) {
          if (selector.includes('shreddit-post') && current.tagName === 'SHREDDIT-POST') return current;
          if (selector.includes('[id^="t3_"]') && current.id.startsWith('t3_')) return current;
          current = current.parentElement;
        }
        return null;
      },
      querySelectorAll(selector) {
        const out = [];
        const walk = (node) => {
          for (const child of node.children) {
            if (child.matches(selector)) out.push(child);
            walk(child);
          }
        };
        walk(this);
        return out;
      },
      querySelector(selector) {
        let found = null;
        const walk = (node) => {
          if (found) return;
          if (selector.startsWith('#') && node.id === selector.slice(1)) {
            found = node;
            return;
          }
          for (const child of node.children) walk(child);
        };
        walk(this);
        return found;
      }
    });

    const documentElement = makeElement({ tag: 'html' });
    const body = documentElement.appendChild(makeElement({ tag: 'body' }));
    const promotedPost = body.appendChild(makeElement({ tag: 'shreddit-post', id: 't3_promoted' }));
    const wrapper = promotedPost.appendChild(makeElement({ className: 'flex' }));
    wrapper.appendChild(makeElement({ className: 'promoted-name-container flex', text: 'Promoted' }));
    const regularPost = body.appendChild(makeElement({ tag: 'shreddit-post', id: 't3_regular' }));
    regularPost.appendChild(makeElement({ className: 'title', text: 'Regular post' }));

    const document = {
      nodeType: 9,
      documentElement,
      body,
      querySelectorAll: selector => documentElement.querySelectorAll(selector),
      querySelector: selector => documentElement.querySelector(selector),
      addEventListener: () => {}
    };

    const sandbox = runScriptlet('redditPromotedAds', [], {
      document,
      MutationObserver: class { observe() {} },
      setTimeout
    });

    const promoted = sandbox.document.querySelector('#t3_promoted');
    const regular = sandbox.document.querySelector('#t3_regular');

    assert.strictEqual(promoted.getAttribute('data-chroma-reddit-promoted'), '1');
    assert.strictEqual(promoted.getAttribute('aria-hidden'), 'true');
    assert.strictEqual(promoted.style.display, 'none');
    assert.notStrictEqual(regular.style.display, 'none');
  });
});

function loadScriptletEngine(storageState, options = {}) {
  const registered = [];
  let changeListener = null;
  const userScripts = Object.prototype.hasOwnProperty.call(options, 'userScripts')
    ? options.userScripts
    : {
      getScripts: async () => [],
      unregister: async () => {},
      register: async scripts => { registered.push(...scripts); }
    };
  const sandbox = {
    SCRIPTLET_MAP: new Map([
      ['set-constant', function setConstant() {}]
    ]),
    chrome: {
      storage: {
        local: {
          get: async (keys) => {
            const out = {};
            for (const key of keys) out[key] = storageState[key];
            return out;
          }
        },
        onChanged: {
          addListener: fn => { changeListener = fn; }
        }
      },
      userScripts,
      scripting: {
        getRegisteredContentScripts: async () => [],
        unregisterContentScripts: async () => {},
        registerContentScripts: async () => {},
        updateContentScripts: async () => {}
      }
    },
    console,
    Promise,
    setTimeout,
    clearTimeout
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(engineCode, sandbox);
  return { sandbox, registered, getChangeListener: () => changeListener };
}

test('scriptlet engine whitelist hardening', async (t) => {
  await t.test('adds main whitelist excludeMatches to subscription userScripts', async () => {
    const { sandbox, registered } = loadScriptletEngine({
      subscriptionScriptletRules: [{ scriptlet: 'set-constant', args: ['foo', 'true'], domains: ['example.org'] }],
      whitelist: ['example.com'],
      config: {},
      fprWhitelist: []
    });

    await sandbox.initScriptletEngine();

    assert.strictEqual(registered.length, 1);
    assert.deepStrictEqual(plain(registered[0].excludeMatches), [
      '*://example.com/*',
      '*://*.example.com/*'
    ]);
  });

  await t.test('whitelist changes re-sync subscription userScripts', async () => {
    const storageState = {
      subscriptionScriptletRules: [{ scriptlet: 'set-constant', args: ['foo', 'true'] }],
      whitelist: [],
      config: {},
      fprWhitelist: []
    };
    const { registered, getChangeListener } = loadScriptletEngine(storageState);

    storageState.whitelist = ['example.com'];
    getChangeListener()({ whitelist: { oldValue: [], newValue: ['example.com'] } }, 'local');
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.strictEqual(registered.length, 1);
    assert.deepStrictEqual(plain(registered[0].excludeMatches), [
      '*://example.com/*',
      '*://*.example.com/*'
    ]);
  });
});

test('scriptlet engine userScripts API availability', async (t) => {
  await t.test('missing chrome.userScripts does not throw during init', async () => {
    const { sandbox, registered } = loadScriptletEngine({
      subscriptionScriptletRules: [{ scriptlet: 'set-constant', args: ['foo', 'true'] }],
      whitelist: [],
      config: {},
      fprWhitelist: []
    }, {
      userScripts: undefined
    });

    await assert.doesNotReject(() => sandbox.initScriptletEngine());
    assert.strictEqual(registered.length, 0);
  });

  await t.test('partial chrome.userScripts object is treated as unavailable', async () => {
    let getScriptsCalled = false;
    let registerCalled = false;
    const cases = [
      {
        register: async () => {
          registerCalled = true;
        }
      },
      {
        getScripts: async () => {
          getScriptsCalled = true;
          return [];
        },
        register: async () => {
          registerCalled = true;
        }
      }
    ];

    for (const userScripts of cases) {
      const { sandbox, registered } = loadScriptletEngine({
        subscriptionScriptletRules: [{ scriptlet: 'set-constant', args: ['foo', 'true'] }],
        whitelist: [],
        config: {},
        fprWhitelist: []
      }, { userScripts });

      await assert.doesNotReject(() => sandbox.initScriptletEngine());
      assert.strictEqual(registered.length, 0);
    }

    assert.strictEqual(getScriptsCalled, false);
    assert.strictEqual(registerCalled, false);
  });

  await t.test('syncUserScripts registers stored rules after API becomes available', async () => {
    const { sandbox, registered } = loadScriptletEngine({
      subscriptionScriptletRules: [{ scriptlet: 'set-constant', args: ['foo', 'true'] }],
      whitelist: [],
      config: {},
      fprWhitelist: []
    }, {
      userScripts: undefined
    });

    await sandbox.initScriptletEngine();
    assert.strictEqual(registered.length, 0);

    sandbox.chrome.userScripts = {
      getScripts: async () => [],
      unregister: async () => {},
      register: async scripts => { registered.push(...scripts); }
    };

    await sandbox.syncUserScripts();

    assert.strictEqual(registered.length, 1);
    assert.strictEqual(registered[0].id, 'scriptlet_1');
  });

  await t.test('recoverUserScriptsIfNeeded only syncs an empty registry with stored rules', async () => {
    const { sandbox, registered } = loadScriptletEngine({
      subscriptionScriptletRules: [{ scriptlet: 'set-constant', args: ['foo', 'true'] }],
      whitelist: [],
      config: {},
      fprWhitelist: []
    });

    const recovered = await sandbox.recoverUserScriptsIfNeeded();

    assert.strictEqual(recovered, true);
    assert.strictEqual(registered.length, 1);
  });

  await t.test('recoverUserScriptsIfNeeded skips when scripts are already registered', async () => {
    let registerCalled = false;
    const { sandbox } = loadScriptletEngine({
      subscriptionScriptletRules: [{ scriptlet: 'set-constant', args: ['foo', 'true'] }],
      whitelist: [],
      config: {},
      fprWhitelist: []
    }, {
      userScripts: {
        getScripts: async () => [{ id: 'scriptlet_1' }],
        unregister: async () => {},
        register: async () => { registerCalled = true; }
      }
    });

    const recovered = await sandbox.recoverUserScriptsIfNeeded();

    assert.strictEqual(recovered, false);
    assert.strictEqual(registerCalled, false);
  });
});

test('fingerprint randomization language normalization', async (t) => {
  await t.test('does not create page-visible storage artifacts', () => {
    const sandbox = runFingerprintRandomization();

    assert.deepStrictEqual(sandbox.__storageAccesses, []);
  });

  await t.test('uses full hostname instead of rough public suffix collapsing', () => {
    const first = runFingerprintRandomization({ hostname: 'shop.example.co.uk', exposeSeedForTest: true });
    const second = runFingerprintRandomization({ hostname: 'news.other.co.uk', exposeSeedForTest: true });

    assert.strictEqual(first.__chromaFprTestSeedScope, 'shop.example.co.uk');
    assert.strictEqual(second.__chromaFprTestSeedScope, 'news.other.co.uk');
    assert.notStrictEqual(first.__chromaFprTestSeed, second.__chromaFprTestSeed);
  });

  await t.test('rotates the seed when a fresh document salt is generated', () => {
    const first = runFingerprintRandomization({
      hostname: 'shop.example.com',
      saltBytes: [1, 2, 3, 4, 5, 6, 7, 8],
      exposeSeedForTest: true
    });
    const second = runFingerprintRandomization({
      hostname: 'shop.example.com',
      saltBytes: [8, 7, 6, 5, 4, 3, 2, 1],
      exposeSeedForTest: true
    });

    assert.strictEqual(first.__chromaFprTestSeedScope, 'shop.example.com');
    assert.strictEqual(second.__chromaFprTestSeedScope, 'shop.example.com');
    assert.notStrictEqual(first.__chromaFprTestSeed, second.__chromaFprTestSeed);
  });

  await t.test('does not hard-spoof WebGL vendor or renderer values', () => {
    assert.doesNotMatch(fingerprintRandomizationCode, /SPOOFED_VENDOR|SPOOFED_RENDERER|UNMASKED_VENDOR_WEBGL|UNMASKED_RENDERER_WEBGL/);
    assert.doesNotMatch(fingerprintRandomizationCode, /Google Inc\. \(Intel\)|ANGLE \(Intel/);
    assert.doesNotMatch(fingerprintRandomizationCode, /replaceProtoMethod\(GL[12]\.prototype, 'getParameter'/);
  });

  await t.test('reports the top preferred language plus base language', () => {
    const sandbox = runFingerprintRandomization({
      language: 'EN_us',
      languages: ['EN_us', 'ko-KR', 'es-ES']
    });

    assert.strictEqual(vm.runInContext('navigator.language', sandbox), 'en-US');
    assert.deepStrictEqual(plain(vm.runInContext('navigator.languages', sandbox)), ['en-US', 'en']);
    assert.strictEqual(vm.runInContext('Object.isFrozen(navigator.languages)', sandbox), true);
  });

  await t.test('keeps single base-language preferences collapsed to one value', () => {
    const sandbox = runFingerprintRandomization({
      language: 'fr',
      languages: ['fr', 'en-US']
    });

    assert.strictEqual(vm.runInContext('navigator.language', sandbox), 'fr');
    assert.deepStrictEqual(plain(vm.runInContext('navigator.languages', sandbox)), ['fr']);
  });
});
