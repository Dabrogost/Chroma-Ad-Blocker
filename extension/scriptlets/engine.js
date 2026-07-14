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

function isMasterProtectionEnabled(config) {
  return config?.enabled !== false;
}

function isManagedUserScript(script) {
  const id = String(script?.id || '');
  return id.startsWith(SUBSCRIPTION_SCRIPTLET_ID_PREFIX) ||
    id.startsWith(USER_SCRIPTLET_ID_PREFIX);
}

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
// Serialize sync calls and invalidate queued stale snapshots. Storage changes
// often arrive in bursts; only the newest queued desired state should run.
let _userScriptGeneration = 0;
let _userScriptSyncInFlight = null;

export function syncUserScripts() {
  _userScriptGeneration++;
  if (_userScriptSyncInFlight) return _userScriptSyncInFlight;

  _userScriptSyncInFlight = (async () => {
    try {
      let result = false;
      while (true) {
        const generation = _userScriptGeneration;
        result = await _syncUserScriptsImpl(generation);
        if (generation === _userScriptGeneration) return result;
      }
    } finally {
      _userScriptSyncInFlight = null;
    }
  })();
  return _userScriptSyncInFlight;
}

export async function recoverUserScriptsIfNeeded() {
  if (!hasUserScriptsApi()) return false;
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
  const registered = await chrome.userScripts.getScripts();
  const managedRegistered = Array.isArray(registered)
    ? registered.filter(isManagedUserScript)
    : [];

  // Worker recovery must converge an off-state by removing persisted Chroma
  // registrations, never by treating stored rules as a registration request.
  if (!isMasterProtectionEnabled(config)) {
    if (managedRegistered.length === 0) return false;
    await syncUserScripts();
    return true;
  }

  const { userScripts: desired } = buildManagedUserScripts({
    subscriptionRules: Array.isArray(subscriptionScriptletRules) ? subscriptionScriptletRules : [],
    userRules: Array.isArray(userScriptletRules) ? userScriptletRules : [],
    userResources: userScriptletResources && typeof userScriptletResources === 'object'
      ? userScriptletResources
      : {},
    whitelist,
    quietConsole: config.quietConsole === true
  });
  if (managedRegistriesMatch(managedRegistered, desired)) return false;

  await syncUserScripts();
  return true;
}

// Filter-list domains can include forms Chrome match patterns reject:
// negations (~foo.com), TLD wildcards (foo.*), entity names (no dot),
// embedded path/port chars, IPv6, etc. A single bad pattern rejects the
// whole register() batch, so we sanitize aggressively and drop the rule
// if nothing usable remains.
function sanitizeDomain(d) {
  if (typeof d !== 'string' || !d) return null;
  d = d.toLowerCase();
  if (d.startsWith('~')) return null;          // negation — not supported
  if (d.endsWith('.*')) return null;           // TLD wildcard
  if (d.includes('/') || d.includes(':') || d.includes('?') || d.includes('#')) return null;
  if (d.includes(' ')) return null;
  if (!d.includes('.')) return null;           // entity / bare label
  if (d.startsWith('*.')) d = d.slice(2);      // we'll add the wildcard ourselves
  if (
    d.length > 253 ||
    d.startsWith('.') ||
    d.endsWith('.') ||
    !/^[a-z0-9.-]+$/i.test(d)
  ) return null;
  const labels = d.split('.');
  if (labels.some(label => (
    label.length === 0 ||
    label.length > 63 ||
    label.startsWith('-') ||
    label.endsWith('-')
  ))) return null;
  if (/^[0-9.]+$/.test(d) && (
    labels.length !== 4 ||
    labels.some(label => !/^\d{1,3}$/.test(label) || Number(label) > 255)
  )) return null;
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

function domainListToMatches(domains) {
  const matches = [];
  let droppedDomains = 0;
  for (const raw of domains) {
    const domain = sanitizeDomain(raw);
    if (!domain) {
      droppedDomains++;
      continue;
    }
    matches.push(`*://${domain}/*`);
    matches.push(`*://*.${domain}/*`);
  }
  return { matches, droppedDomains };
}

function mergeMatchPatterns(...groups) {
  return [...new Set(groups.flat())];
}

const CHUNK_SIZE = 100;

function normalizeUserScriptletName(name) {
  const cleaned = String(name || '').trim().toLowerCase();
  return cleaned.endsWith('.js') ? cleaned.slice(0, -3) : cleaned;
}

function getRuleMatches(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    return { matches: [], excludeMatches: [], droppedDomains: 1, droppedRule: true };
  }
  let matches = ['<all_urls>'];
  let droppedDomains = 0;
  let droppedRule = false;
  let excludeMatches = [];

  if (rule.domains != null && (!Array.isArray(rule.domains) || rule.domains.length === 0)) {
    return { matches: [], excludeMatches: [], droppedDomains: 1, droppedRule: true };
  }
  if (Array.isArray(rule.domains)) {
    const included = domainListToMatches(rule.domains);
    matches = included.matches;
    droppedDomains += included.droppedDomains;
    if (matches.length === 0) droppedRule = true;
  }

  if (rule.excludedDomains != null &&
      (!Array.isArray(rule.excludedDomains) || rule.excludedDomains.length === 0)) {
    return { matches: [], excludeMatches: [], droppedDomains: droppedDomains + 1, droppedRule: true };
  }
  if (Array.isArray(rule.excludedDomains)) {
    const excluded = domainListToMatches(rule.excludedDomains);
    excludeMatches = excluded.matches;
    droppedDomains += excluded.droppedDomains;
    // Ignoring a malformed exclusion would broaden the rule. Fail closed even
    // for legacy/corrupted cached rules that bypassed the current parser.
    if (excluded.droppedDomains > 0) droppedRule = true;
  }

  return { matches, excludeMatches, droppedDomains, droppedRule };
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
            // Public alias for dynamically inserted resource code; static
            // analysis cannot see references inside the inserted payload.
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

function buildManagedUserScripts({
  subscriptionRules,
  userRules,
  userResources,
  whitelist,
  quietConsole
}) {
  const excludeMatches = whitelistToExcludeMatches(whitelist);
  const userScripts = [];
  let scriptCounter = 0;
  let userScriptCounter = 0;
  let droppedDomains = 0;
  let droppedRules = 0;

  for (const rule of subscriptionRules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      droppedRules++;
      continue;
    }
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
    const combinedExclusions = mergeMatchPatterns(excludeMatches, matchResult.excludeMatches);
    if (combinedExclusions.length > 0) script.excludeMatches = combinedExclusions;
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
    const combinedExclusions = mergeMatchPatterns(excludeMatches, matchResult.excludeMatches);
    if (combinedExclusions.length > 0) script.excludeMatches = combinedExclusions;
    userScripts.push(script);
  }

  return { userScripts, droppedDomains, droppedRules };
}

function comparableUserScript(script) {
  const sortedStrings = value => Array.isArray(value)
    ? value.map(String).sort()
    : [];
  return {
    id: String(script?.id || ''),
    matches: sortedStrings(script?.matches),
    excludeMatches: sortedStrings(script?.excludeMatches),
    js: Array.isArray(script?.js)
      ? script.js.map(source => ({
        code: typeof source?.code === 'string' ? source.code : '',
        file: typeof source?.file === 'string' ? source.file : ''
      }))
      : [],
    runAt: String(script?.runAt || ''),
    world: String(script?.world || ''),
    allFrames: script?.allFrames === true
  };
}

function managedRegistriesMatch(actual, desired) {
  if (actual.length !== desired.length) return false;
  const desiredById = new Map(desired.map(script => [script.id, comparableUserScript(script)]));
  if (desiredById.size !== desired.length) return false;
  return actual.every(script => {
    const expected = desiredById.get(script.id);
    return expected && JSON.stringify(comparableUserScript(script)) === JSON.stringify(expected);
  });
}

async function _syncUserScriptsImpl(generation) {
  try {
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
    const masterEnabled = isMasterProtectionEnabled(config);
    const subscriptionRules = Array.isArray(subscriptionScriptletRules) ? subscriptionScriptletRules : [];
    const userRules = Array.isArray(userScriptletRules) ? userScriptletRules : [];
    const storedRuleCount = subscriptionRules.length + userRules.length;

    if (!hasUserScriptsApi()) {
      if (masterEnabled && storedRuleCount > 0) {
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
      return masterEnabled && storedRuleCount > 0
        ? { ok: false, error: 'UserScripts API unavailable' }
        : { ok: true, registered: 0 };
    }

    const quietConsole = config.quietConsole === true;

    // Clear only registrations owned by this engine. When master protection is
    // off this is the terminal action; stored rules remain cached for restore.
    const existing = await chrome.userScripts.getScripts();
    const managedExisting = Array.isArray(existing) ? existing.filter(isManagedUserScript) : [];
    if (generation !== _userScriptGeneration) return { ok: false, stale: true };
    if (managedExisting.length > 0) {
      await chrome.userScripts.unregister({ ids: managedExisting.map(script => script.id) });
    }

    if (!masterEnabled) {
      if (typeof clearHealthDiagnostic === 'function') {
        await clearHealthDiagnostic('scriptletRegistration');
      }
      return { ok: true, registered: 0 };
    }

    const userResources = userScriptletResources && typeof userScriptletResources === 'object'
      ? userScriptletResources
      : {};

    if (subscriptionRules.length === 0 && userRules.length === 0) {
      if (typeof clearHealthDiagnostic === 'function') {
        await clearHealthDiagnostic('scriptletRegistration');
      }
      return { ok: true, registered: 0 };
    }

    const { userScripts, droppedDomains, droppedRules } = buildManagedUserScripts({
      subscriptionRules,
      userRules,
      userResources,
      whitelist,
      quietConsole
    });

    if (userScripts.length === 0) return { ok: true, registered: 0 };

    // Re-read master state immediately before registration. A storage change
    // can arrive while the registry is being inspected or scripts are built.
    const { config: latestConfig = {} } = await chrome.storage.local.get('config');
    if (generation !== _userScriptGeneration || !isMasterProtectionEnabled(latestConfig)) {
      return { ok: false, stale: true };
    }

    // Register in chunks so one malformed entry can't poison the whole batch.
    let registered = 0;
    let failedChunks = 0;
    for (let i = 0; i < userScripts.length; i += CHUNK_SIZE) {
      if (generation !== _userScriptGeneration) return { ok: false, stale: true };
      const chunk = userScripts.slice(i, i + CHUNK_SIZE);
      try {
        await chrome.userScripts.register(chunk);
        registered += chunk.length;
      } catch (err) {
        // Fall back to one-by-one within the failing chunk so we keep the good ones.
        let chunkOk = 0;
        for (const script of chunk) {
          if (generation !== _userScriptGeneration) return { ok: false, stale: true };
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
    return registered === userScripts.length
      ? { ok: true, registered }
      : {
          ok: false,
          registered,
          expected: userScripts.length,
          error: `${userScripts.length - registered} userScript registration(s) failed`
        };
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
    return { ok: false, error: err?.message || 'UserScripts synchronization failed' };
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
// - subscription/user-resource rules and config.enabled → userScripts
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
    const masterChanged = oldC.enabled !== newC.enabled;
    const quietConsoleChanged = oldC.quietConsole !== newC.quietConsole;
    const fingerprintRandomizationChanged =
      oldC.fingerprintRandomization !== newC.fingerprintRandomization;

    if (fingerprintRandomizationChanged || quietConsoleChanged || masterChanged) {
      if (DEBUG) console.log('[Chroma FPR] Config changed, re-syncing.');
      syncFpr();
    }
    if (quietConsoleChanged || masterChanged) {
      if (DEBUG) console.log('[Chroma Scriptlets] Master/Quiet Console state changed, re-syncing userScripts.');
      syncUserScripts();
      if (DEBUG) console.log('[Chroma Quiet Console] Config changed, re-syncing.');
      syncQuietConsole();
    }
  }

  if (changes.whitelist) {
    if (DEBUG) console.log('[Chroma Scriptlets] Whitelist changed, re-syncing userScripts.');
    syncUserScripts();
    if (DEBUG) console.log('[Chroma Quiet Console] Whitelist changed, re-syncing.');
    syncQuietConsole();
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
  await Promise.all([syncUserScripts(), syncFpr(), syncQuietConsole()]);
}
