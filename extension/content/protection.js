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
  const pendingReadyTokens = new Set();
  const attemptedReadyTokens = new Set();
  const candidatePorts = new Set();
  const candidateTimeouts = new Map();
  const MAX_PENDING_READY_TOKENS = 8;
  const MAX_CANDIDATE_PORTS = 4;
  const CANDIDATE_TIMEOUT_MS = 500;
  let handshakeComplete = false;

  function deliverHandshakeForToken(readyToken) {
    if (!configReady || handshakeComplete || attemptedReadyTokens.has(readyToken)) return;
    if (candidatePorts.size >= MAX_CANDIDATE_PORTS) return;
    attemptedReadyTokens.add(readyToken);

    const portNonce = '__CHROMA_PT_' + crypto.getRandomValues(new Uint32Array(2)).join('_') + '__';
    document.dispatchEvent(new CustomEvent('__CHROMA_CONFIG_DELIVERY__', {
      detail: { portNonce, readyToken }
    }));

    const channel = new MessageChannel();
    const candidatePort = channel.port1;
    candidatePorts.add(candidatePort);
    const timeout = setTimeout(() => {
      candidateTimeouts.delete(candidatePort);
      candidatePorts.delete(candidatePort);
      attemptedReadyTokens.delete(readyToken);
      if (typeof candidatePort.close === 'function') candidatePort.close();
    }, CANDIDATE_TIMEOUT_MS);
    candidateTimeouts.set(candidatePort, timeout);
    candidatePort.onmessage = (event) => {
      if (event.data?.type !== 'CHROMA_READY' || handshakeComplete) return;
      handshakeComplete = true;
      isolatedPort = candidatePort;
      document.removeEventListener('__CHROMA_MAIN_READY__', handleMainReady, true);
      for (const port of candidatePorts) {
        const portTimeout = candidateTimeouts.get(port);
        if (portTimeout) clearTimeout(portTimeout);
        if (port !== candidatePort && typeof port.close === 'function') port.close();
      }
      candidateTimeouts.clear();
      candidatePorts.clear();
      attemptedReadyTokens.clear();
    };
    try {
      window.dispatchEvent(new MessageEvent(portNonce, { ports: [channel.port2] }));
    } catch (e) {
      window.dispatchEvent(new CustomEvent(portNonce, { detail: { port: channel.port2 } }));
    }

    candidatePort.postMessage({
      type: 'INIT_CHROMA',
      config: { ...CONFIG }
    });
    if (DEBUG) console.log('[Chroma Ad-Blocker] Secure port sent to MAIN world.');
  }

  function handleMainReady(e) {
    if (typeof e.stopImmediatePropagation === 'function') {
      e.stopImmediatePropagation();
    }
    const token = e.detail && e.detail.readyToken;
    if (typeof token !== 'string' || token.length < 8 || token.length > 160) return;
    if (configReady) {
      deliverHandshakeForToken(token);
      return;
    }
    if (!pendingReadyTokens.has(token) && pendingReadyTokens.size >= MAX_PENDING_READY_TOKENS) {
      pendingReadyTokens.delete(pendingReadyTokens.values().next().value);
    }
    pendingReadyTokens.add(token);
  }

  function deliverPendingHandshakes() {
    for (const token of pendingReadyTokens) deliverHandshakeForToken(token);
    pendingReadyTokens.clear();
  }

  function relayEffectiveConfig() {
    const relayPorts = isolatedPort ? [isolatedPort] : [...candidatePorts];
    for (const port of relayPorts) {
      port.postMessage({
        type: 'BACKGROUND_RESPONSE',
        data: { type: 'CONFIG_UPDATE', config: { ...CONFIG } }
      });
    }
  }

  // Install before asynchronous storage I/O so page listeners never observe
  // the MAIN challenge while configuration is loading.
  document.addEventListener('__CHROMA_MAIN_READY__', handleMainReady, true);

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
