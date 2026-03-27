/**
 * Chroma Ad-Blocker - Generic Interceptor
 * Runs in the page's execution context (MAIN world) for all sites.
 * Overrides window.open and Notification APIs to detect and notify about popup attempts.
 */

(() => {
  'use strict';

  // =========================================================================
  // 1. THE PRISTINE CACHE (Mitigates VULN-01 Race Conditions)
  // Grab all native APIs immediately on Line 1 before the DOM fully parses.
  // =========================================================================
  const pristineWindowOpen = window.open;
  const pristineFetch = window.fetch;
  const pristineSetTimeout = window.setTimeout;
  const pristineSetInterval = window.setInterval;
  const pristineClearInterval = window.clearInterval;

  const pristineCreateElement = document.createElement.bind(document);
  const pristineGetElementById = document.getElementById.bind(document);
  const pristineQuerySelector = document.querySelector.bind(document);
  const pristineAddEventListener = window.addEventListener.bind(window);
  const pristineRemoveEventListener = window.removeEventListener.bind(window);
  const pristineDispatchEvent = document.dispatchEvent.bind(document);
  const pristineAddDocEventListener = document.addEventListener.bind(document);
  const pristineRemoveDocEventListener = document.removeEventListener.bind(document);

  // =========================================================================
  // 2. THE API LOCKDOWN (Prevents future host-page hijacking)
  // Force the global window object to permanently use our pristine references.
  // =========================================================================
  try {
    // Lock Fetch as we don't currently override it, but want to protect it
    Object.defineProperty(window, 'fetch', {
      value: pristineFetch,
      writable: false,
      configurable: false
    });
    
    // We will lock window.open AFTER our override is applied to ensure 
    // it remains intercepted.
  } catch (e) {
    // If Object.defineProperty throws, it means an inline script beat us.
    // We already have our pristine references, so we're safe!
  }

  const DEBUG = false;
  let chromaPort; // This will hold our secure pipe
  let pingInterval;

  /**
   * Helper to send messages only via the secure pipe.
   * Fails closed if the port is not established.
   */
  function sendToProtection(message) {
    if (!chromaPort) {
      if (DEBUG) console.error("[Chroma Ad-Blocker] Secure pipe not established. Dropping message.");
      return;
    }
    chromaPort.postMessage(message);
  }

  /**
   * Initializes the interceptor with the secure token and selectors.
   * This is called only after the secure handshake completes.
   */
  function initChromaInterceptor(token, selectors = {}) {
    if (DEBUG) console.log('[Chroma Ad-Blocker] Global interceptor active with secure token.');
    
    // Store selectors locally for potential future use (e.g. dynamic injection from MAIN world)
    const HIDE_SELECTORS = selectors.HIDE_SELECTORS || [];
    const WARNING_SELECTORS = selectors.WARNING_SELECTORS || [];

    const originalFocus = window.focus;
    const originalBlur = window.blur;

    let lastOpenTime = 0;

    // Use generic dataset attribute names
    const checkPopUnderBlocking = () => document.documentElement.dataset.chromaPopActive === 'true';

    // Intercept window.open
    window.open = function(url, name, specs) {
      if (checkPopUnderBlocking()) {
        // Capture the stack trace to help identify the caller script in content script/background
        let stack = '';
        try {
          throw new Error();
        } catch (e) {
          stack = e.stack || '';
        }

        // Notify the isolated content script about the window.open call
        const message = {
          source: 'chroma-interceptor',
          token: token,
          type: 'WINDOW_OPEN_ATTEMPT',
          url: String(url || 'about:blank'),
          name: String(name || ''),
          specs: String(specs || ''),
          stack: stack
        };

        sendToProtection(message);

        lastOpenTime = Date.now();
      }
      
      // Proceed with the original open call.
      return pristineWindowOpen.apply(this, arguments);
    };

    // Detect suspicious focus/blur patterns right after a window.open
    window.focus = function() {
      if (checkPopUnderBlocking() && Date.now() - lastOpenTime < 1000) {
        const message = {
          source: 'chroma-interceptor',
          token: token,
          type: 'SUSPICIOUS_FOCUS_ATTEMPT',
          context: 'window.focus() called shortly after window.open()'
        };

        sendToProtection(message);
      }
      return originalFocus.apply(this, arguments);
    };

    window.blur = function() {
      if (checkPopUnderBlocking() && Date.now() - lastOpenTime < 1000) {
        const message = {
          source: 'chroma-interceptor',
          token: token,
          type: 'SUSPICIOUS_BLUR_ATTEMPT',
          context: 'window.blur() called shortly after window.open()'
        };

        sendToProtection(message);
      }
      return originalBlur.apply(this, arguments);
    };

    /**
     * PUSH NOTIFICATION BLOCKING
     */
    const checkPushBlocking = () => document.documentElement.dataset.chromaPushActive === 'true';

    if (typeof window.Notification !== 'undefined') {
      const originalRequestPermission = window.Notification.requestPermission;
      
      window.Notification.requestPermission = function(callback) {
        if (checkPushBlocking()) {
          if (DEBUG) console.warn('[Chroma Ad-Blocker] Blocked notification permission request.');
          const message = { source: 'chroma-interceptor', token: token, type: 'NOTIFICATION_ATTEMPT' };
          
          sendToProtection(message);
          
          const denied = 'denied';
          if (typeof callback === 'function') {
            try { callback(denied); } catch (e) {}
          }
          return Promise.resolve(denied);
        }
        
        if (typeof callback === 'function') {
          return originalRequestPermission.call(this, (result) => {
            callback(result);
          });
        }
        
        return originalRequestPermission.apply(this, arguments);
      };

      if (!Object.getOwnPropertyDescriptor(window.Notification, 'permission')) {
        Object.defineProperty(window.Notification, 'permission', {
          get: function() {
            if (checkPushBlocking()) return 'denied';
            return 'default';
          },
          configurable: true
        });
      }

      const OriginalNotification = window.Notification;
      
      // Create a true class to ensure instanceof checks pass correctly
      class ShadowNotification extends OriginalNotification {
        constructor(title, options) {
          if (checkPushBlocking()) {
            if (DEBUG) console.warn('[Chroma Ad-Blocker] Blocked Notification construction:', title);
            const message = { source: 'chroma-interceptor', token: token, type: 'NOTIFICATION_ATTEMPT' };
            
            sendToProtection(message);
            
            // Return a mock object that inherits from ShadowNotification.prototype
            // to ensure (obj instanceof Notification) remains true, without calling super()
            // which would trigger an actual notification or permission request.
            const instance = Object.create(ShadowNotification.prototype);
            
            instance.title = title;
            instance.body = options?.body || '';
            instance.icon = options?.icon || '';
            instance.tag = options?.tag || '';
            instance.onclick = null;
            instance.onshow = null;
            instance.onerror = null;
            instance.onclose = null;
            instance.close = () => {};
            
            pristineSetTimeout(() => {
              if (typeof instance.onshow === 'function') {
                try { instance.onshow(); } catch (e) {}
              }
            }, 50);
            
            return instance;
          }
          return new OriginalNotification(title, options);
        }

        static get permission() {
          if (checkPushBlocking()) return 'denied';
          return OriginalNotification.permission;
        }

        static requestPermission(...args) {
          // This is handled by the earlier override, but keeping it here for completeness
          return OriginalNotification.requestPermission(...args);
        }
      }

      window.Notification = ShadowNotification;
    }

    // ServiceWorker and Navigation API shadowing...
    if (typeof ServiceWorkerRegistration !== 'undefined' && ServiceWorkerRegistration.prototype) {
      const originalShowNotification = ServiceWorkerRegistration.prototype.showNotification;
      ServiceWorkerRegistration.prototype.showNotification = function(title, options) {
        if (checkPushBlocking()) {
          if (DEBUG) console.warn('[Chroma Ad-Blocker] Blocked ServiceWorker showNotification:', title);
          const message = { source: 'chroma-interceptor', token: token, type: 'NOTIFICATION_ATTEMPT' };
          
          sendToProtection(message);
          return Promise.resolve();
        }
        return originalShowNotification.apply(this, arguments);
      };
    }

    if (typeof navigator.permissions !== 'undefined' && typeof navigator.permissions.query === 'function') {
      const originalQuery = navigator.permissions.query;
      navigator.permissions.query = function(parameters) {
        if (parameters && parameters.name === 'notifications' && checkPushBlocking()) {
          return Promise.resolve({
            state: 'denied',
            onchange: null,
            name: 'notifications'
          });
        }
        return originalQuery.apply(this, arguments);
      };
    }

    if (typeof ServiceWorkerRegistration !== 'undefined' && 
        ServiceWorkerRegistration.prototype && 
        Object.prototype.hasOwnProperty.call(ServiceWorkerRegistration.prototype, 'pushManager') &&
        typeof PushManager !== 'undefined' && 
        PushManager.prototype) {
      
      const originalSubscribe = PushManager.prototype.subscribe;
      if (typeof originalSubscribe === 'function') {
        PushManager.prototype.subscribe = function() {
          if (checkPushBlocking()) {
            if (DEBUG) console.warn('[Chroma Ad-Blocker] Blocked PushManager subscription attempt.');
            return Promise.reject(new DOMException('Registration failed - push service not available', 'AbortError'));
          }
          return originalSubscribe.apply(this, arguments);
        };
      }
    }

    // SECURITY: Freeze the overridden APIs to prevent re-clobbering (VULN-06)
    try {
      const lock = (obj, prop) => {
        const desc = Object.getOwnPropertyDescriptor(obj, prop);
        if (desc && desc.configurable) {
          Object.defineProperty(obj, prop, { writable: false, configurable: false });
        }
      };

      lock(window, 'open');
      lock(window, 'focus');
      lock(window, 'blur');
      if (typeof window.Notification !== 'undefined') {
        lock(window, 'Notification');
      }
    } catch (e) {
      if (DEBUG) console.warn('[Chroma Ad-Blocker] Failed to lock APIs:', e);
    }
  }


  /**
   * Two-Way Handshake:
   * 1. Set up a capture-phase listener for the token delivery.
   * 2. Dispatch a 'ready' event to the ISOLATED world repeatedly until token is received.
   */
  const handleTokenDelivery = (e) => {
    // IMMEDIATELY stop the event from reaching any host page listeners
    if (typeof e.stopImmediatePropagation === 'function') {
      e.stopImmediatePropagation();
    }
    
    // Clear the ping interval immediately upon receipt
    if (pingInterval) {
      pristineClearInterval(pingInterval);
      pingInterval = null;
    }
    
    // Clean up the listener immediately
    pristineRemoveDocEventListener('__CHROMA_TOKEN_DELIVERY__', handleTokenDelivery, true);
    
    // Set up a trap to catch the incoming port
    pristineAddEventListener('message', function portCatcher(e) {
      // 1. Verify the message is ours
      if (e.data?.action === '__CHROMA_PORT_TRANSFER__') {
        const secretToken = e.data?.token;
        if (!secretToken) return;
        
        // 2. Kill the event immediately so the host page's 'message' listeners never see it
          if (typeof e.stopImmediatePropagation === 'function') {
            e.stopImmediatePropagation();
          }
          
          // 3. Grab the port and selectors
          chromaPort = e.ports[0];
          const selectors = e.data?.selectors || {};
          
          // 4. Clean up the listener
          pristineRemoveEventListener('message', portCatcher, true);
          
          if (DEBUG) console.log('[Chroma Ad-Blocker] Secure port established.');
          
          initChromaInterceptor(secretToken, selectors);
        }
      }, true); // MUST be true for Capture Phase!
  };

  pristineAddDocEventListener('__CHROMA_TOKEN_DELIVERY__', handleTokenDelivery, true);
  
  // Ping 'READY' every 5 milliseconds until the token is received
  pingInterval = pristineSetInterval(() => {
    pristineDispatchEvent(new CustomEvent('__CHROMA_MAIN_READY__'));
  }, 5);
})(); // Execute immediately
