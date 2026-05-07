/**
 * Chroma Ad-Blocker — Cosmetic Filtering & Warning Suppression
 * Runs as a content script on all URLs (Isolated World).
 * Handles CSS injection, DOM mutation cleanup, and anti-adblock warning removal.
 */

(function() {
  'use strict';

  const DEBUG = false;


  // ─── CONFIG ─────
  const CONFIG = {
    enabled: true,
    cosmetic: true,
    hideShorts: false,
    hideMerch: true,
    hideOffers: true,
    suppressWarnings: true,
  };

  const isYouTube = window.location.hostname.includes('youtube.com');
  const isTwitch  = window.location.hostname.includes('twitch.tv');

  // ─── STATE ─────
  let observer = null;
  let HIDE_SELECTORS = [];
  let LOCAL_ZAPPER_SELECTORS = [];
  let WARNING_SELECTOR_COMBINED = '';
  let IS_WHITELISTED = false;
  let statsQueue = [];
  let statsTimer = null;
  const STATS_FLUSH_MS = 750;
  const STATS_BATCH_CAP = 50;
  const countedElementsByKey = new Map();
  
  // Track our adopted stylesheets to allow toggling without clobbering other extensions
  const chromaSheets = new Map();
  const chromaSheetContent = new Map();

  function queueStatsEvent(event) {
    if (!event || typeof event !== 'object') return;
    statsQueue.push({
      ...event,
      ts: Date.now(),
      domain: window.location.hostname
    });

    if (statsQueue.length >= STATS_BATCH_CAP) {
      flushStatsQueue();
      return;
    }

    if (!statsTimer) statsTimer = setTimeout(flushStatsQueue, STATS_FLUSH_MS);
  }

  function flushStatsQueue() {
    if (statsTimer) {
      clearTimeout(statsTimer);
      statsTimer = null;
    }

    const events = statsQueue.splice(0, STATS_BATCH_CAP);
    if (events.length === 0) return;

    try {
      chrome.runtime.sendMessage({ type: 'STATS_EVENT_BATCH', events }).catch(() => {});
    } catch (_) {}
  }

  function getSeenElements(key) {
    if (!countedElementsByKey.has(key)) countedElementsByKey.set(key, new WeakSet());
    return countedElementsByKey.get(key);
  }

  function countNewSelectorMatches(selectors, key) {
    if (!Array.isArray(selectors) || selectors.length === 0) return 0;
    const seen = getSeenElements(key);
    let count = 0;
    for (const selector of selectors) {
      try {
        document.querySelectorAll(selector).forEach(el => {
          if (!el || seen.has(el)) return;
          seen.add(el);
          count++;
        });
      } catch (_) {}
    }
    return count;
  }

  function recordSelectorStats(styleDef) {
    if (!styleDef.stats || !styleDef.isEnabled()) return;
    const count = countNewSelectorMatches(styleDef.stats.selectors, styleDef.id);
    if (count > 0) {
      queueStatsEvent({ ...styleDef.stats.event, count });
    }
  }

  function getValidSelectors(selectors) {
    if (!Array.isArray(selectors)) return [];

    const out = [];
    const seen = new Set();

    for (const raw of selectors) {
      if (typeof raw !== 'string') continue;
      const selector = raw.trim();
      if (!selector || seen.has(selector)) continue;

      try {
        document.querySelector(selector);
        out.push(selector);
        seen.add(selector);
      } catch {
        if (DEBUG) console.warn('[Chroma] Dropping invalid cosmetic selector:', selector);
      }
    }

    return out;
  }

  function buildHideCSS(selectors) {
    const body = `
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
      height: 0 !important;
      width: 0 !important;
      min-height: 0 !important;
      overflow: hidden !important;
    `;

    return selectors.map(selector => `${selector} {${body}}`).join('\n');
  }

  function buildLocalZapperCSS(selectors) {
    return selectors.map(selector => `${selector} { display: none !important; }`).join('\n');
  }

  function domainMatches(hostname, domain) {
    return hostname === domain || hostname.endsWith('.' + domain);
  }

  function getMatchingLocalZapperSelectors(rules, hostname = window.location.hostname) {
    if (!Array.isArray(rules)) return [];

    return getValidSelectors(
      rules
        .filter(rule =>
          rule &&
          rule.source === 'zapper' &&
          rule.enabled === true &&
          typeof rule.domain === 'string' &&
          typeof rule.selector === 'string' &&
          domainMatches(hostname, rule.domain.toLowerCase())
        )
        .map(rule => rule.selector)
    );
  }

  function shouldRunDomCleanup() {
    return CONFIG.enabled && CONFIG.cosmetic;
  }

  function shouldRunObserver() {
    return CONFIG.enabled && (CONFIG.cosmetic || CONFIG.suppressWarnings);
  }

  // ─── COSMETIC FILTERING ─────
  function injectAllCSS() {
    const styles = [
      {
        id: 'chroma-cosmetic',
        content: `
          ${buildHideCSS(HIDE_SELECTORS)}
          #player-theater-container, #player-container-id {
            max-width: unset !important;
          }
          .ytp-chrome-bottom {
            z-index: 9999999 !important; /* High layer for player controls */
          }
        `,
        isEnabled: () => CONFIG.enabled && CONFIG.cosmetic,
        stats: {
          selectors: HIDE_SELECTORS,
          event: { layer: 'cosmetic', type: 'hide' }
        }
      },
      {
        id: 'chroma-local-zapper',
        content: buildLocalZapperCSS(LOCAL_ZAPPER_SELECTORS),
        isEnabled: () => CONFIG.enabled && CONFIG.cosmetic && LOCAL_ZAPPER_SELECTORS.length > 0,
        stats: {
          selectors: LOCAL_ZAPPER_SELECTORS,
          event: { layer: 'zapper', type: 'hit' }
        }
      },
      {
        id: 'chroma-shorts',
        content: `
          ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts]),
          ytd-rich-shelf-renderer[is-shorts],
          ytd-reel-shelf-renderer,
          ytd-guide-entry-renderer:has([title^="Shorts"]),
          ytd-mini-guide-entry-renderer[aria-label="Shorts"],
          ytd-bottom-pivot-link-renderer:has([title="Shorts"]),
          yt-chip-cloud-chip-renderer:has([title="Shorts"]) {
            display: none !important;
          }
        `,
        isEnabled: () => CONFIG.enabled && CONFIG.cosmetic && CONFIG.hideShorts,
        stats: {
          selectors: [
            'ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])',
            'ytd-rich-shelf-renderer[is-shorts]',
            'ytd-reel-shelf-renderer',
            'ytd-guide-entry-renderer:has([title^="Shorts"])',
            'ytd-mini-guide-entry-renderer[aria-label="Shorts"]',
            'ytd-bottom-pivot-link-renderer:has([title="Shorts"])',
            'yt-chip-cloud-chip-renderer:has([title="Shorts"])'
          ],
          event: { layer: 'cosmetic', type: 'hide', subtype: 'youtube_shorts' }
        }
      },
      {
        id: 'chroma-merch',
        content: `
          ytd-merch-shelf-renderer,
          ytd-companion-slot-renderer,
          ytd-shopping-panel-renderer,
          ytd-horizontal-card-list-renderer:has(ytd-shopping-carousel-item-renderer) {
            display: none !important;
          }
        `,
        isEnabled: () => CONFIG.enabled && CONFIG.cosmetic && CONFIG.hideMerch,
        stats: {
          selectors: [
            'ytd-merch-shelf-renderer',
            'ytd-companion-slot-renderer',
            'ytd-shopping-panel-renderer',
            'ytd-horizontal-card-list-renderer:has(ytd-shopping-carousel-item-renderer)'
          ],
          event: { layer: 'cosmetic', type: 'hide', subtype: 'youtube_merch' }
        }
      },
      {
        id: 'chroma-enforcement',
        content: `
          ytd-enforcement-dialog-view-model,
          tp-yt-paper-dialog:has(ytd-enforcement-dialog-view-model),
          ytd-popup-container:has(ytd-enforcement-dialog-view-model),
          ytd-mealbar-promo-renderer,
          ytd-statement-banner-renderer,
          yt-notification-action-renderer,
          tp-yt-paper-toast,
          ytd-popup-container tp-yt-paper-toast {
            display: none !important;
          }
        `,
        isEnabled: () => CONFIG.enabled && CONFIG.suppressWarnings && isYouTube,
        stats: {
          selectors: [
            'ytd-enforcement-dialog-view-model',
            'tp-yt-paper-dialog:has(ytd-enforcement-dialog-view-model)',
            'ytd-popup-container:has(ytd-enforcement-dialog-view-model)',
            'ytd-mealbar-promo-renderer',
            'ytd-statement-banner-renderer',
            'yt-notification-action-renderer',
            'tp-yt-paper-toast',
            'ytd-popup-container tp-yt-paper-toast'
          ],
          event: { layer: 'warning', type: 'suppression' }
        }
      },
      {
        id: 'chroma-offers',
        content: `
          ytd-tvfilm-offer-module-renderer,
          ytd-movie-offer-module-renderer,
          ytd-offer-module-renderer,
          ytd-compact-movie-renderer,
          ytd-compact-tvfilm-renderer {
            display: none !important;
          }
        `,
        isEnabled: () => CONFIG.enabled && CONFIG.cosmetic && CONFIG.hideOffers,
        stats: {
          selectors: [
            'ytd-tvfilm-offer-module-renderer',
            'ytd-movie-offer-module-renderer',
            'ytd-offer-module-renderer',
            'ytd-compact-movie-renderer',
            'ytd-compact-tvfilm-renderer'
          ],
          event: { layer: 'cosmetic', type: 'hide', subtype: 'youtube_offers' }
        }
      },
      {
        id: 'chroma-twitch-cosmetic',
        content: `
          .ads-manager,
          .ad-slot,
          [class*="ad-banner"],
          .tw-interstitial,
          .ad-overlay,
          [data-target="ad-slot"],
          [data-test-selector="ad-banner-default-text"],
          [data-a-target="video-ad-label"],
          [data-a-target="sda-panel"],
          [data-a-target="outstream-ax-overlay"],
          .premium-ad-slot,
          .stream-display-ad__wrapper,
          #stream-lowerthird,
          .video-ad-display,
          .video-ad-label,
          .player-ad-notice,
          .player-ad-notice__label,
          .outstream-vertical-video,
          .outstream-mirror-pbyp-video,
          .outstream-home-page-video,
          .squeezeback,
          .headliner,
          .pause-ad,
          .promotions-list,
          .home-carousel-ad {
            display: none !important;
          }
        `,
        isEnabled: () => CONFIG.enabled && CONFIG.cosmetic && isTwitch,
        stats: {
          selectors: [
            '.ads-manager',
            '.ad-slot',
            '[class*="ad-banner"]',
            '.tw-interstitial',
            '.ad-overlay',
            '[data-target="ad-slot"]',
            '[data-test-selector="ad-banner-default-text"]',
            '[data-a-target="video-ad-label"]'
          ],
          event: { layer: 'cosmetic', type: 'hide', subtype: 'twitch' }
        }
      }
    ];

    styles.forEach(styleDef => {
      let sheet = chromaSheets.get(styleDef.id);
      if (!sheet || chromaSheetContent.get(styleDef.id) !== styleDef.content) {
        const nextSheet = new CSSStyleSheet();
        try {
          nextSheet.replaceSync(styleDef.content);
        } catch (e) {
          if (DEBUG) console.error(`[Chroma] Failed to parse CSS for ${styleDef.id}:`, e);
          return;
        }

        if (sheet) {
          const currentSheets = document.adoptedStyleSheets || [];
          if (currentSheets.includes(sheet)) {
            document.adoptedStyleSheets = currentSheets.map(s => s === sheet ? nextSheet : s);
          }
        }

        sheet = nextSheet;
        chromaSheets.set(styleDef.id, sheet);
        chromaSheetContent.set(styleDef.id, styleDef.content);
      }

      const isEnabled = styleDef.isEnabled();
      const currentSheets = document.adoptedStyleSheets || [];

      if (isEnabled && !currentSheets.includes(sheet)) {
        document.adoptedStyleSheets = [...currentSheets, sheet];
        recordSelectorStats(styleDef);
      } else if (!isEnabled && currentSheets.includes(sheet)) {
        document.adoptedStyleSheets = currentSheets.filter(s => s !== sheet);
      } else if (isEnabled) {
        recordSelectorStats(styleDef);
      }
    });
  }


  // ─── ANTI-ADBLOCK WARNING SUPPRESSION ─────
  function suppressAdblockWarnings(nodes) {

    if (!CONFIG.enabled || !CONFIG.suppressWarnings || !WARNING_SELECTOR_COMBINED) return;

    let removedCount = 0;

    if (!nodes) {
      const els = document.querySelectorAll(WARNING_SELECTOR_COMBINED);
      if (els.length > 0) {
        els.forEach(el => {
          el.remove();
          removedCount++;
        });
      }
    } else {
      const nodesToProcess = Array.isArray(nodes) ? nodes : [nodes];
      for (const node of nodesToProcess) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;

        if (typeof node.matches === 'function' && node.matches(WARNING_SELECTOR_COMBINED)) {
          node.remove();
          removedCount++;
          continue;
        }

        if (node.firstElementChild && typeof node.querySelectorAll === 'function') {
          const els = node.querySelectorAll(WARNING_SELECTOR_COMBINED);
          if (els.length > 0) {
            els.forEach(el => {
              el.remove();
              removedCount++;
            });
          }
        }
      }
    }

    if (removedCount > 0) {
      queueStatsEvent({ layer: 'warning', type: 'suppression', count: removedCount });
    }

    if (removedCount > 0 && isYouTube) {
      const video = document.querySelector('video');
      if (video && video.paused) {
        video.play().catch(() => {});
      }
    }
  }

  // ─── DOM OBSERVER ─────
  function startObserver() {
    if (observer) observer.disconnect();

    let pendingNodes = new Set();
    let pendingFrame = false;

    observer = new MutationObserver((mutations) => {
      let hasNewNodes = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            pendingNodes.add(node);
            hasNewNodes = true;
          }
        }
      }

      if (hasNewNodes && !pendingFrame) {
        pendingFrame = true;
        requestAnimationFrame(() => {
          const nodesToProcess = Array.from(pendingNodes);
          pendingNodes.clear();

          if (nodesToProcess.length > 0) {
            suppressAdblockWarnings(nodesToProcess);
            if (shouldRunDomCleanup()) {
              removeLeftoverAdContainers(nodesToProcess);
            }
          }
          pendingFrame = false;
        });
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function removeLeftoverAdContainers(nodes) {
    if (!shouldRunDomCleanup()) return;

    const nodesToProcess = Array.isArray(nodes) ? nodes : [nodes || document];
    let removedCount = 0;

    for (const node of nodesToProcess) {
      if (!node) continue;

      const isElement = node.nodeType === Node.ELEMENT_NODE;

      const processAdContainer = (el) => {
        if (!el || !el.id || typeof el.id !== 'string') return;
        
        // Exclusion: Internal extension styles and critical site elements
        const id = el.id.toLowerCase();
        const EXCLUDE_IDS = ['chroma', 'masthead', 'player', 'content', 'columns', 'guide', 'secondary', 'primary'];
        if (EXCLUDE_IDS.some(ex => id.includes(ex))) return;

        // Matching: Restrictive ad-like ID patterns
        // We look for patterns that are typical of ad injections but not general UI.
        const isAdPattern = /^(ad[_-]container|ad[_-]slot|google_ads_iframe|taboola-|outbrain-)/i.test(id) || 
                           (id.includes('ad-container') && !id.includes('video-ad-container'));

        if (isAdPattern) {
          if (DEBUG) console.log('[Chroma Ad-Blocker] Removing suspicious container:', el.id);
          el.style.display = 'none';
          el.remove();
          removedCount++;
        }
      };

      if (isElement && node.id) {
        processAdContainer(node);
      }
      if (typeof node.querySelectorAll === 'function') {
        node.querySelectorAll('[id*="ad-container"], [id*="ad_container"], [id*="ad-slot"]').forEach(processAdContainer);
      }
    }

    if (removedCount > 0) {
      queueStatsEvent({
        layer: 'cosmetic',
        type: 'hide',
        subtype: 'leftover_ad_container',
        count: removedCount
      });
    }
  }

  // ─── NAVIGATION HANDLING (SPA) ─────
  function onYTNavigate() {
    [500, 1500].forEach(delay => { // 500ms catches initial DOM swap; 1500ms catches lazy-rendered ad slots
      setTimeout(() => {
        suppressAdblockWarnings();
        if (shouldRunDomCleanup()) {
          removeLeftoverAdContainers();
        }
      }, delay);
    });
  }

  if (isYouTube) {
    document.addEventListener('yt-navigate-finish', onYTNavigate);
    document.addEventListener('yt-page-data-updated', onYTNavigate);
  }

  // ─── MESSAGE LISTENER ─────
  // Hardcoded type string — messaging.js is only injected on YouTube/Amazon,
  // but content.js runs on <all_urls>. Using window.MSG here would silently
  // drop config updates on all other sites.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'CONFIG_UPDATE') {
      Object.assign(CONFIG, msg.config);
      
      if (shouldRunObserver()) {
        startObserver();
      } else {
        if (observer) {
          observer.disconnect();
          observer = null;
        }
      }

      injectAllCSS();
    }
  });

  if (chrome.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.localCosmeticRules) return;
      if (IS_WHITELISTED) return;
      LOCAL_ZAPPER_SELECTORS = getMatchingLocalZapperSelectors(changes.localCosmeticRules.newValue || []);
      injectAllCSS();
    });
  }

  // ─── INIT ─────
  document.addEventListener('__CHROMA_SCRIPTLET_STATS__', (event) => {
    const detail = event?.detail;
    if (!detail || typeof detail !== 'object') return;
    queueStatsEvent({
      layer: 'scriptlet',
      type: detail.type === 'error' ? 'error' : 'hit',
      scriptlet: detail.scriptlet,
      ruleSource: detail.source,
      error: detail.error
    });
  }, true);

  async function init() {
    try {
      const data = await chrome.storage.local.get(['config', 'HIDE_SELECTORS', 'WARNING_SELECTORS', 'whitelist', 'subscriptionCosmeticRules', 'localCosmeticRules']);
      
      const whitelist = data.whitelist || [];
      const hostname = window.location.hostname;
      IS_WHITELISTED = whitelist.some(d => hostname === d || hostname.endsWith('.' + d));
      if (IS_WHITELISTED) {
        if (DEBUG) console.log('[Chroma] Domain is whitelisted. Staying inactive.');
        return;
      }

      if (data.config) {
        Object.assign(CONFIG, data.config);
      }
      
      if (data.HIDE_SELECTORS) {
        HIDE_SELECTORS = getValidSelectors(data.HIDE_SELECTORS);
      }

      // Merge subscription cosmetic rules applicable to the current hostname.
      if (data.subscriptionCosmeticRules && Array.isArray(data.subscriptionCosmeticRules)) {
        const h = window.location.hostname;

        // Collect exception selectors for this domain first
        const exceptionSelectors = new Set(
          data.subscriptionCosmeticRules
            .filter(r => r.isException && (r.domains === null || r.domains.some(d => h === d || h.endsWith('.' + d))))
            .map(r => r.selector)
        );

        // Merge non-excepted selectors into HIDE_SELECTORS
        const additional = data.subscriptionCosmeticRules
          .filter(r =>
            !r.isException &&
            !exceptionSelectors.has(r.selector) &&
            (r.domains === null || r.domains.some(d => h === d || h.endsWith('.' + d)))
          )
          .map(r => r.selector);

        HIDE_SELECTORS = getValidSelectors([...HIDE_SELECTORS, ...additional]);
      }

      LOCAL_ZAPPER_SELECTORS = getMatchingLocalZapperSelectors(data.localCosmeticRules || [], hostname);
      
      if (data.WARNING_SELECTORS) {
        WARNING_SELECTOR_COMBINED = data.WARNING_SELECTORS.join(',');
      }

      injectAllCSS();

      if (shouldRunObserver()) {
        startObserver();
      }

      if (CONFIG.enabled && CONFIG.suppressWarnings) {
        suppressAdblockWarnings();
      }

      if (shouldRunDomCleanup()) {
        removeLeftoverAdContainers();
      }
    } catch (err) {
      if (DEBUG) console.warn('[Chroma Ad-Blocker] Init fetch failed, using defaults.', err);
      injectAllCSS();
      if (shouldRunObserver()) {
        startObserver();
      }
      if (CONFIG.enabled && CONFIG.suppressWarnings) {
        suppressAdblockWarnings();
      }
      if (shouldRunDomCleanup()) {
        removeLeftoverAdContainers();
      }
    }
  }

  init();

  // ─── TESTING EXPORTS ─────
  if (typeof globalThis !== 'undefined' && globalThis.__CHROMA_INTERNAL_TEST_STRICT__ === true) {
    /** @type {Object} */
    globalThis.CONFIG = CONFIG;
    /** @returns {void} */
    globalThis.injectAllCSS = injectAllCSS;
    /** @param {NodeList|Element[]|Element} [nodes] @returns {void} */
    globalThis.suppressAdblockWarnings = suppressAdblockWarnings;
    /** @param {NodeList|Element[]|Element} [nodes] @returns {void} */
    globalThis.removeLeftoverAdContainers = removeLeftoverAdContainers;
    /** @param {string} val @returns {void} */
    globalThis.setWarningSelector = (val) => { WARNING_SELECTOR_COMBINED = val; };
    /** @param {string[]} val @returns {void} */
    globalThis.setHideSelectors = (val) => { HIDE_SELECTORS = getValidSelectors(val); };
    /** @param {Object[]} val @param {string} [hostname] @returns {string[]} */
    globalThis.getMatchingLocalZapperSelectors = getMatchingLocalZapperSelectors;
    /** @param {Object[]} val @returns {void} */
    globalThis.setLocalZapperRules = (val) => { LOCAL_ZAPPER_SELECTORS = getMatchingLocalZapperSelectors(val); };
    globalThis.queueStatsEvent = queueStatsEvent;
    globalThis.flushStatsQueue = flushStatsQueue;
    globalThis.getPendingStatsQueue = () => statsQueue.slice();
  }
})();
