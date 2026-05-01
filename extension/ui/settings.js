/**
 * Chroma Ad-Blocker - Settings controller.
 * Settings-only entry point for shared UI plus settings-page affordances.
 */

'use strict';

(async () => {
  await ChromaApp.initSharedUI();
  ChromaApp.scrollToProxyHash();
})();
