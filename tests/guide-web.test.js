'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { buildGuideArtifacts } = require('../scripts/build-guide');
const { GUIDE_PAGES, GUIDE_ASSETS } = require('../scripts/guide-manifest');

const prefix = 'dist/guide-site/';
const web = buildGuideArtifacts({ target: 'web' });
const offline = buildGuideArtifacts();
const read = name => web.get(`${prefix}${name}`).toString('utf8');

test('web guide shares article content and assets with the offline guide', () => {
  const expected = new Set([
    'index.html', 'search-index.json', 'guide.css', 'guide.js', '.nojekyll',
    ...GUIDE_PAGES.map(page => `pages/${page.slug}.html`),
    ...GUIDE_ASSETS
  ].map(name => `${prefix}${name}`));
  assert.deepEqual(new Set(web.keys()), expected);

  for (const page of GUIDE_PAGES) {
    const site = new JSDOM(read(`pages/${page.slug}.html`));
    const extension = new JSDOM(offline.get(`extension/guide/pages/${page.slug}.html`).toString('utf8'));
    const content = site.window.document.querySelector('.guide-content');
    // The web root is one directory shallower than the extension guide root.
    for (const img of content.querySelectorAll('img')) {
      img.setAttribute('src', `../${img.getAttribute('src')}`);
    }
    assert.equal(content.innerHTML, extension.window.document.querySelector('.guide-content').innerHTML);
    assert.equal(site.window.document.querySelector('[data-settings-path]'), null);
    site.window.close();
    extension.window.close();
  }

  for (const source of GUIDE_ASSETS) {
    assert.ok(web.get(`${prefix}${source}`).equals(offline.get(`extension/${source}`)));
  }
  for (const name of ['guide.css', 'guide.js']) {
    assert.ok(web.get(`${prefix}${name}`).equals(fs.readFileSync(path.join(__dirname, '..', 'extension', 'guide', name))));
  }
  const home = new JSDOM(read('index.html'));
  assert.equal(home.window.document.querySelector('.guide-primary-action').textContent, 'Download Chroma');
  assert.match(home.window.document.querySelector('.guide-primary-action').href, /\/releases\/latest$/);
  home.window.close();
  assert.ok(JSON.parse(read('search-index.json')).pages.every(page => page.settingsPath === null));
});

test('every web link, fragment, and resource resolves at both root and project URLs', () => {
  const documents = new Map([...web].filter(([name]) => name.endsWith('.html'))
    .map(([name, bytes]) => [name.slice(prefix.length), new JSDOM(bytes.toString('utf8'))]));
  for (const base of ['https://guide.example/', 'https://dabrogost.github.io/Chroma-Ad-Blocker/']) {
    for (const [name, dom] of documents) {
      for (const element of dom.window.document.querySelectorAll('[href], [src]')) {
        const reference = element.getAttribute('href') ?? element.getAttribute('src');
        if (reference.startsWith('https://')) continue;
        const url = new URL(reference, `${base}${name}`);
        assert.ok(url.href.startsWith(base), `${name}: link escapes site: ${reference}`);
        const destination = decodeURIComponent(url.pathname.slice(new URL(base).pathname.length));
        assert.ok(web.has(`${prefix}${destination}`), `${name}: missing ${reference}`);
        if (url.hash) {
          assert.ok(documents.get(destination)?.window.document.getElementById(decodeURIComponent(url.hash.slice(1))),
            `${name}: missing fragment ${reference}`);
        }
      }
    }
  }
  for (const dom of documents.values()) dom.window.close();
});

test('web guide search and mobile navigation work without extension APIs', async () => {
  const base = 'https://dabrogost.github.io/Chroma-Ad-Blocker/';
  for (const name of ['index.html', 'pages/install.html']) {
    const dom = new JSDOM(read(name), {
      url: `${base}${name}`,
      pretendToBeVisual: true,
      runScripts: 'outside-only'
    });
    const { window } = dom;
    try {
      assert.equal(window.chrome, undefined);
      window.fetch = async url => {
        assert.equal(String(url), `${base}search-index.json`);
        return { ok: true, json: async () => JSON.parse(read('search-index.json')) };
      };
      window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
      window.eval(read('guide.js'));
      window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
      await new Promise(resolve => window.setTimeout(resolve, 0));
      const input = window.document.querySelector('[data-guide-search]');
      input.value = 'media proxy';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      const links = [...window.document.querySelectorAll('[data-guide-search-result]')];
      assert.ok(links.some(link => /Media Proxy Router/.test(link.textContent)));
      assert.ok(links.every(link => link.href.startsWith(`${base}pages/`)));
      const toggle = window.document.querySelector('[data-guide-nav-toggle]');
      toggle.click();
      assert.equal(toggle.getAttribute('aria-expanded'), 'true');
      window.document.querySelector('[data-guide-sidebar-backdrop]').click();
      assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    } finally {
      window.close();
    }
  }
});
