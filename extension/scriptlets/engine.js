/**
 * Chroma Ad-Blocker — Scriptlet Injection Engine (userScripts API)
 * Maps subscriptionScriptletRules to chrome.userScripts.
 *
 * Requires manifest permissions: userScripts
 * Timing: document_start
 */

'use strict';

import { SCRIPTLET_MAP } from './lib.js';

const DEBUG = true;

/**
 * Synchronizes the chrome.userScripts registry with the current rules in storage.
 */
// Serialize sync calls. storage.onChanged can fire multiple times in rapid
// succession (once per subscription refresh); concurrent syncs race on the
// unregister/register pair and collide on script IDs.
let _syncInFlight = null;
let _syncPending = false;

function syncUserScripts() {
  if (_syncInFlight) {
    _syncPending = true;
    return _syncInFlight;
  }
  _syncInFlight = (async () => {
    try {
      await _syncUserScriptsImpl();
    } finally {
      _syncInFlight = null;
      if (_syncPending) {
        _syncPending = false;
        syncUserScripts();
      }
    }
  })();
  return _syncInFlight;
}

// Filter-list domains can include forms Chrome match patterns reject:
// negations (~foo.com), TLD wildcards (foo.*), entity names (no dot),
// embedded path/port chars, IPv6, etc. A single bad pattern rejects the
// whole register() batch, so we sanitize aggressively and drop the rule
// if nothing usable remains.
function sanitizeDomain(d) {
  if (!d) return null;
  if (d.startsWith('~')) return null;          // negation — not supported
  if (d.endsWith('.*')) return null;           // TLD wildcard
  if (d.includes('/') || d.includes(':') || d.includes('?') || d.includes('#')) return null;
  if (d.includes(' ')) return null;
  if (!d.includes('.')) return null;           // entity / bare label
  if (d.startsWith('*.')) d = d.slice(2);      // we'll add the wildcard ourselves
  if (!/^[a-z0-9.-]+$/i.test(d)) return null;
  return d;
}

const CHUNK_SIZE = 100;

async function _syncUserScriptsImpl() {
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
    let droppedDomains = 0;
    let droppedRules = 0;

    for (const rule of subscriptionScriptletRules) {
      const fn = SCRIPTLET_MAP.get(rule.scriptlet);
      if (!fn) {
        if (DEBUG) console.warn(`[Chroma Scriptlets] Unknown scriptlet: ${rule.scriptlet}`);
        continue;
      }

      let matches = ['<all_urls>'];
      if (rule.domains && rule.domains.length > 0) {
        matches = [];
        for (const raw of rule.domains) {
          const d = sanitizeDomain(raw);
          if (!d) { droppedDomains++; continue; }
          matches.push(`*://${d}/*`);
          matches.push(`*://*.${d}/*`);
        }
        if (matches.length === 0) {
          droppedRules++;
          continue;
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

    if (userScripts.length === 0) return;

    // Register in chunks so one malformed entry can't poison the whole batch.
    let registered = 0;
    let failedChunks = 0;
    for (let i = 0; i < userScripts.length; i += CHUNK_SIZE) {
      const chunk = userScripts.slice(i, i + CHUNK_SIZE);
      try {
        await chrome.userScripts.register(chunk);
        registered += chunk.length;
      } catch (err) {
        // Fall back to one-by-one within the failing chunk so we keep the good ones.
        let chunkOk = 0;
        for (const script of chunk) {
          try {
            await chrome.userScripts.register([script]);
            chunkOk++;
          } catch (innerErr) {
            if (DEBUG) console.warn(`[Chroma Scriptlets] Skipped ${script.id}:`, innerErr.message);
          }
        }
        registered += chunkOk;
        if (chunkOk < chunk.length) failedChunks++;
      }
    }

    if (DEBUG) {
      console.log(
        `[Chroma Scriptlets] Registered ${registered}/${userScripts.length} scriptlets ` +
        `(dropped ${droppedRules} rules, ${droppedDomains} domains; ${failedChunks} chunks needed retry).`
      );
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
