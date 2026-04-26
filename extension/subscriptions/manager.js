/**
 * Chroma Ad-Blocker — Subscription Lifecycle Manager
 * Orchestrates fetch → parse → allocate → apply for all subscriptions.
 * Uses chrome.alarms for persistence across service worker restarts.
 *
 * Storage keys owned by this module:
 *   subscriptions            — metadata array (url, enabled, lastUpdated, ruleCount, etc.)
 *   sub_network_rules        — { [id]: Object[] } parsed network rules per subscription
 *   sub_cosmetic_rules       — { [id]: Object[] } parsed cosmetic rules per subscription
 *   sub_scriptlet_rules      — { [id]: Object[] } parsed scriptlet rules per subscription
 *   subscriptionCosmeticRules  — Object[] flat combined array consumed by content.js
 *   subscriptionScriptletRules — Object[] flat combined array consumed by scriptlets/engine.js
 */

'use strict';

import { DEFAULT_SUBSCRIPTIONS } from './lists.js';
import { parseList }             from './parser.js';
import { allocate }              from './budget.js';
import { applySubscriptionRules, clearSubscriptionRules } from './dnr.js';
import { SCRIPTLET_MAP } from '../scriptlets/lib.js';

const DEBUG = false;
const ALARM_NAME     = 'chroma-subscription-check';
const FETCH_TIMEOUT  = 30000; // 30s per-fetch timeout

// ─── FETCH ─────
/**
 * Fetches raw filter list text with a hard timeout.
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchList(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ─── COSMETIC DEDUPLICATION ─────
/**
 * Deduplicates cosmetic rules across subscriptions before storage.
 * @param {Object[]} rules
 * @returns {Object[]}
 */
function deduplicateCosmeticRules(rules) {
  const seen = new Set();
  return rules.filter(rule => {
    const key = `${rule.isException}|${rule.domains ? rule.domains.slice().sort().join(',') : ''}|${rule.selector}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── STATIC RULE DEDUPLICATION ─────
/**
 * Builds a Set of urlFilter strings from all bundled static rule files.
 * Used to exclude subscription rules that are already covered statically.
 * Called once per refreshSubscription invocation — cost is paid at fetch time.
 * @returns {Promise<Set<string>>}
 */
async function buildStaticUrlFilterSet() {
  const files = [
    'rules/rules.json',
    'rules/rules_1.json',
    'rules/rules_2.json',
    'rules/rules_3.json',
    'rules/rules_4.json',
    'rules/rules_5.json',
    'rules/rules_6.json',
    'rules/rules_7.json',
    'rules/rules_8.json',
    'rules/rules_9.json'
  ];

  const set = new Set();
  await Promise.all(files.map(async (file) => {
    try {
      const res = await fetch(chrome.runtime.getURL(file));
      if (!res.ok) return;
      const rules = await res.json();
      for (const rule of rules) {
        if (rule.condition && rule.condition.urlFilter) {
          set.add(rule.condition.urlFilter);
        }
      }
    } catch {
      // Individual file failure is non-fatal — deduplication is best-effort
    }
  }));

  return set;
}

// ─── REBUILD HELPERS ─────
/**
 * Reads per-subscription stored network rules, combines enabled subs,
 * runs budget allocator, and applies to DNR.
 * @param {Object[]} subscriptions
 * @returns {Promise<void>}
 */
async function rebuildNetworkRules(subscriptions) {
  const { sub_network_rules: perSubRules = {} } = await chrome.storage.local.get('sub_network_rules');

  const allRules = [];
  for (const sub of subscriptions) {
    if (sub.cosmeticOnly) continue;
    if (sub.enabled && perSubRules[sub.id]) {
      for (const rule of perSubRules[sub.id]) {
        if (rule.action && rule.action.type === 'block') allRules.push(rule);
      }
    }
  }

  const { allocated, trimCount } = allocate(allRules);
  if (DEBUG && trimCount > 0) {
    console.warn(`[Chroma Subscriptions] Budget trim: dropped ${trimCount} rules.`);
  }

  await applySubscriptionRules(allocated);
  await chrome.storage.local.set({ appliedNetworkRuleCount: allocated.length });
}

/**
 * Combines enabled subscription cosmetic rules and writes flat array to storage.
 * content.js reads subscriptionCosmeticRules on init.
 * @param {Object[]} subscriptions
 * @returns {Promise<void>}
 */
async function rebuildCosmeticRules(subscriptions) {
  const { sub_cosmetic_rules: perSubRules = {} } = await chrome.storage.local.get('sub_cosmetic_rules');

  const allRules = [];
  for (const sub of subscriptions) {
    if (sub.enabled && perSubRules[sub.id]) {
      for (const rule of perSubRules[sub.id]) allRules.push(rule);
    }
  }

  const deduped = deduplicateCosmeticRules(allRules);
  await chrome.storage.local.set({ subscriptionCosmeticRules: deduped });
}

/**
 * Combines enabled subscription scriptlet rules and writes flat array to storage.
 * scriptlets/engine.js reads subscriptionScriptletRules.
 * @param {Object[]} subscriptions
 * @returns {Promise<void>}
 */
async function rebuildScriptletRules(subscriptions) {
  const { sub_scriptlet_rules: perSubRules = {} } = await chrome.storage.local.get('sub_scriptlet_rules');

  const allRules = [];
  for (const sub of subscriptions) {
    if (sub.enabled && perSubRules[sub.id]) {
      for (const rule of perSubRules[sub.id]) allRules.push(rule);
    }
  }

  await chrome.storage.local.set({ subscriptionScriptletRules: allRules });
}

// ─── PUBLIC API ─────
/**
 * Called from onInstalled. Writes default subscriptions if none exist.
 * Registers the update alarm.
 * @returns {Promise<void>}
 */
export async function initSubscriptions() {
  const { subscriptions } = await chrome.storage.local.get('subscriptions');
  if (!subscriptions) {
    await chrome.storage.local.set({ subscriptions: DEFAULT_SUBSCRIPTIONS });
  }
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 60 });
  if (DEBUG) console.log('[Chroma Subscriptions] Initialized.');
}

/**
 * Called from onStartup. Re-registers alarm if service worker restarted without it.
 * @returns {Promise<void>}
 */
export async function ensureAlarm() {
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 60 });
  }
}

/**
 * Called from chrome.alarms.onAlarm. Refreshes subscriptions whose interval has elapsed.
 * @returns {Promise<void>}
 */
export async function refreshAllStale() {
  const { subscriptions = [] } = await chrome.storage.local.get('subscriptions');
  const now = Date.now();

  for (const sub of subscriptions) {
    if (!sub.enabled) continue;
    const ageMs = now - (sub.lastUpdated || 0);
    const intervalMs = (sub.intervalHours || 24) * 60 * 60 * 1000;
    if (ageMs >= intervalMs) {
      await refreshSubscription(sub.id);
    }
  }
}

/**
 * Fetches, parses, stores, and applies rules for a single subscription.
 * @param {string} id
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function refreshSubscription(id) {
  const { subscriptions = [] } = await chrome.storage.local.get('subscriptions');
  const sub = subscriptions.find(s => s.id === id);
  if (!sub) return { ok: false, error: 'Subscription not found' };
  if (!sub.enabled) return { ok: false, error: 'Subscription disabled' };

  try {
    if (DEBUG) console.log(`[Chroma Subscriptions] Fetching: ${sub.name}`);
    const text = await fetchList(sub.url);
    const { networkRules: parsedNetworkRules, cosmeticRules, scriptletRules, skipped } = parseList(text);
    const staticFilters = await buildStaticUrlFilterSet();
    const networkRules = parsedNetworkRules
      .filter(r => !r.condition.urlFilter || !staticFilters.has(r.condition.urlFilter))
      .map((rule, index) => ({ ...rule, _listPosition: index }));

    // Store parsed rules per subscription ID
    const [netStore, cosStore, scrStore] = await Promise.all([
      chrome.storage.local.get('sub_network_rules'),
      chrome.storage.local.get('sub_cosmetic_rules'),
      chrome.storage.local.get('sub_scriptlet_rules')
    ]);

    const netPerSub = netStore.sub_network_rules || {};
    const cosPerSub = cosStore.sub_cosmetic_rules || {};
    const scrPerSub = scrStore.sub_scriptlet_rules || {};

    netPerSub[id] = sub.cosmeticOnly ? [] : networkRules;
    cosPerSub[id] = cosmeticRules;
    // Only keep scriptlet rules whose name matches an implementation we ship.
    // Anything else would be silently dropped at engine registration anyway,
    // so we drop it here to avoid storing thousands of dead rules.
    const usableScriptlets = scriptletRules.filter(r => SCRIPTLET_MAP.has(r.scriptlet));
    scrPerSub[id] = usableScriptlets;

    await chrome.storage.local.set({
      sub_network_rules:  netPerSub,
      sub_cosmetic_rules: cosPerSub,
      sub_scriptlet_rules: scrPerSub
    });

    // Update subscription metadata
    sub.ruleCount   = { network: sub.cosmeticOnly ? 0 : networkRules.length, cosmetic: cosmeticRules.length, scriptlet: usableScriptlets.length };
    sub.lastUpdated = Date.now();
    sub.version     = String(Date.now());
    sub.lastError   = null;
    await chrome.storage.local.set({ subscriptions });

    // Rebuild combined rule sets and apply
    await rebuildNetworkRules(subscriptions);
    await rebuildCosmeticRules(subscriptions);
    await rebuildScriptletRules(subscriptions);

    if (DEBUG) {
      console.log(`[Chroma Subscriptions] ${sub.name} — Network: ${networkRules.length}, Cosmetic: ${cosmeticRules.length}, Scriptlet: ${scriptletRules.length}, Skipped:`, skipped);
    }

    return { ok: true };
  } catch (err) {
    // Record error without clobbering other subscription metadata
    const { subscriptions: subs = [] } = await chrome.storage.local.get('subscriptions');
    const s = subs.find(x => x.id === id);
    if (s) {
      s.lastError = err.message;
      await chrome.storage.local.set({ subscriptions: subs });
    }
    if (DEBUG) console.error(`[Chroma Subscriptions] Refresh failed for ${id}:`, err);
    return { ok: false, error: err.message };
  }
}

/**
 * Returns current subscription metadata array.
 * @returns {Promise<Object[]>}
 */
export async function getSubscriptions() {
  const { subscriptions = [] } = await chrome.storage.local.get('subscriptions');
  return subscriptions;
}

/**
 * Enables or disables a subscription. Rebuilds combined rule sets after change.
 * @param {string} id
 * @param {boolean} enabled
 * @returns {Promise<{ ok: boolean }>}
 */
export async function setSubscriptionEnabled(id, enabled) {
  const { subscriptions = [] } = await chrome.storage.local.get('subscriptions');
  const sub = subscriptions.find(s => s.id === id);
  if (!sub) return { ok: false };

  sub.enabled = enabled;
  await chrome.storage.local.set({ subscriptions });

  await rebuildNetworkRules(subscriptions);
  await rebuildCosmeticRules(subscriptions);
  await rebuildScriptletRules(subscriptions);

  // If disabling all subscriptions, clear DNR subscription rules entirely
  const anyEnabled = subscriptions.some(s => s.enabled);
  if (!anyEnabled) await clearSubscriptionRules();

  return { ok: true };
}

/**
 * Adds a new subscription. Does not immediately fetch — requires manual refresh.
 * @param {{ id: string, name: string, url: string, intervalHours?: number }} sub
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function addSubscription(sub) {
  const { subscriptions = [] } = await chrome.storage.local.get('subscriptions');
  if (subscriptions.find(s => s.id === sub.id)) return { ok: false, error: 'ID already exists' };

  subscriptions.push({
    id: sub.id,
    name: sub.name,
    url: sub.url,
    enabled: true,
    intervalHours: sub.intervalHours || 24,
    lastUpdated: 0,
    version: null,
    lastError: null,
    ruleCount: { network: 0, cosmetic: 0, scriptlet: 0 }
  });

  await chrome.storage.local.set({ subscriptions });
  return { ok: true };
}

/**
 * Removes a subscription and its stored rules. Rebuilds combined sets.
 * @param {string} id
 * @returns {Promise<{ ok: boolean }>}
 */
export async function removeSubscription(id) {
  const { subscriptions = [] } = await chrome.storage.local.get('subscriptions');
  const filtered = subscriptions.filter(s => s.id !== id);
  if (filtered.length === subscriptions.length) return { ok: false };

  // Remove per-subscription stored rules
  const [netStore, cosStore, scrStore] = await Promise.all([
    chrome.storage.local.get('sub_network_rules'),
    chrome.storage.local.get('sub_cosmetic_rules'),
    chrome.storage.local.get('sub_scriptlet_rules')
  ]);

  const netPerSub = netStore.sub_network_rules || {};
  const cosPerSub = cosStore.sub_cosmetic_rules || {};
  const scrPerSub = scrStore.sub_scriptlet_rules || {};

  delete netPerSub[id];
  delete cosPerSub[id];
  delete scrPerSub[id];

  await chrome.storage.local.set({
    subscriptions: filtered,
    sub_network_rules:   netPerSub,
    sub_cosmetic_rules:  cosPerSub,
    sub_scriptlet_rules: scrPerSub
  });

  await rebuildNetworkRules(filtered);
  await rebuildCosmeticRules(filtered);
  await rebuildScriptletRules(filtered);

  return { ok: true };
}
