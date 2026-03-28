(function() {
  'use strict';

  const DEBUG = false;

  // ─── CONFIG ──────────────────────────────────────────────────────────────────
  // Use Object.create(null) to protect against Prototype Pollution
  const CONFIG = Object.create(null);
  Object.assign(CONFIG, {
    enabled: false, // Default to disabled until handshake (KILL SWITCH)
    acceleration: false,
    accelerationSpeed: 16,
    checkIntervalMs: 300,
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
                removeDocEventListener: document.removeEventListener.bind(document)
              };

  const qS = (s) => API.querySelector(s);
  const cE = (t) => API.createElement(t);
  const sI = (f, t) => API.setInterval(f, t);
  const cI = (i) => API.clearInterval(i);

  // ─── STATE ────────────────────────────────────────────────────────────────────
  let targetAdVideo = null;
  let adOverlayHost = null; // The Shadow Host
  let adOverlayRoot = null; // The Closed Shadow Root

  // ─── AD ACCELERATION ─────────────────────────────────────────────────────────
  function initAdOverlay() {
    if (adOverlayHost) return;
    
    adOverlayHost = cE('div');
    // Randomized stable ID to avoid clobbering but remain targetable by extension logic if needed
    adOverlayHost.id = 'yt-chroma-host-' + Math.random().toString(36).substring(2, 9);
    
    // Create a CLOSED shadow root for maximum isolation (VULN-06)
    adOverlayRoot = adOverlayHost.attachShadow({ mode: 'closed' });
    
    // Inject Styles into ShadowRoot
    const style = cE('style');
    style.textContent = `
      :host {
        position: absolute !important;
        top: 0 !important; left: 0 !important; 
        width: 100% !important; height: 100% !important;
        background: rgba(15, 15, 18, 0.8) !important;
        backdrop-filter: blur(12px) !important;
        z-index: 2147483640 !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        color: white !important;
        font-family: 'YouTube Noto', Roboto, Arial, sans-serif !important;
        opacity: 0 !important;
        transition: opacity 0.2s ease !important;
        pointer-events: none !important;
      }
      :host(.active) {
        opacity: 1 !important;
        pointer-events: all !important;
      }
      .chroma-spinner {
        width: 48px; height: 48px;
        border: 4px solid rgba(255,255,255,0.1);
        border-top-color: var(--chroma-color, #ff0055);
        border-radius: 50%;
        animation: chroma-spin 1s linear infinite;
        margin-bottom: 20px;
      }
      @keyframes chroma-spin { 100% { transform: rotate(360deg); } }
      .chroma-checkmark {
        width: 48px; height: 48px;
        border: 4px solid var(--chroma-color, #ff0055);
        border-radius: 50%;
        margin-bottom: 20px;
        position: relative;
      }
      .chroma-checkmark::after {
        content: '';
        position: absolute;
        top: 6px; left: 16px;
        width: 10px; height: 20px;
        border: solid var(--chroma-color, #ff0055);
        border-width: 0 4px 4px 0;
        transform: rotate(45deg);
      }
      .chroma-title {
        font-size: 24px; font-weight: 600; margin-bottom: 8px;
        text-shadow: 0 2px 12px rgba(0,0,0,0.8);
      }
      .chroma-subtitle {
        font-size: 15px; color: #eee;
        position: absolute;
        bottom: 18%;
        text-shadow: 0 1px 4px rgba(0,0,0,0.5);
      }
      .chroma-progress-container {
        position: absolute;
        bottom: 0;
        left: 0;
        width: 100%;
        height: 2px;
        background: rgba(255, 255, 255, 0.1);
        overflow: hidden;
      }
      .chroma-progress-bar {
        height: 100%;
        width: 0%;
        background: var(--chroma-color, #ff0055);
        transition: width 0.2s linear, background 0.15s linear;
        box-shadow: 0 0 12px var(--chroma-color-alpha, rgba(255, 0, 85, 0.4));
      }
    `;
    
    const spinner = cE('div');
    spinner.className = 'chroma-spinner';
    
    const title = cE('div');
    title.className = 'chroma-title';
    title.textContent = 'Chroma Active';
    
    const subtitle = cE('div');
    subtitle.className = 'chroma-subtitle';
    subtitle.textContent = 'Accelerating Ad...';

    const progressContainer = cE('div');
    progressContainer.className = 'chroma-progress-container';
    
    const progressBar = cE('div');
    progressBar.className = 'chroma-progress-bar';
    progressContainer.appendChild(progressBar);
    
    adOverlayRoot.appendChild(style);
    adOverlayRoot.appendChild(spinner);
    adOverlayRoot.appendChild(title);
    adOverlayRoot.appendChild(subtitle);
    adOverlayRoot.appendChild(progressContainer);

    const playerContainer = qS('.html5-video-player') || qS('#movie_player');
    if (playerContainer && !playerContainer.contains(adOverlayHost)) {
      playerContainer.appendChild(adOverlayHost);
    }
  }

  function updateAdOverlay(video, effectiveAdShowing, rawAdShowing, adUIElement = null) {
    if (!CONFIG.acceleration || !effectiveAdShowing) {
      if (adOverlayHost && adOverlayHost.classList.contains('active')) {
        adOverlayHost.classList.remove('active');
        
        // --- NEW: Update stats when overlay turns OFF ---
        if (window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.send) {
          window.__CHROMA_INTERNAL__.send({ 
            action: 'STATS_UPDATE', 
            payload: { type: 'accelerated' } 
          });
        }
        
        window.cachedCurrentAd = 1;
        window.cachedTotalAds = 1;
        window.lastVideoDuration = 0;
      }
      return;
    }
    
    if (!adOverlayHost) {
      initAdOverlay();
    }

    const playerContainer = video.closest('.html5-video-player') || video.parentElement;
    if (playerContainer && !playerContainer.contains(adOverlayHost)) {
      playerContainer.appendChild(adOverlayHost);
    }
    
    if (!adOverlayHost.classList.contains('active')) {
      adOverlayHost.classList.add('active');
    }
    
    if (typeof window.cachedCurrentAd === 'undefined') {
      window.cachedCurrentAd = 1;
      window.cachedTotalAds = 1;
      window.lastVideoDuration = 0;
    }

    if (rawAdShowing) {
      if (video && video.duration > 0) {
        if (window.lastVideoDuration > 0 && Math.abs(video.duration - window.lastVideoDuration) > 1) {
          if (window.cachedCurrentAd < window.cachedTotalAds) {
            window.cachedCurrentAd++;
          }
        }
        window.lastVideoDuration = video.duration;
      }

      const adTextSource = adUIElement || playerContainer;
      if (adTextSource) {
        const playerText = adTextSource.textContent || '';
        const parsedTextMatch = playerText.match(/(?:[^\d]|^)([0-9]+)\s*(?:of|de|sur|out of|von|di)\s*([0-9]+)(?:[^\d]|$)/i);
        if (parsedTextMatch) {
          const parsedCurrent = parseInt(parsedTextMatch[1], 10);
          const parsedTotal = parseInt(parsedTextMatch[2], 10);
          if (parsedTotal > 1 && parsedCurrent <= parsedTotal) {
            window.cachedCurrentAd = Math.max(window.cachedCurrentAd, parsedCurrent);
            window.cachedTotalAds = Math.max(window.cachedTotalAds, parsedTotal);
          }
        }
      }
    }

    const isOnFinalAd = window.cachedCurrentAd >= window.cachedTotalAds;
    const isAdMediaFinished = video && video.duration > 0 && (video.duration - video.currentTime < 0.5);
    
    const isAdsDone = (isOnFinalAd && (!rawAdShowing || isAdMediaFinished)) || window.chromaAdSkipped;
    
    const spinner = adOverlayRoot.querySelector('.chroma-spinner, .chroma-checkmark');
    const titleEl = adOverlayRoot.querySelector('.chroma-title');
    const subtitleEl = adOverlayRoot.querySelector('.chroma-subtitle');
    const progressBar = adOverlayRoot.querySelector('.chroma-progress-bar');

    if (isAdsDone) {
      if (spinner && spinner.className !== 'chroma-checkmark') spinner.className = 'chroma-checkmark';
      if (titleEl) titleEl.textContent = 'Ads Cleared';
      if (subtitleEl) subtitleEl.textContent = 'Loading Video...';
      
      if (progressBar) progressBar.style.width = '100%';
    } else {
      if (spinner && spinner.className !== 'chroma-spinner') spinner.className = 'chroma-spinner';
      if (titleEl) titleEl.textContent = 'Chroma Active';
      
      if (subtitleEl) {
        if (window.cachedTotalAds > 1) {
          subtitleEl.textContent = `Accelerating Ad (${window.cachedCurrentAd} of ${window.cachedTotalAds})...`;
        } else {
          subtitleEl.textContent = 'Accelerating Ad...';
        }
      }

      if (video && video.duration > 0 && rawAdShowing) {
        let videoPercent = (video.currentTime / video.duration) * 100;
        if (videoPercent > 100) videoPercent = 100;
        
        let totalPercent = videoPercent;
        if (window.cachedTotalAds > 1 && window.cachedCurrentAd <= window.cachedTotalAds) {
          const segmentSize = 100 / window.cachedTotalAds;
          const basePercent = (window.cachedCurrentAd - 1) * segmentSize;
          totalPercent = basePercent + (videoPercent / window.cachedTotalAds);
        }
        
        if (progressBar) progressBar.style.width = `${totalPercent}%`;
      }
    }
  }

  const enforceMuteHandler = () => {
    if (window.chromaAdSessionActive && targetAdVideo) {
      if (!targetAdVideo.muted) {
        targetAdVideo.muted = true;
      }
      if (targetAdVideo.volume > 0) {
        targetAdVideo.volume = 0;
      }
    }
  };

  function cleanupVideoState() {
    if (!targetAdVideo) return;

    try {
      targetAdVideo.removeEventListener('volumechange', enforceMuteHandler);
      targetAdVideo.removeEventListener('play', enforceMuteHandler);

      delete targetAdVideo.dataset.chromaListenersAdded;
      delete targetAdVideo.dataset.ytChromaMuted;
      delete targetAdVideo.dataset.ytChromaVolume;

      targetAdVideo = null;
    } catch (err) {
      if (DEBUG) console.warn('[Chroma Ad-Blocker] Error during video cleanup:', err);
    }
  }

  function handleAdAcceleration() {
    if (!CONFIG.enabled || !CONFIG.acceleration) return;

    let currentAdVideo = qS('.video-ads video, .ytp-ad-module video');
    let hasAdUI = qS(
      '.ytp-ad-simple-ad-badge, .ytp-ad-duration-remaining, .ytp-ad-text, .ytp-ad-preview-text, .ytp-ad-visit-advertiser-button'
    );

    if (!currentAdVideo) {
      const adPlayer = qS('.html5-video-player.ad-showing, .html5-video-player.ad-interrupting');
      if (adPlayer) {
        currentAdVideo = adPlayer.querySelector('video');
      }
    }

    let rawAdShowing = !!currentAdVideo;

    if (!rawAdShowing && hasAdUI) {
      currentAdVideo = qS('#movie_player video, .html5-main-video');
      rawAdShowing = !!currentAdVideo;
    }

    const video = currentAdVideo || targetAdVideo || qS('#movie_player video, .html5-main-video');
    if (!video) return;

    if (rawAdShowing && currentAdVideo) {
      targetAdVideo = currentAdVideo;
    }

    if (typeof window.chromaAdSkipped === 'undefined') window.chromaAdSkipped = false;
    if (typeof window.chromaAdSessionActive === 'undefined') window.chromaAdSessionActive = false;
    
    if (rawAdShowing) {
      if (!window.chromaAdSessionActive) {
        if (DEBUG) console.log('[Chroma Ad-Blocker] Ad Session Detected');
        window.chromaAdSkipped = false; 
        startFastAdWatcher(); 
        startChromaClock(); 
      }
      window.chromaAdSessionActive = true;
      window.lastAdDetectTime = Date.now();
    }

    if (!rawAdShowing) {
      const timeSinceAd = Date.now() - window.lastAdDetectTime;
      if (timeSinceAd > 500) {
        const isMainVideoReady = video && video.readyState >= 3 && !video.paused && video.currentTime > 0;
        if (isMainVideoReady || timeSinceAd > 5000) {
          window.chromaAdSessionActive = false;
        }
      }
    }
    
    if (window.chromaAdSessionActive) {
      document.body.classList.add('chroma-session-active');
    } else {
      document.body.classList.remove('chroma-session-active');
    }
    
    updateAdOverlay(video, window.chromaAdSessionActive, rawAdShowing, hasAdUI);

    if (!video.dataset.chromaListenersAdded) {
      video.dataset.chromaListenersAdded = 'true';
      video.addEventListener('volumechange', enforceMuteHandler);
      video.addEventListener('play', enforceMuteHandler);
    }

    if (window.chromaAdSessionActive) {
      if (!video.muted) {
        video.muted = true;
      }
      if (video.volume > 0) {
        if (!video.dataset.ytChromaVolume) {
          video.dataset.ytChromaVolume = video.volume;
        }
        video.volume = 0;
      }
      
      if (rawAdShowing && video.playbackRate !== CONFIG.accelerationSpeed) {
        video.playbackRate = CONFIG.accelerationSpeed;
      }
    } else {
      if (video.muted && video.dataset.ytChromaMuted === 'true') {
        video.muted = false;
      }
      if (video.dataset.ytChromaVolume !== undefined) {
        const restoredVol = parseFloat(video.dataset.ytChromaVolume);
        if (restoredVol > 0) {
          video.volume = restoredVol;
        }
        delete video.dataset.ytChromaVolume;
      }
      if (video.playbackRate === CONFIG.accelerationSpeed) {
        video.playbackRate = 1;
      }
    }

    if (window.chromaAdSessionActive) {
      video.dataset.ytChromaMuted = 'true';
    } else {
      delete video.dataset.ytChromaMuted;
    }
  }

  let pollingInterval = null;

  function startPolling() {
    if (pollingInterval) cI(pollingInterval);
    pollingInterval = sI(handleAdAcceleration, CONFIG.checkIntervalMs);
  }

  sI(() => {
    if (!CONFIG.enabled || !CONFIG.acceleration) return;
    if (!pollingInterval) {
      startPolling();
    }
  }, 5000);

  function onYTNavigate() {
    cleanupVideoState();
    window.chromaAdSessionActive = false;
    window.chromaAdSkipped = false;
    window.lastAdDetectTime = 0;
    window.cachedCurrentAd = 1;
    window.cachedTotalAds = 1;

    startPolling();
  }

  API.addDocEventListener('yt-navigate-finish', onYTNavigate);
  API.addDocEventListener('yt-page-data-updated', onYTNavigate);

  // We now handle config updates via a custom event from interceptor.js or direct property update
  API.addDocEventListener('__CHROMA_CONFIG_UPDATE__', (e) => {
    if (e.detail) {
      Object.assign(CONFIG, e.detail);
      if (DEBUG) console.log('[Chroma] yt_handler updated config:', CONFIG);
      
      if (!CONFIG.enabled || !CONFIG.acceleration) {
        if (pollingInterval) {
          cI(pollingInterval);
          pollingInterval = null;
        }
        
        if (targetAdVideo) {
          if (targetAdVideo.playbackRate === CONFIG.accelerationSpeed) {
            targetAdVideo.playbackRate = 1;
          }
          if (targetAdVideo.muted && targetAdVideo.dataset.ytChromaMuted === 'true') {
            targetAdVideo.muted = false;
            if (targetAdVideo.dataset.ytChromaVolume !== undefined) {
              targetAdVideo.volume = parseFloat(targetAdVideo.dataset.ytChromaVolume) || 1;
            }
          }
        }
        
        const overlay = adOverlayHost;
        if (overlay) overlay.classList.remove('active');
        
        window.chromaAdSessionActive = false;
        window._chromaFastWatcher = false;
        cleanupVideoState();
        
      } else {
        injectChromaCSS();
        startPolling();
      }
    }
  });

  function initSkipButtonListener() {
    API.addDocEventListener('click', (e) => {
      if (!window.chromaAdSessionActive) return;
      if (!e || !e.target || typeof e.target.closest !== 'function') return;

      try {
        const skipButton = e.target.closest([
          '.ytp-ad-skip-button-container',
          '.ytp-ad-skip-button-slot',
          '.ytp-skip-ad-button',
          '.videoAdUiSkipButton',
          '[id^="skip-button:"]'
        ].join(','));

        if (skipButton) {
          window.chromaAdSkipped = true;
          if (targetAdVideo) {
            const rawAdShowing = document.getElementsByClassName('ad-showing').length > 0;
            updateAdOverlay(targetAdVideo, true, rawAdShowing);
          }
        }
      } catch (err) {
        if (DEBUG) console.warn('[Chroma Ad-Blocker] Error in skip button listener:', err);
      }
    }, true);
  }

  function startFastAdWatcher() {
    if (window._chromaFastWatcher) return;
    window._chromaFastWatcher = true;

    function check() {
      if (!window.chromaAdSessionActive) {
        window._chromaFastWatcher = false;
        return;
      }
      handleAdAcceleration();
      requestAnimationFrame(check);
    }
    requestAnimationFrame(check);
  }

  const CHROMA_CYCLE_MS = 8000;
  let chromaClockRunning = false;

  function startChromaClock() {
    if (chromaClockRunning) return;
    chromaClockRunning = true;

    function tick() {
      if (!window.chromaAdSessionActive) {
        chromaClockRunning = false;
        return;
      }

      const t = (Date.now() % CHROMA_CYCLE_MS) / CHROMA_CYCLE_MS;
      if (typeof window.calculateChromaColor !== 'function') {
        const root = document.documentElement;
        root.style.setProperty('--chroma-color', `rgb(255,0,85)`);
        root.style.setProperty('--chroma-color-alpha', `rgba(255,0,85,0.3)`);
        requestAnimationFrame(tick);
        return;
      }
      const [r, g, b] = window.calculateChromaColor(t);

      const root = document.documentElement;
      root.style.setProperty('--chroma-color', `rgb(${r},${g},${b})`);
      root.style.setProperty('--chroma-color-alpha', `rgba(${r},${g},${b},0.3)`);

      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function injectChromaCSS() {
    if (API.getElementById('yt-chroma-acceleration')) return;
    const style = cE('style');
    style.id = 'yt-chroma-acceleration';
    style.textContent = `
      body.chroma-session-active .ytp-ad-skip-button-container,
      body.chroma-session-active .ytp-ad-skip-button-slot,
      body.chroma-session-active .ytp-skip-ad-button,
      body.chroma-session-active .videoAdUiSkipButton,
      body.chroma-session-active [id^="skip-button:"] {
        border: 1.5px solid var(--chroma-color, #ff0055) !important;
        border-radius: 24px !important;
        box-shadow: 0 0 15px var(--chroma-color-alpha, rgba(255,0,85,0.4)), 
                    inset 0 0 6px var(--chroma-color-alpha, rgba(255,0,85,0.2)) !important;
        transition: border-color 0.15s linear, box-shadow 0.15s linear !important;
        overflow: hidden !important;
      }
      
      body.chroma-session-active .html5-video-player.ytp-autohide .ytp-chrome-bottom,
      body.chroma-session-active .html5-video-player .ytp-chrome-bottom {
        opacity: 1 !important;
        visibility: visible !important;
      }
      
      body.chroma-session-active .ytp-play-progress,
      body.chroma-session-active .ytp-load-progress,
      body.chroma-session-active .ytp-ad-progress-list,
      body.chroma-session-active .ytp-hover-progress {
        opacity: 0 !important;
        visibility: hidden !important;
      }
      
      #yt-chroma-overlay {
        position: absolute;
        top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(15, 15, 18, 0.8);
        backdrop-filter: blur(12px);
        z-index: 999999;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        color: white;
        font-family: 'YouTube Noto', Roboto, Arial, sans-serif;
        opacity: 0;
        transition: opacity 0.2s ease;
        pointer-events: none;
      }
      #yt-chroma-overlay.active {
        opacity: 1;
        pointer-events: all;
      }
      .chroma-spinner {
        width: 48px; height: 48px;
        border: 4px solid rgba(255,255,255,0.1);
        border-top-color: var(--chroma-color, #ff0055);
        border-radius: 50%;
        animation: chroma-spin 1s linear infinite;
        margin-bottom: 20px;
      }
      @keyframes chroma-spin { 100% { transform: rotate(360deg); } }
      
      .chroma-checkmark {
        width: 48px; height: 48px;
        border: 4px solid var(--chroma-color, #ff0055);
        border-radius: 50%;
        margin-bottom: 20px;
        position: relative;
      }
      .chroma-checkmark::after {
        content: '';
        position: absolute;
        top: 6px; left: 16px;
        width: 10px; height: 20px;
        border: solid var(--chroma-color, #ff0055);
        border-width: 0 4px 4px 0;
        transform: rotate(45deg);
      }
      
      .chroma-title {
        font-size: 24px; font-weight: 600; margin-bottom: 8px;
        text-shadow: 0 2px 12px rgba(0,0,0,0.8);
      }
      .chroma-subtitle {
        font-size: 15px; color: #eee;
        position: absolute;
        bottom: 18%;
        text-shadow: 0 1px 4px rgba(0,0,0,0.5);
      }
    `;
    // Prevent the 'style' variable reference from being reassigned.
    try {
      Object.freeze(style);
    } catch (e) {}
    (document.head || document.documentElement).appendChild(style);
  }


function init() {
    // 0. Whitelist shortcut for MAIN world
    if (document.documentElement.getAttribute('data-chroma-whitelisted') === 'true') {
      if (DEBUG) console.log('[Chroma] YouTube handler disabled by whitelist.');
      return;
    }

    // 1. Initial check (might be ready if script is deferred or loaded slowly)
    if (window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.config) {
      // Safely merge config from the secure pipe
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
        if (DEBUG) console.log('[Chroma] YouTube handler activated via handshake:', CONFIG);
        
        if (CONFIG.enabled && !pollingInterval) {
          startPolling();
          startChromaClock();
          initSkipButtonListener();
        }
      }
    });

    // 3. SECURE START: If we already have config, start. Otherwise, wait for handshake.
    if (CONFIG.enabled) {
      injectChromaCSS();
      startPolling();
      startChromaClock();
      initSkipButtonListener();
    } else {
      // 4. SAFETY FALLBACK: If handshake fails to arrive but site is NOT whitelisted
      // and we are NOT in a compromised environment, we wake up after a delay.
      setTimeout(() => {
        if (!CONFIG.enabled && !document.documentElement.getAttribute('data-chroma-whitelisted')) {
          if (DEBUG) console.log('[Chroma] Handshake timeout. Waking up YouTube handler with defaults.');
          CONFIG.enabled = true;
          CONFIG.acceleration = true;
          injectChromaCSS();
          startPolling();
          startChromaClock();
          initSkipButtonListener();
        }
      }, 1200);
    }
  }

  init();

  // ─── TESTING EXPORTS ────────────────────────────────────────────────────────
  if (typeof globalThis !== 'undefined' && globalThis.__TESTING__) {
    globalThis.CONFIG = CONFIG;
    if (typeof window.MSG !== "undefined") globalThis.MSG = window.MSG;
    globalThis.initAdOverlay = initAdOverlay;
    globalThis.handleAdAcceleration = handleAdAcceleration;
    globalThis.updateAdOverlay = updateAdOverlay;
    globalThis.cleanupVideoState = cleanupVideoState;
    globalThis.notifyBackground = notifyBackground;
  }
})();
