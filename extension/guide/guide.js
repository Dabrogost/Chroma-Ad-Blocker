/**
 * Chroma manual interactions.
 *
 * The guide is generated as static HTML. This controller adds progressive
 * enhancement for local search, mobile navigation, safe new-tab handling,
 * and article table-of-contents state without rendering article HTML.
 */

'use strict';

(() => {
  const SEARCH_RESULT_LIMIT = 8;
  const MOBILE_NAV_QUERY = '(max-width: 880px)';
  const SAFE_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:']);

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function normalize(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function truncate(value, maxLength = 150) {
    const compact = String(value || '').replace(/\s+/g, ' ').trim();
    if (compact.length <= maxLength) return compact;

    const slice = compact.slice(0, Math.max(1, maxLength - 1));
    const lastSpace = slice.lastIndexOf(' ');
    const boundary = lastSpace > Math.floor(maxLength * 0.62) ? lastSpace : slice.length;
    return `${slice.slice(0, boundary).trimEnd()}\u2026`;
  }

  function closestElement(target, selector) {
    if (target && typeof target.closest === 'function') return target.closest(selector);
    if (target?.parentElement && typeof target.parentElement.closest === 'function') {
      return target.parentElement.closest(selector);
    }
    return null;
  }

  function isTypingTarget(target) {
    const element = closestElement(target, 'input, textarea, select, [contenteditable]');
    if (!element) return false;
    if (element.matches('input, textarea, select')) return true;
    return element.matches('[contenteditable]:not([contenteditable="false"])');
  }

  function safeDecodeHash(hash) {
    try {
      return decodeURIComponent(String(hash || '').replace(/^#/, ''));
    } catch {
      return String(hash || '').replace(/^#/, '');
    }
  }

  function ensureId(element, fallback) {
    if (!element.id) element.id = fallback;
    return element.id;
  }

  function getGuideBaseUrl() {
    const root = text(document.body?.dataset.guideRoot) || '.';
    try {
      return new URL(`${root.replace(/\/+$/, '')}/`, globalThis.location.href);
    } catch {
      return new URL('./', globalThis.location.href);
    }
  }

  function normalizeHeadings(headings) {
    if (!Array.isArray(headings)) return [];

    return headings
      .map(heading => {
        if (typeof heading === 'string') {
          return { title: heading.trim(), id: '' };
        }
        if (!heading || typeof heading !== 'object') return null;
        return {
          title: text(heading.title) || text(heading.text) || text(heading.label),
          id: text(heading.id) || text(heading.slug) || text(heading.anchor)
        };
      })
      .filter(heading => heading?.title);
  }

  function normalizeTasks(tasks) {
    if (!Array.isArray(tasks)) return [];
    return tasks
      .map(task => {
        if (typeof task === 'string') return task.trim();
        if (!task || typeof task !== 'object') return '';
        return text(task.title) || text(task.label) || text(task.name);
      })
      .filter(Boolean);
  }

  function normalizeSearchRecord(record) {
    if (!record || typeof record !== 'object') return null;

    const title = text(record.title);
    const url = text(record.url);
    if (!title || !url) return null;

    const headings = normalizeHeadings(record.headings);
    const tasks = normalizeTasks(record.tasks);
    const category = text(record.category);
    const summary = text(record.summary);
    const bodyText = text(record.text);

    const fields = {
      title: normalize(title),
      category: normalize(category),
      summary: normalize(summary),
      headings: normalize(headings.map(heading => heading.title).join(' ')),
      tasks: normalize(tasks.join(' ')),
      text: normalize(bodyText)
    };

    return {
      title,
      url,
      slug: text(record.slug),
      category,
      summary,
      text: bodyText,
      headings,
      tasks,
      fields,
      haystack: Object.values(fields).join(' ')
    };
  }

  function extractSearchRecords(payload) {
    const records = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.items)
        ? payload.items
        : Array.isArray(payload?.pages)
          ? payload.pages
          : [];

    return records.map(normalizeSearchRecord).filter(Boolean);
  }

  function fieldScore(field, term, weights) {
    if (!field || !term) return 0;
    if (field === term) return weights.exact;
    if (field.startsWith(term)) return weights.prefix;
    if (field.includes(term)) return weights.includes;
    return 0;
  }

  function findMatchedHeading(record, terms, fullQuery) {
    return record.headings.find(heading => {
      const headingText = normalize(heading.title);
      if (fullQuery && headingText.includes(fullQuery)) return true;
      return terms.every(term => headingText.includes(term));
    }) || null;
  }

  function scoreRecord(record, terms, fullQuery) {
    if (!terms.every(term => record.haystack.includes(term))) return null;

    let score = 0;
    for (const term of terms) {
      score += fieldScore(record.fields.title, term, { exact: 70, prefix: 42, includes: 30 });
      score += fieldScore(record.fields.category, term, { exact: 24, prefix: 15, includes: 10 });
      score += fieldScore(record.fields.headings, term, { exact: 30, prefix: 22, includes: 18 });
      score += fieldScore(record.fields.tasks, term, { exact: 24, prefix: 18, includes: 13 });
      score += fieldScore(record.fields.summary, term, { exact: 16, prefix: 12, includes: 8 });
      score += fieldScore(record.fields.text, term, { exact: 5, prefix: 4, includes: 2 });
    }

    if (fullQuery) {
      if (record.fields.title.includes(fullQuery)) score += 42;
      if (record.fields.headings.includes(fullQuery)) score += 26;
      if (record.fields.tasks.includes(fullQuery)) score += 18;
      if (record.fields.summary.includes(fullQuery)) score += 12;
    }

    return {
      record,
      score,
      heading: findMatchedHeading(record, terms, fullQuery)
    };
  }

  function searchRecords(records, query) {
    const fullQuery = normalize(query);
    const terms = fullQuery.split(' ').filter(Boolean);
    if (!terms.length) return [];

    return records
      .map(record => scoreRecord(record, terms, fullQuery))
      .filter(Boolean)
      .sort((left, right) => (
        right.score - left.score
        || left.record.title.localeCompare(right.record.title)
      ))
      .slice(0, SEARCH_RESULT_LIMIT);
  }

  function makeSnippet(record, query) {
    const terms = normalize(query).split(' ').filter(Boolean);
    const candidates = [record.summary, record.text].filter(Boolean);

    for (const candidate of candidates) {
      const compact = candidate.replace(/\s+/g, ' ').trim();
      const lowered = compact.toLowerCase();
      const matchIndex = terms
        .map(term => lowered.indexOf(term))
        .filter(index => index >= 0)
        .sort((left, right) => left - right)[0];

      if (Number.isInteger(matchIndex)) {
        const start = Math.max(0, matchIndex - 46);
        const end = Math.min(compact.length, start + 176);
        const prefix = start > 0 ? '\u2026' : '';
        const suffix = end < compact.length ? '\u2026' : '';
        return `${prefix}${compact.slice(start, end).trim()}${suffix}`;
      }
    }

    return truncate(record.summary || record.text || 'Open this guide page.', 150);
  }

  function resolveSearchUrl(baseUrl, match) {
    try {
      const resolved = new URL(match.record.url, baseUrl);
      if (resolved.origin !== globalThis.location.origin) return null;
      if (match.heading?.id) resolved.hash = match.heading.id;
      return resolved.href;
    } catch {
      return null;
    }
  }

  function createSearchResult(match, index, baseUrl, query) {
    const href = resolveSearchUrl(baseUrl, match);
    if (!href) return null;

    const link = document.createElement('a');
    link.className = 'guide-search-result';
    link.href = href;
    link.id = `guideSearchResult-${index}`;
    link.dataset.guideSearchResult = String(index);
    link.setAttribute('role', 'option');
    link.setAttribute('aria-selected', 'false');

    const meta = document.createElement('span');
    meta.className = 'guide-search-result__meta';
    const context = match.heading?.title
      ? [match.record.category, match.heading.title].filter(Boolean).join(' \u00b7 ')
      : match.record.category || 'Guide';
    meta.textContent = context;

    const titleElement = document.createElement('span');
    titleElement.className = 'guide-search-result__title';
    titleElement.textContent = match.record.title;

    const summary = document.createElement('span');
    summary.className = 'guide-search-result__summary';
    summary.textContent = makeSnippet(match.record, query);

    link.append(meta, titleElement, summary);
    return link;
  }

  function setupSearch() {
    const form = document.querySelector('[data-guide-search-form]')
      || document.querySelector('[data-guide-search]')?.closest('form');
    const input = document.querySelector('[data-guide-search]');
    const results = document.querySelector('[data-guide-search-results]');
    const status = document.querySelector('[data-guide-search-status]');
    if (!input || !results) return { isOpen: () => false, clear: () => {} };

    const resultsId = ensureId(results, 'guideSearchResults');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', resultsId);
    input.setAttribute('aria-expanded', 'false');
    results.setAttribute('role', 'listbox');
    results.hidden = true;

    const baseUrl = getGuideBaseUrl();
    const indexUrl = new URL('search-index.json', baseUrl);
    let records = [];
    let loading = true;
    let loadFailed = false;
    let activeIndex = -1;
    let resultLinks = [];

    function updateStatus(message) {
      if (status) status.textContent = message;
    }

    function setExpanded(expanded) {
      results.hidden = !expanded;
      input.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      if (!expanded) {
        activeIndex = -1;
        input.removeAttribute('aria-activedescendant');
      }
    }

    function showMessage(message, statusMessage = message) {
      const empty = document.createElement('div');
      empty.className = 'guide-search-empty';
      empty.textContent = message;
      results.replaceChildren(empty);
      resultLinks = [];
      activeIndex = -1;
      input.removeAttribute('aria-activedescendant');
      setExpanded(true);
      updateStatus(statusMessage);
    }

    function setActiveResult(nextIndex) {
      if (!resultLinks.length) return;

      activeIndex = (nextIndex + resultLinks.length) % resultLinks.length;
      resultLinks.forEach((link, index) => {
        const active = index === activeIndex;
        link.classList.toggle('is-active', active);
        link.setAttribute('aria-selected', active ? 'true' : 'false');
      });

      const activeLink = resultLinks[activeIndex];
      input.setAttribute('aria-activedescendant', activeLink.id);
      activeLink.scrollIntoView?.({ block: 'nearest' });
    }

    function renderResults() {
      const query = input.value.trim();
      if (!query) {
        results.replaceChildren();
        resultLinks = [];
        setExpanded(false);
        updateStatus('');
        return;
      }

      if (loading) {
        showMessage('Loading the offline guide index\u2026', 'Guide search index is loading.');
        return;
      }

      if (loadFailed) {
        showMessage(
          'Search is unavailable. Browse the guide categories instead.',
          'Guide search is unavailable.'
        );
        return;
      }

      const matches = searchRecords(records, query);
      if (!matches.length) {
        showMessage(`No guide results for \u201c${truncate(query, 70)}\u201d.`, 'No guide results found.');
        return;
      }

      const fragment = document.createDocumentFragment();
      const links = [];
      matches.forEach((match, index) => {
        const result = createSearchResult(match, index, baseUrl, query);
        if (!result) return;
        fragment.appendChild(result);
        links.push(result);
      });

      if (!links.length) {
        showMessage('No local guide results are available.', 'No guide results found.');
        return;
      }

      results.replaceChildren(fragment);
      resultLinks = links;
      activeIndex = -1;
      input.removeAttribute('aria-activedescendant');
      setExpanded(true);
      updateStatus(`${links.length} guide result${links.length === 1 ? '' : 's'} available.`);
    }

    function clearSearch({ focus = false } = {}) {
      input.value = '';
      results.replaceChildren();
      resultLinks = [];
      setExpanded(false);
      updateStatus('');
      if (focus) input.focus();
    }

    async function loadIndex() {
      input.setAttribute('aria-busy', 'true');
      try {
        if (indexUrl.origin !== globalThis.location.origin) {
          throw new Error('Guide index must use the extension origin.');
        }
        const response = await fetch(indexUrl.href, {
          cache: 'default',
          credentials: 'same-origin'
        });
        if (!response.ok) {
          throw new Error(`Guide index request failed with ${response.status}.`);
        }
        const payload = await response.json();
        records = extractSearchRecords(payload);
        if (!records.length) throw new Error('Guide index does not contain searchable pages.');
      } catch (error) {
        loadFailed = true;
        console.warn('Chroma guide search unavailable:', error);
      } finally {
        loading = false;
        input.removeAttribute('aria-busy');
        if (input.value.trim()) renderResults();
      }
    }

    input.addEventListener('input', renderResults);
    input.addEventListener('focus', () => {
      if (input.value.trim()) renderResults();
    });

    input.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') {
        if (!results.hidden && resultLinks.length) {
          event.preventDefault();
          setActiveResult(activeIndex + 1);
        }
        return;
      }

      if (event.key === 'ArrowUp') {
        if (!results.hidden && resultLinks.length) {
          event.preventDefault();
          setActiveResult(activeIndex <= 0 ? resultLinks.length - 1 : activeIndex - 1);
        }
        return;
      }

      if (event.key === 'Enter' && !results.hidden && resultLinks.length) {
        event.preventDefault();
        const selected = resultLinks[activeIndex >= 0 ? activeIndex : 0];
        globalThis.location.assign(selected.href);
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        clearSearch({ focus: true });
      }
    });

    form?.addEventListener('submit', event => {
      event.preventDefault();
      if (resultLinks.length) {
        const selected = resultLinks[activeIndex >= 0 ? activeIndex : 0];
        globalThis.location.assign(selected.href);
      } else {
        renderResults();
      }
    });

    results.addEventListener('click', event => {
      if (closestElement(event.target, '[data-guide-search-result]')) setExpanded(false);
    });

    document.addEventListener('click', event => {
      const searchRegion = form || input.parentElement;
      if (searchRegion && !searchRegion.contains(event.target) && !results.contains(event.target)) {
        setExpanded(false);
      }
    });

    loadIndex();

    return {
      isOpen: () => !results.hidden,
      clear: clearSearch,
      focus: () => {
        input.focus();
        input.select();
      }
    };
  }

  function setupMobileNavigation() {
    const toggle = document.querySelector('[data-guide-nav-toggle]');
    const sidebar = document.querySelector('[data-guide-sidebar]');
    const backdrop = document.querySelector('[data-guide-sidebar-backdrop]');
    if (!toggle || !sidebar) {
      return { isOpen: () => false, close: () => {} };
    }

    const media = globalThis.matchMedia?.(MOBILE_NAV_QUERY);
    const focusableSelector = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',');
    const backgroundRegions = Array.from(document.querySelectorAll(
      '.guide-skip-link, .guide-header, .guide-main, .guide-footer'
    ));
    const initialSidebarInert = sidebar.getAttribute('inert');
    let open = false;
    let returnFocus = null;
    let backgroundInertSnapshot = null;

    function syncSidebarInertState() {
      if (media?.matches && !open) sidebar.setAttribute('inert', '');
      else if (initialSidebarInert === null) sidebar.removeAttribute('inert');
      else sidebar.setAttribute('inert', initialSidebarInert);
    }

    function setBackgroundInert(shouldBeInert) {
      if (shouldBeInert) {
        if (backgroundInertSnapshot) return;

        backgroundInertSnapshot = new Map();
        backgroundRegions.forEach(region => {
          backgroundInertSnapshot.set(region, region.getAttribute('inert'));
          region.setAttribute('inert', '');
        });
        return;
      }

      if (!backgroundInertSnapshot) return;
      backgroundInertSnapshot.forEach((previousValue, region) => {
        if (previousValue === null) region.removeAttribute('inert');
        else region.setAttribute('inert', previousValue);
      });
      backgroundInertSnapshot = null;
    }

    function getFocusableElements() {
      return Array.from(sidebar.querySelectorAll(focusableSelector))
        .filter(element => (
          element.tabIndex >= 0
          && !element.closest('[hidden]')
          && !element.closest('[inert]')
          && element.getAttribute('aria-hidden') !== 'true'
        ));
    }

    function focusFirstDrawerControl() {
      const firstControl = getFocusableElements()[0];
      if (firstControl) {
        firstControl.focus();
        return;
      }

      const previousTabIndex = sidebar.getAttribute('tabindex');
      sidebar.setAttribute('tabindex', '-1');
      sidebar.focus();
      if (previousTabIndex === null) sidebar.removeAttribute('tabindex');
      else sidebar.setAttribute('tabindex', previousTabIndex);
    }

    function trapDrawerFocus(event) {
      if (!open || !media?.matches || event.key !== 'Tab') return;

      const focusableElements = getFocusableElements();
      if (!focusableElements.length) {
        event.preventDefault();
        focusFirstDrawerControl();
        return;
      }

      const firstControl = focusableElements[0];
      const lastControl = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (event.shiftKey && (activeElement === firstControl || !sidebar.contains(activeElement))) {
        event.preventDefault();
        lastControl.focus();
      } else if (!event.shiftKey && (
        activeElement === lastControl
        || !sidebar.contains(activeElement)
      )) {
        event.preventDefault();
        firstControl.focus();
      }
    }

    function setOpen(nextOpen, { restoreFocus = false } = {}) {
      const wasOpen = open;
      if (nextOpen && !wasOpen) {
        returnFocus = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : toggle;
      }

      open = Boolean(nextOpen);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      sidebar.classList.toggle('is-open', open);
      document.body.classList.toggle('guide-nav-open', open);
      if (backdrop) backdrop.hidden = !open;
      setBackgroundInert(Boolean(open && media?.matches));
      syncSidebarInertState();

      if (open && !wasOpen) {
        focusFirstDrawerControl();
      } else if (!open && wasOpen) {
        const focusTarget = returnFocus?.isConnected && !returnFocus.closest?.('[inert]')
          ? returnFocus
          : toggle;
        returnFocus = null;
        if (restoreFocus) focusTarget.focus?.();
      }
    }

    toggle.addEventListener('click', () => setOpen(!open, { restoreFocus: open }));
    backdrop?.addEventListener('click', () => setOpen(false, { restoreFocus: true }));
    sidebar.addEventListener('click', event => {
      if (closestElement(event.target, 'a') && media?.matches) {
        setOpen(false, { restoreFocus: true });
      }
    });

    media?.addEventListener?.('change', event => {
      if (!event.matches && open) setOpen(false);
      else {
        setBackgroundInert(Boolean(open && event.matches));
        syncSidebarInertState();
      }
    });

    document.addEventListener('keydown', trapDrawerFocus);
    syncSidebarInertState();

    return {
      isOpen: () => open,
      close: options => setOpen(false, options)
    };
  }

  function setupCurrentPageNavigation() {
    const links = Array.from(document.querySelectorAll('.guide-nav-link'));
    if (!links.length) return;

    const currentSlug = text(document.body.dataset.guideCurrentSlug);
    links.forEach(link => {
      let active = false;
      const linkSlug = text(link.dataset.guideSlug);

      if (currentSlug && linkSlug) {
        active = linkSlug === currentSlug;
      } else {
        try {
          active = new URL(link.href, globalThis.location.href).pathname === globalThis.location.pathname;
        } catch {
          active = false;
        }
      }

      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else if (link.getAttribute('aria-current') === 'page') link.removeAttribute('aria-current');
    });
  }

  function setupTableOfContents() {
    const links = Array.from(document.querySelectorAll('.guide-toc-link'));
    const pairs = links
      .map(link => {
        let hash = '';
        try {
          const targetUrl = new URL(link.href, globalThis.location.href);
          if (targetUrl.pathname !== globalThis.location.pathname) return null;
          hash = targetUrl.hash;
        } catch {
          return null;
        }

        const id = safeDecodeHash(hash);
        const heading = id ? document.getElementById(id) : null;
        return heading ? { link, heading, id } : null;
      })
      .filter(Boolean);

    if (!pairs.length) return;

    let activeId = '';
    let framePending = false;

    function setActive(id) {
      if (!id || id === activeId) return;
      activeId = id;
      pairs.forEach(pair => {
        const active = pair.id === id;
        pair.link.classList.toggle('is-active', active);
        if (active) pair.link.setAttribute('aria-current', 'location');
        else pair.link.removeAttribute('aria-current');
      });
    }

    function findCurrentHeading() {
      const header = document.querySelector('.guide-header');
      const threshold = (header?.getBoundingClientRect().bottom || 0) + 38;
      const nearBottom = globalThis.innerHeight + globalThis.scrollY
        >= document.documentElement.scrollHeight - 12;
      if (nearBottom) return pairs[pairs.length - 1].id;

      let current = pairs[0].id;
      for (const pair of pairs) {
        if (pair.heading.getBoundingClientRect().top <= threshold) current = pair.id;
        else break;
      }
      return current;
    }

    function refresh() {
      framePending = false;
      setActive(findCurrentHeading());
    }

    function scheduleRefresh() {
      if (framePending) return;
      framePending = true;
      if (typeof globalThis.requestAnimationFrame === 'function') {
        globalThis.requestAnimationFrame(refresh);
      } else {
        globalThis.setTimeout(refresh, 0);
      }
    }

    pairs.forEach(pair => {
      pair.link.addEventListener('click', () => setActive(pair.id));
    });

    globalThis.addEventListener('scroll', scheduleRefresh, { passive: true });
    globalThis.addEventListener('resize', scheduleRefresh);
    globalThis.addEventListener('hashchange', () => {
      const id = safeDecodeHash(globalThis.location.hash);
      if (pairs.some(pair => pair.id === id)) setActive(id);
      else scheduleRefresh();
    });

    const initialId = safeDecodeHash(globalThis.location.hash);
    if (pairs.some(pair => pair.id === initialId)) setActive(initialId);
    else refresh();
  }

  function isSafeSettingsPath(value) {
    const path = text(value).replace(/\\/g, '/');
    if (!path || path.startsWith('/') || path.includes('..') || path.includes('?')) return false;
    return /^ui\/settings\.html(?:#[A-Za-z][A-Za-z0-9_-]*)?$/.test(path);
  }

  function setupSettingsLinks() {
    const runtimeGetUrl = globalThis.chrome?.runtime?.getURL;
    if (typeof runtimeGetUrl !== 'function') return;

    document.querySelectorAll('[data-settings-path]').forEach(link => {
      const settingsPath = text(link.dataset.settingsPath).replace(/\\/g, '/');
      if (!isSafeSettingsPath(settingsPath)) return;
      try {
        link.href = runtimeGetUrl(settingsPath);
      } catch {
        // The generated fallback href remains usable outside an extension context.
      }
    });
  }

  function safeTargetUrl(anchor) {
    try {
      const url = new URL(anchor.href, globalThis.location.href);
      if (url.origin === globalThis.location.origin) return url;
      if (SAFE_EXTERNAL_PROTOCOLS.has(url.protocol)) return url;
      if (url.protocol === 'chrome:' && url.hostname === 'extensions') return url;
      return null;
    } catch {
      return null;
    }
  }

  function openNativeTab(url) {
    try {
      const opened = globalThis.open(url, '_blank', 'noopener,noreferrer');
      if (opened) opened.opener = null;
    } catch {
      // If the browser rejects the fallback, the current page remains intact.
    }
  }

  function setupSafeNewTabs() {
    document.querySelectorAll('a[target="_blank"]').forEach(link => {
      link.setAttribute('rel', 'noopener noreferrer');
    });

    document.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = closestElement(event.target, 'a[target="_blank"]');
      if (!anchor) return;

      const target = safeTargetUrl(anchor);
      if (!target) {
        event.preventDefault();
        return;
      }

      const createTab = globalThis.chrome?.tabs?.create;
      if (typeof createTab !== 'function') return;

      event.preventDefault();
      try {
        const result = createTab.call(globalThis.chrome.tabs, { url: target.href });
        if (result && typeof result.catch === 'function') {
          result.catch(() => openNativeTab(target.href));
        }
      } catch {
        openNativeTab(target.href);
      }
    });
  }

  function setupGlobalKeyboard(search, mobileNav) {
    document.addEventListener('keydown', event => {
      if (
        event.key === '/'
        && !event.defaultPrevented
        && !event.ctrlKey
        && !event.metaKey
        && !event.altKey
        && !isTypingTarget(event.target)
      ) {
        event.preventDefault();
        search.focus?.();
        return;
      }

      if (event.key !== 'Escape' || event.defaultPrevented) return;

      if (search.isOpen?.()) {
        event.preventDefault();
        search.clear?.();
        return;
      }

      if (mobileNav.isOpen?.()) {
        event.preventDefault();
        mobileNav.close?.({ restoreFocus: true });
      }
    });
  }

  function init() {
    setupCurrentPageNavigation();
    setupSettingsLinks();
    setupSafeNewTabs();
    setupTableOfContents();

    const search = setupSearch();
    const mobileNav = setupMobileNavigation();
    setupGlobalKeyboard(search, mobileNav);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
