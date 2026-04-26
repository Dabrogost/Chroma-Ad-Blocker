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
 * Removes attribute(s) from matching elements and watches for re-addition.
 * args[0]: space-separated list of attribute names (e.g. 'style data-ad')
 * args[1]: (optional) CSS selector to scope removal. Defaults to '[<attr>]' for each attr.
 */
export function removeAttr(args) {
  const attrStr = args[0];
  const selector = args[1];
  if (!attrStr) return;

  const attrs = attrStr.split(/\s+/).filter(Boolean);
  if (attrs.length === 0) return;

  const sel = selector || attrs.map(a => `[${a}]`).join(',');

  const remove = () => {
    try {
      document.querySelectorAll(sel).forEach(el => {
        for (let i = 0; i < attrs.length; i++) {
          if (el.hasAttribute(attrs[i])) el.removeAttribute(attrs[i]);
        }
      });
    } catch (e) {}
  };

  remove();

  new MutationObserver(remove).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: attrs
  });
}


/**
 * Removes nodes whose tag matches and whose textContent matches a pattern.
 * Useful for stripping inline <script> tags that contain ad-loader code.
 * args[0]: tag name (e.g. 'script') or '*' for any
 * args[1]: string or /regex/ pattern to match against textContent
 */
export function removeNodeText(args) {
  const tag = (args[0] || '*').toLowerCase();
  const pattern = args[1];
  if (!pattern) return;

  const isRegex = pattern.startsWith('/') && pattern.lastIndexOf('/') > 0;
  const re = isRegex ? new RegExp(pattern.slice(1, pattern.lastIndexOf('/'))) : null;
  const matches = (str) => re ? re.test(str) : String(str).includes(pattern);

  const sweep = () => {
    try {
      const nodes = tag === '*'
        ? document.querySelectorAll('*')
        : document.getElementsByTagName(tag);
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n && n.textContent && matches(n.textContent)) {
          if (n.parentNode) n.parentNode.removeChild(n);
        }
      }
    } catch (e) {}
  };

  sweep();

  new MutationObserver(sweep).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}


/**
 * Blocks addEventListener calls whose type and/or handler match a pattern.
 * args[0]: event type pattern — string or /regex/, '*' or empty matches any
 * args[1]: (optional) handler pattern — matched against handler.toString()
 */
export function preventAddEventListener(args) {
  const typePat = args[0];
  const handlerPat = args[1];

  const compile = (p) => {
    if (!p || p === '*') return null;
    const isRegex = p.startsWith('/') && p.lastIndexOf('/') > 0;
    if (isRegex) {
      const re = new RegExp(p.slice(1, p.lastIndexOf('/')));
      return (s) => re.test(String(s));
    }
    return (s) => String(s).includes(p);
  };

  const matchType = compile(typePat);
  const matchHandler = compile(handlerPat);

  const orig = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, listener) {
    try {
      const typeOk = !matchType || matchType(type);
      const handlerOk = !matchHandler || matchHandler(
        typeof listener === 'function' ? listener.toString() :
        (listener && typeof listener.handleEvent === 'function' ? listener.handleEvent.toString() : String(listener))
      );
      if (typeOk && handlerOk) return;
    } catch (e) {}
    return orig.apply(this, arguments);
  };
  EventTarget.prototype.addEventListener.toString = () => orig.toString();
}


/**
 * Sets a cookie to a fixed value to satisfy consent/dismiss prompts.
 * Mirrors uBlock's safelist: only well-known consent tokens are allowed
 * to prevent abuse via filter lists.
 * args[0]: cookie name
 * args[1]: cookie value (one of the allowed tokens below, or numeric)
 * args[2]: (optional) path, defaults to '/'
 */
export function setCookie(args) {
  const name = args[0];
  const value = args[1];
  const path = args[2] || '/';
  if (!name || value === undefined) return;

  const ALLOWED = new Set([
    'true', 'True', 'false', 'False',
    'yes', 'Yes', 'no', 'No',
    'ok', 'OK', 'accept', 'accepted', 'reject', 'rejected',
    'allow', 'deny',
    'on', 'off',
    '0', '1',
    '', 'null', 'undefined'
  ]);

  if (!ALLOWED.has(value) && !/^-?\d+$/.test(value)) return;

  try {
    const enc = encodeURIComponent(name) + '=' + encodeURIComponent(value);
    document.cookie = enc + '; path=' + path;
  } catch (e) {}
}


/**
 * Blocks window.open() calls whose URL matches a pattern.
 * Returns a no-op window-like object so callers chaining .focus()/.close() don't throw.
 * args[0]: URL string pattern, /regex/, or '*' / empty for any
 */
export function preventWindowOpen(args) {
  const pattern = args[0] || '*';

  const isRegex = pattern.startsWith('/') && pattern.lastIndexOf('/') > 0;
  const re = isRegex ? new RegExp(pattern.slice(1, pattern.lastIndexOf('/'))) : null;
  const matches = (url) => {
    if (pattern === '*') return true;
    if (re) return re.test(url);
    return String(url).includes(pattern);
  };

  const noopWin = new Proxy(function() {}, {
    get(_t, k) {
      if (k === 'closed') return true;
      if (k === 'location') return { href: '', assign() {}, replace() {}, reload() {} };
      if (k === 'document') return { write() {}, writeln() {}, open() {}, close() {} };
      return function() {};
    },
    set() { return true; }
  });

  const orig = window.open;
  window.open = function(url) {
    if (matches(url || '')) return noopWin;
    return orig.apply(this, arguments);
  };
  window.open.toString = () => orig.toString();
}


/**
 * Sets a localStorage item to a fixed value. Whitelisted to consent tokens
 * to mirror uBlock's safety model — a malicious filter can't write arbitrary
 * payloads.
 * args[0]: storage key
 * args[1]: value (allowed token or numeric string)
 */
export function setLocalStorageItem(args) {
  const key = args[0];
  const value = args[1];
  if (!key || value === undefined) return;

  const ALLOWED = new Set([
    'true', 'True', 'false', 'False',
    'yes', 'Yes', 'no', 'No',
    'ok', 'OK', 'accept', 'accepted', 'reject', 'rejected',
    'allow', 'deny',
    'on', 'off',
    '0', '1',
    '', 'null', 'undefined',
    '{}', '[]'
  ]);

  if (!ALLOWED.has(value) && !/^-?\d+$/.test(value)) return;

  try {
    window.localStorage.setItem(key, value);
  } catch (e) {}
}


/**
 * Replaces matching text inside nodes of a given tag.
 * args[0]: tag name (e.g. 'script') or '*' for any
 * args[1]: pattern — string or /regex/ — matched against textContent
 * args[2]: replacement string (use '' to strip)
 */
export function replaceNodeText(args) {
  const tag = (args[0] || '*').toLowerCase();
  const pattern = args[1];
  const replacement = args[2] !== undefined ? args[2] : '';
  if (!pattern) return;

  const isRegex = pattern.startsWith('/') && pattern.lastIndexOf('/') > 0;
  let re = null;
  if (isRegex) {
    const lastSlash = pattern.lastIndexOf('/');
    const flags = pattern.slice(lastSlash + 1);
    re = new RegExp(pattern.slice(1, lastSlash), flags.includes('g') ? flags : flags + 'g');
  }

  const replaceIn = (str) => re ? str.replace(re, replacement) : str.split(pattern).join(replacement);

  const sweep = () => {
    try {
      const nodes = tag === '*'
        ? document.querySelectorAll('*')
        : document.getElementsByTagName(tag);
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!n || !n.textContent) continue;
        const before = n.textContent;
        const after = replaceIn(before);
        if (after !== before) n.textContent = after;
      }
    } catch (e) {}
  };

  sweep();

  new MutationObserver(sweep).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
}


/**
 * Prevents requestAnimationFrame calls whose handler matches a pattern.
 * Useful for breaking ad/anti-adblock loops that schedule via rAF.
 * args[0]: string or /regex/ pattern matched against fn.toString()
 *          ('*' or empty matches any)
 */
export function preventRequestAnimationFrame(args) {
  const pattern = args[0] || '*';

  const isRegex = pattern.startsWith('/') && pattern.lastIndexOf('/') > 0;
  const re = isRegex ? new RegExp(pattern.slice(1, pattern.lastIndexOf('/'))) : null;
  const matches = (str) => {
    if (pattern === '*') return true;
    if (re) return re.test(str);
    return String(str).includes(pattern);
  };

  const orig = window.requestAnimationFrame;
  window.requestAnimationFrame = function(fn) {
    const fnStr = typeof fn === 'function' ? fn.toString() : String(fn);
    if (matches(fnStr)) return 0;
    return orig.apply(this, arguments);
  };
  window.requestAnimationFrame.toString = () => orig.toString();
}


/**
 * Aborts the currently-executing script when it reads a watched property.
 * When the getter fires, inspects document.currentScript and throws if its
 * inline text or src URL matches the needle. Used heavily by anti-adblock
 * and consent-wall lists to neutralize detector scripts.
 * args[0]: dot-notation property path (e.g. 'document.cookie' or 'foo.bar')
 * args[1]: (optional) needle — string or /regex/ matched against script.text or script.src.
 *          Empty/'*' matches any current script.
 */
export function abortCurrentScript(args) {
  const prop = args[0];
  const needle = args[1];
  if (!prop) return;

  const isRegex = needle && needle.startsWith('/') && needle.lastIndexOf('/') > 0;
  const re = isRegex ? new RegExp(needle.slice(1, needle.lastIndexOf('/'))) : null;
  const needleMatches = (str) => {
    if (!needle || needle === '*') return true;
    if (re) return re.test(str);
    return String(str).includes(needle);
  };

  const shouldAbort = () => {
    try {
      const cs = document.currentScript;
      if (!cs) return false;
      const haystack = (cs.src || cs.textContent || '');
      return needleMatches(haystack);
    } catch (e) { return false; }
  };

  const parts = prop.split('.');
  const last = parts[parts.length - 1];

  // Walk to the parent object, creating intermediate stubs only if missing.
  let obj = window;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (obj[k] === undefined || obj[k] === null) {
      try {
        Object.defineProperty(obj, k, { value: Object.create(null), writable: true, configurable: true });
      } catch (e) { return; }
    }
    obj = obj[k];
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return;
  }

  let stored;
  try {
    const desc = Object.getOwnPropertyDescriptor(obj, last);
    stored = desc && 'value' in desc ? desc.value : obj[last];
  } catch (e) { stored = undefined; }

  try {
    Object.defineProperty(obj, last, {
      get() {
        if (shouldAbort()) throw new ReferenceError(prop + ' aborted');
        return stored;
      },
      set(v) { stored = v; },
      configurable: true
    });
  } catch (e) {}
}


/**
 * Sets a sessionStorage item. Same safelist as setLocalStorageItem.
 * args[0]: storage key
 * args[1]: value (allowed token or numeric string)
 */
export function setSessionStorageItem(args) {
  const key = args[0];
  const value = args[1];
  if (!key || value === undefined) return;

  const ALLOWED = new Set([
    'true', 'True', 'false', 'False',
    'yes', 'Yes', 'no', 'No',
    'ok', 'OK', 'accept', 'accepted', 'reject', 'rejected',
    'allow', 'deny',
    'on', 'off',
    '0', '1',
    '', 'null', 'undefined',
    '{}', '[]'
  ]);

  if (!ALLOWED.has(value) && !/^-?\d+$/.test(value)) return;

  try {
    window.sessionStorage.setItem(key, value);
  } catch (e) {}
}


/**
 * Blocks src assignments on elements of a given tag whose URL matches a pattern.
 * Hooks both the src property setter and setAttribute('src', ...).
 * args[0]: tag name (e.g. 'img', 'script', 'iframe')
 * args[1]: URL pattern — string or /regex/, '*' / empty matches any
 */
export function preventElementSrcLoading(args) {
  const tag = (args[0] || '').toLowerCase();
  const pattern = args[1] || '*';
  if (!tag) return;

  const tagToProto = {
    img:    'HTMLImageElement',
    script: 'HTMLScriptElement',
    iframe: 'HTMLIFrameElement',
    video:  'HTMLVideoElement',
    audio:  'HTMLAudioElement',
    source: 'HTMLSourceElement',
    embed:  'HTMLEmbedElement',
    track:  'HTMLTrackElement'
  };
  const ctorName = tagToProto[tag];
  if (!ctorName || !window[ctorName]) return;

  const isRegex = pattern.startsWith('/') && pattern.lastIndexOf('/') > 0;
  const re = isRegex ? new RegExp(pattern.slice(1, pattern.lastIndexOf('/'))) : null;
  const matches = (url) => {
    if (pattern === '*') return true;
    if (re) return re.test(url);
    return String(url).includes(pattern);
  };

  const proto = window[ctorName].prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'src');
  if (!desc || !desc.set) return;

  const origSet = desc.set;
  const origGet = desc.get;

  try {
    Object.defineProperty(proto, 'src', {
      get() { return origGet ? origGet.call(this) : ''; },
      set(v) {
        if (matches(String(v))) return;
        return origSet.call(this, v);
      },
      configurable: true
    });
  } catch (e) { return; }

  const origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if (typeof name === 'string' &&
        name.toLowerCase() === 'src' &&
        this.tagName && this.tagName.toLowerCase() === tag &&
        matches(String(value))) {
      return;
    }
    return origSetAttr.apply(this, arguments);
  };
  Element.prototype.setAttribute.toString = () => origSetAttr.toString();
}


/**
 * Prunes ad segments from HLS (.m3u8) playlists.
 * Patches fetch and XHR; when a response is a playlist whose URL matches
 * args[1] (or any .m3u8 URL if omitted), drops segments whose tag block
 * or URI matches args[0].
 * args[0]: segment needle — string or /regex/
 * args[1]: (optional) playlist URL pattern — string or /regex/
 */
export function m3uPrune(args) {
  const needle = args[0];
  const urlPattern = args[1];
  if (!needle) return;

  const compile = (p) => {
    if (!p) return null;
    if (p.startsWith('/') && p.lastIndexOf('/') > 0) {
      const last = p.lastIndexOf('/');
      try { return new RegExp(p.slice(1, last), p.slice(last + 1)); } catch (e) { return null; }
    }
    return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  };
  const needleRe = compile(needle);
  const urlRe = compile(urlPattern);
  if (!needleRe) return;

  const isPlaylistUrl = (url) => {
    const u = String(url || '');
    if (urlRe) return urlRe.test(u);
    return /\.m3u8?(\?|$)/i.test(u);
  };

  const SEGMENT_TAGS = ['#EXTINF', '#EXT-X-DISCONTINUITY', '#EXT-X-CUE', '#EXT-X-SCTE35',
                        '#EXT-X-KEY', '#EXT-X-BYTERANGE', '#EXT-X-DATERANGE',
                        '#EXT-X-PROGRAM-DATE-TIME', '#EXT-X-MAP'];

  const prune = (text) => {
    if (typeof text !== 'string' || !text.includes('#EXTM3U')) return text;
    const lines = text.split(/\r?\n/);
    const out = [];
    let pending = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let isSegmentTag = false;
      for (let j = 0; j < SEGMENT_TAGS.length; j++) {
        if (line.startsWith(SEGMENT_TAGS[j])) { isSegmentTag = true; break; }
      }
      if (isSegmentTag) { pending.push(line); continue; }
      if (line.startsWith('#') || line === '') {
        if (pending.length) { for (const t of pending) out.push(t); pending = []; }
        out.push(line);
        continue;
      }
      const blob = pending.join('\n') + '\n' + line;
      if (needleRe.test(blob)) { pending = []; continue; }
      if (pending.length) { for (const t of pending) out.push(t); pending = []; }
      out.push(line);
    }
    if (pending.length) for (const t of pending) out.push(t);
    return out.join('\n');
  };

  const origFetch = window.fetch;
  window.fetch = function(input) {
    const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    const promise = origFetch.apply(this, arguments);
    if (!isPlaylistUrl(url)) return promise;
    return promise.then((resp) => {
      try {
        const clone = resp.clone();
        return clone.text().then((text) => {
          const pruned = prune(text);
          if (pruned === text) return resp;
          return new Response(pruned, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
        }).catch(() => resp);
      } catch (e) { return resp; }
    });
  };
  window.fetch.toString = () => origFetch.toString();

  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let watchedUrl = '';
    const origOpen = xhr.open.bind(xhr);
    xhr.open = function(method, url) {
      watchedUrl = String(url || '');
      return origOpen.apply(xhr, arguments);
    };
    xhr.addEventListener('readystatechange', function() {
      if (xhr.readyState !== 4 || !isPlaylistUrl(watchedUrl)) return;
      try {
        const text = xhr.responseText;
        const pruned = prune(text);
        if (pruned === text) return;
        Object.defineProperty(xhr, 'responseText', { value: pruned, configurable: true });
        Object.defineProperty(xhr, 'response',     { value: pruned, configurable: true });
      } catch (e) {}
    });
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  Object.defineProperty(window, 'XMLHttpRequest', { value: PatchedXHR, writable: true, configurable: true });
}


/**
 * Sets a cookie like setCookie, then reloads the page once if the cookie
 * wasn't already at the desired value. Used to push consent walls into
 * their dismissed state on first visit.
 * args[0]: cookie name
 * args[1]: value (allowed token or numeric — same safelist as setCookie)
 * args[2]: (optional) path, defaults to '/'
 */
export function setCookieReload(args) {
  const name = args[0];
  const value = args[1];
  const path = args[2] || '/';
  if (!name || value === undefined) return;

  const ALLOWED = new Set([
    'true', 'True', 'false', 'False',
    'yes', 'Yes', 'no', 'No',
    'ok', 'OK', 'accept', 'accepted', 'reject', 'rejected',
    'allow', 'deny',
    'on', 'off',
    '0', '1',
    '', 'null', 'undefined'
  ]);
  if (!ALLOWED.has(value) && !/^-?\d+$/.test(value)) return;

  let already = false;
  try {
    const enc = encodeURIComponent(name) + '=';
    const found = (document.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(enc));
    if (found && decodeURIComponent(found.slice(enc.length)) === value) already = true;
  } catch (e) {}

  try {
    document.cookie = encodeURIComponent(name) + '=' + encodeURIComponent(value) + '; path=' + path;
  } catch (e) { return; }

  if (!already) {
    try { window.location.reload(); } catch (e) {}
  }
}


/**
 * Removes cookies whose name matches a pattern, on this page and any
 * subsequent re-additions (polled). Expires the cookie on the page's
 * host plus each parent domain and root path to maximize removal.
 * args[0]: cookie name needle — string or /regex/
 */
export function cookieRemover(args) {
  const pattern = args[0];
  if (!pattern) return;

  const isRegex = pattern.startsWith('/') && pattern.lastIndexOf('/') > 0;
  let re = null;
  if (isRegex) {
    try {
      const last = pattern.lastIndexOf('/');
      re = new RegExp(pattern.slice(1, last), pattern.slice(last + 1));
    } catch (e) { return; }
  }
  const matches = (name) => re ? re.test(name) : name === pattern || name.includes(pattern);

  const buildDomains = () => {
    const host = location.hostname;
    if (!host) return [''];
    const parts = host.split('.');
    const domains = [''];
    for (let i = 0; i < parts.length - 1; i++) {
      domains.push(parts.slice(i).join('.'));
      domains.push('.' + parts.slice(i).join('.'));
    }
    return domains;
  };

  const expire = () => {
    let raw;
    try { raw = document.cookie; } catch (e) { return; }
    if (!raw) return;
    const domains = buildDomains();
    const paths = ['/', location.pathname || '/'];
    raw.split(';').forEach((c) => {
      const eq = c.indexOf('=');
      const name = (eq > -1 ? c.slice(0, eq) : c).trim();
      if (!name || !matches(name)) return;
      for (let p = 0; p < paths.length; p++) {
        for (let d = 0; d < domains.length; d++) {
          let s = encodeURIComponent(name) + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=' + paths[p];
          if (domains[d]) s += '; domain=' + domains[d];
          try { document.cookie = s; } catch (e) {}
        }
      }
    });
  };

  expire();
  try { setInterval(expire, 1000); } catch (e) {}
}


/**
 * Spoofs getComputedStyle/getBoundingClientRect for matching elements,
 * making blocked ad slots appear visible to anti-adblock detectors.
 * args[0]: CSS selector (or '*')
 * args[1]: property name — CSS prop ('display'), or a synthetic key
 *          ('width', 'height', 'top', 'left', 'right', 'bottom', 'x', 'y')
 *          for getBoundingClientRect
 * args[2]: value to report
 */
export function spoofCss(args) {
  const selector = args[0];
  const prop = args[1];
  const value = args[2];
  if (!selector || !prop || value === undefined) return;

  const isMatch = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (selector === '*') return true;
    try { return el.matches(selector); } catch (e) { return false; }
  };

  const cssProps = new Set([
    'display', 'visibility', 'opacity', 'position',
    'pointer-events', 'z-index', 'overflow', 'clip-path'
  ]);
  const rectProps = new Set(['width', 'height', 'top', 'left', 'right', 'bottom', 'x', 'y']);

  if (cssProps.has(prop)) {
    const origGCS = window.getComputedStyle;
    window.getComputedStyle = function(el, pseudo) {
      const cs = origGCS.call(this, el, pseudo);
      if (!isMatch(el)) return cs;
      return new Proxy(cs, {
        get(t, k) {
          if (k === prop || k === 'getPropertyValue') {
            if (k === 'getPropertyValue') {
              return function(name) {
                if (name === prop) return value;
                return t.getPropertyValue(name);
              };
            }
            return value;
          }
          const v = t[k];
          return typeof v === 'function' ? v.bind(t) : v;
        }
      });
    };
    window.getComputedStyle.toString = () => origGCS.toString();
  }

  if (rectProps.has(prop)) {
    const numeric = Number(value) || 0;
    const origRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function() {
      const r = origRect.apply(this, arguments);
      if (!isMatch(this)) return r;
      const o = {
        x: r.x, y: r.y, top: r.top, left: r.left,
        right: r.right, bottom: r.bottom,
        width: r.width, height: r.height
      };
      o[prop] = numeric;
      return o;
    };
    Element.prototype.getBoundingClientRect.toString = () => origRect.toString();
  }
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

/**
 * Intercepts JSON.parse and prunes specified dot-notation paths from the object.
 * Strictly enforces exact paths without recursive wildcards to maintain performance.
 * args[0]: space-separated list of paths (e.g. 'adPlacements playerResponse.adSlots')
 */
export function jsonPrune(args) {
  const pathsStr = args[0];
  if (!pathsStr) return;
  const paths = pathsStr.split(' ').filter(Boolean);
  if (paths.length === 0) return;

  const origParse = JSON.parse;
  JSON.parse = function(text, reviver) {
    const result = origParse.call(this, text, reviver);
    if (!result || typeof result !== 'object') return result;

    for (let i = 0; i < paths.length; i++) {
      const parts = paths[i].split('.');
      let obj = result;
      let valid = true;
      for (let j = 0; j < parts.length - 1; j++) {
        if (!obj || typeof obj !== 'object' || !(parts[j] in obj)) {
          valid = false;
          break;
        }
        obj = obj[parts[j]];
      }
      if (valid && obj && typeof obj === 'object') {
        const last = parts[parts.length - 1];
        if (last in obj) delete obj[last];
      }
    }
    return result;
  };
  JSON.parse.toString = () => origParse.toString();
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
  ['set',                     setConstant], // uBlock alias
  ['no-setTimeout-if',        noSetTimeoutIf],
  ['nostif',                  noSetTimeoutIf], // uBlock alias
  ['prevent-setTimeout',      noSetTimeoutIf], // uBlock alias
  ['no-setInterval-if',       noSetIntervalIf],
  ['nosiif',                  noSetIntervalIf], // uBlock alias
  ['prevent-fetch',           preventFetch],
  ['no-fetch-if',             preventFetch], // uBlock alias
  ['prevent-xhr',             preventXhr],
  ['no-xhr-if',               preventXhr], // uBlock alias
  ['remove-class',            removeClass],
  ['rc',                      removeClass], // uBlock alias
  ['remove-attr',             removeAttr],
  ['ra',                      removeAttr], // uBlock alias
  ['remove-node-text',        removeNodeText],
  ['rmnt',                    removeNodeText], // uBlock alias
  ['prevent-addEventListener', preventAddEventListener],
  ['aeld',                    preventAddEventListener], // uBlock alias
  ['no-addEventListener-if',  preventAddEventListener], // alt name
  ['set-cookie',              setCookie],
  ['set-local-storage-item',  setLocalStorageItem],
  ['sls',                     setLocalStorageItem], // uBlock alias
  ['set-session-storage-item', setSessionStorageItem],
  ['sss',                     setSessionStorageItem], // uBlock alias
  ['replace-node-text',       replaceNodeText],
  ['rpnt',                    replaceNodeText], // uBlock alias
  ['prevent-requestAnimationFrame', preventRequestAnimationFrame],
  ['no-raf-if',               preventRequestAnimationFrame], // uBlock alias
  ['norafif',                 preventRequestAnimationFrame], // uBlock alias
  ['abort-current-script',    abortCurrentScript],
  ['acs',                     abortCurrentScript], // uBlock alias
  ['abort-current-inline-script', abortCurrentScript],
  ['acis',                    abortCurrentScript], // uBlock alias
  ['prevent-element-src-loading', preventElementSrcLoading],
  ['m3u-prune',               m3uPrune],
  ['spoof-css',               spoofCss],
  ['set-cookie-reload',       setCookieReload],
  ['cookie-remover',          cookieRemover],
  ['cookie-remover.js',       cookieRemover], // legacy filename form
  ['remove-cookie',           cookieRemover], // alt name
  ['prevent-window-open',     preventWindowOpen],
  ['nowoif',                  preventWindowOpen], // uBlock alias
  ['no-window-open-if',       preventWindowOpen], // alt name
  ['no-eval-if',              noEvalIf],
  ['json-prune',              jsonPrune]
]);
