/**
 * Chroma Ad-Blocker Shared Messaging Utilities
 *
 * NOTE: This script is injected multiple times into some pages due to
 * overlapping manifest.json matches. We use guard clauses to prevent
 * SyntaxError: Identifier 'MSG' has already been declared.
 */

if (typeof window.MSG === 'undefined') {
  /**
   * Global message type definitions for consistent communication.
   */
  window.MSG = {
    CONFIG_GET: 'CONFIG_GET',
    CONFIG_SET: 'CONFIG_SET',
    CONFIG_UPDATE: 'CONFIG_UPDATE',
    STATS_GET: 'STATS_GET',
    STATS_RESET: 'STATS_RESET',
    STATS_UPDATE: 'STATS_UPDATE',
    DYNAMIC_RULE_ADD: 'DYNAMIC_RULE_ADD',
    WINDOW_OPEN_NOTIFY: 'WINDOW_OPEN_NOTIFY',
    SUSPICIOUS_ACTIVITY: 'SUSPICIOUS_ACTIVITY'
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
      // Catching synchronous errors (e.g. extension context invalidated)
      return Promise.resolve(null);
    }
  };
}
