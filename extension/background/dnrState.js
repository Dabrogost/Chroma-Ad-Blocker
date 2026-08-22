/**
 * Authoritative, serialized DNR state reconciliation.
 */

'use strict';

import { getDefaultDynamicRules } from './defaultDynamicRules.js';
import { clearHealthDiagnostic, recordHealthDiagnostic } from './diagnostics.js';
import {
  buildSubscriptionRuleApplication,
  prepareSubscriptionRules
} from '../subscriptions/dnr.js';

const DEBUG = false;

const STATIC_RULESETS = chrome.runtime.getManifest()
  .declarative_net_request
  .rule_resources
  .map(resource => resource.id);

// Range 1000 - 99999 reserved for local/default dynamic rules.
const DEFAULT_RULE_ID_START = 1000;
const DEFAULT_RULE_ID_END = 99999;
const SUBSCRIPTION_RULE_ID_START = 100000;
const SUBSCRIPTION_RULE_ID_END = 8999999;
const WHITELIST_RULE_ID_START = 9000000;
const TRACKING_URL_CLEANUP_RULE_ID_START = 2000;
const TRACKING_URL_CLEANUP_RULE_ID_END = 2099;
const DEFAULT_DYNAMIC_REGEX_RULE_LIMIT = 1000;
const ACCELERATION_OFF_PRESERVED_ALLOW_RULE_IDS = new Set([1015]);
const RECOVERED_DNR_DIAGNOSTIC_IDS = [
  'dnrWakeRecovery',
  'dnrState',
  'dnrDynamicRules',
  'whitelistSync',
  'dnrStaticCompensation'
];
const WHITELIST_SUBRESOURCE_TYPES = [
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other'
];
// Compact, ephemeral rule-id -> coarse action map. It is rebuilt from Chrome's
// installed dynamic rules after every worker wake; rule conditions, URLs, and
// subscription bodies never enter this cache or chrome.storage.
const dynamicRuleClassifications = new Map();
const STATIC_RULE_ACTION_OVERRIDES = new Map([
  ['custom_static_rules:28', 'allow'],
  ['custom_static_rules:30014', 'allow'],
  ['custom_static_rules:30015', 'allow'],
  ['custom_static_rules:30027', 'allow']
]);

let requestedGeneration = 0;
let reconciliationTail = Promise.resolve();
let dynamicRuleClassificationsReady = false;
let classificationHydrationPromise = null;

function normalizeMatchedAction(actionType) {
  if (actionType === 'allow' || actionType === 'allowAllRequests') return 'allow';
  if (actionType === 'block' || actionType === 'redirect' || actionType === 'upgradeScheme') return 'block';
  return 'match';
}

/**
 * The only predicate used to decide whether browser-engine network protection
 * may be installed.
 */
export function isNetworkProtectionActive(config) {
  return config?.enabled !== false && config?.networkBlocking !== false;
}

function getStaticRuleActionType(ruleId, rulesetId) {
  const actionType = STATIC_RULE_ACTION_OVERRIDES.get(`${rulesetId}:${ruleId}`);
  if (actionType === 'allow' || actionType === 'allowAllRequests') return 'allow';
  if (actionType === 'block' || actionType === 'redirect' || actionType === 'upgradeScheme') return 'block';
  return 'block';
}

export function classifyDnrMatch(info) {
  const ruleId = Number(info?.rule?.ruleId);
  const rulesetId = info?.rule?.rulesetId || info?.rule?.ruleSetId || null;

  if (!Number.isSafeInteger(ruleId)) {
    return { type: 'match', ruleSource: 'unknown', ruleId: null, rulesetId };
  }

  if (rulesetId && STATIC_RULESETS.includes(rulesetId)) {
    return { type: getStaticRuleActionType(ruleId, rulesetId), ruleSource: 'static_ruleset', ruleId, rulesetId };
  }

  if (ruleId >= WHITELIST_RULE_ID_START) {
    return { type: 'allow', ruleSource: 'whitelist', ruleId, rulesetId };
  }

  if (ruleId >= DEFAULT_RULE_ID_START && ruleId <= DEFAULT_RULE_ID_END) {
    const actionType = dynamicRuleClassifications.get(ruleId);
    if (actionType === 'block' || actionType === 'allow') {
      return { type: actionType, ruleSource: 'default_dynamic', ruleId, rulesetId };
    }
    return { type: 'match', ruleSource: 'default_dynamic', ruleId, rulesetId };
  }

  if (ruleId >= SUBSCRIPTION_RULE_ID_START && ruleId <= SUBSCRIPTION_RULE_ID_END) {
    const actionType = dynamicRuleClassifications.get(ruleId);
    return {
      // A cache miss must stay neutral. Treating an unhydrated subscription ID
      // as a block corrupts both the request log and aggregate statistics.
      type: actionType === 'allow' || actionType === 'block' ? actionType : 'match',
      ruleSource: 'subscription_dynamic',
      ruleId,
      rulesetId
    };
  }

  return { type: 'match', ruleSource: 'unknown', ruleId, rulesetId };
}

function isTrackingCleanupRule(rule) {
  return rule?.id >= TRACKING_URL_CLEANUP_RULE_ID_START &&
    rule?.id <= TRACKING_URL_CLEANUP_RULE_ID_END;
}

function buildDefaultRules(config, whitelist, storedRules) {
  const trackingUrlCleanup = config?.trackingUrlCleanup !== false;
  const trackingOptions = {
    trackingUrlCleanup,
    trackingUrlCleanupExcludedRequestDomains: whitelist
  };
  let rules = Array.isArray(storedRules)
    ? storedRules.slice()
    : getDefaultDynamicRules(trackingOptions);

  rules = rules.filter(rule => !isTrackingCleanupRule(rule));
  if (trackingUrlCleanup) {
    rules.push(...getDefaultDynamicRules({
      ...trackingOptions,
      trackingUrlCleanup: true
    }).filter(isTrackingCleanupRule));
  }

  if (config?.acceleration === false) {
    rules = rules.map(rule => ({
      ...rule,
      action: rule.action?.type === 'allow' && !ACCELERATION_OFF_PRESERVED_ALLOW_RULE_IDS.has(rule.id)
        ? { ...rule.action, type: 'block' }
        : rule.action
    }));
  }

  return rules;
}

/**
 * Two rules are required because requestDomains and initiatorDomains in one
 * condition would be an AND. The destination rule covers direct/external
 * top-level navigation; the initiator rule covers descendants of the allowed
 * document without allowing unrelated top-level destinations.
 */
function buildWhitelistRules(whitelist) {
  const rules = [];
  whitelist.forEach((domain, index) => {
    const firstId = WHITELIST_RULE_ID_START + (index * 2);
    rules.push({
      id: firstId,
      priority: 999999,
      action: { type: 'allow' },
      condition: {
        requestDomains: [domain],
        resourceTypes: ['main_frame']
      }
    });
    rules.push({
      id: firstId + 1,
      priority: 999999,
      action: { type: 'allow' },
      condition: {
        initiatorDomains: [domain],
        resourceTypes: WHITELIST_SUBRESOURCE_TYPES
      }
    });
  });
  return rules;
}

async function readDesiredState() {
  const {
    config = {},
    dynamicRules,
    subscriptions = [],
    sub_network_rules: cachedSubscriptionRules = {},
    whitelist = []
  } = await chrome.storage.local.get([
    'config',
    'dynamicRules',
    'subscriptions',
    'sub_network_rules',
    'whitelist'
  ]);
  return {
    config,
    dynamicRules,
    subscriptions,
    cachedSubscriptionRules,
    whitelist: Array.isArray(whitelist) ? whitelist : []
  };
}

async function commitIsStillAllowed(generation, expectedActive) {
  if (generation !== requestedGeneration) return false;
  const { config = {} } = await chrome.storage.local.get('config');
  return generation === requestedGeneration &&
    isNetworkProtectionActive(config) === expectedActive;
}

function enabledStaticRulesetImage(value) {
  if (!Array.isArray(value)) {
    throw new Error('Enabled static DNR rulesets could not be read');
  }
  const enabled = new Set(value);
  return STATIC_RULESETS.filter(id => enabled.has(id));
}

function buildEnabledRulesetUpdate(currentEnabled, targetEnabled) {
  const current = new Set(currentEnabled);
  const target = new Set(targetEnabled);
  const enableRulesetIds = STATIC_RULESETS.filter(id => target.has(id) && !current.has(id));
  const disableRulesetIds = STATIC_RULESETS.filter(id => current.has(id) && !target.has(id));
  if (enableRulesetIds.length === 0 && disableRulesetIds.length === 0) return null;

  return {
    ...(enableRulesetIds.length > 0 ? { enableRulesetIds } : {}),
    ...(disableRulesetIds.length > 0 ? { disableRulesetIds } : {})
  };
}

async function applyEnabledRulesetImage(currentEnabled, targetEnabled) {
  const update = buildEnabledRulesetUpdate(currentEnabled, targetEnabled);
  if (!update) return false;
  await chrome.declarativeNetRequest.updateEnabledRulesets(update);
  return true;
}

async function readDnrPreimage() {
  const [enabledRulesets, dynamicRules] = await Promise.all([
    chrome.declarativeNetRequest.getEnabledRulesets(),
    chrome.declarativeNetRequest.getDynamicRules()
  ]);
  if (!Array.isArray(dynamicRules)) {
    throw new Error('Dynamic DNR rules could not be read');
  }
  return {
    enabledRulesets: enabledStaticRulesetImage(enabledRulesets),
    dynamicRules
  };
}

async function restoreStaticRulesetPreimage(previousEnabled, committedEnabled) {
  try {
    await applyEnabledRulesetImage(committedEnabled, previousEnabled);
  } catch (err) {
    try {
      await recordHealthDiagnostic('dnrStaticCompensation', {
        area: 'dnr',
        severity: 'error',
        message: 'Static DNR state could not be restored after an incomplete network reconciliation.',
        action: 'Reload the extension, then turn Network Blocking off and on.',
        error: err?.message || err
      });
    } catch {
      // Diagnostics must never replace the original reconciliation failure.
    }
    return false;
  }

  try {
    await clearHealthDiagnostic('dnrStaticCompensation');
  } catch {
    // The browser state was restored; stale diagnostic cleanup is best-effort.
  }
  return true;
}

function updateClassificationCache(rules) {
  dynamicRuleClassifications.clear();
  for (const rule of rules) {
    if (!Number.isSafeInteger(rule?.id)) continue;
    dynamicRuleClassifications.set(rule.id, normalizeMatchedAction(rule.action?.type));
  }
  dynamicRuleClassificationsReady = true;
}

async function clearRecoveredDnrDiagnostics() {
  // Each clear is a storage read-modify-write, so keep them sequential to
  // prevent parallel writes from restoring a diagnostic cleared by a sibling.
  for (const id of RECOVERED_DNR_DIAGNOSTIC_IDS) {
    await clearHealthDiagnostic(id);
  }
}

export function isDynamicRuleClassificationReady() {
  return dynamicRuleClassificationsReady;
}

/**
 * Rebuilds the in-memory action map from Chrome's installed rules. Hydration
 * waits for the current reconciliation generation and retries if a newer
 * generation starts while getDynamicRules() is in flight.
 */
export function hydrateDynamicRuleClassifications() {
  if (dynamicRuleClassificationsReady) {
    return Promise.resolve({ ok: true, cached: true, count: dynamicRuleClassifications.size });
  }
  if (classificationHydrationPromise) return classificationHydrationPromise;

  classificationHydrationPromise = (async () => {
    // A bounded retry keeps diagnostics from hanging under continuous toggles.
    // Callers can safely classify unresolved dynamic IDs as neutral matches and
    // a later event will retry hydration.
    for (let attempt = 0; attempt < 4; attempt++) {
      const observedTail = reconciliationTail;
      await observedTail.catch(() => {});
      if (dynamicRuleClassificationsReady) {
        return { ok: true, cached: true, count: dynamicRuleClassifications.size };
      }

      const observedGeneration = requestedGeneration;
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      if (observedTail !== reconciliationTail || observedGeneration !== requestedGeneration) continue;

      updateClassificationCache(Array.isArray(rules) ? rules : []);
      return { ok: true, cached: false, count: dynamicRuleClassifications.size };
    }
    return { ok: false, stale: true };
  })().finally(() => {
    classificationHydrationPromise = null;
  });

  return classificationHydrationPromise;
}

async function storeAppliedSubscriptionCounts(active, application) {
  const appliedNetworkRuleCount = active ? (Number(application.appliedNetworkRuleCount) || 0) : 0;
  const appliedNetworkRulesPerSub = active ? (application.appliedNetworkRulesPerSub || {}) : {};
  const browserUnsupportedRegexRuleCount = active
    ? (Number(application.browserUnsupportedRegexRuleCount) || 0)
    : 0;
  const browserUnsupportedRegexRulesPerSub = active
    ? (application.browserUnsupportedRegexRulesPerSub || {})
    : {};
  const regexQuotaTrimCount = active ? (Number(application.regexQuotaTrimCount) || 0) : 0;
  const regexQuotaTrimmedRulesPerSub = active
    ? (application.regexQuotaTrimmedRulesPerSub || {})
    : {};
  const perSub = active
    ? Object.fromEntries(Object.entries(application.subscriptionStats || {}).map(([id, stats]) => [
        id,
        { enabledAtCommit: true, ...stats }
      ]))
    : {};
  await chrome.storage.local.set({
    appliedNetworkStateVersion: 1,
    appliedNetworkRuleCount,
    appliedNetworkRulesPerSub,
    browserUnsupportedRegexRuleCount,
    browserUnsupportedRegexRulesPerSub,
    regexQuotaTrimCount,
    regexQuotaTrimmedRulesPerSub,
    subscriptionNetworkRuntime: {
      schemaVersion: 1,
      protectionActive: active,
      committedAt: Date.now(),
      appliedTotal: appliedNetworkRuleCount,
      perSub
    }
  });
}

function dynamicRegexRuleLimit() {
  const browserLimit = Number(chrome.declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES);
  return Number.isInteger(browserLimit) && browserLimit >= 0
    ? browserLimit
    : DEFAULT_DYNAMIC_REGEX_RULE_LIMIT;
}

async function performReconciliation(generation, reason) {
  const desired = await readDesiredState();
  if (generation !== requestedGeneration) return { ok: true, stale: true };

  const active = isNetworkProtectionActive(desired.config);
  let subscriptionApplication = await buildSubscriptionRuleApplication([], {});
  let desiredRules = [];
  let defaultRules = [];
  let whitelistRules = [];
  let buildSubscriptionApplication = null;
  if (active) {
    defaultRules = buildDefaultRules(
      desired.config,
      desired.whitelist,
      desired.dynamicRules
    );
    const regexLimit = dynamicRegexRuleLimit();
    const dnrApi = chrome.declarativeNetRequest;
    buildSubscriptionApplication = async currentDefaultRules => {
      const defaultRegexRuleCount = currentDefaultRules.filter(rule =>
        typeof rule?.condition?.regexFilter === 'string'
      ).length;
      if (defaultRegexRuleCount > regexLimit) {
        throw new Error(
          `Default dynamic rules exceed the browser regex quota (${defaultRegexRuleCount}/${regexLimit})`
        );
      }
      return buildSubscriptionRuleApplication(
        desired.subscriptions,
        desired.cachedSubscriptionRules,
        {
          isRegexSupported: typeof dnrApi.isRegexSupported === 'function'
            ? dnrApi.isRegexSupported.bind(dnrApi)
            : null,
          regexRuleLimit: regexLimit - defaultRegexRuleCount
        }
      );
    };
    subscriptionApplication = await buildSubscriptionApplication(defaultRules);
    const subscriptionRules = prepareSubscriptionRules(subscriptionApplication.networkRules);
    whitelistRules = buildWhitelistRules(desired.whitelist);
    desiredRules = [...defaultRules, ...subscriptionRules, ...whitelistRules];
  }

  if (!await commitIsStillAllowed(generation, active)) {
    return { ok: true, stale: true };
  }
  const preimage = await readDnrPreimage();
  if (!await commitIsStillAllowed(generation, active)) {
    return { ok: true, stale: true };
  }

  const targetEnabledRulesets = active ? STATIC_RULESETS : [];
  const removeRuleIds = preimage.dynamicRules.map(rule => rule.id);
  let staticMutationCommitted = false;
  let dynamicCommitCompleted = false;
  let compensationAttempted = false;

  const compensateStaticMutation = async () => {
    if (!staticMutationCommitted || dynamicCommitCompleted || compensationAttempted) return;
    compensationAttempted = true;
    const restored = await restoreStaticRulesetPreimage(
      preimage.enabledRulesets,
      targetEnabledRulesets
    );
    if (restored) staticMutationCommitted = false;
  };

  try {
    staticMutationCommitted = await applyEnabledRulesetImage(
      preimage.enabledRulesets,
      targetEnabledRulesets
    );

    if (generation !== requestedGeneration) {
      await compensateStaticMutation();
      return { ok: true, stale: true };
    }
    if (!await commitIsStillAllowed(generation, active)) {
      await compensateStaticMutation();
      return { ok: true, stale: true };
    }

    if (!active) {
      if (removeRuleIds.length > 0) {
        dynamicRuleClassificationsReady = false;
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
      }
      dynamicCommitCompleted = true;
      dynamicRuleClassifications.clear();
      dynamicRuleClassificationsReady = true;
      // This exact empty image is now authoritative even if a newer desired
      // generation was queued while Chrome committed it. The serialized newer
      // generation will replace the snapshot only after its own successful
      // commit.
      await storeAppliedSubscriptionCounts(false, subscriptionApplication);
      await clearRecoveredDnrDiagnostics();
      if (DEBUG) console.log(`[Chroma DNR] Reconciled inactive state (${reason}).`);
      return { ok: true, active: false };
    }

    // Keep match diagnostics behind the reconciliation boundary. If this
    // generation becomes stale after Chrome commits, the next generation (or a
    // runtime hydration after failure) will rebuild the authoritative map.
    dynamicRuleClassificationsReady = false;
    let trackingCleanupError = null;
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds,
        addRules: desiredRules
      });
    } catch (err) {
      if (!desiredRules.some(isTrackingCleanupRule)) throw err;
      if (!await commitIsStillAllowed(generation, true)) {
        await compensateStaticMutation();
        return { ok: true, stale: true };
      }
      defaultRules = defaultRules.filter(rule => !isTrackingCleanupRule(rule));
      subscriptionApplication = await buildSubscriptionApplication(defaultRules);
      const subscriptionRules = prepareSubscriptionRules(subscriptionApplication.networkRules);
      desiredRules = [...defaultRules, ...subscriptionRules, ...whitelistRules];
      if (!await commitIsStillAllowed(generation, true)) {
        await compensateStaticMutation();
        return { ok: true, stale: true };
      }
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds,
        addRules: desiredRules
      });
      trackingCleanupError = err;
    }
    dynamicCommitCompleted = true;

    // Chrome has committed this exact runtime image. Publish its action map
    // before checking whether a newer desired-state generation was requested;
    // the queued generation has not started its serialized commit yet.
    updateClassificationCache(desiredRules);

    // Diagnostic persistence is observability only. Keep it outside the DNR
    // rejection boundary so a storage failure can neither remove healthy
    // tracking rules nor make a completed browser commit look unsuccessful.
    try {
      if (trackingCleanupError) {
        await recordHealthDiagnostic('trackingUrlCleanupSync', {
          area: 'trackingUrlCleanup',
          severity: 'warning',
          message: 'Tracking URL Cleanup could not register its DNR redirect rule.',
          action: 'Reload the extension, or turn Tracking URL Cleanup off and on.',
          error: trackingCleanupError?.message || trackingCleanupError
        });
      } else {
        await clearHealthDiagnostic('trackingUrlCleanupSync');
      }
    } catch (err) {
      if (DEBUG) console.warn('[Chroma DNR] Tracking cleanup diagnostic update failed:', err);
    }

    // Publish every successfully committed image. If this generation became
    // stale during the atomic browser call, its snapshot remains the truthful
    // fallback should the queued generation fail.
    await storeAppliedSubscriptionCounts(true, subscriptionApplication);
    if (generation !== requestedGeneration) return { ok: true, stale: true };
    await clearRecoveredDnrDiagnostics();
    if (DEBUG) {
      console.log(`[Chroma DNR] Reconciled ${desiredRules.length} dynamic rules (${reason}).`);
    }
    return { ok: true, active: true, dynamicRuleCount: desiredRules.length };
  } catch (err) {
    await compensateStaticMutation();
    throw err;
  }
}

async function reconcileGeneration(generation, reason) {
  try {
    return await performReconciliation(generation, reason);
  } catch (err) {
    try {
      await recordHealthDiagnostic('dnrState', {
        area: 'dnr',
        severity: 'error',
        message: 'Core DNR state could not be synchronized.',
        action: 'Reload the extension, then turn Network Blocking off and on.',
        error: err?.message || err
      });
    } catch {
      // Diagnostics must never replace the reconciliation failure.
    }
    if (DEBUG) console.error('[Chroma Ad-Blocker] DNR reconciliation failed:', err);
    throw err;
  }
}

/**
 * Queues a full desired-state rebuild. Every request advances the generation
 * synchronously, invalidating older work before it can make another commit.
 */
export function reconcileNetworkDnr(reason = 'requested') {
  const generation = ++requestedGeneration;
  const run = reconciliationTail.then(() => reconcileGeneration(generation, reason));
  reconciliationTail = run.catch(() => {});
  return run;
}

// Compatibility names retained for callers; all now perform the same full,
// serialized reconciliation instead of mutating independent DNR ranges.
export function updateDNRState() {
  return reconcileNetworkDnr('master-network-state');
}

export function syncDynamicRules() {
  return reconcileNetworkDnr('default-dynamic-rules');
}

export function syncWhitelistRules() {
  return reconcileNetworkDnr('whitelist');
}
