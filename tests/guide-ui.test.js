'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const repoRoot = path.join(__dirname, '..');
const guideRoot = path.join(repoRoot, 'extension', 'guide');
const guideJs = fs.readFileSync(path.join(guideRoot, 'guide.js'), 'utf8');
const searchIndex = JSON.parse(
  fs.readFileSync(path.join(guideRoot, 'search-index.json'), 'utf8')
);

function readGuidePage(relativePath) {
  return fs.readFileSync(
    path.join(guideRoot, ...relativePath.split('/')),
    'utf8'
  );
}

function createMediaQueryList(initialMatches) {
  let matches = Boolean(initialMatches);
  const listeners = new Set();

  return {
    get matches() {
      return matches;
    },
    addEventListener(type, listener) {
      if (type === 'change') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'change') listeners.delete(listener);
    },
    setMatches(nextMatches) {
      matches = Boolean(nextMatches);
      for (const listener of listeners) listener({ matches });
    }
  };
}

async function settle(window, turns = 2) {
  for (let turn = 0; turn < turns; turn += 1) {
    await Promise.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));
  }
}

async function createGuideHarness(relativePath, {
  mobile = false,
  searchPayload = searchIndex,
  tabsMode = 'resolve',
  beforeInit
} = {}) {
  const virtualConsole = new VirtualConsole();
  const jsdomErrors = [];
  virtualConsole.on('jsdomError', error => jsdomErrors.push(error));

  const dom = new JSDOM(readGuidePage(relativePath), {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url: `https://extension.test/guide/${relativePath}`,
    virtualConsole
  });
  const { window } = dom;
  const fetchCalls = [];
  const tabCalls = [];
  const fallbackCalls = [];
  const runtimeUrlCalls = [];
  const media = createMediaQueryList(mobile);

  window.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options: options || {} });
    return {
      ok: true,
      json: async () => searchPayload
    };
  };
  window.matchMedia = () => media;
  window.Element.prototype.scrollIntoView = () => {};
  window.open = (url, target, features) => {
    const opened = { opener: {} };
    fallbackCalls.push({ url: String(url), target, features, opened });
    return opened;
  };

  const chrome = {
    runtime: {
      getURL(value) {
        runtimeUrlCalls.push(value);
        return `https://extension.test/${value}`;
      }
    }
  };

  if (tabsMode !== 'none') {
    chrome.tabs = {
      create(info) {
        tabCalls.push(info);
        if (tabsMode === 'throw') throw new Error('tabs unavailable');
        if (tabsMode === 'reject') return Promise.reject(new Error('tabs unavailable'));
        return Promise.resolve(info);
      }
    };
  }
  window.chrome = chrome;

  beforeInit?.({
    window,
    document: window.document,
    media
  });

  window.eval(guideJs);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await settle(window);

  return {
    dom,
    window,
    document: window.document,
    fetchCalls,
    tabCalls,
    fallbackCalls,
    runtimeUrlCalls,
    media,
    jsdomErrors
  };
}

test('offline guide search ranks useful local results and supports keyboard control', async t => {
  const payload = structuredClone(searchIndex);
  payload.pages.unshift({
    title: 'Remote Evil Manual',
    slug: 'remote-evil',
    category: 'Untrusted',
    summary: 'Remote evil search result.',
    headings: [],
    text: 'remote evil',
    url: 'https://malicious.invalid/manual.html',
    settingsPath: null,
    tasks: []
  });

  const harness = await createGuideHarness('index.html', { searchPayload: payload });
  t.after(() => harness.dom.window.close());
  const { window, document, fetchCalls } = harness;
  const input = document.querySelector('[data-guide-search]');
  const results = document.querySelector('[data-guide-search-results]');

  assert.strictEqual(fetchCalls.length, 1);
  assert.strictEqual(fetchCalls[0].url, 'https://extension.test/guide/search-index.json');
  assert.strictEqual(fetchCalls[0].options.credentials, 'same-origin');
  assert.strictEqual(fetchCalls[0].options.cache, 'default');
  assert.doesNotMatch(guideJs, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML|document\.write/);

  document.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: '/',
    bubbles: true,
    cancelable: true
  }));
  assert.strictEqual(document.activeElement, input);

  input.value = 'media proxy';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  let links = [...results.querySelectorAll('.guide-search-result')];
  assert.ok(links.length > 1);
  assert.match(links[0].href, /\/guide\/pages\/media-proxy-router\.html$/);
  assert.match(links[0].querySelector('.guide-search-result__title').textContent, /Media Proxy Router/);
  assert.ok(links.every(link => new URL(link.href).origin === 'https://extension.test'));

  input.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'ArrowDown',
    bubbles: true,
    cancelable: true
  }));
  assert.strictEqual(input.getAttribute('aria-activedescendant'), links[0].id);
  assert.strictEqual(links[0].getAttribute('aria-selected'), 'true');

  input.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'ArrowDown',
    bubbles: true,
    cancelable: true
  }));
  assert.strictEqual(input.getAttribute('aria-activedescendant'), links[1].id);
  input.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'ArrowUp',
    bubbles: true,
    cancelable: true
  }));
  assert.strictEqual(input.getAttribute('aria-activedescendant'), links[0].id);

  const keyboardDestination = document.createElement('div');
  keyboardDestination.id = 'keyboard-destination';
  document.body.appendChild(keyboardDestination);
  links[0].href = '#keyboard-destination';
  input.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true
  }));
  assert.strictEqual(window.location.hash, '#keyboard-destination');

  input.value = 'settings backup';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  links = [...results.querySelectorAll('.guide-search-result')];
  assert.match(links[0].href, /\/guide\/pages\/install\.html#settings-backup-and-import$/);

  input.value = 'remote evil';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.strictEqual(results.querySelector('.guide-search-result'), null);
  assert.match(results.textContent, /No local guide results/i);

  input.value = '<img src=x onerror=alert(1)>';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.strictEqual(results.querySelector('img'), null);
  assert.match(results.textContent, /No guide results/i);

  input.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true
  }));
  assert.strictEqual(input.value, '');
  assert.strictEqual(results.hidden, true);
  assert.strictEqual(input.getAttribute('aria-expanded'), 'false');
});

test('mobile guide navigation isolates and traps focus, then restores prior state', async t => {
  const harness = await createGuideHarness('index.html', {
    mobile: true,
    beforeInit({ document }) {
      document.querySelector('.guide-footer').setAttribute('inert', 'persisted');
    }
  });
  t.after(() => harness.dom.window.close());
  const { window, document } = harness;
  const toggle = document.querySelector('[data-guide-nav-toggle]');
  const sidebar = document.querySelector('[data-guide-sidebar]');
  const backdrop = document.querySelector('[data-guide-sidebar-backdrop]');
  const firstLink = sidebar.querySelector('.guide-nav-home');
  const focusableLinks = [...sidebar.querySelectorAll('a[href]')];
  const lastLink = focusableLinks.at(-1);
  const skipLink = document.querySelector('.guide-skip-link');
  const header = document.querySelector('.guide-header');
  const main = document.querySelector('.guide-main');
  const footer = document.querySelector('.guide-footer');

  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(sidebar.hasAttribute('inert'));
  assert.strictEqual(backdrop.hidden, true);
  assert.ok(!skipLink.hasAttribute('inert'));
  assert.ok(!header.hasAttribute('inert'));
  assert.ok(!main.hasAttribute('inert'));
  assert.strictEqual(footer.getAttribute('inert'), 'persisted');

  toggle.focus();
  toggle.click();
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(!sidebar.hasAttribute('inert'));
  assert.ok(sidebar.classList.contains('is-open'));
  assert.ok(document.body.classList.contains('guide-nav-open'));
  assert.strictEqual(backdrop.hidden, false);
  assert.strictEqual(document.activeElement, firstLink);
  assert.ok(skipLink.hasAttribute('inert'));
  assert.ok(header.hasAttribute('inert'));
  assert.ok(main.hasAttribute('inert'));
  assert.ok(footer.hasAttribute('inert'));

  firstLink.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: true,
    bubbles: true,
    cancelable: true
  }));
  assert.strictEqual(document.activeElement, lastLink);

  lastLink.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'Tab',
    bubbles: true,
    cancelable: true
  }));
  assert.strictEqual(document.activeElement, firstLink);

  document.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true
  }));
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(sidebar.hasAttribute('inert'));
  assert.ok(!sidebar.classList.contains('is-open'));
  assert.ok(!document.body.classList.contains('guide-nav-open'));
  assert.strictEqual(backdrop.hidden, true);
  assert.strictEqual(document.activeElement, toggle);
  assert.ok(!skipLink.hasAttribute('inert'));
  assert.ok(!header.hasAttribute('inert'));
  assert.ok(!main.hasAttribute('inert'));
  assert.strictEqual(footer.getAttribute('inert'), 'persisted');
});

test('new-tab handling permits safe URLs, blocks unsafe schemes, and falls back cleanly', async t => {
  const harness = await createGuideHarness('pages/install.html');
  t.after(() => harness.dom.window.close());
  const { window, document, tabCalls } = harness;

  const generatedExternal = document.querySelector('a[href^="https://"][target="_blank"]');
  assert.ok(generatedExternal);
  assert.match(generatedExternal.rel, /\bnoopener\b/);
  assert.match(generatedExternal.rel, /\bnoreferrer\b/);
  generatedExternal.dispatchEvent(new window.MouseEvent('click', {
    button: 0,
    bubbles: true,
    cancelable: true
  }));
  await settle(window);
  assert.strictEqual(tabCalls.at(-1).url, generatedExternal.href);

  const local = document.createElement('a');
  local.href = '../index.html';
  local.target = '_blank';
  local.textContent = 'Guide home in a new tab';
  document.body.appendChild(local);
  local.dispatchEvent(new window.MouseEvent('click', {
    button: 0,
    bubbles: true,
    cancelable: true
  }));
  await settle(window);
  assert.strictEqual(tabCalls.at(-1).url, 'https://extension.test/guide/index.html');

  const unsafe = document.createElement('a');
  unsafe.href = 'javascript:alert(1)';
  unsafe.target = '_blank';
  unsafe.textContent = 'Unsafe';
  document.body.appendChild(unsafe);
  const callCount = tabCalls.length;
  const unsafeAllowed = unsafe.dispatchEvent(new window.MouseEvent('click', {
    button: 0,
    bubbles: true,
    cancelable: true
  }));
  assert.strictEqual(unsafeAllowed, false);
  assert.strictEqual(tabCalls.length, callCount);

  const throwingHarness = await createGuideHarness('index.html', { tabsMode: 'throw' });
  t.after(() => throwingHarness.dom.window.close());
  const fallbackLink = throwingHarness.document.createElement('a');
  fallbackLink.href = 'https://example.test/help';
  fallbackLink.target = '_blank';
  fallbackLink.textContent = 'Fallback';
  throwingHarness.document.body.appendChild(fallbackLink);
  fallbackLink.dispatchEvent(new throwingHarness.window.MouseEvent('click', {
    button: 0,
    bubbles: true,
    cancelable: true
  }));
  assert.strictEqual(throwingHarness.fallbackCalls.length, 1);
  assert.strictEqual(throwingHarness.fallbackCalls[0].url, 'https://example.test/help');
  assert.strictEqual(throwingHarness.fallbackCalls[0].opened.opener, null);

  const nativeHarness = await createGuideHarness('index.html', { tabsMode: 'none' });
  t.after(() => nativeHarness.dom.window.close());
  const nativeLink = nativeHarness.document.createElement('a');
  nativeLink.href = '#native-fallback';
  nativeLink.target = '_blank';
  nativeLink.textContent = 'Native fallback';
  nativeHarness.document.body.appendChild(nativeLink);
  const nativeAllowed = nativeLink.dispatchEvent(new nativeHarness.window.MouseEvent('click', {
    button: 0,
    bubbles: true,
    cancelable: true
  }));
  assert.strictEqual(nativeAllowed, true);
  assert.strictEqual(nativeHarness.fallbackCalls.length, 0);
});

test('settings links rewrite only canonical extension settings paths', async t => {
  let unsafeLink;
  const harness = await createGuideHarness('pages/media-proxy-router.html', {
    beforeInit({ document }) {
      unsafeLink = document.createElement('a');
      unsafeLink.href = '#keep-local-fallback';
      unsafeLink.dataset.settingsPath = '../../unexpected.html';
      unsafeLink.textContent = 'Unsafe settings path';
      document.body.appendChild(unsafeLink);
    }
  });
  t.after(() => harness.dom.window.close());
  const settings = harness.document.querySelector('.guide-settings-cta[data-settings-path]');

  assert.strictEqual(
    settings.href,
    'https://extension.test/ui/settings.html#proxySection'
  );
  assert.ok(harness.runtimeUrlCalls.includes('ui/settings.html#proxySection'));
  assert.ok(!harness.runtimeUrlCalls.includes('../../unexpected.html'));
  assert.strictEqual(unsafeLink.href, 'https://extension.test/guide/pages/media-proxy-router.html#keep-local-fallback');
});

test('article table of contents follows scroll position and explicit hashes', async t => {
  const harness = await createGuideHarness('pages/install.html', {
    beforeInit({ window, document }) {
      Object.defineProperty(document.documentElement, 'scrollHeight', {
        configurable: true,
        value: 6000
      });
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: 900
      });
      Object.defineProperty(window, 'scrollY', {
        configurable: true,
        value: 0,
        writable: true
      });

      document.querySelector('.guide-header').getBoundingClientRect = () => ({
        top: 0,
        bottom: 70
      });
      [...document.querySelectorAll('.guide-toc-link')].forEach((link, index) => {
        const heading = document.getElementById(decodeURIComponent(link.hash.slice(1)));
        const documentTop = 140 + index * 420;
        heading.getBoundingClientRect = () => ({
          top: documentTop - window.scrollY,
          bottom: documentTop + 40 - window.scrollY
        });
      });
    }
  });
  t.after(() => harness.dom.window.close());
  const { window, document } = harness;
  const links = [...document.querySelectorAll('.guide-toc-link')];

  assert.ok(links.length >= 3);
  assert.strictEqual(links[0].getAttribute('aria-current'), 'location');
  assert.ok(links[0].classList.contains('is-active'));

  window.scrollY = 650;
  window.dispatchEvent(new window.Event('scroll'));
  await new Promise(resolve => window.requestAnimationFrame(resolve));
  assert.strictEqual(links[1].getAttribute('aria-current'), 'location');
  assert.strictEqual(links[0].getAttribute('aria-current'), null);

  window.location.hash = links[2].hash;
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  assert.strictEqual(links[2].getAttribute('aria-current'), 'location');

  window.scrollY = 6000 - 900;
  window.dispatchEvent(new window.Event('scroll'));
  await new Promise(resolve => window.requestAnimationFrame(resolve));
  assert.strictEqual(links.at(-1).getAttribute('aria-current'), 'location');
});
