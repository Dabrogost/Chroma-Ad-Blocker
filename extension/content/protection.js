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

  const CONFIG = {
    enabled: true,
    acceleration: true,
    stripping: true,
  };
  let statsQueue = [];
  let statsTimer = null;
  const STATS_FLUSH_MS = 750;
  const STATS_BATCH_CAP = 50;

  function queueStatsEvent(event) {
    if (!event || typeof event !== 'object') return;
    statsQueue.push({
      ...event,
      ts: Date.now(),
      domain: window.location.hostname
    });
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

  document.addEventListener('__CHROMA_STATS_EVENT__', (event) => {
    const detail = event?.detail;
    if (!detail || typeof detail !== 'object') return;
    queueStatsEvent(detail);
  }, true);

  // ─── SECURE HANDSHAKE ─────
  /**
   * Securely transfers the configuration to the MAIN world.
   * SECURITY: Private Communication Channel Generation
   */
  function initHandshake() {
    const handleMainReady = (e) => {
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }
      
      document.removeEventListener('__CHROMA_MAIN_READY__', handleMainReady, true);
      
      if (DEBUG) console.log('[Chroma Ad-Blocker] MAIN world ready. Delivering config/selectors.');

      // Generate a per-session nonce for the port transfer event name.
      // This prevents page scripts from pre-registering for a predictable event.
      const portNonce = '__CHROMA_PT_' + crypto.getRandomValues(new Uint32Array(2)).join('_') + '__';

      // Deliver the nonce to interceptor.js via CustomEvent detail
      document.dispatchEvent(new CustomEvent('__CHROMA_CONFIG_DELIVERY__', { detail: { portNonce } }));

      const channel = new MessageChannel();
      isolatedPort = channel.port1;

      try {
        window.dispatchEvent(new MessageEvent(portNonce, {
          ports: [channel.port2]
        }));
      } catch (e) {
        window.dispatchEvent(new CustomEvent(portNonce, {
          detail: { port: channel.port2 }
        }));
      }

      // Deliver the payload through the protected pipe
      isolatedPort.postMessage({
        type: 'INIT_CHROMA',
        selectors: { ...CONFIG }
      });

      if (DEBUG) console.log('[Chroma Ad-Blocker] Secure port sent to MAIN world.');
    };

    document.addEventListener('__CHROMA_MAIN_READY__', handleMainReady, true);
  }

  // Initial sync with storage
  chrome.storage.local.get(['config', 'HIDE_SELECTORS', 'WARNING_SELECTORS', 'whitelist']).then(async (data) => {
    let isWhitelisted = false;
    const whitelist = data.whitelist || [];
    const hostname = window.location.hostname;
    
    if (whitelist.some(d => hostname === d || hostname.endsWith('.' + d))) {
      isWhitelisted = true;
      if (DEBUG) console.log('[Chroma] Domain is whitelisted. Staying inactive.');
    }

    const savedConfig = data.config;
    if (savedConfig) {
      CONFIG.enabled = isWhitelisted ? false : (savedConfig.enabled !== false);
      CONFIG.acceleration = isWhitelisted ? false : (savedConfig.acceleration !== false);
      CONFIG.stripping = isWhitelisted ? false : (savedConfig.stripping !== false);
    } else {
      // Fallback to defaults if storage is empty, but respect whitelist
      CONFIG.enabled = !isWhitelisted;
      CONFIG.acceleration = !isWhitelisted;
      CONFIG.stripping = !isWhitelisted;
    }
    
    document.dispatchEvent(new CustomEvent('__EXT_INIT__', { 
      detail: { 
        active: CONFIG.enabled,
        stripping: CONFIG.stripping,
        acceleration: CONFIG.acceleration
      } 
    }));

    // SECURITY: Secure Bridge Handshake
    initHandshake();
  });

  // ─── CONFIGURATION UPDATES ─────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === MSG.CONFIG_UPDATE) {
      CONFIG.enabled = msg.config.enabled !== false;
      CONFIG.acceleration = msg.config.acceleration !== false;
      CONFIG.stripping = msg.config.stripping !== false;

      document.dispatchEvent(new CustomEvent('__CHROMA_CONFIG_UPDATE__', { detail: msg.config }));

      if (isolatedPort) {
        isolatedPort.postMessage({
          type: 'BACKGROUND_RESPONSE',
          data: { type: 'CONFIG_UPDATE', config: msg.config }
        });
      }
    }
  });


  if (DEBUG) console.log('[Chroma Ad-Blocker] Protection script active.');
})();
