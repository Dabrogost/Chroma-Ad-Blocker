/**
 * Chroma Ad-Blocker - Amazon Prime Video Accelerator
 * Strategy: Ad-Acceleration (16x speed)
 * Specifically tuned for Prime Video's web player.
 */

'use strict';

const DEBUG = false;

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
  '.templateContainer .ad-overlay',
  '.dv-player-fullscreen .ad-overlay',
  'div[class*="ad-overlay"]',
  'div[class*="ad-indicator"]',
  'div[class*="ad-timer"]',
  'div[class*="ad-break"]',
  '.adunit',
  '.fbt-ad-indicator',
  '.fbt-ad-progress',
  '#ape_VideoAd-Player-Container',
  // Brittle but sometimes necessary fallbacks
  '.webPlayerUIContainer [tabindex="-1"] > div:nth-child(4) > div:nth-child(2)',
  '.templateContainer [tabindex="-1"] > div:nth-child(4) > div:nth-child(2)'
];

let targetVideo = null;
let isAdActive = false;
let lastAcceleratedSrc = null;
let adOverlayHost = null;
let adOverlayRoot = null;
let currentAdRemainingStart = 0;
let lastAdTimerText = null;
let savedVolume = 1;

const CHROMA_CYCLE_MS = 8000;
let chromaClockRunning = false;

/**
 * Initializes the visual overlay for Prime Video.
 */
function initAdOverlay(video) {
  if (adOverlayHost) return;
  
  adOverlayHost = document.createElement('div');
  adOverlayHost.id = 'prime-chroma-overlay';
  
  // Create a CLOSED shadow root for maximum isolation (VULN-06)
  adOverlayRoot = adOverlayHost.attachShadow({ mode: 'closed' });
  
  // Inject Styles into ShadowRoot
  const style = document.createElement('style');
  style.textContent = `
    :host {
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
    :host(.active) {
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
    :host(.active) .chroma-content-box {
      transform: translateY(-8px) !important;
    }
    .chroma-spinner {
      width: 50px !important; height: 50px !important;
      border: 4px solid rgba(255,255,255,0.08) !important;
      border-top-color: var(--chroma-color, #00A8E1) !important;
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
      background: var(--chroma-color, #00A8E1) !important;
      transition: width 0.1s linear, background 0.3s linear !important;
    }
  `;
  
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
  
  adOverlayRoot.appendChild(style);
  adOverlayRoot.appendChild(contentBox);

  // Target the best container: the SDK player container or the UI container
  const container = video.closest('.atvwebplayersdk-player-container, .webPlayerUIContainer') || video.parentElement;
  if (container) {
    if (window.getComputedStyle(container).position === 'static') {
      container.style.position = 'relative'; 
    }
    container.appendChild(adOverlayHost);
  }
}

/**
 * Updates the visual overlay state.
 */
function updateAdOverlay(video, isActive) {
  if (!CONFIG.acceleration || !isActive) {
    if (adOverlayHost && adOverlayHost.classList.contains('active')) {
      adOverlayHost.classList.remove('active');
    }
    return;
  }
  
  if (!adOverlayHost) {
    initAdOverlay(video);
  }

  // Ensure it's in the right place
  const container = video.closest('.atvwebplayersdk-player-container, .webPlayerUIContainer') || video.parentElement;
  if (container && adOverlayHost && !container.contains(adOverlayHost)) {
    container.appendChild(adOverlayHost);
  }
  
  if (adOverlayHost && !adOverlayHost.classList.contains('active')) {
    adOverlayHost.classList.add('active');
  }

  // Update progress bar
  if (adOverlayRoot && video) {
    const progressBar = adOverlayRoot.querySelector('.chroma-progress-bar');
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
    if (!isAdActive) {
      chromaClockRunning = false;
      return;
    }

    const t = (Date.now() % CHROMA_CYCLE_MS) / CHROMA_CYCLE_MS;
    const [r, g, b] = window.calculateChromaColor ? window.calculateChromaColor(t) : [0, 168, 225];

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
      border-top-color: var(--chroma-color, #00A8E1) !important;
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
      background: var(--chroma-color, #00A8E1) !important;
      transition: width 0.1s linear, background 0.3s linear !important;
    }
    
    /* Highlight Prime's skip buttons with high specificity */
    body.chroma-prime-session .atvwebplayersdk-ad-skip-button,
    body.chroma-prime-session .adSkipButton,
    body.chroma-prime-session [class*="skip-button"],
    body.chroma-prime-session [class*="ad-skip"] {
      border: 2px solid var(--chroma-color, #00A8E1) !important;
      box-shadow: 0 0 25px var(--chroma-color-alpha, rgba(0, 168, 225, 0.5)) !important;
      transition: border-color 0.2s linear, box-shadow 0.2s linear !important;
    }
  `;
  Object.freeze(style);
  (document.head || document.documentElement).appendChild(style);
}

/**
 * Checks for ad indicators using both CSS selectors and text-based heuristics.
 */
function isAdShowing() {
  // 1. Check CSS Selectors First (fastest)
  const adElement = document.querySelector(AD_SELECTORS.join(','));
  if (adElement && (adElement.offsetParent !== null || adElement.getClientRects().length > 0)) return true;

  // 2. Text-based detection using "Invisible Overlay" strategy
  // Expand search container to include Amazon site-specific player wrappers
  const playerContainer = document.querySelector([
    '.atvwebplayersdk-player-container',
    '.webPlayerUIContainer',
    '.templateContainer',
    '.dv-player-fullscreen',
    '.amazon-video-player',
    '.av-player-container',
    '#dv-web-player',
    '[data-testid="video-player"]'
  ].join(','));

  if (playerContainer && (playerContainer.offsetParent !== null || playerContainer.getClientRects().length > 0)) {
    // Hide our overlay text before checking innerText to prevent feedback loops
    const overlay = adOverlayHost;
    const originalVisibility = overlay ? overlay.style.visibility : null;
    if (overlay) overlay.style.visibility = 'hidden';
    
    try {
      const text = (playerContainer.innerText || '').trim();
      // More robust regex for Amazon with case-insensitivity and colon support
      if (/\b(Ad|AD|Ad:|AD:|Sponsored|Advertisement|Annonce|Anzeige)\b/i.test(text)) {
        // Double check: if it's JUST our title, it's not an ad
        const cleanText = text.replace(/Chroma Active|Accelerating Prime Ad/gi, '').trim();
        if (/\b(Ad|AD|Ad:|AD:|Sponsored|Advertisement|Annonce|Anzeige)\b/i.test(cleanText) ||
            (text.toLowerCase().includes('skip ad') || text.toLowerCase().includes('advertisement'))) {
          return true;
        }
      }
    } finally {
      // Always restore visibility
      if (overlay) overlay.style.visibility = originalVisibility || 'visible';
    }
  }

  // 3. Last resort: specific skippable elements
  const skipButton = document.querySelector('.adSkipButton, .skippable, .atvwebplayersdk-ad-skip-button, [class*="skip-button"], div[aria-label*="Skip"]');
  if (skipButton && (skipButton.offsetParent !== null || skipButton.getClientRects().length > 0)) return true;

  return false;
}

// ─── MUTATION OBSERVER ───────────────────────────────────────────────────────
let adMutationObserver = null;

/**
 * Starts a MutationObserver to detect ads instantly when DOM changes occur.
 */
function startMutationObserver() {
  if (adMutationObserver) return;
  
  adMutationObserver = new MutationObserver((mutations) => {
    // We don't need to check every mutation specifically, 
    // just use it as a trigger for our main logic.
    handlePrimeAdAcceleration();
  });
  
  // Observe document.documentElement instead of document.body to avoid null errors at document_start
  const target = document.body || document.documentElement || document;
  
  adMutationObserver.observe(target, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'data-testid']
  });
}

/**
 * Finds the most likely active video element.
 */
function findActiveVideo() {
  const videos = Array.from(document.querySelectorAll('video'));
  if (videos.length === 0) return null;
  
  // 1. Prefer videos that are actually playing or ready and are large enough
  const activeVideos = videos.filter(v => 
    v.readyState >= 1 && // Relaxed from readyState > 0 to include HAVE_METADATA
    !v.paused && 
    (v.offsetParent !== null || v.getClientRects().length > 0) &&
    v.videoWidth > 100 && v.videoHeight > 100 // Filter out miniature tracking videos
  );
  if (activeVideos.length > 0) return activeVideos[0];

  // 2. Fallback to visible videos with source, even if paused (for pre-rolls)
  const visibleVideos = videos.filter(v => 
    (v.offsetParent !== null || v.getClientRects().length > 0) && 
    (v.src || v.querySelector('source')) &&
    (v.offsetWidth > 100 && v.offsetHeight > 100 || v.readyState >= 1)
  );
  if (visibleVideos.length > 0) return visibleVideos[0];

  return videos[0];
}

function handlePrimeAdAcceleration() {
  try {
    if (!CONFIG.enabled || !CONFIG.acceleration) return;

    const rawAdShowing = isAdShowing();
    const video = findActiveVideo();
    
    // Even if no video is found, if we were active, we might need to reset
    if (!video) {
        if (isAdActive) {
            isAdActive = false;
            document.body.classList.remove('chroma-prime-session');
            updateAdOverlay(null, false);
        }
        return;
    }
    
    targetVideo = video;

    // Detect Source Change - Reset state if video source swapped (common on Amazon)
    const currentSrc = video.src || (video.querySelector('source') ? video.querySelector('source').src : null);
    if (lastAcceleratedSrc && lastAcceleratedSrc !== currentSrc && !rawAdShowing) {
        if (DEBUG) console.log('[Chroma] Video source changed, resetting ad state.');
        resetSession();
    }

    if (rawAdShowing) {
      if (!isAdActive) {
        isAdActive = true;
        document.body.classList.add('chroma-prime-session');
        startChromaClock();
      }
      
      // Apply acceleration
      if (video.playbackRate !== CONFIG.accelerationSpeed) {
        // Save the user's current volume before muting
        if (!video.muted && video.volume > 0) {
          savedVolume = video.volume;
        }
        video.playbackRate = CONFIG.accelerationSpeed;
        video.muted = true;
        video.volume = 0;
      }
      
      // Auto-click skip button if it appears
      const skipButton = document.querySelector('.adSkipButton, .skippable, [class*="skip-button"], .atvwebplayersdk-ad-skip-button');
      if (skipButton && (skipButton.offsetParent !== null || skipButton.getClientRects().length > 0)) {
        skipButton.click();
      }
    } else {
      // Restore normal playback
      if (isAdActive) {
        // --- NEW: Update stats when ad session ends ---
        if (window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.send) {
          window.__CHROMA_INTERNAL__.send({
            token: window.__CHROMA_INTERNAL__.token,
            action: 'STATS_UPDATE',
            payload: { type: 'accelerated' }
          });
        }
        
        video.playbackRate = 1;
        video.volume = savedVolume;
        video.muted = false;
        isAdActive = false;
        document.body.classList.remove('chroma-prime-session');
        lastAcceleratedSrc = null;
        currentAdRemainingStart = 0;
        lastAdTimerText = null;
      }
    }

    updateAdOverlay(video, isAdActive);
  } catch (err) {
    if (DEBUG) console.error('[Chroma] Error in Prime loop:', err);
  }
}

// ─── POLLING & INITIALIZATION ────────────────────────────────────────────────
let pollingInterval = null;

function startPolling() {
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = setInterval(handlePrimeAdAcceleration, CONFIG.checkIntervalMs);
}

function resetSession() {
  isAdActive = false;
  lastAcceleratedSrc = null;
  document.body.classList.remove('chroma-prime-session');
  if (adOverlayHost) adOverlayHost.classList.remove('active');
}

function init() {
  // 1. Initial check (might be ready if handshake was fast)
  if (window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.config) {
    Object.assign(CONFIG, window.__CHROMA_INTERNAL__.config);
  }

  // 2. Listen for the handshake completion/config update
  document.addEventListener('__CHROMA_CONFIG_UPDATE__', (e) => {
    if (e.detail) {
      Object.assign(CONFIG, e.detail);
      if (DEBUG) console.log('[Chroma] Prime handler re-init config via handshake:', CONFIG);
      
      if (CONFIG.enabled && CONFIG.acceleration && !pollingInterval) {
        startPolling();
        startMutationObserver();
      }
    }
  });

  // Handle SPA transitions
  window.addEventListener('popstate', resetSession);
  window.addEventListener('hashchange', resetSession);
  document.addEventListener('atv-navigation-complete', resetSession);

  // CRITICAL: Start basic services
  injectChromaCSS();
  startPolling();
  startMutationObserver();
}

// Listen for config updates via custom event from handshake logic
document.addEventListener('__CHROMA_CONFIG_UPDATE__', (e) => {
  if (e.detail) {
    Object.assign(CONFIG, e.detail);
    if (DEBUG) console.log('[Chroma] prm_handler updated config:', CONFIG);
    
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
      document.body.classList.remove('chroma-prime-session');
      if (adOverlayHost) adOverlayHost.classList.remove('active');
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
  globalThis.setIsAdActive = (val) => { isAdActive = val; };
  globalThis.getIsAdActive = () => isAdActive;
}
