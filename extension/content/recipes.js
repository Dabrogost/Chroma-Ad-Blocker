(function () {
  'use strict';

  const DEBUG = false;
  const log = (...a) => { if (DEBUG) console.log('[Chroma Recipes]', ...a); };

  const nativeCreateElement = Document.prototype.createElement;
  const nativeQuerySelectorAll = Document.prototype.querySelectorAll;

  // ─── SITE DETECTION ─────

  const host = (location.hostname || '').toLowerCase();

  const SITE_KEYS = [
    'bellyfull.net', 'allrecipes.com', 'foodnetwork.com', 'epicurious.com',
    'bbcgoodfood.com', 'thekitchn.com', 'seriouseats.com', 'recipetineats.com',
    'smittenkitchen.com', 'budgetbytes.com', 'pinchofyum.com',
    'sallysbakingaddiction.com', 'minimalistbaker.com', 'thewoksoflife.com',
    'americastestkitchen.com', 'cooking.nytimes.com', 'weelicious.com',
    'pcgamer.com',
  ];

  const siteKey = SITE_KEYS.find(k => host === k || host.endsWith('.' + k));
  if (!siteKey) return;

  log('active on', host, 'matched', siteKey);

  // ─── RECIPE CARD PROTECTION ─────
  // If a node to be hidden/removed lives inside a recipe card, leave it alone.
  const RECIPE_CARD_SELECTORS = [
    '[itemtype*="Recipe" i]',
    '.wprm-recipe-container',
    '.wprm-recipe',
    '.tasty-recipes',
    '.tasty-recipe',
    '.mv-create-card',
    '.mv-recipe-card',
    '.recipe-card',
    '.recipe-content',
    '#recipe',
    '[class*="recipe-card"]',
  ].join(',');

  function insideRecipeCard(el) {
    return !!(el && el.closest && el.closest(RECIPE_CARD_SELECTORS));
  }

  // ─── SHARED CLUTTER SELECTORS ─────
  // Ad containers, sticky videos, newsletter modals, sponsor bars, share rails,
  // anti-adblock overlays. NOT article body / life-story prose.
  const SHARED_HIDE = [
    // Ad networks (Raptive/AdThrive/Mediavine/GPT/Taboola/Outbrain)
    '.adthrive', '[class^="adthrive-"]', '[class*=" adthrive-"]',
    '[id^="AdThrive_"]', '[id*="adthrive"]',
    '.mv-ad-box', '[class^="mv-ad-"]', '[class*=" mv-ad-"]',
    '[id^="mediavine-"]', '[id*="mediavine"]',
    '[id^="div-gpt-ad"]', '[id^="google_ads_iframe"]', '[id^="google_ads_frame"]',
    'ins.adsbygoogle',
    '[id^="taboola-"]', '[class*="taboola"]',
    '[id^="outbrain-"]', '[class*="outbrain"]', '[class*="OUTBRAIN"]',

    // Generic ad-ish containers
    '[id^="ad-"]', '[id^="ad_"]', '[class^="ad-slot"]', '[class^="ad_slot"]',
    '[class*="-advertisement"]', '[class*="sponsored"]',
    '[aria-label="Advertisement" i]', '[aria-label="advertisement" i]',
    '[data-ad-slot]', '[data-ad-unit]',

    // Sticky / floating video players
    '.jwplayer.jw-flag-floating', '.jw-flag-floating',
    '[class*="sticky-video"]', '[class*="floating-video"]',
    '[class*="video-sticky"]', '[id*="sticky-video"]',
    '.vjs-floating', '.video-player-sticky',

    // Newsletter / email signup modals & popups
    '.newsletter-modal', '.newsletter-popup', '.email-signup-modal',
    '[class*="newsletter-overlay"]', '[class*="subscribe-modal"]',
    '[aria-label*="newsletter" i][role="dialog"]',
    '.optinmonster', '[id^="om-"]', '[class^="om-"]',
    '.convertful-container', '.mc4wp-form-modal',

    // Anti-adblock overlays
    '[class*="adblock-detected"]', '[id*="adblock-detected"]',
    '[class*="adBlock"]', '[id*="adBlock"]',
    '.fc-ab-root', '.adblock-notice', '#adblock-notice',

    // Sponsor bars / floating share rails
    '[class*="sponsor-bar"]', '[class*="sponsored-by"]',
    '.a2a_floating_style', '.sharedaddy.sd-sharing-enabled .sd-block',
    '[class*="floating-share"]', '[class*="share-float"]',
  ];

  // ─── PER-HOST OVERRIDES ─────
  const PER_HOST = {
    'bellyfull.net': [
      '[id*="browseteriyaki"]',
      '[data-richload]', '[data-lockup]',
      '.grow-iframe-container', '#grow-signup',
    ],
    'foodnetwork.com': [
      '[class*="VideoRail"]', '[data-module="video-rail"]',
      '[class*="StickyVideo"]',
    ],
    'allrecipes.com': [
      '[class*="recirc-video"]', '[class*="inline-video-carousel"]',
      '[class*="comscore"]',
    ],
    'cooking.nytimes.com': [
      '[data-testid="paywall"]', '[class*="paywall"]',
      '[data-testid*="promo"]',
    ],
    'epicurious.com': [
      '[class*="persistent-aside"]', '[data-testid*="Ad"]',
    ],
    'bbcgoodfood.com': [
      '[class*="ad-slot"]', '[data-component="Ad"]',
    ],
    'seriouseats.com': [
      '[id^="mntl-"][id*="ad"]', '[class*="mntl-"][class*="-sc-"][class*="ad"]',
    ],
    'recipetineats.com': [
      '.code-block[class*="ad"]', '[id^="ezoic-pub-ad-placeholder"]',
    ],
    'pinchofyum.com': [
      '[id^="ezoic-"]', '[class*="ezoic"]',
    ],
    'sallysbakingaddiction.com': [
      '[class*="mv-ad-"]', '[id^="mv-creation-"][id$="-jtr"]',
    ],
    'weelicious.com': [
      '[id*="browseteriyaki"]',
      '.grow-iframe-container', '#grow-signup',
      '[class*="mv-ad-"]',
    ],
  };

  const hostOverrides = PER_HOST[siteKey] || [];
  // Append :not(html):not(body) so ad-network class patterns like
  // [class*=" adthrive-"] never accidentally hide <body> itself
  // (e.g. body.adthrive-device-desktop on CafeMedia/Raptive sites).
  const HIDE_SELECTORS = SHARED_HIDE.concat(hostOverrides)
    .map(s => `${s}:not(html):not(body)`);

  // ─── COSMETIC CSS ─────
  // Only use display:none — heavier properties (height:0, width:0, opacity:0)
  // cause cascade conflicts with WP Rocket / CafeMedia critical CSS.
  const CSS = `
${HIDE_SELECTORS.join(',\n')} {
  display: none !important;
}
`;

  function injectCSS() {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch (_) {
      const style = nativeCreateElement.call(document, 'style');
      style.setAttribute('data-chroma-recipes', '1');
      style.textContent = CSS;
      (document.head || document.documentElement).appendChild(style);
    }
  }

  // ─── ANTI-ADBLOCK SCRIPT CONTAINMENT ─────
  // Known anti-adblock script URL fragments. If createElement builds a <script>
  // whose src matches, swap to a data URL that no-ops.
  const BAD_SCRIPT_FRAGMENTS = [
    'ad-shield', 'blockadblock', 'fuckadblock', 'adbdetect',
    'browseteriyaki', 'adblock-detector',
    'content-loader.com', 'error-report.com',
    'html-load.com',
    // CafeMedia/Raptive ad framework — runs in MAIN world and removes <style>
    // elements from the DOM, destroying site styling.
    'ads.adthrive.com', 'adthrive.com/ads.',
  ];
  const NOOP_SRC = 'data:text/javascript,void%200';

  function isBadUrl(v) {
    try {
      const s = String(v);
      return BAD_SCRIPT_FRAGMENTS.some(f => s.includes(f));
    } catch (_) { return false; }
  }

  // Patch HTMLScriptElement.prototype.src once, for every future script.
  try {
    const scriptSrcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    if (scriptSrcDesc && scriptSrcDesc.configurable) {
      Object.defineProperty(HTMLScriptElement.prototype, 'src', {
        configurable: true,
        enumerable: scriptSrcDesc.enumerable,
        get() { return scriptSrcDesc.get.call(this); },
        set(v) {
          if (isBadUrl(v)) {
            log('neutered script.src →', v);
            this.setAttribute('data-chroma-neutered', '1');
            return scriptSrcDesc.set.call(this, NOOP_SRC);
          }
          return scriptSrcDesc.set.call(this, v);
        },
      });
    }
  } catch (_) {}

  // Anti-adblock injectors hide a recovery payload in the script's
  // onerror/onload HTML attrs; a sibling obfuscated script reads those
  // attrs and eval()s them, bypassing src neutering. Detect by content
  // (the script id is randomized per page load — Tqgkgu, keJwKkCjYCQs,
  // etc. — so we match the payload's signature instead).
  const PAYLOAD_MARKERS = [
    'html-load.com', 'content-loader.com', 'error-report.com',
    'problem loading the page', 'loader_light',
  ];
  function looksLikeInjectorPayload(v) {
    try {
      const s = String(v || '');
      if (s.length < 200) return false;
      return PAYLOAD_MARKERS.some(m => s.includes(m));
    } catch (_) { return false; }
  }
  // ─── NATIVE INTEGRITY CHECK ─────
  // Verify that setAttribute/getAttribute are still native before capturing.
  // If a page script has already monkey-patched these prototypes, skip
  // patching to avoid operating on untrusted code (dead-man's-switch).
  const _fnToString = Function.prototype.toString;
  function _isNative(fn) {
    try {
      return typeof fn === 'function' && _fnToString.call(fn).includes('[native code]');
    } catch (_) { return false; }
  }

  const _setAttr = Element.prototype.setAttribute;
  const _getAttr = Element.prototype.getAttribute;
  const _prototypesTrusted = _isNative(_setAttr) && _isNative(_getAttr);

  // Patch setAttribute so `el.setAttribute('src', url)` is caught too.
  if (_prototypesTrusted) {
    Element.prototype.setAttribute = function (name, value) {
      if (this.tagName === 'SCRIPT' && String(name).toLowerCase() === 'src' && isBadUrl(value)) {
        log('neutered setAttribute src →', value);
        _setAttr.call(this, 'data-chroma-neutered', '1');
        return _setAttr.call(this, 'src', NOOP_SRC);
      }
      if (this.tagName === 'SCRIPT') {
        const lname = String(name).toLowerCase();
        if ((lname === 'onerror' || lname === 'onload') && looksLikeInjectorPayload(value)) {
          log('blocked setAttribute', lname, 'on injector', this.id || '(no id)');
          return;
        }
      }
      if (this.tagName === 'META' && String(name).toLowerCase() === 'content'
          && looksLikeRedirectTrap(value)) {
        log('blocked meta-refresh →', value);
        return;
      }
      return _setAttr.call(this, name, value);
    };
  }

  // The HTML parser sets `onerror`/`onload` directly (not via setAttribute),
  // so a sibling inline script can eval the payload before any observer
  // fires. Intercept getAttribute so the reader script sees empty.
  if (_prototypesTrusted) {
    Element.prototype.getAttribute = function (name) {
      const v = _getAttr.call(this, name);
      if (this.tagName === 'SCRIPT') {
        const lname = String(name).toLowerCase();
        if ((lname === 'onerror' || lname === 'onload') && looksLikeInjectorPayload(v)) {
          log('hid injector', lname, 'from getAttribute');
          return '';
        }
      }
      return v;
    };
  }

  Document.prototype.createElement = function (tag, opts) {
    return nativeCreateElement.call(this, tag, opts);
  };

  // ─── REDIRECT GUARD ─────
  // content-loader.com / error-report.com redirect the top frame when they
  // can't phone home. Block any assignment that tries to send us there.
  const REDIRECT_BLOCKLIST = ['content-loader.com', 'error-report.com'];
  function looksLikeRedirectTrap(v) {
    try {
      const s = String(v);
      return REDIRECT_BLOCKLIST.some(b => s.includes(b));
    } catch (_) { return false; }
  }
  try {
    // `window.location` isn't reliably reconfigurable cross-browser; instead
    // patch the common setter paths on the existing Location object.
    const L = window.location;
    const origAssign = L.assign.bind(L);
    const origReplace = L.replace.bind(L);
    L.assign = function (url) {
      if (looksLikeRedirectTrap(url)) { log('blocked assign →', url); return; }
      return origAssign(url);
    };
    L.replace = function (url) {
      if (looksLikeRedirectTrap(url)) { log('blocked replace →', url); return; }
      return origReplace(url);
    };
    // Why: anti-adblock fallback calls reload(); F5 still works (browser-level).
    // Use defineProperty on Location.prototype so page scripts can't restore native.
    try {
      Object.defineProperty(Location.prototype, 'reload', {
        value: function () { log('blocked location.reload() from page script'); },
        writable: false,
        configurable: false,
      });
    } catch (_) {
      L.reload = function () { log('blocked location.reload() from page script'); };
    }
  } catch (_) {}

  // Suppress the fallback alert() the loader fires after all its sources fail.
  const BAD_ALERT_PATTERNS = [
    /problem loading the page/i,
    /ad.?block/i,
    /allow.+html-load\.com/i,
    /allow.+content-loader\.com/i,
    /allow ads/i,
    /please.+ads.+on this site/i,
  ];
  const origAlert = window.alert;
  window.alert = function (msg) {
    try {
      const s = String(msg == null ? '' : msg);
      if (BAD_ALERT_PATTERNS.some(r => r.test(s))) {
        log('swallowed alert →', s);
        return;
      }
    } catch (_) {}
    return origAlert.apply(this, arguments);
  };

  // Suppress the fallback confirm() some loaders use instead of alert().
  const origConfirm = window.confirm;
  window.confirm = function (msg) {
    try {
      const s = String(msg == null ? '' : msg);
      if (BAD_ALERT_PATTERNS.some(r => r.test(s))) {
        log('swallowed confirm →', s);
        return false;
      }
    } catch (_) {}
    return origConfirm.apply(this, arguments);
  };

  // ─── MUTATION OBSERVER ─────
  // Catch late-injected ad/overlay containers the CSS rules miss (inline styles,
  // dynamically-generated IDs, shadow wrappers).
  const AD_ID_PATTERN = /^(ad[_-]|google_ads_|taboola-|outbrain-|mediavine-|adthrive|om-)/i;

  function sweep(root) {
    const scope = root && root.querySelectorAll ? root : document;
    let nodes;
    try {
      nodes = nativeQuerySelectorAll.call(scope, HIDE_SELECTORS.join(','));
    } catch (_) { return; }
    for (const el of nodes) {
      if (insideRecipeCard(el)) continue;
      el.style.setProperty('display', 'none', 'important');
    }

    // ID-pattern sweep for things the selector list can't express generically.
    const idCandidates = nativeQuerySelectorAll.call(scope, '[id]');
    for (const el of idCandidates) {
      if (!AD_ID_PATTERN.test(el.id)) continue;
      if (insideRecipeCard(el)) continue;
      el.style.setProperty('display', 'none', 'important');
    }
  }

  let observer = null;
  function startObserver() {
    if (observer) observer.disconnect();
    let pending = new Set();
    let scheduled = false;

    observer = new MutationObserver((mutations) => {
      let added = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            pending.add(node);
            added = true;
          }
        }
      }
      if (added && !scheduled) {
        scheduled = true;
        requestAnimationFrame(() => {
          const batch = Array.from(pending);
          pending.clear();
          scheduled = false;
          for (const n of batch) sweep(n);
        });
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ─── BOOT ─────
  injectCSS();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      sweep(document);
      startObserver();
    }, { once: true });
  } else {
    sweep(document);
    startObserver();
  }
})();
