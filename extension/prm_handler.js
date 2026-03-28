/**
 * Chroma Ad-Blocker - Amazon Prime Video Accelerator
 * Strategy: Ad-Acceleration (16x speed)
 * Specifically tuned for Prime Video's web player.
 */

'use strict';

const DEBUG = false;

const CONFIG = Object.create(null);
Object.assign(CONFIG, {
  enabled: false, // Default to disabled until handshake (KILL SWITCH)
  acceleration: false,
  accelerationSpeed: 16,
  checkIntervalMs: 400,
});

// ─── PRISTINE API BRIDGE ──────────────────────────────────────────────────────
// SECURE REFERENCE: Use the pristine APIs provided by interceptor.js (VULN-03)
const API = (window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.api) ? 
            window.__CHROMA_INTERNAL__.api : 
            {
              querySelector: document.querySelector.bind(document),
              getElementById: document.getElementById.bind(document),
              createElement: document.createElement.bind(document),
              addEventListener: window.addEventListener.bind(window),
              removeEventListener: window.removeEventListener.bind(window),
              setTimeout: window.setTimeout.bind(window),
              setInterval: window.setInterval.bind(window),
              clearInterval: window.clearInterval.bind(window),
              dispatchEvent: document.dispatchEvent.bind(document),
              addDocEventListener: document.addEventListener.bind(document),
              removeDocEventListener: document.removeEventListener.bind(document),
              MutationObserver: window.MutationObserver
            };

const qS = (s) => API.querySelector(s);
const cE = (t) => API.createElement(t);
const sI = (f, t) => API.setInterval(f, t);
const cI = (i) => API.clearInterval(i);

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
let lastAdDetectTime = 0;

const CHROMA_CYCLE_MS = 8000;
let chromaClockRunning = false;

/**
 * Initializes the visual overlay for Prime Video.
 */
function initAdOverlay(video) {
  if (adOverlayHost) return;
  
  adOverlayHost = cE('div');
  adOverlayHost.id = 'prime-chroma-overlay';
  
  // Create a CLOSED shadow root for maximum isolation (VULN-06)
  adOverlayRoot = adOverlayHost.attachShadow({ mode: 'closed' });
  
  // Inject Styles into ShadowRoot
  const style = cE('style');
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
  
  const contentBox = cE('div');
  contentBox.className = 'chroma-content-box';
  
  const spinner = cE('div');
  spinner.className = 'chroma-spinner';
  
  const title = cE('div');
  title.className = 'chroma-title';
  title.textContent = 'Chroma Active';
  
  const subtitle = cE('div');
  subtitle.className = 'chroma-subtitle';
  subtitle.textContent = 'Accelerating Prime Ad...';

  const progressContainer = cE('div');
  progressContainer.className = 'chroma-progress-container';
  
  const progressBar = cE('div');
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
      const adTimer = qS('.atvwebplayersdk-ad-time-remaining, .atvwebplayersdk-ad-timer, [data-testid="ad-indicator"]');
      const nativeProgress = qS('.atvwebplayersdk-ad-progress-bar, [class*="ad-progress"]');
      
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
  if (API.getElementById('prime-chroma-styles')) return;
  const style = cE('style');
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
  // Prevent the 'style' variable reference from being reassigned.
  Object.freeze(style);
  (document.head || document.documentElement).appendChild(style);
}

/**
 * Checks for ad indicators using both CSS selectors and text-based heuristics.
 */
function isAdShowing() {
  // 1. Check CSS Selectors First (fastest)
  const adElement = qS(AD_SELECTORS.join(','));
  if (adElement && (adElement.offsetParent !== null || adElement.getClientRects().length > 0)) return true;

  // 2. Text-based detection using "Invisible Overlay" strategy
  // Expand search container to include Amazon site-specific player wrappers
  const playerContainer = qS([
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
  const skipButton = qS('.adSkipButton, .skippable, .atvwebplayersdk-ad-skip-button, [class*="skip-button"], div[aria-label*="Skip"]');
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
  
  adMutationObserver = new API.MutationObserver((mutations) => {
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

    const video = findActiveVideo();
    const rawAdShowing = isAdShowing();
    
    // We only use the duration as a weak signal now, not a hard kill switch.
    // If it's a 2-hour movie, it's definitely content.
    let effectiveAdShowing = rawAdShowing;
    if (video && video.duration > 600 && isFinite(video.duration)) {
      effectiveAdShowing = false;
    }
    
    // Determine current video source for transition tracking
    const currentSrc = video ? (video.src || (video.querySelector('source') ? video.querySelector('source').src : null)) : null;

    // Detect Source Change - Force reset IF source swapped AND we are not seeing an ad
    if (currentSrc && lastAcceleratedSrc && lastAcceleratedSrc !== currentSrc && !rawAdShowing) {
        if (DEBUG) console.log('[Chroma] Video source changed, resetting ad state.');
        resetSession(video);
        effectiveAdShowing = false;
    }

    if (effectiveAdShowing) {

      if (!isAdActive) {
        isAdActive = true;
        document.body.classList.add('chroma-prime-session');
        startChromaClock();
      }
      lastAdDetectTime = Date.now();
      if (currentSrc) lastAcceleratedSrc = currentSrc;
      
      // Apply acceleration ONLY if we have a video
      if (video) {
        if (video.playbackRate !== CONFIG.accelerationSpeed) {
          // Save the user's current volume before muting
          if (!video.muted && video.volume > 0) {
            savedVolume = video.volume;
          }
          video.playbackRate = CONFIG.accelerationSpeed;
          video.muted = true;
          video.volume = 0;
        }
      }
      
      // Auto-click skip button if it appears
      const skipButton = qS('.adSkipButton, .skippable, [class*="skip-button"], .atvwebplayersdk-ad-skip-button');
      if (skipButton && (skipButton.offsetParent !== null || skipButton.getClientRects().length > 0)) {
        skipButton.click();
      }
    } else {
      // Sticky State: Restore normal playback ONLY after 1000ms of stable "no ad" signal
      if (isAdActive) {
        const timeSinceAd = Date.now() - lastAdDetectTime;
        if (timeSinceAd > 1000) {
          // --- NEW: Update stats when ad session ends ---
          if (window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.send) {
            window.__CHROMA_INTERNAL__.send({
              action: 'STATS_UPDATE',
              payload: { type: 'accelerated' }
            });
          }
          
          if (video) {
            video.playbackRate = 1;
            video.volume = savedVolume;
            video.muted = false;
          }
          
          // Also reset the targetVideo in case it's different from the active video
          if (targetVideo && targetVideo !== video) {
            targetVideo.playbackRate = 1;
            targetVideo.muted = false;
          }

          isAdActive = false;
          document.body.classList.remove('chroma-prime-session');
          lastAcceleratedSrc = null;
          currentAdRemainingStart = 0;
          lastAdTimerText = null;
        }
      }
    }

    if (video) targetVideo = video;
    updateAdOverlay(targetVideo, isAdActive);
  } catch (err) {
    if (DEBUG) console.error('[Chroma] Error in Prime loop:', err);
  }
}

// ─── POLLING & INITIALIZATION ────────────────────────────────────────────────
let pollingInterval = null;

function startPolling() {
  if (pollingInterval) cI(pollingInterval);
  pollingInterval = sI(handlePrimeAdAcceleration, CONFIG.checkIntervalMs);
}

function resetSession(videoToRestore = null) {
  if (videoToRestore && isAdActive) {
    videoToRestore.playbackRate = 1;
    videoToRestore.volume = savedVolume;
    videoToRestore.muted = false;
  }
  isAdActive = false;
  lastAcceleratedSrc = null;
  document.body.classList.remove('chroma-prime-session');
  if (adOverlayHost) adOverlayHost.classList.remove('active');
}

function init() {
  // 0. Whitelist shortcut for MAIN world
  if (document.documentElement.getAttribute('data-chroma-whitelisted') === 'true') {
    if (DEBUG) console.log('[Chroma] Prime handler disabled by whitelist.');
    return;
  }

  // 1. Initial check (might be ready if handshake was fast)
  if (window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.config) {
    const remoteConfig = window.__CHROMA_INTERNAL__.config;
    for (const key in remoteConfig) {
      if (Object.prototype.hasOwnProperty.call(remoteConfig, key)) {
        CONFIG[key] = remoteConfig[key];
      }
    }
  }

  // 2. Listen for the handshake completion (THE PRIMARY ACTIVATION TRIGGER)
  API.addDocEventListener('__CHROMA_CONFIG_UPDATE__', (e) => {
    if (e.detail) {
      Object.assign(CONFIG, e.detail);
      if (DEBUG) console.log('[Chroma] Prime handler activated via handshake:', CONFIG);
      
      if (CONFIG.enabled && !pollingInterval) {
        startPolling();
        startMutationObserver();
      }
    }
  });

  // Handle SPA transitions
  window.addEventListener('popstate', resetSession);
  window.addEventListener('hashchange', resetSession);
  document.addEventListener('atv-navigation-complete', resetSession);

  // 3. SECURE START: If we already have config, start. Otherwise, wait for handshake.
  if (CONFIG.enabled) {
    injectChromaCSS();
    startPolling();
    startMutationObserver();
  } else {
    // 4. SAFETY FALLBACK: If handshake fails to arrive but site is NOT whitelisted
    // and we are NOT in a compromised environment, we wake up after a delay.
    setTimeout(() => {
      if (!CONFIG.enabled && !document.documentElement.getAttribute('data-chroma-whitelisted')) {
        if (DEBUG) console.log('[Chroma] Handshake timeout. Waking up Prime handler with defaults.');
        CONFIG.enabled = true;
        CONFIG.acceleration = true;
        injectChromaCSS();
        startPolling();
        startMutationObserver();
      }
    }, 1200);
  }
}

// Listen for config updates via custom event from handshake logic
API.addDocEventListener('__CHROMA_CONFIG_UPDATE__', (e) => {
  if (e.detail) {
    Object.assign(CONFIG, e.detail);
    if (DEBUG) console.log('[Chroma] prm_handler updated config:', CONFIG);
    
    if (!CONFIG.enabled || !CONFIG.acceleration) {
      if (pollingInterval) {
        cI(pollingInterval);
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
  if (typeof window.MSG !== "undefined") globalThis.MSG = window.MSG;
  globalThis.handlePrimeAdAcceleration = handlePrimeAdAcceleration;
  globalThis.isAdShowing = isAdShowing;
  globalThis.findActiveVideo = findActiveVideo;
  globalThis.setIsAdActive = (val) => { isAdActive = val; };
  globalThis.getIsAdActive = () => isAdActive;
}
