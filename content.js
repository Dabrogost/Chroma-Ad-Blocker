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
  blockPopUnders: true, // Default to true
  blockPushNotifications: true,
  enabled: true,
};

const isYouTube = window.location.hostname.includes('youtube.com');

// ─── STATE ────────────────────────────────────────────────────────────────────
let stats = { blocked: 0, accelerated: 0 };
let lastUserGestureTime = 0;
let lastUserGestureType = '';
let popupCountInGesture = 0;
let observer = null;

// ─── COSMETIC SELECTORS ──────────────────────────────────────────────────────
// Elements to hide: ad containers, sponsored slots, survey overlays
const HIDE_SELECTORS = [
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
  'ytd-rich-item-renderer:has(ytd-ad-slot-renderer)',
  'ytd-rich-item-renderer:has(.ytd-ad-slot-renderer)',
  'ytd-rich-section-renderer:has(ytd-ad-slot-renderer)',
  'ytd-rich-section-renderer:has(.ytd-ad-slot-renderer)',
  'ytd-rich-item-renderer:has(#ad-badge)',
  'ytd-rich-section-renderer:has(#ad-badge)',
  'ytd-statement-banner-renderer',
  'ytd-video-masthead-ad-v3-renderer',
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
  // Common ad-block test selectors
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

// Optimized ID-based ad container patterns
const AD_ID_PATTERNS = [
  '[id*="ad-container"]',
  '[id*="ad_container"]'
];
const AD_ID_SELECTOR_COMBINED = AD_ID_PATTERNS.join(',');

// Optimized slot-based ad container patterns
const AD_SLOT_SELECTORS = [
  'ytd-ad-slot-renderer',
  '.ytd-ad-slot-renderer',
  '#ad-badge'
];
const AD_SLOT_SELECTOR_COMBINED = AD_SLOT_SELECTORS.join(',');

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
    /* Elevate native "skip ad" buttons and their parent stacking wrappers above our Chroma overlay */
    .ytp-ad-player-overlay,
    .ytp-ad-player-overlay-instream-info,
    .ytp-ad-skip-button-container, 
    .ytp-ad-skip-button-slot,
    .ytp-skip-ad-button, 
    .videoAdUiSkipButton,
    [id^="skip-button:"] {
      z-index: 9999999 !important;
    }

    /* Chroma glow on skip-ad buttons during an active ad session */
    body.chroma-session-active .ytp-ad-skip-button-container,
    body.chroma-session-active .ytp-ad-skip-button-slot,
    body.chroma-session-active .ytp-skip-ad-button,
    body.chroma-session-active .videoAdUiSkipButton,
    body.chroma-session-active [id^="skip-button:"] {
      border: 1.5px solid var(--chroma-color, #ff0055) !important;
      border-radius: 24px !important;
      box-shadow: 0 0 15px var(--chroma-color-alpha, rgba(255,0,85,0.4)), 
                  inset 0 0 6px var(--chroma-color-alpha, rgba(255,0,85,0.2)) !important;
      transition: border-color 0.15s linear, box-shadow 0.15s linear !important;
      overflow: hidden !important;
    }
    
    /* Allow user to access video controls (fullscreen, etc) through the overlay */
    .ytp-chrome-bottom {
      z-index: 9999999 !important;
    }
    
    /* Force the control bar to stay visible even if the mouse stops moving */
    body.chroma-session-active .html5-video-player.ytp-autohide .ytp-chrome-bottom,
    body.chroma-session-active .html5-video-player .ytp-chrome-bottom {
      opacity: 1 !important;
      visibility: visible !important;
    }
    
    /* Completely hide YouTube's native ad progress indicators during our sequence */
    body.chroma-session-active .ytp-play-progress,
    body.chroma-session-active .ytp-load-progress,
    body.chroma-session-active .ytp-ad-progress-list,
    body.chroma-session-active .ytp-hover-progress {
      opacity: 0 !important;
      visibility: hidden !important;
    }

    /* Our custom replacement progress bar injected into the native control bar */
    .chroma-native-progress {
      display: none;
      position: absolute;
      bottom: 0; left: 0; height: 3px;
      z-index: 50;
      background: var(--chroma-color, #ff0055);
      transition: width 0.1s linear, height 0.1s ease, background 0.15s linear;
      pointer-events: none;
    }
    .ytp-chrome-bottom:hover .chroma-native-progress,
    .ytp-progress-bar-container:hover .chroma-native-progress {
      height: 5px;
    }
    body.chroma-session-active .chroma-native-progress {
      display: block;
    }
    


    /* Ad Acceleration Overlay */
    #yt-chroma-overlay {
      position: absolute;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(15, 15, 18, 0.8); /* base */
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
      border-top-color: var(--chroma-color, #ff0055);
      border-radius: 50%;
      animation: chroma-spin 1s linear infinite;
      transition: border-top-color 0.15s linear;
      margin-bottom: 20px;
    }
    @keyframes chroma-spin { 100% { transform: rotate(360deg); } }
    
    /* chroma-border and chroma-all-borders removed — driven by --chroma-color */

    .chroma-checkmark {
      width: 48px; height: 48px;
      border: 4px solid var(--chroma-color, #ff0055);
      border-radius: 50%;
      margin-bottom: 20px;
      z-index: 2;
      transition: border-color 0.15s linear;
      position: relative;
    }
    .chroma-checkmark::after {
      content: '';
      position: absolute;
      top: 6px; left: 16px;
      width: 10px; height: 20px;
      border: solid var(--chroma-color, #ff0055);
      border-width: 0 4px 4px 0;
      transform: rotate(45deg);
      transition: border-color 0.15s linear;
    }
    
    /* chroma-bg removed — driven by --chroma-color */

    .chroma-title {
      font-size: 24px; font-weight: 600; margin-bottom: 8px;
      text-shadow: 0 2px 12px rgba(0,0,0,0.8);
      z-index: 2;
    }
    .chroma-subtitle {
      font-size: 15px; color: #eee;
      position: absolute;
      bottom: 18%;
      text-shadow: 0 1px 4px rgba(0,0,0,0.5);
      z-index: 2;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
  updateCosmeticState();
}

function updateCosmeticState() {
  const style = document.getElementById('yt-chroma-cosmetic');
  if (style) {
    style.disabled = !(CONFIG.enabled && CONFIG.cosmetic);
  }
}

// ─── ANTI-ADBLOCK WARNING SUPPRESSION ────────────────────────────────────────
function suppressAdblockWarnings(root = document) {
  if (!CONFIG.enabled || !CONFIG.suppressWarnings) return;

  // 1. If the root itself is a target, remove it
  if (root !== document && typeof root.matches === 'function' && root.matches(WARNING_SELECTOR_COMBINED)) {
    root.remove();
    stats.blocked++;
    return;
  }

  // 2. Otherwise, check children
  const els = root.querySelectorAll(WARNING_SELECTOR_COMBINED);
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
  
  adOverlay.appendChild(spinner);
  adOverlay.appendChild(title);
  adOverlay.appendChild(subtitle);

  // Eagerly attach to the player container if available
  const playerContainer = document.querySelector('.html5-video-player') || document.querySelector('#movie_player');
  if (playerContainer && !playerContainer.contains(adOverlay)) {
    playerContainer.appendChild(adOverlay);
  }
}

function updateAdOverlay(video, effectiveAdShowing, rawAdShowing) {
  if (!CONFIG.acceleration || !effectiveAdShowing) {
    if (adOverlay && adOverlay.classList.contains('active')) {
      adOverlay.classList.remove('active');
      window.cachedCurrentAd = 1;
      window.cachedTotalAds = 1;
      window.lastVideoDuration = 0;
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
  
  if (!adOverlay.classList.contains('active')) {
    adOverlay.classList.add('active');
  }
  
  if (typeof window.cachedCurrentAd === 'undefined') {
    window.cachedCurrentAd = 1;
    window.cachedTotalAds = 1;
    window.lastVideoDuration = 0;
  }

  // We only parse DOM and increment trackers if an ad is actively showing
  if (rawAdShowing) {
    if (video && video.duration > 0) {
      if (window.lastVideoDuration > 0 && Math.abs(video.duration - window.lastVideoDuration) > 1) {
        if (window.cachedCurrentAd < window.cachedTotalAds) {
          window.cachedCurrentAd++;
        }
      }
      window.lastVideoDuration = video.duration;
    }

    if (playerContainer) {
      const playerText = playerContainer.textContent || '';
      const parsedTextMatch = playerText.match(/(?:[^\d]|^)([1-9])\s*(?:of|de|sur|out of|von|di)\s*([2-9])(?:[^\d]|$)/i);
      if (parsedTextMatch) {
        const parsedCurrent = parseInt(parsedTextMatch[1], 10);
        const parsedTotal = parseInt(parsedTextMatch[2], 10);
        if (parsedTotal > 1 && parsedCurrent <= parsedTotal) {
          window.cachedCurrentAd = Math.max(window.cachedCurrentAd, parsedCurrent);
          window.cachedTotalAds = Math.max(window.cachedTotalAds, parsedTotal);
        }
      }
    }
  }

  const isOnFinalAd = window.cachedCurrentAd >= window.cachedTotalAds;
  // YouTube often hangs at the absolute end of the ad (currentTime === duration) for a network timeout
  // before switching rawAdShowing to false. We detect this to show the 'Ads Cleared' checkmark earlier.
  const isAdMediaFinished = video && video.duration > 0 && (video.duration - video.currentTime < 0.5);
  
  const isAdsDone = (isOnFinalAd && (!rawAdShowing || isAdMediaFinished)) || window.chromaAdSkipped;
  
  const spinner = adOverlay.querySelector('.chroma-spinner, .chroma-checkmark');
  const titleEl = adOverlay.querySelector('.chroma-title');
  const subtitleEl = adOverlay.querySelector('.chroma-subtitle');

  if (isAdsDone) {
    // Morph spinner cleanly into an animated checkmark when ad payload is defeated
    if (spinner && spinner.className !== 'chroma-checkmark') spinner.className = 'chroma-checkmark';
    if (titleEl) titleEl.textContent = 'Ads Cleared';
    if (subtitleEl) subtitleEl.textContent = 'Loading Video...';
    
    // Snap bottom bar to 100% cleanly
    const nativeProgressBar = document.querySelector('.chroma-native-progress');
    if (nativeProgressBar) nativeProgressBar.style.width = '100%';
  } else {
    if (spinner && spinner.className !== 'chroma-spinner') spinner.className = 'chroma-spinner';
    if (titleEl) titleEl.textContent = 'Chroma Active';
    
    if (subtitleEl) {
      if (window.cachedTotalAds > 1) {
        subtitleEl.textContent = `Accelerating Ad (${window.cachedCurrentAd} of ${window.cachedTotalAds})...`;
      } else {
        subtitleEl.textContent = 'Accelerating Ad...';
      }
    }

    // Update dynamically calculated progress mapping only while ad is live
    if (video && video.duration > 0 && rawAdShowing) {
      let videoPercent = (video.currentTime / video.duration) * 100;
      if (videoPercent > 100) videoPercent = 100;
      
      let totalPercent = videoPercent;
      if (window.cachedTotalAds > 1 && window.cachedCurrentAd <= window.cachedTotalAds) {
        const segmentSize = 100 / window.cachedTotalAds;
        const basePercent = (window.cachedCurrentAd - 1) * segmentSize;
        totalPercent = basePercent + (videoPercent / window.cachedTotalAds);
      }
      
      const nativeProgressBar = document.querySelector('.chroma-native-progress');
      if (nativeProgressBar) nativeProgressBar.style.width = `${totalPercent}%`;
    }
  }
}

let cachedVideo = null;
function handleAdAcceleration() {
  if (!CONFIG.enabled || !CONFIG.acceleration) return;

  // Auto-clicking of skip buttons has been removed per user request.
  // The buttons remain elevated via CSS to allow manual user skipping.

  if (!cachedVideo || !document.contains(cachedVideo)) {
    cachedVideo = document.querySelector('video');
  }
  const video = cachedVideo;

  if (!video) return;

  // Detect if we're in an ad by checking YouTube's own ad UI markers
  // getElementsByClassName is significantly faster than querySelector
  let rawAdShowing =
    document.getElementsByClassName('ad-showing').length > 0 ||
    document.getElementsByClassName('ytp-ad-player-overlay').length > 0 ||
    document.getElementsByClassName('ytp-ad-progress').length > 0 ||
    document.getElementsByClassName('ytp-ad-player-overlay-layout').length > 0 ||
    document.getElementsByClassName('ytp-ad-player-overlay-skip-or-preview').length > 0 ||
    document.querySelector('.html5-video-player.ad-showing') !== null ||
    document.querySelector('[class*="ytp-ad-persistent-progress-bar"]') !== null ||
    document.querySelector('.ytp-ad-module .ytp-ad-player-overlay') !== null ||
    document.querySelector('div.video-ads.ytp-ad-module') !== null ||
    document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-container, .ytp-ad-skip-button-slot, .ytp-ad-skip-button-modern') !== null ||
    document.querySelector('.ytp-ad-text, .ytp-ad-preview-text, .ytp-ad-simple-ad-badge, .ytp-ad-badge-label') !== null ||
    (video && video.closest('.html5-video-player')?.classList?.contains('ad-showing'));

  // Fallback: detect ad by YouTube's own ad UI text/badge elements
  if (!rawAdShowing) {
    const adText = document.querySelector(
      '.ytp-ad-simple-ad-badge, .ytp-ad-duration-remaining, .ytp-ad-text, .ytp-ad-preview-text, .ytp-ad-visit-advertiser-button'
    );
    if (adText) rawAdShowing = true;
  }

  if (typeof window.chromaAdSkipped === 'undefined') window.chromaAdSkipped = false;
  if (typeof window.chromaAdSessionActive === 'undefined') window.chromaAdSessionActive = false;
  
  if (rawAdShowing) {
    if (!window.chromaAdSessionActive) {
      console.log('[YT Chroma] Ad Session Detected');
      window.chromaAdSkipped = false; // Reset skip state for new session
      startFastAdWatcher(); // Start higher frequency loop during ads
    }
    window.chromaAdSessionActive = true;
    window.lastAdDetectTime = Date.now();
  }

  // The overlay definitively ends when the real video stream successfully buffers to level 3 (HAVE_FUTURE_DATA)
  if (!rawAdShowing) {
    const timeSinceAd = Date.now() - window.lastAdDetectTime;
    if (timeSinceAd > 500) {
      const isMainVideoReady = video && video.readyState >= 3 && !video.paused && video.currentTime > 0;
      if (isMainVideoReady || timeSinceAd > 5000) {
        window.chromaAdSessionActive = false; // Graceful handoff to the actual stream
      }
    }
  }
  
  if (window.chromaAdSessionActive) {
    document.body.classList.add('chroma-session-active');
    // Inject the replacement native scrub bar into the real control bar
    let nativeProgressBar = document.querySelector('.chroma-native-progress');
    if (!nativeProgressBar) {
      const ytpProgressBar = document.querySelector('.ytp-progress-bar');
      if (ytpProgressBar) {
        nativeProgressBar = document.createElement('div');
        nativeProgressBar.className = 'chroma-native-progress';
        ytpProgressBar.appendChild(nativeProgressBar);
      }
    }
  } else {
    document.body.classList.remove('chroma-session-active');
  }

  updateAdOverlay(video, window.chromaAdSessionActive, rawAdShowing);

  // Instantly attach fast event listeners if we haven't already
  if (!video.dataset.chromaListenersAdded) {
    video.dataset.chromaListenersAdded = 'true';
    const enforceMuteHandler = () => {
      if (window.chromaAdSessionActive) {
        if (!video.muted) {
          video.muted = true;
        }
        if (video.volume > 0) {
          video.volume = 0;
        }
      }
    };
    // Intercept spontaneous unmuting by YouTube between our poll intervals
    video.addEventListener('volumechange', enforceMuteHandler);
    video.addEventListener('play', enforceMuteHandler);
  }

  // Tie muting directly to the overlay's overarching active session
  if (window.chromaAdSessionActive) {
    if (!video.muted) {
      video.muted = true;
    }
    if (video.volume > 0) {
      if (!video.dataset.ytChromaVolume) {
        video.dataset.ytChromaVolume = video.volume;
      }
      video.volume = 0;
    }
    
    // Perform actual acceleration only if an ad is actively playing
    if (rawAdShowing && video.playbackRate !== CONFIG.accelerationSpeed) {
      video.playbackRate = CONFIG.accelerationSpeed;
      // Increment stats ONLY once per unique ad to prevent spikes if YouTube fights the playback rate
      if (window.lastAcceleratedSrc !== video.src) {
        stats.accelerated++;
        notifyBackground({ type: 'STAT_UPDATE', stats });
        window.lastAcceleratedSrc = video.src;
      }
    }
  } else if (!window.chromaAdSessionActive) {
    // Restore normal playback only if the entire ad break and overlay session are TRULY over
    if (video.muted && video.dataset.ytChromaMuted === 'true') {
      video.muted = false;
    }
    if (video.dataset.ytChromaVolume !== undefined) {
      const restoredVol = parseFloat(video.dataset.ytChromaVolume);
      if (restoredVol > 0) {
        video.volume = restoredVol;
      }
      delete video.dataset.ytChromaVolume;
    }
    if (video.playbackRate === CONFIG.accelerationSpeed) {
      video.playbackRate = 1;
    }
  }

  // Tag the video element so we can restore mute state correctly
  if (window.chromaAdSessionActive) {
    video.dataset.ytChromaMuted = 'true';
  } else if (!window.chromaAdSessionActive) {
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
  let addedElements = new Set();

  observer = new MutationObserver((mutations) => {
    let hasNewNodes = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1) { // Node.ELEMENT_NODE
          addedElements.add(node);
          hasNewNodes = true;
        }
      }
    }

    if (hasNewNodes) {
      if (!pendingFrame) {
        pendingFrame = true;
        requestAnimationFrame(() => {
          // Process collected elements
          addedElements.forEach(el => {
            if (document.contains(el)) {
              suppressAdblockWarnings(el);
              removeLeftoverAdContainers(el);
            }
          });
          addedElements.clear();

          // Also check for the player container if we haven't attached the overlay yet
          if (!document.getElementById('yt-chroma-overlay')) {
            initAdOverlay();
          }
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
function removeLeftoverAdContainers(root = document) {
  // 1. Precise element-based removal for elements with 'ad' in their ID
  if (root !== document && typeof root.matches === 'function' && root.matches(AD_ID_SELECTOR_COMBINED)) {
    if (root.id !== 'yt-chroma-cosmetic' && !root.id.includes('masthead')) {
      root.style.display = 'none';
      root.remove();
      return;
    }
  }

  const adIds = root.querySelectorAll(AD_ID_SELECTOR_COMBINED);
  adIds.forEach(el => {
    if (el.id !== 'yt-chroma-cosmetic' && !el.id.includes('masthead')) {
      el.style.display = 'none';
      el.remove(); // Safely remove to collapse grid
    }
  });

  // 2. Parent-container removal for ad slots that the CSS engine might have missed
  if (root !== document && typeof root.matches === 'function' && root.matches(AD_SLOT_SELECTOR_COMBINED)) {
    handleAdSlotRemoval(root);
    return;
  }

  const adSlots = root.querySelectorAll(AD_SLOT_SELECTOR_COMBINED);
  adSlots.forEach(slot => {
    handleAdSlotRemoval(slot);
  });
}

/**
 * Helper to handle the specific removal logic for ad slot renderers
 */
function handleAdSlotRemoval(slot) {
  const parent = slot.closest('ytd-rich-item-renderer, ytd-rich-section-renderer');
  if (parent) {
    parent.style.display = 'none';
    parent.remove();
  } else {
    // For sidebar or other sections, just hide the slot itself to preserve siblings
    slot.style.display = 'none';
    if (!slot.closest('#secondary')) { // Don't remove from sidebar, just hide
      slot.remove();
    }
  }
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

// ─── POP-UNDER PROTECTION ──────────────────────────────────────────────────
/**
 * Monitor user gestures (clicks) to distinguish between legitimate
 * user-initiated popups and automated pop-under ads.
 */
function initPopUnderProtection() {
  // Track last click/interaction time with broader event coverage
  const updateGesture = (e) => {
    const now = Date.now();
    // If this is a new gesture (more than 300ms since last), reset popup count
    if (now - lastUserGestureTime > 300) {
      popupCountInGesture = 0;
    }
    lastUserGestureTime = now;
    lastUserGestureType = e.type;
  };
  
  ['mousedown', 'mouseup', 'keydown', 'touchstart', 'touchend', 'click'].forEach(evt => {
    document.addEventListener(evt, updateGesture, { capture: true, passive: true });
    window.addEventListener(evt, updateGesture, { capture: true, passive: true });
  });

  // Intercept link clicks that might open new windows
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (link && (link.target === '_blank' || e.ctrlKey || e.shiftKey || e.metaKey)) {
      // If it's a suspicious link (e.g., hidden, overlay-like), we could flag it
      const rect = link.getBoundingClientRect();
      const isTiny = rect.width < 5 || rect.height < 5;
      const isOverlay = rect.width > window.innerWidth * 0.9 && rect.height > window.innerHeight * 0.9;
      
      if (isTiny || isOverlay) {
        console.warn('[YT Chroma] Suspicious link click detected:', link.href);
      }
    }
  }, { capture: true, passive: true });

  // Listen for messages from the MAIN world (main-world.js)
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'yt-chroma-main-world') return;

    if (event.data.type === 'WINDOW_OPEN_ATTEMPT') {
      const now = Date.now();
      const timeSinceGesture = now - lastUserGestureTime;
      
      // A popup is suspicious if:
      // 1. It's too long after a gesture (> 300ms)
      // 2. It's the 2nd or further popup in a single gesture
      // 3. The gesture was a mousemove or something non-specific (though we only track specific ones)
      
      popupCountInGesture++;
      
      const isSuspicious = timeSinceGesture > 300 || popupCountInGesture > 1;

      // Notify background script about the attempt
      notifyBackground({
        type: 'WINDOW_OPEN_NOTIFY',
        url: event.data.url,
        isSuspicious,
        timeSinceGesture,
        popupCount: popupCountInGesture,
        gestureType: lastUserGestureType,
        stack: event.data.stack
      });
    }

    if (event.data.type === 'SUSPICIOUS_FOCUS_ATTEMPT' || event.data.type === 'SUSPICIOUS_BLUR_ATTEMPT') {
      console.log(`[YT Chroma] Blocked suspicious pop-under attempt (${event.data.type})`);
      notifyBackground({
        type: 'SUSPICIOUS_ACTIVITY',
        activity: event.data.type,
        context: event.data.context
      });
    }

    if (event.data.type === 'NOTIFICATION_ATTEMPT') {
      // Handle notification attempts (stat tracking)
      stats.blocked++;
      notifyBackground({ type: 'STAT_UPDATE', stats });
    }
  });
}

/**
 * Signals the main-world.js script whether push notification blocking
 * should be active.
 */
function signalMainWorld() {
  if (CONFIG.enabled && CONFIG.blockPushNotifications) {
    document.documentElement.dataset.ytChromaPushActive = 'true';
  } else {
    delete document.documentElement.dataset.ytChromaPushActive;
  }
}

// ─── BACKGROUND COMMUNICATION ─────────────────────────────────────────────────
function notifyBackground(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch (_) {}
}

// Listen for config updates from the popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CONFIG_UPDATE') {
    Object.assign(CONFIG, msg.config);
    // Immediately apply config changes
    if (!CONFIG.enabled || !CONFIG.acceleration) {
      if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
      }
    } else {
      startPolling();
    }

    if (!CONFIG.enabled) {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
    } else {
      startObserver();
    }

    updateCosmeticState();
    signalMainWorld();
  }
  if (msg.type === 'GET_STATS') {
    sendResponse(stats);
    return true;
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
  signalMainWorld();
  startChromaClock();
  initSkipButtonListener();
  initAdOverlay();
}

/**
 * Delegated listener for the "Skip Ad" button to update our overlay state
 * immediately when the user interacts with it.
 */
function initSkipButtonListener() {
  document.addEventListener('click', (e) => {
    // Only care if an ad session is actually active
    if (!window.chromaAdSessionActive) return;
    
    // Safety check for e.target
    if (!e || !e.target || typeof e.target.closest !== 'function') return;

    try {
      // Check if the click target or its ancestors match YouTube's skip button selectors
      const skipButton = e.target.closest([
        '.ytp-ad-skip-button-container',
        '.ytp-ad-skip-button-slot',
        '.ytp-skip-ad-button',
        '.videoAdUiSkipButton',
        '[id^="skip-button:"]'
      ].join(','));

      if (skipButton) {
        window.chromaAdSkipped = true;
        // Force an immediate UI update if we have the video element
        if (cachedVideo) {
          const rawAdShowing = document.getElementsByClassName('ad-showing').length > 0;
          updateAdOverlay(cachedVideo, true, rawAdShowing);
        }
      }
    } catch (err) {
      console.warn('[YT Chroma] Error in skip button listener:', err);
    }
  }, true);
}

/**
 * High-frequency watcher that runs only during active ad sessions
 * to catch quick transitions or late-rendering ad elements.
 */
function startFastAdWatcher() {
  if (window._chromaFastWatcher) return;
  window._chromaFastWatcher = true;

  function check() {
    if (!window.chromaAdSessionActive) {
      window._chromaFastWatcher = false;
      return;
    }
    handleAdAcceleration();
    requestAnimationFrame(check);
  }
  requestAnimationFrame(check);
}

// ─── CHROMA COLOR CLOCK ────────────────────────────────────────────────────────
/**
 * Drives a single --chroma-color CSS variable from a global time base
 * so every chroma element (spinner, checkmark, progress bar, skip glow)
 * is perfectly phase-locked.
 */
const CHROMA_PALETTE = [
  [255,   0,  85],  // #ff0055
  [153,   0, 255],  // #9900ff
  [  0, 136, 255],  // #0088ff
  [  0, 255, 136],  // #00ff88
  [204, 255,   0],  // #ccff00
  [255,  85,   0],  // #ff5500
];
const CHROMA_CYCLE_MS = 8000;
let chromaClockRunning = false;

function startChromaClock() {
  if (chromaClockRunning) return;
  chromaClockRunning = true;

  function tick() {
    const t = (Date.now() % CHROMA_CYCLE_MS) / CHROMA_CYCLE_MS; // 0 → 1
    const segCount = CHROMA_PALETTE.length;
    const raw = t * segCount;
    const idx = Math.floor(raw) % segCount;
    const frac = raw - Math.floor(raw);
    const next = (idx + 1) % segCount;

    const r = Math.round(CHROMA_PALETTE[idx][0] + (CHROMA_PALETTE[next][0] - CHROMA_PALETTE[idx][0]) * frac);
    const g = Math.round(CHROMA_PALETTE[idx][1] + (CHROMA_PALETTE[next][1] - CHROMA_PALETTE[idx][1]) * frac);
    const b = Math.round(CHROMA_PALETTE[idx][2] + (CHROMA_PALETTE[next][2] - CHROMA_PALETTE[idx][2]) * frac);

    const root = document.documentElement;
    root.style.setProperty('--chroma-color', `rgb(${r},${g},${b})`);
    root.style.setProperty('--chroma-color-alpha', `rgba(${r},${g},${b},0.3)`);

    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
function init() {
  // 0. Signal main world as early as possible
  signalMainWorld();

  // 1. Inject cosmetic CSS immediately at document_start
  injectCosmeticCSS();

  // 2. Start protection scripts immediately to catch early gestures
  initPopUnderProtection();

  // 3. Once DOM is ready, start the observer and polling
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      startExtensionServices();
    });
  } else {
    startExtensionServices();
  }
}

init();
