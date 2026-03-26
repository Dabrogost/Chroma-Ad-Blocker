/**
 * Chroma Ad-Blocker - Twitch Accelerator
 * Strategy: Ad-Acceleration (8x speed + mute)
 * Specifically tuned for Twitch.tv DOM structure.
 */

'use strict';

const CONFIG = {
  enabled: true,
  acceleration: true,
  accelerationSpeed: 8,
  checkIntervalMs: 400,
};

const AD_SELECTORS = [
  '[data-a-target="video-ad-label"]',
  '[data-a-target="ad-video-countdown"]',
  '.video-ad-label',
  '.tw-strong.tw-upcase.video-ad-label',
  '.video-ad-label--countdown',
  '.ad-showing',
  '.ad-interrupting',
  '.video-player__overlay--ad',
  '[class*="AdIndicator"]'
];

let targetVideo = null;
let isAdActive = false;
let lastAcceleratedSrc = null;
let adOverlay = null;
let currentAdRemainingStart = 0;
let lastAdTimerText = null;
let savedVolume = 1;

const CHROMA_CYCLE_MS = 8000;
let chromaClockRunning = false;

const MSG = {
  STATS_UPDATE: 'STATS_UPDATE',
  CONFIG_UPDATE: 'CONFIG_UPDATE'
};

/**
 * Helper to notify background script.
 */
function notifyBackground(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

/**
 * Initializes the visual overlay for Twitch.
 */
function initAdOverlay(video) {
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
  subtitle.textContent = 'Accelerating Twitch Ad...';

  const progressContainer = document.createElement('div');
  progressContainer.className = 'chroma-progress-container';
  
  const progressBar = document.createElement('div');
  progressBar.className = 'chroma-progress-bar';
  progressContainer.appendChild(progressBar);
  
  contentBox.appendChild(spinner);
  contentBox.appendChild(title);
  contentBox.appendChild(subtitle);
  contentBox.appendChild(progressContainer);
  
  adOverlay.appendChild(contentBox);

  // Target the best container: Twitch's specific player containers
  const container = video.closest('.video-player__container, .highwind-video-player') || video.parentElement;
  if (container) {
    if (window.getComputedStyle(container).position === 'static') {
      container.style.position = 'relative'; 
    }
    container.appendChild(adOverlay);
  }
}

/**
 * Updates the visual overlay state.
 */
function updateAdOverlay(video, isActive) {
  adOverlay = document.getElementById('twitch-chroma-overlay');

  if (!CONFIG.acceleration || !isActive) {
    if (adOverlay && adOverlay.classList.contains('active')) {
      adOverlay.classList.remove('active');
    }
    return;
  }
  
  if (!adOverlay) {
    initAdOverlay(video);
  }

  // Ensure it's in the right place
  const container = video.closest('.video-player__container, .highwind-video-player') || video.parentElement;
  if (container && adOverlay && !container.contains(adOverlay)) {
    container.appendChild(adOverlay);
  }
  
  if (adOverlay && !adOverlay.classList.contains('active')) {
    adOverlay.classList.add('active');
  }

  // Update progress bar
  if (adOverlay && video) {
    const progressBar = adOverlay.querySelector('.chroma-progress-bar');
    if (progressBar) {
      let percent = 0;
      
      // 1. Try to find native ad timer/progress
      const adTimer = document.querySelector(AD_SELECTORS.join(','));
      
      // Twitch doesn't have a simple progress bar for ads usually, so we rely on video duration or timer text
      if (percent <= 0) {
        // 2. Try video elements if duration is sane (twitch ads are usually 15-60s)
        const duration = video.duration;
        const currentTime = video.currentTime;
        
        if (duration > 0 && duration < 180 && isFinite(duration) && isFinite(currentTime)) {
          percent = (currentTime / duration) * 100;
          currentAdRemainingStart = 0; // Reset estimation
        } else if (adTimer) {
          // 3. Last resort: Try to parse timer text and estimate progress
          const text = adTimer.textContent || '';
          const match = text.match(/(\d+):(\d+)/);
          if (match) {
            const remaining = parseInt(match[1]) * 60 + parseInt(match[2]);
            
            // If timer changed (new ad), reset estimation
            if (text !== lastAdTimerText) {
              if (remaining > currentAdRemainingStart) {
                currentAdRemainingStart = remaining;
              }
              lastAdTimerText = text;
            }

            if (currentAdRemainingStart > 0) {
              const estimated = ((currentAdRemainingStart - remaining) / currentAdRemainingStart) * 100;
              percent = Math.min(99, Math.max(5, estimated));
            } else {
              percent = 10;
            }
          } else {
            // Indeterminate progress
            percent = (Date.now() % 2000) / 20; 
          }
        }
      }
      
      if (isFinite(percent) && percent > 0) {
        progressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
      } else {
        progressBar.style.width = '0%';
      }
    }
  }
}

/**
 * Cycles through the chroma colors.
 */
function startChromaClock() {
  if (chromaClockRunning) return;
  chromaClockRunning = true;

  function tick() {
    if (!isAdActive) {
      chromaClockRunning = false;
      return;
    }

    const t = (Date.now() % CHROMA_CYCLE_MS) / CHROMA_CYCLE_MS;
    const [r, g, b] = window.calculateChromaColor ? window.calculateChromaColor(t) : [145, 71, 255]; // Twitch Purple fallback

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
  if (document.getElementById('twitch-chroma-styles')) return;
  const style = document.createElement('style');
  style.id = 'twitch-chroma-styles';
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
      font-family: Inter, Roobert, 'Helvetica Neue', Helvetica, Arial, sans-serif !important;
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
      border-top-color: var(--chroma-color, #9147FF) !important;
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
    }
    .chroma-subtitle {
      font-size: 15px !important; color: rgba(255, 255, 255, 0.6) !important;
      margin: 0 0 20px 0 !important;
      text-align: center !important;
      line-height: 1.4 !important;
    }
    .chroma-progress-container {
      width: 100% !important;
      height: 4px !important;
      background: rgba(255,255,255,0.1) !important;
      border-radius: 2px !important;
      overflow: hidden !important;
      display: block !important;
    }
    .chroma-progress-bar {
      width: 0%;
      height: 100% !important;
      background: var(--chroma-color, #9147FF) !important;
      transition: width 0.1s linear, background 0.3s linear !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

/**
 * Checks for ad indicators using both CSS selectors and text-based heuristics.
 */
function isAdShowing() {
  // 1. Check CSS Selectors
  const adElements = document.querySelectorAll(AD_SELECTORS.join(','));
  for (const el of adElements) {
    if (el.offsetParent === null && el.getClientRects().length === 0) continue;
    
    const text = el.textContent || '';
    if (/ad|commercial|sponsored|promo|break/i.test(text) || /\d+:\d+/.test(text)) {
      return true;
    }
  }

  // 2. Text-based detection using "Invisible Overlay" strategy
  const playerContainer = document.querySelector('.video-player__container, .highwind-video-player');
  if (playerContainer && (playerContainer.offsetParent !== null || playerContainer.getClientRects().length > 0)) {
    const overlay = document.getElementById('twitch-chroma-overlay');
    // FIX: Must use display:none (not visibility:hidden).
    // innerText still reads visibility:hidden content in most browsers, so the overlay's
    // own text ("Accelerating Twitch Ad...") was matching the "Ad" regex and keeping
    // isAdShowing() returning true indefinitely after the real ad ended.
    // An inline !important overrides the stylesheet's `display: flex !important`.
    if (overlay) overlay.style.setProperty('display', 'none', 'important');
    
    try {
      const text = playerContainer.innerText || '';
      if (/\b(Ad|Sponsored|Advertisement|Commercial|Annonce|Anzeige|Break)\b/i.test(text)) {
        return true;
      }
    } finally {
      if (overlay) overlay.style.removeProperty('display');
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
  
  const activeVideos = videos.filter(v => 
    v.readyState > 0 && 
    !v.paused && 
    (v.offsetParent !== null || v.getClientRects().length > 0)
  );
  if (activeVideos.length > 0) return activeVideos[0];

  const visibleVideos = videos.filter(v => 
    (v.offsetParent !== null || v.getClientRects().length > 0) && 
    (v.src || v.querySelector('source'))
  );
  if (visibleVideos.length > 0) return visibleVideos[0];

  return videos[0];
}

function handleTwitchAdAcceleration() {
  try {
    if (!CONFIG.enabled || !CONFIG.acceleration) return;

    const rawAdShowing = isAdShowing();
    const video = findActiveVideo();
    
    if (!video) return;
    targetVideo = video;

    if (rawAdShowing) {
      if (!isAdActive) {
        isAdActive = true;
        document.body.classList.add('chroma-twitch-session');
        startChromaClock();
      }
      
      // Apply acceleration
      if (video.playbackRate !== CONFIG.accelerationSpeed) {
        if (!video.muted && video.volume > 0) {
          savedVolume = video.volume;
        }
        video.playbackRate = CONFIG.accelerationSpeed;
        video.muted = true;
        video.volume = 0;

        const currentSrc = video.src || 'twitch-ad';
        if (lastAcceleratedSrc !== currentSrc) {
          notifyBackground({ type: MSG.STATS_UPDATE, stats: { accelerated: 1 } });
          lastAcceleratedSrc = currentSrc;
        }
      }
      
      const skipButton = document.querySelector('.adSkipButton, .skippable, [class*="skip-button"]');
      if (skipButton && (skipButton.offsetParent !== null || skipButton.getClientRects().length > 0)) {
        skipButton.click();
      }
    } else {
      // Restore normal playback
      if (isAdActive) {
        video.playbackRate = 1;
        video.volume = savedVolume;
        video.muted = false;
        isAdActive = false;
        document.body.classList.remove('chroma-twitch-session');
        lastAcceleratedSrc = null;
        currentAdRemainingStart = 0;
        lastAdTimerText = null;
      }
    }

    updateAdOverlay(video, isAdActive);
  } catch (err) {
    console.error('[Chroma] Error in Twitch loop:', err);
  }
}

// ─── POLLING & INITIALIZATION ────────────────────────────────────────────────
let pollingInterval = null;

function startPolling() {
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = setInterval(handleTwitchAdAcceleration, CONFIG.checkIntervalMs);
}

function resetSession() {
  isAdActive = false;
  lastAcceleratedSrc = null;
  document.body.classList.remove('chroma-twitch-session');
  if (adOverlay) adOverlay.classList.remove('active');
}

function init() {
  chrome.storage.local.get('config').then(({ config: savedConfig }) => {
    if (savedConfig) {
      Object.assign(CONFIG, savedConfig);
    }
    injectChromaCSS();
    startPolling();
    
    // SPA transitions
    window.addEventListener('popstate', resetSession);
    window.addEventListener('hashchange', resetSession);
  }).catch(() => {
    injectChromaCSS();
    startPolling();
    window.addEventListener('popstate', resetSession);
    window.addEventListener('hashchange', resetSession);
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
      if (targetVideo && isAdActive) {
        targetVideo.playbackRate = 1;
        targetVideo.volume = savedVolume;
        targetVideo.muted = false;
      }
      isAdActive = false;
      document.body.classList.remove('chroma-twitch-session');
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
  globalThis.handleTwitchAdAcceleration = handleTwitchAdAcceleration;
  globalThis.isAdShowing = isAdShowing;
  globalThis.findActiveVideo = findActiveVideo;
  globalThis.setIsAdActive = (val) => { isAdActive = val; };
  globalThis.getIsAdActive = () => isAdActive;
}
