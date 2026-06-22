const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const quietConsoleCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content', 'quiet_console.js'), 'utf8');

function createSandbox({ hostname = 'example.com' } = {}) {
  let nativeFetchCalls = 0;
  let nativeXHROpenCalls = 0;
  let nativeXHRSendCalls = 0;
  let nativeBeaconCalls = 0;

  class EventTargetMock {
    constructor() {
      this._listeners = Object.create(null);
    }
    addEventListener(type, callback) {
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push(callback);
    }
    dispatchEvent(event) {
      const listeners = this._listeners[event?.type] || [];
      for (const callback of listeners) callback.call(this, event);
      return true;
    }
  }

  class NodeMock extends EventTargetMock {
    constructor() {
      super();
      this.nodeType = 1;
      this.children = [];
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    insertBefore(child, referenceNode) {
      const index = this.children.indexOf(referenceNode);
      if (index === -1) this.children.push(child);
      else this.children.splice(index, 0, child);
      return child;
    }
  }

  class ElementMock extends NodeMock {
    constructor(tagName = 'div') {
      super();
      this.tagName = String(tagName).toUpperCase();
      this._attrs = Object.create(null);
    }
    setAttribute(name, value) {
      this._attrs[String(name).toLowerCase()] = String(value);
    }
    getAttribute(name) {
      return this._attrs[String(name).toLowerCase()] || '';
    }
    querySelectorAll(selector) {
      const out = [];
      const wanted = String(selector)
        .split(',')
        .map(part => part.trim().match(/^([a-z]+)\[([a-z]+)\]$/i))
        .filter(Boolean)
        .map(match => ({ tag: match[1].toUpperCase(), attr: match[2].toLowerCase() }));
      const visit = (node) => {
        if (node && node.nodeType === 1) {
          if (wanted.some(item => node.tagName === item.tag && !!node.getAttribute(item.attr))) {
            out.push(node);
          }
          for (const child of node.children || []) visit(child);
        }
      };
      for (const child of this.children) visit(child);
      return out;
    }
  }

  class HTMLScriptElementMock extends ElementMock {
    constructor() { super('script'); }
    get src() { return this._src || this.getAttribute('src'); }
    set src(value) {
      this._src = String(value);
      ElementMock.prototype.setAttribute.call(this, 'src', value);
    }
  }

  class HTMLImageElementMock extends ElementMock {
    constructor() { super('img'); }
    get src() { return this._src || this.getAttribute('src'); }
    set src(value) {
      this._src = String(value);
      ElementMock.prototype.setAttribute.call(this, 'src', value);
    }
  }

  class HTMLIFrameElementMock extends ElementMock {
    constructor() { super('iframe'); }
    get src() { return this._src || this.getAttribute('src'); }
    set src(value) {
      this._src = String(value);
      ElementMock.prototype.setAttribute.call(this, 'src', value);
    }
  }

  class HTMLLinkElementMock extends ElementMock {
    constructor() { super('link'); }
    get href() { return this._href || this.getAttribute('href'); }
    set href(value) {
      this._href = String(value);
      ElementMock.prototype.setAttribute.call(this, 'href', value);
    }
  }

  class XMLHttpRequestMock extends EventTargetMock {
    open() { nativeXHROpenCalls++; }
    send() { nativeXHRSendCalls++; }
  }

  const document = new ElementMock('#document');
  document.createElement = (tag) => {
    const lower = String(tag).toLowerCase();
    if (lower === 'script') return new HTMLScriptElementMock();
    if (lower === 'img') return new HTMLImageElementMock();
    if (lower === 'iframe') return new HTMLIFrameElementMock();
    if (lower === 'link') return new HTMLLinkElementMock();
    return new ElementMock(tag);
  };

  class ResponseMock {
    constructor(body, init = {}) {
      this.body = body;
      this.status = init.status || 200;
      this.statusText = init.statusText || 'OK';
      this.headers = init.headers || {};
      this.ok = this.status >= 200 && this.status < 300;
    }
    async text() { return this.body; }
    async json() { return JSON.parse(this.body); }
  }

  const navigator = {
    sendBeacon() {
      nativeBeaconCalls++;
      return false;
    }
  };

  const sandbox = {
    console,
    window: {
      location: { hostname },
      fetch: function fetch() {
        nativeFetchCalls++;
        return Promise.resolve(new ResponseMock('native', { status: 299, statusText: 'Native' }));
      },
      XMLHttpRequest: XMLHttpRequestMock,
      navigator,
      Element: ElementMock,
      Node: NodeMock,
      HTMLScriptElement: HTMLScriptElementMock,
      HTMLImageElement: HTMLImageElementMock,
      HTMLIFrameElement: HTMLIFrameElementMock,
      HTMLLinkElement: HTMLLinkElementMock
    },
    document,
    navigator,
    XMLHttpRequest: XMLHttpRequestMock,
    Element: ElementMock,
    Node: NodeMock,
    HTMLScriptElement: HTMLScriptElementMock,
    HTMLImageElement: HTMLImageElementMock,
    HTMLIFrameElement: HTMLIFrameElementMock,
    HTMLLinkElement: HTMLLinkElementMock,
    Response: ResponseMock,
    CustomEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    Promise,
    JSON,
    String,
    Object,
    Function,
    Map,
    Array,
    Set,
    Error,
    URL
  };
  const originals = {
    fetch: sandbox.window.fetch,
    sendBeacon: sandbox.navigator.sendBeacon,
    xhrOpen: sandbox.XMLHttpRequest.prototype.open,
    xhrSend: sandbox.XMLHttpRequest.prototype.send,
    setAttribute: sandbox.Element.prototype.setAttribute
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(quietConsoleCode, sandbox);

  sandbox.getNativeCallCounts = () => ({
    fetch: nativeFetchCalls,
    xhrOpen: nativeXHROpenCalls,
    xhrSend: nativeXHRSendCalls,
    beacon: nativeBeaconCalls
  });
  sandbox.setQuietConfig = (detail) => {
    sandbox.document.dispatchEvent(new sandbox.CustomEvent('__CHROMA_QUIET_CONSOLE_CONFIG__', { detail }));
  };
  sandbox.pageToString = (expression) => vm.runInContext(`${expression}.toString()`, sandbox);
  sandbox.originals = originals;
  return sandbox;
}

test('Quiet Console shared page layer', async (t) => {
  await t.test('short-circuits generic ad fetches', async () => {
    const sandbox = createSandbox();
    sandbox.setQuietConfig({ enabled: true, quietConsole: true });

    const response = await sandbox.window.fetch('https://googleads.g.doubleclick.net/pagead/id');

    assert.notStrictEqual(sandbox.window.fetch, sandbox.originals.fetch);
    assert.strictEqual(sandbox.getNativeCallCounts().fetch, 0);
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), {});
    assert.strictEqual(sandbox.pageToString('window.fetch'), 'function fetch() { [native code] }');
  });

  await t.test('passes generic ad fetches through by default', async () => {
    const sandbox = createSandbox();

    const response = await sandbox.window.fetch('https://googleads.g.doubleclick.net/pagead/id');

    assert.strictEqual(sandbox.window.fetch, sandbox.originals.fetch);
    assert.strictEqual(sandbox.navigator.sendBeacon, sandbox.originals.sendBeacon);
    assert.strictEqual(sandbox.XMLHttpRequest.prototype.open, sandbox.originals.xhrOpen);
    assert.strictEqual(sandbox.XMLHttpRequest.prototype.send, sandbox.originals.xhrSend);
    assert.strictEqual(sandbox.Element.prototype.setAttribute, sandbox.originals.setAttribute);
    assert.strictEqual(sandbox.getNativeCallCounts().fetch, 1);
    assert.strictEqual(response.status, 299);
  });

  await t.test('passes generic ad fetches through when quiet is off', async () => {
    const sandbox = createSandbox();
    sandbox.setQuietConfig({ enabled: true, quietConsole: true });
    sandbox.setQuietConfig({ enabled: true, quietConsole: false });

    const response = await sandbox.window.fetch('https://googleads.g.doubleclick.net/pagead/id');

    assert.strictEqual(sandbox.getNativeCallCounts().fetch, 1);
    assert.strictEqual(response.status, 299);
  });

  await t.test('short-circuits generic ad XHRs', () => {
    const sandbox = createSandbox();
    sandbox.setQuietConfig({ enabled: true, quietConsole: true });
    const xhr = new sandbox.XMLHttpRequest();
    let readyStateSeen = false;
    xhr.onreadystatechange = () => { readyStateSeen = xhr.readyState === 4; };

    xhr.open('POST', 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js');
    xhr.send();

    assert.deepStrictEqual(sandbox.getNativeCallCounts(), {
      fetch: 0,
      xhrOpen: 0,
      xhrSend: 0,
      beacon: 0
    });
    assert.strictEqual(readyStateSeen, true);
    assert.strictEqual(xhr.status, 200);
    assert.strictEqual(xhr.responseText, '{}');
  });

  await t.test('passes generic ad XHRs through when quiet is off', () => {
    const sandbox = createSandbox();
    sandbox.setQuietConfig({ enabled: true, quietConsole: false });
    const xhr = new sandbox.XMLHttpRequest();

    xhr.open('POST', 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js');
    xhr.send();

    assert.strictEqual(sandbox.getNativeCallCounts().xhrOpen, 1);
    assert.strictEqual(sandbox.getNativeCallCounts().xhrSend, 1);
  });

  await t.test('short-circuits generic ad beacons', () => {
    const sandbox = createSandbox();
    sandbox.setQuietConfig({ enabled: true, quietConsole: true });

    const result = sandbox.navigator.sendBeacon('https://www.facebook.com/tr/?id=123');

    assert.strictEqual(result, true);
    assert.strictEqual(sandbox.getNativeCallCounts().beacon, 0);
    assert.strictEqual(sandbox.pageToString('navigator.sendBeacon'), 'function sendBeacon() { [native code] }');
  });

  await t.test('replaces dynamic ad resource URLs', () => {
    const sandbox = createSandbox();
    sandbox.setQuietConfig({ enabled: true, quietConsole: true });
    const script = new sandbox.HTMLScriptElement();
    const image = new sandbox.HTMLImageElement();
    const frame = new sandbox.HTMLIFrameElement();
    const link = new sandbox.HTMLLinkElement();

    script.src = 'https://static.doubleclick.net/instream/ad_status.js';
    image.setAttribute('src', 'https://www.google-analytics.com/collect?v=1');
    frame.setAttribute('src', 'https://adservice.google.com/pagead/ads');
    link.href = 'https://www.googletagmanager.com/gtm.js?id=GTM-TEST';

    assert.match(script.src, /^data:text\/javascript/);
    assert.match(image.getAttribute('src'), /^data:image\/gif/);
    assert.strictEqual(frame.getAttribute('src'), 'about:blank');
    assert.match(link.href, /^data:text\/css/);
  });

  await t.test('passes first-party ad-like paths through on ordinary hosts', async () => {
    const sandbox = createSandbox();
    sandbox.setQuietConfig({ enabled: true, quietConsole: true });
    const script = new sandbox.HTMLScriptElement();

    const response = await sandbox.window.fetch('https://example.com/api/ad_status');
    script.src = 'https://example.com/assets/ad_status.js';

    assert.strictEqual(sandbox.getNativeCallCounts().fetch, 1);
    assert.strictEqual(response.status, 299);
    assert.strictEqual(script.src, 'https://example.com/assets/ad_status.js');
  });

  await t.test('does not run on safety-excluded hosts', async () => {
    const sandbox = createSandbox({ hostname: 'accounts.google.com' });
    sandbox.setQuietConfig({ enabled: true, quietConsole: true });

    const response = await sandbox.window.fetch('https://googleads.g.doubleclick.net/pagead/id');

    assert.strictEqual(sandbox.getNativeCallCounts().fetch, 1);
    assert.strictEqual(response.status, 299);
  });
});
