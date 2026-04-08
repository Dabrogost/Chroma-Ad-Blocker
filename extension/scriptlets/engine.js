/**
 * Chroma Ad-Blocker — Scriptlet Injection Engine
 * Reads subscriptionScriptletRules from storage, injects matching scriptlets
 * into page MAIN world on navigation via chrome.scripting.executeScript.
 *
 * Requires manifest permissions: scripting, webNavigation
 * Timing: chrome.webNavigation.onCommitted + injectImmediately: true
 */

'use strict';

import { SCRIPTLET_MAP } from './lib.js';

const DEBUG = false;

// ─── RULE CACHE ─────
// In-memory cache to avoid storage reads on every navigation.
// Invalidated by storage.onChanged. Re-hydrated from storage on engine init.
let _cachedRules = null;

/**
 * Returns scriptlet rules from cache or storage.
 * @returns {Promise<Object[]>}
 */
async function getRules() {
  if (_cachedRules !== null) return _cachedRules;
  const { subscriptionScriptletRules = [] } = await chrome.storage.local.get('subscriptionScriptletRules');
  _cachedRules = subscriptionScriptletRules;
  return _cachedRules;
}

/**
 * Updates the in-memory rule cache when storage is changed by the subscription manager.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.subscriptionScriptletRules) {
    _cachedRules = changes.subscriptionScriptletRules.newValue || [];
    if (DEBUG) console.log(`[Chroma Scriptlets] Cache invalidated. ${_cachedRules.length} rules loaded.`);
  }
});

// ─── INJECTION ─────
/**
 * Finds scriptlet rules matching a given hostname.
 * A rule with domains: null matches all hostnames.
 * @param {Object[]} rules
 * @param {string} hostname
 * @returns {Object[]}
 */
function matchingRules(rules, hostname) {
  return rules.filter(r =>
    r.domains === null ||
    r.domains.some(d => hostname === d || hostname.endsWith('.' + d))
  );
}

/**
 * Injects a single scriptlet into a tab frame.
 * Fails silently — restricted pages, missing tabs, and CSP blocks are all ignored.
 * @param {number} tabId
 * @param {number} frameId
 * @param {Function} fn
 * @param {string[]} fnArgs
 */
async function inject(tabId, frameId, fn, fnArgs) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      injectImmediately: true,
      func: fn,
      args: [fnArgs]
    });
  } catch (err) {
    if (DEBUG) console.warn(`[Chroma Scriptlets] Injection failed (tab ${tabId}, frame ${frameId}):`, err.message);
  }
}

// ─── NAVIGATION LISTENER ─────
/**
 * On each navigation commit, find and inject matching scriptlets.
 * Fires for both main frame (frameId: 0) and subframes (frameId > 0).
 */
chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId, url }) => {
  // Only handle http/https — skip chrome://, about:, extensions, etc.
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return;

  try {
    const hostname = new URL(url).hostname;
    const rules    = await getRules();
    if (rules.length === 0) return;

    const matched = matchingRules(rules, hostname);
    if (matched.length === 0) return;

    if (DEBUG) console.log(`[Chroma Scriptlets] ${matched.length} scriptlet(s) matched for ${hostname}`);

    for (const rule of matched) {
      const fn = SCRIPTLET_MAP.get(rule.scriptlet);
      if (!fn) {
        if (DEBUG) console.warn(`[Chroma Scriptlets] Unknown scriptlet: ${rule.scriptlet}`);
        continue;
      }
      await inject(tabId, frameId, fn, rule.args || []);
    }
  } catch (err) {
    if (DEBUG) console.warn('[Chroma Scriptlets] Navigation handler error:', err.message);
  }
});

// ─── INIT ─────
/**
 * Pre-warms the rule cache on service worker startup.
 * Prevents the first navigation after a service worker restart from hitting storage.
 * @returns {Promise<void>}
 */
export async function initScriptletEngine() {
  await getRules();
  if (DEBUG) console.log(`[Chroma Scriptlets] Engine initialized. ${_cachedRules.length} rules cached.`);
}
