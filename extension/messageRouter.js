/**
 * Message router for chrome.runtime.onMessage.
 *
 * Owns origin authentication and dispatch. Handlers register themselves by
 * message type; sensitive types are restricted to the extension's own origin
 * so content scripts cannot invoke them.
 */

'use strict';

const DEBUG = false;

const handlers = new Map();
const sensitive = new Set();

export function registerHandler(type, fn) {
  handlers.set(type, fn);
}

export function markSensitive(type) {
  sensitive.add(type);
}

export function attachListener() {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const handle = async () => {
      try {
        const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
        const isFromInternal = sender.origin === extensionOrigin;

        if (sensitive.has(msg.type) && !isFromInternal) {
          if (DEBUG) console.error('[Chroma Security] Blocked unauthorized message from:', sender.origin, msg.type);
          return;
        }

        const fn = handlers.get(msg.type);
        if (!fn) return;

        const response = await fn(msg, sender);
        sendResponse(response);
      } catch (err) {
        if (DEBUG) console.error('[Chroma] Error in message handler:', err);
      }
    };

    const p = handle();
    if (typeof globalThis !== 'undefined' && globalThis.__CHROMA_INTERNAL_TEST_STRICT__ === true) return p;
    return true;
  });
}
