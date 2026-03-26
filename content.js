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
    checkIntervalMs: 300,
  };

  const isYouTube = window.location.hostname.includes('youtube.com');

  // ─── STATE ────────────────────────────────────────────────────────────────────
  let observer = null;

  // ─── COSMETIC SELECTORS ──────────────────────────────────────────────────────
  const HIDE_SELECTORS = [
    '.ytd-display-ad-renderer',
    'ytd-display-ad-renderer',
    '#masthead-ad',
    'ytd-banner-promo-renderer',
    '#banner-ad',
    '#player-ads',
    '.ytd-promoted-sparkles-web-renderer',
    'ytd-promoted-sparkles-web-renderer',
    '.ytd-promoted-video-renderer',
    'ytd-promoted-video-renderer',
    'ytd-search-pyv-renderer',
    'ytd-ad-slot-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-rich-item-renderer:has(ytd-ad-slot-renderer)',
    'ytd-rich-item-renderer:has(.ytd-ad-slot-renderer)',
    'ytd-rich-section-renderer:has(ytd-ad-slot-renderer)',
    'ytd-rich-section-renderer:has(.ytd-ad-slot-renderer)',
    'ytd-rich-item-renderer:has(#ad-badge)',
    'ytd-rich-section-renderer:has(#ad-badge)',
    'ytd-statement-banner-renderer',
    'ytd-video-masthead-ad-v3-renderer',
    'ytd-reel-shelf-renderer[is-ad]',
    '.ytd-mealbar-promo-renderer',
    'ytd-mealbar-promo-renderer',
    '.ytp-suggested-action',
    '.adbox.banner_ads.adsbox',
    '.textads',
    '.ad_unit',
    '.ad-server',
    '.ad-wrapper',
    '#ad-test',
    '.ad-test',
    '.advertisement',
    'img[src*="/ad/gif.gif"]',
    'img[src*="/ad/static.png"]',
    'img[src*="advmaker"]',
    'div[class*="advmaker"]',
    'a[href*="advmaker"]',
    '.advmaker',
    '#advmaker',
    '.ad-slot',
    '.ad-container',
    '.ads-by-google',
    '[id^="ad-"]',
    '[class^="ad-"]',
  ];

  const WARNING_SELECTORS = [
    'tp-yt-iron-overlay-backdrop',
    'ytd-enforcement-message-view-model',
    '.ytd-enforcement-message-view-model',
    '#header-ad-container',
    '.yt-playability-error-supported-renderers',
  ];

  const WARNING_SELECTOR_COMBINED = WARNING_SELECTORS.join(',');

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
            z-index: 9999999 !important;
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
      let styleEl = document.getElementById(styleDef.id);
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = styleDef.id;
        styleEl.textContent = styleDef.content;
        (document.head || document.documentElement).appendChild(styleEl);
      }
      styleEl.disabled = !styleDef.isEnabled();
    });
  }

  function updateAllStyles() {
    ['yt-chroma-cosmetic', 'yt-chroma-shorts', 'yt-chroma-merch', 'yt-chroma-offers'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        if (id === 'yt-chroma-cosmetic') el.disabled = !(CONFIG.enabled && CONFIG.cosmetic);
        if (id === 'yt-chroma-shorts') el.disabled = !(CONFIG.enabled && CONFIG.hideShorts);
        if (id === 'yt-chroma-merch') el.disabled = !(CONFIG.enabled && CONFIG.hideMerch);
        if (id === 'yt-chroma-offers') el.disabled = !(CONFIG.enabled && CONFIG.hideOffers);
      }
    });
  }

  // ─── ANTI-ADBLOCK WARNING SUPPRESSION ────────────────────────────────────────
  function suppressAdblockWarnings(nodes) {
    if (!CONFIG.enabled || !CONFIG.suppressWarnings) return;

    let removedAny = false;

    if (!nodes) {
      // Fallback for full document checks (e.g. init, navigation)
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

    if (removedAny) {
      const video = document.querySelector('video');
      if (video && video.paused) {
        video.play().catch(() => {});
      }
      if (document.body) {
        document.body.style.removeProperty('overflow');
      }
    }
  }

  // ─── DOM OBSERVER ─────────────────────────────────────────────────────────────
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

      // Handle ad-containers
      const processAdContainer = (el) => {
        if (el.id && el.id !== 'yt-chroma-cosmetic' && el.id !== 'yt-chroma-shorts' && el.id !== 'yt-chroma-merch' && el.id !== 'yt-chroma-offers' && !el.id.includes('masthead')) {
          el.style.display = 'none';
          el.remove();
        }
      };

      if (isElement && node.id && (node.id.includes('ad-container') || node.id.includes('ad_container'))) {
        processAdContainer(node);
      }
      if (typeof node.querySelectorAll === 'function') {
        node.querySelectorAll('[id*="ad-container"], [id*="ad_container"]').forEach(processAdContainer);
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
  function init() {
    injectAllCSS();

    chrome.storage.local.get('config').then(({ config: savedConfig }) => {
      if (savedConfig) {
        Object.assign(CONFIG, savedConfig);
        updateAllStyles();
      }
      
      if (CONFIG.enabled) {
        startObserver();
        suppressAdblockWarnings();
      }
    }).catch(err => {
      if (DEBUG) console.warn('[Chroma Ad-Blocker] Init config fetch failed, using defaults.', err);
      startObserver();
      suppressAdblockWarnings();
    });
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
  }
})();
