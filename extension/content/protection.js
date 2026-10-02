/**
 * Handles secure handshake and configuration relay
 * between isolated and MAIN worlds across all websites.
 */

'use strict';

(function() {
  const DEBUG = false;
  if (!window.MSG) {
    console.error("[Chroma Error] window.MSG is missing. Expected messaging.js to provide it.");
    return;
  }
  if (!window.notifyBackground) {
    console.error("[Chroma Error] window.notifyBackground is missing. Expected messaging.js to provide it.");
    return;
  }
  const MSG = window.MSG; // Provided by messaging.js
  let isolatedPort;

  const CONFIG_DEFAULTS = Object.freeze({
    enabled: true,
    acceleration: false,
    stripping: true,
    accelerationSpeed: 8
  });
  const CONFIG_VALIDATORS = Object.freeze({
    enabled:           (value) => typeof value === 'boolean',
    acceleration:      (value) => typeof value === 'boolean',
    stripping:         (value) => typeof value === 'boolean',
    accelerationSpeed: (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 16
  });
  const SOURCE_CONFIG = Object.assign(Object.create(null), {
    enabled: false,
    acceleration: false,
    stripping: false,
    accelerationSpeed: 8
  });
  const CONFIG = Object.assign(Object.create(null), SOURCE_CONFIG);
  let configReady = false;
  let isWhitelisted = false;
  let pendingConfigPatch = null;
  let pendingWhitelistState = null;

  function getValidatedConfigPatch(source) {
    const patch = Object.create(null);
    if (!source || typeof source !== 'object' || Array.isArray(source)) return patch;
    for (const [key, validate] of Object.entries(CONFIG_VALIDATORS)) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const value = source[key];
      if (validate(value)) patch[key] = value;
    }
    return patch;
  }

  function refreshEffectiveConfig() {
    Object.assign(CONFIG, SOURCE_CONFIG);
    if (isWhitelisted) {
      CONFIG.enabled = false;
      CONFIG.acceleration = false;
      CONFIG.stripping = false;
    }
    if (CONFIG.enabled !== true || CONFIG.stripping !== true) {
      resetMainStatsIngress();
    }
  }

  function applyValidatedConfig(source, useDefaults = false) {
    if (useDefaults) Object.assign(SOURCE_CONFIG, CONFIG_DEFAULTS);
    Object.assign(SOURCE_CONFIG, getValidatedConfigPatch(source));
    refreshEffectiveConfig();
  }

  function matchesCurrentHostname(whitelist) {
    if (!Array.isArray(whitelist)) return false;
    const hostname = String(window.location.hostname || '').toLowerCase().replace(/\.$/, '');
    return whitelist.some((domain) => {
      if (typeof domain !== 'string') return false;
      const normalized = domain.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
      return normalized.length > 0 &&
        (hostname === normalized || hostname.endsWith('.' + normalized));
    });
  }
  let statsQueue = [];
  let statsTimer = null;
  const STATS_FLUSH_MS = 750;
  const STATS_BATCH_CAP = 50;
  const MAIN_STATS_EVENT = '__CHROMA_STATS_EVENT__';
  const YOUTUBE_PAYLOAD_MODIFIED = 'youtube_payload_modified';
  const MAIN_STATS_WINDOW_MS = 60_000;
  const MAIN_STATS_WINDOW_CAP = 20;
  let mainStatsWindowStartedAt = Date.now();
  let mainStatsWindowCount = 0;

  function resetMainStatsIngress() {
    if (statsTimer) {
      clearTimeout(statsTimer);
      statsTimer = null;
    }
    statsQueue.length = 0;
    mainStatsWindowStartedAt = Date.now();
    mainStatsWindowCount = 0;
  }

  function queueStatsEvent(eventType) {
    if (eventType !== YOUTUBE_PAYLOAD_MODIFIED) return;
    statsQueue.push({ eventType });
    if (statsQueue.length >= STATS_BATCH_CAP) {
      flushStatsQueue();
      return;
    }
    if (!statsTimer) statsTimer = setTimeout(flushStatsQueue, STATS_FLUSH_MS);
  }

  function flushStatsQueue() {
    if (statsTimer) {
      clearTimeout(statsTimer);
      statsTimer = null;
    }
    const events = statsQueue.splice(0, STATS_BATCH_CAP);
    if (events.length === 0) return;
    notifyBackground({ type: MSG.STATS_EVENT_BATCH, events });
  }

  document.addEventListener(MAIN_STATS_EVENT, (event) => {
    // MAIN-world DOM events are page-forgeable. Accept only a coarse enum and
    // derive all metadata outside MAIN; caller-supplied objects are rejected.
    if (event?.detail !== YOUTUBE_PAYLOAD_MODIFIED) return;
    if (!configReady || CONFIG.enabled !== true || CONFIG.stripping !== true) return;

    const now = Date.now();
    if (now - mainStatsWindowStartedAt >= MAIN_STATS_WINDOW_MS) {
      mainStatsWindowStartedAt = now;
      mainStatsWindowCount = 0;
    }
    if (mainStatsWindowCount >= MAIN_STATS_WINDOW_CAP) return;
    mainStatsWindowCount++;
    queueStatsEvent(YOUTUBE_PAYLOAD_MODIFIED);
  }, true);

  // ─── SECURE HANDSHAKE ─────
  /**
   * Securely transfers the configuration to the MAIN world.
   * SECURITY: Private Communication Channel Generation
   */
  let pendingReadyToken = null;
  let candidate = null;
  let handshakeComplete = false;

  function releaseCandidate(current, keepPort = false) {
    if (candidate !== current) return;
    current.port.onmessage = null;
    if (!keepPort) {
      current.port.close();
      current.peer.close();
    }
    candidate = null;
  }

  function deliverHandshakeForToken(readyToken) {
    if (!configReady || handshakeComplete || candidate) return;

    let current = null;
    try {
      const portNonce = '__CHROMA_PT_' + crypto.getRandomValues(new Uint32Array(4)).join('_') + '__';
      // MAIN consumes every delivery, but cancels only an authenticated one
      // after arming its nonce listener and deadline. Forged READY tokens
      // allocate no ports and cannot starve the genuine repeated challenge.
      const rejected = window.dispatchEvent(new CustomEvent('__CHROMA_CONFIG_DELIVERY__', {
        cancelable: true,
        detail: { portNonce, readyToken }
      }));
      if (rejected) return;

      const channel = new MessageChannel();
      current = { port: channel.port1, peer: channel.port2, readyToken };
      candidate = current;
      current.port.onmessage = (event) => {
        if (candidate !== current || event.data?.type !== 'CHROMA_READY' || handshakeComplete) return;
        handshakeComplete = true;
        isolatedPort = current.port;
        pendingReadyToken = null;
        window.removeEventListener('__CHROMA_MAIN_READY__', handleMainReady, true);
        releaseCandidate(current, true);
      };
      try {
        window.dispatchEvent(new MessageEvent(portNonce, { ports: [channel.port2] }));
      } catch (e) {
        window.dispatchEvent(new CustomEvent(portNonce, { detail: { port: channel.port2 } }));
      }

      current.port.postMessage({
        type: 'INIT_CHROMA',
        config: { ...CONFIG }
      });
      if (DEBUG) console.log('[Chroma Ad-Blocker] Secure port sent to MAIN world.');
    } catch (e) {
      // A broken primitive or failed transfer cannot enable MAIN. Its own
      // candidate expires, and a later READY can retry with a fresh challenge.
      if (current) releaseCandidate(current);
    }
  }

  function handleMainReady(e) {
    if (typeof e.stopImmediatePropagation === 'function') {
      e.stopImmediatePropagation();
    }
    const detail = e.detail;
    // MAIN alone owns the deadline. A local timer could close a committed
    // channel ahead of its queued CHROMA_READY. Only the hidden old challenge
    // can authenticate expiration, so forged READY cannot replace a candidate.
    if (candidate && detail?.expiredReadyToken === candidate.readyToken) {
      releaseCandidate(candidate);
    }
    const token = detail && detail.readyToken;
    if (typeof token !== 'string' || token.length < 8 || token.length > 160) return;
    if (configReady) {
      deliverHandshakeForToken(token);
      return;
    }
    pendingReadyToken = token;
  }

  function deliverPendingHandshakes() {
    const token = pendingReadyToken;
    pendingReadyToken = null;
    if (token) deliverHandshakeForToken(token);
  }

  function relayEffectiveConfig() {
    const relayPorts = isolatedPort ? [isolatedPort] : candidate ? [candidate.port] : [];
    for (const port of relayPorts) {
      port.postMessage({
        type: 'BACKGROUND_RESPONSE',
        data: { type: 'CONFIG_UPDATE', config: { ...CONFIG } }
      });
    }
  }

  // Install synchronously at document_start, before page scripts and storage
  // I/O. Window has no ancestor capture listener ahead of this secret event.
  window.addEventListener('__CHROMA_MAIN_READY__', handleMainReady, true);

  // Initial sync with storage
  chrome.storage.local.get(['config', 'whitelist']).then((data) => {
    isWhitelisted = matchesCurrentHostname(data.whitelist);
    if (pendingWhitelistState !== null) {
      isWhitelisted = pendingWhitelistState;
      pendingWhitelistState = null;
    }

    if (isWhitelisted) {
      if (DEBUG) console.log('[Chroma] Domain is whitelisted. Staying inactive.');
    }

    applyValidatedConfig(data.config || {}, true);
    if (pendingConfigPatch) {
      applyValidatedConfig(pendingConfigPatch, false);
      pendingConfigPatch = null;
    }
    configReady = true;
    deliverPendingHandshakes();
  }).catch(() => {
    // Storage is authoritative. If it cannot be read, finish the handshake
    // with the existing inert state instead of guessing enabled defaults.
    Object.assign(SOURCE_CONFIG, {
      enabled: false,
      acceleration: false,
      stripping: false,
      accelerationSpeed: 8
    });
    if (pendingWhitelistState !== null) {
      isWhitelisted = pendingWhitelistState;
      pendingWhitelistState = null;
    }
    refreshEffectiveConfig();
    if (pendingConfigPatch) {
      applyValidatedConfig(pendingConfigPatch, false);
      pendingConfigPatch = null;
    }
    configReady = true;
    deliverPendingHandshakes();
  });

  // ─── CONFIGURATION UPDATES ─────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === MSG.CONFIG_UPDATE) {
      if (!configReady) {
        pendingConfigPatch = {
          ...(pendingConfigPatch || {}),
          ...getValidatedConfigPatch(msg.config)
        };
        return;
      }
      applyValidatedConfig(msg.config, false);
      relayEffectiveConfig();
    }
  });

  // Whitelist changes do not mutate the master config. Derive and relay the
  // effective state so already-open tabs deactivate immediately and can later
  // restore the exact stored master settings when removed from the whitelist.
  if (chrome.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.whitelist) return;
      const nextWhitelisted = matchesCurrentHostname(changes.whitelist.newValue);
      if (!configReady) {
        pendingWhitelistState = nextWhitelisted;
        return;
      }
      if (nextWhitelisted === isWhitelisted) return;
      isWhitelisted = nextWhitelisted;
      refreshEffectiveConfig();
      relayEffectiveConfig();
    });
  }


  if (DEBUG) console.log('[Chroma Ad-Blocker] Protection script active.');
})();
