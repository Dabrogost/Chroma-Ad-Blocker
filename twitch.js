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
let adOverlay = null;

const CHROMA_PALETTE = [
  [255,   0,  85], [153,   0, 255], [  0, 136, 255], 
  [  0, 255, 136], [204, 255,   0], [255,  85,   0]
];
const CHROMA_CYCLE_MS = 8000;
let chromaClockRunning = false;

function startChromaClock() {
  if (chromaClockRunning) return;
  chromaClockRunning = true;

  function tick() {
    if (!isAdActive) {
      chromaClockRunning = false;
      return;
    }

    const t = (Date.now() % CHROMA_CYCLE_MS) / CHROMA_CYCLE_MS;
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

function initAdOverlay() {
  if (document.getElementById('twitch-chroma-overlay')) return;
  
  adOverlay = document.createElement('div');
  adOverlay.id = 'twitch-chroma-overlay';
  
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

  const progressContainer = document.createElement('div');
  progressContainer.className = 'chroma-progress-container';
  const progressBar = document.createElement('div');
  progressBar.className = 'chroma-progress-bar';
  progressContainer.appendChild(progressBar);
  adOverlay.appendChild(progressContainer);

  const playerContainer = document.querySelector('.video-player__container') || document.querySelector('.highwind-video-player');
  if (playerContainer && !playerContainer.contains(adOverlay)) {
    playerContainer.appendChild(adOverlay);
  }
}

function updateAdOverlay(video, effectiveAdShowing) {
  if (!CONFIG.acceleration || !effectiveAdShowing) {
    if (adOverlay && adOverlay.classList.contains('active')) {
      adOverlay.classList.remove('active');
    }
    return;
  }
  
  if (!adOverlay) {
    initAdOverlay();
  }

  const playerContainer = video.closest('.video-player__container') || video.closest('.highwind-video-player') || video.parentElement;
  if (playerContainer && !playerContainer.contains(adOverlay)) {
    playerContainer.appendChild(adOverlay);
  }
  
  if (!adOverlay.classList.contains('active')) {
    adOverlay.classList.add('active');
  }

  const adLabel = document.querySelector(AD_SELECTORS.join(','));
  const subtitleEl = adOverlay.querySelector('.chroma-subtitle');
  if (subtitleEl && adLabel) {
    const labelText = adLabel.textContent.trim();
    if (labelText) {
      // Twitch labels often look like "Ad 1 of 2" or "Commercial Break"
      subtitleEl.textContent = labelText.includes('Ad') ? `Accelerating ${labelText}...` : 'Accelerating Ad...';
    }
  }

  const progressBar = adOverlay.querySelector('.chroma-progress-bar');
  if (progressBar && video && video.duration > 0) {
    const percent = Math.min((video.currentTime / video.duration) * 100, 100);
    progressBar.style.width = `${percent}%`;
  }
}

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
      startChromaClock();
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
    }
  }

  updateAdOverlay(video, isAdActive);
}

function injectChromaCSS() {
  if (document.getElementById('twitch-chroma-acceleration')) return;
  const style = document.createElement('style');
  style.id = 'twitch-chroma-acceleration';
  style.textContent = `
    #twitch-chroma-overlay {
      position: absolute;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(15, 15, 18, 0.85);
      backdrop-filter: blur(12px);
      z-index: 9999;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: white;
      font-family: Inter, Roboto, Arial, sans-serif;
      opacity: 0;
      transition: opacity 0.3s ease;
      pointer-events: none;
    }
    #twitch-chroma-overlay.active {
      opacity: 1;
      pointer-events: all;
    }
    .chroma-spinner {
      width: 50px; height: 50px;
      border: 4px solid rgba(255,255,255,0.1);
      border-top-color: var(--chroma-color, #ff0055);
      border-radius: 50%;
      animation: chroma-spin 1s linear infinite;
      margin-bottom: 24px;
      box-shadow: 0 0 15px var(--chroma-color-alpha, rgba(255,0,85,0.4));
    }
    @keyframes chroma-spin { 100% { transform: rotate(360deg); } }
    
    .chroma-title {
      font-size: 28px; font-weight: 700; margin-bottom: 8px;
      letter-spacing: -0.5px;
      text-shadow: 0 2px 15px rgba(0,0,0,0.5);
    }
    .chroma-subtitle {
      font-size: 16px; color: #adadb8;
      margin-bottom: 24px;
      text-shadow: 0 1px 4px rgba(0,0,0,0.5);
    }

    .chroma-progress-container {
      width: 60%; height: 4px;
      background: rgba(255,255,255,0.1);
      border-radius: 2px; overflow: hidden;
      margin-top: 10px;
    }
    .chroma-progress-bar {
      height: 100%; width: 0%;
      background: var(--chroma-color, #ff0055);
      transition: width 0.2s linear;
    }

    /* Target Twitch ad labels to highlight them */
    ${AD_SELECTORS.join(', ')} {
      border: 1px solid var(--chroma-color, #ff0055) !important;
      box-shadow: 0 0 10px var(--chroma-color-alpha, rgba(255,0,85,0.4)) !important;
      border-radius: 4px !important;
      padding: 0 4px !important;
      transition: all 0.2s ease !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
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
      injectChromaCSS();
      startPolling();
    }
  }).catch(() => {
    injectChromaCSS();
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
        if (adOverlay) adOverlay.classList.remove('active');
        isAdActive = false;
        lastAcceleratedSrc = null;
      }
    } else {
      injectChromaCSS();
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
