/**
 * Chroma Ad-Blocker - Twitch Accelerator
 * Strategy: Ad-Acceleration (10x speed + mute)
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
  '[data-a-target="ad-video-countdown"]',
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
  
  const contentBox = document.createElement('div');
  contentBox.className = 'chroma-content-box';
  
  const spinner = document.createElement('div');
  spinner.className = 'chroma-spinner';
  
  const title = document.createElement('div');
  title.className = 'chroma-title';
  title.textContent = 'Chroma Active';
  
  const subtitle = document.createElement('div');
  subtitle.className = 'chroma-subtitle';
  subtitle.textContent = 'Accelerating Ad...';

  contentBox.appendChild(spinner);
  contentBox.appendChild(title);
  contentBox.appendChild(subtitle);
  
  adOverlay.appendChild(contentBox);

  const playerContainer = document.querySelector('.video-player__container') || document.querySelector('.highwind-video-player');
  if (playerContainer && !playerContainer.contains(adOverlay)) {
    playerContainer.appendChild(adOverlay);
  }
}

function updateAdOverlay(video, effectiveAdShowing) {
  try {
    const existingOverlay = document.getElementById('twitch-chroma-overlay');
    
    if (!CONFIG.acceleration || !effectiveAdShowing) {
      if (existingOverlay) existingOverlay.classList.remove('active');
      return;
    }
    
    adOverlay = existingOverlay;
    if (!adOverlay) {
      initAdOverlay();
      adOverlay = document.getElementById('twitch-chroma-overlay');
    }
    if (!adOverlay) return;

    const container = video?.closest('.video-player__container') || 
                    video?.closest('.highwind-video-player') || 
                    document.querySelector('.video-player__container') || 
                    document.querySelector('.highwind-video-player');

    if (container && !container.contains(adOverlay)) {
      container.appendChild(adOverlay);
    }
    
    adOverlay.classList.add('active');

    // Update subtitle
    const adLabel = document.querySelector(AD_SELECTORS.join(','));
    const subtitleEl = adOverlay.querySelector('.chroma-subtitle');
    if (subtitleEl && adLabel) {
      const labelText = adLabel.textContent.trim();
      if (labelText) {
        subtitleEl.textContent = labelText.includes('Ad') ? `Accelerating ${labelText}...` : 'Accelerating Ad...';
      }
    }
  } catch (e) {
    console.warn('[Chroma Twitch] updateAdOverlay error:', e);
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
    if (!targetVideo.muted) targetVideo.muted = true;
    if (targetVideo.volume > 0) targetVideo.volume = 0;
    if (targetVideo.paused) targetVideo.play().catch(() => {});
  }
};

/**
 * Checks if a Twitch ad is currently showing.
 * Simple approach: just check if any ad label element exists with text content.
 * No getComputedStyle / getBoundingClientRect to avoid exceptions on detached nodes.
 */
function isTwitchAdShowing() {
  const labels = document.querySelectorAll(AD_SELECTORS.join(','));
  for (const el of labels) {
    // Only check text content and basic DOM presence
    const text = el.textContent.trim();
    if (text.length > 0 && el.offsetParent !== null) {
      return true;
    }
  }
  return false;
}

function handleTwitchAdAcceleration() {

  try {
    if (!CONFIG.enabled) return;

    const rawAdShowing = isTwitchAdShowing();
    const video = document.querySelector('video');

    // ALWAYS force-hide the overlay if no ad is detected
    if (!rawAdShowing) {
      // Restore video state
      if (isAdActive) {
        console.log('[Chroma Twitch] Ad ended — cleaning up overlay');
        if (video) {
          video.playbackRate = 1;
          video.muted = false;
        }
        isAdActive = false;
        lastAcceleratedSrc = null;
      }
      // Force hide overlay regardless of isAdActive state
      const overlay = document.getElementById('twitch-chroma-overlay');
      if (overlay) overlay.classList.remove('active');
      return;
    }

    // Ad is showing — accelerate
    if (!isAdActive) {
      console.log('[Chroma Twitch] Ad detected — activating overlay');
      isAdActive = true;
      startChromaClock();
    }

    if (video) {
      targetVideo = video;
      if (!video.dataset.chromaListenersAdded) {
        video.dataset.chromaListenersAdded = 'true';
        video.addEventListener('volumechange', enforceMuteHandler);
        video.addEventListener('play', enforceMuteHandler);
        video.addEventListener('pause', enforceMuteHandler);
      }
      if (video.paused) video.play().catch(() => {});
      if (!video.muted) video.muted = true;
      if (video.volume > 0) video.volume = 0;

      if (video.playbackRate !== CONFIG.accelerationSpeed) {
        video.playbackRate = CONFIG.accelerationSpeed;
        const currentSrc = video.src || 'twitch-ad';
        if (lastAcceleratedSrc !== currentSrc) {
          notifyBackground({ type: MSG.STATS_UPDATE, stats: { accelerated: 1 } });
          lastAcceleratedSrc = currentSrc;
        }
      }
    }

    updateAdOverlay(video, isAdActive);
  } catch (err) {
    console.error('[Chroma Twitch] Error in acceleration loop:', err);
    // If anything crashes, force-hide the overlay as a safety net
    const overlay = document.getElementById('twitch-chroma-overlay');
    if (overlay) overlay.classList.remove('active');
    isAdActive = false;
  }
}

function injectChromaCSS() {
  if (document.getElementById('twitch-chroma-acceleration')) return;
  const style = document.createElement('style');
  style.id = 'twitch-chroma-acceleration';
  style.textContent = `
    #twitch-chroma-overlay {
      position: absolute !important;
      top: 0 !important; left: 0 !important; 
      width: 100% !important; height: 100% !important;
      background: rgba(0, 0, 0, 0.7) !important;
      backdrop-filter: blur(12px) !important;
      z-index: 2147483647 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      color: white !important;
      font-family: Inter, Roboto, Arial, sans-serif !important;
      opacity: 0 !important;
      transition: opacity 0.5s ease-out !important;
      pointer-events: none !important;
      margin: 0 !important;
      padding: 0 !important;
    }
    #twitch-chroma-overlay.active {
      opacity: 1 !important;
      pointer-events: all !important;
    }
    .chroma-content-box {
      display: flex !important;
      flex-direction: column !important;
      align-items: center !important;
      justify-content: center !important;
      background: rgba(20, 20, 25, 0.85) !important;
      padding: 40px !important;
      border-radius: 20px !important;
      border: 1px solid rgba(255, 255, 255, 0.1) !important;
      box-shadow: 0 30px 60px rgba(0,0,0,0.8) !important;
      max-width: 90% !important;
      width: 380px !important;
      height: auto !important;
      min-height: 0 !important;
      max-height: 90% !important;
      transform: translateY(0) !important;
      transition: transform 0.5s cubic-bezier(0.16, 1, 0.3, 1) !important;
      flex-grow: 0 !important;
      flex-shrink: 0 !important;
    }
    #twitch-chroma-overlay.active .chroma-content-box {
      transform: translateY(-8px) !important;
    }
    .chroma-spinner {
      width: 50px !important; height: 50px !important;
      border: 4px solid rgba(255,255,255,0.08) !important;
      border-top-color: var(--chroma-color, #ff0055) !important;
      border-radius: 50% !important;
      animation: chroma-spin 1s linear infinite !important;
      margin: 0 0 20px 0 !important;
      flex-shrink: 0 !important;
      box-sizing: border-box !important;
      display: block !important;
    }
    @keyframes chroma-spin { 
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); } 
    }
    .chroma-title {
      font-size: 24px !important; font-weight: 800 !important; 
      margin: 0 0 8px 0 !important;
      color: #fff !important;
      letter-spacing: -0.02em !important;
      text-align: center !important;
      line-height: 1.2 !important;
      text-shadow: 0 2px 15px rgba(0,0,0,0.5) !important;
    }
    .chroma-subtitle {
      font-size: 15px !important; color: rgba(255, 255, 255, 0.6) !important;
      margin: 0 !important;
      text-align: center !important;
      line-height: 1.4 !important;
      text-shadow: 0 1px 4px rgba(0,0,0,0.5) !important;
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
