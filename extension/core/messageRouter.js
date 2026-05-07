/**
 * Message router for chrome.runtime.onMessage.
 *
 * Owns origin authentication and dispatch. Handlers register themselves by
 * message type; sensitive types are restricted to trusted extension senders.
 */

import { MSG } from './messageTypes.js';

const DEBUG = false;

const handlers = new Map();
const sensitive = new Set();

function getSenderOrigin(sender) {
  if (sender?.origin) return sender.origin;
  if (!sender?.url) return null;
  try {
    return new URL(sender.url).origin;
  } catch {
    return null;
  }
}

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
        const type = msg?.type;
        const isFromExtensionPage = getSenderOrigin(sender) === extensionOrigin;
        const isStatsBatchFromOwnContentScript = type === MSG.STATS_EVENT_BATCH && sender.id === chrome.runtime.id;

        if (sensitive.has(type) && !isFromExtensionPage && !isStatsBatchFromOwnContentScript) {
          if (DEBUG) console.error('[Chroma Security] Blocked unauthorized message from:', getSenderOrigin(sender), type);
          return;
        }

        const fn = handlers.get(type);
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
