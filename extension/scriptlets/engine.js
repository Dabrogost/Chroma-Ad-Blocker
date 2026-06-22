/**
 * Chroma Ad-Blocker — Scriptlet Injection Engine (userScripts API)
 * Maps bundled subscription scriptlet rules and explicit user resources to
 * chrome.userScripts.
 *
 * Requires manifest permissions: userScripts
 * Timing: document_start
 */

'use strict';

import { SCRIPTLET_MAP } from './lib.js';
import { recordStatsEvent } from '../background/stats.js';
import { clearHealthDiagnostic, recordHealthDiagnostic } from '../background/diagnostics.js';

const DEBUG = false;

// FPR is registered via chrome.scripting.registerContentScripts (not via the
// userScripts API used for subscription scriptlets) because the scripting API
// guarantees the same document_start ordering as a static manifest
// content_script — the patches install before any page script can snapshot
// the prototype. userScripts.register is best-effort timing and races inline
// <script> tags in <head>.
const FPR_ID = 'chroma_fpr';
const FPR_QUIET_FILE = 'scriptlets/fingerprintConsoleQuiet.js';
const FPR_FILE = 'scriptlets/fingerprintRandomization.js';
const QUIET_CONSOLE_ID = 'chroma_quiet_console';
const QUIET_CONSOLE_FILE = 'content/quiet_console.js';
const USER_SCRIPTLET_RULES_KEY = 'userScriptletRules';
const USER_SCRIPTLET_RESOURCES_KEY = 'userScriptletResources';
const SUBSCRIPTION_SCRIPTLET_ID_PREFIX = 'scriptlet_';
const USER_SCRIPTLET_ID_PREFIX = 'user_scriptlet_';

function hasUserScriptsApi() {
  return !!(
    chrome.userScripts &&
    typeof chrome.userScripts.getScripts === 'function' &&
    typeof chrome.userScripts.register === 'function' &&
    typeof chrome.userScripts.unregister === 'function'
  );
}

/**
 * Synchronizes the chrome.userScripts registry with the current rules in storage.
 */
// Serialize sync calls. storage.onChanged can fire multiple times in rapid
// succession (once per subscription refresh); concurrent syncs race on the
// unregister/register pair and collide on script IDs.
let _syncInFlight = null;
let _syncPending = false;

export function syncUserScripts() {
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

export async function recoverUserScriptsIfNeeded() {
  if (!hasUserScriptsApi()) return false;
  const {
    subscriptionScriptletRules = [],
    userScriptletRules = []
  } = await chrome.storage.local.get(['subscriptionScriptletRules', USER_SCRIPTLET_RULES_KEY]);
  const storedRuleCount =
    (Array.isArray(subscriptionScriptletRules) ? subscriptionScriptletRules.length : 0) +
    (Array.isArray(userScriptletRules) ? userScriptletRules.length : 0);
  if (storedRuleCount === 0) return false;

  const registered = await chrome.userScripts.getScripts();
  if (Array.isArray(registered) && registered.length > 0) return false;

  await syncUserScripts();
  return true;
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

function normalizeUserScriptletName(name) {
  const cleaned = String(name || '').trim().toLowerCase();
  return cleaned.endsWith('.js') ? cleaned.slice(0, -3) : cleaned;
}

function getRuleMatches(rule) {
  let matches = ['<all_urls>'];
  let droppedDomains = 0;
  let droppedRule = false;

  if (rule.domains && rule.domains.length > 0) {
    matches = [];
    for (const raw of rule.domains) {
      const d = sanitizeDomain(raw);
      if (!d) {
        droppedDomains++;
        continue;
      }
      matches.push(`*://${d}/*`);
      matches.push(`*://*.${d}/*`);
    }
    if (matches.length === 0) droppedRule = true;
  }

  return { matches, droppedDomains, droppedRule };
}

function normalizeRunAt(value) {
  return ['document_start', 'document_end', 'document_idle'].includes(value)
    ? value
    : 'document_start';
}

function escapeTemplateArg(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
}

function applyUserScriptletArgs(code, args) {
  const safeArgs = Array.isArray(args) ? args : [];
  return String(code || '')
    .replace(/\{\{args\}\}/g, JSON.stringify(safeArgs))
    .replace(/\{\{(\d+)\}\}/g, (_, index) => escapeTemplateArg(safeArgs[Number(index) - 1]));
}

function buildSubscriptionScriptletCode(fn, args, quietConsole = false) {
  const argsStr = JSON.stringify(Array.isArray(args) ? args : []);
  const shouldThrow = quietConsole ? 'false' : 'true';
  return `
        try {
          (${fn.toString()})(${argsStr});
          document.dispatchEvent(new CustomEvent('__CHROMA_SCRIPTLET_STATS__', { detail: { type: 'hit' } }));
        } catch (err) {
          document.dispatchEvent(new CustomEvent('__CHROMA_SCRIPTLET_STATS__', { detail: { type: 'error' } }));
          if (${shouldThrow}) throw err;
        }
      `;
}

function buildUserResourceCode(resource, args, quietConsole = false) {
  const argsStr = JSON.stringify(Array.isArray(args) ? args : []);
  const shouldThrow = quietConsole ? 'false' : 'true';
  const code = applyUserScriptletArgs(resource?.code || '', args);
  return `
        try {
          (function() {
            const scriptletArgs = ${argsStr};
            const chromaScriptletArgs = scriptletArgs;
            ${code}
          })();
          document.dispatchEvent(new CustomEvent('__CHROMA_SCRIPTLET_STATS__', { detail: { type: 'hit' } }));
        } catch (err) {
          document.dispatchEvent(new CustomEvent('__CHROMA_SCRIPTLET_STATS__', { detail: { type: 'error' } }));
          if (${shouldThrow}) throw err;
        }
      `;
}

async function _syncUserScriptsImpl() {
  try {
    if (!hasUserScriptsApi()) {
      const {
        subscriptionScriptletRules = [],
        userScriptletRules = []
      } = await chrome.storage.local.get(['subscriptionScriptletRules', USER_SCRIPTLET_RULES_KEY]);
      const storedRuleCount =
        (Array.isArray(subscriptionScriptletRules) ? subscriptionScriptletRules.length : 0) +
        (Array.isArray(userScriptletRules) ? userScriptletRules.length : 0);
      if (storedRuleCount > 0) {
        if (typeof recordHealthDiagnostic === 'function') {
          await recordHealthDiagnostic('scriptletRegistration', {
            area: 'scriptlets',
            severity: 'warning',
            message: 'Scriptlets could not be registered because the UserScripts API is unavailable.',
            action: 'Open Chrome extension details and enable Allow User Scripts.',
            error: 'UserScripts API unavailable'
          });
        }
      } else if (typeof clearHealthDiagnostic === 'function') {
        await clearHealthDiagnostic('scriptletRegistration');
      }
      if (DEBUG) {
        console.warn('[Chroma Scriptlets] userScripts API unavailable. Enable Allow User Scripts in Chrome extension details.');
      }
      return;
    }

    const {
      subscriptionScriptletRules = [],
      userScriptletRules = [],
      userScriptletResources = {},
      whitelist = [],
      config = {}
    } = await chrome.storage.local.get([
      'subscriptionScriptletRules',
      USER_SCRIPTLET_RULES_KEY,
      USER_SCRIPTLET_RESOURCES_KEY,
      'whitelist',
      'config'
    ]);
    const quietConsole = config.quietConsole === true;
    const excludeMatches = whitelistToExcludeMatches(whitelist);

    // Clear existing registered scripts
    const existing = await chrome.userScripts.getScripts();
    if (existing.length > 0) {
      await chrome.userScripts.unregister({ ids: existing.map(s => s.id) });
    }

    const subscriptionRules = Array.isArray(subscriptionScriptletRules) ? subscriptionScriptletRules : [];
    const userRules = Array.isArray(userScriptletRules) ? userScriptletRules : [];
    const userResources = userScriptletResources && typeof userScriptletResources === 'object'
      ? userScriptletResources
      : {};

    if (subscriptionRules.length === 0 && userRules.length === 0) {
      if (typeof clearHealthDiagnostic === 'function') {
        await clearHealthDiagnostic('scriptletRegistration');
      }
      return;
    }

    const userScripts = [];
    let scriptCounter = 0;
    let userScriptCounter = 0;
    let droppedDomains = 0;
    let droppedRules = 0;

    for (const rule of subscriptionRules) {
      const fn = SCRIPTLET_MAP.get(rule.scriptlet);
      if (!fn) {
        if (DEBUG) console.warn(`[Chroma Scriptlets] Unknown scriptlet: ${rule.scriptlet}`);
        continue;
      }

      const matchResult = getRuleMatches(rule);
      droppedDomains += matchResult.droppedDomains;
      if (matchResult.droppedRule) {
        droppedRules++;
        continue;
      }

      const script = {
        id: `${SUBSCRIPTION_SCRIPTLET_ID_PREFIX}${++scriptCounter}`,
        matches: matchResult.matches,
        js: [{ code: buildSubscriptionScriptletCode(fn, rule.args, quietConsole) }],
        runAt: normalizeRunAt(rule.runAt),
        world: 'MAIN'
      };
      if (excludeMatches.length > 0) script.excludeMatches = excludeMatches;
      userScripts.push(script);
    }

    for (const rule of userRules) {
      const resource = userResources[normalizeUserScriptletName(rule?.scriptlet)];
      if (!resource?.code) {
        if (DEBUG) console.warn(`[Chroma Scriptlets] Missing user resource: ${rule?.scriptlet}`);
        continue;
      }

      const matchResult = getRuleMatches(rule);
      droppedDomains += matchResult.droppedDomains;
      if (matchResult.droppedRule) {
        droppedRules++;
        continue;
      }

      const script = {
        id: `${USER_SCRIPTLET_ID_PREFIX}${++userScriptCounter}`,
        matches: matchResult.matches,
        js: [{ code: buildUserResourceCode(resource, rule.args, quietConsole) }],
        runAt: normalizeRunAt(rule.runAt),
        world: 'MAIN',
        allFrames: true
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

    if (registered < userScripts.length) {
      if (typeof recordHealthDiagnostic === 'function') {
        await recordHealthDiagnostic('scriptletRegistration', {
          area: 'scriptlets',
          severity: 'warning',
          message: `Registered ${registered}/${userScripts.length} scriptlets.`,
          action: 'Open Chrome extension details and confirm Allow User Scripts is enabled.',
          error: `${userScripts.length - registered} scriptlet registration(s) failed`
        });
      }
    } else if (typeof clearHealthDiagnostic === 'function') {
      await clearHealthDiagnostic('scriptletRegistration');
    }

    if (DEBUG) {
      console.log(
        `[Chroma Scriptlets] Registered ${registered}/${userScripts.length} scriptlets ` +
        `(dropped ${droppedRules} rules, ${droppedDomains} domains; ${failedChunks} chunks needed retry).`
      );
    }
  } catch (err) {
    if (typeof recordHealthDiagnostic === 'function') {
      await recordHealthDiagnostic('scriptletRegistration', {
        area: 'scriptlets',
        severity: 'warning',
        message: 'Scriptlets could not be synchronized.',
        action: 'Open Chrome extension details and confirm Allow User Scripts is enabled.',
        error: err?.message || err
      });
    }
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
      if (typeof clearHealthDiagnostic === 'function') {
        await clearHealthDiagnostic('fingerprintSync');
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
      js: config.quietConsole === true ? [FPR_QUIET_FILE, FPR_FILE] : [FPR_FILE],
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
      if (typeof clearHealthDiagnostic === 'function') {
        await clearHealthDiagnostic('fingerprintSync');
      }
    } catch (e) {
      if (typeof recordHealthDiagnostic === 'function') {
        await recordHealthDiagnostic('fingerprintSync', {
          area: 'fingerprint',
          severity: 'warning',
          message: 'Fingerprint Randomization script could not be registered.',
          action: 'Turn Fingerprint Randomization off and on, or reload the extension.',
          error: e?.message || e
        });
      }
      if (DEBUG) console.error('[Chroma FPR] Register/update failed:', e);
    }
  } catch (err) {
    if (typeof recordHealthDiagnostic === 'function') {
      await recordHealthDiagnostic('fingerprintSync', {
        area: 'fingerprint',
        severity: 'warning',
        message: 'Fingerprint Randomization sync could not complete.',
        action: 'Turn Fingerprint Randomization off and on, or reload the extension.',
        error: err?.message || err
      });
    }
    if (DEBUG) console.error('[Chroma FPR] Sync failed:', err);
  }
}

let _quietConsoleInFlight = null;
let _quietConsolePending = false;

function syncQuietConsole() {
  if (_quietConsoleInFlight) {
    _quietConsolePending = true;
    return _quietConsoleInFlight;
  }
  _quietConsoleInFlight = (async () => {
    try {
      await _syncQuietConsoleImpl();
    } finally {
      _quietConsoleInFlight = null;
      if (_quietConsolePending) {
        _quietConsolePending = false;
        syncQuietConsole();
      }
    }
  })();
  return _quietConsoleInFlight;
}

async function _syncQuietConsoleImpl() {
  try {
    if (
      !chrome.scripting ||
      typeof chrome.scripting.getRegisteredContentScripts !== 'function' ||
      typeof chrome.scripting.registerContentScripts !== 'function' ||
      typeof chrome.scripting.unregisterContentScripts !== 'function'
    ) {
      return;
    }

    const { config = {}, whitelist = [] } = await chrome.storage.local.get(['config', 'whitelist']);
    const masterEnabled = config.enabled !== false;
    const quietEnabled = masterEnabled && config.quietConsole === true;

    let existing = [];
    try {
      existing = await chrome.scripting.getRegisteredContentScripts({ ids: [QUIET_CONSOLE_ID] });
    } catch (_) {
      existing = [];
    }
    const isRegistered = existing.length > 0;

    if (!quietEnabled) {
      if (isRegistered) {
        await chrome.scripting.unregisterContentScripts({ ids: [QUIET_CONSOLE_ID] });
        if (DEBUG) console.log('[Chroma Quiet Console] Unregistered.');
      }
      if (typeof clearHealthDiagnostic === 'function') {
        await clearHealthDiagnostic('quietConsoleSync');
      }
      return;
    }

    const script = {
      id: QUIET_CONSOLE_ID,
      js: [QUIET_CONSOLE_FILE],
      matches: ['<all_urls>'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
      persistAcrossSessions: true
    };
    const excludeMatches = whitelistToExcludeMatches(whitelist);
    if (excludeMatches.length > 0) script.excludeMatches = excludeMatches;

    if (isRegistered && typeof chrome.scripting.updateContentScripts === 'function') {
      await chrome.scripting.updateContentScripts([script]);
      if (DEBUG) console.log('[Chroma Quiet Console] Updated.');
    } else if (isRegistered) {
      await chrome.scripting.unregisterContentScripts({ ids: [QUIET_CONSOLE_ID] });
      await chrome.scripting.registerContentScripts([script]);
      if (DEBUG) console.log('[Chroma Quiet Console] Re-registered.');
    } else {
      await chrome.scripting.registerContentScripts([script]);
      if (DEBUG) console.log('[Chroma Quiet Console] Registered.');
    }
    if (typeof clearHealthDiagnostic === 'function') {
      await clearHealthDiagnostic('quietConsoleSync');
    }
  } catch (err) {
    if (typeof recordHealthDiagnostic === 'function') {
      await recordHealthDiagnostic('quietConsoleSync', {
        area: 'scriptlets',
        severity: 'warning',
        message: 'Quiet Console could not be registered.',
        action: 'Turn Quiet Console off and on, or reload the extension.',
        error: err?.message || err
      });
    }
    if (DEBUG) console.error('[Chroma Quiet Console] Sync failed:', err);
  }
}

// Re-sync when inputs change.
// - subscriptionScriptletRules → userScripts only
// - config.fingerprintRandomization / config.enabled → FPR
// - config.quietConsole / config.enabled → Quiet Console
// - whitelist → userScripts, FPR, and Quiet Console excludeMatches
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.subscriptionScriptletRules || changes.userScriptletRules || changes.userScriptletResources) {
    if (DEBUG) console.log('[Chroma Scriptlets] Rule change detected, re-syncing userScripts.');
    syncUserScripts();
  }
  if (changes.config) {
    const oldC = changes.config.oldValue || {};
    const newC = changes.config.newValue || {};
    if (oldC.fingerprintRandomization !== newC.fingerprintRandomization ||
        oldC.quietConsole !== newC.quietConsole ||
        oldC.enabled !== newC.enabled) {
      if (DEBUG) console.log('[Chroma FPR] Config changed, re-syncing.');
      syncFpr();
    }
    if (oldC.quietConsole !== newC.quietConsole) {
      syncUserScripts();
    }
    if (oldC.quietConsole !== newC.quietConsole ||
        oldC.enabled !== newC.enabled) {
      if (DEBUG) console.log('[Chroma Quiet Console] Config changed, re-syncing.');
      syncQuietConsole();
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
  if (changes.whitelist) {
    if (DEBUG) console.log('[Chroma Quiet Console] Whitelist changed, re-syncing.');
    syncQuietConsole();
  }
});

// ─── INIT ─────
/**
 * Synchronize subscription user scripts and FPR content script on
 * service worker startup.
 */
export async function initScriptletEngine() {
  await Promise.all([syncUserScripts(), syncFpr(), syncQuietConsole()]);
}
