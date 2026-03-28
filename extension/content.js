(function() {
  'use strict';

  const DEBUG = false;

  // ─── CONFIG ──────────────────────────────────────────────────────────────────
  const CONFIG = {
    enabled: true,
    networkBlocking: true,
    acceleration: true,
    cosmetic: true,
    hideShorts: false,
    hideMerch: true,
    hideOffers: true,
    suppressWarnings: true,
    accelerationSpeed: 16,
  };

  const isYouTube = window.location.hostname.includes('youtube.com');

  // ─── STATE ────────────────────────────────────────────────────────────────────
  let observer = null;
  let HIDE_SELECTORS = [];
  let WARNING_SELECTOR_COMBINED = '';
  
  // Track our adopted stylesheets to allow toggling without clobbering other extensions
  const chromaSheets = new Map(); // id -> CSSStyleSheet

  // ─── COSMETIC FILTERING ───────────────────────────────────────────────────────
  function injectAllCSS() {
    const styles = [
      {
        id: 'yt-chroma-cosmetic',
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
          .ytp-ad-player-overlay,
          .ytp-ad-player-overlay-instream-info,
          .ytp-ad-skip-button-container, 
          .ytp-ad-skip-button-slot,
          .ytp-skip-ad-button, 
          .videoAdUiSkipButton,
          [id^="skip-button:"] {
            z-index: 2147483647 !important;
          }
          .ytp-chrome-bottom {
            z-index: 9999999 !important;
          }
        `,
        isEnabled: () => CONFIG.enabled && CONFIG.cosmetic
      },
      {
        id: 'yt-chroma-shorts',
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
        id: 'yt-chroma-merch',
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
        id: 'yt-chroma-offers',
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
        // Constructable Stylesheets: Prevents HTML injection by keeping styles isolated from the DOM string parser.
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

  function updateAllStyles() {
    // Rely on injectAllCSS to reconcile stylesheets
    injectAllCSS();
  }

  // ─── ANTI-ADBLOCK WARNING SUPPRESSION ────────────────────────────────────────
  function suppressAdblockWarnings(nodes) {
    if (!CONFIG.enabled || !CONFIG.suppressWarnings || !WARNING_SELECTOR_COMBINED) return;

    let removedAny = false;

    if (!nodes) {
      // Fallback for full document checks (e.g. init, navigation)
      if (!WARNING_SELECTOR_COMBINED) return; 
      const els = document.querySelectorAll(WARNING_SELECTOR_COMBINED);
      if (els.length > 0) {
        removedAny = true;
        els.forEach(el => el.remove());
      }
    } else {
      // Fast path for MutationObserver: process only added nodes
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
    if (removedAny && document.body) {
      document.body.style.removeProperty('overflow');
    }
  }

  // ─── DOM OBSERVER ─────────────────────────────────────────────────────────────
  function startObserver() {
    if (observer) observer.disconnect();

    // State trackers for batched DOM processing via requestAnimationFrame to maintain UI performance.
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

      // Heuristic-based container removal: Targeting ad-specific IDs while protecting core UI components.
      const processAdContainer = (el) => {
        if (!el || !el.id) return;
        
        // 1. Exclude internal extension styles and critical site elements
        const id = el.id.toLowerCase();
        const EXCLUDE_IDS = ['yt-chroma', 'masthead', 'player', 'content', 'columns', 'guide', 'secondary', 'primary'];
        if (EXCLUDE_IDS.some(ex => id.includes(ex))) return;

        // 2. More restrictive matching for ad-like IDs
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
        // Only target specific suspicious patterns to avoid over-matching
        node.querySelectorAll('[id*="ad-container"], [id*="ad_container"], [id*="ad-slot"]').forEach(processAdContainer);
      }

      // Handle Shorts
      if (CONFIG.enabled && CONFIG.hideShorts) {
        const shortsSelector = 'ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts]), ytd-rich-shelf-renderer[is-shorts], ytd-reel-shelf-renderer';
        const processShorts = (el) => {
          el.style.display = 'none';
          if (!el.closest('#secondary')) el.remove();
        };

        if (isElement && typeof node.matches === 'function' && node.matches(shortsSelector)) {
          processShorts(node);
        }
        if (typeof node.querySelectorAll === 'function') {
          node.querySelectorAll(shortsSelector).forEach(processShorts);
        }
      }

      // Handle Merch
      if (CONFIG.enabled && CONFIG.hideMerch) {
        const merchSelector = 'ytd-merch-shelf-renderer, ytd-companion-slot-renderer, ytd-shopping-panel-renderer, ytd-horizontal-card-list-renderer:has(ytd-shopping-carousel-item-renderer)';
        const processMerch = (el) => {
          el.style.display = 'none';
          if (!el.closest('#secondary')) el.remove();
        };

        if (isElement && typeof node.matches === 'function' && node.matches(merchSelector)) {
          processMerch(node);
        }
        if (typeof node.querySelectorAll === 'function') {
          node.querySelectorAll(merchSelector).forEach(processMerch);
        }
      }

      // Handle Offers
      if (CONFIG.enabled && CONFIG.hideOffers) {
        const offersSelector = 'ytd-tvfilm-offer-module-renderer, ytd-movie-offer-module-renderer, ytd-offer-module-renderer, ytd-compact-movie-renderer, ytd-compact-tvfilm-renderer';
        const processOffers = (el) => {
          el.style.display = 'none';
          if (!el.closest('#secondary')) el.remove();
        };

        if (isElement && typeof node.matches === 'function' && node.matches(offersSelector)) {
          processOffers(node);
        }
        if (typeof node.querySelectorAll === 'function') {
          node.querySelectorAll(offersSelector).forEach(processOffers);
        }
      }

      // Handle Ad Slots
      const adSlotSelector = 'ytd-ad-slot-renderer, .ytd-ad-slot-renderer, #ad-badge';
      const processAdSlot = (slot) => {
        const parent = slot.closest('ytd-rich-item-renderer, ytd-rich-section-renderer');
        if (parent) {
          parent.style.display = 'none';
          parent.remove();
        } else {
          slot.style.display = 'none';
          if (!slot.closest('#secondary')) {
            slot.remove();
          }
        }
      };

      if (isElement && typeof node.matches === 'function' && node.matches(adSlotSelector)) {
        processAdSlot(node);
      }
      if (typeof node.querySelectorAll === 'function') {
        node.querySelectorAll(adSlotSelector).forEach(processAdSlot);
      }
    }
  }

  // ─── NAVIGATION HANDLING (SPA) ────────────────────────────────────────────────
  function onYTNavigate() {
    // Multi-stage cleanup: Accounts for both early DOM mounting and late-loading ad scripts during SPA navigation.
    [500, 1500].forEach(delay => {
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

  // ─── MESSAGE LISTENER ────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === MSG.CONFIG_UPDATE) {
      Object.assign(CONFIG, msg.config);
      
      if (!CONFIG.enabled) {
        if (observer) {
          observer.disconnect();
          observer = null;
        }
      } else {
        startObserver();
      }

      updateAllStyles();
    }
  });

  // ─── INIT ─────────────────────────────────────────────────────────────────────
  async function init() {
    try {
      const data = await chrome.storage.local.get(['config', 'HIDE_SELECTORS', 'WARNING_SELECTORS', 'whitelist']);
      
      // Whitelist check: if whitelisted, exit early.
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
      
      if (data.WARNING_SELECTORS) {
        WARNING_SELECTOR_COMBINED = data.WARNING_SELECTORS.join(',');
      }

      injectAllCSS();
      updateAllStyles();

      if (CONFIG.enabled) {
        startObserver();
        suppressAdblockWarnings();
      }
    } catch (err) {
      if (DEBUG) console.warn('[Chroma Ad-Blocker] Init fetch failed, using defaults.', err);
      injectAllCSS();
      startObserver();
      suppressAdblockWarnings();
    }
  }

  init();

  // ─── TESTING EXPORTS ────────────────────────────────────────────────────────
  if (typeof globalThis !== 'undefined' && globalThis.__TESTING__) {
    globalThis.CONFIG = CONFIG;
    globalThis.MSG = MSG;
    globalThis.injectAllCSS = injectAllCSS;
    globalThis.updateAllStyles = updateAllStyles;
    globalThis.suppressAdblockWarnings = suppressAdblockWarnings;
    globalThis.removeLeftoverAdContainers = removeLeftoverAdContainers;
    globalThis.startObserver = startObserver;
    globalThis.onYTNavigate = onYTNavigate;
    globalThis.setWarningSelector = (val) => { WARNING_SELECTOR_COMBINED = val; };
    globalThis.setHideSelectors = (val) => { HIDE_SELECTORS = val; };
  }
})();
