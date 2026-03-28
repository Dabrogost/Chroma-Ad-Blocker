/**
 * Chroma Ad-Blocker - Global Protection Script
 * Handles gesture tracking, message relay for pop-under attempts,
 * and push notification suppression across all websites.
 */

'use strict';

(function() {
  const DEBUG = false;
  let isolatedPort; // This will hold our secure pipe

  // Token-Based Authorization: Request a unique session token from the background script.
  let secretToken = null;
  const getTokenFromBackground = async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_TOKEN' });
    if (response && response.token) {
      secretToken = response.token;
      return true;
    }
    return false;
  };

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

    // Intercept suspicious link clicks (Common Pop-Under technique)
    document.addEventListener('click', (e) => {
      // SECURITY: Fail closed if config isn't loaded yet
      if (!CONFIG.enabled || !CONFIG.blockPopUnders) return;

      const link = e.target.closest('a');
      if (link && (link.target === '_blank' || e.ctrlKey || e.shiftKey || e.metaKey)) {
        const rect = link.getBoundingClientRect();
        
        // DETECTION: Ad-networks often use 1x1 invisible pixels or full-page 
        // transparent overlays to hijack clicks for pop-unders.
        const isTiny = rect.width > 0 && rect.width < 5 || rect.height > 0 && rect.height < 5;
        const isOverlay = rect.width > window.innerWidth * 0.8 && rect.height > window.innerHeight * 0.8;
        
        if (isTiny || isOverlay) {
          if (DEBUG) console.warn('[Chroma Ad-Blocker] Proactively blocked suspicious pop-under click.');
          
          // ACTION: Kill the event before the browser can open a new tab/window
          e.preventDefault();
          e.stopImmediatePropagation();
          
          // REPORT: Update stats and log activity
          if (secretToken) {
            notifyBackground({
              type: MSG.SUSPICIOUS_ACTIVITY,
              token: secretToken,
              activity: 'BLOCKED_SUSPICIOUS_CLICK',
              context: `Link: ${link.href.substring(0, 100)}...`
            });
          }
        }
      }
    }, { capture: true, passive: false });
  }

  /**
   * Processes messages from the interceptor (via the secure MessagePort)
   * and routes them to the background script.
   */
  function processInterceptorMessage(data) {
    if (!data || data.source !== 'chroma-interceptor') return;


    // LEGACY: Handle existing message types that aren't yet using action/payload
    if (data.type === 'WINDOW_OPEN_ATTEMPT') {
      const now = Date.now();
      const timeSinceGesture = now - lastUserGestureTime;
      popupCountInGesture++;
      
      const isSuspicious = timeSinceGesture > 300 || popupCountInGesture > 1;

      notifyBackground({
        type: MSG.WINDOW_OPEN_NOTIFY,
        token: data.token,
        url: data.url,
        isSuspicious,
        timeSinceGesture,
        popupCount: popupCountInGesture,
        gestureType: lastUserGestureType,
        stack: data.stack
      });
      return;
    }

    if (data.type === 'SUSPICIOUS_FOCUS_ATTEMPT' || data.type === 'SUSPICIOUS_BLUR_ATTEMPT') {
      if (DEBUG) console.log(`[Chroma Ad-Blocker] Blocked suspicious pop-under attempt (${data.type})`);
      notifyBackground({
        type: MSG.SUSPICIOUS_ACTIVITY,
        token: data.token,
        activity: data.type,
        context: data.context
      });
      return;
    }

    if (data.type === 'NOTIFICATION_ATTEMPT') {
      if (DEBUG) console.log('[Chroma Ad-Blocker] Blocked notification attempt');
      notifyBackground({
        type: MSG.SUSPICIOUS_ACTIVITY,
        token: data.token,
        activity: data.type
      });
      return;
    }

    // NEW: Generic Routing to Background
    const payload = {
      source: 'chroma_interceptor',
      token: data.token,
      action: data.action || data.type,
      payload: data.payload || data
    };

    try {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          if (DEBUG) console.error("Background script unreachable:", chrome.runtime.lastError.message);
          return;
        }
        // Optional: Send the response back down the secure pipe to the MAIN world
        if (isolatedPort && response) {
           isolatedPort.postMessage({ type: 'BACKGROUND_RESPONSE', data: response });
        }
      });
    } catch (error) {
      if (DEBUG) console.error("Failed to route message to background:", error);
    }
  }

  /**
   * Listen for messages from the MAIN world interceptor
   */
  function initInterceptorListener() {
    // Message Quarantine: Handling only non-sensitive interactions via window.postMessage to prevent handshake spoofing.
    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data) return;

      const sensitiveTypes = [
        'WINDOW_OPEN_ATTEMPT',
        'SUSPICIOUS_FOCUS_ATTEMPT',
        'SUSPICIOUS_BLUR_ATTEMPT',
        'NOTIFICATION_ATTEMPT'
      ];

      if (sensitiveTypes.includes(event.data.type)) {
        if (DEBUG) console.warn('[Chroma Ad-Blocker] Blocked insecure delivery of sensitive command via window.postMessage.');
        return;
      }

      // Process non-sensitive messages here if any...
      // processInterceptorMessage(event.data); // Removed legacy support for sensitive messages
    });
  }

  /**
   * Securely transfers the secret token to the MAIN world using
   * a two-way CustomEvent handshake with stopImmediatePropagation.
   */
  function initHandshake(selectors = {}) {
    // If background script failed to provide a token, abort handshake.
    if (!secretToken) {
      if (DEBUG) console.error('[Chroma Ad-Blocker] Token generation failed. Aborting handshake.');
      return; 
    }

    const handleMainReady = (e) => {
      // Stop the host page from knowing the extension is initializing
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }
      
      // Clean up the listener so it only fires once
      document.removeEventListener('__CHROMA_MAIN_READY__', handleMainReady, true);
      
      if (DEBUG) console.log('[Chroma Ad-Blocker] MAIN world ready. Delivering token.');

      // Dispatch the token securely via CustomEvent
      document.dispatchEvent(new CustomEvent('__CHROMA_TOKEN_DELIVERY__'));

      // Create the secure pipe (MessagePort)
      const channel = new MessageChannel();
      isolatedPort = channel.port1;

      // Set up a listener for messages coming FROM interceptor.js
      isolatedPort.onmessage = (e) => {
        if (DEBUG) console.log('[Chroma Ad-Blocker] Received via secure pipe:', e.data);
        processInterceptorMessage(e.data);
      };

      // Send port2 to the MAIN world via MessageEvent
      try {
        window.dispatchEvent(new MessageEvent('__CHROMA_PORT_TRANSFER__', {
          ports: [channel.port2]
        }));
      } catch (e) {
        window.dispatchEvent(new CustomEvent('__CHROMA_PORT_TRANSFER__', {
          detail: { port: channel.port2 }
        }));
      }

      // Deliver the payload through the protected pipe
      isolatedPort.postMessage({
        type: 'INIT_CHROMA',
        token: secretToken,
        selectors: { ...selectors, ...CONFIG }
      });

      if (DEBUG) console.log('[Chroma Ad-Blocker] Secure port sent to MAIN world.');
    };

    // Attach the listener to catch the ping from interceptor.js
    document.addEventListener('__CHROMA_MAIN_READY__', handleMainReady, true);
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

    // SECURITY: We no longer pass the token via dataset (VULN-02 Fix)
    delete document.documentElement.dataset.chromaToken;
  }

  // Initial sync with storage
  chrome.storage.local.get(['config', 'HIDE_SELECTORS', 'WARNING_SELECTORS', 'whitelist']).then(async (data) => {
    let isWhitelisted = false;
    const whitelist = data.whitelist || [];
    const hostname = window.location.hostname;
    
    if (whitelist.some(d => hostname === d || hostname.endsWith('.' + d))) {
      isWhitelisted = true;
      if (DEBUG) console.log('[Chroma] Domain is whitelisted. Staying inactive.');
      document.documentElement.setAttribute('data-chroma-whitelisted', 'true');
    }

    const savedConfig = data.config;
    if (savedConfig) {
      CONFIG.enabled = isWhitelisted ? false : (savedConfig.enabled !== false);
      CONFIG.blockPopUnders = isWhitelisted ? false : (savedConfig.blockPopUnders !== false);
      CONFIG.blockPushNotifications = isWhitelisted ? false : (savedConfig.blockPushNotifications !== false);
    } else if (isWhitelisted) {
      CONFIG.enabled = false;
      CONFIG.blockPopUnders = false;
      CONFIG.blockPushNotifications = false;
    }
    
    // Cache selectors to pass to MAIN world
    const selectors = {
      HIDE_SELECTORS: isWhitelisted ? [] : (data.HIDE_SELECTORS || []),
      WARNING_SELECTORS: isWhitelisted ? [] : (data.WARNING_SELECTORS || []),
      enabled: CONFIG.enabled
    };

    // SECURITY: Request token from background before starting handshake
    await getTokenFromBackground();
    
    signalInterceptor();
    initHandshake(selectors); // Pass selectors to handshake
  }).catch(async () => {
    await getTokenFromBackground();
    signalInterceptor(); // Fallback
    initHandshake();
  });

  // Listen for config updates
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === MSG.CONFIG_UPDATE) {
      CONFIG.enabled = msg.config.enabled !== false;
      CONFIG.blockPopUnders = msg.config.blockPopUnders !== false;
      CONFIG.blockPushNotifications = msg.config.blockPushNotifications !== false;
      signalInterceptor();

      // Forward to MAIN world if port is active
      if (isolatedPort) {
        isolatedPort.postMessage({
          type: 'BACKGROUND_RESPONSE',
          data: { type: 'CONFIG_UPDATE', config: msg.config }
        });
      }
    }
  });

  // Start tracking
  initGestureTracking();
  initInterceptorListener();

  if (DEBUG) console.log('[Chroma Ad-Blocker] Protection script active.');
})();
