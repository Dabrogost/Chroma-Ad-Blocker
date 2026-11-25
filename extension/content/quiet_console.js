/**
 * Chroma Ad-Blocker - Quiet Console
 *
 * Runs in the page context and short-circuits common ad/tracker request paths
 * before Chromium can surface blocked-request noise in the page DevTools console.
 */

(function () {
  'use strict';

  const DEBUG = false;
  const CONFIG_EVENT = '__CHROMA_QUIET_CONSOLE_CONFIG__';
  const CONFIG = {
    enabled: true,
    quietConsole: false
  };
  let hooksInstalled = false;
  const toStringTargets = new Map();

  const CRITICAL_EXCLUSIONS = [
    'accounts.google.com',
    'github.com',
    'login.microsoftonline.com',
    'okta.com',
    'auth0.com',
    'appleid.apple.com',
    'idm.xfinity.com',
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
    'console.aws.amazon.com',
    'console.cloud.google.com',
    'portal.azure.com',
    'app.slack.com',
    'teams.microsoft.com',
    'vault.bitwarden.com',
    'my.1password.com',
    'lastpass.com'
  ];
  const CRITICAL_TLDS = ['.gov', '.mil', '.edu', '.int'];

  const QUIET_HOSTS = [
    'doubleclick.net',
    'googlesyndication.com',
    'googleadservices.com',
    'google-analytics.com',
    'analytics.google.com',
    'bat.bing.com',
    'ads-twitter.com',
    'ads.linkedin.com',
    'px.ads.linkedin.com',
    'analytics.tiktok.com',
    'business-api.tiktok.com',
    'snap.licdn.com'
  ];
  const QUIET_GOOGLE_TAG_PATHS = ['/gtm.js', '/gtag/js'];
  const QUIET_FACEBOOK_PATHS = ['/tr/'];
  const QUIET_YOUTUBE_PATHS = [
    '/youtubei/v1/log_event',
    '/ptracking',
    '/pcs/activeview',
    '/api/stats/ads'
  ];

  function isSafetyExcluded(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    if (!host) return false;
    if (CRITICAL_TLDS.some(tld => host.endsWith(tld))) return true;
    return CRITICAL_EXCLUSIONS.some(domain => host === domain || host.endsWith('.' + domain));
  }

  if (isSafetyExcluded(window.location && window.location.hostname)) {
    return;
  }

  function log(...args) {
    if (DEBUG) console.log('[Chroma Quiet Console]', ...args);
  }

  function applyConfig(source) {
    if (!source || typeof source !== 'object') return;
    if (typeof source.enabled === 'boolean') CONFIG.enabled = source.enabled;
    if (typeof source.quietConsole === 'boolean') CONFIG.quietConsole = source.quietConsole;
  }

  const nativeFetch = typeof window.fetch === 'function' ? window.fetch : null;
  const nativeXHROpen = window.XMLHttpRequest && XMLHttpRequest.prototype.open;
  const nativeXHRSend = window.XMLHttpRequest && XMLHttpRequest.prototype.send;
  const nativeXHRAbort = window.XMLHttpRequest && XMLHttpRequest.prototype.abort;
  const nativeXHRSetRequestHeader = window.XMLHttpRequest && XMLHttpRequest.prototype.setRequestHeader;
  const nativeSendBeacon = window.navigator && typeof navigator.sendBeacon === 'function'
    ? navigator.sendBeacon
    : null;

  const nativeWindowAddListener = typeof window.addEventListener === 'function'
    ? window.addEventListener.bind(window)
    : null;
  const nativeWindowRemoveListener = typeof window.removeEventListener === 'function'
    ? window.removeEventListener.bind(window)
    : null;
  const nativeWindowDispatchEvent = typeof window.dispatchEvent === 'function'
    ? window.dispatchEvent.bind(window)
    : null;
  const NativeCustomEvent = typeof CustomEvent === 'function' ? CustomEvent : null;
  const supportsSecurePort = Boolean(
    typeof MessageChannel === 'function' &&
    nativeWindowAddListener &&
    nativeWindowDispatchEvent &&
    NativeCustomEvent &&
    typeof crypto === 'object' && crypto && typeof crypto.getRandomValues === 'function'
  );
  let authenticatedPort = null;

  if (supportsSecurePort) {
    const tokenBytes = new Uint32Array(4);
    crypto.getRandomValues(tokenBytes);
    const readyToken = '__CHROMA_QC_' + Array.from(tokenBytes, n => n.toString(16).padStart(8, '0')).join('') + '__';
    let armedNonce = null;
    let handleNonce = null;

    const handleIsoReady = () => {
      if (authenticatedPort) return;
      try {
        nativeWindowDispatchEvent(new NativeCustomEvent('__CHROMA_QC_MAIN_READY__', {
          detail: { readyToken }
        }));
      } catch (_) {}
    };

    const handleDelivery = (event) => {
      if (authenticatedPort) return;
      const detail = event && event.detail;
      if (!detail || detail.readyToken !== readyToken || typeof detail.portNonce !== 'string' || !detail.portNonce) {
        return;
      }
      if (typeof event.preventDefault === 'function') event.preventDefault();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();

      if (armedNonce && handleNonce && nativeWindowRemoveListener) {
        try { nativeWindowRemoveListener(armedNonce, handleNonce, true); } catch (_) {}
      }

      armedNonce = detail.portNonce;
      handleNonce = (portEvent) => {
        if (typeof portEvent.stopImmediatePropagation === 'function') portEvent.stopImmediatePropagation();
        const port = (portEvent.ports && portEvent.ports[0]) || (portEvent.detail && portEvent.detail.port);
        if (!port || typeof port.postMessage !== 'function') return;
        authenticatedPort = port;
        if (nativeWindowRemoveListener) {
          try { nativeWindowRemoveListener(armedNonce, handleNonce, true); } catch (_) {}
          try { nativeWindowRemoveListener('__CHROMA_QC_DELIVERY__', handleDelivery, true); } catch (_) {}
          try { nativeWindowRemoveListener('__CHROMA_QC_ISO_READY__', handleIsoReady, true); } catch (_) {}
        }
        port.onmessage = (msgEvent) => {
          applyConfig(msgEvent && msgEvent.data);
          installQuietConsoleHooks();
        };
        try {
          port.postMessage({ type: 'CHROMA_QC_PORT_READY' });
        } catch (_) {}
      };
      nativeWindowAddListener(armedNonce, handleNonce, true);
    };

    nativeWindowAddListener('__CHROMA_QC_DELIVERY__', handleDelivery, true);
    nativeWindowAddListener('__CHROMA_QC_ISO_READY__', handleIsoReady, true);
    handleIsoReady();
  } else {
    document.addEventListener(CONFIG_EVENT, event => {
      applyConfig(event && event.detail);
      installQuietConsoleHooks();
    }, true);
  }

  function getRequestUrl(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    try {
      return String(input || '');
    } catch (_) {
      return '';
    }
  }

  function isHostOrSubdomain(hostname, domain) {
    return hostname === domain || hostname.endsWith('.' + domain);
  }

  function parseUrl(value) {
    try {
      return new URL(value, window.location && window.location.href);
    } catch (_) {
      try {
        return new URL(value);
      } catch (_) {
        return null;
      }
    }
  }

  function isQuietableUrl(url) {
    const value = String(url || '').trim().toLowerCase();
    if (!value) return false;
    if (
      value.startsWith('about:') ||
      value.startsWith('blob:') ||
      value.startsWith('chrome:') ||
      value.startsWith('chrome-extension:') ||
      value.startsWith('data:')
    ) {
      return false;
    }

    const parsed = parseUrl(value);
    if (!parsed) return false;

    const host = String(parsed.hostname || '').toLowerCase().replace(/\.$/, '');
    const path = String(parsed.pathname || '').toLowerCase();
    if (!host) return false;
    if (QUIET_HOSTS.some(domain => isHostOrSubdomain(host, domain))) return true;
    if (host.startsWith('adservice.google.')) return true;
    if (isHostOrSubdomain(host, 'googletagmanager.com')) {
      return QUIET_GOOGLE_TAG_PATHS.some(part => path.startsWith(part));
    }
    if (isHostOrSubdomain(host, 'facebook.com')) {
      return QUIET_FACEBOOK_PATHS.some(part => path.startsWith(part));
    }
    if (isHostOrSubdomain(host, 'youtube.com') || isHostOrSubdomain(host, 'youtube-nocookie.com')) {
      return QUIET_YOUTUBE_PATHS.some(part => path.includes(part));
    }
    return false;
  }

  function shouldQuiet(url) {
    return CONFIG.enabled === true && CONFIG.quietConsole === true && isQuietableUrl(url);
  }

  const QUIET_XHR_PROPS = ['readyState', 'status', 'statusText', 'responseText', 'response'];
  const quietXhrState = new WeakMap();

  function getQuietXhrState(xhr) {
    let state = quietXhrState.get(xhr);
    if (!state) {
      state = { generation: 0, suppressed: false, timerId: null, savedDescriptors: null };
      quietXhrState.set(xhr, state);
    }
    return state;
  }

  function restoreQuietXhr(xhr) {
    const state = quietXhrState.get(xhr);
    if (!state) return;
    if (state.timerId !== null) {
      try {
        clearTimeout(state.timerId);
      } catch (_) {}
      state.timerId = null;
    }
    if (!state.savedDescriptors) return;
    const saved = state.savedDescriptors;
    state.savedDescriptors = null;
    for (const key of QUIET_XHR_PROPS) {
      if (Object.prototype.hasOwnProperty.call(saved, key)) {
        try {
          Object.defineProperty(xhr, key, saved[key]);
        } catch (_) {}
      } else {
        try {
          delete xhr[key];
        } catch (_) {}
      }
    }
  }

  function defineValue(target, key, value) {
    try {
      Object.defineProperty(target, key, { value, writable: true, configurable: true });
      return;
    } catch (_) {}
    try {
      target[key] = value;
    } catch (_) {}
  }

  function makeQuietFetchResponse() {
    if (typeof Response !== 'function') {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {},
        text: async () => '{}',
        json: async () => ({})
      };
    }
    return new Response('{}', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  }

  function fireQuietXhrEvent(target, type, handlerProp) {
    const hasOwnHandler = Object.prototype.hasOwnProperty.call(target, handlerProp);
    let handledByDom = false;
    const EventCtor = (type === 'load' || type === 'loadend') && typeof ProgressEvent === 'function'
      ? ProgressEvent
      : (typeof Event === 'function' ? Event : (typeof CustomEvent === 'function' ? CustomEvent : null));
    if (EventCtor && typeof target.dispatchEvent === 'function') {
      try {
        target.dispatchEvent(new EventCtor(type));
        handledByDom = !hasOwnHandler;
      } catch (_) {}
    }
    if (!handledByDom && typeof target[handlerProp] === 'function') {
      try {
        target[handlerProp].call(target, { type, target });
      } catch (_) {}
    }
  }

  function completeQuietXhr(xhr, state) {
    const expectedGeneration = state.generation;
    let completed = false;
    const finish = () => {
      completed = true;
      state.timerId = null;
      if (state.generation !== expectedGeneration || state.suppressed !== true) return;
      if (!state.savedDescriptors) {
        const saved = Object.create(null);
        for (const key of QUIET_XHR_PROPS) {
          const desc = Object.getOwnPropertyDescriptor(xhr, key);
          if (desc) saved[key] = desc;
        }
        state.savedDescriptors = saved;
      }
      defineValue(xhr, 'readyState', 4);
      defineValue(xhr, 'status', 200);
      defineValue(xhr, 'statusText', 'OK');
      defineValue(xhr, 'responseText', '{}');
      defineValue(xhr, 'response', '{}');
      fireQuietXhrEvent(xhr, 'readystatechange', 'onreadystatechange');
      fireQuietXhrEvent(xhr, 'load', 'onload');
      fireQuietXhrEvent(xhr, 'loadend', 'onloadend');
    };

    try {
      const id = setTimeout(finish, 0);
      if (!completed) state.timerId = id;
    } catch (_) {
      finish();
    }
  }

  function getNativeToStringLabel(fn) {
    if (typeof fn === 'function') {
      try {
        return fn.call(fn);
      } catch (_) {}
    }
    return 'function toString() { [native code] }';
  }

  function markNativeLike(fn, source, usePrototypeSpoof = false) {
    if (typeof fn !== 'function') return;
    toStringTargets.set(fn, source);
    if (usePrototypeSpoof && typeof Object.getPrototypeOf === 'function' &&
        Object.getPrototypeOf(fn) === Function.prototype) {
      return;
    }
    try {
      const currentToString = typeof Function.prototype.toString === 'function'
        ? Function.prototype.toString
        : null;
      const nativeLabel = getNativeToStringLabel(currentToString);
      const ownToString = function toString() { return source; };
      toStringTargets.set(ownToString, nativeLabel);
      Object.defineProperty(ownToString, 'toString', {
        value: function () { return nativeLabel; },
        configurable: true
      });
      Object.defineProperty(fn, 'toString', {
        value: ownToString,
        configurable: true
      });
    } catch (_) {}
  }

  function installQuietConsoleHooks() {
    if (hooksInstalled || CONFIG.enabled !== true || CONFIG.quietConsole !== true) return;
    hooksInstalled = true;

    const toStringInstalled = installToStringSpoof();

    if (nativeFetch) {
      window.fetch = function fetch(input, ...args) {
        if (shouldQuiet(getRequestUrl(input))) {
          log('quiet fetch', getRequestUrl(input));
          return Promise.resolve(makeQuietFetchResponse());
        }
        return nativeFetch.apply(this, arguments);
      };
      markNativeLike(window.fetch, 'function fetch() { [native code] }', toStringInstalled);
    }

    if (typeof nativeXHROpen === 'function' && typeof nativeXHRSend === 'function') {
      XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
        const requestUrl = getRequestUrl(url);
        const state = getQuietXhrState(this);
        state.generation += 1;
        state.suppressed = false;
        restoreQuietXhr(this);
        if (shouldQuiet(requestUrl)) {
          state.suppressed = true;
          log('quiet xhr', requestUrl);
          return;
        }
        return nativeXHROpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function send(...args) {
        const state = quietXhrState.get(this);
        if (state && state.suppressed === true) {
          completeQuietXhr(this, state);
          return;
        }
        return nativeXHRSend.apply(this, arguments);
      };
      markNativeLike(XMLHttpRequest.prototype.open, 'function open() { [native code] }', toStringInstalled);
      markNativeLike(XMLHttpRequest.prototype.send, 'function send() { [native code] }', toStringInstalled);
      if (typeof nativeXHRAbort === 'function') {
        XMLHttpRequest.prototype.abort = function abort() {
          const state = quietXhrState.get(this);
          if (state && state.suppressed === true) {
            state.generation += 1;
            state.suppressed = false;
            restoreQuietXhr(this);
            return;
          }
          if (state) {
            state.generation += 1;
            restoreQuietXhr(this);
          }
          return nativeXHRAbort.apply(this, arguments);
        };
        markNativeLike(XMLHttpRequest.prototype.abort, 'function abort() { [native code] }', toStringInstalled);
      }
      if (typeof nativeXHRSetRequestHeader === 'function') {
        XMLHttpRequest.prototype.setRequestHeader = function setRequestHeader(name, value) {
          const state = quietXhrState.get(this);
          if (state && state.suppressed === true) return;
          return nativeXHRSetRequestHeader.apply(this, arguments);
        };
        markNativeLike(
          XMLHttpRequest.prototype.setRequestHeader,
          'function setRequestHeader() { [native code] }',
          toStringInstalled
        );
      }
    }

    if (nativeSendBeacon) {
      navigator.sendBeacon = function sendBeacon(url, ...args) {
        if (shouldQuiet(getRequestUrl(url))) {
          log('quiet beacon', getRequestUrl(url));
          return true;
        }
        return nativeSendBeacon.apply(this, arguments);
      };
      markNativeLike(navigator.sendBeacon, 'function sendBeacon() { [native code] }', toStringInstalled);
    }
  }

  function installToStringSpoof() {
    const previousToString = Function.prototype.toString;
    if (typeof previousToString !== 'function') return false;
    const nativeLabel = getNativeToStringLabel(previousToString);
    const spoofedToString = {
      toString() {
        if (toStringTargets.has(this)) return toStringTargets.get(this);
        try {
          return previousToString.call(this);
        } catch (err) {
          if (typeof Error === 'function' && typeof Error.captureStackTrace === 'function') {
            try { Error.captureStackTrace(err, spoofedToString); } catch (_) {}
          }
          throw err;
        }
      }
    }.toString;
    toStringTargets.set(spoofedToString, nativeLabel);
    try {
      Object.defineProperty(Function.prototype, 'toString', {
        value: spoofedToString,
        writable: true,
        configurable: true
      });
      return Function.prototype.toString === spoofedToString;
    } catch (_) {
      return false;
    }
  }
})();
