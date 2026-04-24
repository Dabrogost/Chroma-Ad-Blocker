/**
 * Chroma Ad-Blocker — YouTube Handler
 * 
 * Portions of the YouTube ad-stripping logic (specifically payload field pruning) 
 * are derived from Brave Browser's ad-blocking scriptlets and are subject to 
 * the Mozilla Public License, v. 2.0. You can obtain a copy of the MPL 2.0 
 * at https://mozilla.org/MPL/2.0/.
 */

(function() {
  'use strict';

  const DEBUG = false;

  // ─── CONFIG ─────
  // Use Object.create(null) to protect against Prototype Pollution
  const CONFIG = Object.create(null);
  Object.assign(CONFIG, {
    enabled: true, // Default to active; handshake will synchronize with user settings
    stripping: true,  // Primary: strip ad data from YouTube API responses before the player reads it
    acceleration: false,
    accelerationSpeed: 8, // Default playback rate supported for ad acceleration
    checkIntervalMs: 300,  // Interval between ad state checks (ms)
  });

  // Whitelist of allowed config keys for secure updates.
  // Mirror of prm_handler.js — the enabled / acceleration / accelerationSpeed /
  // checkIntervalMs validators are intentionally identical across both handlers;
  // keep structurally aligned when changing shared keys.
  const VALID_CONFIG_KEYS = ['enabled', 'stripping', 'acceleration', 'accelerationSpeed', 'checkIntervalMs'];

  const CONFIG_VALIDATORS = Object.freeze({
    enabled:           (v) => typeof v === 'boolean',
    stripping:         (v) => typeof v === 'boolean',
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

  // Returns true only when acceleration polling should run on YouTube.
  // When stripping is active it handles ad removal upstream, so polling is redundant.
  function shouldAccelerate() {
    return CONFIG.acceleration;
  }

  // ─── AD FIELD STRIPPING (PRIMARY BLOCKER) ─────
  // Deletes ad payload fields from YouTube API responses before the player reads them.
  // Native APIs are captured here — before the beacon suppression IIFE below patches XHR —
  // so the wrap order is: beacon suppression → our wrapper → native (correct chain).
  const AD_FIELDS = [
    'adPlacements',
    'adSlots',
    'playerAds',
    'adBreakParams',
    'adBreakHeartbeatParams',
    'adInferredBlockingStatus',
  ];

  function stripAdFields(obj) {
    if (!obj || typeof obj !== 'object') return false;
    let stripped = false;
    for (const field of AD_FIELDS) {
      if (field in obj) {
        delete obj[field];
        stripped = true;
      }
    }
    return stripped;
  }

  function stripResponseAds(data) {
    if (!data) return;
    try {
      const contents =
        data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
          ?.sectionListRenderer?.contents ||
        data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer
          ?.content?.richGridRenderer?.contents;
      if (Array.isArray(contents)) {
        for (let i = contents.length - 1; i >= 0; i--) {
          const item = contents[i];
          if (
            item?.promotedSparklesTextSearchRenderer ||
            item?.searchPyvRenderer ||
            item?.adSlotRenderer ||
            item?.richItemRenderer?.content?.adSlotRenderer
          ) {
            contents.splice(i, 1);
          }
        }
      }
    } catch (_) {}
  }

  // Hook ytInitialPlayerResponse — strips ad fields from the initial player payload
  // before YouTube's own scripts read the value.
  let _ytInitialPlayerResponse;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get() { return _ytInitialPlayerResponse; },
      set(value) {
        if (CONFIG.enabled && CONFIG.stripping && value && typeof value === 'object') {
          stripAdFields(value);
        }
        _ytInitialPlayerResponse = value;
      }
    });
  } catch (_) {}

  // Hook ytInitialData — strips ad fields and promoted feed items from page-level data.
  let _ytInitialData;
  try {
    Object.defineProperty(window, 'ytInitialData', {
      configurable: true,
      get() { return _ytInitialData; },
      set(value) {
        if (CONFIG.enabled && CONFIG.stripping && value && typeof value === 'object') {
          stripAdFields(value);
          stripResponseAds(value);
        }
        _ytInitialData = value;
      }
    });
  } catch (_) {}

  // Capture native fetch/XHR/JSON.parse before anything else in this file modifies them.
  const _nativeToString = Function.prototype.toString;
  const _nativeFetch = window.fetch;
  const _nativeXHROpen = XMLHttpRequest.prototype.open;
  const _nativeXHRSend = XMLHttpRequest.prototype.send;
  const _nativeJSONParse = JSON.parse;

  const YT_API_PATHS = [
    '/youtubei/v1/player',
    '/youtubei/v1/next',
    '/youtubei/v1/browse',
    '/youtubei/v1/search',
  ];

  // Fetch wrapper — intercepts YouTube API responses and strips ad fields before returning.
  window.fetch = async function(...args) {
    const response = await _nativeFetch.apply(this, args);
    if (!(CONFIG.enabled && CONFIG.stripping)) return response;

    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    if (YT_API_PATHS.some(p => url.includes(p))) {
      try {
        const clone = response.clone();
        const json = await clone.json();
        let modified = false;
        if (stripAdFields(json)) modified = true;
        if (json?.playerResponse && stripAdFields(json.playerResponse)) modified = true;
        stripResponseAds(json);
        if (modified) {
          return new Response(JSON.stringify(json), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
      } catch (_) {}
    }
    return response;
  };
  // Save reference before YouTube's scripts re-wrap window.fetch, so the
  // toString spoof can map our wrapper even after it's no longer the outermost fetch.
  const _ourFetch = window.fetch;

  // XHR wrapper — saves the request URL so the send wrapper can check it.
  // The beacon suppression IIFE (below) captures this as its _origOpen, giving the
  // correct chain: beacon suppression → this wrapper → native open.
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._chromaYTUrl = String(url);
    return _nativeXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    const url = this._chromaYTUrl || '';
    if (CONFIG.enabled && CONFIG.stripping && YT_API_PATHS.some(p => url.includes(p))) {
      this.addEventListener('readystatechange', function() {
        if (this.readyState !== 4) return;
        try {
          const rt = this.responseType;
          if (rt && rt !== '' && rt !== 'text' && rt !== 'json') return;
          const text = rt === 'json' ? JSON.stringify(this.response) : this.responseText;
          const json = _nativeJSONParse(text);
          if (stripAdFields(json)) {
            const stripped = JSON.stringify(json);
            Object.defineProperty(this, 'responseText', { value: stripped, writable: false });
            Object.defineProperty(this, 'response', {
              value: rt === 'json' ? json : stripped,
              writable: false
            });
          }
        } catch (_) {}
      });
    }
    return _nativeXHRSend.apply(this, args);
  };

  // JSON.parse catch-all — strips ad fields from every parsed object regardless of
  // how the bytes arrived (worker-side processing, batched RPC, etc.).
  JSON.parse = function(text, reviver) {
    const result = _nativeJSONParse.call(this, text, reviver);
    if (!(CONFIG.enabled && CONFIG.stripping)) return result;
    try {
      if (result && typeof result === 'object') {
        stripAdFields(result);
        if (result.playerResponse && typeof result.playerResponse === 'object') {
          stripAdFields(result.playerResponse);
        }
      }
    } catch (_) {}
    return result;
  };

  // Integrity Layer: Utilizing pre-cached native APIs from the secure bridge to bypass host-page prototype pollution.
  const API = (window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.api) ? 
              window.__CHROMA_INTERNAL__.api : 
              {
                querySelector: document.querySelector.bind(document),
                createElement: document.createElement.bind(document),
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
    if (e && e.detail) {
      if (e.detail.active === false) {
        _chromaExtInitActive = false;
        CONFIG.enabled = false;
      }
      if (e.detail.stripping !== undefined) CONFIG.stripping = e.detail.stripping;
      if (e.detail.acceleration !== undefined) CONFIG.acceleration = e.detail.acceleration;
    }

    // Late-arrival activation: If the init polling loop already timed out
    // (cold browser start where chrome.storage was slow), activate now.
    if (!pollingInterval && _chromaExtInitActive) {
      if (window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.config) {
        applyConfig(window.__CHROMA_INTERNAL__.config);
      }
      
      if (CONFIG.enabled && shouldAccelerate()) {
        injectChromaCSS();
        startPolling();
        initSkipButtonListener();
      }
    }
  }, true);

  // ─── STATE ─────
  let targetAdVideo = null;
  let adOverlayHost = null;
  let adOverlayRoot = null;
  let skipListenerAdded = false;

  let chromaAdSessionActive = false;
  let chromaAdSkipped = false;
  let lastAdDetectTime = 0;
  let cachedCurrentAd = 1;
  let cachedTotalAds = 1;
  let lastVideoDuration = 0;
  let _chromaFastWatcher = false;

  // Anti-Tamper: In-memory video state (invisible to page scripts, unlike dataset attributes)
  const videoState = new WeakMap();
  function getVideoState(video) {
    let s = videoState.get(video);
    if (!s) {
      s = { listenersAdded: false, chromaMuted: false, savedVolume: null };
      videoState.set(video, s);
    }
    return s;
  }

  // Anti-Detection: Session stylesheet toggle (replaces observable body class mutations)
  let sessionSheet = null;

  function ensureSessionSheet() {
    if (sessionSheet) return;
    sessionSheet = new CSSStyleSheet();
    sessionSheet.replaceSync(`
      .ytp-ad-player-overlay,
      .ytp-ad-player-overlay-instream-info {
        z-index: 2147483647 !important;
        pointer-events: none !important;
      }
      .ytp-ad-skip-button-container,
      .ytp-ad-skip-button-slot,
      .ytp-skip-ad-button,
      .videoAdUiSkipButton,
      [id^="skip-button:"] {
        z-index: 2147483647 !important;
        border: 1.5px solid #FE0034 !important;
        border-radius: 24px !important;
        box-shadow: 0 0 15px rgba(254, 0, 52, 0.4),
                    inset 0 0 6px rgba(254, 0, 52, 0.2) !important;
        transition: border-color 0.15s linear, box-shadow 0.15s linear !important;
        overflow: hidden !important;
      }
      .html5-video-player.ytp-autohide .ytp-chrome-bottom,
      .html5-video-player .ytp-chrome-bottom {
        opacity: 1 !important;
        visibility: visible !important;
      }
      .ytp-play-progress,
      .ytp-load-progress,
      .ytp-ad-progress-list,
      .ytp-hover-progress {
        opacity: 0 !important;
        visibility: hidden !important;
      }
    `);
  }

  function activateSessionSheet() {
    ensureSessionSheet();
    const sheets = document.adoptedStyleSheets;
    if (!sheets.includes(sessionSheet)) {
      document.adoptedStyleSheets = [...sheets, sessionSheet];
    }
  }

  function deactivateSessionSheet() {
    if (!sessionSheet) return;
    const sheets = document.adoptedStyleSheets;
    if (sheets.includes(sessionSheet)) {
      document.adoptedStyleSheets = sheets.filter(s => s !== sessionSheet);
    }
  }

  // ─── ACTIVEVIEW / PTRACKING BEACON SUPPRESSION ─────
  // Suppresses activeview and ptracking beacons when no ad session is active,
  // preventing post-session observer floods. Beacons fire normally during
  // active ad playback.
  (function() {
    const _origOpen = XMLHttpRequest.prototype.open;

    XMLHttpRequest.prototype.open = function(method, url) {
      if (typeof url === 'string' &&
          !chromaAdSessionActive &&
          (url.includes('/pcs/activeview') || url.includes('/ptracking'))) {
        this._chromaSuppressed = true;
        return;
      }
      return _origOpen.apply(this, arguments);
    };

    const _origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function() {
      if (this._chromaSuppressed) return;
      return _origSend.apply(this, arguments);
    };
  })();

  // ─── TOSTRING SPOOFING ─────
  // Placed after beacon suppression so the Map captures the final XHR wrappers,
  // not the intermediate stripping wrappers that beacon suppression overlays.
  // fetch is omitted — YouTube's own scripts re-wrap window.fetch after document_start,
  // so we can't make their outer wrapper appear native (nor do we need to).
  (function() {
    const _targets = new Map([
      [_ourFetch,                       'function fetch() { [native code] }'],
      [XMLHttpRequest.prototype.open,   'function open() { [native code] }'],
      [XMLHttpRequest.prototype.send,   'function send() { [native code] }'],
      [JSON.parse,                      'function parse() { [native code] }'],
    ]);

    const _spoof = function toString() {
      if (_targets.has(this)) return _targets.get(this);
      return _nativeToString.call(this);
    };

    // Recursive protection: make the spoof's own toString return a native string.
    Object.defineProperty(_spoof, 'toString', {
      value: function() { return _nativeToString.call(_nativeToString); },
      writable: false,
      configurable: false,
    });

    Function.prototype.toString = _spoof;
  })();

  // ─── AD ACCELERATION ─────
  function initAdOverlay() {
    if (adOverlayHost) return;
    
    adOverlayHost = safeCreate('div');
    // SECURITY: Session Isolation (evade detector scripts)
    adOverlayHost.id = 'chroma-host-' + Math.random().toString(36).substring(2, 9); // Random 7-char suffix to evade detector scripts

    // SECURITY: Shadow DOM Lockdown (prevent host-page tampering)
    adOverlayRoot = adOverlayHost.attachShadow({ mode: 'closed' });
    
    const style = safeCreate('style');
    style.textContent = `
      :host {
        display: block !important;
        position: absolute !important;
        top: 0 !important; left: 0 !important; 
        width: 100% !important; height: 100% !important;
        z-index: 2147483640 !important; /* Below browser default z-index ceiling */
        pointer-events: none !important;
        contain: strict !important;
        margin: 0 !important; padding: 0 !important;
        box-sizing: border-box !important;
        
        /* UX: Visibility delay allows the 0.2s fade-out to complete before interaction handling is removed. */
        visibility: hidden !important;
        transition: visibility 0s 0.2s;
      }
      :host(.active) {
        visibility: visible !important;
        transition: none;
      }
      .chroma-screen {
        position: absolute !important;
        top: 0 !important; left: 0 !important;
        width: 100% !important; height: 100% !important;
        background: rgba(15, 15, 18, 0.8) !important;
        backdrop-filter: blur(12px) !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        color: white !important;
        font-family: 'YouTube Noto', Roboto, Arial, sans-serif !important;
        opacity: 0 !important;
        transition: opacity 0.2s ease !important;
        box-sizing: border-box !important;
        pointer-events: none !important;
      }
      :host(.active) .chroma-screen {
        opacity: 1 !important;
        pointer-events: all !important;
      }
      .chroma-spinner {
        width: 48px; height: 48px;
        border: 4px solid rgba(255,255,255,0.1) !important;
        border-top-color: #FE0034 !important;
        border-radius: 50% !important;
        animation: chroma-spin 1s linear infinite !important;
        margin-bottom: 20px !important;
      }
      @keyframes chroma-spin { 100% { transform: rotate(360deg); } }
      .chroma-checkmark {
        width: 48px; height: 48px;
        border: 4px solid #FE0034;
        border-radius: 50%;
        margin-bottom: 20px;
        position: relative;
      }
      .chroma-checkmark::after {
        content: '';
        position: absolute;
        top: 6px; left: 16px;
        width: 10px; height: 20px;
        border: solid #FE0034;
        border-width: 0 4px 4px 0;
        transform: rotate(45deg);
      }
      .chroma-title {
        font-size: 24px; font-weight: 600; margin-bottom: 8px;
        text-shadow: 0 2px 12px rgba(0,0,0,0.8);
      }
      .chroma-subtitle {
        font-size: 15px; color: #eee;
        text-shadow: 0 1px 4px rgba(0,0,0,0.5);
        margin-top: 8px !important;
        text-align: center !important;
        max-width: 80% !important;
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
        background: #FE0034;
        transition: width 0.2s linear, background 0.15s linear;
        box-shadow: 0 0 12px rgba(254, 0, 52, 0.4);
      }
    `;
    
    const screen = safeCreate('div');
    screen.className = 'chroma-screen';

    const spinner = safeCreate('div');
    spinner.className = 'chroma-spinner';
    
    const title = safeCreate('div');
    title.className = 'chroma-title';
    title.textContent = 'Chroma Active';
    
    const subtitle = safeCreate('div');
    subtitle.className = 'chroma-subtitle';
    subtitle.textContent = 'Accelerating Ad...';

    const progressContainer = safeCreate('div');
    progressContainer.className = 'chroma-progress-container';
    
    const progressBar = safeCreate('div');
    progressBar.className = 'chroma-progress-bar';
    progressContainer.appendChild(progressBar);
    
    screen.appendChild(spinner);
    screen.appendChild(title);
    screen.appendChild(subtitle);
    screen.appendChild(progressContainer);

    adOverlayRoot.appendChild(style);
    adOverlayRoot.appendChild(screen);

    const playerContainer = safeQuery('.html5-video-player') || safeQuery('#movie_player');
    if (playerContainer && !playerContainer.contains(adOverlayHost)) {
      playerContainer.appendChild(adOverlayHost);
    }
  }

  function updateAdOverlay(video, effectiveAdShowing, rawAdShowing, adUIElement = null) {
    if (!CONFIG.acceleration || !effectiveAdShowing) {
      if (adOverlayHost && adOverlayHost.classList.contains('active')) {
        adOverlayHost.classList.remove('active');
        
        cachedCurrentAd = 1;
        cachedTotalAds = 1;
        lastVideoDuration = 0;
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
    

    if (rawAdShowing) {
      if (video && video.duration > 0) {
        if (lastVideoDuration > 0 && Math.abs(video.duration - lastVideoDuration) > 1) {
          if (cachedCurrentAd < cachedTotalAds) {
            cachedCurrentAd++;
          }
        }
        lastVideoDuration = video.duration;
      }

      const adTextSource = adUIElement || playerContainer;
      if (adTextSource) {
        const playerText = adTextSource.textContent || '';
        // Pod Detection: Extracts 'current' and 'total' ad counts from localized UI strings (e.g., 'Ad 1 of 2') to track progress through multi-ad sequences.
        const parsedTextMatch = playerText.match(/(?:[^\d]|^)([0-9]+)\s*(?:of|de|sur|out of|von|di)\s*([0-9]+)(?:[^\d]|$)/i);
        if (parsedTextMatch) {
          const parsedCurrent = parseInt(parsedTextMatch[1], 10);
          const parsedTotal = parseInt(parsedTextMatch[2], 10);
          if (parsedTotal > 1 && parsedCurrent <= parsedTotal) {
            cachedCurrentAd = Math.max(cachedCurrentAd, parsedCurrent);
            cachedTotalAds = Math.max(cachedTotalAds, parsedTotal);
          }
        }
      }
    }

    // Heuristic completion check: Terminal state reached if the final ad in a sequence finishes or a manual skip is detected.
    const isOnFinalAd = (cachedCurrentAd || 1) >= (cachedTotalAds || 1);
    const isAdMediaFinished = video && video.duration > 0 && video.currentTime >= video.duration - 0.5; // 0.5s threshold accounts for imprecise ad media boundaries
    const isAdsDone = (isOnFinalAd && (!rawAdShowing || isAdMediaFinished)) || chromaAdSkipped;
    
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
        if (cachedTotalAds > 1) {
          subtitleEl.textContent = `Accelerating Ad (${cachedCurrentAd} of ${cachedTotalAds})...`;
        } else {
          subtitleEl.textContent = 'Accelerating Ad...';
        }
      }

      if (video && video.duration > 0 && rawAdShowing) {
        let videoPercent = (video.currentTime / video.duration) * 100;
        if (videoPercent > 100) videoPercent = 100;
        
        let totalPercent = videoPercent;
        if (cachedTotalAds > 1 && cachedCurrentAd <= cachedTotalAds) {
          const segmentSize = 100 / cachedTotalAds;
          const basePercent = (cachedCurrentAd - 1) * segmentSize;
          totalPercent = basePercent + (videoPercent / cachedTotalAds);
        }
        
        if (progressBar) progressBar.style.width = `${totalPercent}%`;
      }
    }
  }

  const enforceMuteHandler = () => {
    if (chromaAdSessionActive && targetAdVideo) {
      // Prevents the 'sticky mute' bug where content starts but the session hasn't cleared yet.
      const isAdDetected = safeQuery('.ad-showing, .ad-interrupting') || 
                          safeQuery('.ytp-ad-simple-ad-badge, .ytp-ad-duration-remaining, .ytp-ad-preview-text');
      
      if (!isAdDetected) {
        // If we are here, it means the event fired but we don't see an ad anymore.
        // We should trigger a state check to potentially end the session early.
        return;
      }

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

      const state = videoState.get(targetAdVideo);
      if (state) {
        state.listenersAdded = false;
        state.chromaMuted = false;
        state.savedVolume = null;
      }

      targetAdVideo = null;
    } catch (err) {
      if (DEBUG) console.warn('[Chroma Ad-Blocker] Error during video cleanup:', err);
    }
  }

  function handleAdAcceleration() {
    if (!CONFIG.enabled || !CONFIG.acceleration) return;

    let currentAdVideo = safeQuery('.video-ads video, .ytp-ad-module video');
    let hasAdUI = safeQuery(
      '.ytp-ad-simple-ad-badge, .ytp-ad-duration-remaining, .ytp-ad-text, .ytp-ad-preview-text, .ytp-ad-visit-advertiser-button'
    );

    if (!currentAdVideo) {
      const adPlayer = safeQuery('.html5-video-player.ad-showing, .html5-video-player.ad-interrupting');
      if (adPlayer) {
        currentAdVideo = adPlayer.querySelector('video');
      }
    }

    let rawAdShowing = !!currentAdVideo;

    if (!rawAdShowing && hasAdUI) {
      currentAdVideo = safeQuery('#movie_player video, .html5-main-video');
      rawAdShowing = !!currentAdVideo;
    }

    const video = currentAdVideo || targetAdVideo || safeQuery('#movie_player video, .html5-main-video');
    if (!video) return;

    if (rawAdShowing && currentAdVideo) {
      targetAdVideo = currentAdVideo;
    }

    
    if (rawAdShowing) {
      if (!chromaAdSessionActive) {
        if (DEBUG) console.log('[Chroma Ad-Blocker] Ad Session Detected');
        chromaAdSkipped = false;
        // Switches to rAF-synced watcher during active ads for frame-aligned acceleration and overlay updates.
        startFastAdWatcher(); 
      }
      chromaAdSessionActive = true;
      lastAdDetectTime = Date.now();
    }

    if (!rawAdShowing) {
      const now = Date.now();
      const timeSinceAd = lastAdDetectTime ? now - lastAdDetectTime : 0;
      const mainVideo = safeQuery('.html5-main-video');
      const isMainVideoReady = mainVideo && mainVideo.readyState >= 3;

      // Session release logic:
      if (isMainVideoReady || timeSinceAd > 5000) { // Normal release: main video ready; watchdog: force-release after 5000ms if video never becomes ready
        chromaAdSessionActive = false;
        targetAdVideo = null;
      }
    }
    
    if (chromaAdSessionActive) {
      activateSessionSheet();
    } else {
      deactivateSessionSheet();
    }
    
    updateAdOverlay(video, chromaAdSessionActive, rawAdShowing, hasAdUI);

    if (!getVideoState(video).listenersAdded) {
      getVideoState(video).listenersAdded = true;
      video.addEventListener('volumechange', enforceMuteHandler);
      video.addEventListener('play', enforceMuteHandler);
    }

    if (chromaAdSessionActive) {
      if (!video.muted) {
        video.muted = true;
      }
      if (video.volume > 0) {
        if (!getVideoState(video).savedVolume) {
          getVideoState(video).savedVolume = video.volume;
        }
        video.volume = 0;
      }
      
      if (rawAdShowing && video.playbackRate !== CONFIG.accelerationSpeed) {
        video.playbackRate = CONFIG.accelerationSpeed;
      }
      getVideoState(video).chromaMuted = true;
    } else {
      if (video.muted && getVideoState(video).chromaMuted) {
        video.muted = false;
      }
      const savedVol = getVideoState(video).savedVolume;
      if (savedVol != null) {
        if (savedVol > 0) {
          video.volume = savedVol;
        }
        getVideoState(video).savedVolume = null;
      }
      if (video.playbackRate === CONFIG.accelerationSpeed) {
        video.playbackRate = 1;
      }
      getVideoState(video).chromaMuted = false;
    }
  }

  let pollingInterval = null;

  function startPolling() {
    if (pollingInterval) safeClearInterval(pollingInterval);
    pollingInterval = safeSetInterval(handleAdAcceleration, CONFIG.checkIntervalMs);
  }

  // ─── NAVIGATION & EVENT HANDLERS ─────
  function onYTNavigate() {
    cleanupVideoState();
    chromaAdSessionActive = false;
    chromaAdSkipped = false;
    lastAdDetectTime = 0;
    cachedCurrentAd = 1;
    cachedTotalAds = 1;

    startPolling();
  }

  API.addDocEventListener('yt-navigate-finish', onYTNavigate);
  API.addDocEventListener('yt-page-data-updated', onYTNavigate);

  API.addDocEventListener('__CHROMA_CONFIG_UPDATE__', (e) => {
    if (e.detail) {
      // SECURITY: Configuration Validation Allowlist
      applyConfig(e.detail);

      if (DEBUG) console.log('[Chroma] YouTube handler updated config:', CONFIG);
      
      if (!CONFIG.enabled) {
        if (pollingInterval) {
          safeClearInterval(pollingInterval);
          pollingInterval = null;
        }
        
        if (targetAdVideo) {
          if (targetAdVideo.playbackRate === CONFIG.accelerationSpeed) {
            targetAdVideo.playbackRate = 1;
          }
          if (targetAdVideo.muted && getVideoState(targetAdVideo).chromaMuted) {
            targetAdVideo.muted = false;
            const savedVol = getVideoState(targetAdVideo).savedVolume;
            if (savedVol != null) {
              targetAdVideo.volume = savedVol > 0 ? savedVol : 1;
            }
          }
        }
        
        const overlay = adOverlayHost;
        if (overlay) overlay.classList.remove('active');
        
        chromaAdSessionActive = false;
        _chromaFastWatcher = false;
        deactivateSessionSheet();
        cleanupVideoState();
        
      }
      
      if (CONFIG.enabled && shouldAccelerate()) {
        injectChromaCSS();
        startPolling();
        initSkipButtonListener();
      } else if (pollingInterval) {
        safeClearInterval(pollingInterval);
        pollingInterval = null;
        if (adOverlayHost) adOverlayHost.classList.remove('active');
        deactivateSessionSheet();
      }
    }
  });

  function initSkipButtonListener() {
    if (skipListenerAdded) return;
    skipListenerAdded = true;

    API.addDocEventListener('click', (e) => {
      if (!chromaAdSessionActive) return;
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
          chromaAdSkipped = true;
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
    if (_chromaFastWatcher) return;
    _chromaFastWatcher = true;

    function check() {
      if (!chromaAdSessionActive) {
        _chromaFastWatcher = false;
        return;
      }
      handleAdAcceleration();
      requestAnimationFrame(check);
    }
    requestAnimationFrame(check);
  }

  // Convenience alias — ensures the session stylesheet object exists for later activation.
  function injectChromaCSS() {
    ensureSessionSheet();
  }

  function init() {
    // 1. Initial check (might be ready if script is deferred or loaded slowly)
    if (window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.config) {
      // SECURITY: Handshake Configuration Validation
      applyConfig(window.__CHROMA_INTERNAL__.config);
    }

    // If config is already available, start immediately. Otherwise, poll for handshake.
    if (CONFIG.enabled && shouldAccelerate()) {
      injectChromaCSS();
      startPolling();
      initSkipButtonListener();
    } else {
      // Safety Fallback: Poll for isolated-world sentinel before activating.
      let _pollCount = 0;
      const _pollId = API.setInterval(() => {
        const initDone = !!window.__CHROMA_INTERNAL__ || _extInitFired;
        _pollCount++;

        if (initDone) {
          API.clearInterval(_pollId);
          if (window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.config) {
            applyConfig(window.__CHROMA_INTERNAL__.config);
          }
          if (!_chromaExtInitActive) return;
          if (CONFIG.enabled && shouldAccelerate()) {
            injectChromaCSS();
            startPolling();
            initSkipButtonListener();
          }
        } else if (_pollCount >= 40) {
          API.clearInterval(_pollId);
        }
      }, 50); // Polling frequency (50ms) for initialization check
    }
  }

  init();

  // ─── TESTING EXPORTS ─────
  if (typeof globalThis !== 'undefined' && globalThis.__CHROMA_INTERNAL_TEST_STRICT__ === true) {
    globalThis.CONFIG = CONFIG;
    globalThis.stripAdFields = stripAdFields;
    globalThis.stripResponseAds = stripResponseAds;
    globalThis.shouldAccelerate = shouldAccelerate;
    globalThis.initAdOverlay = initAdOverlay;
    globalThis.handleAdAcceleration = handleAdAcceleration;
    
    // Test hook: exposes internal state to the Node vm test harness.
    globalThis.__CHROMA_STATE_BRIDGE__ = {
      get chromaAdSessionActive() { return chromaAdSessionActive; },
      set chromaAdSessionActive(v) { chromaAdSessionActive = v; },
      get chromaAdSkipped() { return chromaAdSkipped; },
      set chromaAdSkipped(v) { chromaAdSkipped = v; },
      get lastAdDetectTime() { return lastAdDetectTime; },
      set lastAdDetectTime(v) { lastAdDetectTime = v; }
    };
  }
})();
