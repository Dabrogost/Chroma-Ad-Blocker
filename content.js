/**
 * YT Shield - Content Script
 * Strategy 1: Ad-Acceleration (16x speed + mute) — detection-resistant
 * Strategy 2: Cosmetic Filtering — hides ad containers and sponsored slots
 * Strategy 3: Anti-Adblock Warning Suppression — removes overlay dialogs
 */

'use strict';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  accelerationSpeed: 16,
  checkIntervalMs: 300,
  cosmetic: true,
  acceleration: true,
  suppressWarnings: true,
};

// ─── STATE ────────────────────────────────────────────────────────────────────
let stats = { blocked: 0, accelerated: 0 };
let observer = null;

// ─── COSMETIC SELECTORS ──────────────────────────────────────────────────────
// Elements to hide: ad containers, sponsored slots, survey overlays
const HIDE_SELECTORS = [
  // In-video overlay ads
  '.ytp-ad-overlay-container',
  '.ytp-ad-overlay-slot',
  '.ytp-ad-text-overlay',
  '.ytp-ad-image-overlay',
  // Bottom banner ads during video
  '.ytp-ad-progress',
  '.ytp-ad-progress-list',
  // "Ad" label pill on thumbnail
  '.ytd-display-ad-renderer',
  'ytd-display-ad-renderer',
  // Masthead / homepage banner ads
  '#masthead-ad',
  'ytd-banner-promo-renderer',
  '#banner-ad',
  // Sidebar / right-rail ads
  '#player-ads',
  '.ytd-promoted-sparkles-web-renderer',
  'ytd-promoted-sparkles-web-renderer',
  '.ytd-promoted-video-renderer',
  'ytd-promoted-video-renderer',
  // In-feed sponsored items
  'ytd-search-pyv-renderer',
  'ytd-ad-slot-renderer',
  'ytd-in-feed-ad-layout-renderer',
  // Shorts ads
  'ytd-reel-shelf-renderer[is-ad]',
  // Survey / research panels
  '.ytd-mealbar-promo-renderer',
  'ytd-mealbar-promo-renderer',
  // Info cards that are ads
  '.ytp-suggested-action',
];

// Anti-adblock warning dialog selectors
const WARNING_SELECTORS = [
  // YouTube's native "Ad blockers are not allowed" modal
  'tp-yt-iron-overlay-backdrop',
  'ytd-enforcement-message-view-model',
  '.ytd-enforcement-message-view-model',
  '#header-ad-container',
  // Generic modal backdrop that freezes the page
  '.yt-playability-error-supported-renderers',
];

const WARNING_SELECTOR_COMBINED = WARNING_SELECTORS.join(',');

// ─── COSMETIC FILTERING ───────────────────────────────────────────────────────
function injectCosmeticCSS() {
  const style = document.createElement('style');
  style.id = 'yt-shield-cosmetic';
  style.textContent = `
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
    /* Ensure video player fills gap when sidebar ads are removed */
    #player-theater-container, #player-container-id {
      max-width: unset !important;
    }
    /* Remove "skip ad" button flicker – handled by acceleration */
    .ytp-ad-skip-button-container {
      display: none !important;
    }
    /* Hide "Visit advertiser" hover elements */
    .ytp-ad-visit-advertiser-button {
      display: none !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

// ─── ANTI-ADBLOCK WARNING SUPPRESSION ────────────────────────────────────────
function suppressAdblockWarnings(node) {
  if (!CONFIG.suppressWarnings) return;

  const els = (node || document).querySelectorAll(WARNING_SELECTOR_COMBINED);
  els.forEach(el => {
    el.remove();
    stats.blocked++;
  });

  // If the page has been paused by YouTube's enforcement overlay,
  // try to unpause the video
  const video = document.querySelector('video');
  if (video && video.paused) {
    // Only resume if we find an enforcement overlay was present
    const hasEnforcement = document.querySelector('ytd-enforcement-message-view-model');
    if (!hasEnforcement) {
      video.play().catch(() => {});
    }
  }

  // Remove body scroll lock that enforcement dialogs apply
  if (document.body) {
    document.body.style.removeProperty('overflow');
  }
}

// ─── AD ACCELERATION ─────────────────────────────────────────────────────────
/**
 * Core strategy: allow the ad to "play" but manipulate the media engine
 * to complete it in ~2 seconds instead of 30. This satisfies YouTube's
 * impression requirement without triggering the anti-adblock detection
 * that fires when a network request is blocked.
 */
function handleAdAcceleration() {
  if (!CONFIG.acceleration) return;

  const video = document.querySelector('video');
  if (!video) return;

  // Detect if we're in an ad by checking YouTube's own ad UI markers
  const adShowing =
    document.querySelector('.ad-showing') !== null ||
    document.querySelector('.ytp-ad-player-overlay') !== null ||
    document.querySelector('.ytp-ad-progress') !== null;

  if (adShowing) {
    // Mute and accelerate
    if (!video.muted) video.muted = true;
    if (video.playbackRate !== CONFIG.accelerationSpeed) {
      video.playbackRate = CONFIG.accelerationSpeed;
      stats.accelerated++;
      notifyBackground({ type: 'STAT_UPDATE', stats });
    }

    // Also try clicking the skip button if available (belt-and-suspenders)
    const skipBtn =
      document.querySelector('.ytp-skip-ad-button') ||
      document.querySelector('.ytp-ad-skip-button');
    if (skipBtn) skipBtn.click();

  } else {
    // Restore normal playback when ad ends
    if (video.muted && video.dataset.ytShieldMuted === 'true') {
      video.muted = false;
    }
    if (video.playbackRate === CONFIG.accelerationSpeed) {
      video.playbackRate = 1;
    }
  }

  // Tag the video element so we can restore mute state correctly
  if (adShowing) {
    video.dataset.ytShieldMuted = 'true';
  } else {
    delete video.dataset.ytShieldMuted;
  }
}

// ─── DOM OBSERVER ─────────────────────────────────────────────────────────────
/**
 * Watch for dynamically injected ad elements (YouTube is a SPA and
 * re-renders the DOM constantly during navigation).
 */
function startObserver() {
  if (observer) observer.disconnect();

  observer = new MutationObserver((mutations) => {
    if (mutations.some(m => m.addedNodes.length > 0)) {
      suppressAdblockWarnings();
      removeLeftoverAdContainers();
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

/**
 * Remove any ad containers that slipped through the CSS hiding
 * (e.g., elements with inline styles or dynamic class injection)
 */
function removeLeftoverAdContainers() {
  // Catch elements that have 'ad' in their ID but aren't in our static list
  const adElements = document.querySelectorAll(
    '[id*="ad-container"], [id*="ad_container"], [class*="ad-slot"]'
  );
  adElements.forEach(el => {
    if (el.id !== 'yt-shield-cosmetic') {
      el.style.display = 'none';
    }
  });
}

// ─── NAVIGATION HANDLING (SPA) ────────────────────────────────────────────────
/**
 * YouTube is a Single-Page App. We must re-run our checks after every
 * navigation event (yt-navigate-finish fires on each page transition).
 */
function onYTNavigate() {
  // Short delay to let YouTube render the new page's ad elements
  setTimeout(() => {
    suppressAdblockWarnings();
    removeLeftoverAdContainers();
  }, 500);

  setTimeout(() => {
    suppressAdblockWarnings();
    removeLeftoverAdContainers();
  }, 1500);
}

document.addEventListener('yt-navigate-finish', onYTNavigate);
document.addEventListener('yt-page-data-updated', onYTNavigate);

// ─── POLLING LOOP ─────────────────────────────────────────────────────────────
/**
 * The MutationObserver catches DOM changes, but the acceleration check
 * must poll because it tracks the <video> element's playback state.
 */
let pollingInterval = null;

function startPolling() {
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = setInterval(handleAdAcceleration, CONFIG.checkIntervalMs);
}

// ─── BACKGROUND COMMUNICATION ─────────────────────────────────────────────────
function notifyBackground(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch (_) {}
}

// Listen for config updates from the popup
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CONFIG_UPDATE') {
    Object.assign(CONFIG, msg.config);
    // Immediately apply acceleration config changes
    if (!CONFIG.acceleration) {
      clearInterval(pollingInterval);
    } else {
      startPolling();
    }
  }
  if (msg.type === 'GET_STATS') {
    return Promise.resolve(stats);
  }
});

// ─── INIT ─────────────────────────────────────────────────────────────────────
function init() {
  // 1. Inject cosmetic CSS immediately at document_start
  injectCosmeticCSS();

  // 2. Once DOM is ready, start the observer and polling
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      startObserver();
      startPolling();
      suppressAdblockWarnings();
    });
  } else {
    startObserver();
    startPolling();
    suppressAdblockWarnings();
  }
}

init();
