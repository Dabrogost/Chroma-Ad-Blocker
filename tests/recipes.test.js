const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const recipesCode = fs.readFileSync(path.join(root, 'extension', 'content', 'recipes.js'), 'utf8');

function createHarness({ enabled = false, bridge = true, readyState = 'complete', hostname = 'www.allrecipes.com' } = {}) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const frames = new Map();
  const cancelledFrames = new Set();
  const observers = [];
  const baseCalls = { alert: [], confirm: [], assign: [], replace: [], reload: 0 };
  let nextFrame = 1;

  function addListener(registry, type, callback, options) {
    const entries = registry.get(type) || [];
    entries.push({ callback, once: options?.once === true });
    registry.set(type, entries);
  }

  function removeListener(registry, type, callback) {
    const entries = registry.get(type) || [];
    registry.set(type, entries.filter(entry => entry.callback !== callback));
  }

  function dispatch(registry, event) {
    for (const entry of [...(registry.get(event.type) || [])]) {
      entry.callback(event);
      if (entry.once) removeListener(registry, event.type, entry.callback);
    }
    return true;
  }

  class StyleDeclaration {
    constructor() { this.values = new Map(); }
    getPropertyValue(name) { return this.values.get(name)?.value || ''; }
    getPropertyPriority(name) { return this.values.get(name)?.priority || ''; }
    setProperty(name, value, priority = '') {
      this.values.set(name, { value: String(value), priority: String(priority) });
    }
    removeProperty(name) {
      const prior = this.getPropertyValue(name);
      this.values.delete(name);
      return prior;
    }
  }

  class Element {
    constructor(tag = 'div') {
      this.tagName = String(tag).toUpperCase();
      this.nodeType = 1;
      this.id = '';
      this.style = new StyleDeclaration();
      this.attributes = new Map();
      this.children = [];
      this.parentNode = null;
      this.isConnected = false;
      this._insideRecipe = false;
      this._hiddenCandidates = [];
      this._idCandidates = [];
      this.removeCalls = 0;
    }
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      child.isConnected = true;
      return child;
    }
    removeChild(child) {
      this.children = this.children.filter(item => item !== child);
      child.parentNode = null;
      child.isConnected = false;
      return child;
    }
    closest() { return this._insideRecipe ? {} : null; }
  }

  const baseSetAttribute = function setAttribute(name, value) {
    this.attributes.set(String(name).toLowerCase(), String(value));
  };
  const baseGetAttribute = function getAttribute(name) {
    return this.attributes.get(String(name).toLowerCase()) ?? null;
  };
  const nativeLookingSetAttribute = new Proxy(baseSetAttribute, {});
  const nativeLookingGetAttribute = new Proxy(baseGetAttribute, {});
  Object.defineProperty(Element.prototype, 'setAttribute', {
    value: nativeLookingSetAttribute, writable: true, configurable: true
  });
  Object.defineProperty(Element.prototype, 'getAttribute', {
    value: nativeLookingGetAttribute, writable: true, configurable: true
  });
  Object.defineProperty(Element.prototype, 'remove', {
    value: function remove() { this.removeCalls++; }, writable: true, configurable: true
  });

  class HTMLScriptElement extends Element {
    constructor() { super('script'); this._src = ''; }
  }
  const nativeScriptDescriptor = {
    configurable: true,
    enumerable: true,
    get() { return this._src; },
    set(value) { this._src = String(value); }
  };
  Object.defineProperty(HTMLScriptElement.prototype, 'src', nativeScriptDescriptor);

  class Location {
    assign(url) { baseCalls.assign.push(url); }
    replace(url) { baseCalls.replace.push(url); }
    reload() { baseCalls.reload++; }
  }
  class History { go() {} }

  class Document {
    constructor() {
      this.readyState = readyState;
      this.adoptedStyleSheets = [];
      this.documentElement = new Element('html');
      this.head = new Element('head');
      this.body = new Element('body');
      this._hiddenCandidates = [];
      this._idCandidates = [];
    }
    createElement(tag) {
      return String(tag).toLowerCase() === 'script'
        ? new HTMLScriptElement()
        : new Element(tag);
    }
    querySelectorAll(selector) {
      return selector === '[id]' ? (this._idCandidates || []) : (this._hiddenCandidates || []);
    }
    addEventListener(type, callback, options) {
      addListener(documentListeners, type, callback, options);
    }
    removeEventListener(type, callback) {
      removeListener(documentListeners, type, callback);
    }
    dispatchEvent(event) { return dispatch(documentListeners, event); }
  }

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.connected = false;
      observers.push(this);
    }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  }

  class FakeStyleSheet {
    replaceSync(css) { this.css = css; }
  }

  const document = new Document();
  const location = new Location();
  location.hostname = hostname;
  const history = new History();
  const window = {
    location,
    alert(message) { baseCalls.alert.push(message); return 'alerted'; },
    confirm(message) { baseCalls.confirm.push(message); return true; },
    addEventListener(type, callback, options) {
      addListener(windowListeners, type, callback, options);
    },
    removeEventListener(type, callback) { removeListener(windowListeners, type, callback); },
    postMessage() {},
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { cancelledFrames.add(id); }
  };

  const bridgeState = { enabled, revision: 0 };
  function installBridge() {
    const api = Object.freeze({
      createCssStyleSheet: () => new FakeStyleSheet(),
      getAdoptedStyleSheets: () => document.adoptedStyleSheets,
      setAdoptedStyleSheets: sheets => { document.adoptedStyleSheets = sheets; },
      requestAnimationFrame: callback => window.requestAnimationFrame(callback),
      cancelAnimationFrame: id => window.cancelAnimationFrame(id),
      addEventListener: (type, callback, options) => window.addEventListener(type, callback, options),
      removeEventListener: (type, callback) => window.removeEventListener(type, callback)
    });
    const internal = {};
    Object.defineProperties(internal, {
      config: { enumerable: true, get: () => Object.freeze({ enabled: bridgeState.enabled }) },
      revision: { enumerable: true, get: () => bridgeState.revision },
      api: { enumerable: true, value: api }
    });
    Object.freeze(internal);
    Object.defineProperty(window, '__CHROMA_INTERNAL__', {
      value: internal, writable: false, configurable: false
    });
  }
  if (bridge) installBridge();

  const originals = {
    appendChild: Element.prototype.appendChild,
    setAttribute: Element.prototype.setAttribute,
    getAttribute: Element.prototype.getAttribute,
    scriptDescriptor: Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src'),
    assign: Location.prototype.assign,
    replace: Location.prototype.replace,
    reload: Location.prototype.reload,
    alert: window.alert,
    confirm: window.confirm
  };

  const sandbox = {
    window,
    document,
    location,
    history,
    Document,
    Element,
    HTMLScriptElement,
    Location,
    History,
    MutationObserver: FakeMutationObserver,
    CSSStyleSheet: FakeStyleSheet,
    Node: { ELEMENT_NODE: 1, prototype: Element.prototype },
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
    },
    console,
    Map,
    Set,
    WeakMap,
    Reflect,
    Object,
    Array,
    Number,
    String
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(recipesCode, sandbox);

  return {
    sandbox,
    window,
    document,
    bridgeState,
    observers,
    frames,
    cancelledFrames,
    baseCalls,
    originals,
    classes: { Element, HTMLScriptElement, Location },
    update(nextEnabled, { bump = true } = {}) {
      bridgeState.enabled = nextEnabled;
      if (bump) bridgeState.revision++;
      document.dispatchEvent(new sandbox.CustomEvent('__CHROMA_CONFIG_UPDATE__', {
        detail: { enabled: nextEnabled }
      }));
    },
    dispatchDocument(type, detail) {
      document.dispatchEvent(new sandbox.CustomEvent(type, { detail }));
    },
    listenerCount(type) { return (documentListeners.get(type) || []).length; },
    activeObservers() { return observers.filter(observer => observer.connected); },
    runFrames() {
      for (const [id, callback] of [...frames]) {
        frames.delete(id);
        if (!cancelledFrames.has(id)) callback();
      }
    },
    frameIds() { return [...frames.keys()]; },
    runFrame(id, { ignoreCancellation = false } = {}) {
      const callback = frames.get(id);
      frames.delete(id);
      if (callback && (ignoreCancellation || !cancelledFrames.has(id))) callback();
    }
  };
}

test('recipe MAIN-world lifecycle', async t => {
  await t.test('stays inert without a trusted bridge and while master protection is off', () => {
    for (const options of [{ bridge: false }, { enabled: false }]) {
      const harness = createHarness(options);
      assert.deepStrictEqual(harness.document.adoptedStyleSheets, []);
      assert.strictEqual(harness.activeObservers().length, 0);
      assert.strictEqual(harness.window.alert, harness.originals.alert);
      assert.strictEqual(harness.classes.Element.prototype.setAttribute, harness.originals.setAttribute);
    }
  });

  await t.test('enabled activation installs containment and disable cleans CSS, observer, inline styles, and APIs', () => {
    const harness = createHarness({ enabled: true });
    const clutter = new harness.classes.Element('div');
    const pageChangedClutter = new harness.classes.Element('div');
    clutter.style.setProperty('display', 'block');
    harness.document._hiddenCandidates = [clutter, pageChangedClutter];

    // The initial synchronous sweep ran before the fixture was added; drive a
    // production observer batch for the late node.
    const observer = harness.activeObservers()[0];
    assert.ok(observer);
    observer.callback([{ addedNodes: [clutter, pageChangedClutter] }]);
    harness.runFrames();

    assert.strictEqual(harness.document.adoptedStyleSheets.length, 1);
    assert.strictEqual(clutter.style.getPropertyValue('display'), 'none');
    assert.strictEqual(clutter.style.getPropertyPriority('display'), 'important');
    pageChangedClutter.style.setProperty('display', 'grid');
    assert.notStrictEqual(harness.window.alert, harness.originals.alert);

    const script = new harness.classes.HTMLScriptElement();
    script.src = 'https://content-loader.com/trap.js';
    assert.strictEqual(script.src, 'data:text/javascript,void%200');
    assert.strictEqual(script.getAttribute('data-chroma-neutered'), '1');
    harness.window.alert('Please allow ads on this site');
    assert.deepStrictEqual(harness.baseCalls.alert, []);

    const pageSheet = { page: true };
    harness.document.adoptedStyleSheets.push(pageSheet);
    harness.update(false);

    assert.deepStrictEqual(harness.document.adoptedStyleSheets, [pageSheet]);
    assert.strictEqual(harness.activeObservers().length, 0);
    assert.strictEqual(clutter.style.getPropertyValue('display'), 'block');
    assert.strictEqual(pageChangedClutter.style.getPropertyValue('display'), 'grid');
    assert.strictEqual(harness.window.alert, harness.originals.alert);
    assert.strictEqual(harness.classes.Element.prototype.setAttribute, harness.originals.setAttribute);
    assert.strictEqual(harness.classes.Location.prototype.reload, harness.originals.reload);
    assert.strictEqual(
      Object.getOwnPropertyDescriptor(harness.classes.HTMLScriptElement.prototype, 'src').set,
      harness.originals.scriptDescriptor.set
    );
  });

  await t.test('re-enable does not accumulate sheets, observers, or active wrappers', () => {
    const harness = createHarness({ enabled: false });
    for (let cycle = 0; cycle < 3; cycle++) {
      harness.update(true);
      assert.strictEqual(harness.document.adoptedStyleSheets.length, 1);
      assert.strictEqual(harness.activeObservers().length, 1);
      harness.window.alert(`benign-${cycle}`);
      assert.strictEqual(harness.baseCalls.alert.length, cycle + 1);
      harness.update(false);
      assert.strictEqual(harness.document.adoptedStyleSheets.length, 0);
      assert.strictEqual(harness.activeObservers().length, 0);
      assert.strictEqual(harness.window.alert, harness.originals.alert);
    }
  });

  await t.test('preserves page replacements and leaves a buried Chroma wrapper permanently inert', () => {
    const harness = createHarness({ enabled: true });
    const chromaAlert = harness.window.alert;
    const pageAlert = function pageAlert(message) { return chromaAlert.call(this, message); };
    const pageConfirm = function pageConfirm() { return 'page-confirm'; };
    harness.window.alert = pageAlert;
    harness.window.confirm = pageConfirm;

    const chromaSetAttribute = harness.classes.Element.prototype.setAttribute;
    const chromaGetAttribute = harness.classes.Element.prototype.getAttribute;
    const pageSetAttribute = function pageSetAttribute(name, value) {
      return Reflect.apply(chromaSetAttribute, this, [name, value]);
    };
    const pageGetAttribute = function pageGetAttribute(name) {
      return Reflect.apply(chromaGetAttribute, this, [name]);
    };
    harness.classes.Element.prototype.setAttribute = pageSetAttribute;
    harness.classes.Element.prototype.getAttribute = pageGetAttribute;

    const chromaSrc = Object.getOwnPropertyDescriptor(harness.classes.HTMLScriptElement.prototype, 'src');
    const pageSrc = {
      configurable: true,
      enumerable: true,
      get() { return Reflect.apply(chromaSrc.get, this, []); },
      set(value) { return Reflect.apply(chromaSrc.set, this, [value]); }
    };
    Object.defineProperty(harness.classes.HTMLScriptElement.prototype, 'src', pageSrc);

    harness.update(false);
    assert.strictEqual(harness.window.alert, pageAlert);
    assert.strictEqual(harness.window.confirm, pageConfirm);
    assert.strictEqual(harness.classes.Element.prototype.setAttribute, pageSetAttribute);
    assert.strictEqual(harness.classes.Element.prototype.getAttribute, pageGetAttribute);
    assert.strictEqual(
      Object.getOwnPropertyDescriptor(harness.classes.HTMLScriptElement.prototype, 'src').set,
      pageSrc.set
    );

    harness.window.alert('Please allow ads on this site');
    assert.deepStrictEqual(harness.baseCalls.alert, ['Please allow ads on this site']);
    const script = new harness.classes.HTMLScriptElement();
    script.src = 'https://content-loader.com/after-disable.js';
    assert.strictEqual(script.src, 'https://content-loader.com/after-disable.js');
    script.setAttribute('src', 'https://content-loader.com/attribute-after-disable.js');
    assert.strictEqual(script.getAttribute('src'), 'https://content-loader.com/attribute-after-disable.js');

    harness.update(true);
    assert.notStrictEqual(harness.classes.Element.prototype.setAttribute, pageSetAttribute);
    const activeScript = new harness.classes.HTMLScriptElement();
    activeScript.setAttribute('src', 'https://content-loader.com/attribute-after-enable.js');
    assert.strictEqual(activeScript.getAttribute('src'), 'data:text/javascript,void%200');
    harness.update(false);
    assert.strictEqual(harness.window.alert, pageAlert);
    assert.strictEqual(harness.classes.Element.prototype.setAttribute, pageSetAttribute);
    assert.strictEqual(harness.classes.Element.prototype.getAttribute, pageGetAttribute);
    harness.window.alert('Allow ads again');
    assert.strictEqual(harness.baseCalls.alert.at(-1), 'Allow ads again');
  });

  await t.test('a stale canceled frame cannot erase the next enabled generation', () => {
    const harness = createHarness({ enabled: true });
    const oldNode = new harness.classes.Element('div');
    harness.activeObservers()[0].callback([{ addedNodes: [oldNode] }]);
    const oldFrame = harness.frameIds()[0];

    harness.update(false);
    harness.update(true);
    const newNode = new harness.classes.Element('div');
    harness.document._hiddenCandidates = [newNode];
    harness.activeObservers()[0].callback([{ addedNodes: [newNode] }]);
    const newFrame = harness.frameIds().find(id => id !== oldFrame);
    assert.ok(newFrame);

    harness.runFrame(oldFrame, { ignoreCancellation: true });
    harness.runFrame(newFrame);
    assert.strictEqual(newNode.style.getPropertyValue('display'), 'none');
    assert.strictEqual(newNode.style.getPropertyPriority('display'), 'important');
  });

  await t.test('ignores forged or duplicate notifications until bridge revision advances', () => {
    const harness = createHarness({ enabled: false });
    harness.update(true, { bump: false });
    assert.strictEqual(harness.document.adoptedStyleSheets.length, 0);
    harness.dispatchDocument('__CHROMA_CONFIG_UPDATE__', { enabled: true });
    assert.strictEqual(harness.document.adoptedStyleSheets.length, 0);

    harness.update(true);
    assert.strictEqual(harness.document.adoptedStyleSheets.length, 1);
    harness.dispatchDocument('__CHROMA_CONFIG_UPDATE__', { enabled: false });
    assert.strictEqual(harness.document.adoptedStyleSheets.length, 1);
  });

  await t.test('disable before DOMContentLoaded cancels deferred startup', () => {
    const harness = createHarness({ enabled: true, readyState: 'loading' });
    assert.strictEqual(harness.listenerCount('DOMContentLoaded'), 1);
    assert.strictEqual(harness.activeObservers().length, 0);
    harness.update(false);
    assert.strictEqual(harness.listenerCount('DOMContentLoaded'), 0);
    harness.dispatchDocument('DOMContentLoaded');
    assert.strictEqual(harness.activeObservers().length, 0);
    assert.deepStrictEqual(harness.document.adoptedStyleSheets, []);
  });
});

test('registered Yahoo recipe contains recovery before bridge delivery and restores APIs when disabled', () => {
  for (const hostname of ['yahoo.com', 'www.yahoo.com']) {
    const harness = createHarness({ hostname });
    const { document, classes } = harness;
    const originalAppend = harness.originals.appendChild;
    document.currentScript = { id: 'ad-shield-container' };
    const payload = new classes.HTMLScriptElement();
    payload.textContent = 'window.recoveryWasExecuted = true';
    assert.strictEqual(document.head.appendChild(payload), payload);
    assert.strictEqual(payload.isConnected, false, 'Inline recovery must not reach the document');
    harness.update(true);

    document.currentScript = { id: 'normal-yahoo-app' };
    const appScript = new classes.HTMLScriptElement();
    document.head.appendChild(appScript);
    assert.strictEqual(appScript.isConnected, true, 'Unrelated inline scripts must still execute');

    for (const src of [
      'https://s.yimg.com/du/site/fbeasdplgxqkkjim.js',
      'https://s.yimg.com/du/site/rotated-loader_2.js?v=2'
    ]) {
      const loader = new classes.HTMLScriptElement();
      loader.src = src;
      assert.strictEqual(loader.src, 'data:text/javascript,void%200');
      for (const event of ['onload', 'onerror']) {
        loader.setAttribute(event, 'eval(scrambledRecoveryPayload)');
        assert.notStrictEqual(loader.getAttribute(event), 'eval(scrambledRecoveryPayload)');
        // Simulate an attribute already installed by the parser or a saved native setter.
        harness.originals.setAttribute.call(loader, event, 'eval(scrambledRecoveryPayload)');
        assert.strictEqual(loader.getAttribute(event), '', 'Sibling scripts must not recover the payload');
      }
    }

    for (const src of [
      'https://s.yimg.com/du/benji/app.js',
      'https://s.yimg.com/du/site/nested/app.js',
      'https://s.yimg.com.example.com/du/site/loader.js'
    ]) {
      const app = new classes.HTMLScriptElement();
      app.src = src;
      assert.strictEqual(app.src, src);
      app.setAttribute('onload', 'appReady()');
      assert.strictEqual(app.getAttribute('onload'), 'appReady()');
    }

    harness.update(false);
    assert.strictEqual(classes.Element.prototype.appendChild, originalAppend);
    document.currentScript = { id: 'ad-shield-container' };
    const restoredScript = new classes.HTMLScriptElement();
    restoredScript.src = 'https://s.yimg.com/du/site/loader.js';
    assert.strictEqual(restoredScript.src, 'https://s.yimg.com/du/site/loader.js');
    document.head.appendChild(restoredScript);
    assert.strictEqual(restoredScript.isConnected, true);
  }
});

test('first authenticated off delivery releases the registered Yahoo startup protection', () => {
  const harness = createHarness({ hostname: 'www.yahoo.com' });
  assert.notStrictEqual(harness.classes.Element.prototype.appendChild, harness.originals.appendChild);
  harness.dispatchDocument('__CHROMA_CONFIG_UPDATE__', { enabled: false });
  assert.notStrictEqual(harness.classes.Element.prototype.appendChild, harness.originals.appendChild);
  harness.update(false);
  assert.strictEqual(harness.classes.Element.prototype.appendChild, harness.originals.appendChild);
  assert.strictEqual(harness.activeObservers().length, 0);
  assert.deepStrictEqual(harness.document.adoptedStyleSheets, []);
});

test('Yahoo containment excludes other Yahoo hosts and unrelated recipe sites', () => {
  for (const options of [
    { hostname: 'mail.yahoo.com', enabled: true },
    { hostname: 'finance.yahoo.com', enabled: true },
    { hostname: 'notyahoo.com', enabled: true },
    { hostname: 'www.yahoo.com.example.com', enabled: true },
    { hostname: 'www.allrecipes.com', enabled: true }
  ]) {
    const harness = createHarness(options);
    const script = new harness.classes.HTMLScriptElement();
    script.src = 'https://s.yimg.com/du/site/loader.js';
    assert.strictEqual(script.src, 'https://s.yimg.com/du/site/loader.js');
    harness.document.currentScript = { id: 'ad-shield-container' };
    const inline = new harness.classes.HTMLScriptElement();
    harness.document.head.appendChild(inline);
    assert.strictEqual(inline.isConnected, true);
  }
});

test('recipe manifest entries are covered by the authenticated bridge in execution order', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  const entries = manifest.content_scripts;
  const recipeIndex = entries.findIndex(entry => entry.js?.includes('content/recipes.js'));
  const interceptorIndex = entries.findIndex(entry => entry.js?.includes('content/interceptor.js'));
  const protectionIndex = entries.findIndex(entry => entry.js?.includes('content/protection.js'));
  assert.ok(protectionIndex > -1 && interceptorIndex > protectionIndex && recipeIndex > interceptorIndex);

  const recipe = entries[recipeIndex];
  const interceptor = entries[interceptorIndex];
  const protection = entries[protectionIndex];
  assert.strictEqual(recipe.world, 'MAIN');
  assert.strictEqual(interceptor.world, 'MAIN');
  assert.strictEqual(recipe.run_at, 'document_start');
  assert.strictEqual(recipe.all_frames, true);
  assert.ok(!recipe.matches.includes('*://yahoo.com/*'), 'Yahoo uses conditional early registration');
  assert.ok(!recipe.matches.includes('*://www.yahoo.com/*'));
  for (const match of ['*://yahoo.com/*', '*://www.yahoo.com/*']) {
    assert.ok(interceptor.matches.includes(match));
    assert.ok(protection.matches.includes(match));
  }
  assert.ok(!recipe.matches.includes('*://*.yahoo.com/*'), 'Yahoo Mail and Finance are outside this fix');
  for (const match of recipe.matches) {
    assert.ok(interceptor.matches.includes(match), `${match} must load interceptor before recipes`);
    assert.ok(protection.matches.includes(match), `${match} must load isolated protection`);
  }
});
