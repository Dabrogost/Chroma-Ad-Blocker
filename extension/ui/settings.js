/**
 * Chroma Ad-Blocker - Settings controller.
 * Settings-only entry point for shared UI plus settings-page affordances.
 */

'use strict';

(async () => {
  document.body.classList.add('app-hydrating');

  try {
    await ChromaApp.initSharedUI();
    ChromaApp.scrollToProxyHash();
  } catch (error) {
    console.error('Chroma settings failed to initialize:', error);

    const shell = document.getElementById('appShell');
    if (shell) {
      shell.innerHTML = `
        <div class="main-container">
          <div class="section-title">Settings</div>
          <div class="protection-list">
            <div class="toggle-row">
              <div class="toggle-info">
                <div class="name">Settings failed to load</div>
                <div class="desc">Reload the extension or check the extension console.</div>
              </div>
            </div>
          </div>
        </div>
      `;
    }
  } finally {
    document.body.classList.remove('app-hydrating');
    document.body.classList.add('app-ready');
  }
})();
