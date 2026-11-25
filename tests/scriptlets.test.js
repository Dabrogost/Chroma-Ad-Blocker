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
  win.window = new Proxy(win, {});
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
test('bundled anti-detection rules', async (t) => {
  const parser = {};
  vm.createContext(parser);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/subscriptions/parser.js'), 'utf8')
    .replace(/^export\s+/gm, ''), parser);
  const { scriptletRules } = parser.parseList(fs.readFileSync(
    path.join(__dirname, '../extension/subscriptions/chroma-lib.txt'), 'utf8'));
  function page(hostname, overrides = {}) {
    const pendingTimers = [];
    const base = makeWindow();
    const sandbox = { ...base, console,
      setTimeout: (callback) => { pendingTimers.push(callback); return pendingTimers.length; },
      ...overrides,
      document: { ...base.document, ...(overrides.document || {}) } };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/scriptlets/lib.js'), 'utf8')
      .replace(/^export\s+/gm, ''), sandbox);
    for (const rule of scriptletRules) {
      if (!rule.domains?.some(domain => hostname === domain || hostname.endsWith('.' + domain))) continue;
      vm.runInContext(`SCRIPTLET_MAP.get(${JSON.stringify(rule.scriptlet)})(${JSON.stringify(rule.args)})`, sandbox);
    }
    return { sandbox, pendingTimers };
  }

  await t.test('Dailymotion canary stays true and only its detector timer is suppressed', () => {
    for (const host of ['www.dailymotion.com', 'geo.dailymotion.com']) {
      const { sandbox, pendingTimers } = page(host);
      assert.strictEqual(vm.runInContext('__NATIVEADS_CANARY__', sandbox), true);
      vm.runInContext(`
        __NATIVEADS_CANARY__ = false;
        setTimeout(function adBlockerDetection() { window.blocked = true; }, 100);
        setTimeout(function playerProgress() { window.progress = true; }, 100);
      `, sandbox);
      assert.strictEqual(vm.runInContext('__NATIVEADS_CANARY__', sandbox), true);
      assert.strictEqual(pendingTimers.length, 1);
      pendingTimers[0]();
      assert.strictEqual(sandbox.blocked, undefined);
      assert.strictEqual(sandbox.progress, true);
    }
  });

  await t.test('MLive stops detector access and recovery scripts but permits normal DOM work', () => {
    const { sandbox } = page('www.mlive.com');
    vm.runInContext(`
      _sp_ = { consent: 'unchanged' };
      admiral('engage');
    `, sandbox);
    assert.throws(() => vm.runInContext('_sp_._networkListenerData', sandbox), /ReferenceError/);
    assert.strictEqual(vm.runInContext('_sp_.consent', sandbox), 'unchanged');
    assert.strictEqual(sandbox.admrlLoaded, true);
    sandbox.document.currentScript = { textContent: 'load admiral recovery' };
    assert.throws(() => vm.runInContext('document.createElement', sandbox), /ReferenceError/);
    sandbox.document.currentScript = { textContent: 'render article' };
    assert.doesNotThrow(() => vm.runInContext('document.createElement', sandbox));
  });

  await t.test('lookalike and unrelated hosts receive no site hooks', () => {
    for (const host of ['notdailymotion.com', 'dailymotion.com.example', 'notmlive.com', 'example.com']) {
      const { sandbox } = page(host);
      assert.strictEqual(sandbox.__NATIVEADS_CANARY__, undefined);
      assert.strictEqual(sandbox.admiral, undefined);
      assert.strictEqual(Object.getOwnPropertyDescriptor(sandbox, '_sp_'), undefined);
    }
  });

  await t.test('Pinterest rules prune home/search feeds and startup maps without changing organic pins', () => {
    const organic = { id: 'organic', title: 'Sponsored post design ideas', images: { orig: 'pin.jpg' } };
    const ad = { id: 'promoted', pin_promotion_id: 'campaign-1', images: { orig: 'ad.jpg' } };
    const payloads = [
      [{ resource_response: { data: [ad, ad, organic, ad], bookmark: 'next' } },
        { resource_response: { data: [organic], bookmark: 'next' } }],
      [{ resource_response: { data: { results: [ad, organic], bookmark: 'search-next' } } },
        { resource_response: { data: { results: [organic], bookmark: 'search-next' } } }],
      [{ initialReduxState: { pins: { a: ad, b: organic }, resources: {
        UserHomefeedResource: { first: { data: [ad, organic] }, second: { data: [organic, ad] } }
      }, user: { id: 'user' } } },
        { initialReduxState: { pins: { b: organic }, resources: {
          UserHomefeedResource: { first: { data: [organic] }, second: { data: [organic] } }
        }, user: { id: 'user' } } }],
      [{ unrelated: { data: [ad, organic] } }, { unrelated: { data: [ad, organic] } }]
    ];
    for (const host of ['pinterest.com', 'www.pinterest.com', 'notpinterest.com', 'pinterest.com.example']) {
      const { sandbox } = page(host);
      for (const [before, after] of payloads) {
        sandbox.input = JSON.stringify(before);
        const result = vm.runInContext('JSON.parse(input)', sandbox);
        assert.deepStrictEqual(plain(result), host === 'pinterest.com' || host === 'www.pinterest.com' ? after : before);
      }
    }
  });

  await t.test('streaming mirrors and embedded players block popunders, aclib, and iframe window.open', () => {
    for (const host of [
      'totalsportekl.is',
      'live4.totalsportek.today',
      'live.totalsportek.gives',
      'maindesign.pw',
      'ehgembxe.cfd',
      'embedcenter.st',
      's3.vertex.st',
      'nizar.nexa.st',
      'lineagest.click',
      'example.com'
    ]) {
      let realOpens = 0;
      let realChildOpens = 0;
      function EventTarget() {}
      EventTarget.prototype.addEventListener = function addEventListener() {};
      const winTarget = new EventTarget();
      const childWin = {
        open: function open() { realChildOpens++; return { closed: false }; }
      };
      function HTMLIFrameElement() {}
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
        get: function contentWindow() { return childWin; },
        configurable: true
      });
      const iframe = new HTMLIFrameElement();

      const { sandbox } = page(host, {
        EventTarget,
        HTMLIFrameElement,
        iframe,
        winTarget,
        MutationObserver: class { observe() {} takeRecords() { return []; } disconnect() {} },
        NodeFilter: { SHOW_ELEMENT: 1 },
        open: function open() { realOpens++; return { closed: false }; },
        document: {
          nodeType: 9,
          readyState: 'complete',
          currentScript: null,
          createElement: tag => ({ tag }),
          createTreeWalker: () => ({ nextNode: () => null }),
          addEventListener: () => {},
          removeEventListener: () => {}
        }
      });

      const protectedHost = host !== 'example.com';
      if (protectedHost) {
        assert.deepStrictEqual(plain(vm.runInContext('window.aclib', sandbox)), {}, host);

        sandbox.document.currentScript = { textContent: 'const cfg = [["popundersPerIP", "0"]]; document.createElement("script");' };
        assert.throws(() => vm.runInContext('document.createElement("script")', sandbox), /ReferenceError/, host);

        sandbox.document.currentScript = { textContent: 'https://llvpn.com/tag.min.js' };
        assert.throws(() => vm.runInContext('document.createElement("script")', sandbox), /ReferenceError/, host);

        sandbox.document.currentScript = { textContent: '/* adserverDomain */' };
        assert.throws(() => vm.runInContext('winTarget.addEventListener("click", () => {})', sandbox), /ReferenceError/, host);

        sandbox.document.currentScript = { textContent: 'localStorage.setItem("unloaded_at", "1");' };
        assert.throws(() => vm.runInContext('winTarget.addEventListener("unload", () => {})', sandbox), /ReferenceError/, host);

        sandbox.document.currentScript = { textContent: 'console.log("normal player");' };
        assert.doesNotThrow(() => vm.runInContext('document.createElement("video")', sandbox), host);

        const topPop = vm.runInContext('window.open("https://ads.example/pop", "_blank", "width=800,height=600")', sandbox);
        const childPop = vm.runInContext('iframe.contentWindow.open("about:blank", "pop", "width=800,height=600")', sandbox);
        assert.strictEqual(topPop.closed, true, host);
        assert.strictEqual(childPop.closed, true, host);
        assert.strictEqual(realOpens, 0, host);
        assert.strictEqual(realChildOpens, 0, host);
      } else {
        assert.strictEqual(sandbox.aclib, undefined);
        const topPop = vm.runInContext('window.open("https://ads.example/pop", "_blank")', sandbox);
        const childPop = vm.runInContext('iframe.contentWindow.open("about:blank", "pop")', sandbox);
        assert.strictEqual(topPop.closed, false);
        assert.strictEqual(childPop.closed, false);
        assert.strictEqual(realOpens, 1);
        assert.strictEqual(realChildOpens, 1);
      }
    }
  });

  await t.test('nflbite and totalsportek mirrors defuse mousedown shown_at hijack and set shown_at timestamp', () => {
    for (const host of ['links.nflbite.run', 'nflbite.is', 'live.totalsportek.gives', 'live5.totalsportek.vg']) {
      const storage = {};
      const listeners = [];
      function EventTarget() {}
      EventTarget.prototype.addEventListener = function addEventListener(type, fn) {
        listeners.push({ type, fn });
      };
      const { sandbox } = page(host, {
        EventTarget,
        MutationObserver: class { observe() {} takeRecords() { return []; } disconnect() {} },
        NodeFilter: { SHOW_ELEMENT: 1 },
        document: {
          nodeType: 9,
          readyState: 'complete',
          currentScript: null,
          createElement: tag => ({ tag }),
          createTreeWalker: () => ({ nextNode: () => null }),
          addEventListener: () => {},
          removeEventListener: () => {}
        },
        localStorage: {
          getItem: (k) => storage[k] ?? null,
          setItem: (k, v) => { storage[k] = String(v); }
        }
      });
      assert.strictEqual(storage.shown_at, '9999999999999', host);

      const target = new EventTarget();
      const adMousedownListener = function r() {
        if (!localStorage.getItem('shown_at') || Date.now() - Number(localStorage.getItem('shown_at')) > 36e5) {
          window.open('https://ad.example');
        }
      };
      target.addEventListener('mousedown', adMousedownListener);
      assert.strictEqual(listeners.some(l => l.fn === adMousedownListener), false, host);
    }
  });
});

test('remove-node-text clears matching text promptly without deleting nodes', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  const { window } = dom;
  try {
    // Injection can precede the document element.
    window.document.documentElement.remove();
    window.eval(libCode + ';window.removeNodeText = removeNodeText;');
    window.removeNodeText(['script', '/adserverDomain/gi', 'stay', '1']);
    const html = window.document.createElement('html');
    html.innerHTML = `<head>
      <script id="one">ADSERVERDOMAIN</script><script id="two">adserverDomain</script>
      <script id="player">playVideo()</script></head><body>
      <p id="text">adserverDomain</p>
      <template><script>adserverDomain</script></template></body>`;
    window.document.append(html);
    await new Promise(resolve => setImmediate(resolve));
    for (const id of ['one', 'two']) assert.strictEqual(window.document.getElementById(id).textContent, '');
    assert.strictEqual(window.document.getElementById('player').textContent, 'playVideo()');
    assert.strictEqual(window.document.getElementById('text').textContent, 'adserverDomain');
    assert.strictEqual(window.document.querySelector('template').content.querySelector('script').textContent, '');
    const later = window.document.createElement('script');
    later.textContent = 'adserverDomain';
    window.document.body.append(later);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(later.textContent, '');
    assert.strictEqual(later.isConnected, true);
    // Live HTTP responses can deliver the tag and its text in separate chunks.
    const streamed = window.document.createElement('script');
    window.document.head.append(streamed);
    await new Promise(resolve => setImmediate(resolve));
    const chunk = window.document.createTextNode('adserver');
    streamed.append(chunk);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(streamed.textContent, 'adserver');
    chunk.appendData('Domain');
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(streamed.textContent, '');
    // Discard the remaining chunks too, even without another signature.
    streamed.append(window.document.createTextNode('window.open("late-ad")'));
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(streamed.textContent, '');
    const secondChunk = window.document.createTextNode('adserverDomain');
    streamed.append(secondChunk);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(streamed.textContent, '');
  } finally { window.close(); }
});

test('remove-node-text stops after parsing unless stay is requested', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  const { window } = dom;
  try {
    window.eval(libCode + ';window.removeNodeText = removeNodeText;');
    window.removeNodeText(['script', 'adserverDomain']);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(window.document.readyState, 'complete');
    const later = window.document.createElement('script');
    later.textContent = 'adserverDomain';
    window.document.body.append(later);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(later.textContent, 'adserverDomain');
    assert.doesNotThrow(() => window.removeNodeText(['script', '/[/']));
  } finally { window.close(); }
});

test('json-prune path operators', async (t) => {
  function parse(paths, value) {
    const sandbox = runScriptlet('jsonPrune', [paths]);
    sandbox.input = JSON.stringify(value);
    return plain(vm.runInContext('JSON.parse(input)', sandbox));
  }

  await t.test('keeps exact-path deletion and adds array/object traversal', () => {
    assert.deepStrictEqual(parse('adSlots nested.ad nested.items.[].ad objects.*.ad', {
      adSlots: [], nested: { ad: 1, keep: true, items: [{ ad: 1, id: 1 }, null, { id: 2 }] },
      objects: { first: { ad: 1, keep: 1 }, second: { keep: 2 } }
    }), { nested: { keep: true, items: [{ id: 1 }, null, { id: 2 }] },
      objects: { first: { keep: 1 }, second: { keep: 2 } } });
  });

  await t.test('removes whole matching entries and compacts arrays, using property presence', () => {
    assert.deepStrictEqual(parse('items.[-].ad entries.{-}.ad', {
      items: [{ ad: 'a' }, { ad: null }, { id: 1 }, null, 42, { ad: false }, { ad: 'b' }],
      entries: { a: { ad: 1 }, b: { id: 2 }, c: null }
    }), { items: [{ id: 1 }, null, 42], entries: { b: { id: 2 }, c: null } });
  });

  await t.test('checks nested predicates without editing surviving entries', () => {
    const keep = { children: [{ metadata: {} }, null] };
    assert.deepStrictEqual(parse('items.[-].children.[].metadata.ad', {
      items: [{ children: [{ metadata: { ad: 1 } }] }, keep]
    }), { items: [keep] });
  });

  await t.test('leaves missing paths, wrong container types and primitive JSON unchanged', () => {
    for (const value of [null, 7, 'text', [], { items: { ad: 1 }, entries: [{ ad: 1 }] }]) {
      assert.deepStrictEqual(parse('missing.ad items.[-].ad entries.{-}.ad', value), value);
    }
  });

  await t.test('honors revivers and preserves native parse errors', () => {
    const sandbox = runScriptlet('jsonPrune', ['items.[-].ad']);
    const result = vm.runInContext(`JSON.parse('{"items":[{"id":1,"ad":true},{"id":2}]}',
      (key, value) => key === 'id' ? value * 10 : value)`, sandbox);
    assert.deepStrictEqual(plain(result), { items: [{ id: 20 }] });
    assert.throws(() => vm.runInContext('JSON.parse("invalid")', sandbox), { name: 'SyntaxError' });
    assert.throws(() => vm.runInContext('JSON.parse("{}", () => { throw new Error("reviver"); })', sandbox), /reviver/);
    assert.doesNotThrow(() => vm.runInContext(`JSON.parse('{"items":[{"ad":true}]}',
      (key, value) => value && typeof value === 'object' ? Object.freeze(value) : value)`, sandbox));
  });

  await t.test('does not traverse inherited properties or match inherited ad markers', () => {
    const sandbox = runScriptlet('jsonPrune', ['constructor.prototype.keep items.[-].ad']);
    const result = vm.runInContext(`
      Object.prototype.keep = true;
      Object.prototype.ad = true;
      JSON.parse('{"items":[{"id":1},{"ad":true}]}');
    `, sandbox);
    assert.deepStrictEqual(plain(result), { items: [{ id: 1 }] });
    assert.strictEqual(vm.runInContext('Object.prototype.keep', sandbox), true);
  });
});

test('abort-on-property-read', async (t) => {
  await t.test('follows late and replaced publisher namespaces without fabricating them', () => {
    const sandbox = runScriptlet('abortOnPropertyRead', ['_sp_._networkListenerData']);
    assert.strictEqual(vm.runInContext('window._sp_', sandbox), undefined);
    for (const value of ['{}', 'null', '42', 'function publisher() {}', '{ consent: true }']) {
      vm.runInContext(`window._sp_ = ${value}`, sandbox);
      if (value === 'null' || value === '42') continue;
      assert.throws(() => vm.runInContext('window._sp_._networkListenerData', sandbox), /ReferenceError/);
    }
    assert.strictEqual(vm.runInContext('window._sp_.consent', sandbox), true);
  });

  await t.test('preserves existing accessors and protects deeper replacements', () => {
    let publisher = { nested: { unrelated: 7 } };
    const win = makeWindow();
    Object.defineProperty(win, '_sp_', {
      configurable: true,
      get: () => publisher,
      set: value => { publisher = value; }
    });
    // runScriptlet spreads its overrides; install accessors inside the realm.
    const sandbox = runScriptlet('abortOnPropertyRead', ['unused']);
    sandbox.publisher = win;
    vm.runInContext(`
      Object.defineProperty(window, '_sp_', Object.getOwnPropertyDescriptor(publisher, '_sp_'));
      abortOnPropertyRead(['_sp_.nested.detect']);
    `, sandbox);
    assert.strictEqual(vm.runInContext('_sp_.nested.unrelated', sandbox), 7);
    assert.throws(() => vm.runInContext('_sp_.nested.detect', sandbox), /ReferenceError/);
    vm.runInContext('_sp_ = { nested: { unrelated: 9 } }', sandbox);
    assert.strictEqual(publisher.nested.unrelated, 9);
    vm.runInContext('_sp_.nested = {}', sandbox);
    assert.throws(() => vm.runInContext('_sp_.nested.detect', sandbox), /ReferenceError/);
  });

  await t.test('does not eagerly evaluate configurable intermediate getters at install time', () => {
    const sandbox = runScriptlet('abortOnPropertyRead', ['unused']);
    vm.runInContext(`
      var getterCalls = 0;
      var ready = false;
      Object.defineProperty(window, 'lazyNs', {
        configurable: true,
        get() {
          getterCalls++;
          if (!ready) throw new Error('not ready yet');
          return { detect: 'blocked', safe: 'ok' };
        }
      });
      abortOnPropertyRead(['lazyNs.detect']);
    `, sandbox);

    assert.strictEqual(vm.runInContext('getterCalls', sandbox), 0);
    vm.runInContext('ready = true', sandbox);
    assert.strictEqual(vm.runInContext('lazyNs.safe', sandbox), 'ok');
    assert.throws(() => vm.runInContext('lazyNs.detect', sandbox), /ReferenceError/);
  });

  await t.test('leaves non-configurable properties usable', () => {
    const root = {};
    Object.defineProperty(root, 'locked', { value: 7, configurable: false });
    const sandbox = runScriptlet('abortOnPropertyRead', ['root.locked'], { root });
    assert.strictEqual(vm.runInContext('root.locked', sandbox), 7);
  });

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

// ─── ABORT-CURRENT-SCRIPT ─────
test('abort-current-script', async (t) => {
  await t.test('stacks multiple rules on the same property without overwriting earlier ones', () => {
    const originalWrite = () => 'ok';
    const doc = {
      write: originalWrite,
      currentScript: null,
      querySelectorAll: () => [],
      documentElement: { setAttribute: () => {}, getAttribute: () => null }
    };
    const sandbox = runScriptlet('abortCurrentScript', ['document.write', 'adblock'], { document: doc });
    vm.runInContext(`abortCurrentScript(['document.write', 'consentWall'])`, sandbox);

    doc.currentScript = { textContent: 'window.adblock = true;' };
    assert.throws(() => vm.runInContext('document.write', sandbox), /ReferenceError/);

    doc.currentScript = { textContent: 'consentWall();' };
    assert.throws(() => vm.runInContext('document.write', sandbox), /ReferenceError/);

    doc.currentScript = { textContent: 'renderArticle();' };
    assert.strictEqual(vm.runInContext('document.write', sandbox), originalWrite);
  });

  await t.test('preserves prototype accessors like document.cookie across writes and stacked rules', () => {
    const jar = ['seed=1'];
    const DocumentProto = {};
    Object.defineProperty(DocumentProto, 'cookie', {
      configurable: true,
      enumerable: true,
      get() {
        return jar.join('; ');
      },
      set(value) {
        jar.push(String(value));
      }
    });
    const doc = Object.create(DocumentProto);
    doc.currentScript = null;
    doc.querySelectorAll = () => [];
    doc.documentElement = { setAttribute: () => {}, getAttribute: () => null };

    const sandbox = runScriptlet('abortCurrentScript', ['document.cookie', 'trackerA'], { document: doc });
    vm.runInContext(`abortCurrentScript(['document.cookie', 'trackerB'])`, sandbox);

    assert.strictEqual(Object.prototype.propertyIsEnumerable.call(doc, 'cookie'), false);

    doc.currentScript = { src: 'https://cdn.example.com/app.js' };
    assert.strictEqual(vm.runInContext('document.cookie', sandbox), 'seed=1');
    vm.runInContext("document.cookie = 'session=ok'", sandbox);
    assert.deepStrictEqual(jar, ['seed=1', 'session=ok']);
    jar.push('server=2');
    assert.strictEqual(vm.runInContext('document.cookie', sandbox), 'seed=1; session=ok; server=2');

    doc.currentScript = { src: 'https://trackerA.example.com/detect.js' };
    assert.throws(() => vm.runInContext('document.cookie', sandbox), /ReferenceError/);

    doc.currentScript = { textContent: 'if (trackerB) check();' };
    assert.throws(() => vm.runInContext('document.cookie', sandbox), /ReferenceError/);
  });

  await t.test('handles wrapping document.currentScript without infinite recursion', () => {
    let activeScript = { textContent: 'normalInit();' };
    const DocumentProto = {};
    Object.defineProperty(DocumentProto, 'currentScript', {
      configurable: true,
      get() {
        return activeScript;
      }
    });
    const doc = Object.create(DocumentProto);
    doc.querySelectorAll = () => [];
    doc.documentElement = { setAttribute: () => {}, getAttribute: () => null };

    const sandbox = runScriptlet('abortCurrentScript', ['document.currentScript', 'selfTrap'], { document: doc });
    assert.strictEqual(vm.runInContext('document.currentScript', sandbox), activeScript);

    activeScript = { textContent: 'selfTrap();' };
    assert.throws(() => vm.runInContext('document.currentScript', sandbox), /ReferenceError/);
  });
});

// ─── REGEX FLAG SUPPORT ACROSS SCRIPTLETS ─────
test('regex-accepting scriptlets honor regex flags cleanly', async (t) => {
  await t.test('all 10 scriptlets preserve case-insensitive and repeated-call matching under /pattern/flags', async () => {
    // 1. noSetTimeoutIf (/gi should match case-insensitively and repeatedly)
    const timerCalls = [];
    const stSandbox = runScriptlet('noSetTimeoutIf', ['/adTimer/gi'], {
      setTimeout: fn => { timerCalls.push(fn.name); return 42; }
    });
    assert.strictEqual(vm.runInContext('setTimeout(function ADTIMER() {}, 10)', stSandbox), -1);
    assert.strictEqual(vm.runInContext('setTimeout(function ADTIMER() {}, 10)', stSandbox), -1);
    assert.strictEqual(vm.runInContext('setTimeout(function normalTimer() {}, 10)', stSandbox), 42);
    assert.deepStrictEqual(timerCalls, ['normalTimer']);

    // 2. noSetIntervalIf
    const intervalCalls = [];
    const siSandbox = runScriptlet('noSetIntervalIf', ['/adTick/gi'], {
      setInterval: fn => { intervalCalls.push(fn.name); return 7; }
    });
    assert.strictEqual(vm.runInContext('setInterval(function ADTICK() {}, 10)', siSandbox), -1);
    assert.strictEqual(vm.runInContext('setInterval(function ADTICK() {}, 10)', siSandbox), -1);
    assert.strictEqual(vm.runInContext('setInterval(function okTick() {}, 10)', siSandbox), 7);
    assert.deepStrictEqual(intervalCalls, ['okTick']);

    // 3. preventFetch
    const fetchUrls = [];
    const fetchSandbox = runScriptlet('preventFetch', ['/ads\\.example/i'], {
      fetch: url => { fetchUrls.push(url); return Promise.resolve({ ok: true, allowed: true }); }
    });
    const blockedFetch = await vm.runInContext("fetch('https://ADS.EXAMPLE/pixel.js')", fetchSandbox);
    assert.strictEqual(blockedFetch.status, 200);
    await vm.runInContext("fetch('https://cdn.example/app.js')", fetchSandbox);
    assert.deepStrictEqual(fetchUrls, ['https://cdn.example/app.js']);

    // 4. preventXhr
    const openedUrls = [];
    class MockXHR {
      open(_m, u) { openedUrls.push(u); }
      send() {}
    }
    const xhrSandbox = runScriptlet('preventXhr', ['/beacon\\.example/i'], { XMLHttpRequest: MockXHR });
    vm.runInContext("var x1 = new XMLHttpRequest(); x1.open('GET', 'https://BEACON.EXAMPLE/ping'); x1.send();", xhrSandbox);
    vm.runInContext("var x2 = new XMLHttpRequest(); x2.open('GET', 'https://api.example/data'); x2.send();", xhrSandbox);
    assert.deepStrictEqual(openedUrls, ['https://api.example/data']);

    // 5. preventAddEventListener
    const addedListeners = [];
    class MockEventTarget {
      addEventListener(type, fn) { addedListeners.push([type, fn]); }
    }
    const aelSandbox = runScriptlet(
      'preventAddEventListener',
      ['/CLICK/i', '/trackAd/i'],
      { EventTarget: MockEventTarget }
    );
    vm.runInContext(
      "new EventTarget().addEventListener('click', function TrackAd() {}); new EventTarget().addEventListener('click', function allowClick() {});",
      aelSandbox
    );
    assert.strictEqual(addedListeners.length, 1);
    assert.strictEqual(addedListeners[0][1].name, 'allowClick');

    // 6. preventWindowOpen
    const openedWindows = [];
    const woSandbox = runScriptlet('preventWindowOpen', ['/popup\\.bad/i'], {
      open: url => { openedWindows.push(url); return { closed: false }; }
    });
    assert.strictEqual(vm.runInContext("open('https://POPUP.BAD/offer').closed", woSandbox), true);
    assert.strictEqual(vm.runInContext("open('https://app.example/help').closed", woSandbox), false);
    assert.deepStrictEqual(openedWindows, ['https://app.example/help']);

    // 7. preventRequestAnimationFrame
    const rafCalls = [];
    const rafSandbox = runScriptlet('preventRequestAnimationFrame', ['/loopAd/i'], {
      requestAnimationFrame: fn => { rafCalls.push(fn.name); return 9; }
    });
    assert.strictEqual(vm.runInContext('requestAnimationFrame(function LOOPAD() {})', rafSandbox), 0);
    assert.strictEqual(vm.runInContext('requestAnimationFrame(function renderUi() {})', rafSandbox), 9);
    assert.deepStrictEqual(rafCalls, ['renderUi']);

    // 8. abortCurrentScript
    const acsDoc = { probe: 'ok', currentScript: { textContent: 'DETECTAD()' } };
    const acsSandbox = runScriptlet('abortCurrentScript', ['document.probe', '/detectAd/gi'], { document: acsDoc });
    assert.throws(() => vm.runInContext('document.probe', acsSandbox), /ReferenceError/);
    assert.throws(() => vm.runInContext('document.probe', acsSandbox), /ReferenceError/);

    // 9. preventElementSrcLoading
    const mediaSets = [];
    class MockHTMLVideoElement {
      set src(v) { mediaSets.push(v); }
      get src() { return mediaSets[mediaSets.length - 1] || ''; }
    }
    class MockElement {
      setAttribute(name, v) { mediaSets.push(name + ":" + v); }
    }
    const bmSandbox = runScriptlet('preventElementSrcLoading', ['video', '/adVideo\\.mp4/i'], {
      HTMLVideoElement: MockHTMLVideoElement,
      Element: MockElement
    });
    vm.runInContext("var v = new HTMLVideoElement(); v.src = 'https://cdn.test/ADVIDEO.MP4'; v.src = 'https://cdn.test/movie.mp4';", bmSandbox);
    assert.deepStrictEqual(mediaSets, ['https://cdn.test/movie.mp4']);

    // 10. noEvalIf
    const evalCalls = [];
    const evalSandbox = runScriptlet('noEvalIf', ['/adEval/i'], {
      eval: code => { evalCalls.push(code); return 'ran'; }
    });
    assert.strictEqual(vm.runInContext("eval('ADEVAL()')", evalSandbox), undefined);
    assert.strictEqual(vm.runInContext("eval('safeCall()')", evalSandbox), 'ran');
    assert.deepStrictEqual(evalCalls, ['safeCall()']);

    // 11. cookieRemover (/gi and /y must not skip alternating matching cookies)
    for (const pattern of ['/^_ga/gi', '/^_ga/y']) {
      const expired = new Set();
      const doc = {
        get cookie() {
          return pattern === '/^_ga/y'
            ? '_ga=1; _ga_123=2; _ga_456=3; _ga_789=4; session=keep'
            : '_ga=1; _GA_123=2; _ga_456=3; _ga_789=4; session=keep';
        },
        set cookie(v) {
          expired.add(decodeURIComponent(v.split('=')[0]));
        }
      };
      runScriptlet('cookieRemover', [pattern], {
        document: doc,
        location: { hostname: 'example.com', pathname: '/' }
      });
      const expected = pattern === '/^_ga/y'
        ? ['_ga', '_ga_123', '_ga_456', '_ga_789']
        : ['_ga', '_GA_123', '_ga_456', '_ga_789'];
      assert.deepStrictEqual([...expired].sort(), expected.sort());
      assert.strictEqual(expired.has('session'), false);
    }
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

  await t.test('treats multi-slash paths like /ads/img as literal substrings instead of RegExp("ads", "img")', async () => {
    const fetchUrls = [];
    const win = makeWindow();
    win.fetch = (url) => { fetchUrls.push(url); return Promise.resolve({}); };
    const sandbox = runScriptlet('preventFetch', ['/ads/img'], win);
    await vm.runInContext('window.fetch("https://example.com/ads/img/logo.png")', sandbox);
    await vm.runInContext('window.fetch("https://example.com/uploads/photo.png")', sandbox);
    assert.deepStrictEqual(fetchUrls, ['https://example.com/uploads/photo.png']);
  });
});

test('replace-node-text handles slash paths and malformed regex literals safely', () => {
  const scriptNode = { textContent: 'load("/ads/sdk.js"); keep();' };
  const win = makeWindow();
  win.document = {
    documentElement: null,
    querySelectorAll: () => [],
    getElementsByTagName: (tag) => (tag === 'script' ? [scriptNode] : [])
  };
  runScriptlet('replaceNodeText', ['script', '/ads/sdk.js', '"/safe.js"'], win);
  assert.strictEqual(scriptNode.textContent, 'load(""/safe.js""); keep();');

  assert.doesNotThrow(() => runScriptlet('replaceNodeText', ['script', '/invalid[/', ''], win));
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

  await t.test('preserves XMLHttpRequest constructor name, source, and static constants', () => {
    const win = makeWindow();
    win.XMLHttpRequest = class XMLHttpRequest { open() {} send() {} };
    win.XMLHttpRequest.UNSENT = 0;
    win.XMLHttpRequest.OPENED = 1;
    win.XMLHttpRequest.HEADERS_RECEIVED = 2;
    win.XMLHttpRequest.LOADING = 3;
    win.XMLHttpRequest.DONE = 4;
    const origSource = win.XMLHttpRequest.toString();

    const sandbox = runScriptlet('preventXhr', ['analytics.example.com'], win);

    assert.strictEqual(vm.runInContext('window.XMLHttpRequest.name', sandbox), 'XMLHttpRequest');
    assert.strictEqual(vm.runInContext('window.XMLHttpRequest.toString()', sandbox), origSource);
    assert.strictEqual(vm.runInContext('window.XMLHttpRequest.UNSENT', sandbox), 0);
    assert.strictEqual(vm.runInContext('window.XMLHttpRequest.OPENED', sandbox), 1);
    assert.strictEqual(vm.runInContext('window.XMLHttpRequest.HEADERS_RECEIVED', sandbox), 2);
    assert.strictEqual(vm.runInContext('window.XMLHttpRequest.LOADING', sandbox), 3);
    assert.strictEqual(vm.runInContext('window.XMLHttpRequest.DONE', sandbox), 4);
    assert.strictEqual(vm.runInContext('new window.XMLHttpRequest().open.name', sandbox), 'open');
    assert.strictEqual(vm.runInContext('new window.XMLHttpRequest().send.name', sandbox), 'send');
  });

  await t.test('preserves m3u-prune patched fetch and XHR names and static constants', () => {
    const win = makeWindow();
    win.fetch = function fetch() {
      return Promise.resolve({ clone() {}, text() {} });
    };
    win.XMLHttpRequest = class XMLHttpRequest {
      open() {}
      send() {}
      addEventListener() {}
    };
    win.XMLHttpRequest.UNSENT = 0;
    win.XMLHttpRequest.OPENED = 1;
    win.XMLHttpRequest.HEADERS_RECEIVED = 2;
    win.XMLHttpRequest.LOADING = 3;
    win.XMLHttpRequest.DONE = 4;

    const sandbox = runScriptlet('m3uPrune', ['ad-segment'], win);

    assert.strictEqual(vm.runInContext('window.fetch.name', sandbox), 'fetch');
    assert.strictEqual(vm.runInContext('window.XMLHttpRequest.name', sandbox), 'XMLHttpRequest');
    assert.strictEqual(vm.runInContext('window.XMLHttpRequest.UNSENT', sandbox), 0);
    assert.strictEqual(vm.runInContext('window.XMLHttpRequest.DONE', sandbox), 4);
    assert.strictEqual(vm.runInContext('new window.XMLHttpRequest().open.name', sandbox), 'open');
  });

  await t.test('m3u-prune rejects invalid URL regex without broadening playlist matching', () => {
    const win = makeWindow();
    const originalFetch = win.fetch;

    const sandbox = runScriptlet('m3uPrune', ['ad-segment', '/playlist[/'], win);

    assert.strictEqual(sandbox.window.fetch, originalFetch);
  });

  await t.test('m3u-prune strips /g and /y flags so consecutive ad segments and playlists match reliably', async () => {
    const playlistBody = '#EXTM3U\n#EXTINF:5,\nad1.ts\n#EXTINF:5,\nad2.ts\n#EXTINF:5,\nAD3.ts\n#EXTINF:5,\ncontent.ts\n';
    class FakeResponse {
      constructor(body, init = {}) {
        this._body = body;
        this.status = init.status || 200;
        this.statusText = init.statusText || 'OK';
        this.headers = init.headers || {};
      }
      clone() { return new FakeResponse(this._body, this); }
      async text() { return this._body; }
    }

    const win = makeWindow();
    win.Response = FakeResponse;
    win.fetch = async () => new FakeResponse(playlistBody);
    win.XMLHttpRequest = class {
      constructor() { this._listeners = {}; this.readyState = 0; this.responseText = ''; }
      open() {}
      addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
      send() {
        this.readyState = 4;
        this.responseText = playlistBody;
        for (const fn of this._listeners.readystatechange || []) fn();
      }
    };

    const sandbox = runScriptlet('m3uPrune', ['/ad\\d+\\.ts/gi', '/playlist\\.m3u8/gy'], win);

    const expected = '#EXTM3U\n#EXTINF:5,\ncontent.ts\n';
    const r1 = await vm.runInContext('window.fetch("playlist.m3u8").then(r => r.text())', sandbox);
    const r2 = await vm.runInContext('window.fetch("playlist.m3u8").then(r => r.text())', sandbox);
    assert.strictEqual(r1, expected);
    assert.strictEqual(r2, expected);

    const xhrText = vm.runInContext(`(() => {
      const xhr = new window.XMLHttpRequest();
      xhr.open('GET', 'playlist.m3u8');
      xhr.send();
      return xhr.responseText;
    })()`, sandbox);
    assert.strictEqual(xhrText, expected);
  });

  await t.test('prevent-xhr and m3u-prune reset per-request state when an XHR instance is reused', () => {
    const sentUrls = [];
    class ReusedProtoXHR {
      constructor() {
        this.readyState = 0;
        this._rawText = '';
        this._listeners = {};
      }
      get responseText() { return this._rawText; }
      get response() { return this._rawText; }
      open(method, url) {
        this._url = url;
        this.readyState = 1;
      }
      addEventListener(type, fn) {
        (this._listeners[type] = this._listeners[type] || []).push(fn);
      }
      send() {
        sentUrls.push(this._url);
        this.readyState = 4;
        for (const fn of this._listeners.readystatechange || []) fn.call(this);
      }
    }

    const xhrSandbox = runScriptlet('preventXhr', ['/ads/'], { XMLHttpRequest: ReusedProtoXHR });
    vm.runInContext(`(() => {
      const xhr = new window.XMLHttpRequest();
      xhr.open('GET', 'https://example.com/ads/pixel');
      xhr.send();
      xhr.open('GET', 'https://example.com/api/legit');
      xhr.send();
    })()`, xhrSandbox);
    assert.deepStrictEqual(sentUrls, ['https://example.com/api/legit']);

    const m3uSandbox = runScriptlet('m3uPrune', ['/ad-seg/'], { XMLHttpRequest: ReusedProtoXHR });
    const responses = vm.runInContext(`(() => {
      const xhr = new window.XMLHttpRequest();
      xhr._rawText = '#EXTM3U\\n#EXTINF:5,\\nhttps://cdn.example/ad-seg/1.ts\\n#EXTINF:5,\\nhttps://cdn.example/live/1.ts';
      xhr.open('GET', 'https://example.com/live.m3u8?seq=1');
      xhr.send();
      const first = xhr.responseText;

      xhr._rawText = '#EXTM3U\\n#EXTINF:5,\\nhttps://cdn.example/live/2.ts';
      xhr.open('GET', 'https://example.com/live.m3u8?seq=2');
      xhr.send();
      const second = xhr.responseText;

      xhr._rawText = '{"ok":true}';
      xhr.open('GET', 'https://example.com/api/status');
      xhr.send();
      const third = xhr.responseText;
      return { first, second, third };
    })()`, m3uSandbox);
    assert.deepStrictEqual(plain(responses), {
      first: '#EXTM3U\n#EXTINF:5,\nhttps://cdn.example/live/1.ts',
      second: '#EXTM3U\n#EXTINF:5,\nhttps://cdn.example/live/2.ts',
      third: '{"ok":true}'
    });
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

test('prevent-window-open blocks window.open and iframe contentWindow.open', async (t) => {
  function setupOpenEnv(patternArgs) {
    const calls = [];
    const childWin = {
      open: function open(url, target, features) {
        calls.push(['child', url, target, features]);
        return { closed: false };
      }
    };
    const frameWin = {
      open: function open(url, target, features) {
        calls.push(['frame', url, target, features]);
        return { closed: false };
      }
    };
    function HTMLIFrameElement() {}
    function contentWindowGetter() { return childWin; }
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      get: contentWindowGetter,
      configurable: true,
      enumerable: true
    });
    function HTMLFrameElement() {}
    Object.defineProperty(HTMLFrameElement.prototype, 'contentWindow', {
      get() { return frameWin; },
      configurable: true,
      enumerable: true
    });
    const iframe = new HTMLIFrameElement();
    const frame = new HTMLFrameElement();
    const sandbox = runScriptlet('preventWindowOpen', patternArgs, {
      HTMLIFrameElement,
      HTMLFrameElement,
      iframe,
      frame,
      open: function open(url, target, features) {
        calls.push(['top', url, target, features]);
        return { closed: false };
      }
    });
    return { sandbox, calls, origGetterStr: contentWindowGetter.toString() };
  }

  await t.test('blocks top and iframe contentWindow.open including dimension popups', () => {
    const { sandbox, calls, origGetterStr } = setupOpenEnv([]);
    const result = vm.runInContext(`
      const topWin = window.open('https://ads.example/pop', '_blank', 'width=800,height=600,toolbar=1');
      const childWin = iframe.contentWindow.open('about:blank', 'pop', 'top=0,left=0,width=800,height=600');
      const frameWin = frame.contentWindow.open('https://ads.example/popunder', '_blank', 'width=800,height=600');
      childWin.focus();
      childWin.document.open();
      childWin.document.write('hi');
      childWin.location.replace('https://ads.example/');
      const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
      ({
        topClosed: topWin.closed,
        childClosed: childWin.closed,
        frameClosed: frameWin.closed,
        childOpenName: iframe.contentWindow.open.name,
        getterName: desc.get.name,
        getterStr: desc.get.toString()
      });
    `, sandbox);
    assert.strictEqual(result.topClosed, true);
    assert.strictEqual(result.childClosed, true);
    assert.strictEqual(result.frameClosed, true);
    assert.strictEqual(result.childOpenName, 'open');
    assert.strictEqual(result.getterName, 'contentWindowGetter');
    assert.strictEqual(result.getterStr, origGetterStr);
    assert.deepStrictEqual(calls, []);
  });

  await t.test('honors URL pattern filter for both window.open and iframe.contentWindow.open', () => {
    const { sandbox, calls } = setupOpenEnv(['ads.example']);
    const result = vm.runInContext(`
      const blockedTop = window.open('https://ads.example/pop', '_blank');
      const blockedChild = iframe.contentWindow.open('https://ads.example/sub', '_blank');
      const allowedTop = window.open('https://player.example/embed', '_blank');
      const allowedChild = iframe.contentWindow.open('https://player.example/inner', '_blank');
      ({
        blockedTopClosed: blockedTop.closed,
        blockedChildClosed: blockedChild.closed,
        allowedTopClosed: allowedTop.closed,
        allowedChildClosed: allowedChild.closed
      });
    `, sandbox);
    assert.deepStrictEqual(plain(result), {
      blockedTopClosed: true,
      blockedChildClosed: true,
      allowedTopClosed: false,
      allowedChildClosed: false
    });
    assert.deepStrictEqual(calls, [
      ['top', 'https://player.example/embed', '_blank', undefined],
      ['child', 'https://player.example/inner', '_blank', undefined]
    ]);
  });
});

test('persistent observer scriptlets', async (t) => {
  await t.test('coalesce mutation bursts into one scheduled DOM sweep', () => {
    let observerCallback = null;
    const rafCallbacks = [];
    let queryCount = 0;
    const target = {
      style: {
        display: '',
        setProperty(name, value) {
          if (name === 'display') this.display = value;
        }
      }
    };
    const win = makeWindow();
    win.requestAnimationFrame = (cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    };
    win.MutationObserver = class {
      constructor(cb) {
        observerCallback = cb;
      }
      observe() {}
    };
    win.document = {
      documentElement: {},
      querySelectorAll: () => {
        queryCount++;
        return [target];
      }
    };

    runScriptlet('hideElement', ['.ad-slot'], win);

    assert.strictEqual(queryCount, 1);
    observerCallback();
    observerCallback();
    observerCallback();
    assert.strictEqual(queryCount, 1, 'mutation burst should not run repeated synchronous sweeps');
    assert.strictEqual(rafCallbacks.length, 1);

    rafCallbacks.shift()();
    assert.strictEqual(queryCount, 2);
  });

  await t.test('observer scriptlets fall back to document when documentElement is null at document_start', () => {
    const observedTargets = [];
    const doc = {
      documentElement: null,
      body: null,
      querySelectorAll: () => [],
      getElementsByTagName: () => []
    };
    for (const [name, args] of [
      ['hideElement', ['.ad-slot']],
      ['releaseScrollLock', []],
      ['hideUpward', ['.ad-slot', 'div']],
      ['removeClass', ['noscroll']],
      ['removeAttr', ['disabled']],
      ['replaceNodeText', ['#text', 'a', 'b']]
    ]) {
      const win = makeWindow();
      win.document = doc;
      win.MutationObserver = class {
        observe(target) {
          if (!target || typeof target !== 'object') {
            throw new TypeError("Failed to execute 'observe' on 'MutationObserver': parameter 1 is not of type 'Node'.");
          }
          observedTargets.push({ name, target });
        }
      };
      runScriptlet(name, args, win);
    }

    assert.strictEqual(observedTargets.length, 6);
    assert.ok(observedTargets.every(entry => entry.target === doc));
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
  const registered = plain(options.initialUserScripts || []);
  const userScriptRegisterCalls = [];
  const userScriptUnregisterCalls = [];
  let duplicateRegistrationAttempts = 0;
  const registeredContentScripts = [];
  const unregisteredContentScriptIds = [];
  let changeListener = null;
  const userScripts = Object.prototype.hasOwnProperty.call(options, 'userScripts')
    ? options.userScripts
    : {
      getScripts: async () => registered.slice(),
      unregister: async ({ ids } = {}) => {
        const removeIds = Array.isArray(ids) ? ids : registered.map(script => script.id);
        userScriptUnregisterCalls.push(removeIds.slice());
        for (const id of removeIds) {
          const index = registered.findIndex(script => script.id === id);
          if (index !== -1) registered.splice(index, 1);
        }
      },
      register: async scripts => {
        userScriptRegisterCalls.push(plain(scripts));
        const ids = scripts.map(script => script.id);
        if (new Set(ids).size !== ids.length || ids.some(id => registered.some(existing => existing.id === id))) {
          duplicateRegistrationAttempts++;
          throw new Error(`Duplicate userScript id in batch: ${ids.join(',')}`);
        }
        registered.push(...scripts);
      }
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
            const requested = Array.isArray(keys) ? keys : [keys];
            for (const key of requested) out[key] = storageState[key];
            return out;
          }
        },
        onChanged: {
          addListener: fn => { changeListener = fn; }
        }
      },
      userScripts,
      scripting: options.scripting || {
        getRegisteredContentScripts: async (query = {}) => {
          if (Array.isArray(query.ids)) {
            return registeredContentScripts.filter(script => query.ids.includes(script.id));
          }
          return registeredContentScripts.slice();
        },
        unregisterContentScripts: async (query = {}) => {
          const ids = Array.isArray(query.ids) ? query.ids : registeredContentScripts.map(script => script.id);
          unregisteredContentScriptIds.push(...ids);
          for (const id of ids) {
            const index = registeredContentScripts.findIndex(script => script.id === id);
            if (index !== -1) registeredContentScripts.splice(index, 1);
          }
        },
        registerContentScripts: async scripts => { registeredContentScripts.push(...scripts); },
        updateContentScripts: async scripts => {
          for (const script of scripts) {
            const index = registeredContentScripts.findIndex(existing => existing.id === script.id);
            if (index === -1) registeredContentScripts.push(script);
            else registeredContentScripts[index] = { ...registeredContentScripts[index], ...script };
          }
        }
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
  return {
    sandbox,
    registered,
    registeredContentScripts,
    unregisteredContentScriptIds,
    userScriptRegisterCalls,
    userScriptUnregisterCalls,
    get duplicateRegistrationAttempts() { return duplicateRegistrationAttempts; },
    getChangeListener: () => changeListener
  };
}

test('scriptlet engine whitelist hardening', async (t) => {
  await t.test('duplicate scriptlets register once across lists, preserving arguments, scope, and timing', async () => {
    const shared = {
      scriptlet: 'set-constant', args: ['flag', 'true'],
      domains: ['example.org', 'example.com'], excludedDomains: ['skip.example.org'], sourceId: 'first'
    };
    const duplicate = {
      ...shared, domains: ['EXAMPLE.COM', 'example.org', 'example.com'],
      excludedDomains: ['skip.example.org', 'skip.example.org'], runAt: 'document_start', sourceId: 'second'
    };
    const storage = {
      subscriptionScriptletRules: [shared, shared, duplicate,
        { ...shared, args: ['flag', 'false'] },
        { ...shared, args: ['true', 'flag'] },
        { ...shared, domains: ['example.net'] },
        { ...shared, excludedDomains: ['other.example.org'] },
        { ...shared, runAt: 'document_end' }
      ],
      config: {}
    };
    const { sandbox, registered } = loadScriptletEngine(storage);
    await sandbox.initScriptletEngine();
    assert.strictEqual(registered.length, 6);
    assert.deepStrictEqual(registered.map(script => script.id), Array.from({ length: 6 }, (_, i) => `scriptlet_${i + 1}`));
    assert.strictEqual(await sandbox.recoverUserScriptsIfNeeded(), false);

    storage.subscriptionScriptletRules = [duplicate];
    await sandbox.syncUserScripts();
    assert.strictEqual(registered.length, 1, 'the surviving list must still supply its scriptlet');
    assert.match(registered[0].js[0].code, /\["flag","true"\]/);
  });

  await t.test('bundled aliases and repeated user-resource rules share their effective registration', async () => {
    const shared = { scriptlet: 'set-constant', args: ['flag', 'true'], domains: ['example.com'] };
    const { sandbox, registered } = loadScriptletEngine({
      subscriptionScriptletRules: [shared, { ...shared, scriptlet: 'set' }],
      userScriptletRules: [
        { ...shared, scriptlet: 'custom' },
        { ...shared, scriptlet: 'custom.js' },
        { ...shared, scriptlet: 'custom', args: ['flag', 'false'] }
      ],
      userScriptletResources: { custom: { code: 'window.flag = scriptletArgs[1];' } },
      config: {}
    });
    sandbox.SCRIPTLET_MAP.set('set', sandbox.SCRIPTLET_MAP.get('set-constant'));
    await sandbox.initScriptletEngine();
    assert.deepStrictEqual(registered.map(script => script.id), ['scriptlet_1', 'user_scriptlet_1', 'user_scriptlet_2']);
  });

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

  await t.test('exclusion-only subscription scriptlets run globally except on negated domains', async () => {
    const { sandbox, registered } = loadScriptletEngine({
      subscriptionScriptletRules: [null, {
        scriptlet: 'set-constant',
        args: ['foo', 'true'],
        domains: null,
        excludedDomains: ['example.org']
      }],
      whitelist: ['whitelisted.example'],
      config: {},
      fprWhitelist: []
    });

    await sandbox.initScriptletEngine();

    assert.strictEqual(registered.length, 1);
    assert.deepStrictEqual(plain(registered[0].matches), ['<all_urls>']);
    assert.deepStrictEqual(plain(registered[0].excludeMatches), [
      '*://whitelisted.example/*',
      '*://*.whitelisted.example/*',
      '*://example.org/*',
      '*://*.example.org/*'
    ]);
  });

  await t.test('malformed cached scriptlet exclusions fail closed instead of broadening', async () => {
    const { sandbox, registered } = loadScriptletEngine({
      subscriptionScriptletRules: [{
        scriptlet: 'set-constant',
        args: ['foo', 'true'],
        domains: null,
        excludedDomains: ['bad/domain']
      }, {
        scriptlet: 'set-constant',
        args: ['bar', 'true'],
        domains: null,
        excludedDomains: 'example.com'
      }, {
        scriptlet: 'set-constant',
        args: ['baz', 'true'],
        domains: null,
        excludedDomains: [123]
      }, {
        scriptlet: 'set-constant',
        args: ['empty', 'true'],
        domains: [],
        excludedDomains: null
      }, {
        scriptlet: 'set-constant',
        args: ['valid', 'true'],
        domains: ['VALID.EXAMPLE'],
        excludedDomains: null
      }],
      whitelist: [],
      config: {},
      fprWhitelist: []
    });

    await sandbox.initScriptletEngine();

    assert.strictEqual(registered.length, 1);
    assert.deepStrictEqual(plain(registered[0].matches), [
      '*://valid.example/*',
      '*://*.valid.example/*'
    ]);
  });

  await t.test('subscription and remote resource wrappers report runs and synchronous errors', () => {
    const { sandbox } = loadScriptletEngine({});
    const runs = [
      [sandbox.buildSubscriptionScriptletCode(function noOp() {}, []), 'hit'],
      [sandbox.buildSubscriptionScriptletCode(function fails() { throw new Error('private'); }, [], true), 'error'],
      [sandbox.buildUserResourceCode({ code: 'return;' }, []), 'hit'],
      [sandbox.buildUserResourceCode({ code: 'throw new Error("private");' }, [], true), 'error']
    ];
    for (const [code, expected] of runs) {
      const events = [];
      vm.runInNewContext(code, {
        document: { dispatchEvent: event => events.push(event) },
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } }
      });
      assert.deepStrictEqual(plain(events), [{ type: '__CHROMA_SCRIPTLET_STATS__', detail: { type: expected } }]);
    }
  });

  await t.test('registered telemetry does not expose scriptlet metadata to the page', async () => {
    const { sandbox, registered } = loadScriptletEngine({
      subscriptionScriptletRules: [{
        scriptlet: 'set-constant',
        sourceId: 'private-list-id',
        args: ['foo', 'true'],
        domains: ['example.org']
      }],
      whitelist: [],
      config: {},
      fprWhitelist: []
    });

    await sandbox.initScriptletEngine();

    assert.strictEqual(registered.length, 1);
    const code = registered[0].js[0].code;
    assert.match(code, /__CHROMA_SCRIPTLET_STATS__/);
    assert.match(code, /detail:\s*\{\s*type:\s*'hit'\s*\}/);
    assert.match(code, /detail:\s*\{\s*type:\s*'error'\s*\}/);
    assert.doesNotMatch(code, /private-list-id/);
    assert.doesNotMatch(code, /sourceId|source:/);
    assert.doesNotMatch(code, /scriptlet:/);
    assert.doesNotMatch(code, /err\.message|err\.name|String\(err\)/);
  });

  await t.test('quiet console records scriptlet telemetry without throwing into page DevTools', async () => {
    const { sandbox, registered } = loadScriptletEngine({
      subscriptionScriptletRules: [{
        scriptlet: 'set-constant',
        args: ['foo', 'true'],
        domains: ['example.org']
      }],
      whitelist: [],
      config: { quietConsole: true },
      fprWhitelist: []
    });

    await sandbox.initScriptletEngine();

    assert.strictEqual(registered.length, 1);
    const code = registered[0].js[0].code;
    assert.match(code, /detail:\s*\{\s*type:\s*'error'\s*\}/);
    assert.match(code, /if\s*\(false\)\s*throw err/);
    assert.doesNotMatch(code, /if\s*\(true\)\s*throw err/);
  });

  await t.test('quiet console registers the FPR quiet bootstrap before the FPR script', async () => {
    const { sandbox, registeredContentScripts } = loadScriptletEngine({
      subscriptionScriptletRules: [],
      userScriptletRules: [],
      whitelist: [],
      config: { enabled: true, fingerprintRandomization: true, quietConsole: true },
      fprWhitelist: []
    });

    await sandbox.initScriptletEngine();

    const fpr = registeredContentScripts.find(script => script.id === 'chroma_fpr');
    assert.ok(fpr);
    assert.deepStrictEqual(plain(fpr.js), [
      'scriptlets/fingerprintConsoleQuiet.js',
      'scriptlets/fingerprintRandomization.js'
    ]);
  });

  await t.test('default FPR registration does not need a console bootstrap', async () => {
    const { sandbox, registeredContentScripts } = loadScriptletEngine({
      subscriptionScriptletRules: [],
      userScriptletRules: [],
      whitelist: [],
      config: { enabled: true, fingerprintRandomization: true, quietConsole: false },
      fprWhitelist: []
    });

    await sandbox.initScriptletEngine();

    const fpr = registeredContentScripts.find(script => script.id === 'chroma_fpr');
    assert.ok(fpr);
    assert.deepStrictEqual(plain(fpr.js), [
      'scriptlets/fingerprintRandomization.js'
    ]);
    assert.strictEqual(registeredContentScripts.some(script => script.id === 'chroma_quiet_console'), false);
  });

  await t.test('quiet console page helper is not registered when quiet console is off', async () => {
    const { sandbox, registeredContentScripts } = loadScriptletEngine({
      subscriptionScriptletRules: [],
      userScriptletRules: [],
      whitelist: [],
      config: { enabled: true, quietConsole: false },
      fprWhitelist: []
    });

    await sandbox.initScriptletEngine();

    assert.strictEqual(registeredContentScripts.some(script => script.id === 'chroma_quiet_console'), false);
  });

  await t.test('quiet console page helper is not registered when master protection is off', async () => {
    const { sandbox, registeredContentScripts } = loadScriptletEngine({
      subscriptionScriptletRules: [],
      userScriptletRules: [],
      whitelist: [],
      config: { enabled: false, quietConsole: true },
      fprWhitelist: []
    });

    await sandbox.initScriptletEngine();

    assert.strictEqual(registeredContentScripts.some(script => script.id === 'chroma_quiet_console'), false);
  });

  await t.test('quiet console page helper registers only when quiet console is on', async () => {
    const { sandbox, registeredContentScripts } = loadScriptletEngine({
      subscriptionScriptletRules: [],
      userScriptletRules: [],
      whitelist: ['example.com'],
      config: { enabled: true, quietConsole: true },
      fprWhitelist: []
    });

    await sandbox.initScriptletEngine();

    const quiet = registeredContentScripts.find(script => script.id === 'chroma_quiet_console');
    assert.ok(quiet);
    assert.deepStrictEqual(plain(quiet.js), ['content/quiet_console.js']);
    assert.strictEqual(quiet.world, 'MAIN');
    assert.strictEqual(quiet.runAt, 'document_start');
    assert.strictEqual(quiet.allFrames, true);
    assert.deepStrictEqual(plain(quiet.excludeMatches), [
      '*://example.com/*',
      '*://*.example.com/*'
    ]);
  });

  await t.test('quiet console page helper unregisters when quiet console turns off', async () => {
    const { sandbox, registeredContentScripts, unregisteredContentScriptIds, getChangeListener } = loadScriptletEngine({
      subscriptionScriptletRules: [],
      userScriptletRules: [],
      whitelist: [],
      config: { enabled: true, quietConsole: true },
      fprWhitelist: []
    });

    await sandbox.initScriptletEngine();
    assert.ok(registeredContentScripts.some(script => script.id === 'chroma_quiet_console'));

    sandbox.chrome.storage.local.get = async (keys) => {
      const source = {
        subscriptionScriptletRules: [],
        userScriptletRules: [],
        userScriptletResources: {},
        whitelist: [],
        fprWhitelist: [],
        config: { enabled: true, quietConsole: false }
      };
      const out = {};
      for (const key of (Array.isArray(keys) ? keys : [keys])) out[key] = source[key];
      return out;
    };
    getChangeListener()({
      config: {
        oldValue: { enabled: true, quietConsole: true },
        newValue: { enabled: true, quietConsole: false }
      }
    }, 'local');
    await new Promise(resolve => setImmediate(resolve));

    assert.ok(unregisteredContentScriptIds.includes('chroma_quiet_console'));
    assert.strictEqual(registeredContentScripts.some(script => script.id === 'chroma_quiet_console'), false);
  });

  await t.test('quiet console page helper unregisters when master protection turns off', async () => {
    const { sandbox, registeredContentScripts, unregisteredContentScriptIds, getChangeListener } = loadScriptletEngine({
      subscriptionScriptletRules: [],
      userScriptletRules: [],
      whitelist: [],
      config: { enabled: true, quietConsole: true },
      fprWhitelist: []
    });

    await sandbox.initScriptletEngine();
    assert.ok(registeredContentScripts.some(script => script.id === 'chroma_quiet_console'));

    sandbox.chrome.storage.local.get = async (keys) => {
      const source = {
        subscriptionScriptletRules: [],
        userScriptletRules: [],
        userScriptletResources: {},
        whitelist: [],
        fprWhitelist: [],
        config: { enabled: false, quietConsole: true }
      };
      const out = {};
      for (const key of (Array.isArray(keys) ? keys : [keys])) out[key] = source[key];
      return out;
    };
    getChangeListener()({
      config: {
        oldValue: { enabled: true, quietConsole: true },
        newValue: { enabled: false, quietConsole: true }
      }
    }, 'local');
    await new Promise(resolve => setImmediate(resolve));

    assert.ok(unregisteredContentScriptIds.includes('chroma_quiet_console'));
    assert.strictEqual(registeredContentScripts.some(script => script.id === 'chroma_quiet_console'), false);
  });

  await t.test('FPR and Quiet Console clear stale excludeMatches when sites leave the whitelist', async () => {
    const storage = {
      subscriptionScriptletRules: [],
      userScriptletRules: [],
      userScriptletResources: {},
      whitelist: ['example.com'],
      fprWhitelist: ['fpr-only.example'],
      config: { enabled: true, fingerprintRandomization: true, quietConsole: true }
    };
    const { sandbox, registeredContentScripts, getChangeListener } = loadScriptletEngine(storage);

    sandbox.chrome.storage.local.get = async (keys) => {
      const out = {};
      for (const key of (Array.isArray(keys) ? keys : [keys])) out[key] = storage[key];
      return out;
    };

    await sandbox.initScriptletEngine();

    const fprBefore = registeredContentScripts.find(script => script.id === 'chroma_fpr');
    const quietBefore = registeredContentScripts.find(script => script.id === 'chroma_quiet_console');
    assert.deepStrictEqual(plain(fprBefore.excludeMatches), [
      '*://example.com/*',
      '*://*.example.com/*',
      '*://fpr-only.example/*',
      '*://*.fpr-only.example/*'
    ]);
    assert.deepStrictEqual(plain(quietBefore.excludeMatches), [
      '*://example.com/*',
      '*://*.example.com/*'
    ]);

    storage.whitelist = [];
    storage.fprWhitelist = [];
    getChangeListener()({
      whitelist: { oldValue: ['example.com'], newValue: [] },
      fprWhitelist: { oldValue: ['fpr-only.example'], newValue: [] }
    }, 'local');
    await new Promise(resolve => setImmediate(resolve));

    const fprAfter = registeredContentScripts.find(script => script.id === 'chroma_fpr');
    const quietAfter = registeredContentScripts.find(script => script.id === 'chroma_quiet_console');
    assert.deepStrictEqual(plain(fprAfter.excludeMatches), []);
    assert.deepStrictEqual(plain(quietAfter.excludeMatches), []);
  });

  await t.test('user resource scriptlets use MAIN world, all frames, and coarse telemetry', async () => {
    const { sandbox, registered } = loadScriptletEngine({
      subscriptionScriptletRules: [],
      userScriptletRules: [{
        scriptlet: 'resource-name.js',
        args: ['needle'],
        domains: ['example.net'],
        excludedDomains: ['ads.example.net']
      }],
      userScriptletResources: {
        'resource-name': {
          name: 'resource-name',
          displayName: 'resource-name.js',
          sourceId: 'private-source-id',
          code: '(function() { window.__needle = "{{1}}"; })();'
        }
      },
      whitelist: ['excluded.example'],
      config: {},
      fprWhitelist: []
    });

    await sandbox.initScriptletEngine();

    assert.strictEqual(registered.length, 1);
    assert.strictEqual(registered[0].id, 'user_scriptlet_1');
    assert.strictEqual(registered[0].world, 'MAIN');
    assert.strictEqual(registered[0].allFrames, true);
    assert.deepStrictEqual(plain(registered[0].matches), ['*://example.net/*', '*://*.example.net/*']);
    assert.deepStrictEqual(plain(registered[0].excludeMatches), [
      '*://excluded.example/*',
      '*://*.excluded.example/*',
      '*://ads.example.net/*',
      '*://*.ads.example.net/*'
    ]);
    const code = registered[0].js[0].code;
    assert.match(code, /window\.__needle = "needle"/);
    assert.match(code, /__CHROMA_SCRIPTLET_STATS__/);
    assert.doesNotMatch(code, /private-source-id/);
    assert.doesNotMatch(code, /sourceId|scriptlet:/);
  });

  await t.test('user resource {{args}} preserves dollar replacement sequences and avoids double-interpolation', async () => {
    const { sandbox, registered } = loadScriptletEngine({
      subscriptionScriptletRules: [],
      userScriptletRules: [{
        scriptlet: 'dollar-args.js',
        args: ['foo$$bar', '$&', '{{1}}'],
        domains: ['example.net']
      }],
      userScriptletResources: {
        'dollar-args': {
          name: 'dollar-args',
          displayName: 'dollar-args.js',
          code: 'window.__allArgs = {{args}}; window.__first = "{{1}}";'
        }
      },
      whitelist: [],
      config: {},
      fprWhitelist: []
    });

    await sandbox.initScriptletEngine();

    assert.strictEqual(registered.length, 1);
    const code = registered[0].js[0].code;
    const win = {};
    vm.runInNewContext(code, {
      window: win,
      document: { dispatchEvent() {} },
      CustomEvent: class {}
    });
    assert.deepStrictEqual(plain(win.__allArgs), ['foo$$bar', '$&', '{{1}}']);
    assert.strictEqual(win.__first, 'foo$$bar');
  });

  await t.test('whitelist changes update subscription and advanced exclusions while enabled', async () => {
    const storageState = {
      subscriptionScriptletRules: [{ scriptlet: 'set-constant', args: ['foo', 'true'] }],
      userScriptletRules: [{ scriptlet: 'custom-resource', args: [] }],
      userScriptletResources: {
        'custom-resource': { code: '(function() { window.__custom = true; })();' }
      },
      whitelist: [],
      config: { enabled: true },
      fprWhitelist: []
    };
    const { sandbox, registered, getChangeListener } = loadScriptletEngine(storageState);
    await sandbox.initScriptletEngine();
    assert.deepStrictEqual(registered.map(script => script.id), ['scriptlet_1', 'user_scriptlet_1']);

    storageState.whitelist = ['example.com'];
    getChangeListener()({ whitelist: { oldValue: [], newValue: ['example.com'] } }, 'local');
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.strictEqual(registered.length, 2);
    for (const script of registered) {
      assert.deepStrictEqual(plain(script.excludeMatches), [
        '*://example.com/*',
        '*://*.example.com/*'
      ]);
    }
  });
});

test('scriptlet engine isolates failures within 100-script registration batches', async () => {
  const userScriptletRules = [];
  const userScriptletResources = {};
  for (let index = 1; index <= 101; index++) {
    const name = `advanced-resource-${index}`;
    userScriptletRules.push({
      scriptlet: name,
      args: [],
      domains: [`site-${index}.example`]
    });
    userScriptletResources[name] = {
      name,
      code: `globalThis.__advancedResource${index} = true;`
    };
  }

  const accepted = [];
  const registrationCalls = [];
  const failingId = 'user_scriptlet_50';
  const { sandbox } = loadScriptletEngine({
    subscriptionScriptletRules: [],
    userScriptletRules,
    userScriptletResources,
    whitelist: [],
    config: { enabled: true },
    fprWhitelist: []
  }, {
    userScripts: {
      getScripts: async () => [],
      unregister: async () => {},
      register: async scripts => {
        registrationCalls.push(scripts.map(script => script.id));
        if (scripts.some(script => script.id === failingId)) {
          throw new Error('malformed registration');
        }
        accepted.push(...scripts);
      }
    }
  });

  const result = await sandbox.syncUserScripts();

  assert.strictEqual(registrationCalls[0].length, 100);
  assert.ok(registrationCalls.slice(1).every(batch => batch.length === 1));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.registered, 100);
  assert.strictEqual(result.expected, 101);
  assert.strictEqual(accepted.length, 100);
  assert.strictEqual(accepted.some(script => script.id === failingId), false);
  assert.strictEqual(accepted.some(script => script.id === 'user_scriptlet_101'), true);
});

test('scriptlet engine master lifecycle', async (t) => {
  function lifecycleStorage(enabled) {
    return {
      subscriptionScriptletRules: [{
        scriptlet: 'set-constant',
        args: ['subscriptionFlag', 'true'],
        domains: ['subscription.example']
      }],
      userScriptletRules: [{
        scriptlet: 'advanced-resource.js',
        args: ['advanced'],
        domains: ['advanced.example']
      }],
      userScriptletResources: {
        'advanced-resource': {
          name: 'advanced-resource',
          code: '(function() { window.__advanced = "{{1}}"; })();'
        }
      },
      whitelist: ['excluded.example'],
      fprWhitelist: [],
      config: { enabled }
    };
  }

  const waitForSync = () => new Promise(resolve => setTimeout(resolve, 25));

  await t.test('existing subscription and advanced registrations are removed when master turns off', async () => {
    const storageState = lifecycleStorage(true);
    const harness = loadScriptletEngine(storageState);
    await harness.sandbox.initScriptletEngine();
    assert.deepStrictEqual(harness.registered.map(script => script.id), ['scriptlet_1', 'user_scriptlet_1']);

    storageState.config = { enabled: false };
    harness.getChangeListener()({
      config: { oldValue: { enabled: true }, newValue: { enabled: false } }
    }, 'local');
    await waitForSync();

    assert.deepStrictEqual(harness.registered, []);
    assert.deepStrictEqual(harness.userScriptUnregisterCalls.at(-1), ['scriptlet_1', 'user_scriptlet_1']);
  });

  await t.test('stored rule and resource changes while off never register scripts', async () => {
    const storageState = lifecycleStorage(false);
    storageState.subscriptionScriptletRules = [];
    storageState.userScriptletRules = [];
    storageState.userScriptletResources = {};
    const harness = loadScriptletEngine(storageState);
    await harness.sandbox.initScriptletEngine();

    storageState.subscriptionScriptletRules = [{ scriptlet: 'set-constant', args: ['offFlag', 'true'] }];
    harness.getChangeListener()({ subscriptionScriptletRules: { oldValue: [], newValue: storageState.subscriptionScriptletRules } }, 'local');
    storageState.userScriptletResources = lifecycleStorage(false).userScriptletResources;
    storageState.userScriptletRules = lifecycleStorage(false).userScriptletRules;
    harness.getChangeListener()({
      userScriptletResources: { oldValue: {}, newValue: storageState.userScriptletResources },
      userScriptletRules: { oldValue: [], newValue: storageState.userScriptletRules }
    }, 'local');
    await waitForSync();

    assert.deepStrictEqual(harness.registered, []);
    assert.strictEqual(harness.userScriptRegisterCalls.length, 0);
  });

  await t.test('worker recovery with master off purges only stale managed registrations', async () => {
    const storageState = lifecycleStorage(false);
    const harness = loadScriptletEngine(storageState, {
      initialUserScripts: [
        { id: 'scriptlet_1' },
        { id: 'user_scriptlet_1' },
        { id: 'unmanaged_helper' }
      ]
    });

    assert.strictEqual(await harness.sandbox.recoverUserScriptsIfNeeded(), true);
    assert.deepStrictEqual(harness.registered.map(script => script.id), ['unmanaged_helper']);
    assert.deepStrictEqual(harness.userScriptUnregisterCalls, [[
      'scriptlet_1',
      'user_scriptlet_1'
    ]]);
    assert.strictEqual(harness.userScriptRegisterCalls.length, 0);

    const emptyHarness = loadScriptletEngine(storageState);
    assert.strictEqual(await emptyHarness.sandbox.recoverUserScriptsIfNeeded(), false);
    assert.deepStrictEqual(emptyHarness.registered, []);
    assert.strictEqual(emptyHarness.userScriptRegisterCalls.length, 0);
  });

  await t.test('worker recovery clears orphaned managed registrations with an empty active cache', async () => {
    const storageState = lifecycleStorage(true);
    storageState.subscriptionScriptletRules = [];
    storageState.userScriptletRules = [];
    const harness = loadScriptletEngine(storageState, {
      initialUserScripts: [{ id: 'scriptlet_1' }, { id: 'unmanaged_helper' }]
    });

    assert.strictEqual(await harness.sandbox.recoverUserScriptsIfNeeded(), true);
    assert.deepStrictEqual(harness.registered.map(script => script.id), ['unmanaged_helper']);
    assert.strictEqual(harness.userScriptRegisterCalls.length, 0);
  });

  await t.test('worker recovery repairs a partial active subscription and advanced registry', async () => {
    const storageState = lifecycleStorage(true);
    const expectedHarness = loadScriptletEngine(storageState);
    await expectedHarness.sandbox.initScriptletEngine();
    const partialRegistry = plain([expectedHarness.registered[0]]);
    const harness = loadScriptletEngine(storageState, {
      initialUserScripts: [...partialRegistry, { id: 'unmanaged_helper' }]
    });

    assert.strictEqual(await harness.sandbox.recoverUserScriptsIfNeeded(), true);
    assert.deepStrictEqual(harness.registered.map(script => script.id), [
      'unmanaged_helper',
      'scriptlet_1',
      'user_scriptlet_1'
    ]);
    assert.deepStrictEqual(harness.userScriptUnregisterCalls, [['scriptlet_1']]);
    assert.strictEqual(harness.duplicateRegistrationAttempts, 0);
  });

  await t.test('re-enable restores the exact cached subscription and advanced registry', async () => {
    const storageState = lifecycleStorage(false);
    const harness = loadScriptletEngine(storageState);
    await harness.sandbox.initScriptletEngine();
    assert.deepStrictEqual(harness.registered, []);

    storageState.config = { enabled: true };
    harness.getChangeListener()({
      config: { oldValue: { enabled: false }, newValue: { enabled: true } }
    }, 'local');
    await waitForSync();

    assert.deepStrictEqual(harness.registered.map(script => script.id), ['scriptlet_1', 'user_scriptlet_1']);
    const [subscription, advanced] = harness.registered;
    assert.deepStrictEqual(plain(subscription.matches), [
      '*://subscription.example/*',
      '*://*.subscription.example/*'
    ]);
    assert.strictEqual(subscription.runAt, 'document_start');
    assert.strictEqual(subscription.world, 'MAIN');
    assert.strictEqual(subscription.allFrames, true);
    assert.match(subscription.js[0].code, /subscriptionFlag/);

    assert.deepStrictEqual(plain(advanced.matches), [
      '*://advanced.example/*',
      '*://*.advanced.example/*'
    ]);
    assert.strictEqual(advanced.runAt, 'document_start');
    assert.strictEqual(advanced.world, 'MAIN');
    assert.strictEqual(advanced.allFrames, true);
    assert.match(advanced.js[0].code, /window\.__advanced = \"advanced\"/);

    for (const script of [subscription, advanced]) {
      assert.deepStrictEqual(plain(script.excludeMatches), [
        '*://excluded.example/*',
        '*://*.excluded.example/*'
      ]);
    }
  });

  await t.test('rapid repeated toggles converge without duplicate registrations', async () => {
    const storageState = lifecycleStorage(true);
    const harness = loadScriptletEngine(storageState);
    await harness.sandbox.initScriptletEngine();

    for (const enabled of [false, true, false, true]) {
      const oldValue = storageState.config;
      storageState.config = { enabled };
      harness.getChangeListener()({ config: { oldValue, newValue: storageState.config } }, 'local');
    }
    await waitForSync();
    assert.deepStrictEqual(harness.registered.map(script => script.id), ['scriptlet_1', 'user_scriptlet_1']);
    assert.strictEqual(new Set(harness.registered.map(script => script.id)).size, 2);
    assert.strictEqual(harness.duplicateRegistrationAttempts, 0);

    for (const enabled of [false, true, false]) {
      const oldValue = storageState.config;
      storageState.config = { enabled };
      harness.getChangeListener()({ config: { oldValue, newValue: storageState.config } }, 'local');
    }
    await waitForSync();
    assert.deepStrictEqual(harness.registered, []);
    assert.strictEqual(harness.duplicateRegistrationAttempts, 0);
  });

  await t.test('an in-flight active sync drains a newer off request before its callers resolve', async () => {
    const storageState = lifecycleStorage(true);
    const registry = [];
    let releaseRegistration;
    let registrationReached;
    let firstRegistration = true;
    const registrationBlocked = new Promise(resolve => { releaseRegistration = resolve; });
    const reachedRegistration = new Promise(resolve => { registrationReached = resolve; });
    const userScripts = {
      getScripts: async () => registry.slice(),
      unregister: async ({ ids }) => {
        for (const id of ids) {
          const index = registry.findIndex(script => script.id === id);
          if (index !== -1) registry.splice(index, 1);
        }
      },
      register: async scripts => {
        if (firstRegistration) {
          firstRegistration = false;
          registrationReached();
          await registrationBlocked;
        }
        registry.push(...plain(scripts));
      }
    };
    const harness = loadScriptletEngine(storageState, { userScripts });

    const activeSync = harness.sandbox.syncUserScripts();
    await reachedRegistration;
    storageState.config = { enabled: false };
    const offSync = harness.sandbox.syncUserScripts();
    assert.strictEqual(activeSync, offSync);

    releaseRegistration();
    await activeSync;
    assert.deepStrictEqual(registry, []);
  });

  await t.test('FPR and Quiet Console retain their documented master lifecycle', async () => {
    const storageState = lifecycleStorage(true);
    storageState.config = { enabled: true, fingerprintRandomization: true, quietConsole: true };
    const harness = loadScriptletEngine(storageState);
    await harness.sandbox.initScriptletEngine();
    assert.deepStrictEqual(
      harness.registeredContentScripts.map(script => script.id).sort(),
      ['chroma_fpr', 'chroma_quiet_console', 'chroma_yahoo_recipe']
    );

    storageState.config = { enabled: false, fingerprintRandomization: true, quietConsole: true };
    harness.getChangeListener()({
      config: {
        oldValue: { enabled: true, fingerprintRandomization: true, quietConsole: true },
        newValue: storageState.config
      }
    }, 'local');
    await waitForSync();
    assert.deepStrictEqual(harness.registered, []);
    assert.deepStrictEqual(harness.registeredContentScripts, []);

    const oldValue = storageState.config;
    storageState.config = { enabled: true, fingerprintRandomization: true, quietConsole: true };
    harness.getChangeListener()({ config: { oldValue, newValue: storageState.config } }, 'local');
    await waitForSync();
    assert.deepStrictEqual(harness.registered.map(script => script.id), ['scriptlet_1', 'user_scriptlet_1']);
    assert.deepStrictEqual(
      harness.registeredContentScripts.map(script => script.id).sort(),
      ['chroma_fpr', 'chroma_quiet_console', 'chroma_yahoo_recipe']
    );
  });

  await t.test('syncFpr and syncQuietConsole drain queued changes before resolving callers', async () => {
    const storageState = lifecycleStorage(true);
    storageState.config = { enabled: true, fingerprintRandomization: true, quietConsole: true };
    const harness = loadScriptletEngine(storageState);

    let releaseFpr;
    let releaseQuiet;
    let blockFpr = true;
    let blockQuiet = true;
    let fprStarted;
    let quietStarted;
    const fprBlocked = new Promise(resolve => { releaseFpr = resolve; });
    const quietBlocked = new Promise(resolve => { releaseQuiet = resolve; });
    const fprAtRegister = new Promise(resolve => { fprStarted = resolve; });
    const quietAtRegister = new Promise(resolve => { quietStarted = resolve; });

    const origRegister = harness.sandbox.chrome.scripting.registerContentScripts;
    harness.sandbox.chrome.scripting.registerContentScripts = async (scripts) => {
      for (const script of scripts) {
        if (script.id === 'chroma_fpr' && blockFpr) {
          blockFpr = false;
          fprStarted();
          await fprBlocked;
        }
        if (script.id === 'chroma_quiet_console' && blockQuiet) {
          blockQuiet = false;
          quietStarted();
          await quietBlocked;
        }
      }
      return origRegister(scripts);
    };

    const initialSync = harness.sandbox.initScriptletEngine();
    await Promise.all([fprAtRegister, quietAtRegister]);

    const oldConfig = storageState.config;
    storageState.config = { enabled: true, fingerprintRandomization: false, quietConsole: false };
    harness.getChangeListener()({ config: { oldValue: oldConfig, newValue: storageState.config } }, 'local');
    const secondSync = harness.sandbox.initScriptletEngine();

    releaseFpr();
    releaseQuiet();
    await Promise.all([initialSync, secondSync]);

    assert.deepStrictEqual(
      harness.registeredContentScripts.map(script => script.id),
      ['chroma_yahoo_recipe']
    );
  });
});

test('Yahoo recipe registration follows master and whitelist state without enabling Yahoo subdomains', async () => {
  const storage = { config: { enabled: true }, whitelist: [] };
  const harness = loadScriptletEngine(storage);
  await harness.sandbox.initScriptletEngine();
  const recipe = () => harness.registeredContentScripts.find(script => script.id === 'chroma_yahoo_recipe');
  assert.deepStrictEqual(plain(recipe().matches), ['*://yahoo.com/*', '*://www.yahoo.com/*']);
  assert.deepStrictEqual(plain(recipe().js), ['content/recipes.js']);
  assert.strictEqual(recipe().world, 'MAIN');
  assert.strictEqual(recipe().runAt, 'document_start');
  assert.strictEqual(recipe().persistAcrossSessions, true);

  storage.whitelist = ['yahoo.com'];
  harness.getChangeListener()({ whitelist: { oldValue: [], newValue: storage.whitelist } }, 'local');
  await harness.sandbox.syncYahooRecipe();
  assert.deepStrictEqual(plain(recipe().excludeMatches), ['*://yahoo.com/*', '*://*.yahoo.com/*']);

  storage.config = { enabled: false };
  harness.getChangeListener()({ config: { oldValue: { enabled: true }, newValue: storage.config } }, 'local');
  await harness.sandbox.syncYahooRecipe();
  assert.strictEqual(recipe(), undefined);

  storage.config = { enabled: true };
  storage.whitelist = [];
  await harness.sandbox.initScriptletEngine();
  assert.ok(recipe());
  assert.deepStrictEqual(plain(recipe().excludeMatches), []);
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

  await t.test('syncUserScripts reports unavailable and partial registry failures', async () => {
    const unavailable = loadScriptletEngine({
      subscriptionScriptletRules: [{ scriptlet: 'set-constant', args: ['foo', 'true'] }],
      whitelist: [],
      config: {},
      fprWhitelist: []
    }, { userScripts: undefined });

    const unavailableResult = await unavailable.sandbox.syncUserScripts();
    assert.strictEqual(unavailableResult.ok, false);
    assert.strictEqual(unavailableResult.unavailable, true);
    assert.match(unavailableResult.error, /unavailable/i);

    const partial = loadScriptletEngine({
      subscriptionScriptletRules: [{ scriptlet: 'set-constant', args: ['foo', 'true'] }],
      whitelist: [],
      config: {},
      fprWhitelist: []
    }, {
      userScripts: {
        getScripts: async () => [],
        unregister: async () => {},
        register: async () => { throw new Error('registration rejected'); }
      }
    });

    const partialResult = await partial.sandbox.syncUserScripts();
    assert.strictEqual(partialResult.ok, false);
    assert.strictEqual(partialResult.registered, 0);
    assert.strictEqual(partialResult.expected, 1);
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

  await t.test('recoverUserScriptsIfNeeded skips an exact healthy registry', async () => {
    const harness = loadScriptletEngine({
      subscriptionScriptletRules: [{ scriptlet: 'set-constant', args: ['foo', 'true'] }],
      whitelist: [],
      config: {},
      fprWhitelist: []
    });
    await harness.sandbox.initScriptletEngine();
    const registerCallCount = harness.userScriptRegisterCalls.length;
    const unregisterCallCount = harness.userScriptUnregisterCalls.length;

    const recovered = await harness.sandbox.recoverUserScriptsIfNeeded();

    assert.strictEqual(recovered, false);
    assert.strictEqual(harness.userScriptRegisterCalls.length, registerCallCount);
    assert.strictEqual(harness.userScriptUnregisterCalls.length, unregisterCallCount);
  });

  await t.test('syncUserScripts clears both scriptletRegistration and userScriptsRecovery on success', async () => {
    const harness = loadScriptletEngine({
      subscriptionScriptletRules: [{ scriptlet: 'set-constant', args: ['foo', 'true'] }],
      whitelist: [],
      config: { enabled: true },
      fprWhitelist: []
    });
    const cleared = [];
    harness.sandbox.clearHealthDiagnostic = async id => { cleared.push(id); };

    const result = await harness.sandbox.syncUserScripts();

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(cleared, ['scriptletRegistration', 'userScriptsRecovery']);
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

  await t.test('preserves Function.prototype.toString identity across self-inspection', () => {
    const sandbox = runFingerprintRandomization();

    assert.strictEqual(
      vm.runInContext('Function.prototype.toString.call(Function.prototype.toString)', sandbox),
      'function toString() { [native code] }'
    );
    assert.strictEqual(
      vm.runInContext('Function.prototype.toString.toString()', sandbox),
      'function toString() { [native code] }'
    );
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

test('protectStylesheets preserves real stylesheets while allowing removal of empty probe elements', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://www.allrecipes.com/'
  });
  const { window } = dom;
  const { document } = window;

  const sandbox = {
    window,
    document,
    Node: window.Node,
    Element: window.Element,
    console,
    Array
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(libCode, sandbox);
  vm.runInContext('protectStylesheets()', sandbox);

  const probeLink = document.createElement('link');
  probeLink.setAttribute('rel', 'stylesheet');
  probeLink.setAttribute('type', 'text/css');
  document.head.appendChild(probeLink);
  probeLink.remove();
  assert.strictEqual(document.head.contains(probeLink), false, 'empty probe <link rel="stylesheet"> without href should be removable');

  const emptyStyle = document.createElement('style');
  document.head.appendChild(emptyStyle);
  document.head.removeChild(emptyStyle);
  assert.strictEqual(document.head.contains(emptyStyle), false, 'empty probe <style> should be removable');

  const realLink = document.createElement('link');
  realLink.setAttribute('rel', 'stylesheet');
  realLink.setAttribute('href', 'https://www.allrecipes.com/static/site.css');
  document.head.appendChild(realLink);
  realLink.remove();
  assert.strictEqual(document.head.contains(realLink), true, 'real <link rel="stylesheet" href="..."> must stay protected');
  document.head.removeChild(realLink);
  assert.strictEqual(document.head.contains(realLink), true, 'removeChild must also preserve real stylesheet links');

  const realStyle = document.createElement('style');
  realStyle.textContent = 'body { color: #111; }';
  document.head.appendChild(realStyle);
  realStyle.remove();
  assert.strictEqual(document.head.contains(realStyle), true, 'non-empty <style> must stay protected');
  document.head.replaceChildren();
  assert.strictEqual(document.head.contains(realLink), true);
  assert.strictEqual(document.head.contains(realStyle), true);
});

test('Bug 8 scriptlet stealth and determinism regressions', async (t) => {
  await t.test('abort-on-property-read does not leave enumerable properties for absent parents', () => {
    const sandbox = runScriptlet('abortOnPropertyRead', ['absentNs.detect']);
    assert.strictEqual(Object.keys(sandbox).includes('absentNs'), false);
    assert.strictEqual(vm.runInContext('Object.getOwnPropertyDescriptor(window, "absentNs").enumerable', sandbox), false);
    vm.runInContext('window.absentNs = {}', sandbox);
    assert.throws(() => vm.runInContext('window.absentNs.detect', sandbox), /ReferenceError/);
  });

  await t.test('set-constant keeps empty string values as empty string instead of 0', () => {
    const sandbox = runScriptlet('setConstant', ['emptyFlag', '']);
    assert.strictEqual(vm.runInContext('window.emptyFlag', sandbox), '');
  });

  await t.test('prevent-fetch matches URL objects and cloaks Function.prototype.toString without own .toString', async () => {
    let called = false;
    const win = makeWindow();
    win.URL = URL;
    win.fetch = function fetch() { called = true; return Promise.resolve({ ok: true }); };
    const sandbox = runScriptlet('preventFetch', ['blocked.example'], win);
    const res = await vm.runInContext('window.fetch(new URL("https://blocked.example/beacon"))', sandbox);
    assert.strictEqual(called, false);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(vm.runInContext('Object.prototype.hasOwnProperty.call(window.fetch, "toString")', sandbox), false);
    assert.match(vm.runInContext('Function.prototype.toString.call(window.fetch)', sandbox), /function fetch/);
  });

  await t.test('prevent-xhr preserves constructor/prototype identity, cloaks methods, and suppresses blocked setRequestHeader', () => {
    const opened = [];
    const sent = [];
    const headers = [];
    class BaseXHR {
      constructor() {
        this.readyState = 0;
      }
      open(_m, u) {
        this.readyState = 1;
        opened.push(u);
      }
      setRequestHeader(k, v) {
        if (this.readyState !== 1) throw new Error('InvalidStateError');
        headers.push([k, v]);
      }
      send() {
        sent.push(true);
      }
    }
    const sandbox = runScriptlet('preventXhr', ['/ads/'], { XMLHttpRequest: BaseXHR });
    const checks = vm.runInContext(`(() => {
      const xhr = new window.XMLHttpRequest();
      const ctorOk = xhr.constructor === window.XMLHttpRequest;
      const instOk = xhr instanceof window.XMLHttpRequest;
      const hasOwnOpen = Object.prototype.hasOwnProperty.call(xhr, 'open');
      const hasOwnSend = Object.prototype.hasOwnProperty.call(xhr, 'send');
      const protoOpenStr = Function.prototype.toString.call(window.XMLHttpRequest.prototype.open);
      xhr.open('GET', 'https://example.com/ads/px');
      xhr.setRequestHeader('X-Ad', '1');
      xhr.send();
      xhr.open('GET', 'https://example.com/api/ok');
      xhr.setRequestHeader('X-Ok', '2');
      xhr.send();
      return { ctorOk, instOk, hasOwnOpen, hasOwnSend, protoOpenStr };
    })()`, sandbox);
    assert.strictEqual(checks.ctorOk, true);
    assert.strictEqual(checks.instOk, true);
    assert.strictEqual(checks.hasOwnOpen, false);
    assert.strictEqual(checks.hasOwnSend, false);
    assert.match(checks.protoOpenStr, /open\(/);
    assert.deepStrictEqual(opened, ['https://example.com/api/ok']);
    assert.deepStrictEqual(headers, [['X-Ok', '2']]);
    assert.deepStrictEqual(sent, [true]);
  });

  await t.test('protectStylesheets keeps prototype descriptors configurable and writable', () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'https://www.allrecipes.com/'
    });
    const { window } = dom;
    const sandbox = {
      window,
      document: window.document,
      Node: window.Node,
      Element: window.Element,
      console,
      Array
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(libCode, sandbox);
    vm.runInContext('protectStylesheets()', sandbox);

    for (const [proto, prop] of [
      [window.Node.prototype, 'removeChild'],
      [window.Element.prototype, 'remove'],
      [window.Element.prototype, 'replaceChildren']
    ]) {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      assert.strictEqual(desc.configurable, true);
      assert.strictEqual(desc.writable, true);
    }
  });

  await t.test('replace-node-text with wildcard updates text nodes without wiping DOM elements', () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html><head><title>ad_title</title></head><body><div id="wrap"><span>ad_banner</span><button id="keep">OK</button></div></body></html>');
    const { window } = dom;
    const sandbox = {
      window,
      document: window.document,
      NodeFilter: window.NodeFilter,
      MutationObserver: window.MutationObserver,
      console,
      setTimeout: (fn) => { fn(); return 1; }
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(libCode, sandbox);
    vm.runInContext('replaceNodeText(["*", "ad_banner", "clean"])', sandbox);

    assert.ok(window.document.head);
    assert.ok(window.document.body);
    assert.ok(window.document.getElementById('keep'));
    assert.strictEqual(window.document.querySelector('#wrap span').textContent, 'clean');
  });

  await t.test('fingerprintRandomization does not drift AudioBuffer channel data across repeated reads', () => {
    const sandbox = {
      console,
      location: { hostname: 'audio.example.com' },
      crypto: {
        getRandomValues: buf => {
          for (let i = 0; i < buf.length; i++) buf[i] = (i + 3) & 0xff;
          return buf;
        }
      },
      Uint8Array,
      Uint8ClampedArray
    };
    sandbox.self = sandbox;
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(`
      class AudioBuffer {
        constructor() { this._channels = [new Float32Array(2048), new Float32Array(2048)]; }
        getChannelData(ch = 0) { return this._channels[ch | 0]; }
        copyFromChannel(dest, ch = 0) { dest.set(this._channels[ch | 0].subarray(0, dest.length)); }
      }
      self.AudioBuffer = AudioBuffer;
    `, sandbox);
    vm.runInContext(fingerprintRandomizationCode, sandbox);

    const results = vm.runInContext(`(() => {
      const ab = new AudioBuffer();
      const first = Array.from(ab.getChannelData(0));
      const second = Array.from(ab.getChannelData(0));
      const copy0 = new Float32Array(2048);
      ab.copyFromChannel(copy0, 0);
      const copy1 = new Float32Array(2048);
      ab.copyFromChannel(copy1, 1);

      const fresh = new AudioBuffer();
      const freshCopy = new Float32Array(2048);
      fresh.copyFromChannel(freshCopy, 0);
      const freshDirect = Array.from(fresh.getChannelData(0));

      return {
        nonZero: first.some(v => v !== 0),
        drift: first.some((v, i) => v !== second[i]),
        copy0Mismatch: first.some((v, i) => v !== copy0[i]),
        copy1Farbled: Array.from(copy1).some(v => v !== 0),
        copy1Matches: first.every((v, i) => v === copy1[i]),
        freshFarbled: Array.from(freshCopy).some(v => v !== 0),
        freshMatches: freshDirect.every((v, i) => v === freshCopy[i])
      };
    })()`, sandbox);
    assert.strictEqual(results.nonZero, true);
    assert.strictEqual(results.drift, false);
    assert.strictEqual(results.copy0Mismatch, false);
    assert.strictEqual(results.copy1Farbled, true);
    assert.strictEqual(results.copy1Matches, true);
    assert.strictEqual(results.freshFarbled, true);
    assert.strictEqual(results.freshMatches, true);
  });

  await t.test('fingerprintRandomization farbles Canvas 2D pixels deterministically and restores after encoding', () => {
    function makeCanvasSandbox(saltBytes) {
      const backing = new Uint8ClampedArray(64 * 4);
      for (let i = 0; i < backing.length; i++) backing[i] = (i * 17 + 5) & 255;
      const original = new Uint8ClampedArray(backing);
      const encodedSnapshots = [];

      const sandbox = {
        console,
        location: { hostname: 'canvas.example.com' },
        crypto: {
          getRandomValues: buf => {
            for (let i = 0; i < buf.length; i++) buf[i] = saltBytes[i % saltBytes.length];
            return buf;
          }
        },
        Uint8Array,
        Uint8ClampedArray
      };
      sandbox.self = sandbox;
      sandbox.window = sandbox;
      sandbox.globalThis = sandbox;
      vm.createContext(sandbox);
      sandbox.__backing = backing;
      sandbox.__encodedSnapshots = encodedSnapshots;
      vm.runInContext(`
        class CanvasRenderingContext2D {
          getImageData(_x, _y, w, h) {
            return { width: w, height: h, data: new Uint8ClampedArray(self.__backing) };
          }
          putImageData(img) {
            self.__backing.set(img.data);
          }
        }
        const sharedCtx = new CanvasRenderingContext2D();
        class HTMLCanvasElement {
          constructor() { this.width = 64; this.height = 1; }
          getContext(type) { return type === '2d' ? sharedCtx : null; }
          toDataURL() {
            const snap = Array.from(self.__backing);
            self.__encodedSnapshots.push(snap);
            return snap.join(',');
          }
        }
        self.CanvasRenderingContext2D = CanvasRenderingContext2D;
        self.HTMLCanvasElement = HTMLCanvasElement;
      `, sandbox);
      vm.runInContext(fingerprintRandomizationCode, sandbox);
      return { sandbox, backing, original, encodedSnapshots };
    }

    const first = makeCanvasSandbox([1, 2, 3, 4, 5, 6, 7, 8]);
    const read1 = vm.runInContext('Array.from(new HTMLCanvasElement().getContext("2d").getImageData(0, 0, 64, 1).data)', first.sandbox);
    const read2 = vm.runInContext('Array.from(new HTMLCanvasElement().getContext("2d").getImageData(0, 0, 64, 1).data)', first.sandbox);

    assert.deepStrictEqual(read1, read2);
    let rgbDiffs = 0;
    for (let i = 0; i < first.original.length; i++) {
      if ((i & 3) === 3) {
        assert.strictEqual(read1[i], first.original[i], 'alpha channel must remain untouched');
      } else {
        const delta = read1[i] ^ first.original[i];
        assert.ok(delta === 0 || delta === 1, 'RGB perturbation must be at most 1 LSB');
        if (delta === 1) rgbDiffs++;
      }
    }
    assert.ok(rgbDiffs > 0, 'Canvas 2D getImageData must perturb at least one RGB byte');

    const encoded1 = vm.runInContext('new HTMLCanvasElement().toDataURL()', first.sandbox);
    const encoded2 = vm.runInContext('new HTMLCanvasElement().toDataURL()', first.sandbox);
    assert.strictEqual(encoded1, encoded2);
    assert.deepStrictEqual(first.encodedSnapshots[0], read1);
    assert.deepStrictEqual(Array.from(first.backing), Array.from(first.original), 'canvas backing buffer must be restored after encoding');

    const second = makeCanvasSandbox([8, 7, 6, 5, 4, 3, 2, 1]);
    const otherRead = vm.runInContext('Array.from(new HTMLCanvasElement().getContext("2d").getImageData(0, 0, 64, 1).data)', second.sandbox);
    assert.notDeepStrictEqual(read1, otherRead);
  });
});
