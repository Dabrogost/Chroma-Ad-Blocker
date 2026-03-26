/**
 * Chroma Ad-Blocker - Twitch Accelerator
 * Strategy: Ad-Acceleration (16x speed + mute)
 * Specifically tuned for Twitch.tv DOM structure.
 */

'use strict';

const CONFIG = {
  enabled: true,
  acceleration: true,
  accelerationSpeed: 16,
  checkIntervalMs: 300,
};

const MSG = {
  CONFIG_UPDATE: 'CONFIG_UPDATE',
  STATS_UPDATE: 'STATS_UPDATE'
};

const AD_SELECTORS = [
  '[data-a-target="video-ad-label"]',
  '.video-ad-label',
  '.tw-strong.tw-upcase.video-ad-label',
  '.video-ad-label--countdown'
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
 * Handler to enforce muting and zero volume during an ad session.
 */
const enforceMuteHandler = () => {
  if (isAdActive && targetVideo) {
    if (!targetVideo.muted) {
      targetVideo.muted = true;
    }
    if (targetVideo.volume > 0) {
      targetVideo.volume = 0;
    }
    // Twitch often pauses the video when it detects acceleration or buffer lag
    if (targetVideo.paused) {
      targetVideo.play().catch(() => {});
    }
  }
};

function handleTwitchAdAcceleration() {
  if (!CONFIG.enabled) return;

  // 1. Detect if an ad is showing based on UI labels
  const adLabel = document.querySelector(AD_SELECTORS.join(','));
  const rawAdShowing = !!adLabel;

  // 2. Find the video element
  const video = document.querySelector('video');
  if (!video) return;

  targetVideo = video;

  if (rawAdShowing) {
    if (!isAdActive) {
      isAdActive = true;
      // Start higher frequency check if needed, but for now we rely on listeners
    }

    // Attach listeners if not already present
    if (!video.dataset.chromaListenersAdded) {
      video.dataset.chromaListenersAdded = 'true';
      video.addEventListener('volumechange', enforceMuteHandler);
      video.addEventListener('play', enforceMuteHandler);
      video.addEventListener('pause', enforceMuteHandler);
    }

    // Ensure it's playing and muted
    if (video.paused) {
      video.play().catch(() => {});
    }
    if (!video.muted) {
      video.muted = true;
    }
    if (video.volume > 0) {
      video.volume = 0;
    }

    // Apply acceleration
    if (video.playbackRate !== CONFIG.accelerationSpeed) {
      video.playbackRate = CONFIG.accelerationSpeed;

      // Increment stats (once per unique ad source if possible)
      const currentSrc = video.src || 'twitch-ad';
      if (lastAcceleratedSrc !== currentSrc) {
        notifyBackground({ type: MSG.STATS_UPDATE, stats: { accelerated: 1 } });
        lastAcceleratedSrc = currentSrc;
      }
    }
  } else {
    // Restore normal playback if we were previously accelerating
    if (isAdActive) {
      video.playbackRate = 1;
      video.muted = false;
      isAdActive = false;
      lastAcceleratedSrc = null;

      // Note: We leave listeners attached to keep them warm for the next ad,
      // but enforceMuteHandler checks isAdActive.
    }
  }
}

// ─── POLLING & INITIALIZATION ────────────────────────────────────────────────
let pollingInterval = null;

function startPolling() {
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = setInterval(handleTwitchAdAcceleration, CONFIG.checkIntervalMs);
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
  globalThis.handleTwitchAdAcceleration = handleTwitchAdAcceleration;
}
