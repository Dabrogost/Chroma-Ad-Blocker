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

function loadScriptletEngine(storageState) {
  const registered = [];
  let changeListener = null;
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
      userScripts: {
        getScripts: async () => [],
        unregister: async () => {},
        register: async scripts => { registered.push(...scripts); }
      },
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
