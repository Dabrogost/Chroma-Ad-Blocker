/**
 * Chroma Ad-Blocker — Scriptlet Injection Engine (userScripts API)
 * Maps subscriptionScriptletRules to chrome.userScripts.
 *
 * Requires manifest permissions: userScripts
 * Timing: document_start
 */

'use strict';

import { SCRIPTLET_MAP } from './lib.js';

const DEBUG = false;

/**
 * Synchronizes the chrome.userScripts registry with the current rules in storage.
 */
async function syncUserScripts() {
  try {
    const { subscriptionScriptletRules = [] } = await chrome.storage.local.get('subscriptionScriptletRules');
    
    // Clear existing registered scripts
    const existing = await chrome.userScripts.getScripts();
    if (existing.length > 0) {
      await chrome.userScripts.unregister({ ids: existing.map(s => s.id) });
    }

    if (subscriptionScriptletRules.length === 0) return;

    const userScripts = [];
    let scriptCounter = 0;

    for (const rule of subscriptionScriptletRules) {
      const fn = SCRIPTLET_MAP.get(rule.scriptlet);
      if (!fn) {
        if (DEBUG) console.warn(`[Chroma Scriptlets] Unknown scriptlet: ${rule.scriptlet}`);
        continue;
      }

      // Convert domains array to Chrome match patterns
      let matches = ['<all_urls>'];
      if (rule.domains && rule.domains.length > 0) {
        matches = [];
        for (const d of rule.domains) {
          matches.push(`*://${d}/*`);
          matches.push(`*://*.${d}/*`);
        }
      }

      const argsStr = JSON.stringify(rule.args || []);
      const code = `(${fn.toString()})(${argsStr});`;

      userScripts.push({
        id: `scriptlet_${++scriptCounter}`,
        matches: matches,
        js: [{ code }],
        runAt: rule.runAt || 'document_start',
        world: 'MAIN'
      });
    }

    if (userScripts.length > 0) {
      await chrome.userScripts.register(userScripts);
      if (DEBUG) console.log(`[Chroma Scriptlets] Registered ${userScripts.length} scriptlets to userScripts API.`);
    }
  } catch (err) {
    if (DEBUG) console.error('[Chroma Scriptlets] Failed to sync userScripts:', err);
  }
}

/**
 * Triggers a sync when subscription rules change
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.subscriptionScriptletRules) {
    if (DEBUG) console.log(`[Chroma Scriptlets] Rule change detected, re-syncing userScripts.`);
    syncUserScripts();
  }
});

// ─── INIT ─────
/**
 * Synchronize user scripts on service worker startup.
 */
export async function initScriptletEngine() {
  await syncUserScripts();
}
