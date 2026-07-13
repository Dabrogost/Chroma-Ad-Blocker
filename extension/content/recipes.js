(function () {
  'use strict';

  const DEBUG = false;
  const log = (...a) => { if (DEBUG) console.log('[Chroma Recipes]', ...a); };

  const nativeCreateElement = Document.prototype.createElement;
  const nativeQuerySelectorAll = Document.prototype.querySelectorAll;
  const nativeAddDocEventListener = document.addEventListener.bind(document);
  const nativeRemoveDocEventListener = document.removeEventListener.bind(document);

  // ─── SITE DETECTION ─────

  const host = (location.hostname || '').toLowerCase();

  const SITE_KEYS = [
    'bellyfull.net', 'allrecipes.com', 'foodnetwork.com', 'epicurious.com',
    'bbcgoodfood.com', 'thekitchn.com', 'seriouseats.com', 'recipetineats.com',
    'smittenkitchen.com', 'budgetbytes.com', 'pinchofyum.com',
    'sallysbakingaddiction.com', 'minimalistbaker.com', 'thewoksoflife.com',
    'americastestkitchen.com', 'cooking.nytimes.com', 'weelicious.com',
    'therecipecritic.com', 'acozykitchen.com', 'twopeasandtheirpod.com',
    'halfbakedharvest.com',
    'pcgamer.com',
  ];

  const siteKey = SITE_KEYS.find(k => host === k || host.endsWith('.' + k));
  if (!siteKey) return;

  log('loaded inert on', host, 'matched', siteKey);

  // The Session 3 bridge reserves this name synchronously with an inert config
  // and advances revision only after authenticated MessagePort updates. Public
  // event details are never trusted.
  const getBridge = () => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(window, '__CHROMA_INTERNAL__');
      const bridge = descriptor?.value;
      if (!bridge || descriptor.configurable !== false || descriptor.writable !== false ||
          !Object.isFrozen(bridge)) return null;
      return bridge;
    } catch (_) {
      return null;
    }
  };
  const getBridgeConfig = () => getBridge()?.config || null;
  const getBridgeRevision = () => getBridge()?.revision;

  let isActive = false;
  let lifecycleGeneration = 0;
  let lastBridgeRevision = -1;
  const patchCleanups = [];
  const ownedPatches = new WeakMap();

  function getOwnedPatch(owner, key) {
    return ownedPatches.get(owner)?.get(key) || null;
  }

  function setOwnedPatch(owner, key, record) {
    let records = ownedPatches.get(owner);
    if (!records) {
      records = new Map();
      ownedPatches.set(owner, records);
    }
    records.set(key, record);
  }

  function clearOwnedPatch(owner, key, record) {
    const records = ownedPatches.get(owner);
    if (!records || records.get(key) !== record) return;
    records.delete(key);
    if (records.size === 0) ownedPatches.delete(owner);
  }

  function patchMethod(owner, key, createWrapper) {
    if (!owner) return null;
    const existingRecord = getOwnedPatch(owner, key);
    if (existingRecord) return existingRecord.wrapper;
    let originalDescriptor;
    let original;
    try {
      originalDescriptor = Object.getOwnPropertyDescriptor(owner, key);
      original = owner[key];
    } catch (_) {
      return null;
    }
    if (typeof original !== 'function') return null;
    if (originalDescriptor && !Object.prototype.hasOwnProperty.call(originalDescriptor, 'value')) {
      return null;
    }
    if (originalDescriptor && originalDescriptor.writable !== true) return null;

    const lifecycle = { active: true };
    const wrapper = createWrapper(original, lifecycle);
    try {
      if (originalDescriptor) {
        Object.defineProperty(owner, key, { ...originalDescriptor, value: wrapper });
      } else {
        owner[key] = wrapper;
      }
      if (owner[key] !== wrapper) return null;
    } catch (_) {
      return null;
    }

    const record = { wrapper, lifecycle };
    setOwnedPatch(owner, key, record);
    patchCleanups.push(() => {
      lifecycle.active = false;
      try {
        if (owner[key] === wrapper) {
          if (originalDescriptor) Object.defineProperty(owner, key, originalDescriptor);
          else delete owner[key];
        }
      } catch (_) {}
      clearOwnedPatch(owner, key, record);
    });
    return wrapper;
  }

  function restoreApiPatches() {
    while (patchCleanups.length > 0) {
      const cleanup = patchCleanups.pop();
      try { cleanup(); } catch (_) {}
    }
  }

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

  let recipeSheet = null;
  let recipeStyle = null;

  function getAdoptedStyleSheets() {
    const api = getBridge()?.api;
    try {
      if (api && typeof api.getAdoptedStyleSheets === 'function') {
        return api.getAdoptedStyleSheets();
      }
      return document.adoptedStyleSheets;
    } catch (_) {
      return [];
    }
  }

  function setAdoptedStyleSheets(sheets) {
    const api = getBridge()?.api;
    if (api && typeof api.setAdoptedStyleSheets === 'function') {
      api.setAdoptedStyleSheets(sheets);
      return;
    }
    document.adoptedStyleSheets = sheets;
  }

  function injectCSS() {
    if (!isActive) return;
    try {
      if (!recipeSheet) {
        const api = getBridge()?.api;
        recipeSheet = api && typeof api.createCssStyleSheet === 'function'
          ? api.createCssStyleSheet()
          : new CSSStyleSheet();
        if (!recipeSheet) throw new Error('Constructed stylesheets unavailable');
        recipeSheet.replaceSync(CSS);
      }
      const current = Array.from(getAdoptedStyleSheets() || []);
      if (!current.includes(recipeSheet)) setAdoptedStyleSheets([...current, recipeSheet]);
      return;
    } catch (_) {
      recipeSheet = null;
    }

    try {
      if (!recipeStyle || !recipeStyle.isConnected) {
        recipeStyle = nativeCreateElement.call(document, 'style');
        recipeStyle.setAttribute('data-chroma-recipes', '1');
        recipeStyle.textContent = CSS;
        (document.head || document.documentElement).appendChild(recipeStyle);
      }
    } catch (_) {}
  }

  function removeCSS() {
    if (recipeSheet) {
      try {
        const current = Array.from(getAdoptedStyleSheets() || []);
        if (current.includes(recipeSheet)) {
          setAdoptedStyleSheets(current.filter(sheet => sheet !== recipeSheet));
        }
      } catch (_) {}
      recipeSheet = null;
    }
    if (recipeStyle) {
      try {
        if (recipeStyle.parentNode) recipeStyle.parentNode.removeChild(recipeStyle);
      } catch (_) {}
      recipeStyle = null;
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

  function installScriptSrcPatch() {
    try {
      const owner = HTMLScriptElement.prototype;
      if (getOwnedPatch(owner, 'src')) return;
      const originalDescriptor = Object.getOwnPropertyDescriptor(owner, 'src');
      if (!originalDescriptor?.configurable || typeof originalDescriptor.get !== 'function' ||
          typeof originalDescriptor.set !== 'function') return;
      const lifecycle = { active: true };
      const wrapperGet = function () {
        return Reflect.apply(originalDescriptor.get, this, []);
      };
      const wrapperSet = function (value) {
        if (!lifecycle.active) return Reflect.apply(originalDescriptor.set, this, [value]);
        if (isBadUrl(value)) {
          log('neutered script.src →', value);
          try { this.setAttribute('data-chroma-neutered', '1'); } catch (_) {}
          return Reflect.apply(originalDescriptor.set, this, [NOOP_SRC]);
        }
        return Reflect.apply(originalDescriptor.set, this, [value]);
      };
      Object.defineProperty(owner, 'src', {
        configurable: true,
        enumerable: originalDescriptor.enumerable,
        get: wrapperGet,
        set: wrapperSet,
      });
      const record = { wrapper: wrapperSet, get: wrapperGet, set: wrapperSet, lifecycle };
      setOwnedPatch(owner, 'src', record);
      patchCleanups.push(() => {
        lifecycle.active = false;
        try {
          const current = Object.getOwnPropertyDescriptor(owner, 'src');
          if (current?.get === wrapperGet && current?.set === wrapperSet) {
            Object.defineProperty(owner, 'src', originalDescriptor);
          }
        } catch (_) {}
        clearOwnedPatch(owner, 'src', record);
      });
    } catch (_) {}
  }

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

  const initialSetAttribute = Element.prototype.setAttribute;
  const initialGetAttribute = Element.prototype.getAttribute;
  const initialAttributePrimitivesTrusted =
    _isNative(initialSetAttribute) && _isNative(initialGetAttribute);
  let attributePatchesEstablished = false;

  function installElementAttributePatches() {
    const currentSetAttribute = Element.prototype.setAttribute;
    const currentGetAttribute = Element.prototype.getAttribute;
    if (!initialAttributePrimitivesTrusted) return;
    // Before the first trusted installation, refuse a page replacement made
    // while configuration was still loading. After a prior Chroma lifecycle,
    // a preserved page wrapper is expected and receives a fresh active layer.
    if (!attributePatchesEstablished &&
        (currentSetAttribute !== initialSetAttribute || currentGetAttribute !== initialGetAttribute)) return;

    // Patch setAttribute so `el.setAttribute('src', url)` is caught too.
    const setWrapper = patchMethod(Element.prototype, 'setAttribute', (original, lifecycle) => function (name, value) {
      if (!lifecycle.active) return Reflect.apply(original, this, arguments);
      const lowerName = String(name).toLowerCase();
      if (this.tagName === 'SCRIPT' && lowerName === 'src' && isBadUrl(value)) {
        log('neutered setAttribute src →', value);
        Reflect.apply(original, this, ['data-chroma-neutered', '1']);
        return Reflect.apply(original, this, ['src', NOOP_SRC]);
      }
      if (this.tagName === 'SCRIPT' &&
          (lowerName === 'onerror' || lowerName === 'onload') &&
          looksLikeInjectorPayload(value)) {
        log('blocked setAttribute', lowerName, 'on injector', this.id || '(no id)');
        return;
      }
      if (this.tagName === 'META' && lowerName === 'content' && looksLikeRedirectTrap(value)) {
        log('blocked meta-refresh →', value);
        return;
      }
      return Reflect.apply(original, this, arguments);
    });

    // The HTML parser sets `onerror`/`onload` directly (not via setAttribute),
    // so a sibling inline script can eval the payload before an observer fires.
    const getWrapper = patchMethod(Element.prototype, 'getAttribute', (original, lifecycle) => function (name) {
      const value = Reflect.apply(original, this, arguments);
      if (!lifecycle.active) return value;
      if (this.tagName === 'SCRIPT') {
        const lowerName = String(name).toLowerCase();
        if ((lowerName === 'onerror' || lowerName === 'onload') &&
            looksLikeInjectorPayload(value)) {
          log('hid injector', lowerName, 'from getAttribute');
          return '';
        }
      }
      return value;
    });
    if (setWrapper || getWrapper) attributePatchesEstablished = true;
  }

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
  function installRedirectPatches() {
    patchMethod(Location.prototype, 'assign', (original, lifecycle) => function (url) {
      if (lifecycle.active && looksLikeRedirectTrap(url)) {
        log('blocked assign →', url);
        return;
      }
      return Reflect.apply(original, this, arguments);
    });
    patchMethod(Location.prototype, 'replace', (original, lifecycle) => function (url) {
      if (lifecycle.active && looksLikeRedirectTrap(url)) {
        log('blocked replace →', url);
        return;
      }
      return Reflect.apply(original, this, arguments);
    });
    // Page-triggered reloads are blocked only while active. The replacement is
    // kept configurable so deactivation can restore the original descriptor.
    patchMethod(Location.prototype, 'reload', (original, lifecycle) => function () {
      if (lifecycle.active) {
        log('blocked location.reload() from page script');
        return;
      }
      return Reflect.apply(original, this, arguments);
    });
  }

  // Suppress the fallback alert() the loader fires after all its sources fail.
  const BAD_ALERT_PATTERNS = [
    /problem loading the page/i,
    /ad.?block/i,
    /allow.+html-load\.com/i,
    /allow.+content-loader\.com/i,
    /allow ads/i,
    /please.+ads.+on this site/i,
  ];
  function installDialogPatches() {
    patchMethod(window, 'alert', (original, lifecycle) => function (message) {
      if (lifecycle.active) {
        try {
          const text = String(message == null ? '' : message);
          if (BAD_ALERT_PATTERNS.some(pattern => pattern.test(text))) {
            log('swallowed alert →', text);
            return;
          }
        } catch (_) {}
      }
      return Reflect.apply(original, this, arguments);
    });
    patchMethod(window, 'confirm', (original, lifecycle) => function (message) {
      if (lifecycle.active) {
        try {
          const text = String(message == null ? '' : message);
          if (BAD_ALERT_PATTERNS.some(pattern => pattern.test(text))) {
            log('swallowed confirm →', text);
            return false;
          }
        } catch (_) {}
      }
      return Reflect.apply(original, this, arguments);
    });
  }

  function installPcgamerFeatures() {
    if (siteKey !== 'pcgamer.com') return;
    const suffix = '_as_req';
    const lifecycle = { active: true };
    const messageHandler = event => {
      if (!lifecycle.active) return;
      if (event.source === window && typeof event.data === 'string' && event.data.endsWith(suffix)) {
        const token = event.data.slice(0, -suffix.length);
        window.postMessage(token + '_as_res', '*');
      }
    };
    const api = getBridge()?.api;
    try {
      if (api && typeof api.addEventListener === 'function') api.addEventListener('message', messageHandler);
      else window.addEventListener('message', messageHandler);
      patchCleanups.push(() => {
        lifecycle.active = false;
        try {
          if (api && typeof api.removeEventListener === 'function') api.removeEventListener('message', messageHandler);
          else window.removeEventListener('message', messageHandler);
        } catch (_) {}
      });
    } catch (_) {}

    patchMethod(Element.prototype, 'remove', (original, patchLifecycle) => function () {
      if (patchLifecycle.active && this === document.body) {
        log('blocked document.body.remove() for PCGamer');
        return;
      }
      return Reflect.apply(original, this, arguments);
    });
    patchMethod(History.prototype, 'go', (original, patchLifecycle) => function (delta) {
      if (patchLifecycle.active && (delta === 0 || delta === '0')) {
        log('blocked history.go(0) for PCGamer');
        return;
      }
      return Reflect.apply(original, this, arguments);
    });
  }

  // ─── MUTATION OBSERVER ─────
  // Catch late-injected ad/overlay containers the CSS rules miss (inline styles,
  // dynamically-generated IDs, shadow wrappers).
  const AD_ID_PATTERN = /^(ad[_-]|google_ads_|taboola-|outbrain-|mediavine-|adthrive|om-)/i;
  const hiddenElements = new Map();

  function hideElement(element) {
    if (!isActive || !element?.style || hiddenElements.has(element)) return;
    try {
      hiddenElements.set(element, {
        value: element.style.getPropertyValue('display'),
        priority: element.style.getPropertyPriority('display'),
      });
      element.style.setProperty('display', 'none', 'important');
    } catch (_) {
      hiddenElements.delete(element);
    }
  }

  function restoreHiddenElements() {
    for (const [element, original] of hiddenElements) {
      try {
        // Do not overwrite a style that the page changed after Chroma hid it.
        if (element.style.getPropertyValue('display') !== 'none' ||
            element.style.getPropertyPriority('display') !== 'important') continue;
        if (original.value) element.style.setProperty('display', original.value, original.priority);
        else element.style.removeProperty('display');
      } catch (_) {}
    }
    hiddenElements.clear();
  }

  function sweep(root) {
    if (!isActive) return;
    const scope = root && root.querySelectorAll ? root : document;
    let nodes;
    try {
      nodes = nativeQuerySelectorAll.call(scope, HIDE_SELECTORS.join(','));
    } catch (_) { return; }
    for (const el of nodes) {
      if (insideRecipeCard(el)) continue;
      hideElement(el);
    }

    // ID-pattern sweep for things the selector list can't express generically.
    const idCandidates = nativeQuerySelectorAll.call(scope, '[id]');
    for (const el of idCandidates) {
      if (!AD_ID_PATTERN.test(el.id)) continue;
      if (insideRecipeCard(el)) continue;
      hideElement(el);
    }
  }

  let observer = null;
  let pendingNodes = new Set();
  let scheduledAnimationFrame = null;
  let domReadyHandler = null;

  function requestFrame(callback) {
    const api = getBridge()?.api;
    if (api && typeof api.requestAnimationFrame === 'function') return api.requestAnimationFrame(callback);
    return window.requestAnimationFrame(callback);
  }

  function cancelFrame(id) {
    const api = getBridge()?.api;
    if (api && typeof api.cancelAnimationFrame === 'function') api.cancelAnimationFrame(id);
    else if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(id);
  }

  function startObserver() {
    if (!isActive || observer || !document.documentElement) return;
    const generation = lifecycleGeneration;

    observer = new MutationObserver((mutations) => {
      if (!isActive || generation !== lifecycleGeneration) return;
      let added = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            pendingNodes.add(node);
            added = true;
          }
        }
      }
      if (added && scheduledAnimationFrame == null) {
        const schedule = { id: null, generation };
        scheduledAnimationFrame = schedule;
        schedule.id = requestFrame(() => {
          // A canceled callback may still run. It must not clear a newer
          // generation's frame record or pending batch.
          if (scheduledAnimationFrame !== schedule) return;
          scheduledAnimationFrame = null;
          if (!isActive || generation !== lifecycleGeneration) {
            pendingNodes.clear();
            return;
          }
          const batch = Array.from(pendingNodes);
          pendingNodes.clear();
          for (const node of batch) sweep(node);
        });
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function startDomLifecycle() {
    if (!isActive) return;
    if (document.readyState !== 'loading') {
      sweep(document);
      startObserver();
      return;
    }
    const generation = lifecycleGeneration;
    domReadyHandler = () => {
      domReadyHandler = null;
      if (!isActive || generation !== lifecycleGeneration) return;
      sweep(document);
      startObserver();
    };
    nativeAddDocEventListener('DOMContentLoaded', domReadyHandler, { once: true });
  }

  function stopDomLifecycle() {
    if (domReadyHandler) {
      try { nativeRemoveDocEventListener('DOMContentLoaded', domReadyHandler); } catch (_) {}
      domReadyHandler = null;
    }
    if (observer) {
      try { observer.disconnect(); } catch (_) {}
      observer = null;
    }
    if (scheduledAnimationFrame != null) {
      const schedule = scheduledAnimationFrame;
      scheduledAnimationFrame = null;
      try { cancelFrame(schedule.id); } catch (_) {}
    }
    pendingNodes.clear();
  }

  function installApiPatches() {
    installElementAttributePatches();
    installScriptSrcPatch();
    installRedirectPatches();
    installDialogPatches();
    installPcgamerFeatures();
  }

  function activate() {
    if (isActive) return;
    isActive = true;
    lifecycleGeneration++;
    installApiPatches();
    injectCSS();
    startDomLifecycle();
    log('activated at bridge revision', lastBridgeRevision);
  }

  function deactivate() {
    if (!isActive && patchCleanups.length === 0 && hiddenElements.size === 0) return;
    // Flip the global lifecycle first. Individual API cleanup callbacks then
    // permanently deactivate their own cells before attempting restoration.
    isActive = false;
    lifecycleGeneration++;
    stopDomLifecycle();
    removeCSS();
    restoreHiddenElements();
    restoreApiPatches();
    log('deactivated at bridge revision', lastBridgeRevision);
  }

  function reconcileTrustedConfig() {
    const bridge = getBridge();
    if (!bridge) {
      deactivate();
      return;
    }
    const revision = getBridgeRevision();
    if (!Number.isSafeInteger(revision) || revision < 0 || revision <= lastBridgeRevision) return;
    const config = getBridgeConfig();
    if (!config || !Object.isFrozen(config) || typeof config.enabled !== 'boolean') {
      deactivate();
      return;
    }
    lastBridgeRevision = revision;
    if (config.enabled === true) activate();
    else deactivate();
  }

  // These events are notification-only and therefore safe for pages to forge:
  // every callback re-reads the immutable bridge and requires a newer revision.
  nativeAddDocEventListener('__CHROMA_BRIDGE_READY__', reconcileTrustedConfig, true);
  nativeAddDocEventListener('__CHROMA_CONFIG_UPDATE__', reconcileTrustedConfig, true);
  reconcileTrustedConfig();
})();
