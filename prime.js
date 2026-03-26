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
  '[data-testid="video-ad-label"]',
  '.ad-skipping',
  '.ad-interrupting',
  '.ad-showing',
  '.adSkipButton',
  '.skippable',
  '.atvwebplayersdk-player-container .ad-overlay',
  // Brittle but sometimes necessary fallbacks
  '.webPlayerUIContainer [tabindex="-1"] > div:nth-child(4) > div:nth-child(2)'
];

let targetVideo = null;
let lastAcceleratedSrc = null;
let adOverlay = null;

const CHROMA_PALETTE = [
  [255,   0,  85], [153,   0, 255], [  0, 136, 255], 
  [  0, 255, 136], [204, 255,   0], [255,  85,   0]
];
const CHROMA_CYCLE_MS = 8000;
let chromaClockRunning = false;

function notifyBackground(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch (_) {}
}

/**
 * Initializes the visual overlay for Prime Video.
 */
function initAdOverlay(video) {
  if (document.getElementById('prime-chroma-overlay')) return;
  
  adOverlay = document.createElement('div');
  adOverlay.id = 'prime-chroma-overlay';
  
  const spinner = document.createElement('div');
  spinner.className = 'chroma-spinner';
  
  const title = document.createElement('div');
  title.className = 'chroma-title';
  title.textContent = 'Chroma Active';
  
  const subtitle = document.createElement('div');
  subtitle.className = 'chroma-subtitle';
  subtitle.textContent = 'Accelerating Prime Ad...';
  
  adOverlay.appendChild(spinner);
  adOverlay.appendChild(title);
  adOverlay.appendChild(subtitle);

  const container = video.closest('.atvwebplayersdk-player-container, .webPlayerUIContainer') || video.parentElement;
  if (container && !container.contains(adOverlay)) {
    container.appendChild(adOverlay);
  }
}

/**
 * Updates the visual overlay state.
 */
function updateAdOverlay(video, isAdActive) {
  if (!CONFIG.acceleration || !isAdActive) {
    if (adOverlay && adOverlay.classList.contains('active')) {
      adOverlay.classList.remove('active');
    }
    return;
  }
  
  if (!adOverlay) {
    initAdOverlay(video);
  }

  const container = video.closest('.atvwebplayersdk-player-container, .webPlayerUIContainer') || video.parentElement;
  if (container && adOverlay && !container.contains(adOverlay)) {
    container.appendChild(adOverlay);
  }
  
  if (adOverlay && !adOverlay.classList.contains('active')) {
    adOverlay.classList.add('active');
  }
}

/**
 * Cycles through the chroma colors.
 */
function startChromaClock() {
  if (chromaClockRunning) return;
  chromaClockRunning = true;

  function tick() {
    if (!window._primeAdSessionActive) {
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

/**
 * Injects necessary CSS for the overlay.
 */
function injectChromaCSS() {
  if (document.getElementById('prime-chroma-styles')) return;
  const style = document.createElement('style');
  style.id = 'prime-chroma-styles';
  style.textContent = `
    #prime-chroma-overlay {
      position: absolute;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(10, 10, 12, 0.85);
      backdrop-filter: blur(15px);
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: white;
      font-family: 'Amazon Ember', Arial, sans-serif;
      opacity: 0;
      transition: opacity 0.3s ease;
      pointer-events: none;
    }
    #prime-chroma-overlay.active {
      opacity: 1;
      pointer-events: all;
    }
    .chroma-spinner {
      width: 50px; height: 50px;
      border: 4px solid rgba(255,255,255,0.1);
      border-top-color: var(--chroma-color, #ff0055);
      border-radius: 50%;
      animation: chroma-spin 1s linear infinite;
      margin-bottom: 25px;
    }
    @keyframes chroma-spin { 100% { transform: rotate(360deg); } }
    .chroma-title {
      font-size: 26px; font-weight: 700; margin-bottom: 10px;
      text-shadow: 0 4px 15px rgba(0,0,0,0.5);
    }
    .chroma-subtitle {
      font-size: 16px; color: #ccc;
      text-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
    
    /* Highlight Prime's skip buttons */
    body.chroma-prime-session .atvwebplayersdk-ad-skip-button,
    body.chroma-prime-session .adSkipButton,
    body.chroma-prime-session [class*="skip-button"] {
      border: 2px solid var(--chroma-color, #ff0055) !important;
      box-shadow: 0 0 20px var(--chroma-color-alpha, rgba(255,0,85,0.4)) !important;
      transition: border-color 0.2s, box-shadow 0.2s !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

/**
 * Checks for ad indicators using both CSS selectors and text-based heuristics.
 */
function isAdShowing() {
  // 1. Check CSS Selectors
  const adElement = document.querySelector(AD_SELECTORS.join(','));
  if (adElement && (adElement.offsetParent !== null || adElement.getClientRects().length > 0)) return true;

  // 2. Text-based detection in common overlay containers
  const overlayContainers = document.querySelectorAll('.atvwebplayersdk-overlays-container, .webPlayerUIContainer, .atvwebplayersdk-player-container');
  for (const container of overlayContainers) {
    const text = container.textContent || '';
    if (/\b(Ad|Sponsored|Advertisement|Annonce|Anzeige)\b/i.test(text)) {
      // Check if it's visible
      if (container.offsetParent !== null || container.getClientRects().length > 0) {
         return true;
      }
    }
  }

  return false;
}

/**
 * Finds the most likely active video element.
 */
function findActiveVideo() {
  const videos = Array.from(document.querySelectorAll('video'));
  if (videos.length === 0) return null;
  
  // Prefer visible videos with source
  const visibleVideos = videos.filter(v => (v.offsetParent !== null || v.getClientRects().length > 0) && (v.src || v.querySelector('source')));
  if (visibleVideos.length > 0) return visibleVideos[0];

  return videos[0];
}

function handlePrimeAdAcceleration() {
  if (!CONFIG.enabled || !CONFIG.acceleration) return;

  const rawAdShowing = isAdShowing();
  const video = findActiveVideo();
  
  if (!video) return;
  targetVideo = video;

  if (typeof window._primeAdSessionActive === 'undefined') window._primeAdSessionActive = false;

  if (rawAdShowing) {
    if (!window._primeAdSessionActive) {
      window._primeAdSessionActive = true;
      document.body.classList.add('chroma-prime-session');
      startChromaClock();
    }
    
    // Apply acceleration
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
    const skipButton = document.querySelector('.adSkipButton, .skippable, [class*="skip-button"], .atvwebplayersdk-ad-skip-button');
    if (skipButton && (skipButton.offsetParent !== null || skipButton.getClientRects().length > 0)) {
      skipButton.click();
    }
  } else {
    // Restore normal playback
    if (window._primeAdSessionActive) {
      video.playbackRate = 1;
      video.muted = false;
      window._primeAdSessionActive = false;
      document.body.classList.remove('chroma-prime-session');
      lastAcceleratedSrc = null;
    }
  }

  updateAdOverlay(video, window._primeAdSessionActive);
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
    if (!CONFIG.enabled || !CONFIG.acceleration) {
      if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
      }
      if (targetVideo && window._primeAdSessionActive) {
        targetVideo.playbackRate = 1;
        targetVideo.muted = false;
      }
      window._primeAdSessionActive = false;
      document.body.classList.remove('chroma-prime-session');
      if (adOverlay) adOverlay.classList.remove('active');
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
