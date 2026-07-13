/**
 * Chroma Ad-Blocker - Generic Interceptor
 * Runs in the page's execution context (MAIN world) for supported sites.
 * Provides secure API bridge and configuration relay.
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
  const rawCreateElement = document.createElement;
  const rawDispatchEvent = document.dispatchEvent;
  const rawFunctionToString = Function.prototype.toString;
  const rawFunctionCall = Function.prototype.call;
  const rawFunctionBind = Function.prototype.bind;
  const rawReflectApply = Reflect.apply;
  const rawStringIncludes = String.prototype.includes;
  const rawHasOwnProperty = Object.prototype.hasOwnProperty;
  const rawObjectCreate = Object.create;
  const rawObjectAssign = Object.assign;
  const rawObjectDefineProperty = Object.defineProperty;
  const rawObjectDefineProperties = Object.defineProperties;
  const rawObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const rawObjectFreeze = Object.freeze;
  const rawArrayIsArray = Array.isArray;
  const rawNumberIsFinite = Number.isFinite;
  const rawNumberIsInteger = Number.isInteger;

  // Equivalent to Function.prototype.toString.call(fn), captured before page
  // code can replace either operation.
  const pristineFnToString = (fn) => rawReflectApply(rawFunctionToString, fn, []);
  const pristineIncludes = (value, search) => rawReflectApply(rawStringIncludes, value, [search]);
  const pristineHasOwn = (value, key) => rawReflectApply(rawHasOwnProperty, value, [key]);

  // Verify original, unbound primitives. Bound functions stringify as native
  // regardless of their target, so checking the wrappers would be meaningless.
  let isEnvironmentCompromised = false;
  try {
    const isNative = (fn) => typeof fn === 'function' &&
      pristineIncludes(pristineFnToString(fn), '[native code]');
    const criticalPrimitives = [
      rawFunctionCall,
      rawFunctionBind,
      rawReflectApply,
      rawStringIncludes,
      rawHasOwnProperty,
      rawObjectCreate,
      rawObjectAssign,
      rawObjectDefineProperty,
      rawObjectDefineProperties,
      rawObjectGetOwnPropertyDescriptor,
      rawObjectFreeze,
      rawArrayIsArray,
      rawNumberIsFinite,
      rawNumberIsInteger,
      rawCreateElement,
      rawDispatchEvent
    ];
    for (let index = 0; index < criticalPrimitives.length; index++) {
      if (!isNative(criticalPrimitives[index])) {
        isEnvironmentCompromised = true;
        if (DEBUG) console.error('[Chroma Security] Environment compromised. Severing secure port.');
        break;
      }
    }
  } catch (e) {
    isEnvironmentCompromised = true;
  }

  // Do not invoke bind until its native source has passed the check above.
  // A compromised environment receives inert API shims only.
  const bindCaptured = (fn, receiver) => rawReflectApply(rawFunctionBind, fn, [receiver]);
  const inertNoop = () => {};
  const inertNull = () => null;
  const inertList = () => [];
  let pristineSetInterval = inertNull;
  let pristineClearInterval = inertNoop;
  let pristineSetTimeout = inertNull;
  let pristineClearTimeout = inertNoop;
  let pristineRequestAnimationFrame = inertNull;
  let pristineCancelAnimationFrame = inertNoop;
  let pristineCreateElement = inertNull;
  let pristineQuerySelector = inertNull;
  let pristineQuerySelectorAll = inertList;
  let pristineGetElementsByClassName = inertList;
  let pristineAddEventListener = inertNoop;
  let pristineRemoveEventListener = inertNoop;
  let pristineDispatchEvent = inertNoop;
  let pristineAddDocEventListener = inertNoop;
  let pristineRemoveDocEventListener = inertNoop;
  let PristineCSSStyleSheet = null;

  // A Proxy around a native function can retain a native-looking source while
  // throwing when invoked. Treat any wrapper-construction failure as a
  // compromised environment and retain the inert defaults above.
  if (!isEnvironmentCompromised) {
    try {
      pristineSetInterval = bindCaptured(window.setInterval, window);
      pristineClearInterval = bindCaptured(window.clearInterval, window);
      pristineSetTimeout = bindCaptured(window.setTimeout, window);
      pristineClearTimeout = bindCaptured(window.clearTimeout, window);
      pristineRequestAnimationFrame = typeof window.requestAnimationFrame === 'function'
        ? bindCaptured(window.requestAnimationFrame, window)
        : (fn) => pristineSetTimeout(fn, 16);
      pristineCancelAnimationFrame = typeof window.cancelAnimationFrame === 'function'
        ? bindCaptured(window.cancelAnimationFrame, window)
        : pristineClearTimeout;
      pristineCreateElement = bindCaptured(rawCreateElement, document);
      pristineQuerySelector = bindCaptured(document.querySelector, document);
      pristineQuerySelectorAll = typeof document.querySelectorAll === 'function'
        ? bindCaptured(document.querySelectorAll, document)
        : inertList;
      pristineGetElementsByClassName = typeof document.getElementsByClassName === 'function'
        ? bindCaptured(document.getElementsByClassName, document)
        : inertList;
      pristineAddEventListener = bindCaptured(window.addEventListener, window);
      pristineRemoveEventListener = bindCaptured(window.removeEventListener, window);
      pristineDispatchEvent = bindCaptured(rawDispatchEvent, document);
      pristineAddDocEventListener = bindCaptured(document.addEventListener, document);
      pristineRemoveDocEventListener = bindCaptured(document.removeEventListener, document);
      PristineCSSStyleSheet = typeof CSSStyleSheet === 'function' ? CSSStyleSheet : null;
    } catch (e) {
      isEnvironmentCompromised = true;
      pristineSetInterval = inertNull;
      pristineClearInterval = inertNoop;
      pristineSetTimeout = inertNull;
      pristineClearTimeout = inertNoop;
      pristineRequestAnimationFrame = inertNull;
      pristineCancelAnimationFrame = inertNoop;
      pristineCreateElement = inertNull;
      pristineQuerySelector = inertNull;
      pristineQuerySelectorAll = inertList;
      pristineGetElementsByClassName = inertList;
      pristineAddEventListener = inertNoop;
      pristineRemoveEventListener = inertNoop;
      pristineDispatchEvent = inertNoop;
      pristineAddDocEventListener = inertNoop;
      pristineRemoveDocEventListener = inertNoop;
      PristineCSSStyleSheet = null;
    }
  }

  // One-time challenge used to reject a page-forged port delivery.
  let readyToken = null;
  if (!isEnvironmentCompromised) {
    try {
      const randomWords = crypto.getRandomValues(new Uint32Array(4));
      readyToken = Array.from(randomWords, value => value.toString(36)).join('_');
    } catch (e) {
      isEnvironmentCompromised = true;
    }
  }

  // ─── YOUTUBE SCROLL LOCK PREVENTION ─────
  // Remain inert until the private port authenticates an active master config.
  // Teardown uses identity checks so page replacements made later always win.
  const isYouTubeHost = (() => {
    const hostname = String(window.location?.hostname || '').toLowerCase().replace(/\.$/, '');
    return hostname === 'youtube.com' || hostname.endsWith('.youtube.com');
  })();
  let youtubeScrollLifecycle = null;
  let youtubeScrollSheet = null;

  function isRecentYouTubeScrollReset(args, lifecycle) {
    let x = 0;
    let y = 0;
    if (args[0] && typeof args[0] === 'object') {
      x = args[0].left || 0;
      y = args[0].top || 0;
    } else {
      x = args[0] || 0;
      y = args[1] || 0;
    }
    if (x !== 0 || y !== 0 || window.pageYOffset < 80) return false;
    return lifecycle.active && (performance.now() - lifecycle.wheelTimestamp) < 400;
  }

  function hasYouTubeScrollSheet(sheets) {
    if (!sheets || !youtubeScrollSheet) return false;
    for (let index = 0; index < sheets.length; index++) {
      if (sheets[index] === youtubeScrollSheet) return true;
    }
    return false;
  }

  function addYouTubeScrollSheet() {
    if (!PristineCSSStyleSheet) return;
    try {
      if (!youtubeScrollSheet) {
        youtubeScrollSheet = new PristineCSSStyleSheet();
        youtubeScrollSheet.replaceSync(`
          html[style*="overflow: hidden"], html[style*="overflow:hidden"],
          html[style*="overflow-y: hidden"], html[style*="overflow-y:hidden"],
          body[style*="overflow: hidden"], body[style*="overflow:hidden"],
          body[style*="overflow-y: hidden"], body[style*="overflow-y:hidden"] {
            overflow: auto !important;
            overflow-y: auto !important;
          }
        `);
      }
      const sheets = document.adoptedStyleSheets || [];
      if (!hasYouTubeScrollSheet(sheets)) document.adoptedStyleSheets = [...sheets, youtubeScrollSheet];
    } catch (_) {}
  }

  function removeYouTubeScrollSheet() {
    if (!youtubeScrollSheet) return;
    try {
      const sheets = document.adoptedStyleSheets || [];
      if (!hasYouTubeScrollSheet(sheets)) return;
      const nextSheets = [];
      for (let index = 0; index < sheets.length; index++) {
        if (sheets[index] !== youtubeScrollSheet) nextSheets[nextSheets.length] = sheets[index];
      }
      document.adoptedStyleSheets = nextSheets;
    } catch (_) {}
  }

  function activateYouTubeScrollProtection() {
    if (!isYouTubeHost || isEnvironmentCompromised || youtubeScrollLifecycle?.active) return;
    const lifecycle = {
      active: true,
      wheelTimestamp: 0,
      onWheel: null,
      scrollToOriginal: window.scrollTo,
      scrollOriginal: window.scroll,
      scrollToWrapper: null,
      scrollWrapper: null,
      scrollTopPreviousDescriptor: null,
      scrollTopWrapperDescriptor: null
    };
    youtubeScrollLifecycle = lifecycle;
    lifecycle.onWheel = () => {
      if (lifecycle.active) lifecycle.wheelTimestamp = performance.now();
    };
    try {
      pristineAddDocEventListener('wheel', lifecycle.onWheel, { capture: true, passive: true });
    } catch (_) {}

    lifecycle.scrollToWrapper = function(...args) {
      if (lifecycle.active && isRecentYouTubeScrollReset(args, lifecycle)) return;
      if (typeof lifecycle.scrollToOriginal === 'function') {
        return rawReflectApply(lifecycle.scrollToOriginal, window, args);
      }
    };
    lifecycle.scrollWrapper = function(...args) {
      if (lifecycle.active && isRecentYouTubeScrollReset(args, lifecycle)) return;
      if (typeof lifecycle.scrollOriginal === 'function') {
        return rawReflectApply(lifecycle.scrollOriginal, window, args);
      }
    };
    try { window.scrollTo = lifecycle.scrollToWrapper; } catch (_) {}
    try { window.scroll = lifecycle.scrollWrapper; } catch (_) {}

    try {
      const documentElement = document.documentElement;
      lifecycle.scrollTopPreviousDescriptor = rawObjectGetOwnPropertyDescriptor(documentElement, 'scrollTop') || null;
      const scrollTopDescriptor = lifecycle.scrollTopPreviousDescriptor?.set
        ? lifecycle.scrollTopPreviousDescriptor
        : (!lifecycle.scrollTopPreviousDescriptor
            ? rawObjectGetOwnPropertyDescriptor(Element.prototype, 'scrollTop') ||
              rawObjectGetOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop')
            : null);
      if (scrollTopDescriptor?.set) {
        const originalGet = scrollTopDescriptor.get;
        const originalSet = scrollTopDescriptor.set;
        lifecycle.scrollTopWrapperDescriptor = {
          configurable: true,
          enumerable: scrollTopDescriptor.enumerable === true,
          get() { return originalGet ? rawReflectApply(originalGet, this, []) : 0; },
          set(value) {
            if (lifecycle.active && value === 0 && window.pageYOffset > 80 &&
                (performance.now() - lifecycle.wheelTimestamp) < 400) return;
            rawReflectApply(originalSet, this, [value]);
          }
        };
        rawObjectDefineProperty(documentElement, 'scrollTop', lifecycle.scrollTopWrapperDescriptor);
      }
    } catch (_) {
      lifecycle.scrollTopPreviousDescriptor = null;
      lifecycle.scrollTopWrapperDescriptor = null;
    }

    addYouTubeScrollSheet();
  }

  function deactivateYouTubeScrollProtection() {
    const lifecycle = youtubeScrollLifecycle;
    if (!lifecycle?.active) return;
    lifecycle.active = false;
    try { pristineRemoveDocEventListener('wheel', lifecycle.onWheel, true); } catch (_) {}

    try {
      if (window.scrollTo === lifecycle.scrollToWrapper) window.scrollTo = lifecycle.scrollToOriginal;
    } catch (_) {}
    try {
      if (window.scroll === lifecycle.scrollWrapper) window.scroll = lifecycle.scrollOriginal;
    } catch (_) {}

    try {
      const documentElement = document.documentElement;
      const currentDescriptor = rawObjectGetOwnPropertyDescriptor(documentElement, 'scrollTop');
      const wrapperDescriptor = lifecycle.scrollTopWrapperDescriptor;
      const stillOwned = !!currentDescriptor && !!wrapperDescriptor &&
        currentDescriptor.configurable === wrapperDescriptor.configurable &&
        currentDescriptor.enumerable === wrapperDescriptor.enumerable &&
        currentDescriptor.get === wrapperDescriptor.get &&
        currentDescriptor.set === wrapperDescriptor.set;
      if (stillOwned) {
        if (lifecycle.scrollTopPreviousDescriptor) {
          rawObjectDefineProperty(documentElement, 'scrollTop', lifecycle.scrollTopPreviousDescriptor);
        } else {
          delete documentElement.scrollTop;
        }
      }
    } catch (_) {}

    removeYouTubeScrollSheet();
    youtubeScrollLifecycle = null;
  }

  function syncYouTubeScrollProtection() {
    if (localConfig?.enabled === true) activateYouTubeScrollProtection();
    else deactivateYouTubeScrollProtection();
  }

  // Domains where the secure bridge and pristine API wrappers are provisioned.
  const BRIDGE_DOMAINS = [
    'youtube.com', 'amazon.com', 'amazon.de', 'amazon.co.uk',
    'amazon.co.jp', 'amazon.ca', 'amazon.fr', 'amazon.it',
    'amazon.es', 'primevideo.com',
    'bellyfull.net', 'allrecipes.com', 'foodnetwork.com', 'epicurious.com',
    'bbcgoodfood.com', 'thekitchn.com', 'seriouseats.com', 'recipetineats.com',
    'smittenkitchen.com', 'budgetbytes.com', 'pinchofyum.com',
    'sallysbakingaddiction.com', 'minimalistbaker.com', 'thewoksoflife.com',
    'americastestkitchen.com', 'cooking.nytimes.com', 'weelicious.com',
    'therecipecritic.com', 'acozykitchen.com', 'twopeasandtheirpod.com',
    'halfbakedharvest.com', 'pcgamer.com'
  ];
  const bridgeHostname = String(window.location?.hostname || '').toLowerCase().replace(/\.$/, '');
  const isBridgeDomain = BRIDGE_DOMAINS.some(domain =>
    bridgeHostname === domain || bridgeHostname.endsWith('.' + domain)
  );

  // ─── SECURE PORT ─────
  let chromaPort;
  let pingInterval;

  // ─── INTERCEPTOR ─────
  let isInitialized = false;
  const CONFIG_KEYS = rawObjectFreeze([
    'enabled',
    'stripping',
    'acceleration',
    'accelerationSpeed',
    'checkIntervalMs'
  ]);
  const CONFIG_VALIDATORS = rawObjectFreeze({
    enabled:           (value) => typeof value === 'boolean',
    stripping:         (value) => typeof value === 'boolean',
    acceleration:      (value) => typeof value === 'boolean',
    accelerationSpeed: (value) => typeof value === 'number' && rawNumberIsFinite(value) && value > 0 && value <= 16,
    checkIntervalMs:   (value) => typeof value === 'number' && rawNumberIsInteger(value) && value >= 100 && value <= 5000
  });
  const localConfig = rawObjectAssign(rawObjectCreate(null), {
    enabled: false,
    stripping: false,
    acceleration: false
  });
  let configRevision = 0;

  function applyBridgeConfig(config) {
    if (!config || typeof config !== 'object' || rawArrayIsArray(config)) return false;
    let changed = false;
    for (let index = 0; index < CONFIG_KEYS.length; index++) {
      const key = CONFIG_KEYS[index];
      if (!pristineHasOwn(config, key)) continue;
      const value = config[key];
      if (!CONFIG_VALIDATORS[key](value)) continue;
      if (localConfig[key] === value) continue;
      localConfig[key] = value;
      changed = true;
    }
    if (changed) configRevision++;
    return changed;
  }

  function getBridgeConfigSnapshot() {
    return rawObjectFreeze({ ...localConfig });
  }

  function provisionInternalBridge() {
    // Reserve the public name synchronously with an inert snapshot. This runs
    // before asynchronous storage work and before page scripts can preclaim it.
    if (isBridgeDomain) {
      const internalBridge = rawObjectCreate(null); // SECURITY: Property Lookup Prevention via Prototype Chain
      rawObjectDefineProperties(internalBridge, {
        config: {
          get: getBridgeConfigSnapshot,
          enumerable: true
        },
        revision: {
          get: () => configRevision,
          enumerable: true
        },
        // Integrity Layer: API Passthrough
        api: {
          value: rawObjectFreeze({
            querySelector: pristineQuerySelector,
            querySelectorAll: pristineQuerySelectorAll,
            getElementsByClassName: pristineGetElementsByClassName,
            createElement: pristineCreateElement,
            addEventListener: pristineAddEventListener,
            removeEventListener: pristineRemoveEventListener,
            dispatchEvent: pristineDispatchEvent,
            setTimeout: pristineSetTimeout,
            clearTimeout: pristineClearTimeout,
            setInterval: pristineSetInterval,
            clearInterval: pristineClearInterval,
            requestAnimationFrame: pristineRequestAnimationFrame,
            cancelAnimationFrame: pristineCancelAnimationFrame,
            addDocEventListener: pristineAddDocEventListener,
            removeDocEventListener: pristineRemoveDocEventListener,
            createCssStyleSheet: PristineCSSStyleSheet ? () => new PristineCSSStyleSheet() : null,
            getAdoptedStyleSheets: () => document.adoptedStyleSheets,
            setAdoptedStyleSheets: (sheets) => { document.adoptedStyleSheets = sheets; }
          }),
          enumerable: true
        }
      });

      // SECURITY: Immutable Bridge
      try {
        rawObjectDefineProperty(window, '__CHROMA_INTERNAL__', {
          value: rawObjectFreeze(internalBridge),
          writable: false,
          configurable: false
        });
      } catch (e) {
        // A page-owned non-configurable property cannot become a trusted
        // bridge. Leave handlers on their inert local defaults.
        return;
      }
      pristineDispatchEvent(new CustomEvent('__CHROMA_BRIDGE_READY__'));
    }

    if (DEBUG) console.log(`[Chroma Ad-Blocker] Bridge reserved. Bridge Domain: ${isBridgeDomain}`);
  }

  /** @param {Object} [config] */
  function initChromaInterceptor(config = {}) {
    if (isInitialized) return;
    isInitialized = true;
    applyBridgeConfig(config);
    syncYouTubeScrollProtection();
  }

  provisionInternalBridge();

  // ─── SECURE SYNCHRONIZATION ─────
  /** @param {Event} e */
  const handleConfigDelivery = (e) => {
    if (typeof e.stopImmediatePropagation === 'function') {
      e.stopImmediatePropagation();
    }

    // Accept delivery only when it echoes the one-time MAIN challenge. The
    // isolated listener is installed before storage I/O and prevents the page
    // from observing the challenge event.
    const portNonce = e.detail && e.detail.portNonce;
    const echoedReadyToken = e.detail && e.detail.readyToken;
    if (typeof portNonce !== 'string' || portNonce.length < 16 || portNonce.length > 160 ||
        typeof echoedReadyToken !== 'string' || echoedReadyToken !== readyToken) {
      return;
    }
    
    if (pingInterval) {
      pristineClearInterval(pingInterval);
      pingInterval = null;
    }
    
    pristineRemoveDocEventListener('__CHROMA_CONFIG_DELIVERY__', handleConfigDelivery, true);

    // SECURITY: Read per-session nonce from delivery event.
    // Port transfer event name is randomized per page load — page scripts
    // cannot pre-register for an event name they don't know yet.
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

      let portInitialized = false;
      chromaPort.onmessage = (msgEvent) => {
        if (msgEvent.data?.type === 'INIT_CHROMA') {
          if (portInitialized) return;
          portInitialized = true;
          initChromaInterceptor(msgEvent.data.config || {});
          // Notification only: authoritative values stay in the private port
          // closure and are read through the immutable bridge snapshot.
          pristineDispatchEvent(new CustomEvent('__CHROMA_CONFIG_UPDATE__'));
          if (typeof chromaPort.postMessage === 'function') {
            chromaPort.postMessage({ type: 'CHROMA_READY' });
          }
          if (DEBUG) console.log('[Chroma Ad-Blocker] Secure port initialized via inner channel.');
        } else if (portInitialized && msgEvent.data?.type === 'BACKGROUND_RESPONSE') {
          const resp = msgEvent.data.data;
          if (resp && resp.type === 'CONFIG_UPDATE') {
            const changed = applyBridgeConfig(resp.config || {});
            if (changed) syncYouTubeScrollProtection();
            pristineDispatchEvent(new CustomEvent('__CHROMA_CONFIG_UPDATE__'));
          }
        }
      };
      
      pristineRemoveEventListener(portNonce, portCatcher, true);
    }, true); // MUST be true for Capture Phase!
  };

  // A compromised environment gets an immutable inert snapshot and no
  // delivery listener or ready signal. Page events cannot reactivate it.
  if (!isEnvironmentCompromised) {
    pristineAddDocEventListener('__CHROMA_CONFIG_DELIVERY__', handleConfigDelivery, true);
    const pingRate = isBridgeDomain ? 5 : 50; // 5ms on bridge domains; 50ms relaxed for general web
    
    pingInterval = pristineSetInterval(() => {
      // SECURITY: Secure Handshake Initiation
      pristineDispatchEvent(new CustomEvent('__CHROMA_MAIN_READY__', {
        detail: { readyToken }
      }));
    }, pingRate);
  } else {
    initChromaInterceptor({ enabled: false, stripping: false, acceleration: false });
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
