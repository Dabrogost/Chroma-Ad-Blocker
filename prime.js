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
let currentAdRemainingStart = 0;
let lastAdTimerText = null;

const CHROMA_CYCLE_MS = 8000;
let chromaClockRunning = false;

/**
 * Initializes the visual overlay for Prime Video.
 */
function initAdOverlay(video) {
  if (document.getElementById('prime-chroma-overlay')) return;
  
  adOverlay = document.createElement('div');
  adOverlay.id = 'prime-chroma-overlay';
  
  const contentBox = document.createElement('div');
  contentBox.className = 'chroma-content-box';
  
  const spinner = document.createElement('div');
  spinner.className = 'chroma-spinner';
  
  const title = document.createElement('div');
  title.className = 'chroma-title';
  title.textContent = 'Chroma Active';
  
  const subtitle = document.createElement('div');
  subtitle.className = 'chroma-subtitle';
  subtitle.textContent = 'Accelerating Prime Ad...';

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

  // Update progress bar
  if (adOverlay && video) {
    const progressBar = adOverlay.querySelector('.chroma-progress-bar');
    if (progressBar) {
      let percent = 0;
      
      // 1. Try to find native ad timer/progress
      const adTimer = document.querySelector('.atvwebplayersdk-ad-time-remaining, .atvwebplayersdk-ad-timer, [data-testid="ad-indicator"]');
      const nativeProgress = document.querySelector('.atvwebplayersdk-ad-progress-bar, [class*="ad-progress"]');
      
      if (nativeProgress) {
        // Try to mirror native progress bar width or aria-valuenow
        const width = nativeProgress.style.width || nativeProgress.getAttribute('aria-valuenow');
        if (width) {
          percent = parseFloat(width);
        }
      } 
      
      if (percent <= 0) {
        // 2. Fallback to video elements if duration is sane (e.g. < 10 mins)
        const duration = video.duration;
        const currentTime = video.currentTime;
        
        if (duration > 0 && duration < 600 && isFinite(duration) && isFinite(currentTime)) {
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
              // Estimate: (Total - Remaining) / Total
              // We caps the progress at 99% until it finishes
              const estimated = ((currentAdRemainingStart - remaining) / currentAdRemainingStart) * 100;
              percent = Math.min(99, Math.max(5, estimated));
            } else {
              percent = 10; // Initial placeholder
            }
          } else {
            // Indeterminate progress (pulsating)
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
    if (!window._primeAdSessionActive) {
      chromaClockRunning = false;
      return;
    }

    const t = (Date.now() % CHROMA_CYCLE_MS) / CHROMA_CYCLE_MS;
    const [r, g, b] = window.calculateChromaColor(t);

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
      font-family: 'Amazon Ember', Arial, sans-serif !important;
      opacity: 0 !important;
      transition: opacity 0.5s ease-out !important;
      pointer-events: none !important;
      margin: 0 !important;
      padding: 0 !important;
    }
    #prime-chroma-overlay.active {
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
    #prime-chroma-overlay.active .chroma-content-box {
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
      background: var(--chroma-color, #ff0055) !important;
      transition: width 0.1s linear, background 0.3s linear !important;
    }
    
    /* Highlight Prime's skip buttons with high specificity */
    body.chroma-prime-session .atvwebplayersdk-ad-skip-button,
    body.chroma-prime-session .adSkipButton,
    body.chroma-prime-session [class*="skip-button"],
    body.chroma-prime-session [class*="ad-skip"] {
      border: 2px solid var(--chroma-color, #ff0055) !important;
      box-shadow: 0 0 25px var(--chroma-color-alpha, rgba(255,0,85,0.5)) !important;
      transition: border-color 0.2s linear, box-shadow 0.2s linear !important;
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
  const overlayContainers = document.querySelectorAll('.atvwebplayersdk-overlays-container, .webPlayerUIContainer');
  for (const container of overlayContainers) {
    // Avoid detecting our own overlay text
    if (container.id === 'prime-chroma-overlay' || container.querySelector('#prime-chroma-overlay')) continue;

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
  try {
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
        currentAdRemainingStart = 0;
        lastAdTimerText = null;
      }
    }

    updateAdOverlay(video, window._primeAdSessionActive);
  } catch (err) {
    console.error('[Chroma] Error in Prime loop:', err);
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
