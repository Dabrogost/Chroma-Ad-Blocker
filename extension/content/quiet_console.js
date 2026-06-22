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
  const nativeToString = Function.prototype.toString;
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

  document.addEventListener(CONFIG_EVENT, event => {
    applyConfig(event && event.detail);
    installQuietConsoleHooks();
  }, true);

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

  function defineValue(target, key, value) {
    try {
      Object.defineProperty(target, key, { value, configurable: true });
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

  function completeQuietXhr(xhr) {
    const finish = () => {
      defineValue(xhr, 'readyState', 4);
      defineValue(xhr, 'status', 200);
      defineValue(xhr, 'statusText', 'OK');
      defineValue(xhr, 'responseText', '{}');
      defineValue(xhr, 'response', '{}');
      try {
        if (typeof xhr.onreadystatechange === 'function') {
          xhr.onreadystatechange({ type: 'readystatechange', target: xhr });
        }
      } catch (_) {}
      try {
        if (typeof xhr.onload === 'function') {
          xhr.onload({ type: 'load', target: xhr });
        }
      } catch (_) {}
      try {
        if (typeof xhr.onloadend === 'function') {
          xhr.onloadend({ type: 'loadend', target: xhr });
        }
      } catch (_) {}
    };

    try {
      setTimeout(finish, 0);
    } catch (_) {
      finish();
    }
  }

  function markNativeLike(fn, source) {
    if (typeof fn !== 'function') return;
    toStringTargets.set(fn, source);
    try {
      const ownToString = function toString() { return source; };
      Object.defineProperty(ownToString, 'toString', {
        value: function () { return nativeToString.call(nativeToString); },
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

    const nativeFetch = typeof window.fetch === 'function' ? window.fetch : null;
    const nativeXHROpen = window.XMLHttpRequest && XMLHttpRequest.prototype.open;
    const nativeXHRSend = window.XMLHttpRequest && XMLHttpRequest.prototype.send;
    const nativeSendBeacon = window.navigator && typeof navigator.sendBeacon === 'function'
      ? navigator.sendBeacon
      : null;

    if (nativeFetch) {
      window.fetch = function fetch(input, ...args) {
        if (shouldQuiet(getRequestUrl(input))) {
          log('quiet fetch', getRequestUrl(input));
          return Promise.resolve(makeQuietFetchResponse());
        }
        return nativeFetch.apply(this, arguments);
      };
      markNativeLike(window.fetch, 'function fetch() { [native code] }');
    }

    if (typeof nativeXHROpen === 'function' && typeof nativeXHRSend === 'function') {
      XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
        const requestUrl = getRequestUrl(url);
        this.__chromaQuietConsoleUrl = requestUrl;
        this.__chromaQuietConsoleSuppressed = false;
        if (shouldQuiet(requestUrl)) {
          this.__chromaQuietConsoleSuppressed = true;
          log('quiet xhr', requestUrl);
          return;
        }
        return nativeXHROpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function send(...args) {
        if (this.__chromaQuietConsoleSuppressed === true) {
          completeQuietXhr(this);
          return;
        }
        return nativeXHRSend.apply(this, arguments);
      };
      markNativeLike(XMLHttpRequest.prototype.open, 'function open() { [native code] }');
      markNativeLike(XMLHttpRequest.prototype.send, 'function send() { [native code] }');
    }

    if (nativeSendBeacon) {
      navigator.sendBeacon = function sendBeacon(url, ...args) {
        if (shouldQuiet(getRequestUrl(url))) {
          log('quiet beacon', getRequestUrl(url));
          return true;
        }
        return nativeSendBeacon.apply(this, arguments);
      };
      markNativeLike(navigator.sendBeacon, 'function sendBeacon() { [native code] }');
    }

    installToStringSpoof();
  }

  function installToStringSpoof() {
    Function.prototype.toString = function toString() {
      if (toStringTargets.has(this)) return toStringTargets.get(this);
      return nativeToString.call(this);
    };
    try {
      Object.defineProperty(Function.prototype.toString, 'toString', {
        value: function () { return nativeToString.call(nativeToString); },
        configurable: true
      });
    } catch (_) {}
  }
})();
