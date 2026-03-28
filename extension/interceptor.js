/**
 * Chroma Ad-Blocker - Generic Interceptor
 * Runs in the page's execution context (MAIN world) for all sites.
 * Overrides window.open and Notification APIs to detect and notify about popup attempts.
 */

(() => {
  'use strict';

  // =========================================================================
  // 1. THE PRISTINE CACHE (Mitigates Race Conditions)
  // Best-effort capture of native APIs. Effectiveness depends on injection 
  // timing (document_start) relative to host-page scripts.
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

  // SECURE REFERENCE CACHE: Protect against Prototype Pollution hijacking (VULN-01)
  const hasOwn = Object.prototype.hasOwnProperty;
  const toString = Object.prototype.toString;
  const slice = Array.prototype.slice;
  
  // Integrity Verification: Cache prototype methods to prevent 'isNative' spoofing via host-page prototype pollution
  const pristineFnToString = Function.prototype.toString;
  const pristineCall = Function.prototype.call;
  const pristineIncludes = String.prototype.includes;

  // =========================================================================
  // 3. THE DEAD MAN'S SWITCH (Detects Hijacked Environment)
  // Emergency disconnect: If core primitives are hijacked, the secure relay is
  // disabled to prevent spoofing, which may degrade blocking capabilities.
  // =========================================================================
  let isEnvironmentCompromised = false;
  try {
    const isNative = (fn) => {
      try {
        return typeof fn === 'function' && 
               pristineCall.call(pristineIncludes, pristineCall.call(pristineFnToString, fn), '[native code]');
      } catch (e) {
        return false;
      }
    };
    
    // Check core primitives
    if (!isNative(pristineWindowOpen) || 
        !isNative(pristineCreateElement) || 
        !isNative(pristineDispatchEvent)) {
      isEnvironmentCompromised = true;
      if (DEBUG) console.error("[Chroma Security] Environment compromised. Severing secure port.");
    }
  } catch (e) {
    isEnvironmentCompromised = true;
  }

  // =========================================================================
  // 3. THE API LOCKDOWN (Prevents future host-page hijacking)
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
   * Fails closed if the port is not established or env is compromised.
   */
  function sendToProtection(message) {
    if (isEnvironmentCompromised || !chromaPort) {
      if (DEBUG) console.error("[Chroma Ad-Blocker] Secure pipe not available/compromised. Dropping message.");
      return;
    }
    chromaPort.postMessage(message);
  }

  // =========================================================================
  // 4. THE INTERCEPTOR (Logic for blocking and notifying)
  // =========================================================================
  let isInitialized = false;

  /**
   * Initializes the interceptor with the secure token and selectors.
   * This is called only after the secure handshake completes.
   */
  function initChromaInterceptor(token, selectors = {}) {
    if (isInitialized) return;
    isInitialized = true;

    // SECURE CONFIG STATE: Use local variables instead of HTML datasets to prevent host-page tampering.
    const localConfig = {
      blockPopUnders: selectors.blockPopUnders !== false,
      blockPushNotifications: selectors.blockPushNotifications !== false,
      enabled: selectors.enabled !== false
    };

    // BRIDGE: Provisioning of secure messaging and configuration for authorized streaming domains (YouTube, Amazon/Prime Video).
    const TRUSTED_DOMAINS = [
      'youtube.com',
      'amazon.com',
      'amazon.de',
      'amazon.co.uk',
      'amazon.co.jp',
      'amazon.ca',
      'amazon.fr',
      'amazon.it',
      'amazon.es',
      'primevideo.com'
    ];
    
    const isTrusted = TRUSTED_DOMAINS.some(d => window.location.hostname.endsWith(d));

    if (isTrusted) {
      // SECURITY: We NO LONGER expose the token on the window object (VULN-02 Fix).
      // Site-specific handlers (yt_handler, prm_handler) must use the exposed 'send' function
      // which automatically injects the token from this closure.
      const internalBridge = Object.create(null);
      Object.assign(internalBridge, {
        send: (payload) => {
          // SECURITY: Whitelist allowed bridge actions (VULN: Messaging Bridge Abuse)
          const ALLOWED_ACTIONS = ['STATS_UPDATE', 'CLOSE_TAB', 'WINDOW_OPEN_ATTEMPT'];
          const action = (payload && payload.action) ? payload.action : (payload && payload.type);
          
          if (!ALLOWED_ACTIONS.includes(action)) {
            if (DEBUG) console.error(`[Chroma Security] Blocked unauthorized bridge action: ${action}`);
            return;
          }

          // Automatically inject token and source for site-specific handlers
          sendToProtection({
            ...payload,
            token: token,
            source: 'chroma-interceptor'
          });
        },
        config: Object.freeze({ ...selectors }),
        // API Passthrough: Provide handlers with pre-cached, unpolluted native methods for DOM manipulation.
        api: Object.freeze({
          querySelector: pristineQuerySelector,
          getElementById: pristineGetElementById,
          createElement: pristineCreateElement,
          addEventListener: pristineAddEventListener,
          removeEventListener: pristineRemoveEventListener,
          setTimeout: pristineSetTimeout,
          setInterval: pristineSetInterval,
          clearInterval: pristineClearInterval,
          dispatchEvent: pristineDispatchEvent,
          addDocEventListener: pristineAddDocEventListener,
          removeDocEventListener: pristineRemoveDocEventListener,
          MutationObserver: window.MutationObserver,
          // VULN-01 Hardening: Capture and expose pure utility functions
          calculateChromaColor: (typeof window.calculateChromaColor === 'function') ? 
                                window.calculateChromaColor.bind(window) : null
        })
      });

      // Immutable Bridge: Using Object.defineProperty to prevent host-page scripts from overwriting or intercepting the internal API.
      try {
        Object.defineProperty(window, '__CHROMA_INTERNAL__', {
          value: Object.freeze(internalBridge),
          writable: false,
          configurable: false
        });
      } catch (e) {
        // Fallback for non-configurable scenarios
        window.__CHROMA_INTERNAL__ = Object.freeze(internalBridge);
      }
    }

    if (DEBUG) console.log(`[Chroma Ad-Blocker] Interceptor active. Trusted: ${isTrusted}`);

    const originalFocus = window.focus;
    const originalBlur = window.blur;
    let lastOpenTime = 0;

    // SECURITY: Use localConfig instead of insecure datasets (VULN-01/02 Hardening)
    const checkPopUnderBlocking = () => localConfig.enabled && localConfig.blockPopUnders;
    const checkPushBlocking = () => localConfig.enabled && localConfig.blockPushNotifications;

    // Listen for config updates via the secure MessagePort
    pristineAddDocEventListener('__CHROMA_CONFIG_UPDATE__', (e) => {
      if (e.detail) {
        Object.assign(localConfig, {
          blockPopUnders: e.detail.blockPopUnders !== false,
          blockPushNotifications: e.detail.blockPushNotifications !== false,
          enabled: e.detail.enabled !== false
        });
      }
    }, true);

    // Intercept window.open
    window.open = function(url, name, specs) {
      if (checkPopUnderBlocking()) {
        let stack = '';
        try { throw new Error(); } catch (e) { stack = e.stack || ''; }

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
      
      return pristineWindowOpen.apply(this, arguments);
    };

    // Detect suspicious focus/blur patterns
    window.focus = function() {
      if (checkPopUnderBlocking() && Date.now() - lastOpenTime < 1000) {
        sendToProtection({
          source: 'chroma-interceptor',
          token: token,
          type: 'SUSPICIOUS_FOCUS_ATTEMPT',
          context: 'window.focus() called shortly after window.open()'
        });
      }
      return originalFocus.apply(this, arguments);
    };

    window.blur = function() {
      if (checkPopUnderBlocking() && Date.now() - lastOpenTime < 1000) {
        sendToProtection({
          source: 'chroma-interceptor',
          token: token,
          type: 'SUSPICIOUS_BLUR_ATTEMPT',
          context: 'window.blur() called shortly after window.open()'
        });
      }
      return originalBlur.apply(this, arguments);
    };

    /**
     * PUSH NOTIFICATION BLOCKING
     */
    if (typeof window.Notification !== 'undefined') {
      const originalRequestPermission = window.Notification.requestPermission;
      
      window.Notification.requestPermission = function(callback) {
        if (checkPushBlocking()) {
          if (DEBUG) console.warn('[Chroma Ad-Blocker] Blocked notification permission request.');
          sendToProtection({ source: 'chroma-interceptor', token: token, type: 'NOTIFICATION_ATTEMPT' });
          
          const denied = 'denied';
          if (typeof callback === 'function') {
            try { callback(denied); } catch (e) {}
          }
          return Promise.resolve(denied);
        }
        
        if (typeof callback === 'function') {
          return originalRequestPermission.call(this, (result) => callback(result));
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
      class ShadowNotification extends OriginalNotification {
        constructor(title, options) {
          if (checkPushBlocking()) {
            if (DEBUG) console.warn('[Chroma Ad-Blocker] Blocked Notification construction:', title);
            sendToProtection({ source: 'chroma-interceptor', token: token, type: 'NOTIFICATION_ATTEMPT' });
            
            const instance = Object.create(ShadowNotification.prototype);
            instance.title = title;
            instance.body = options?.body || '';
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
          return OriginalNotification.requestPermission(...args);
        }
      }

      window.Notification = ShadowNotification;
    }

    // Deep Notification Blocking: Overriding ServiceWorkerRegistration prototype to catch background push notifications.
    if (typeof ServiceWorkerRegistration !== 'undefined' && ServiceWorkerRegistration.prototype) {
      const originalShowNotification = ServiceWorkerRegistration.prototype.showNotification;
      ServiceWorkerRegistration.prototype.showNotification = function(title, options) {
        if (checkPushBlocking()) {
          sendToProtection({ source: 'chroma-interceptor', token: token, type: 'NOTIFICATION_ATTEMPT' });
          return Promise.resolve();
        }
        return originalShowNotification.apply(this, arguments);
      };
    }

    if (typeof navigator.permissions !== 'undefined' && typeof navigator.permissions.query === 'function') {
      const originalQuery = navigator.permissions.query;
      navigator.permissions.query = function(parameters) {
        if (parameters && parameters.name === 'notifications' && checkPushBlocking()) {
          return Promise.resolve({ state: 'denied', onchange: null, name: 'notifications' });
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
            return Promise.reject(new DOMException('Registration failed - push service not available', 'AbortError'));
          }
          return originalSubscribe.apply(this, arguments);
        };
      }
    }

    // SECURITY: Freeze the overridden APIs (VULN-06)
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
    } catch (e) {}
  }


  /**
   * Secure Synchronization: Capture-phase handshake to establish the MessagePort.
   * Repeats 'ready' signal to handle variable script injection order between worlds.
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
    
    // SECURE HANDSHAKE: Use Capture-Phase CustomEvent to transfer the port (VULN-01 Hardening)
    pristineAddEventListener('__CHROMA_PORT_TRANSFER__', function portCatcher(e) {
      // 1. Kill the event immediately so the host page never knows it occurred
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }
      
      // 2. Grab the port from the event ports (MessageEvent compatibility)
      chromaPort = e.ports ? e.ports[0] : null;
      if (!chromaPort) {
        // Fallback for CustomEvent delivery if MessageEvent wasn't used/available
        if (e.detail && e.detail.port) {
            chromaPort = e.detail.port;
        }
      }
      
      if (!chromaPort) return;

      // 3. Secure the port listeners
      chromaPort.onmessage = (msgEvent) => {
        // Verify it's the INIT message or a CONFIG update
        if (msgEvent.data?.type === 'INIT_CHROMA') {
           const initData = msgEvent.data;
           if (initData.token) {
             initChromaInterceptor(initData.token, initData.selectors || {});
             if (DEBUG) console.log('[Chroma Ad-Blocker] Secure port initialized via inner channel.');
           }
        } else if (msgEvent.data?.type === 'BACKGROUND_RESPONSE') {
          const resp = msgEvent.data.data;
          if (resp && resp.type === 'CONFIG_UPDATE') {
            // Internal state is locked, use CustomEvent for reactive components
            document.dispatchEvent(new CustomEvent('__CHROMA_CONFIG_UPDATE__', { detail: resp.config }));
          }
        }
      };
      
      // 4. Clean up the listener
      pristineRemoveEventListener('__CHROMA_PORT_TRANSFER__', portCatcher, true);
    }, true); // MUST be true for Capture Phase!
  };

  pristineAddDocEventListener('__CHROMA_TOKEN_DELIVERY__', handleTokenDelivery, true);
  
  // Ping 'READY' every 5 milliseconds until the token is received
  // DO NOT ping if compromised or if the site is whitelisted
  if (!isEnvironmentCompromised) {
    if (document.documentElement.getAttribute('data-chroma-whitelisted') === 'true') {
      if (DEBUG) console.log('[Chroma] Interceptor disabled by whitelist.');
      return;
    }
    
    // High-frequency synchronization: Minimizes handshake latency during page initialization to ensure interceptors are active before first-party scripts.
    pingInterval = pristineSetInterval(() => {
      pristineDispatchEvent(new CustomEvent('__CHROMA_MAIN_READY__'));
    }, 5);
  } else {
    // If compromised, we still allow local component initialization (yt_handler) 
    // but with NO token and NO secure port.
    initChromaInterceptor(null, {});
  }
})(); // Execute immediately
