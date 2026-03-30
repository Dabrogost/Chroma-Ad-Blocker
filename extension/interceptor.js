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

  /**
   * @param {string} token
   * @param {Object} [selectors]
   */
  function initChromaInterceptor(token, selectors = {}) {
    if (isInitialized) return;
    isInitialized = true;

    // Secure Config State: Use local variables to prevent host-page tampering.
    const localConfig = {
      blockPushNotifications: selectors.blockPushNotifications !== false,
      enabled: selectors.enabled !== false
    };

    // SECURITY: Provisioning of secure messaging for authorized domains.
    if (isHostileDomain) {
      // SECURITY: Token Exposure Prevention (VULN-02 Fix)
      // Site-specific handlers (yt_handler, prm_handler) must use the exposed 'send' function
      // which automatically injects the token from this closure.
      const internalBridge = Object.create(null); // SECURITY: Rationale - Prevent property lookup via Prototype Chain.
      Object.assign(internalBridge, {
        config: Object.freeze({ ...selectors }),
        // Integrity Layer: API Passthrough
        api: Object.freeze({
          querySelector: pristineQuerySelector,
          getElementById: pristineGetElementById,
          createElement: pristineCreateElement,
          addEventListener: pristineAddEventListener,
          setTimeout: pristineSetTimeout,
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
          // SECURITY: Prevents sites from spawning non-consensual notification prompts.
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
            }, 50); // Grace period for event listener attachment
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
        // SECURITY: Spoofs permission state to 'denied' to suppress repeat requests.
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

    // SECURITY: Freeze the overridden APIs (VULN-06).
    if (isHostileDomain) {
      try {
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
    
    // SECURITY: Capture Phase Port Transfer (VULN-01 Hardening)
    pristineAddEventListener('__CHROMA_PORT_TRANSFER__', function portCatcher(e) {
      // SECURITY: Port Acquisition Capture Phase Logic
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }
      
      // SECURITY: Port Acquisition (MessageEvent compatibility)
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
      
      pristineRemoveEventListener('__CHROMA_PORT_TRANSFER__', portCatcher, true);
    }, true); // MUST be true for Capture Phase!
  };

  pristineAddDocEventListener('__CHROMA_TOKEN_DELIVERY__', handleTokenDelivery, true);
  
  // DO NOT ping if compromised or if the site is whitelisted
  if (!isEnvironmentCompromised) {
    if (document.documentElement.getAttribute('data-chroma-whitelisted') === 'true') {
      if (DEBUG) console.log('[Chroma] Interceptor disabled by whitelist.');
      return;
    }
    
    // Aggressive polling (5ms) for hostile domains; relaxed polling (50ms) for general web.
    const pingRate = isHostileDomain ? 5 : 50; // 5ms aggressive polling for hostile domains; 50ms relaxed for general web.
    
    pingInterval = pristineSetInterval(() => {
      pristineDispatchEvent(new CustomEvent('__CHROMA_MAIN_READY__'));
    }, pingRate);
  } else {
    initChromaInterceptor(null, {});
  }
})();
