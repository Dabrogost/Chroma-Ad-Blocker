/**
 * Chroma Ad-Blocker - Amazon Prime Video Accelerator
 * Strategy: Ad-Acceleration (16x speed)
 * Specifically tuned for Prime Video's web player.
 */

'use strict';

const CONFIG = {
  enabled: true,
  acceleration: true,
  accelerationSpeed: 16,
  checkIntervalMs: 400,
};

const MSG = {
  CONFIG_UPDATE: 'CONFIG_UPDATE',
  STATS_UPDATE: 'STATS_UPDATE'
};

const AD_SELECTORS = [
  '.atvwebplayersdk-ad-container',
  '.atvwebplayersdk-ad-time-remaining',
  '.atvwebplayersdk-ad-indicator-text',
  '.atvwebplayersdk-ad-timer',
  '[data-testid="ad-indicator"]',
  '.ad-skipping',
  '.ad-interrupting',
  '.adSkipButton',
  '.skippable',
  // Brittle but sometimes necessary fallbacks
  '.webPlayerUIContainer [tabindex="-1"] > div:nth-child(4) > div:nth-child(2)'
];

let targetVideo = null;
let isAdActive = false;
let lastAcceleratedSrc = null;

function notifyBackground(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch (_) {}
}

/**
 * Checks for ad indicators using both CSS selectors and text-based heuristics.
 */
function isAdShowing() {
  // 1. Check CSS Selectors
  const adElement = document.querySelector(AD_SELECTORS.join(','));
  if (adElement && adElement.offsetParent !== null) return true;

  // 2. Text-based detection in common overlay containers
  const overlayContainer = document.querySelector('.atvwebplayersdk-overlays-container, .webPlayerUIContainer');
  if (overlayContainer) {
    const text = overlayContainer.textContent || '';
    // Look for common ad indicators in various languages if possible, but start with English
    if (/\b(Ad|Sponsored|Advertisement)\b/i.test(text)) {
      // Ensure it's not just a "Skip Ad" button (which we also count as ad showing)
      return true;
    }
  }

  return false;
}

/**
 * Finds the most likely active video element.
 * Prime Video may have multiple <video> tags; we want the one that is currently visible and playing.
 */
function findActiveVideo() {
  const videos = Array.from(document.querySelectorAll('video'));
  if (videos.length === 0) return null;
  if (videos.length === 1) return videos[0];

  // If multiple, find the one that is visible and has a source
  return videos.find(v => v.offsetParent !== null && (v.src || v.querySelector('source'))) || videos[0];
}

function handlePrimeAdAcceleration() {
  if (!CONFIG.enabled) return;

  const rawAdShowing = isAdShowing();
  const video = findActiveVideo();
  
  if (!video) return;
  targetVideo = video;

  if (rawAdShowing) {
    if (!isAdActive) {
      isAdActive = true;
    }

    // Apply acceleration
    // We use a high playbackRate to speed through the ad
    if (video.playbackRate !== CONFIG.accelerationSpeed) {
      video.playbackRate = CONFIG.accelerationSpeed;
      video.muted = true;
      video.volume = 0;

      // Increment stats
      const currentSrc = video.src || 'prime-ad';
      if (lastAcceleratedSrc !== currentSrc) {
        notifyBackground({ type: MSG.STATS_UPDATE, stats: { accelerated: 1 } });
        lastAcceleratedSrc = currentSrc;
      }
    }
    
    // Auto-click skip button if it appears
    const skipButton = document.querySelector('.adSkipButton, .skippable, [class*="skip-button"]');
    if (skipButton && skipButton.offsetParent !== null) {
      skipButton.click();
    }
  } else {
    // Restore normal playback
    if (isAdActive) {
      video.playbackRate = 1;
      video.muted = false;
      // We don't force volume back to 1.0 to respect user's previous setting if possible,
      // but Prime Video often mutes/unmutes automatically.
      isAdActive = false;
      lastAcceleratedSrc = null;
    }
  }
}

// ─── POLLING & INITIALIZATION ────────────────────────────────────────────────
let pollingInterval = null;

function startPolling() {
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = setInterval(handlePrimeAdAcceleration, CONFIG.checkIntervalMs);
}

function init() {
  chrome.storage.local.get('config').then(({ config: savedConfig }) => {
    if (savedConfig) {
      Object.assign(CONFIG, savedConfig);
    }
    if (CONFIG.enabled) {
      startPolling();
    }
  }).catch(() => {
    startPolling();
  });
}

// Listen for config updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === MSG.CONFIG_UPDATE) {
    Object.assign(CONFIG, msg.config);
    if (!CONFIG.enabled) {
      if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
      }
      if (targetVideo && isAdActive) {
        targetVideo.playbackRate = 1;
        targetVideo.muted = false;
      }
      isAdActive = false;
    } else {
      startPolling();
    }
  }
});

init();

// ─── TESTING EXPORTS ────────────────────────────────────────────────────────
if (typeof globalThis !== 'undefined' && globalThis.__TESTING__) {
  globalThis.CONFIG = CONFIG;
  globalThis.MSG = MSG;
  globalThis.handlePrimeAdAcceleration = handlePrimeAdAcceleration;
  globalThis.isAdShowing = isAdShowing;
  globalThis.findActiveVideo = findActiveVideo;
}
