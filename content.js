/**
 * YT Chroma - Content Script
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

const isYouTube = window.location.hostname.includes('youtube.com');

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
  // Static / Empty Ad Containers
  '.ad-container',
  '.ad-div',
  '.video-ads.ytp-ad-module',
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
  // turtlecute test rules
  '.adbox.banner_ads.adsbox',
  '.textads',
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
  style.id = 'yt-chroma-cosmetic';
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

    /* Ad Acceleration Overlay */
    #yt-chroma-overlay {
      position: absolute;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(10, 10, 12, 0.85); /* deep dark base */
      backdrop-filter: blur(12px);
      z-index: 999999;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: white;
      font-family: 'YouTube Noto', Roboto, Arial, sans-serif;
      opacity: 0;
      transition: opacity 0.2s ease;
      pointer-events: none;
    }
    #yt-chroma-overlay.active {
      opacity: 1;
      pointer-events: all;
    }
    .chroma-spinner {
      width: 48px; height: 48px;
      border: 4px solid rgba(255,255,255,0.1);
      border-top-color: #ff0000;
      border-radius: 50%;
      animation: chroma-spin 1s linear infinite;
      margin-bottom: 20px;
    }
    @keyframes chroma-spin { 100% { transform: rotate(360deg); } }
    .chroma-title {
      font-size: 24px; font-weight: 600; margin-bottom: 8px;
      text-shadow: 0 2px 8px rgba(0,0,0,0.5);
    }
    .chroma-subtitle {
      font-size: 14px; color: #aaa; margin-bottom: 30px;
    }
    .chroma-progress-container {
      width: 60%; max-width: 400px; height: 6px;
      background: rgba(255,255,255,0.1);
      border-radius: 3px; overflow: hidden;
    }
    .chroma-progress-bar {
      height: 100%; width: 0%;
      background: #ff0000;
      transition: width 0.1s linear;
      box-shadow: 0 0 10px #ff0000;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

// ─── ANTI-ADBLOCK WARNING SUPPRESSION ────────────────────────────────────────
function suppressAdblockWarnings(node) {
  if (!CONFIG.suppressWarnings) return;

  const els = (node || document).querySelectorAll(WARNING_SELECTOR_COMBINED);
  const removedAny = els.length > 0;

  els.forEach(el => {
    el.remove();
    stats.blocked++;
  });

  // If the page has been paused by YouTube's enforcement overlay,
  // try to unpause the video
  const video = document.querySelector('video');
  if (video && video.paused) {
    // Only resume if we actually removed a warning overlay right now
    if (removedAny) {
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
let adOverlay = null;
let progressBar = null;

function initAdOverlay() {
  if (document.getElementById('yt-chroma-overlay')) return;
  
  adOverlay = document.createElement('div');
  adOverlay.id = 'yt-chroma-overlay';
  
  const spinner = document.createElement('div');
  spinner.className = 'chroma-spinner';
  
  const title = document.createElement('div');
  title.className = 'chroma-title';
  title.textContent = 'Chroma Active';
  
  const subtitle = document.createElement('div');
  subtitle.className = 'chroma-subtitle';
  subtitle.textContent = 'Accelerating Ad...';
  
  const progressContainer = document.createElement('div');
  progressContainer.className = 'chroma-progress-container';
  
  progressBar = document.createElement('div');
  progressBar.className = 'chroma-progress-bar';
  
  progressContainer.appendChild(progressBar);
  adOverlay.appendChild(spinner);
  adOverlay.appendChild(title);
  adOverlay.appendChild(subtitle);
  adOverlay.appendChild(progressContainer);
}

function updateAdOverlay(video, adShowing) {
  if (!CONFIG.acceleration || !adShowing) {
    if (adOverlay && adOverlay.classList.contains('active')) {
      adOverlay.classList.remove('active');
    }
    return;
  }
  
  if (!adOverlay) {
    initAdOverlay();
  }

  // Ensure it's attached to the video's parent container
  const playerContainer = video.closest('.html5-video-player') || video.parentElement;
  if (playerContainer && !playerContainer.contains(adOverlay)) {
    playerContainer.appendChild(adOverlay);
  }
  
  // Show it
  if (!adOverlay.classList.contains('active')) {
    adOverlay.classList.add('active');
  }
  
  // Update progress
  if (video && video.duration > 0) {
    const progressPercent = (video.currentTime / video.duration) * 100;
    if (progressBar) {
      progressBar.style.width = `${progressPercent}%`;
    }
  }
}

let cachedVideo = null;
function handleAdAcceleration() {
  if (!CONFIG.acceleration) return;

  // 1. Look for ANYTHING that looks like a skip or close button
  const skipButtons = document.querySelectorAll(
    '[class*="skip-button"], [class*="SkipButton"], .ytp-ad-overlay-close-button, .videoAdUiSkipButton'
  );

  skipButtons.forEach(btn => {
    // Only click if it's actually visible in the DOM
    if (btn.offsetParent !== null) { 
        btn.click();
    }
  });

  if (!cachedVideo || !document.contains(cachedVideo)) {
    cachedVideo = document.querySelector('video');
  }
  const video = cachedVideo;

  if (!video) return;

  // Detect if we're in an ad by checking YouTube's own ad UI markers
  // getElementsByClassName is significantly faster than querySelector
  const adShowing =
    document.getElementsByClassName('ad-showing').length > 0 ||
    document.getElementsByClassName('ytp-ad-player-overlay').length > 0 ||
    document.getElementsByClassName('ytp-ad-progress').length > 0;

  updateAdOverlay(video, adShowing);

  if (adShowing) {
    // Mute first, then accelerate on the next poll/tick to prevent audio bleeding
    if (!video.muted) {
      video.muted = true;
    } else if (video.playbackRate !== CONFIG.accelerationSpeed) {
      video.playbackRate = CONFIG.accelerationSpeed;
      stats.accelerated++;
      notifyBackground({ type: 'STAT_UPDATE', stats });
    }
  } else {
    // Restore normal playback when ad ends
    if (video.muted && video.dataset.ytChromaMuted === 'true') {
      video.muted = false;
    }
    if (video.playbackRate === CONFIG.accelerationSpeed) {
      video.playbackRate = 1;
    }
  }

  // Tag the video element so we can restore mute state correctly
  if (adShowing) {
    video.dataset.ytChromaMuted = 'true';
  } else {
    delete video.dataset.ytChromaMuted;
  }
}

// ─── DOM OBSERVER ─────────────────────────────────────────────────────────────
/**
 * Watch for dynamically injected ad elements (YouTube is a SPA and
 * re-renders the DOM constantly during navigation).
 */
function startObserver() {
  if (observer) observer.disconnect();

  let pendingFrame = false;

  observer = new MutationObserver((mutations) => {
    if (mutations.some(m => m.addedNodes.length > 0)) {
      if (!pendingFrame) {
        pendingFrame = true;
        requestAnimationFrame(() => {
          suppressAdblockWarnings();
          removeLeftoverAdContainers();
          pendingFrame = false;
        });
      }
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
    if (el.id !== 'yt-chroma-cosmetic' && !el.id.includes('masthead')) {
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

// ─── POLLING LOOP ─────────────────────────────────────────────────────────────
/**
 * The MutationObserver catches DOM changes, but the acceleration check
 * must poll because it tracks the <video> element's playback state.
 */
let pollingInterval = null;

function startPolling() {
  if (!isYouTube) return;
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

/**
 * Helper to start observer, polling and initial warning suppression.
 * Extracted to avoid duplication in init().
 */
function startExtensionServices() {
  startObserver();
  startPolling();
  suppressAdblockWarnings();
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
function init() {
  // 1. Inject cosmetic CSS immediately at document_start
  injectCosmeticCSS();

  // 2. Once DOM is ready, start the observer and polling
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startExtensionServices);
  } else {
    startExtensionServices();
  }
}

init();
