/**
 * Chroma Ad-Blocker — Scriptlet Injection Engine (userScripts API)
 * Maps subscriptionScriptletRules to chrome.userScripts.
 *
 * Requires manifest permissions: userScripts
 * Timing: document_start
 */

'use strict';

import { SCRIPTLET_MAP } from './lib.js';
import { recordStatsEvent } from '../background/stats.js';

const DEBUG = false;

// FPR is registered via chrome.scripting.registerContentScripts (not via the
// userScripts API used for subscription scriptlets) because the scripting API
// guarantees the same document_start ordering as a static manifest
// content_script — the patches install before any page script can snapshot
// the prototype. userScripts.register is best-effort timing and races inline
// <script> tags in <head>.
const FPR_ID = 'chroma_fpr';
const FPR_FILE = 'scriptlets/fingerprintRandomization.js';

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

// Whitelist entries are bare hostnames (e.g. "example.com"). Mirror the
// domain expansion the engine uses elsewhere so subdomains are also excluded.
function whitelistToExcludeMatches(whitelist) {
  if (!Array.isArray(whitelist) || whitelist.length === 0) return [];
  const out = [];
  for (const raw of whitelist) {
    const d = sanitizeDomain(raw);
    if (!d) continue;
    out.push(`*://${d}/*`);
    out.push(`*://*.${d}/*`);
  }
  return out;
}

const CHUNK_SIZE = 100;

async function _syncUserScriptsImpl() {
  try {
    const {
      subscriptionScriptletRules = [],
      whitelist = []
    } = await chrome.storage.local.get(['subscriptionScriptletRules', 'whitelist']);
    const excludeMatches = whitelistToExcludeMatches(whitelist);

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
      const statsDetail = JSON.stringify({
        scriptlet: rule.scriptlet,
        source: rule.sourceId || 'subscription'
      });
      const code = `
        try {
          (${fn.toString()})(${argsStr});
          document.dispatchEvent(new CustomEvent('__CHROMA_SCRIPTLET_STATS__', { detail: { type: 'hit', ...${statsDetail} } }));
        } catch (err) {
          document.dispatchEvent(new CustomEvent('__CHROMA_SCRIPTLET_STATS__', { detail: { type: 'error', error: err && (err.message || err.name || String(err)), ...${statsDetail} } }));
          throw err;
        }
      `;

      const script = {
        id: `scriptlet_${++scriptCounter}`,
        matches: matches,
        js: [{ code }],
        runAt: rule.runAt || 'document_start',
        world: 'MAIN'
      };
      if (excludeMatches.length > 0) script.excludeMatches = excludeMatches;
      userScripts.push(script);
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

// ─── FPR registration via chrome.scripting ─────
// Serialized like the userScripts sync — config + whitelist changes can fire
// in rapid succession and a register/unregister race throws "id already
// registered" errors.
let _fprInFlight = null;
let _fprPending = false;

function syncFpr() {
  if (_fprInFlight) {
    _fprPending = true;
    return _fprInFlight;
  }
  _fprInFlight = (async () => {
    try {
      await _syncFprImpl();
    } finally {
      _fprInFlight = null;
      if (_fprPending) {
        _fprPending = false;
        syncFpr();
      }
    }
  })();
  return _fprInFlight;
}

async function _syncFprImpl() {
  try {
    const {
      config = {},
      whitelist = [],
      fprWhitelist = []
    } = await chrome.storage.local.get(['config', 'whitelist', 'fprWhitelist']);
    const masterEnabled = config.enabled !== false;
    const fprEnabled = masterEnabled && config.fingerprintRandomization === true;

    let existing = [];
    try {
      existing = await chrome.scripting.getRegisteredContentScripts({ ids: [FPR_ID] });
    } catch (e) {
      // getRegisteredContentScripts throws if the id filter matches nothing
      // in some Chrome versions; treat as not registered.
      existing = [];
    }
    const isRegistered = existing.length > 0;

    if (!fprEnabled) {
      if (isRegistered) {
        try {
          await chrome.scripting.unregisterContentScripts({ ids: [FPR_ID] });
          if (DEBUG) console.log('[Chroma FPR] Unregistered.');
        } catch (e) {
          if (DEBUG) console.warn('[Chroma FPR] Unregister failed:', e);
        }
      }
      return;
    }

    // Union of the global whitelist (also disables ad-blocking) and the
    // FPR-only whitelist (disables only this scriptlet — used for sites
    // whose bot-checks read canvas/audio and break under farbling).
    const merged = Array.from(new Set([...whitelist, ...fprWhitelist]));
    const excludeMatches = whitelistToExcludeMatches(merged);
    const script = {
      id: FPR_ID,
      js: [FPR_FILE],
      matches: ['<all_urls>'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
      persistAcrossSessions: true
    };
    if (excludeMatches.length > 0) script.excludeMatches = excludeMatches;

    try {
      if (isRegistered) {
        await chrome.scripting.updateContentScripts([script]);
        if (DEBUG) console.log('[Chroma FPR] Updated.');
      } else {
        await chrome.scripting.registerContentScripts([script]);
        if (DEBUG) console.log('[Chroma FPR] Registered.');
      }
      if (typeof recordStatsEvent === 'function') {
        recordStatsEvent({ layer: 'fingerprint', type: 'activation' });
      }
    } catch (e) {
      if (DEBUG) console.error('[Chroma FPR] Register/update failed:', e);
    }
  } catch (err) {
    if (DEBUG) console.error('[Chroma FPR] Sync failed:', err);
  }
}

// Re-sync when inputs change.
// - subscriptionScriptletRules → userScripts only
// - config.fingerprintRandomization / config.enabled → FPR only
// - whitelist → both (whitelist drives excludeMatches for FPR and is also
//   used by subscription scriptlet domain expansion in the future)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.subscriptionScriptletRules) {
    if (DEBUG) console.log('[Chroma Scriptlets] Rule change detected, re-syncing userScripts.');
    syncUserScripts();
  }
  if (changes.config) {
    const oldC = changes.config.oldValue || {};
    const newC = changes.config.newValue || {};
    if (oldC.fingerprintRandomization !== newC.fingerprintRandomization ||
        oldC.enabled !== newC.enabled) {
      if (DEBUG) console.log('[Chroma FPR] Config changed, re-syncing.');
      syncFpr();
    }
  }
  if (changes.whitelist) {
    if (DEBUG) console.log('[Chroma Scriptlets] Whitelist changed, re-syncing userScripts.');
    syncUserScripts();
  }
  if (changes.whitelist || changes.fprWhitelist) {
    if (DEBUG) console.log('[Chroma FPR] Whitelist changed, re-syncing.');
    syncFpr();
  }
});

// ─── INIT ─────
/**
 * Synchronize subscription user scripts and FPR content script on
 * service worker startup.
 */
export async function initScriptletEngine() {
  await Promise.all([syncUserScripts(), syncFpr()]);
}
