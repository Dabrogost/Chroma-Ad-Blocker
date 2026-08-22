/**
 * Message router for chrome.runtime.onMessage.
 *
 * Owns sender authentication and dispatch. Registered handlers are restricted
 * to extension pages unless they explicitly opt in to own content scripts.
 */

const DEBUG = false;

const handlers = new Map();

function errorResponse(code, error) {
  return { ok: false, code, error };
}

function getSenderOrigin(sender) {
  if (sender?.origin) return sender.origin;
  if (!sender?.url) return null;
  try {
    return new URL(sender.url).origin;
  } catch {
    return null;
  }
}

export function registerHandler(type, fn, options = {}) {
  if (typeof type !== 'string' || type.length === 0) {
    throw new TypeError('Message handler type must be a non-empty string');
  }
  if (typeof fn !== 'function') {
    throw new TypeError(`Message handler for ${type} must be a function`);
  }
  if (handlers.has(type)) {
    throw new Error(`Message handler already registered for ${type}`);
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError(`Message handler options for ${type} must be an object`);
  }
  const unknownOptions = Object.keys(options).filter(key => key !== 'allowContentScripts');
  if (unknownOptions.length > 0 || (
    Object.prototype.hasOwnProperty.call(options, 'allowContentScripts') &&
    typeof options.allowContentScripts !== 'boolean'
  )) {
    throw new TypeError(`Invalid message handler options for ${type}`);
  }

  handlers.set(type, {
    fn,
    allowContentScripts: options.allowContentScripts === true
  });
}

export function attachListener() {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const handle = async () => {
      try {
        const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
        const type = msg?.type;
        const isFromExtensionPage = getSenderOrigin(sender) === extensionOrigin;
        const registration = handlers.get(type);

        if (!registration) {
          sendResponse(errorResponse('unknown_message', 'Unknown message type'));
          return;
        }

        const isAllowedContentScript = registration.allowContentScripts &&
          sender?.id === chrome.runtime.id &&
          Number.isInteger(sender?.tab?.id);
        if (!isFromExtensionPage && !isAllowedContentScript) {
          if (DEBUG) console.error('[Chroma Security] Blocked unauthorized message from:', getSenderOrigin(sender), type);
          sendResponse(errorResponse('unauthorized', 'Unauthorized message sender'));
          return;
        }

        const response = await registration.fn(msg, sender);
        sendResponse(response);
      } catch (err) {
        if (DEBUG) console.error('[Chroma] Error in message handler:', err);
        sendResponse(errorResponse('handler_error', 'Message handler failed'));
      }
    };

    const p = handle();
    if (typeof globalThis !== 'undefined' && globalThis.__CHROMA_INTERNAL_TEST_STRICT__ === true) return p;
    return true;
  });
}
