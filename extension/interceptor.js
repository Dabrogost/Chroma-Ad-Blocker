/**
 * Chroma Ad-Blocker - Generic Interceptor
 * Runs in the page's execution context (MAIN world) for all sites.
 * Overrides Notification APIs to detect and notify about push attempts.
 */

(() => {
  'use strict';

  const DEBUG = false;

  // ─── DO-NO-HARM EXCLUSION LIST ─────
  // Bypasses all MAIN world interception for critical infrastructure,
  // financial institutions, and core authentication providers.

  const CRITICAL_EXCLUSIONS = [
    // --- Authentication & Identity (Heavy reliance on popups/tokens) ---
    'accounts.google.com',
    'github.com',
    'login.microsoftonline.com',
    'okta.com',
    'auth0.com',
    'appleid.apple.com',
    'idm.xfinity.com',

    // --- Financial, Payment Gateways & Banking ---
    'paypal.com',
    'stripe.com',
    'plaid.com',
    'squareup.com',
    'chase.com',
    'bankofamerica.com',
    'wellsfargo.com',
    'citi.com',
    'americanexpress.com',
    'capitalone.com',
    'discover.com',
    'usbank.com',

    // --- Essential Cloud & Work Consoles ---
    'console.aws.amazon.com',
    'console.cloud.google.com',
    'portal.azure.com',
    'app.slack.com',
    'teams.microsoft.com',
    
    // --- Password Managers (Web Vaults) ---
    'vault.bitwarden.com',
    'my.1password.com',
    'lastpass.com'
  ];

  const CRITICAL_TLDS = ['.gov', '.mil', '.edu', '.int'];

  /** @param {string} hostname */
  function isSafetyExcluded(hostname) {
    hostname = hostname.toLowerCase();

    if (CRITICAL_TLDS.some(tld => hostname.endsWith(tld))) return true;

    return CRITICAL_EXCLUSIONS.some(domain => 
      hostname === domain || hostname.endsWith('.' + domain)
    );
  }

  if (isSafetyExcluded(window.location.hostname)) {
    // Terminate execution immediately for excluded domains to ensure zero interference.
    return; 
  }

  // ─── PRISTINE CACHE ─────
  // Capture native APIs immediately to prevent host-page scripts from 
  // bypassing blockers by overwriting globals later.
  const pristineSetTimeout = window.setTimeout.bind(window);
  const pristineSetInterval = window.setInterval.bind(window);
  const pristineClearInterval = window.clearInterval.bind(window);

  const pristineCreateElement = document.createElement.bind(document);
  const pristineGetElementById = document.getElementById.bind(document);
  const pristineQuerySelector = document.querySelector.bind(document);
  const pristineAddEventListener = window.addEventListener.bind(window);
  const pristineRemoveEventListener = window.removeEventListener.bind(window);
  const pristineDispatchEvent = document.dispatchEvent.bind(document);
  const pristineAddDocEventListener = document.addEventListener.bind(document);
  const pristineRemoveDocEventListener = document.removeEventListener.bind(document);
  const pristineFnToString = Function.prototype.toString.bind(Function.prototype);
  const pristineCall = Function.prototype.call.bind(Function.prototype.call);
  const pristineIncludes = String.prototype.includes.bind(String.prototype);

  // SECURITY: Protect against Prototype Pollution hijacking (VULN-01)
  const HOSTILE_DOMAINS = [
    'youtube.com', 'amazon.com', 'amazon.de', 'amazon.co.uk',
    'amazon.co.jp', 'amazon.ca', 'amazon.fr', 'amazon.it',
    'amazon.es', 'primevideo.com'
  ];
  
  const isHostileDomain = HOSTILE_DOMAINS.some(d => window.location.hostname.endsWith(d));

  // ─── DEAD MAN'S SWITCH ─────
  // Emergency disconnect: If core primitives are hijacked, the secure relay is
  // disabled to prevent spoofing.
  let isEnvironmentCompromised = false;
  try {
    const isNative = (fn) => {
      try {
        // SECURITY: Test Environment Pass-through
        if (window.__CHROMA_TEST_ENVIRONMENT__ === true) return true;

        return typeof fn === 'function' && 
               pristineCall.call(pristineIncludes, pristineCall.call(pristineFnToString, fn), '[native code]');
      } catch (e) {
        return false;
      }
    };
    
    if (!isNative(pristineCreateElement) || 
        !isNative(pristineDispatchEvent)) {
      isEnvironmentCompromised = true;
      if (DEBUG) console.error("[Chroma Security] Environment compromised. Severing secure port.");
    }
  } catch (e) {
    isEnvironmentCompromised = true;
  }

  // =========================================================================
  // ─── API LOCKDOWN ─────
  let chromaPort;
  let pingInterval;

  /**
   * Helper to send messages only via the secure pipe.
   * Fails closed if the port is not established or env is compromised.
   */
  /** @param {Object} message */
  function sendToProtection(message) {
    if (isEnvironmentCompromised || !chromaPort) {
      if (DEBUG) console.error("[Chroma Ad-Blocker] Secure pipe not available/compromised. Dropping message.");
      return;
    }
    chromaPort.postMessage(message);
  }

  // ─── INTERCEPTOR ─────
  let isInitialized = false;
  let localConfig = null;

  /**
   * @param {string} token
   * @param {Object} [selectors]
   */
  function initChromaInterceptor(token, selectors = {}) {
    if (isInitialized) return;
    isInitialized = true;

    // Secure Config State: Use local variables to prevent host-page tampering.
    localConfig = {
      blockPushNotifications: selectors.blockPushNotifications !== false,
      enabled: selectors.enabled !== false
    };

    // SECURITY: Provisioning of secure messaging for authorized domains.
    if (isHostileDomain) {
      // SECURITY: Token Exposure Prevention (VULN-02 Fix)
      // Site-specific handlers (yt_handler, prm_handler) must use the exposed 'send' function
      // which automatically injects the token from this closure.
      const internalBridge = Object.create(null); // SECURITY: Property Lookup Prevention via Prototype Chain
      Object.assign(internalBridge, {
        config: Object.freeze({ ...selectors }),
        // Integrity Layer: API Passthrough
        api: Object.freeze({
          querySelector: pristineQuerySelector,
          getElementById: pristineGetElementById,
          createElement: pristineCreateElement,
          addEventListener: pristineAddEventListener,
          setInterval: pristineSetInterval,
          clearInterval: pristineClearInterval,
          addDocEventListener: pristineAddDocEventListener
        })
      });

      // SECURITY: Immutable Bridge
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

    if (DEBUG) console.log(`[Chroma Ad-Blocker] Interceptor active. Hostile Domain: ${isHostileDomain}`);
    // SECURITY: Local Configuration Access (VULN-01/02 Hardening)
    const checkPushBlocking = () => localConfig.enabled && localConfig.blockPushNotifications;

    pristineAddDocEventListener('__CHROMA_CONFIG_UPDATE__', (e) => {
      if (e.detail) {
        Object.assign(localConfig, {
          blockPushNotifications: e.detail.blockPushNotifications !== false,
          enabled: e.detail.enabled !== false
        });
      }
    }, true);


    // ─── PUSH NOTIFICATION BLOCKING ─────
    if (typeof window.Notification !== 'undefined') {
      const OriginalNotification = window.Notification;
      const originalRequestPermission = OriginalNotification.requestPermission;

      class ShadowNotification extends OriginalNotification {
        constructor(title, options) {
          // SECURITY: Notification Prompt Prevention
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
            }, 50); // 50ms grace period for event listener attachment before firing onshow
            return instance;
          }
          return new OriginalNotification(title, options);
        }

        static get permission() {
          if (checkPushBlocking()) return 'denied';
          return OriginalNotification.permission;
        }

        static requestPermission(callback) {
          if (checkPushBlocking()) {
            if (DEBUG) console.warn('[Chroma Ad-Blocker] Blocked notification permission request.');
            sendToProtection({ source: 'chroma-interceptor', token: token, type: 'NOTIFICATION_ATTEMPT' });
            
            const denied = 'denied';
            if (typeof callback === 'function') {
              try { callback(denied); } catch (e) {}
            }
            return Promise.resolve(denied);
          }
          
          if (typeof originalRequestPermission === 'function') {
            if (typeof callback === 'function') {
               return originalRequestPermission.call(OriginalNotification, (result) => callback(result));
            }
            return originalRequestPermission.apply(OriginalNotification, arguments);
          }
          return Promise.resolve('default');
        }
      }

      window.Notification = ShadowNotification;
    }
    // SECURITY: Deep Notification Blocking
    if (typeof ServiceWorkerRegistration !== 'undefined' && ServiceWorkerRegistration.prototype) {
      const originalShowNotification = ServiceWorkerRegistration.prototype.showNotification;
      // SECURITY: Prototype Reassignment to intercept SW-based push notifications
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
        // SECURITY: Permission State Spoofing
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
        // SECURITY: Prototype Reassignment to block push subscription enrollment
        PushManager.prototype.subscribe = function() {
          if (checkPushBlocking()) {
            return Promise.reject(new DOMException('Registration failed - push service not available', 'AbortError'));
          }
          return originalSubscribe.apply(this, arguments);
        };
      }
    }

    // SECURITY: API Lockdown
    if (isHostileDomain) {
      try {
        // SECURITY: Freeze writable+configurable to prevent host-page re-override
        const lock = (obj, prop) => {
          const desc = Object.getOwnPropertyDescriptor(obj, prop);
          if (desc && desc.configurable) {
            Object.defineProperty(obj, prop, { writable: false, configurable: false });
          }
        };

        if (typeof window.Notification !== 'undefined') {
          lock(window, 'Notification');
        }
      } catch (e) {}
    }
  }

  // ─── SECURE SYNCHRONIZATION ─────
  /** @param {Event} e */
  const handleTokenDelivery = (e) => {
    if (typeof e.stopImmediatePropagation === 'function') {
      e.stopImmediatePropagation();
    }
    
    if (pingInterval) {
      pristineClearInterval(pingInterval);
      pingInterval = null;
    }
    
    pristineRemoveDocEventListener('__CHROMA_TOKEN_DELIVERY__', handleTokenDelivery, true);

    // SECURITY: Read per-session nonce from delivery event.
    // Port transfer event name is randomized per page load — page scripts
    // cannot pre-register for an event name they don't know yet.
    const portNonce = e.detail && e.detail.portNonce;
    if (!portNonce) return;

    // SECURITY: Capture Phase Port Transfer (VULN-01 Hardening)
    pristineAddEventListener(portNonce, function portCatcher(e) {
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }
      
      chromaPort = e.ports ? e.ports[0] : null;
      if (!chromaPort) {
        // Fallback for CustomEvent delivery if MessageEvent wasn't used/available
        if (e.detail && e.detail.port) {
            chromaPort = e.detail.port;
        }
      }
      
      if (!chromaPort) return;

      chromaPort.onmessage = (msgEvent) => {
        if (msgEvent.data?.type === 'INIT_CHROMA') {
           const initData = msgEvent.data;
           initChromaInterceptor(initData.token || null, initData.selectors || {});
           if (DEBUG) console.log('[Chroma Ad-Blocker] Secure port initialized via inner channel.');
        } else if (msgEvent.data?.type === 'BACKGROUND_RESPONSE') {
          const resp = msgEvent.data.data;
          if (resp && resp.type === 'CONFIG_UPDATE') {
            // Internal state is locked, use CustomEvent for reactive components
            document.dispatchEvent(new CustomEvent('__CHROMA_CONFIG_UPDATE__', { detail: resp.config }));
          }
        }
      };
      
      pristineRemoveEventListener(portNonce, portCatcher, true);
    }, true); // MUST be true for Capture Phase!
  };

  pristineAddDocEventListener('__CHROMA_TOKEN_DELIVERY__', handleTokenDelivery, true);
  
  // DO NOT ping if compromised or if the site is whitelisted
  if (!isEnvironmentCompromised) {
    
    const pingRate = isHostileDomain ? 5 : 50; // 5ms aggressive polling for hostile domains; 50ms relaxed for general web
    
    pingInterval = pristineSetInterval(() => {
      // SECURITY: Secure Handshake Initiation
      pristineDispatchEvent(new CustomEvent('__CHROMA_MAIN_READY__'));
    }, pingRate);
  } else {
    initChromaInterceptor(null, {});
  }
  // ─── TESTING EXPORTS ─────
  if (typeof globalThis !== 'undefined' && globalThis.__CHROMA_INTERNAL_TEST_STRICT__ === true) {
    globalThis.__CHROMA_STATE_BRIDGE__ = {
      get isInitialized() { return isInitialized; },
      get isEnvironmentCompromised() { return isEnvironmentCompromised; },
      get localConfig() { return localConfig; }
    };
  }
})();
