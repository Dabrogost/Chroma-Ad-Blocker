/**
 * Handles message relay for push notification suppression
 * and other security tasks across all websites.
 */

'use strict';

(function() {
  const DEBUG = false;
  const MSG = window.MSG; // Provided by messaging.js
  let isolatedPort;
  let secretToken;

  // SECURITY: Session Token Retrieval
  /** @returns {Promise<boolean>} */
  const getTokenFromBackground = async () => {
    const response = await window.notifyBackground({ type: MSG.GET_TOKEN });
    if (response && response.token) {
      secretToken = response.token;
      return true;
    }
    return false;
  };

  const CONFIG = {
    blockPushNotifications: true,
    enabled: true,
    acceleration: true
  };



  // ─── MESSAGE PROCESSING ─────
  /** @param {Object} data */
  function processInterceptorMessage(data) {
    if (!data || data.source !== 'chroma-interceptor') return;


    // Legacy: Handle existing message types that aren't yet using action/payload.
    if (data.type === 'NOTIFICATION_ATTEMPT') {
      if (DEBUG) console.log('[Chroma Ad-Blocker] Blocked notification attempt');
      notifyBackground({
        type: MSG.SUSPICIOUS_ACTIVITY,
        token: data.token,
        activity: data.type
      });
      return;
    }

  }

  /**
   * Listen for messages from the MAIN world interceptor
   */

  // ─── SECURE HANDSHAKE ─────
  /**
   * Securely transfers the secret token to the MAIN world.
   * SECURITY: Private Communication Channel Generation
   */
  function initHandshake() {
    if (!secretToken) {
      if (DEBUG) console.error('[Chroma Ad-Blocker] Token generation failed. Aborting handshake.');
      return; 
    }

    const handleMainReady = (e) => {
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }
      
      document.removeEventListener('__CHROMA_MAIN_READY__', handleMainReady, true);
      
      if (DEBUG) console.log('[Chroma Ad-Blocker] MAIN world ready. Delivering token.');

      // Dispatch the token securely via CustomEvent
      document.dispatchEvent(new CustomEvent('__CHROMA_TOKEN_DELIVERY__'));

      const channel = new MessageChannel();
      isolatedPort = channel.port1;

      isolatedPort.onmessage = (e) => {
        if (DEBUG) console.log('[Chroma Ad-Blocker] Received via secure pipe:', e.data);
        processInterceptorMessage(e.data);
      };

      try {
        window.dispatchEvent(new MessageEvent('__CHROMA_PORT_TRANSFER__', {
          ports: [channel.port2]
        }));
      } catch (e) {
        window.dispatchEvent(new CustomEvent('__CHROMA_PORT_TRANSFER__', {
          detail: { port: channel.port2 }
        }));
      }

      // Deliver the payload through the protected pipe
      isolatedPort.postMessage({
        type: 'INIT_CHROMA',
        token: secretToken,
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
      document.documentElement.setAttribute('data-chroma-whitelisted', 'true');
    }

    const savedConfig = data.config;
    if (savedConfig) {
      CONFIG.enabled = isWhitelisted ? false : (savedConfig.enabled !== false);
      CONFIG.blockPushNotifications = isWhitelisted ? false : (savedConfig.blockPushNotifications !== false);
      CONFIG.acceleration = isWhitelisted ? false : (savedConfig.acceleration !== false);
    } else if (isWhitelisted) {
      CONFIG.enabled = false;
      CONFIG.blockPushNotifications = false;
      CONFIG.acceleration = false;
    }
    
    // Set DOM attributes for immediate kill-switch access in MAIN world
    document.documentElement.setAttribute('data-chroma-enabled', CONFIG.enabled);
    document.documentElement.setAttribute('data-chroma-acceleration', CONFIG.acceleration);

    // SECURITY: Secure Bridge Handshake
    await getTokenFromBackground();
    initHandshake();
    document.documentElement.setAttribute('data-chroma-init', 'complete'); // SECURITY: Security Context Initialization
  });

  // ─── CONFIGURATION UPDATES ─────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === MSG.CONFIG_UPDATE) {
      CONFIG.enabled = msg.config.enabled !== false;
      CONFIG.blockPushNotifications = msg.config.blockPushNotifications !== false;
      CONFIG.acceleration = msg.config.acceleration !== false;

      // Update DOM attributes for live kill-switch response
      document.documentElement.setAttribute('data-chroma-enabled', CONFIG.enabled);
      document.documentElement.setAttribute('data-chroma-acceleration', CONFIG.acceleration);
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
