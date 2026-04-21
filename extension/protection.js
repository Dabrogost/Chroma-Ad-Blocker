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
    } else if (isWhitelisted) {
      CONFIG.enabled = false;
      CONFIG.acceleration = false;
      CONFIG.stripping = false;
    }
    
    document.dispatchEvent(new CustomEvent('__EXT_INIT__', { detail: { active: CONFIG.enabled } }));

    // SECURITY: Secure Bridge Handshake
    initHandshake();
  });

  // ─── CONFIGURATION UPDATES ─────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === MSG.CONFIG_UPDATE) {
      CONFIG.enabled = msg.config.enabled !== false;
      CONFIG.acceleration = msg.config.acceleration !== false;

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
