/**
 * Chroma Ad-Blocker Shared Messaging Utilities
 *
 * Note: Script is multi-injected. window property assignment bypasses
 * const/let declaration conflicts across injections.
 */

if (typeof window.MSG === 'undefined') {
  /**
   * Global message type definitions for consistent communication.
   */
  window.MSG = {
    CONFIG_GET: 'CONFIG_GET',
    CONFIG_SET: 'CONFIG_SET',
    CONFIG_UPDATE: 'CONFIG_UPDATE',
    STATS_RESET: 'STATS_RESET',
    SUSPICIOUS_ACTIVITY: 'SUSPICIOUS_ACTIVITY',
    GET_TOKEN: 'GET_TOKEN',
    WHITELIST_GET: 'WHITELIST_GET',
    WHITELIST_ADD: 'WHITELIST_ADD',
    WHITELIST_REMOVE: 'WHITELIST_REMOVE'
  };
}

if (typeof window.notifyBackground === 'undefined') {
  /**
   * Sends a message to the background service worker with unified error handling.
   * @param {Object} message - The message object to send.
   * @returns {Promise<any>} - A promise that resolves with the background's response.
   */
  window.notifyBackground = function(message) {
    try {
      return chrome.runtime.sendMessage(message).catch(err => {
        // Log warnings only in extension pages (like popup.html) to keep content console clean
        if (typeof window !== 'undefined' && window.location.protocol === 'chrome-extension:') {
           console.warn('[Chroma Ad-Blocker] Messaging error:', err);
        }
        return null;
      });
    } catch (err) {
      return Promise.resolve(null);
    }
  };
}
