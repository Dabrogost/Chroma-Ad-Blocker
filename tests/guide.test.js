'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const {
  buildGuideArtifacts,
  checkGuideFreshness,
  slugifyHeading
} = require('../scripts/build-guide');
const {
  GUIDE_ASSETS,
  GUIDE_CATEGORIES,
  GUIDE_HUB_SOURCE,
  GUIDE_PAGES,
  USER_DOC_FILES,
  validateGuideManifest
} = require('../scripts/guide-manifest');

const repoRoot = path.join(__dirname, '..');
const artifacts = buildGuideArtifacts();
const guideCss = fs.readFileSync(path.join(repoRoot, 'extension', 'guide', 'guide.css'), 'utf8');
const guideJs = fs.readFileSync(path.join(repoRoot, 'extension', 'guide', 'guide.js'), 'utf8');
const htmlArtifacts = [...artifacts]
  .filter(([relativePath]) => relativePath.endsWith('.html'));
const mojibakePattern = /\uFFFD|\u00e2\u20ac|\u00c3|\u00c2/iu;
const repoOnlyDocs = [
  'docs/README.md',
  'docs/ARCHITECTURE.md',
  'docs/SECURITY.md',
  'docs/THREAT_MODEL.md',
  'docs/TEST_GUIDE.md',
  'docs/DISTRIBUTION.md',
  'docs/CONTRIBUTING.md'
];
const repoOnlyGuideSlugs = [
  'architecture',
  'security',
  'threat-model',
  'testing',
  'distribution',
  'contributing'
];

function artifactText(relativePath) {
  const value = artifacts.get(relativePath);
  assert.ok(value, `missing in-memory artifact ${relativePath}`);
  return value.toString('utf8');
}

function artifactDocument(relativePath) {
  return new JSDOM(artifactText(relativePath)).window.document;
}

async function runGuide(relativePath, { mobile = false } = {}) {
  const browserPath = relativePath.replace(/^extension\//, '');
  const dom = new JSDOM(artifactText(relativePath), {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url: `https://extension.test/${browserPath}`
  });
  const { window } = dom;
  const searchPayload = JSON.parse(artifactText('extension/guide/search-index.json'));
  window.fetch = async url => {
    assert.strictEqual(String(url), 'https://extension.test/guide/search-index.json');
    return {
      ok: true,
      json: async () => searchPayload
    };
  };
  window.matchMedia = () => ({
    matches: mobile,
    addEventListener() {},
    removeEventListener() {}
  });
  window.chrome = {
    runtime: {
      getURL: value => `https://extension.test/${value}`
    }
  };
  window.eval(guideJs);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise(resolve => window.setTimeout(resolve, 0));
  return dom;
}

test('guide manifest is explicit, complete, and free of local-only docs', () => {
  assert.deepStrictEqual(validateGuideManifest(), []);
  assert.strictEqual(GUIDE_PAGES.length, 12);
  assert.strictEqual(GUIDE_CATEGORIES.length, 5);
  assert.strictEqual(new Set(USER_DOC_FILES).size, USER_DOC_FILES.length);
  assert.strictEqual(USER_DOC_FILES.length, 12);
  assert.deepStrictEqual(USER_DOC_FILES, GUIDE_PAGES.map(page => page.source));
  assert.ok(!USER_DOC_FILES.includes(GUIDE_HUB_SOURCE));
  assert.ok(USER_DOC_FILES.includes('docs/ADVANCED_USER_SCRIPTLETS.md'));
  assert.ok(!USER_DOC_FILES.includes('docs/testing.md'));
  assert.ok(!USER_DOC_FILES.includes('docs/dist.md'));

  for (const repoOnlyDoc of repoOnlyDocs) {
    assert.ok(!USER_DOC_FILES.includes(repoOnlyDoc), `${repoOnlyDoc} must remain repository-only`);
  }
  for (const repoOnlySlug of repoOnlyGuideSlugs) {
    assert.ok(
      !GUIDE_PAGES.some(page => page.slug === repoOnlySlug),
      `${repoOnlySlug} must not be a user-guide page`
    );
  }

  for (const relativePath of [...USER_DOC_FILES, ...GUIDE_ASSETS]) {
    assert.ok(
      fs.existsSync(path.join(repoRoot, ...relativePath.split('/'))),
      `missing declared guide input ${relativePath}`
    );
  }

  const manifestText = JSON.stringify({ GUIDE_CATEGORIES, GUIDE_PAGES });
  assert.doesNotMatch(manifestText, mojibakePattern);
});

test('guide generation is deterministic and checked into the extension', () => {
  assert.deepStrictEqual(checkGuideFreshness(artifacts), []);
  assert.strictEqual(htmlArtifacts.length, GUIDE_PAGES.length + 1);
  assert.ok(artifacts.has('extension/guide/index.html'));
  assert.ok(artifacts.has('extension/guide/search-index.json'));
});

test('mobile guide navigation layers the drawer above its backdrop', () => {
  const mobileStart = guideCss.indexOf('@media (max-width: 880px)');
  const mobileEnd = guideCss.indexOf('@media (max-width: 660px)', mobileStart);
  const mobileCss = guideCss.slice(mobileStart, mobileEnd);

  assert.ok(mobileStart >= 0 && mobileEnd > mobileStart);
  assert.match(mobileCss, /\.guide-layout\s*\{[^}]*z-index:\s*auto;/s);
  assert.match(mobileCss, /\.guide-sidebar\s*\{[^}]*z-index:\s*120;/s);
  assert.match(
    guideCss,
    /\.guide-sidebar-backdrop,\s*\[data-guide-sidebar-backdrop\]\s*\{[^}]*z-index:\s*115;/s
  );
});

test('generated pages use static semantic markup and a strict self-only policy', () => {
  for (const [relativePath, bytes] of htmlArtifacts) {
    const html = bytes.toString('utf8');
    const document = new JSDOM(html).window.document;
    const body = document.body;
    const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
    const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '';

    assert.ok(body.dataset.guideRoot === '.' || body.dataset.guideRoot === '..', relativePath);
    assert.match(
      html,
      /<!-- Generated from canonical \/docs content by scripts\/build-guide\.js\. Edit the Markdown source, not this file\. -->/
    );
    assert.ok(body.dataset.guideCurrentSlug, relativePath);
    assert.ok(document.querySelector('a.guide-skip-link[href="#guideMain"]'), relativePath);
    assert.ok(document.querySelector('#guideMain'), relativePath);
    assert.ok(document.querySelector('.guide-layout'), relativePath);
    assert.ok(document.querySelector('#guideSidebar[data-guide-sidebar]'), relativePath);
    assert.ok(document.querySelector('[data-guide-nav-toggle][aria-controls="guideSidebar"]'), relativePath);
    assert.ok(document.querySelector('#guideSearch[data-guide-search]'), relativePath);
    assert.ok(document.querySelector('#guideSearchResults[data-guide-search-results][hidden]'), relativePath);
    assert.ok(document.querySelector('[data-guide-search-status][role="status"]'), relativePath);
    assert.strictEqual(new Set(ids).size, ids.length, `${relativePath} has duplicate IDs`);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|frame-ancestors|https?:/);
    assert.strictEqual(document.querySelectorAll('script:not([src])').length, 0, relativePath);
    assert.strictEqual(document.querySelectorAll('style').length, 0, relativePath);
    assert.strictEqual(document.querySelectorAll('[style]').length, 0, relativePath);
    assert.doesNotMatch(html, mojibakePattern);
  }
});

test('article pages expose stable headings, TOCs, settings CTAs, and safe external links', () => {
  for (const page of GUIDE_PAGES) {
    const relativePath = `extension/guide/pages/${page.slug}.html`;
    const document = artifactDocument(relativePath);
    const headings = [...document.querySelectorAll('.guide-article h1, .guide-content h2, .guide-content h3, .guide-content h4')];
    const headingIds = new Set(headings.map(heading => heading.id));

    assert.strictEqual(document.body.dataset.guideRoot, '..');
    assert.strictEqual(document.body.dataset.guideCurrentSlug, page.slug);
    assert.strictEqual(document.querySelectorAll('.guide-article h1').length, 1);
    assert.strictEqual(document.querySelector('.guide-article h1').textContent, page.title);
    assert.ok(document.querySelector(`.guide-nav-link[data-guide-slug="${page.slug}"][aria-current="page"]`));
    assert.strictEqual(document.querySelector('.guide-heading-permalink'), null);

    for (const tocLink of document.querySelectorAll('.guide-toc-link')) {
      assert.ok(headingIds.has(tocLink.getAttribute('href').slice(1)), `${relativePath} has stale TOC link`);
    }

    if (page.settings) {
      const cta = document.querySelector('.guide-settings-cta[data-settings-path]');
      assert.ok(cta, `${relativePath} is missing its settings CTA`);
      assert.strictEqual(cta.dataset.settingsPath, page.settings.path);
    }

    for (const anchor of document.querySelectorAll('a[href^="https://"]')) {
      assert.strictEqual(anchor.target, '_blank');
      assert.ok(anchor.rel.split(/\s+/).includes('noopener'));
      assert.ok(anchor.rel.split(/\s+/).includes('noreferrer'));
    }
  }

  assert.strictEqual(
    slugifyHeading('Layer 1: Network-Level Blocking (extension/rules/, extension/background/dnrState.js, extension/subscriptions/)'),
    'layer-1-network-level-blocking-extensionrules-extensionbackgrounddnrstatejs-extensionsubscriptions'
  );
});

test('Markdown features render accessibly while repository-only diagrams stay out of the guide', () => {
  const filters = artifactDocument('extension/guide/pages/filter-lists.html');
  const philosophy = artifactDocument('extension/guide/pages/project-philosophy.html');

  for (const source of ['docs/ARCHITECTURE.md', 'docs/SECURITY.md']) {
    assert.match(fs.readFileSync(path.join(repoRoot, ...source.split('/')), 'utf8'), /```mermaid/);
  }
  for (const slug of repoOnlyGuideSlugs) {
    assert.ok(!artifacts.has(`extension/guide/pages/${slug}.html`));
  }
  for (const page of GUIDE_PAGES) {
    const document = artifactDocument(`extension/guide/pages/${page.slug}.html`);
    assert.strictEqual(document.querySelector('.guide-mermaid-card, code.language-mermaid'), null);
  }
  assert.ok(filters.querySelector('.guide-table-wrap > table'));
  assert.ok(filters.querySelector('.guide-align-right'));
  assert.ok(filters.querySelector('.guide-callout.guide-callout--note'));
  assert.ok(philosophy.querySelector('.guide-callout.guide-callout--important'));
  assert.doesNotMatch(philosophy.body.textContent, /\[!IMPORTANT\]/);
});

test('every rendered documentation image has useful alt text and a byte-identical local copy', () => {
  const renderedImages = [];
  for (const page of GUIDE_PAGES) {
    const document = artifactDocument(`extension/guide/pages/${page.slug}.html`);
    renderedImages.push(...document.querySelectorAll('.guide-content img'));
  }

  assert.ok(renderedImages.length >= GUIDE_ASSETS.length);
  for (const image of renderedImages) {
    assert.ok(image.alt.trim(), `${image.getAttribute('src')} has empty alt text`);
    assert.match(image.getAttribute('src'), /^\.\.\/\.\.\/docs\/assets\/[^/]+\.png$/);
    assert.strictEqual(image.getAttribute('loading'), 'lazy');
    assert.strictEqual(image.getAttribute('decoding'), 'async');
  }

  for (const source of GUIDE_ASSETS) {
    const destination = `extension/${source}`;
    const canonical = fs.readFileSync(path.join(repoRoot, ...source.split('/')));
    assert.ok(artifacts.has(destination), `missing generated copy ${destination}`);
    assert.ok(artifacts.get(destination).equals(canonical), `${destination} differs from canonical asset`);
  }
});

test('search index covers every article with plain searchable metadata', () => {
  const index = JSON.parse(artifactText('extension/guide/search-index.json'));
  assert.strictEqual(index.version, 1);
  assert.strictEqual(index.pages.length, GUIDE_PAGES.length);

  for (const page of GUIDE_PAGES) {
    const item = index.pages.find(candidate => candidate.slug === page.slug);
    assert.ok(item, `missing search item ${page.slug}`);
    assert.strictEqual(item.title, page.title);
    assert.strictEqual(item.url, `pages/${page.slug}.html`);
    assert.strictEqual(item.settingsPath, page.settings?.path || null);
    assert.ok(item.text.length > 100, `${page.slug} has too little searchable text`);
    assert.deepStrictEqual(item.tasks, page.tasks);
    assert.ok(item.headings.every(heading => heading.text && heading.id));
  }
});

test('guide controller searches the offline index without runtime HTML injection', async () => {
  assert.doesNotMatch(guideJs, /\.innerHTML\s*=|insertAdjacentHTML|document\.write|eval\s*\(/);
  const dom = await runGuide('extension/guide/index.html');
  const { window } = dom;
  const input = window.document.querySelector('[data-guide-search]');
  const results = window.document.querySelector('[data-guide-search-results]');

  input.value = 'media proxy';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));

  const links = [...results.querySelectorAll('[data-guide-search-result]')];
  assert.ok(links.length > 0);
  assert.strictEqual(results.hidden, false);
  assert.strictEqual(input.getAttribute('aria-expanded'), 'true');
  assert.ok(links.some(link => /Media Proxy Router/.test(link.textContent)));
  assert.ok(links.every(link => link.href.startsWith('https://extension.test/guide/pages/')));
  dom.window.close();
});

test('guide controller wires mobile navigation and safe settings deep links', async () => {
  const dom = await runGuide('extension/guide/pages/media-proxy-router.html', { mobile: true });
  const { window } = dom;
  const toggle = window.document.querySelector('[data-guide-nav-toggle]');
  const sidebar = window.document.querySelector('[data-guide-sidebar]');
  const backdrop = window.document.querySelector('[data-guide-sidebar-backdrop]');
  const settings = window.document.querySelector('[data-settings-path]');

  assert.ok(sidebar.hasAttribute('inert'));
  assert.strictEqual(settings.href, 'https://extension.test/ui/settings.html#proxySection');
  toggle.click();
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(sidebar.classList.contains('is-open'));
  assert.strictEqual(backdrop.hidden, false);
  backdrop.click();
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(!sidebar.classList.contains('is-open'));
  dom.window.close();
});
