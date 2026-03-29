/**
 * Handles message relay for push notification suppression
 * and other security tasks across all websites.
 */

'use strict';

(function() {
  const DEBUG = false;
  const MSG = window.MSG; // Provided by messaging.js
  let isolatedPort; // This will hold our secure pipe

  // Token-Based Authorization: Request a unique session token from the background script.
  let secretToken = null;
  const getTokenFromBackground = async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_TOKEN' });
    if (response && response.token) {
      secretToken = response.token;
      return true;
    }
    return false;
  };

  const CONFIG = {
    blockPushNotifications: true,
    enabled: true
  };



  /**
   * Processes messages from the interceptor (via the secure MessagePort)
   * and routes them to the background script.
   */
  function processInterceptorMessage(data) {
    if (!data || data.source !== 'chroma-interceptor') return;


    // LEGACY: Handle existing message types that aren't yet using action/payload
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

  /**
   * Securely transfers the secret token to the MAIN world using
   * a two-way CustomEvent handshake with stopImmediatePropagation.
   */
  function initHandshake(selectors = {}) {
    // If background script failed to provide a token, abort handshake.
    if (!secretToken) {
      if (DEBUG) console.error('[Chroma Ad-Blocker] Token generation failed. Aborting handshake.');
      return; 
    }

    const handleMainReady = (e) => {
      // Stop the host page from knowing the extension is initializing
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }
      
      // Clean up the listener so it only fires once
      document.removeEventListener('__CHROMA_MAIN_READY__', handleMainReady, true);
      
      if (DEBUG) console.log('[Chroma Ad-Blocker] MAIN world ready. Delivering token.');

      // Dispatch the token securely via CustomEvent
      document.dispatchEvent(new CustomEvent('__CHROMA_TOKEN_DELIVERY__'));

      // Create the secure pipe (MessagePort)
      const channel = new MessageChannel();
      isolatedPort = channel.port1;

      // Set up a listener for messages coming FROM interceptor.js
      isolatedPort.onmessage = (e) => {
        if (DEBUG) console.log('[Chroma Ad-Blocker] Received via secure pipe:', e.data);
        processInterceptorMessage(e.data);
      };

      // Send port2 to the MAIN world via MessageEvent
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
        selectors: { ...selectors, ...CONFIG }
      });

      if (DEBUG) console.log('[Chroma Ad-Blocker] Secure port sent to MAIN world.');
    };

    // Attach the listener to catch the ping from interceptor.js
    document.addEventListener('__CHROMA_MAIN_READY__', handleMainReady, true);
  }

  /**
   * Signals the interceptor script whether protections should be active.
   */

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
    } else if (isWhitelisted) {
      CONFIG.enabled = false;
      CONFIG.blockPushNotifications = false;
    }
    
    // Cache only necessary state to pass to MAIN world
    const selectors = {
      enabled: CONFIG.enabled
    };

    
    await getTokenFromBackground();
    initHandshake(selectors); // Pass selectors to handshake
  });

  // Listen for config updates
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === MSG.CONFIG_UPDATE) {
      CONFIG.enabled = msg.config.enabled !== false;
      CONFIG.blockPushNotifications = msg.config.blockPushNotifications !== false;
      // Forward to MAIN world if port is active
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
