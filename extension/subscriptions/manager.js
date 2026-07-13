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
 *   subscriptionCosmeticRules  — active flat runtime image consumed by content.js
 *   subscriptionScriptletRules — active flat runtime image consumed by scriptlets/engine.js
 */

'use strict';

import { DEFAULT_SUBSCRIPTIONS } from './lists.js';
import { parseList }             from './parser.js';
import { SCRIPTLET_MAP } from '../scriptlets/lib.js';
import { reconcileNetworkDnr } from '../background/dnrState.js';
import { validateRemoteHttpsUrl } from '../core/remoteUrl.js';

const DEBUG = false;
const ALARM_NAME     = 'chroma-subscription-check';
const FETCH_TIMEOUT  = 30000; // 30s per-fetch timeout
const MAX_LIST_BYTES = 10 * 1024 * 1024; // 10 MiB per subscription response
let _staticRuleKeySetPromise = null;
let _subscriptionStateTail = Promise.resolve();

function serializeSubscriptionState(task) {
  const run = _subscriptionStateTail.then(task);
  _subscriptionStateTail = run.catch(() => {});
  return run;
}

function normalizeSubscriptionCompatibility(value = {}) {
  return {
    translatedRegexFilter: Number(value?.translatedRegexFilter) || 0,
    unsupportedUrlFilter: Number(value?.unsupportedUrlFilter) || 0
  };
}

function buildSubscriptionCompatibility(networkRules = [], skipped = {}) {
  return normalizeSubscriptionCompatibility({
    translatedRegexFilter: networkRules.filter(rule => rule?.condition?.regexFilter).length,
    unsupportedUrlFilter: skipped?.unsupportedUrlFilter
  });
}

function sortedArray(value) {
  return Array.isArray(value) ? value.slice().sort() : [];
}

function networkRuleDedupeKey(rule) {
  const condition = rule?.condition || {};
  return JSON.stringify({
    actionType: rule?.action?.type || '',
    urlFilter: condition.urlFilter || '',
    regexFilter: condition.regexFilter || '',
    resourceTypes: sortedArray(condition.resourceTypes),
    domainType: condition.domainType || '',
    initiatorDomains: sortedArray(condition.initiatorDomains),
    excludedInitiatorDomains: sortedArray(condition.excludedInitiatorDomains),
    priority: Number(rule?.priority) || 0
  });
}

function getHeader(res, name) {
  if (!res.headers || typeof res.headers.get !== 'function') return null;
  return res.headers.get(name);
}

function utf8ByteLength(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function cloneSubscriptionMetadata(sub) {
  return {
    ...sub,
    ruleCount: sub?.ruleCount ? { ...sub.ruleCount } : sub?.ruleCount,
    compatibility: sub?.compatibility ? normalizeSubscriptionCompatibility(sub.compatibility) : sub?.compatibility
  };
}

function mergeDefaultSubscriptions(existing) {
  if (!Array.isArray(existing)) return DEFAULT_SUBSCRIPTIONS.map(cloneSubscriptionMetadata);

  const byId = new Map(existing.map(sub => [sub?.id, sub]));
  const merged = existing.map(sub => {
    const defaults = DEFAULT_SUBSCRIPTIONS.find(defaultSub => defaultSub.id === sub?.id);
    if (!defaults || sub?.isCustom) return sub;
    const next = {
      ...sub,
      name: defaults.name,
      url: defaults.url,
      intervalHours: defaults.intervalHours
    };
    if (sub?.compatibility || defaults.compatibility) {
      next.compatibility = normalizeSubscriptionCompatibility(sub?.compatibility || defaults.compatibility);
    } else {
      delete next.compatibility;
    }
    if (defaults.cosmeticOnly === true) next.cosmeticOnly = true;
    else delete next.cosmeticOnly;
    return next;
  });

  for (const defaults of DEFAULT_SUBSCRIPTIONS) {
    if (!byId.has(defaults.id)) {
      merged.push(cloneSubscriptionMetadata(defaults));
    }
  }

  return merged;
}

async function readResponseTextWithLimit(res, maxBytes) {
  const contentLength = Number(getHeader(res, 'content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Subscription list too large: ${contentLength} bytes exceeds ${maxBytes} byte limit`);
  }

  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    const bytes = utf8ByteLength(text);
    if (bytes > maxBytes) {
      throw new Error(`Subscription list too large: ${bytes} bytes exceeds ${maxBytes} byte limit`);
    }
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let bytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength !== undefined ? value.byteLength : utf8ByteLength(String(value));
    if (bytes > maxBytes) {
      if (typeof reader.cancel === 'function') {
        await reader.cancel().catch(() => {});
      }
      throw new Error(`Subscription list too large: exceeds ${maxBytes} byte limit`);
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}

// ─── FETCH ─────
/**
 * Fetches raw filter list text with a hard timeout.
 * @param {Object} sub
 * @returns {Promise<{ text?: string, notModified?: boolean, etag: string|null, lastModified: string|null }>}
 */
async function fetchList(sub) {
  const isBundledResource = sub?.isCustom !== true && String(sub?.url || '').startsWith('chrome-extension://');
  if (!isBundledResource) {
    const requestedUrl = validateRemoteHttpsUrl(sub?.url, { label: 'Subscription' });
    if (!requestedUrl.ok) throw new Error(`Unsafe subscription URL: ${requestedUrl.error}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  const headers = {};
  if (sub.etag) headers['If-None-Match'] = sub.etag;
  if (sub.lastModified) headers['If-Modified-Since'] = sub.lastModified;

  try {
    const res = await fetch(sub.url, { signal: controller.signal, cache: 'no-cache', headers });
    // Bundled chrome-extension:// resources do not cross a remote trust
    // boundary. Every HTTPS response, including a 304, is checked at its final
    // post-redirect URL before headers or body data are accepted.
    if (!isBundledResource) {
      const finalUrl = validateRemoteHttpsUrl(res.url || sub.url, { label: 'Subscription' });
      if (!finalUrl.ok) throw new Error(`Unsafe subscription redirect: ${finalUrl.error}`);
    }
    const etag = getHeader(res, 'etag');
    const lastModified = getHeader(res, 'last-modified');
    if (res.status === 304) {
      return {
        notModified: true,
        etag: etag || sub.etag || null,
        lastModified: lastModified || sub.lastModified || null
      };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return {
      text: await readResponseTextWithLimit(res, MAX_LIST_BYTES),
      etag: etag || null,
      lastModified: lastModified || null
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── COSMETIC DEDUPLICATION ─────
function storedCosmeticDomainKey(domains) {
  if (domains == null) return { valid: true, key: '' };
  if (!Array.isArray(domains) || domains.length === 0) return { valid: false, key: '' };

  const normalized = [];
  for (const value of domains) {
    if (typeof value !== 'string' || value !== value.trim()) return { valid: false, key: '' };
    const domain = value.toLowerCase();
    if (
      domain.length > 253 ||
      !domain.includes('.') ||
      domain.startsWith('.') ||
      domain.endsWith('.') ||
      !/^[a-z0-9.-]+$/.test(domain)
    ) {
      return { valid: false, key: '' };
    }
    const labels = domain.split('.');
    if (labels.some(label => (
      label.length === 0 ||
      label.length > 63 ||
      label.startsWith('-') ||
      label.endsWith('-')
    ))) {
      return { valid: false, key: '' };
    }
    if (/^[0-9.]+$/.test(domain) && (
      labels.length !== 4 ||
      labels.some(label => !/^\d{1,3}$/.test(label) || Number(label) > 255)
    )) {
      return { valid: false, key: '' };
    }
    normalized.push(domain);
  }

  return { valid: true, key: normalized.sort().join(',') };
}

/**
 * Deduplicates cosmetic rules across subscriptions before storage.
 * @param {Object[]} rules
 * @returns {Object[]}
 */
function deduplicateCosmeticRules(rules) {
  const seen = new Set();
  return rules.filter(rule => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
    if (typeof rule.selector !== 'string' || !rule.selector.trim() || typeof rule.isException !== 'boolean') return false;
    const included = storedCosmeticDomainKey(rule.domains);
    const excluded = storedCosmeticDomainKey(rule.excludedDomains);
    // Do not let malformed cached values collide with a valid semantic key or
    // make the combined-cache rebuild reject otherwise valid sibling rules.
    if (!included.valid || !excluded.valid) return false;
    const key = `${rule.isException}|${included.key}|${excluded.key}|${rule.selector}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── STATIC RULE DEDUPLICATION ─────
/**
 * Builds a Set of semantic rule keys from all bundled static rule files.
 * Used to exclude subscription rules that are already covered statically.
 * Cached for the service-worker lifetime; bundled rule resources do not change
 * until the extension is reloaded or updated.
 * @returns {Promise<Set<string>>}
 */
async function buildStaticRuleKeySet() {
  if (_staticRuleKeySetPromise) return _staticRuleKeySetPromise;

  _staticRuleKeySetPromise = (async () => {
    const files = chrome.runtime
      .getManifest()
      .declarative_net_request
      .rule_resources
      .map(resource => resource.path);

    const set = new Set();
    await Promise.all(files.map(async (file) => {
      try {
        const res = await fetch(chrome.runtime.getURL(file));
        if (!res.ok) return;
        const rules = await res.json();
        for (const rule of rules) {
          if (rule.condition && (rule.condition.urlFilter || rule.condition.regexFilter)) {
            set.add(networkRuleDedupeKey(rule));
          }
        }
      } catch {
        // Static resource failures are non-fatal; deduplication is best-effort.
      }
    }));

    return set;
  })();

  return _staticRuleKeySetPromise;
}

// ─── REBUILD HELPERS ─────
/**
 * Reconciles cached subscription rules through the authoritative DNR
 * coordinator.
 * @returns {Promise<void>}
 */
async function rebuildNetworkRules() {
  await reconcileNetworkDnr('subscription-cache');
}

/**
 * Combines enabled subscription cosmetic rules and writes flat array to storage.
 * content.js reads subscriptionCosmeticRules on init.
 * @param {Object[]} subscriptions
 * @returns {Promise<void>}
 */
function buildCombinedCosmeticRules(subscriptions, perSubRules = {}) {
  const allRules = [];
  for (const sub of subscriptions) {
    if (sub?.enabled && Array.isArray(perSubRules[sub.id])) {
      for (const rule of perSubRules[sub.id]) {
        allRules.push(rule);
      }
    }
  }

  return deduplicateCosmeticRules(allRules);
}

/**
 * Combines enabled subscription scriptlet rules and writes flat array to storage.
 * scriptlets/engine.js reads subscriptionScriptletRules.
 * @param {Object[]} subscriptions
 * @returns {Promise<void>}
 */
function buildCombinedScriptletRules(subscriptions, perSubRules = {}) {
  const allRules = [];
  for (const sub of subscriptions) {
    if (sub?.enabled && Array.isArray(perSubRules[sub.id])) {
      for (const rule of perSubRules[sub.id]) {
        allRules.push({ ...rule, sourceId: sub.id });
      }
    }
  }

  return allRules;
}

function isSubscriptionRuntimeActive(config) {
  return config?.enabled !== false;
}

function buildSubscriptionRuntimeState(config, subscriptions, cosmeticRules, scriptletRules) {
  if (!isSubscriptionRuntimeActive(config)) {
    return {
      subscriptionCosmeticRules: [],
      subscriptionScriptletRules: []
    };
  }

  return {
    subscriptionCosmeticRules: buildCombinedCosmeticRules(subscriptions, cosmeticRules),
    subscriptionScriptletRules: buildCombinedScriptletRules(subscriptions, scriptletRules)
  };
}

function clonePerSubscriptionStore(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value }
    : {};
}

function subscriptionStageError(error) {
  return { ok: false, error, importedCount: 0, storage: null };
}

/**
 * Builds the complete subscription-owned portion of a settings-import storage
 * image without writing storage or reconciling DNR. Transactional callers can
 * combine this image with other staged settings and commit it atomically.
 *
 * @param {Object[]} importedCustomSubs
 * @param {Object} currentState current subscription-owned storage values
 * @param {Object} runtimeConfig staged configuration controlling the aggregate runtime image
 * @returns {{ ok: boolean, importedCount: number, storage: Object|null, error?: string }}
 */
export function stageCustomSubscriptions(
  importedCustomSubs = [],
  currentState = {},
  runtimeConfig = currentState?.config
) {
  if (!Array.isArray(importedCustomSubs)) {
    return subscriptionStageError('Imported subscriptions must be an array');
  }

  const storedSubscriptions = Array.isArray(currentState?.subscriptions)
    ? currentState.subscriptions
    : [];
  const baseSubscriptions = mergeDefaultSubscriptions(storedSubscriptions)
    .map(cloneSubscriptionMetadata);
  const defaultIds = new Set(
    baseSubscriptions.filter(sub => sub?.isCustom !== true).map(sub => sub.id)
  );
  const candidatesById = new Map();

  for (const candidate of importedCustomSubs) {
    const validShape = candidate && typeof candidate === 'object' && !Array.isArray(candidate) &&
      typeof candidate.id === 'string' && candidate.id.length > 0 &&
      typeof candidate.url === 'string' && candidate.url.length > 0;
    if (!validShape) {
      return subscriptionStageError('Imported subscription metadata is malformed');
    }
    if (defaultIds.has(candidate.id)) {
      return subscriptionStageError(`Imported subscription ID conflicts with a default: ${candidate.id}`);
    }
    if (candidatesById.has(candidate.id)) {
      return subscriptionStageError(`Duplicate imported subscription ID: ${candidate.id}`);
    }
    const validatedUrl = validateRemoteHttpsUrl(candidate.url, { label: 'Subscription' });
    if (!validatedUrl.ok) {
      return subscriptionStageError(`Invalid imported subscription URL: ${validatedUrl.error}`);
    }
    candidatesById.set(candidate.id, {
      ...cloneSubscriptionMetadata(candidate),
      url: validatedUrl.url,
      isCustom: true
    });
  }

  const keptSubscriptions = baseSubscriptions.filter(sub => sub?.isCustom !== true);
  const usedUrls = new Set(keptSubscriptions.map(sub => sub?.url).filter(Boolean));
  const acceptedImports = [];

  for (const candidate of candidatesById.values()) {
    if (usedUrls.has(candidate.url)) {
      return subscriptionStageError(`Duplicate or conflicting imported subscription URL: ${candidate.url}`);
    }
    usedUrls.add(candidate.url);
    acceptedImports.push(candidate);
  }

  const nextSubscriptions = keptSubscriptions.concat(acceptedImports);
  const netPerSub = clonePerSubscriptionStore(currentState?.sub_network_rules);
  const cosPerSub = clonePerSubscriptionStore(currentState?.sub_cosmetic_rules);
  const scrPerSub = clonePerSubscriptionStore(currentState?.sub_scriptlet_rules);
  const clearedIds = new Set([
    ...baseSubscriptions.filter(sub => sub?.isCustom === true).map(sub => sub.id),
    ...acceptedImports.map(sub => sub.id)
  ]);
  const stagedIds = new Set(nextSubscriptions.map(sub => sub?.id).filter(Boolean));
  for (const store of [netPerSub, cosPerSub, scrPerSub]) {
    for (const id of Object.keys(store)) {
      if (!stagedIds.has(id)) delete store[id];
    }
  }

  for (const id of clearedIds) {
    delete netPerSub[id];
    delete cosPerSub[id];
    delete scrPerSub[id];
  }

  const storage = {
    subscriptions: nextSubscriptions,
    sub_network_rules: netPerSub,
    sub_cosmetic_rules: cosPerSub,
    sub_scriptlet_rules: scrPerSub,
    ...buildSubscriptionRuntimeState(runtimeConfig, nextSubscriptions, cosPerSub, scrPerSub)
  };

  return {
    ok: true,
    importedCount: acceptedImports.length,
    storage
  };
}

// ─── PUBLIC API ─────
/**
 * Converges the two subscription-owned runtime aggregates with master state.
 * Per-list caches and requested subscription enablement are never changed, so
 * re-enabling can restore the exact cosmetic/scriptlet image without fetching.
 *
 * @returns {Promise<{ ok: true, active: boolean, changed: boolean, cosmeticRuleCount: number, scriptletRuleCount: number }>}
 */
export function reconcileSubscriptionRuntimeState() {
  return serializeSubscriptionState(async () => {
    const {
      config = {},
      subscriptions = [],
      sub_cosmetic_rules: cosmeticRules = {},
      sub_scriptlet_rules: scriptletRules = {},
      subscriptionCosmeticRules: currentCosmeticRules = [],
      subscriptionScriptletRules: currentScriptletRules = []
    } = await chrome.storage.local.get([
      'config',
      'subscriptions',
      'sub_cosmetic_rules',
      'sub_scriptlet_rules',
      'subscriptionCosmeticRules',
      'subscriptionScriptletRules'
    ]);
    const runtimeState = buildSubscriptionRuntimeState(
      config,
      subscriptions,
      cosmeticRules,
      scriptletRules
    );
    const changed =
      JSON.stringify(currentCosmeticRules) !== JSON.stringify(runtimeState.subscriptionCosmeticRules) ||
      JSON.stringify(currentScriptletRules) !== JSON.stringify(runtimeState.subscriptionScriptletRules);
    if (changed) await chrome.storage.local.set(runtimeState);
    return {
      ok: true,
      active: isSubscriptionRuntimeActive(config),
      changed,
      cosmeticRuleCount: runtimeState.subscriptionCosmeticRules.length,
      scriptletRuleCount: runtimeState.subscriptionScriptletRules.length
    };
  });
}

/**
 * Called from onInstalled. Writes default subscriptions if none exist.
 * Registers the update alarm.
 * @returns {Promise<void>}
 */
export async function initSubscriptions() {
  const { subscriptions } = await chrome.storage.local.get('subscriptions');
  const merged = mergeDefaultSubscriptions(subscriptions);
  if (JSON.stringify(merged) !== JSON.stringify(subscriptions)) {
    await chrome.storage.local.set({ subscriptions: merged });
  }
  await reconcileSubscriptionRuntimeState();
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
    const fetched = await fetchList(sub);
    const now = Date.now();

    if (fetched.notModified) {
      const metadataCommitted = await serializeSubscriptionState(async () => {
        const { subscriptions: latestSubscriptions = [] } = await chrome.storage.local.get('subscriptions');
        const currentSub = latestSubscriptions.find(item => item.id === id);
        if (!currentSub || currentSub.url !== sub.url) return false;
        const nextSubscriptions = latestSubscriptions.map(item => item.id === id
          ? {
              ...item,
              lastUpdated: now,
              lastError: null,
              etag: fetched.etag,
              lastModified: fetched.lastModified
            }
          : item
        );
        await chrome.storage.local.set({ subscriptions: nextSubscriptions });
        return true;
      });
      if (!metadataCommitted) {
        return { ok: false, error: 'Subscription changed during refresh' };
      }
      await reconcileSubscriptionRuntimeState();
      // A 304 confirms the cache is current; rebuilding here also repairs a
      // missing runtime ruleset after browser or service-worker recovery.
      await reconcileNetworkDnr('subscription-not-modified');
      return { ok: true, notModified: true };
    }

    const { networkRules: parsedNetworkRules, cosmeticRules, scriptletRules, skipped } = parseList(fetched.text || '');
    const staticRuleKeys = await buildStaticRuleKeySet();
    const networkRules = parsedNetworkRules
      .filter(r => !staticRuleKeys.has(networkRuleDedupeKey(r)))
      .map((rule, index) => ({ ...rule, _listPosition: index }));
    const compatibility = buildSubscriptionCompatibility(sub.cosmeticOnly ? [] : networkRules, skipped);

    // Only keep scriptlet rules whose name matches an implementation we ship.
    // Anything else would be silently dropped at engine registration anyway,
    // so we drop it here to avoid storing thousands of dead rules.
    const usableScriptlets = scriptletRules.filter(r => SCRIPTLET_MAP.has(r.scriptlet));
    const cacheCommitted = await serializeSubscriptionState(async () => {
      const {
        subscriptions: latestSubscriptions = [],
        sub_network_rules: storedNetworkRules = {},
        sub_cosmetic_rules: storedCosmeticRules = {},
        sub_scriptlet_rules: storedScriptletRules = {},
        config = {}
      } = await chrome.storage.local.get([
        'subscriptions',
        'sub_network_rules',
        'sub_cosmetic_rules',
        'sub_scriptlet_rules',
        'config'
      ]);
      const currentSub = latestSubscriptions.find(item => item.id === id);
      if (!currentSub || currentSub.url !== sub.url) return false;

      const netPerSub = { ...storedNetworkRules };
      const cosPerSub = { ...storedCosmeticRules };
      const scrPerSub = { ...storedScriptletRules };
      netPerSub[id] = currentSub.cosmeticOnly ? [] : networkRules;
      cosPerSub[id] = cosmeticRules;
      scrPerSub[id] = usableScriptlets;

      const nextSubscriptions = latestSubscriptions.map(item => item.id === id
        ? {
            ...item,
            ruleCount: {
              network: item.cosmeticOnly ? 0 : networkRules.length,
              cosmetic: cosmeticRules.length,
              scriptlet: usableScriptlets.length
            },
            compatibility,
            lastUpdated: now,
            version: String(now),
            lastError: null,
            etag: fetched.etag,
            lastModified: fetched.lastModified
          }
        : item
      );

      await chrome.storage.local.set({
        subscriptions: nextSubscriptions,
        sub_network_rules: netPerSub,
        sub_cosmetic_rules: cosPerSub,
        sub_scriptlet_rules: scrPerSub,
        ...buildSubscriptionRuntimeState(config, nextSubscriptions, cosPerSub, scrPerSub)
      });
      return true;
    });

    if (!cacheCommitted) {
      return { ok: false, error: 'Subscription changed during refresh' };
    }
    // The coordinator rereads config and cached rules immediately before its
    // commit. Off-state refreshes therefore update cache without adding DNR.
    await reconcileNetworkDnr('subscription-refresh');

    if (DEBUG) {
      console.log(
        `[Chroma Subscriptions] ${sub.name} —`,
        `Network: ${networkRules.length},`,
        `Cosmetic: ${cosmeticRules.length},`,
        `Scriptlet: ${scriptletRules.length},`,
        'Skipped:',
        skipped
      );
    }

    return { ok: true };
  } catch (err) {
    // Record error without clobbering other subscription metadata
    await serializeSubscriptionState(async () => {
      const { subscriptions: subs = [] } = await chrome.storage.local.get('subscriptions');
      if (!subs.some(item => item.id === id)) return;
      await chrome.storage.local.set({
        subscriptions: subs.map(item => item.id === id
          ? { ...item, lastError: err.message }
          : item)
      });
    });
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
  const updated = await serializeSubscriptionState(async () => {
    const {
      subscriptions = [],
      sub_cosmetic_rules: cosmeticRules = {},
      sub_scriptlet_rules: scriptletRules = {},
      config = {}
    } = await chrome.storage.local.get([
      'subscriptions',
      'sub_cosmetic_rules',
      'sub_scriptlet_rules',
      'config'
    ]);
    if (!subscriptions.some(sub => sub.id === id)) return false;

    const nextSubscriptions = subscriptions.map(sub => sub.id === id
      ? { ...sub, enabled }
      : sub);
    await chrome.storage.local.set({
      subscriptions: nextSubscriptions,
      ...buildSubscriptionRuntimeState(config, nextSubscriptions, cosmeticRules, scriptletRules)
    });
    return true;
  });
  if (!updated) return { ok: false };

  await rebuildNetworkRules();

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

  if (subscriptions.find(s => s.url === sub.url)) return { ok: false, error: 'URL already added' };

  subscriptions.push({
    id: sub.id,
    name: sub.name,
    url: sub.url,
    enabled: true,
    isCustom: true,
    intervalHours: sub.intervalHours || 24,
    lastUpdated: 0,
    version: null,
    lastError: null,
    ruleCount: { network: 0, cosmetic: 0, scriptlet: 0 },
    compatibility: normalizeSubscriptionCompatibility()
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
  const removed = await serializeSubscriptionState(async () => {
    const {
      config = {},
      subscriptions = [],
      sub_network_rules: storedNetworkRules = {},
      sub_cosmetic_rules: storedCosmeticRules = {},
      sub_scriptlet_rules: storedScriptletRules = {}
    } = await chrome.storage.local.get([
      'config',
      'subscriptions',
      'sub_network_rules',
      'sub_cosmetic_rules',
      'sub_scriptlet_rules'
    ]);
    const filtered = subscriptions.filter(sub => sub.id !== id);
    if (filtered.length === subscriptions.length) return false;

    const netPerSub = { ...storedNetworkRules };
    const cosPerSub = { ...storedCosmeticRules };
    const scrPerSub = { ...storedScriptletRules };
    delete netPerSub[id];
    delete cosPerSub[id];
    delete scrPerSub[id];

    await chrome.storage.local.set({
      subscriptions: filtered,
      sub_network_rules: netPerSub,
      sub_cosmetic_rules: cosPerSub,
      sub_scriptlet_rules: scrPerSub,
      ...buildSubscriptionRuntimeState(config, filtered, cosPerSub, scrPerSub)
    });
    return true;
  });
  if (!removed) return { ok: false };

  await rebuildNetworkRules();

  return { ok: true };
}
