(function() {
  'use strict';

  const DEBUG = false;

  // ─── CONFIG ──────────────────────────────────────────────────────────────────
  const CONFIG = {
    enabled: true,
    acceleration: true,
    accelerationSpeed: 16,
    checkIntervalMs: 300,
  };

  // ─── STATE ────────────────────────────────────────────────────────────────────
  let stats = { accelerated: 0 };
  let targetAdVideo = null;
  let adOverlay = null;

  // ─── AD ACCELERATION ─────────────────────────────────────────────────────────
  function initAdOverlay() {
    if (document.getElementById('yt-chroma-overlay')) return;
    
    adOverlay = document.createElement('div');
    adOverlay.id = 'yt-chroma-overlay';
    
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

    const playerContainer = document.querySelector('.html5-video-player') || document.querySelector('#movie_player');
    if (playerContainer && !playerContainer.contains(adOverlay)) {
      playerContainer.appendChild(adOverlay);
    }
  }

  function updateAdOverlay(video, effectiveAdShowing, rawAdShowing) {
    if (!CONFIG.acceleration || !effectiveAdShowing) {
      if (adOverlay && adOverlay.classList.contains('active')) {
        adOverlay.classList.remove('active');
        window.cachedCurrentAd = 1;
        window.cachedTotalAds = 1;
        window.lastVideoDuration = 0;
      }
      return;
    }
    
    if (!adOverlay) {
      initAdOverlay();
    }

    const playerContainer = video.closest('.html5-video-player') || video.parentElement;
    if (playerContainer && !playerContainer.contains(adOverlay)) {
      playerContainer.appendChild(adOverlay);
    }
    
    if (!adOverlay.classList.contains('active')) {
      adOverlay.classList.add('active');
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

      if (playerContainer) {
        const playerText = playerContainer.textContent || '';
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
    
    const spinner = adOverlay.querySelector('.chroma-spinner, .chroma-checkmark');
    const titleEl = adOverlay.querySelector('.chroma-title');
    const subtitleEl = adOverlay.querySelector('.chroma-subtitle');

    if (isAdsDone) {
      if (spinner && spinner.className !== 'chroma-checkmark') spinner.className = 'chroma-checkmark';
      if (titleEl) titleEl.textContent = 'Ads Cleared';
      if (subtitleEl) subtitleEl.textContent = 'Loading Video...';
      
      const nativeProgressBar = document.querySelector('.chroma-native-progress');
      if (nativeProgressBar) nativeProgressBar.style.width = '100%';
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
        
        const nativeProgressBar = document.querySelector('.chroma-native-progress');
        if (nativeProgressBar) nativeProgressBar.style.width = `${totalPercent}%`;
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

    let currentAdVideo = document.querySelector('.video-ads video, .ytp-ad-module video');

    if (!currentAdVideo) {
      const adPlayer = document.querySelector('.html5-video-player.ad-showing, .html5-video-player.ad-interrupting');
      if (adPlayer) {
        currentAdVideo = adPlayer.querySelector('video');
      }
    }

    let rawAdShowing = !!currentAdVideo;

    if (!rawAdShowing) {
      const hasAdUI = document.querySelector(
        '.ytp-ad-simple-ad-badge, .ytp-ad-duration-remaining, .ytp-ad-text, .ytp-ad-preview-text, .ytp-ad-visit-advertiser-button'
      );
      if (hasAdUI) {
        currentAdVideo = document.querySelector('#movie_player video, .html5-main-video');
        rawAdShowing = !!currentAdVideo;
      }
    }

    const video = currentAdVideo || targetAdVideo || document.querySelector('#movie_player video, .html5-main-video');
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
      let nativeProgressBar = document.querySelector('.chroma-native-progress');
      if (!nativeProgressBar) {
        const ytpProgressBar = document.querySelector('.ytp-progress-bar');
        if (ytpProgressBar) {
          nativeProgressBar = document.createElement('div');
          nativeProgressBar.className = 'chroma-native-progress';
          ytpProgressBar.appendChild(nativeProgressBar);
        }
      }
    } else {
      document.body.classList.remove('chroma-session-active');
    }

    updateAdOverlay(video, window.chromaAdSessionActive, rawAdShowing);

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
        if (window.lastAcceleratedSrc !== video.src) {
          stats.accelerated++;
          notifyBackground({ type: MSG.STATS_UPDATE, stats: { accelerated: 1 } });
          window.lastAcceleratedSrc = video.src;
        }
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
    if (pollingInterval) clearInterval(pollingInterval);
    pollingInterval = setInterval(handleAdAcceleration, CONFIG.checkIntervalMs);
  }

  setInterval(() => {
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

  document.addEventListener('yt-navigate-finish', onYTNavigate);
  document.addEventListener('yt-page-data-updated', onYTNavigate);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === MSG.CONFIG_UPDATE) {
      Object.assign(CONFIG, msg.config);
      
      if (!CONFIG.enabled || !CONFIG.acceleration) {
        if (pollingInterval) {
          clearInterval(pollingInterval);
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
        
        const overlay = document.getElementById('yt-chroma-overlay');
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
    document.addEventListener('click', (e) => {
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
      if (!window.chromaAdSessionActive) {
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

  function injectChromaCSS() {
    if (document.getElementById('yt-chroma-acceleration')) return;
    const style = document.createElement('style');
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

      .chroma-native-progress {
        display: none;
        position: absolute;
        bottom: 0; left: 0; height: 3px;
        z-index: 50;
        background: var(--chroma-color, #ff0055);
        transition: width 0.1s linear, height 0.1s ease, background 0.15s linear;
        pointer-events: none;
      }
      .ytp-chrome-bottom:hover .chroma-native-progress,
      .ytp-progress-bar-container:hover .chroma-native-progress {
        height: 5px;
      }
      body.chroma-session-active .chroma-native-progress {
        display: block;
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
    (document.head || document.documentElement).appendChild(style);
  }


  function init() {
    chrome.storage.local.get('config').then(({ config: savedConfig }) => {
      if (savedConfig) {
        Object.assign(CONFIG, savedConfig);
      }
      
      if (CONFIG.enabled && CONFIG.acceleration) {
        injectChromaCSS();
        startPolling();
        startChromaClock();
        initSkipButtonListener();
      }
    }).catch(() => {
      injectChromaCSS();
      startPolling();
    });
  }

  init();

  // ─── TESTING EXPORTS ────────────────────────────────────────────────────────
  if (typeof globalThis !== 'undefined' && globalThis.__TESTING__) {
    globalThis.CONFIG = CONFIG;
    if (typeof MSG !== "undefined") globalThis.MSG = MSG;
    globalThis.initAdOverlay = initAdOverlay;
    globalThis.handleAdAcceleration = handleAdAcceleration;
    globalThis.updateAdOverlay = updateAdOverlay;
    globalThis.cleanupVideoState = cleanupVideoState;
    globalThis.notifyBackground = notifyBackground;
  }
})();
