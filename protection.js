/**
 * Chroma Ad-Blocker - Global Protection Script
 * Handles gesture tracking, message relay for pop-under attempts,
 * and push notification suppression across all websites.
 */

'use strict';

(function() {
  const DEBUG = false;

  const CONFIG = {
    blockPopUnders: true,
    blockPushNotifications: true,
    enabled: true
  };

  let lastUserGestureTime = 0;
  let lastUserGestureType = '';
  let popupCountInGesture = 0;

  /**
   * Track user gestures to distinguish between legitimate
   * user-initiated popups and automated pop-under ads.
   */
  function initGestureTracking() {
    const updateGesture = (e) => {
      const now = Date.now();
      if (now - lastUserGestureTime > 300) {
        popupCountInGesture = 0;
      }
      lastUserGestureTime = now;
      lastUserGestureType = e.type;
    };
    
    ['mousedown', 'mouseup', 'keydown', 'touchstart', 'touchend', 'click'].forEach(evt => {
      document.addEventListener(evt, updateGesture, { capture: true, passive: true });
      window.addEventListener(evt, updateGesture, { capture: true, passive: true });
    });

    // Intercept suspicious link clicks
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a');
      if (link && (link.target === '_blank' || e.ctrlKey || e.shiftKey || e.metaKey)) {
        const rect = link.getBoundingClientRect();
        const isTiny = rect.width < 5 || rect.height < 5;
        const isOverlay = rect.width > window.innerWidth * 0.9 && rect.height > window.innerHeight * 0.9;
        
        if (isTiny || isOverlay) {
          if (DEBUG) console.warn('[Chroma Ad-Blocker] Suspicious link click detected:', link.href);
        }
      }
    }, { capture: true, passive: true });
  }

  /**
   * Listen for messages from the MAIN world interceptor
   */
  function initInterceptorListener() {
    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data || event.data.source !== 'chroma-interceptor') return;

      if (event.data.type === 'WINDOW_OPEN_ATTEMPT') {
        const now = Date.now();
        const timeSinceGesture = now - lastUserGestureTime;
        popupCountInGesture++;
        
        const isSuspicious = timeSinceGesture > 300 || popupCountInGesture > 1;

        notifyBackground({
          type: MSG.WINDOW_OPEN_NOTIFY,
          url: event.data.url,
          isSuspicious,
          timeSinceGesture,
          popupCount: popupCountInGesture,
          gestureType: lastUserGestureType,
          stack: event.data.stack
        });
      }

      if (event.data.type === 'SUSPICIOUS_FOCUS_ATTEMPT' || event.data.type === 'SUSPICIOUS_BLUR_ATTEMPT') {
        if (DEBUG) console.log(`[Chroma Ad-Blocker] Blocked suspicious pop-under attempt (${event.data.type})`);
        notifyBackground({
          type: MSG.SUSPICIOUS_ACTIVITY,
          activity: event.data.type,
          context: event.data.context
        });
      }
    });
  }

  /**
   * Signals the interceptor script whether protections should be active.
   */
  function signalInterceptor() {
    if (CONFIG.enabled && CONFIG.blockPushNotifications) {
      document.documentElement.dataset.chromaPushActive = 'true';
    } else {
      delete document.documentElement.dataset.chromaPushActive;
    }

    if (CONFIG.enabled && CONFIG.blockPopUnders) {
      document.documentElement.dataset.chromaPopActive = 'true';
    } else {
      delete document.documentElement.dataset.chromaPopActive;
    }
  }

  // Initial sync with storage
  chrome.storage.local.get('config').then(({ config: savedConfig }) => {
    if (savedConfig) {
      CONFIG.enabled = savedConfig.enabled !== false;
      CONFIG.blockPopUnders = savedConfig.blockPopUnders !== false;
      CONFIG.blockPushNotifications = savedConfig.blockPushNotifications !== false;
    }
    signalInterceptor();
  }).catch(() => {
    signalInterceptor(); // Fallback
  });

  // Listen for config updates
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === MSG.CONFIG_UPDATE) {
      CONFIG.enabled = msg.config.enabled !== false;
      CONFIG.blockPopUnders = msg.config.blockPopUnders !== false;
      CONFIG.blockPushNotifications = msg.config.blockPushNotifications !== false;
      signalInterceptor();
    }
  });

  // Start tracking
  initGestureTracking();
  initInterceptorListener();

  if (DEBUG) console.log('[Chroma Ad-Blocker] Protection script active.');
})();
