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

  // ─── STATE ─────
  let observer = null;
  let HIDE_SELECTORS = [];
  let WARNING_SELECTOR_COMBINED = '';
  
  // Track our adopted stylesheets to allow toggling without clobbering other extensions
  const chromaSheets = new Map();

  // ─── COSMETIC FILTERING ─────
  function injectAllCSS() {
    const styles = [
      {
        id: 'chroma-cosmetic',
        content: `
          ${HIDE_SELECTORS.join(',\n    ')} {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
            height: 0 !important;
            width: 0 !important;
            min-height: 0 !important;
            overflow: hidden !important;
          }
          #player-theater-container, #player-container-id {
            max-width: unset !important;
          }
          .ytp-chrome-bottom {
            z-index: 9999999 !important; /* High layer for player controls */
          }
        `,
        isEnabled: () => CONFIG.enabled && CONFIG.cosmetic
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
        isEnabled: () => CONFIG.enabled && CONFIG.hideShorts
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
        isEnabled: () => CONFIG.enabled && CONFIG.hideMerch
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
        isEnabled: () => CONFIG.enabled && CONFIG.hideOffers
      }
    ];

    styles.forEach(styleDef => {
      let sheet = chromaSheets.get(styleDef.id);
      if (!sheet) {
        sheet = new CSSStyleSheet();
        try {
          sheet.replaceSync(styleDef.content);
          chromaSheets.set(styleDef.id, sheet);
        } catch (e) {
          if (DEBUG) console.error(`[Chroma] Failed to parse CSS for ${styleDef.id}:`, e);
          return;
        }
      }

      const isEnabled = styleDef.isEnabled();
      const currentSheets = document.adoptedStyleSheets || [];

      if (isEnabled && !currentSheets.includes(sheet)) {
        document.adoptedStyleSheets = [...currentSheets, sheet];
      } else if (!isEnabled && currentSheets.includes(sheet)) {
        document.adoptedStyleSheets = currentSheets.filter(s => s !== sheet);
      }
    });
  }


  // ─── ANTI-ADBLOCK WARNING SUPPRESSION ─────
  function suppressAdblockWarnings(nodes) {
    if (!CONFIG.enabled || !CONFIG.suppressWarnings || !WARNING_SELECTOR_COMBINED) return;

    let removedAny = false;

    if (!nodes) {
      const els = document.querySelectorAll(WARNING_SELECTOR_COMBINED);
      if (els.length > 0) {
        removedAny = true;
        els.forEach(el => el.remove());
      }
    } else {
      const nodesToProcess = Array.isArray(nodes) ? nodes : [nodes];
      for (const node of nodesToProcess) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;

        if (typeof node.matches === 'function' && node.matches(WARNING_SELECTOR_COMBINED)) {
          node.remove();
          removedAny = true;
          continue;
        }

        if (node.firstElementChild && typeof node.querySelectorAll === 'function') {
          const els = node.querySelectorAll(WARNING_SELECTOR_COMBINED);
          if (els.length > 0) {
            removedAny = true;
            els.forEach(el => el.remove());
          }
        }
      }
    }

    if (removedAny && isYouTube) {
      const video = document.querySelector('video');
      if (video && video.paused) {
        video.play().catch(() => {});
      }
    }
    if (isYouTube) {
      removeScrollLock();
    }
  }

  // ─── SCROLL LOCK PREVENTION ─────
  let scrollLockObserver = null;

  function removeScrollLock() {
    const targets = [document.documentElement, document.body];
    targets.forEach(el => {
      if (!el) return;
      const s = el.style;
      if (s.overflow === 'hidden' || s.overflowY === 'hidden') {
        s.removeProperty('overflow');
        s.removeProperty('overflow-y');
      }
      // YouTube sometimes uses position:fixed on <body> to freeze scroll position
      if (el === document.body && s.position === 'fixed') {
        s.removeProperty('position');
        s.removeProperty('top');
      }
    });
  }

  function startScrollLockObserver() {
    if (scrollLockObserver) scrollLockObserver.disconnect();
    scrollLockObserver = new MutationObserver(() => removeScrollLock());
    const opts = { attributes: true, attributeFilter: ['style', 'class'] };
    if (document.documentElement) scrollLockObserver.observe(document.documentElement, opts);
    if (document.body) scrollLockObserver.observe(document.body, opts);
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
            removeLeftoverAdContainers(nodesToProcess);
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
    const nodesToProcess = Array.isArray(nodes) ? nodes : [nodes || document];

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
        }
      };

      if (isElement && node.id) {
        processAdContainer(node);
      }
      if (typeof node.querySelectorAll === 'function') {
        node.querySelectorAll('[id*="ad-container"], [id*="ad_container"], [id*="ad-slot"]').forEach(processAdContainer);
      }
    }
  }

  // ─── NAVIGATION HANDLING (SPA) ─────
  function onYTNavigate() {
    [500, 1500].forEach(delay => { // 500ms catches initial DOM swap; 1500ms catches lazy-rendered ad slots
      setTimeout(() => {
        suppressAdblockWarnings();
        removeLeftoverAdContainers();
      }, delay);
    });
  }

  if (isYouTube) {
    document.addEventListener('yt-navigate-finish', onYTNavigate);
    document.addEventListener('yt-page-data-updated', onYTNavigate);
  }

  // ─── MESSAGE LISTENER ─────
  chrome.runtime.onMessage.addListener((msg) => {
    const MSG = window.MSG;
    if (MSG && msg.type === MSG.CONFIG_UPDATE) {
      Object.assign(CONFIG, msg.config);
      
      if (!CONFIG.enabled) {
        if (observer) {
          observer.disconnect();
          observer = null;
        }
      } else {
        startObserver();
      }

      injectAllCSS();
    }
  });

  // ─── INIT ─────
  async function init() {
    try {
      const data = await chrome.storage.local.get(['config', 'HIDE_SELECTORS', 'WARNING_SELECTORS', 'whitelist', 'subscriptionCosmeticRules']);
      
      const whitelist = data.whitelist || [];
      const hostname = window.location.hostname;
      if (whitelist.some(d => hostname === d || hostname.endsWith('.' + d))) {
        if (DEBUG) console.log('[Chroma] Domain is whitelisted. Staying inactive.');
        return;
      }

      if (data.config) {
        Object.assign(CONFIG, data.config);
      }
      
      if (data.HIDE_SELECTORS) {
        HIDE_SELECTORS = data.HIDE_SELECTORS;
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

        const validated = additional.filter(sel => {
          try { document.querySelector(sel); return true; } catch { return false; }
        });

        HIDE_SELECTORS = [...HIDE_SELECTORS, ...validated];
      }
      
      if (data.WARNING_SELECTORS) {
        WARNING_SELECTOR_COMBINED = data.WARNING_SELECTORS.join(',');
      }

      injectAllCSS();

      if (CONFIG.enabled) {
        startObserver();
        suppressAdblockWarnings();
        if (isYouTube) {
          removeScrollLock();
          startScrollLockObserver();
        }
      }
    } catch (err) {
      if (DEBUG) console.warn('[Chroma Ad-Blocker] Init fetch failed, using defaults.', err);
      injectAllCSS();
      startObserver();
      suppressAdblockWarnings();
      if (isYouTube) {
        removeScrollLock();
        startScrollLockObserver();
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
    globalThis.setHideSelectors = (val) => { HIDE_SELECTORS = val; };
  }
})();
