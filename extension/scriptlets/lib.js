/**
 * Chroma Ad-Blocker — Scriptlet Library
 * Each function is completely self-contained — no imports, no external references.
 * Functions are passed directly to chrome.scripting.executeScript as `func`.
 * Each receives a single `args` array of strings.
 */

'use strict';

// ─── SCRIPTLET IMPLEMENTATIONS ─────

/**
 * Throws a ReferenceError when a property is read.
 * Kills adblock detectors that check for window.adsbygoogle, window._googletag_config etc.
 * args[0]: dot-notation property path e.g. 'adsbygoogle' or 'google_ad_client'
 */
export function abortOnPropertyRead(args) {
  const prop = args[0];
  if (!prop) return;

  const abort = () => { throw new ReferenceError(prop + ' is not defined'); };
  const parts = prop.split('.');

  let obj = window;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof obj[parts[i]] === 'undefined') {
      try {
        Object.defineProperty(obj, parts[i], {
          get() { return Object.create(null); },
          configurable: true
        });
      } catch (e) { return; }
    }
    obj = obj[parts[i]];
    if (!obj || typeof obj !== 'object') return;
  }

  const last = parts[parts.length - 1];
  try {
    Object.defineProperty(obj, last, {
      get: abort,
      set() {},
      configurable: true
    });
  } catch (e) {}
}

/**
 * Throws a ReferenceError when a property is written.
 * args[0]: dot-notation property path
 */
export function abortOnPropertyWrite(args) {
  const prop = args[0];
  if (!prop) return;

  const parts = prop.split('.');
  let obj = window;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in obj)) return;
    obj = obj[parts[i]];
    if (!obj || typeof obj !== 'object') return;
  }

  const last = parts[parts.length - 1];
  try {
    Object.defineProperty(obj, last, {
      set() { throw new ReferenceError(prop + ' is read-only'); },
      get() { return undefined; },
      configurable: true
    });
  } catch (e) {}
}

/**
 * Forces a property to a constant value permanently.
 * args[0]: dot-notation property path
 * args[1]: value string — supports: true, false, null, undefined, noopFunc,
 *          trueFunc, falseFunc, emptyArray, emptyObj, or any numeric string
 */
export function setConstant(args) {
  const prop = args[0];
  let raw  = args[1];
  if (!prop || raw === undefined) return;

  let value;
  if (raw === 'true')        value = true;
  else if (raw === 'false')  value = false;
  else if (raw === 'null')   value = null;
  else if (raw === 'undefined') value = undefined;
  else if (raw === 'noopFunc')  value = function() {};
  else if (raw === 'trueFunc')  value = function() { return true; };
  else if (raw === 'falseFunc') value = function() { return false; };
  else if (raw === 'emptyArray') value = [];
  else if (raw === 'emptyObj')   value = {};
  else if (!isNaN(raw))     value = Number(raw);
  else                      value = raw;

  const parts = prop.split('.');
  let obj = window;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in obj)) obj[parts[i]] = Object.create(null);
    obj = obj[parts[i]];
    if (!obj || typeof obj !== 'object') return;
  }

  const last = parts[parts.length - 1];
  try {
    Object.defineProperty(obj, last, {
      get: () => value,
      set() {},
      configurable: false,
      enumerable: true
    });
  } catch (e) {}
}

/**
 * Prevents setTimeout calls whose handler matches a pattern.
 * args[0]: string or /regex/ pattern to match against fn.toString()
 * args[1]: (optional) exact delay value to match
 */
export function noSetTimeoutIf(args) {
  const pattern = args[0];
  const delay   = args[1];
  if (!pattern) return;

  const isRegex = pattern.startsWith('/') && pattern.lastIndexOf('/') > 0;
  const re = isRegex ? new RegExp(pattern.slice(1, pattern.lastIndexOf('/'))) : null;
  const matches = (str) => re ? re.test(str) : String(str).includes(pattern);

  const orig = window.setTimeout;
  window.setTimeout = function(fn, d) {
    const fnStr = typeof fn === 'function' ? fn.toString() : String(fn);
    if (matches(fnStr) && (delay === undefined || String(d) === String(delay))) return -1;
    return orig.apply(this, arguments);
  };
  window.setTimeout.toString = () => orig.toString();
}

/**
 * Prevents setInterval calls whose handler matches a pattern.
 * args[0]: string or /regex/ pattern
 * args[1]: (optional) exact delay value to match
 */
export function noSetIntervalIf(args) {
  const pattern = args[0];
  const delay   = args[1];
  if (!pattern) return;

  const isRegex = pattern.startsWith('/') && pattern.lastIndexOf('/') > 0;
  const re = isRegex ? new RegExp(pattern.slice(1, pattern.lastIndexOf('/'))) : null;
  const matches = (str) => re ? re.test(str) : String(str).includes(pattern);

  const orig = window.setInterval;
  window.setInterval = function(fn, d) {
    const fnStr = typeof fn === 'function' ? fn.toString() : String(fn);
    if (matches(fnStr) && (delay === undefined || String(d) === String(delay))) return -1;
    return orig.apply(this, arguments);
  };
  window.setInterval.toString = () => orig.toString();
}

/**
 * Blocks fetch() calls to URLs matching a pattern.
 * Returns an empty 200 response for blocked calls.
 * args[0]: URL string pattern, /regex/, or '*' to block all
 */
export function preventFetch(args) {
  const pattern = args[0] || '*';

  const isRegex = pattern.startsWith('/') && pattern.lastIndexOf('/') > 0;
  const re = isRegex ? new RegExp(pattern.slice(1, pattern.lastIndexOf('/'))) : null;
  const matches = (url) => {
    if (pattern === '*') return true;
    if (re) return re.test(url);
    return url.includes(pattern);
  };

  const orig = window.fetch;
  window.fetch = function(input) {
    const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    if (matches(url)) {
      return Promise.resolve(new Response(new Blob([''], { type: 'text/plain' }), { status: 200 }));
    }
    return orig.apply(this, arguments);
  };
  window.fetch.toString = () => orig.toString();
}

/**
 * Blocks XMLHttpRequest calls to URLs matching a pattern.
 * Silently aborts the request without firing error events.
 * args[0]: URL string pattern, /regex/, or '*' to block all
 */
export function preventXhr(args) {
  const pattern = args[0] || '*';

  const isRegex = pattern.startsWith('/') && pattern.lastIndexOf('/') > 0;
  const re = isRegex ? new RegExp(pattern.slice(1, pattern.lastIndexOf('/'))) : null;
  const matches = (url) => {
    if (pattern === '*') return true;
    if (re) return re.test(url);
    return url.includes(pattern);
  };

  const OrigXHR = window.XMLHttpRequest;

  function PatchedXHR() {
    const instance = new OrigXHR();
    let _blocked = false;

    const origOpen = instance.open.bind(instance);
    instance.open = function(method, url) {
      if (matches(String(url))) { _blocked = true; return; }
      return origOpen.apply(instance, arguments);
    };

    const origSend = instance.send.bind(instance);
    instance.send = function() {
      if (_blocked) return;
      return origSend.apply(instance, arguments);
    };

    return instance;
  }

  // Preserve prototype chain so instanceof checks pass
  PatchedXHR.prototype = OrigXHR.prototype;
  Object.defineProperty(window, 'XMLHttpRequest', { value: PatchedXHR, writable: true, configurable: true });
}

/**
 * Removes a CSS class from matching elements and watches for re-addition.
 * Useful for removing classes that trigger paywall overlays.
 * args[0]: class name to remove
 * args[1]: (optional) CSS selector to scope removal. Defaults to '*'
 */
export function removeClass(args) {
  const className = args[0];
  const selector  = args[1] || '*';
  if (!className) return;

  const remove = () => {
    try {
      document.querySelectorAll(selector).forEach(el => {
        if (el.classList.contains(className)) el.classList.remove(className);
      });
    } catch (e) {}
  };

  remove();

  new MutationObserver(remove).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });
}

/**
 * Blocks window.open calls to URLs matching a pattern.
 * Returns null (same as a blocked popup) for matched calls.
 * args[0]: URL string pattern, /regex/, or '*' to block all opens
 */
export function preventWindowOpen(args) {
  const pattern = args[0] || '*';

  const isRegex = pattern.startsWith('/') && pattern.lastIndexOf('/') > 0;
  const re = isRegex ? new RegExp(pattern.slice(1, pattern.lastIndexOf('/'))) : null;
  const matches = (url) => {
    if (pattern === '*') return true;
    if (re) return re.test(url);
    return !url || url.includes(pattern);
  };

  const orig = window.open;
  window.open = function(url) {
    if (matches(url || '')) return null;
    return orig.apply(this, arguments);
  };
  window.open.toString = () => orig.toString();
}

/**
 * Blocks eval() calls whose code string matches a pattern.
 * Returns undefined for blocked calls.
 * args[0]: string or /regex/ pattern to match against eval input
 */
export function noEvalIf(args) {
  const pattern = args[0];
  if (!pattern) return;

  const isRegex = pattern.startsWith('/') && pattern.lastIndexOf('/') > 0;
  const re = isRegex ? new RegExp(pattern.slice(1, pattern.lastIndexOf('/'))) : null;
  const matches = (str) => re ? re.test(str) : String(str).includes(pattern);

  const orig = window.eval;
  window.eval = function(code) {
    if (matches(String(code))) return undefined;
    return orig.call(this, code);
  };
  window.eval.toString = () => orig.toString();
}

// ─── SCRIPTLET MAP ─────
/**
 * Maps filter list scriptlet names to their implementation functions.
 * Both uBlock Origin and AdGuard naming conventions are included where they differ.
 */
export const SCRIPTLET_MAP = new Map([
  ['abort-on-property-read',  abortOnPropertyRead],
  ['aopr',                    abortOnPropertyRead], // uBlock alias
  ['abort-on-property-write', abortOnPropertyWrite],
  ['aopw',                    abortOnPropertyWrite], // uBlock alias
  ['set-constant',            setConstant],
  ['no-setTimeout-if',        noSetTimeoutIf],
  ['nostif',                  noSetTimeoutIf], // uBlock alias
  ['no-setInterval-if',       noSetIntervalIf],
  ['nosiif',                  noSetIntervalIf], // uBlock alias
  ['prevent-fetch',           preventFetch],
  ['no-fetch-if',             preventFetch], // uBlock alias
  ['prevent-xhr',             preventXhr],
  ['no-xhr-if',               preventXhr], // uBlock alias
  ['remove-class',            removeClass],
  ['prevent-window-open',     preventWindowOpen],
  ['no-window-open-if',       preventWindowOpen], // uBlock alias
  ['no-eval-if',              noEvalIf]
]);
