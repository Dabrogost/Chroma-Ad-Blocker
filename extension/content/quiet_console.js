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
  let nativeSetAttribute = null;
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

  const NOOP_SCRIPT = 'data:text/javascript,void%200';
  const EMPTY_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  const EMPTY_CSS = 'data:text/css,/*%20chroma%20quiet%20*/';
  const EMPTY_FRAME = 'about:blank';

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

  function tagNameOf(element) {
    return String(element && element.tagName || '').toLowerCase();
  }

  function replacementFor(element, attrName) {
    const tag = tagNameOf(element);
    const attr = String(attrName || '').toLowerCase();
    if (attr === 'src') {
      if (tag === 'script') return NOOP_SCRIPT;
      if (tag === 'img') return EMPTY_IMAGE;
      if (tag === 'iframe') return EMPTY_FRAME;
    }
    if (attr === 'href' && tag === 'link') {
      return EMPTY_CSS;
    }
    return null;
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
    nativeSetAttribute = window.Element && Element.prototype.setAttribute;
    const nativeAppendChild = window.Node && Node.prototype.appendChild;
    const nativeInsertBefore = window.Node && Node.prototype.insertBefore;

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

    if (typeof nativeSetAttribute === 'function') {
      Element.prototype.setAttribute = function setAttribute(name, value) {
        const lname = String(name || '').toLowerCase();
        if ((lname === 'src' || lname === 'href') && shouldQuiet(value)) {
          const replacement = replacementFor(this, lname);
          if (replacement) {
            log('quiet attribute', lname, value);
            return nativeSetAttribute.call(this, name, replacement);
          }
        }
        return nativeSetAttribute.apply(this, arguments);
      };
      markNativeLike(Element.prototype.setAttribute, 'function setAttribute() { [native code] }');
    }

    patchUrlProperty(window.HTMLScriptElement && HTMLScriptElement.prototype, 'src', 'function set src() { [native code] }');
    patchUrlProperty(window.HTMLImageElement && HTMLImageElement.prototype, 'src', 'function set src() { [native code] }');
    patchUrlProperty(window.HTMLIFrameElement && HTMLIFrameElement.prototype, 'src', 'function set src() { [native code] }');
    patchUrlProperty(window.HTMLLinkElement && HTMLLinkElement.prototype, 'href', 'function set href() { [native code] }');

    if (typeof nativeAppendChild === 'function') {
      Node.prototype.appendChild = function appendChild(child) {
        rewriteQuietResources(child);
        return nativeAppendChild.apply(this, arguments);
      };
      markNativeLike(Node.prototype.appendChild, 'function appendChild() { [native code] }');
    }

    if (typeof nativeInsertBefore === 'function') {
      Node.prototype.insertBefore = function insertBefore(child, referenceNode) {
        rewriteQuietResources(child);
        return nativeInsertBefore.apply(this, arguments);
      };
      markNativeLike(Node.prototype.insertBefore, 'function insertBefore() { [native code] }');
    }

    installToStringSpoof();
  }

  function patchUrlProperty(proto, prop, nativeLabel) {
    if (!proto) return;
    let descriptor = null;
    try {
      descriptor = Object.getOwnPropertyDescriptor(proto, prop);
    } catch (_) {}
    if (!descriptor || typeof descriptor.set !== 'function' || descriptor.configurable === false) return;

    try {
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
          return descriptor.get ? descriptor.get.call(this) : '';
        },
        set(value) {
          if (shouldQuiet(value)) {
            const replacement = replacementFor(this, prop);
            if (replacement) {
              log('quiet property', prop, value);
              return descriptor.set.call(this, replacement);
            }
          }
          return descriptor.set.call(this, value);
        }
      });
    } catch (_) {
      return;
    }
    markNativeLike(Object.getOwnPropertyDescriptor(proto, prop).set, nativeLabel);
  }

  function rewriteElementResource(element) {
    if (!element || element.nodeType !== 1) return;
    const tag = tagNameOf(element);
    const attr = tag === 'link' ? 'href' : 'src';
    if (!['script', 'img', 'iframe', 'link'].includes(tag)) return;
    let current = '';
    try {
      current = element.getAttribute(attr) || element[attr] || '';
    } catch (_) {}
    if (!shouldQuiet(current)) return;
    const replacement = replacementFor(element, attr);
    if (!replacement || typeof nativeSetAttribute !== 'function') return;
    try {
      nativeSetAttribute.call(element, attr, replacement);
    } catch (_) {}
  }

  function rewriteQuietResources(node) {
    rewriteElementResource(node);
    if (!node || typeof node.querySelectorAll !== 'function') return;
    try {
      node.querySelectorAll('script[src],img[src],iframe[src],link[href]').forEach(rewriteElementResource);
    } catch (_) {}
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
