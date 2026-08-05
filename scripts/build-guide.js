'use strict';

const fs = require('fs');
const path = require('path');
const MarkdownIt = require('markdown-it');
const {
  GUIDE_ASSETS,
  GUIDE_CATEGORIES,
  GUIDE_HUB_SOURCE,
  GUIDE_PAGES,
  validateGuideManifest
} = require('./guide-manifest');

const repoRoot = path.join(__dirname, '..');
const generatedPagesRoot = path.join(repoRoot, 'extension', 'guide', 'pages');
const generatedAssetsRoot = path.join(repoRoot, 'extension', 'docs', 'assets');
const htmlEscape = MarkdownIt().utils.escapeHtml;

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugifyHeading(value) {
  const slug = normalizeWhitespace(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'section';
}

function stripFrontMatter(markdown) {
  const normalized = String(markdown).replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return normalized;
  const end = normalized.indexOf('\n---\n', 4);
  return end === -1 ? normalized : normalized.slice(end + 5);
}

function normalizeCanonicalMarkdown(markdown, source) {
  const withoutFrontMatter = stripFrontMatter(markdown);
  const normalized = withoutFrontMatter
    .replace(/^[ \t]*<div[ \t]+align=(?:"|')center(?:"|')[ \t]*>[ \t]*$/gim, '')
    .replace(/^[ \t]*<\/div>[ \t]*$/gim, '')
    .replace(
      /^[ \t]*<img[ \t]+src=(?:"|')([^"']+)(?:"|')[ \t]+alt=(?:"|')([^"']*)(?:"|')(?:[ \t]+width=(?:"|')\d+(?:"|'))?[ \t]*\/?>[ \t]*$/gim,
      (_, src, alt) => `![${alt}](${src})`
    )
    .trim();

  const unsupportedHtml = normalized.match(/^[ \t]*<\/?[A-Za-z][^>]*>[ \t]*$/m);
  if (unsupportedHtml) {
    throw new Error(`${source} contains unsupported raw HTML: ${unsupportedHtml[0].trim()}`);
  }
  return `${normalized}\n`;
}

function inlineTokenText(token) {
  if (!token) return '';
  if (!Array.isArray(token.children)) return normalizeWhitespace(token.content);
  return normalizeWhitespace(token.children.map(child => {
    if (child.type === 'text' || child.type === 'code_inline') return child.content;
    if (child.type === 'image') return child.content;
    if (child.type === 'softbreak' || child.type === 'hardbreak') return ' ';
    return '';
  }).join(' '));
}

function assignHeadingIds(tokens) {
  const counts = new Map();
  const headings = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== 'heading_open') continue;
    const inline = tokens[index + 1];
    const text = inlineTokenText(inline);
    const base = slugifyHeading(text);
    const occurrence = counts.get(base) || 0;
    counts.set(base, occurrence + 1);
    const id = occurrence === 0 ? base : `${base}-${occurrence}`;
    const level = Number(token.tag.slice(1));
    token.attrSet('id', id);
    token.attrSet('tabindex', '-1');
    headings.push({ level, text, id });
  }

  return headings;
}

function transformCallouts(tokens, md, env) {
  const allowed = new Set(['note', 'tip', 'important', 'warning', 'caution']);
  for (let index = 0; index < tokens.length; index++) {
    const open = tokens[index];
    if (open.type !== 'blockquote_open') continue;

    let depth = 1;
    let closeIndex = -1;
    let inlineIndex = -1;
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      if (tokens[cursor].type === 'blockquote_open') depth++;
      if (tokens[cursor].type === 'blockquote_close') {
        depth--;
        if (depth === 0) {
          closeIndex = cursor;
          break;
        }
      }
      if (depth === 1 && inlineIndex === -1 && tokens[cursor].type === 'inline') {
        inlineIndex = cursor;
      }
    }
    if (inlineIndex === -1 || closeIndex === -1) continue;

    const inline = tokens[inlineIndex];
    const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i.exec(inline.content);
    if (!match) continue;
    const type = match[1].toLowerCase();
    if (!allowed.has(type)) continue;

    const stripped = inline.content.slice(match[0].length);
    const reparsed = md.parseInline(stripped, env);
    inline.content = stripped;
    inline.children = reparsed[0]?.children || [];
    open.meta = { ...(open.meta || {}), guideCallout: type };
    tokens[closeIndex].meta = {
      ...(tokens[closeIndex].meta || {}),
      guideCallout: type
    };
  }
}

function splitReference(value) {
  const hashIndex = value.indexOf('#');
  if (hashIndex === -1) return { pathname: value, hash: '' };
  return {
    pathname: value.slice(0, hashIndex),
    hash: value.slice(hashIndex + 1)
  };
}

function createMarkdownRenderer(sourceToPage) {
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false
  });

  const defaultFence = md.renderer.rules.fence.bind(md.renderer.rules);
  const defaultCodeBlock = md.renderer.rules.code_block.bind(md.renderer.rules);
  const defaultImage = md.renderer.rules.image.bind(md.renderer.rules);
  const defaultHeadingOpen = md.renderer.rules.heading_open
    || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));

  function rewriteInternalLink(href, page) {
    if (href.startsWith('#')) return href;
    if (href.startsWith('https://')) return href;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) || href.startsWith('//')) {
      throw new Error(`${page.source} contains unsupported link protocol: ${href}`);
    }

    const { pathname: pathnamePart, hash } = splitReference(href);
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathnamePart);
    } catch {
      throw new Error(`${page.source} contains an invalid encoded link: ${href}`);
    }
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(page.source), decodedPath)
    );

    let destination;
    if (resolved === GUIDE_HUB_SOURCE) {
      destination = '../index.html';
    } else {
      const targetPage = sourceToPage.get(resolved);
      if (!targetPage) {
        throw new Error(`${page.source} links to an unmapped guide document: ${href}`);
      }
      destination = `${targetPage.slug}.html`;
    }
    return hash ? `${destination}#${hash}` : destination;
  }

  function rewriteImageSource(src, page) {
    if (/^(?:https?:|data:|\/\/)/i.test(src)) {
      throw new Error(`${page.source} contains a non-local guide image: ${src}`);
    }
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(splitReference(src).pathname);
    } catch {
      throw new Error(`${page.source} contains an invalid encoded image path: ${src}`);
    }
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(page.source), decodedPath)
    );
    if (!GUIDE_ASSETS.includes(resolved)) {
      throw new Error(`${page.source} references an undeclared guide image: ${src}`);
    }
    return `../../${resolved}`;
  }

  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = token.attrGet('href') || '';
    token.attrSet('href', rewriteInternalLink(href, env.page));
    if (href.startsWith('https://')) {
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener noreferrer');
    }
    return self.renderToken(tokens, idx, options);
  };

  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    token.attrSet('src', rewriteImageSource(token.attrGet('src') || '', env.page));
    token.attrSet('loading', 'lazy');
    token.attrSet('decoding', 'async');
    return defaultImage(tokens, idx, options, env, self);
  };

  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => (
    defaultHeadingOpen(tokens, idx, options, env, self)
  );

  md.renderer.rules.table_open = () => '<div class="guide-table-wrap"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';
  const renderTableCell = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const styleIndex = token.attrIndex('style');
    if (styleIndex >= 0) {
      const style = token.attrs[styleIndex][1];
      token.attrs.splice(styleIndex, 1);
      const alignment = /text-align\s*:\s*(left|center|right)/i.exec(style)?.[1]?.toLowerCase();
      if (alignment) token.attrJoin('class', `guide-align-${alignment}`);
    }
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.th_open = renderTableCell;
  md.renderer.rules.td_open = renderTableCell;

  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const rawLanguage = normalizeWhitespace(token.info).split(/\s+/)[0] || 'text';
    const language = /^[A-Za-z0-9_+-]+$/.test(rawLanguage)
      ? rawLanguage.toLowerCase()
      : 'text';
    if (language === 'mermaid') {
      // Keep Mermaid diagrams in the canonical Markdown, but omit unrendered
      // graph source from the static offline guide.
      return '';
    }
    return `<div class="guide-code-block" data-language="${htmlEscape(language)}">${defaultFence(tokens, idx, options, env, self)}</div>`;
  };

  md.renderer.rules.code_block = (tokens, idx, options, env, self) => (
    `<div class="guide-code-block" data-language="text">${defaultCodeBlock(tokens, idx, options, env, self)}</div>`
  );

  md.renderer.rules.blockquote_open = (tokens, idx) => {
    const type = tokens[idx].meta?.guideCallout;
    if (!type) return '<blockquote>\n';
    const label = type[0].toUpperCase() + type.slice(1);
    return `<aside class="guide-callout guide-callout--${type}" role="note"><p class="guide-callout-label guide-callout__title">${label}</p>\n`;
  };
  md.renderer.rules.blockquote_close = (tokens, idx) => (
    tokens[idx].meta?.guideCallout ? '</aside>\n' : '</blockquote>\n'
  );

  return md;
}

function renderCanonicalPage(page, md) {
  const sourcePath = path.join(repoRoot, ...page.source.split('/'));
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing canonical guide source: ${page.source}`);
  }
  const markdown = normalizeCanonicalMarkdown(fs.readFileSync(sourcePath, 'utf8'), page.source);
  const env = { page };
  const tokens = md.parse(markdown, env);
  transformCallouts(tokens, md, env);
  const headings = assignHeadingIds(tokens);
  const firstHeadingIndex = tokens.findIndex(token => token.type === 'heading_open');
  const firstHeading = headings[0];

  if (firstHeadingIndex !== 0 || firstHeading?.level !== 1) {
    throw new Error(`${page.source} must begin with one level-one heading.`);
  }
  if (firstHeading.text !== page.title) {
    throw new Error(
      `${page.source} heading "${firstHeading.text}" does not match manifest title "${page.title}".`
    );
  }

  const bodyTokens = tokens.slice(3);
  const contentHtml = md.renderer.render(bodyTokens, md.options, env);
  const searchText = normalizeWhitespace(tokens.flatMap(token => {
    if (token.type === 'inline') return [inlineTokenText(token)];
    if (token.type === 'fence' || token.type === 'code_block') return [];
    return [];
  }).join(' '));

  return {
    contentHtml,
    headingIds: new Set(headings.map(heading => heading.id)),
    headings,
    h1: firstHeading,
    searchText
  };
}

function categoryFor(page) {
  return GUIDE_CATEGORIES.find(category => category.id === page.category);
}

function pageHref(page, currentSlug, root) {
  if (!currentSlug) return `pages/${page.slug}.html`;
  return `${page.slug}.html`;
}

function renderSearch() {
  return [
    '<form class="guide-search" role="search" data-guide-search-form>',
    '<label class="guide-visually-hidden" for="guideSearch">Search the guide</label>',
    '<input id="guideSearch" class="guide-search-input" type="search" autocomplete="off" ',
    'placeholder="Search the guide" aria-controls="guideSearchResults" aria-autocomplete="list" data-guide-search>',
    '<div id="guideSearchResults" class="guide-search-results" data-guide-search-results hidden></div>',
    '<p class="guide-visually-hidden" role="status" aria-live="polite" data-guide-search-status></p>',
    '</form>'
  ].join('');
}

function renderSidebar(currentSlug, root) {
  const sections = GUIDE_CATEGORIES.map(category => {
    const links = GUIDE_PAGES
      .filter(page => page.category === category.id)
      .map(page => {
        const active = page.slug === currentSlug;
        return [
          `<li><a class="guide-nav-link${active ? ' is-active' : ''}" `,
          `href="${htmlEscape(pageHref(page, currentSlug, root))}" data-guide-slug="${htmlEscape(page.slug)}"`,
          active ? ' aria-current="page"' : '',
          `>${htmlEscape(page.title)}</a></li>`
        ].join('');
      })
      .join('');
    return [
      '<section class="guide-nav-group">',
      `<h2>${htmlEscape(category.title)}</h2>`,
      `<ul>${links}</ul>`,
      '</section>'
    ].join('');
  }).join('');

  return [
    '<aside id="guideSidebar" class="guide-sidebar" aria-label="Guide navigation" data-guide-sidebar>',
    `<a class="guide-nav-home${currentSlug ? '' : ' is-active'}" href="${root}/index.html" data-guide-home`,
    currentSlug ? '' : ' aria-current="page"',
    '>Guide home</a>',
    sections,
    '</aside>'
  ].join('');
}

function renderShell({ root, currentSlug = '', title, description, mainHtml }) {
  const assetPrefix = root === '.' ? '' : '../';
  const bodySlug = currentSlug || 'home';
  return [
    '<!doctype html>',
    '<!-- Generated from canonical /docs content by scripts/build-guide.js. Edit the Markdown source, not this file. -->',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\'; img-src \'self\' data:; connect-src \'self\'; object-src \'none\'; base-uri \'none\'; form-action \'none\';">',
    `<title>${htmlEscape(title)} · Chroma Guide</title>`,
    `<meta name="description" content="${htmlEscape(description)}">`,
    `<link rel="stylesheet" href="${assetPrefix}guide.css">`,
    '</head>',
    `<body class="guide-page" data-guide-root="${root}" data-guide-current-slug="${htmlEscape(bodySlug)}">`,
    '<a class="guide-skip-link" href="#guideMain">Skip to guide content</a>',
    '<header class="guide-header">',
    '<button class="guide-nav-toggle" type="button" aria-controls="guideSidebar" aria-expanded="false" data-guide-nav-toggle>',
    '<span aria-hidden="true">☰</span><span class="guide-visually-hidden">Open guide navigation</span>',
    '</button>',
    `<a class="guide-brand" href="${root}/index.html" data-guide-home><span aria-hidden="true">◈</span><span>Chroma Guide</span></a>`,
    renderSearch(),
    '</header>',
    '<div class="guide-shell guide-layout">',
    renderSidebar(currentSlug, root),
    mainHtml,
    '</div>',
    '<button class="guide-sidebar-backdrop" type="button" aria-label="Close guide navigation" data-guide-sidebar-backdrop hidden></button>',
    '<footer class="guide-footer"><p>Available offline with Chroma Ad-Blocker.</p></footer>',
    `<script src="${assetPrefix}guide.js" defer></script>`,
    '</body>',
    '</html>',
    ''
  ].join('\n');
}

function renderTaskCard(page, href) {
  const primaryTask = page.tasks[0];
  return [
    `<a class="guide-task-card" href="${htmlEscape(href)}" data-guide-slug="${htmlEscape(page.slug)}">`,
    `<span class="guide-task-label">${htmlEscape(primaryTask)}</span>`,
    `<h3>${htmlEscape(page.title)}</h3>`,
    `<p>${htmlEscape(page.summary)}</p>`,
    '<span class="guide-card-action" aria-hidden="true">Read guide →</span>',
    '</a>'
  ].join('');
}

function renderIndex() {
  const featured = GUIDE_PAGES.filter(page => page.featured)
    .map(page => renderTaskCard(page, `pages/${page.slug}.html`))
    .join('');

  const categories = GUIDE_CATEGORIES.map(category => {
    const pages = GUIDE_PAGES.filter(page => page.category === category.id);
    const cards = pages.map(page => [
      `<article class="guide-article-card" data-guide-slug="${htmlEscape(page.slug)}">`,
      `<h3><a href="pages/${htmlEscape(page.slug)}.html">${htmlEscape(page.title)}</a></h3>`,
      `<p>${htmlEscape(page.summary)}</p>`,
      `<ul class="guide-task-list">${page.tasks.map(task => `<li>${htmlEscape(task)}</li>`).join('')}</ul>`,
      '</article>'
    ].join('')).join('');
    return [
      `<section class="guide-category" id="category-${htmlEscape(category.id)}" aria-labelledby="category-${htmlEscape(category.id)}-title">`,
      `<header><h2 id="category-${htmlEscape(category.id)}-title">${htmlEscape(category.title)}</h2>`,
      `<p>${htmlEscape(category.description)}</p></header>`,
      `<div class="guide-article-grid">${cards}</div>`,
      '</section>'
    ].join('');
  }).join('');

  const mainHtml = [
    '<main id="guideMain" class="guide-main guide-main--home" tabindex="-1">',
    '<section class="guide-hero" aria-labelledby="guideHeroTitle">',
    '<p class="guide-eyebrow">Chroma Ad-Blocker user manual</p>',
    '<h1 id="guideHeroTitle">What would you like to do?</h1>',
    '<p>Find practical setup help, feature explanations, privacy details, and performance guidance—all available offline.</p>',
    '<div class="guide-hero-actions">',
    '<a class="guide-primary-action" href="../ui/settings.html">Open Chroma settings</a>',
    '<a class="guide-secondary-action" href="pages/install.html">Start with installation</a>',
    '</div>',
    '</section>',
    '<section class="guide-popular-tasks" aria-labelledby="popularTasksTitle">',
    '<header><p class="guide-eyebrow">Popular paths</p><h2 id="popularTasksTitle">Get something done</h2></header>',
    `<div class="guide-task-grid">${featured}</div>`,
    '</section>',
    '<aside class="guide-callout" aria-label="Guide privacy note">',
    '<h2>Private by design</h2>',
    '<p>This guide is packaged with Chroma. Reading and searching it does not send your questions or browsing activity anywhere.</p>',
    '</aside>',
    categories,
    '</main>'
  ].join('');

  return renderShell({
    root: '.',
    title: 'Home',
    description: 'Offline user manual for Chroma Ad-Blocker.',
    mainHtml
  });
}

function renderToc(rendered) {
  const items = rendered.headings.filter(heading => heading.level === 2 || heading.level === 3);
  if (items.length === 0) return '';
  return [
    '<aside class="guide-toc" aria-labelledby="guideTocTitle">',
    '<h2 id="guideTocTitle">On this page</h2>',
    '<ol>',
    items.map(heading => [
      `<li class="guide-toc-level-${heading.level}">`,
      `<a class="guide-toc-link" href="#${htmlEscape(heading.id)}">${htmlEscape(heading.text)}</a>`,
      '</li>'
    ].join('')).join(''),
    '</ol>',
    '</aside>'
  ].join('');
}

function settingsHref(settings) {
  return `../../${settings.path}`;
}

function renderArticle(page, rendered, index) {
  const category = categoryFor(page);
  const previous = index > 0 ? GUIDE_PAGES[index - 1] : null;
  const next = index < GUIDE_PAGES.length - 1 ? GUIDE_PAGES[index + 1] : null;
  const cta = page.settings
    ? [
      `<a class="guide-settings-cta" href="${htmlEscape(settingsHref(page.settings))}" `,
      `data-settings-path="${htmlEscape(page.settings.path)}">`,
      `<span>${htmlEscape(page.settings.label)}</span><span aria-hidden="true">↗</span></a>`
    ].join('')
    : '';
  const pagination = [
    '<nav class="guide-pagination" aria-label="Guide pages">',
    previous
      ? `<a class="guide-pagination-link guide-pagination-link--previous" href="${htmlEscape(previous.slug)}.html"><span>Previous</span><strong>${htmlEscape(previous.title)}</strong></a>`
      : '<span></span>',
    next
      ? `<a class="guide-pagination-link guide-pagination-link--next" href="${htmlEscape(next.slug)}.html"><span>Next</span><strong>${htmlEscape(next.title)}</strong></a>`
      : '<span></span>',
    '</nav>'
  ].join('');

  const mainHtml = [
    '<main id="guideMain" class="guide-main" tabindex="-1">',
    '<div class="guide-article-layout">',
    '<article class="guide-article">',
    '<nav class="guide-breadcrumbs" aria-label="Breadcrumb">',
    '<a href="../index.html">Guide home</a><span aria-hidden="true">/</span>',
    `<span>${htmlEscape(category.title)}</span>`,
    '</nav>',
    '<header class="guide-article-header">',
    `<p class="guide-eyebrow">${htmlEscape(category.title)}</p>`,
    `<h1 id="${htmlEscape(rendered.h1.id)}" tabindex="-1">${htmlEscape(page.title)}</h1>`,
    `<p class="guide-article-summary">${htmlEscape(page.summary)}</p>`,
    cta,
    '</header>',
    `<div class="guide-content">${rendered.contentHtml}</div>`,
    pagination,
    '</article>',
    renderToc(rendered),
    '</div>',
    '</main>'
  ].join('');

  return renderShell({
    root: '..',
    currentSlug: page.slug,
    title: page.title,
    description: page.summary,
    mainHtml
  });
}

function buildSearchIndex(renderedPages) {
  return {
    version: 1,
    pages: GUIDE_PAGES.map(page => {
      const rendered = renderedPages.get(page.slug);
      const category = categoryFor(page);
      return {
        title: page.title,
        slug: page.slug,
        category: category.title,
        summary: page.summary,
        headings: rendered.headings
          .filter(heading => heading.level >= 2 && heading.level <= 3)
          .map(heading => ({ text: heading.text, id: heading.id })),
        text: rendered.searchText,
        url: `pages/${page.slug}.html`,
        settingsPath: page.settings?.path || null,
        tasks: page.tasks.slice()
      };
    })
  };
}

function validateRenderedGuide(renderedPages) {
  const errors = [];
  const bySlug = new Map(GUIDE_PAGES.map(page => [page.slug, page]));

  for (const page of GUIDE_PAGES) {
    const rendered = renderedPages.get(page.slug);
    const hrefPattern = /href="([^"]+)"/g;
    for (const match of rendered.contentHtml.matchAll(hrefPattern)) {
      const href = match[1];
      if (href.startsWith('https://') || href === '../index.html') continue;
      if (href.startsWith('#')) {
        if (!rendered.headingIds.has(href.slice(1))) {
          errors.push(`${page.source} links to missing local heading ${href}.`);
        }
        continue;
      }
      const { pathname: pathnamePart, hash } = splitReference(href);
      const targetSlug = path.posix.basename(pathnamePart, '.html');
      const targetPage = bySlug.get(targetSlug);
      if (!targetPage) {
        errors.push(`${page.source} links to missing guide page ${href}.`);
        continue;
      }
      if (hash && !renderedPages.get(targetSlug).headingIds.has(hash)) {
        errors.push(`${page.source} links to missing heading ${href}.`);
      }
    }
  }

  return errors;
}

function buildGuideArtifacts() {
  const manifestErrors = validateGuideManifest();
  if (manifestErrors.length > 0) {
    throw new Error(`Invalid guide manifest:\n- ${manifestErrors.join('\n- ')}`);
  }

  const sourceToPage = new Map(GUIDE_PAGES.map(page => [page.source, page]));
  const md = createMarkdownRenderer(sourceToPage);
  const renderedPages = new Map();
  for (const page of GUIDE_PAGES) {
    renderedPages.set(page.slug, renderCanonicalPage(page, md));
  }

  const linkErrors = validateRenderedGuide(renderedPages);
  if (linkErrors.length > 0) {
    throw new Error(`Guide link validation failed:\n- ${linkErrors.join('\n- ')}`);
  }

  const artifacts = new Map();
  artifacts.set('extension/guide/index.html', Buffer.from(renderIndex(), 'utf8'));
  GUIDE_PAGES.forEach((page, index) => {
    const output = renderArticle(page, renderedPages.get(page.slug), index);
    artifacts.set(`extension/guide/pages/${page.slug}.html`, Buffer.from(output, 'utf8'));
  });
  artifacts.set(
    'extension/guide/search-index.json',
    Buffer.from(`${JSON.stringify(buildSearchIndex(renderedPages), null, 2)}\n`, 'utf8')
  );

  for (const source of GUIDE_ASSETS) {
    const sourcePath = path.join(repoRoot, ...source.split('/'));
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Missing canonical guide asset: ${source}`);
    }
    artifacts.set(`extension/${source}`, fs.readFileSync(sourcePath));
  }

  return artifacts;
}

function safeGeneratedPath(relativePath) {
  const normalized = path.normalize(relativePath);
  const absolute = path.resolve(repoRoot, normalized);
  const allowedRoots = [
    path.resolve(repoRoot, 'extension', 'guide'),
    path.resolve(repoRoot, 'extension', 'docs', 'assets')
  ];
  if (!allowedRoots.some(root => absolute === root || absolute.startsWith(`${root}${path.sep}`))) {
    throw new Error(`Refusing to write outside generated guide roots: ${relativePath}`);
  }
  return absolute;
}

function listUnexpectedGeneratedFiles(expectedPaths) {
  const unexpected = [];
  const scans = [
    { directory: generatedPagesRoot, accept: name => name.endsWith('.html') },
    { directory: generatedAssetsRoot, accept: () => true }
  ];
  for (const scan of scans) {
    if (!fs.existsSync(scan.directory)) continue;
    for (const entry of fs.readdirSync(scan.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !scan.accept(entry.name)) continue;
      const relative = toPosix(path.relative(repoRoot, path.join(scan.directory, entry.name)));
      if (!expectedPaths.has(relative)) unexpected.push(relative);
    }
  }
  return unexpected.sort();
}

function writeGuideArtifacts(artifacts = buildGuideArtifacts()) {
  const expectedPaths = new Set(artifacts.keys());
  let written = 0;
  for (const [relativePath, bytes] of artifacts) {
    const absolute = safeGeneratedPath(relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const current = fs.existsSync(absolute) ? fs.readFileSync(absolute) : null;
    if (current && current.equals(bytes)) continue;
    fs.writeFileSync(absolute, bytes);
    written++;
  }

  const removed = [];
  for (const relativePath of listUnexpectedGeneratedFiles(expectedPaths)) {
    const absolute = safeGeneratedPath(relativePath);
    fs.unlinkSync(absolute);
    removed.push(relativePath);
  }
  return { artifacts: artifacts.size, removed, written };
}

function checkGuideFreshness(artifacts = buildGuideArtifacts()) {
  const errors = [];
  const expectedPaths = new Set(artifacts.keys());
  for (const [relativePath, expected] of artifacts) {
    const absolute = safeGeneratedPath(relativePath);
    if (!fs.existsSync(absolute)) {
      errors.push(`Missing generated guide file: ${relativePath}`);
      continue;
    }
    const current = fs.readFileSync(absolute);
    if (!current.equals(expected)) {
      errors.push(`Stale generated guide file: ${relativePath}`);
    }
  }
  for (const relativePath of listUnexpectedGeneratedFiles(expectedPaths)) {
    errors.push(`Unexpected generated guide file: ${relativePath}`);
  }
  return errors;
}

function main() {
  if (process.argv.includes('--check')) {
    const errors = checkGuideFreshness();
    if (errors.length > 0) {
      console.error('Generated guide is not current:');
      errors.forEach(error => console.error(`- ${error}`));
      process.exitCode = 1;
      return;
    }
    console.log('Generated guide is current.');
    return;
  }

  const result = writeGuideArtifacts();
  console.log(`Guide artifacts: ${result.artifacts}`);
  console.log(`Guide files written: ${result.written}`);
  console.log(`Stale guide files removed: ${result.removed.length}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildGuideArtifacts,
  checkGuideFreshness,
  normalizeCanonicalMarkdown,
  slugifyHeading,
  writeGuideArtifacts
};
