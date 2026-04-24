/**
 * Chroma Ad-Blocker - Amazon Prime Video Accelerator
 * Strategy: Ad-Acceleration (configurable speed, default 8x)
 * Specifically tuned for Prime Video's web player.
 */

(function() {
  'use strict';

  const DEBUG = false;

  const CONFIG = Object.create(null);
  Object.assign(CONFIG, {
    enabled: false, // Default to disabled until handshake (KILL SWITCH)
    acceleration: false,
    accelerationSpeed: 8, // Default playback rate supported for ad acceleration
    checkIntervalMs: 400,  // Interval between ad state checks (ms)
  });

  // Whitelist of allowed config keys for secure updates.
  // Mirror of yt_handler.js — the enabled / acceleration / accelerationSpeed /
  // checkIntervalMs validators are intentionally identical across both handlers;
  // keep structurally aligned when changing shared keys.
  const VALID_CONFIG_KEYS = ['enabled', 'acceleration', 'accelerationSpeed', 'checkIntervalMs'];

  const CONFIG_VALIDATORS = Object.freeze({
    enabled:           (v) => typeof v === 'boolean',
    acceleration:      (v) => typeof v === 'boolean',
    accelerationSpeed: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 16,
    checkIntervalMs:   (v) => typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 5000
  });

  function applyConfig(source) {
    for (const key of VALID_CONFIG_KEYS) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        const val = source[key];
        if (CONFIG_VALIDATORS[key](val)) CONFIG[key] = val;
      }
    }
  }

  // ─── PRISTINE API BRIDGE ─────
  // Integrity Layer: Utilizing pre-cached native APIs from the secure bridge to bypass host-page prototype pollution.
  const API = (window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.api) ? 
              window.__CHROMA_INTERNAL__.api : 
              {
                querySelector: document.querySelector.bind(document),
                createElement: document.createElement.bind(document),
                addEventListener: window.addEventListener.bind(window),
                setInterval: window.setInterval.bind(window),
                clearInterval: window.clearInterval.bind(window),
                addDocEventListener: document.addEventListener.bind(document)
              };

  const safeQuery = (s) => API.querySelector(s);
  const safeCreate = (t) => API.createElement(t);
  const safeSetInterval = (f, t) => API.setInterval(f, t);
  const safeClearInterval = (i) => API.clearInterval(i);

  let _chromaExtInitActive = true;
  let _extInitFired = false;
  API.addDocEventListener('__EXT_INIT__', (e) => {
    _extInitFired = true;
    if (e && e.detail && e.detail.active === false) {
      _chromaExtInitActive = false;
      CONFIG.enabled = false;
    } else {
      CONFIG.enabled = true;
    }
    if (e && e.detail && e.detail.acceleration !== undefined) {
      CONFIG.acceleration = e.detail.acceleration;
    }

    // Late-arrival activation: If the init polling loop already timed out
    // (cold browser start where chrome.storage was slow), activate now.
    if (!pollingInterval && _chromaExtInitActive) {
      if (window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.config) {
        applyConfig(window.__CHROMA_INTERNAL__.config);
      }
      if (CONFIG.enabled && CONFIG.acceleration) {
        ensurePrimeSessionSheet();
        startPolling();
      } else if (_chromaExtInitActive) {
        CONFIG.enabled = true;
        ensurePrimeSessionSheet();
        startPolling();
      }
    }
  }, true);

  // Selectors that reliably indicate an active ad (state classes, skip buttons, overlays)
  const AD_SELECTORS_RELIABLE = [
    '.ad-skipping',
    '.ad-interrupting',
    '.ad-showing',
    '.adSkipButton',
    '.skippable',
    '.atvwebplayersdk-player-container .ad-overlay',
    '.templateContainer .ad-overlay',
    '.dv-player-fullscreen .ad-overlay',
    '.adunit',
    '.fbt-ad-indicator',
    '.fbt-ad-progress',
    '#ape_VideoAd-Player-Container',
    '[data-testid="video-ad-label"]'
  ];

  // Selectors for elements that persist in the DOM after ads end.
  // These require secondary validation (must contain countdown text).
  const AD_SELECTORS_NEED_TIMER = [
    '.atvwebplayersdk-ad-container',
    '.atvwebplayersdk-ad-time-remaining',
    '.atvwebplayersdk-ad-indicator-text',
    '.atvwebplayersdk-ad-timer',
    '[data-testid="ad-indicator"]'
  ];

  let targetVideo = null;
  let isAdActive = false;
  let lastAcceleratedSrc = null;
  let adOverlayHost = null;
  let adOverlayRoot = null;
  let currentAdRemainingStart = 0;
  let lastAdTimerText = null;
  let savedVolume = 1;
  let lastAdEndTime = 0;
  const AD_COOLDOWN_MS = 2000; // Cooldown to bridge ad-to-content transitions (ms)
  let consecutiveFalseCount = 0;

  // Anti-Detection: Session stylesheet toggle (replaces observable body class mutations)
  let primeSessionSheet = null;

  function ensurePrimeSessionSheet() {
    if (primeSessionSheet) return;
    primeSessionSheet = new CSSStyleSheet();
    primeSessionSheet.replaceSync(`
      .atvwebplayersdk-ad-skip-button,
      .adSkipButton,
      [class*="skip-button"],
      [class*="ad-skip"] {
        border: 2px solid #00A8E1 !important;
        box-shadow: 0 0 25px rgba(0, 168, 225, 0.4) !important;
        transition: border-color 0.2s linear, box-shadow 0.2s linear !important;
      }
    `);
  }

  function activatePrimeSessionSheet() {
    ensurePrimeSessionSheet();
    const sheets = document.adoptedStyleSheets;
    if (!sheets.includes(primeSessionSheet)) {
      document.adoptedStyleSheets = [...sheets, primeSessionSheet];
    }
  }

  function deactivatePrimeSessionSheet() {
    if (!primeSessionSheet) return;
    const sheets = document.adoptedStyleSheets;
    if (sheets.includes(primeSessionSheet)) {
      document.adoptedStyleSheets = sheets.filter(s => s !== primeSessionSheet);
    }
  }

  /**
   * Initializes the visual overlay for Prime Video.
   */
  function initAdOverlay(video) {
    if (adOverlayHost) return;
  
    adOverlayHost = safeCreate('div');
    adOverlayHost.id = 'chroma-host-' + Math.random().toString(36).substring(2, 9);
  
    // SECURITY: Using 'closed' mode to prevent host-page scripts from accessing or tampering with the Chroma overlay.
    adOverlayRoot = adOverlayHost.attachShadow({ mode: 'closed' });
  
    const style = safeCreate('style');
    style.textContent = `
      :host {
        display: block !important;
        position: absolute !important;
        top: 0 !important; left: 0 !important; 
        width: 100% !important; height: 100% !important;
        z-index: 2147483647 !important; /* Maximum z-index */
        pointer-events: none !important;
        contain: strict !important;
        margin: 0 !important; padding: 0 !important;
        box-sizing: border-box !important;
      
        /* UX: Visibility delay allows the 0.5s fade-out to complete before interaction handling is removed. */
        visibility: hidden !important;
        transition: visibility 0s 0.5s;
      }
      :host(.active) {
        visibility: visible !important;
        transition: none;
      }
      .chroma-screen {
        position: absolute !important;
        top: 0 !important; left: 0 !important;
        width: 100% !important; height: 100% !important;
        background: rgba(0, 0, 0, 0.7) !important;
        backdrop-filter: blur(12px) !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        color: white !important;
        font-family: 'Amazon Ember', Arial, sans-serif !important;
        opacity: 0 !important;
        transition: opacity 0.5s ease-out !important;
        box-sizing: border-box !important;
        pointer-events: none !important;
      }
      :host(.active) .chroma-screen {
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
        border-top-color: #00A8E1 !important;
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
        background: #00A8E1 !important;
        transition: width 0.1s linear, background 0.3s linear !important;
      }
    `;
  
    const screen = safeCreate('div');
    screen.className = 'chroma-screen';

    const contentBox = safeCreate('div');
    contentBox.className = 'chroma-content-box';
  
    const spinner = safeCreate('div');
    spinner.className = 'chroma-spinner';
  
    const title = safeCreate('div');
    title.className = 'chroma-title';
    title.textContent = 'Chroma Active';
  
    const subtitle = safeCreate('div');
    subtitle.className = 'chroma-subtitle';
    subtitle.textContent = 'Accelerating Prime Ad...';

    const progressContainer = safeCreate('div');
    progressContainer.className = 'chroma-progress-container';
  
    const progressBar = safeCreate('div');
    progressBar.className = 'chroma-progress-bar';
    progressContainer.appendChild(progressBar);
  
    contentBox.appendChild(spinner);
    contentBox.appendChild(title);
    contentBox.appendChild(subtitle);
    contentBox.appendChild(progressContainer);
  
    screen.appendChild(contentBox);
  
    adOverlayRoot.appendChild(style);
    adOverlayRoot.appendChild(screen);

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

    const container = video.closest('.atvwebplayersdk-player-container, .webPlayerUIContainer') || video.parentElement;
    if (container && adOverlayHost && !container.contains(adOverlayHost)) {
      container.appendChild(adOverlayHost);
    }
  
    if (adOverlayHost && !adOverlayHost.classList.contains('active')) {
      adOverlayHost.classList.add('active');
    }

    if (adOverlayRoot && video) {
      const progressBar = adOverlayRoot.querySelector('.chroma-progress-bar');
      if (progressBar) {
        let percent = 0;
      
        // 1. Try to find native ad timer/progress
        const adTimer = safeQuery('.atvwebplayersdk-ad-time-remaining, .atvwebplayersdk-ad-timer, [data-testid="ad-indicator"]');
        const nativeProgress = safeQuery('.atvwebplayersdk-ad-progress-bar, [class*="ad-progress"]');
      
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
        
          if (duration > 0 && duration < 600 && isFinite(duration) && isFinite(currentTime)) { // 10-minute threshold for sane ad duration
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
                // Pod Detection: Calculate completion percentage based on the starting remaining time.
                // Caps at 99% until the ad actually terminates to avoid visual jumping.
                const estimated = ((currentAdRemainingStart - remaining) / currentAdRemainingStart) * 100;
                percent = Math.min(99, Math.max(5, estimated));
              } else {
                percent = 10; // Initial placeholder
              }
            } else {
              // Indeterminate progress (pulsating)
              percent = (Date.now() % 2000) / 20; // Pulsating indeterminate progress (2000ms period)
            }
          }
        }
      
        if (isFinite(percent) && percent > 0) {
          progressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
        }
      }
    }
  }

  /**
   * Checks for ad indicators using both CSS selectors and text-based heuristics.
   */
  function isAdShowing() {
    // 1a. Reliable selectors — state classes, skip buttons, overlays (trusted immediately)
    const reliableEl = safeQuery(AD_SELECTORS_RELIABLE.join(','));
    if (reliableEl && (reliableEl.offsetParent !== null || reliableEl.getClientRects().length > 0)) {
      return true;
    }

    // 1b. Persistent selectors — containers/timers that linger after ads end.
    //     Only trust them if they (or a child) contain an active countdown.
    const timerEl = safeQuery(AD_SELECTORS_NEED_TIMER.join(','));
    if (timerEl && (timerEl.offsetParent !== null || timerEl.getClientRects().length > 0)) {
      const content = (timerEl.textContent || '').trim();
      if (/\d+:\d+/.test(content)) {
        return true;
      }
    }

    // 2. Text-based detection using "Invisible Overlay" strategy
    // Expand search container to include Amazon site-specific player wrappers
    const playerContainer = safeQuery([
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
          if (text.toLowerCase().includes('skip ad') || text.toLowerCase().includes('advertisement')) {
            return true;
          }
          if (/\b(Ad|AD|Ad:|AD:|Sponsored|Annonce|Anzeige)\b/i.test(cleanText)) {
            // Require corroborating evidence: a visible countdown timer with actual digits,
            // or a progress indicator. A lone "Ad" word without a live timing signal is
            // unreliable (catches residual "Ad info" / "Ad choices" links after ad ends).
            if (/\d+:\d+/.test(cleanText)) {
              return true;
            }
            const timerEl = safeQuery('.atvwebplayersdk-ad-timer, .atvwebplayersdk-ad-time-remaining, [class*="ad-progress"], [class*="ad-timer"]');
            if (timerEl && /\d+:\d+/.test(timerEl.textContent || '')) {
              return true;
            }
          }
        }
      } finally {
        // Always restore visibility
        if (overlay) overlay.style.visibility = originalVisibility || 'visible';
      }
    }

    // 3. Last resort: specific skippable elements
    const skipButton = safeQuery('.adSkipButton, .skippable, .atvwebplayersdk-ad-skip-button, [class*="skip-button"], div[aria-label*="Skip"]');
    if (skipButton && (skipButton.offsetParent !== null || skipButton.getClientRects().length > 0)) return true;

    return false;
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
      // Performance Optimization: Capture ad state and video reference BEFORE the configuration guard 
      // to prevent UI 'flicker' caused by the MutationObserver/visibility-toggle race condition.
      const rawAdShowing = isAdShowing();
      const video = findActiveVideo();
      if (isAdActive && adOverlayHost && !adOverlayHost.isConnected) {
        if (DEBUG) console.log('[Chroma] Overlay disconnected — forcing ad-end.');
        if (targetVideo) {
          targetVideo.playbackRate = 1;
          targetVideo.muted = false;
          targetVideo.volume = savedVolume;
        }
        isAdActive = false;
        lastAdEndTime = Date.now();
        consecutiveFalseCount = 0;
        lastAcceleratedSrc = null;
        currentAdRemainingStart = 0;
        lastAdTimerText = null;
        deactivatePrimeSessionSheet();
        adOverlayHost = null;
        adOverlayRoot = null;
        return;
      }
      if (!CONFIG.enabled || !CONFIG.acceleration) return;

      // Cooldown check: Prevents rapid re-triggering during the playback transition.
      // However, if we definitively detect an ad, we reset the cooldown.
      if (rawAdShowing) {
        lastAdEndTime = 0;
      } else if (Date.now() - lastAdEndTime < AD_COOLDOWN_MS) {
        return;
      }
    
      // Even if no video is found, if we were active, we might need to reset
      if (!video) {
          if (isAdActive) {
              isAdActive = false;
              deactivatePrimeSessionSheet();
              updateAdOverlay(null, false);
              if (targetVideo) targetVideo.playbackRate = 1;
          }
          return;
      }
    
      const currentSrc = video.src || (video.querySelector('source') ? video.querySelector('source').src : null);

      // Detect Source Change - Force reset if source swapped and no ad indicator
      if (lastAcceleratedSrc && lastAcceleratedSrc !== currentSrc && !rawAdShowing) {
          if (DEBUG) console.log('[Chroma] Video source changed, resetting ad state.');
          if (isAdActive) {
            video.playbackRate = 1;
            video.volume = savedVolume;
            video.muted = false;
          }
          resetSession();
      }

      if (rawAdShowing) {
        // Guard: If we were accelerating a specific video source and findActiveVideo()
        // now returns a different source, the player has switched to content while
        // residual ad DOM persists. Treat this as a false positive.
        if (isAdActive && lastAcceleratedSrc && lastAcceleratedSrc !== currentSrc) {
          consecutiveFalseCount++;
        } else {
          consecutiveFalseCount = 0;
          if (!isAdActive) {
            isAdActive = true;
            targetVideo = video;
            activatePrimeSessionSheet();
          }

          lastAcceleratedSrc = currentSrc;

          // Apply acceleration
          if (targetVideo.playbackRate !== CONFIG.accelerationSpeed) {
            if (!targetVideo.muted && targetVideo.volume > 0) savedVolume = targetVideo.volume;
            targetVideo.playbackRate = CONFIG.accelerationSpeed;
            targetVideo.muted = true;
            targetVideo.volume = 0;
          }
        }
      
      } else {
        consecutiveFalseCount++;
        // Performance Optimization: Restore normal playback with debounce.
        if (isAdActive && consecutiveFalseCount >= 4) { // Require 4 consecutive negative detections (~1.6s)
        
          video.playbackRate = 1;
          video.volume = savedVolume;
          video.muted = false;

          // Explicit reset of previously accelerated element in case findActiveVideo()
          // switched to the content video during the ad-to-content DOM transition.
          if (targetVideo && targetVideo !== video) {
            targetVideo.playbackRate = 1;
            targetVideo.muted = false;
            targetVideo.volume = savedVolume;
          }
        
          isAdActive = false;
          lastAdEndTime = Date.now();
          deactivatePrimeSessionSheet();
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

  // ─── POLLING & INITIALIZATION ─────
  let pollingInterval = null;

  function startPolling() {
    if (pollingInterval) safeClearInterval(pollingInterval);
    pollingInterval = safeSetInterval(handlePrimeAdAcceleration, CONFIG.checkIntervalMs);
  }

  function resetSession() {
    isAdActive = false;
    lastAdEndTime = 0;
    lastAcceleratedSrc = null;
    consecutiveFalseCount = 0;
    deactivatePrimeSessionSheet();
    if (adOverlayHost) adOverlayHost.classList.remove('active');
  }

  function init() {
    // 1. Initial check (might be ready if handshake was fast)
    if (window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.config) {
      applyConfig(window.__CHROMA_INTERNAL__.config);
    }

    // 2. Listen for the handshake completion (THE PRIMARY ACTIVATION TRIGGER)

    // Handle SPA transitions
    API.addEventListener('popstate', resetSession);
    API.addEventListener('hashchange', resetSession);
    API.addDocEventListener('atv-navigation-complete', resetSession);

    // 3. SECURE START: If we already have config, start. Otherwise, wait for handshake.
    if (CONFIG.enabled && CONFIG.acceleration) {
      ensurePrimeSessionSheet();
      startPolling();
    } else {
      // Safety Fallback: Poll for isolated-world sentinel before activating.
      let _pollCount = 0;
      const _pollId = safeSetInterval(() => {
        const initDone = !!window.__CHROMA_INTERNAL__ || _extInitFired;
        _pollCount++;

        if (initDone) {
          safeClearInterval(_pollId);
          if (window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.config) {
            applyConfig(window.__CHROMA_INTERNAL__.config);
          }
          if (!_chromaExtInitActive) return;
          if (CONFIG.enabled && CONFIG.acceleration) {
            ensurePrimeSessionSheet();
            startPolling();
          } else if (_extInitFired && _chromaExtInitActive) {
            CONFIG.enabled = true;
            ensurePrimeSessionSheet();
            startPolling();
          }
        } else if (_pollCount >= 40) {
          safeClearInterval(_pollId);
        }
      }, 50); // Polling frequency (50ms) for initialization check
    }
  }

  // Listen for config updates via custom event from handshake logic
  API.addDocEventListener('__CHROMA_CONFIG_UPDATE__', (e) => {
    if (e.detail) {
      // SECURITY: Validating update keys against a strict allowlist.
      applyConfig(e.detail);

      if (DEBUG) console.log('[Chroma] Prime handler updated config:', CONFIG);
    
      if (!CONFIG.enabled || !CONFIG.acceleration) {
        if (pollingInterval) {
          safeClearInterval(pollingInterval);
          pollingInterval = null;
        }
        if (targetVideo && isAdActive) {
          targetVideo.playbackRate = 1;
          targetVideo.volume = savedVolume;
          targetVideo.muted = false;
        }
        isAdActive = false;
        deactivatePrimeSessionSheet();
        if (adOverlayHost) adOverlayHost.classList.remove('active');
      } else {
        ensurePrimeSessionSheet();
        startPolling();
      }
    }
  });

  init();

  // ─── TESTING EXPORTS ─────
  if (typeof globalThis !== 'undefined' && globalThis.__CHROMA_INTERNAL_TEST_STRICT__ === true) {
    globalThis.CONFIG = CONFIG;
    globalThis.handlePrimeAdAcceleration = handlePrimeAdAcceleration;
    globalThis.isAdShowing = isAdShowing;
  
    // Test hook: exposes internal state to the Node vm test harness.
    globalThis.__CHROMA_STATE_BRIDGE__ = {
      get isAdActive() { return isAdActive; },
      set isAdActive(v) { isAdActive = v; }
    };
  }
})();
