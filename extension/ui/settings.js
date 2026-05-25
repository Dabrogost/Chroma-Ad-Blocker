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
      if (globalThis.ChromaDom?.clearElement) {
        globalThis.ChromaDom.clearElement(shell);
      } else {
        shell.textContent = '';
      }
      const main = document.createElement('div');
      main.className = 'main-container';
      const title = document.createElement('div');
      title.className = 'section-title';
      title.textContent = 'Settings';
      const list = document.createElement('div');
      list.className = 'protection-list';
      const row = document.createElement('div');
      row.className = 'toggle-row';
      const info = document.createElement('div');
      info.className = 'toggle-info';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = 'Settings failed to load';
      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = 'Reload the extension or check the extension console.';
      info.append(name, desc);
      row.appendChild(info);
      list.appendChild(row);
      main.append(title, list);
      shell.appendChild(main);
    }
  } finally {
    document.body.classList.remove('app-hydrating');
    document.body.classList.add('app-ready');
  }
})();
