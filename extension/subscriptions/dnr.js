/**
 * Chroma Ad-Blocker — Subscription DNR rule preparation.
 *
 * This module is deliberately side-effect free. The background DNR coordinator
 * is the only place that commits rules to chrome.declarativeNetRequest.
 */

'use strict';

import {
  allocate,
  SUBSCRIPTION_ID_START,
  SUBSCRIPTION_ID_END
} from './budget.js';

const DEBUG = false;
const VALID_ACTION_TYPES = new Set(['block', 'allow']);
const VALID_RESOURCE_TYPES = new Set([
  'main_frame',
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
]);
const MAX_FILTER_BYTES = 2048;
const DEFAULT_DYNAMIC_REGEX_RULE_LIMIT = 1000;
const DEFAULT_REGEX_PREFLIGHT_CONCURRENCY = 8;
const REGEX_PREFLIGHT_WORK_MULTIPLIER = 2;
const REGEX_PREFLIGHT_MIN_BACKFILL_BATCH = 64;
const MAX_REGEX_SUPPORT_CACHE_ENTRIES = 2048;

// Browser support depends on the regex text and case-sensitivity flag, not on
// the subscription that supplied the rule. Keep this cache ephemeral so a
// service-worker/browser restart naturally revalidates the current engine.
const regexSupportCache = new Map();

function byteLength(value) {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
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

function isAscii(value) {
  return !/[^\x00-\x7f]/.test(value);
}

function validateStringArray(values, label, { valueSet = null, validateValue = null } = {}) {
  if (values === undefined) return;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${label} entries must be non-empty strings`);
    }
    if (valueSet && !valueSet.has(value)) {
      throw new Error(`${label} contains unsupported value: ${value}`);
    }
    if (validateValue && !validateValue(value)) {
      throw new Error(`${label} contains malformed value: ${value}`);
    }
  }
}

function isValidDomainConstraint(value) {
  if (
    value !== value.trim() ||
    value.length > 253 ||
    !value.includes('.') ||
    value.startsWith('.') ||
    value.endsWith('.') ||
    !/^[a-z0-9.-]+$/i.test(value)
  ) {
    return false;
  }
  const labels = value.split('.');
  if (/^[0-9.]+$/.test(value) && (
    labels.length !== 4 ||
    labels.some(label => !/^\d{1,3}$/.test(label) || Number(label) > 255)
  )) {
    return false;
  }
  return labels.every(label =>
    label.length > 0 &&
    label.length <= 63 &&
    !label.startsWith('-') &&
    !label.endsWith('-')
  );
}

function validateSubscriptionRule(rule, index) {
  const label = `subscription rule ${index}`;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new Error(`${label} must be an object`);
  }
  if (!Number.isInteger(rule.id) || rule.id < SUBSCRIPTION_ID_START || rule.id > SUBSCRIPTION_ID_END) {
    throw new Error(`${label} has invalid id`);
  }
  if (!Number.isInteger(rule.priority) || rule.priority < 1) {
    throw new Error(`${label} must have integer priority >= 1`);
  }
  if (!rule.action || typeof rule.action !== 'object' || Array.isArray(rule.action) || !VALID_ACTION_TYPES.has(rule.action.type)) {
    throw new Error(`${label} has unsupported action`);
  }
  const condition = rule.condition;
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    throw new Error(`${label} missing condition`);
  }

  const hasUrlFilter = condition.urlFilter !== undefined;
  const hasRegexFilter = condition.regexFilter !== undefined;
  if (!hasUrlFilter && !hasRegexFilter) {
    throw new Error(`${label} requires urlFilter or regexFilter`);
  }
  if (hasUrlFilter && hasRegexFilter) {
    throw new Error(`${label} cannot combine urlFilter and regexFilter`);
  }
  if (hasUrlFilter) {
    if (typeof condition.urlFilter !== 'string' || condition.urlFilter.length === 0) {
      throw new Error(`${label}.condition.urlFilter must be a non-empty string`);
    }
    if (!isAscii(condition.urlFilter)) {
      throw new Error(`${label}.condition.urlFilter must contain only ASCII characters`);
    }
    if (byteLength(condition.urlFilter) > MAX_FILTER_BYTES) {
      throw new Error(`${label}.condition.urlFilter exceeds ${MAX_FILTER_BYTES} bytes`);
    }
  }
  if (hasRegexFilter) {
    if (typeof condition.regexFilter !== 'string' || condition.regexFilter.length === 0) {
      throw new Error(`${label}.condition.regexFilter must be a non-empty string`);
    }
    if (!isAscii(condition.regexFilter)) {
      throw new Error(`${label}.condition.regexFilter must contain only ASCII characters`);
    }
    if (byteLength(condition.regexFilter) > MAX_FILTER_BYTES) {
      throw new Error(`${label}.condition.regexFilter exceeds ${MAX_FILTER_BYTES} bytes`);
    }
    try {
      new RegExp(condition.regexFilter);
    } catch (err) {
      throw new Error(`${label}.condition.regexFilter does not compile: ${err.message}`);
    }
  }

  if (
    condition.domainType !== undefined &&
    condition.domainType !== 'firstParty' &&
    condition.domainType !== 'thirdParty'
  ) {
    throw new Error(`${label}.condition.domainType has unsupported value: ${condition.domainType}`);
  }
  validateStringArray(condition.resourceTypes, `${label}.condition.resourceTypes`, { valueSet: VALID_RESOURCE_TYPES });
  validateStringArray(condition.excludedResourceTypes, `${label}.condition.excludedResourceTypes`, { valueSet: VALID_RESOURCE_TYPES });
  validateStringArray(condition.initiatorDomains, `${label}.condition.initiatorDomains`, { validateValue: isValidDomainConstraint });
  validateStringArray(condition.excludedInitiatorDomains, `${label}.condition.excludedInitiatorDomains`, { validateValue: isValidDomainConstraint });
}

function isSafeCachedRule(rule) {
  try {
    validateSubscriptionRule({ ...rule, id: SUBSCRIPTION_ID_START }, 0);
    return true;
  } catch (err) {
    if (DEBUG) console.warn('[Chroma Subscriptions] Dropping malformed cached DNR rule:', err);
    return false;
  }
}

function countObject(entries) {
  return Object.fromEntries(entries);
}

function incrementCount(counts, key, amount = 1) {
  counts.set(key, (counts.get(key) || 0) + amount);
}

function regexSupportKey(condition) {
  return JSON.stringify([
    condition.regexFilter,
    condition.isUrlFilterCaseSensitive === true
  ]);
}

function rememberRegexSupport(key, result) {
  if (regexSupportCache.has(key)) regexSupportCache.delete(key);
  regexSupportCache.set(key, result);
  while (regexSupportCache.size > MAX_REGEX_SUPPORT_CACHE_ENTRIES) {
    regexSupportCache.delete(regexSupportCache.keys().next().value);
  }
}

function resolveRegexSupportChecker(checker) {
  if (typeof checker === 'function') return checker;
  const dnr = globalThis.chrome?.declarativeNetRequest;
  if (typeof dnr?.isRegexSupported === 'function') {
    return dnr.isRegexSupported.bind(dnr);
  }
  throw new Error('chrome.declarativeNetRequest.isRegexSupported is unavailable');
}

/**
 * Asks Chromium's RE2 compiler about each distinct subscription regex before
 * the rule can consume a quota/budget slot. Source length and JavaScript's
 * RegExp parser cannot predict Chromium's compiled-memory limit.
 */
async function preflightRegexCandidates(candidates, checker, concurrency) {
  const uniqueChecks = new Map();
  // Keep every result needed by this reconciliation independently of the
  // bounded service-worker cache. A candidate set may legitimately exceed the
  // lifetime cache while it is being reduced to Chromium's regex quota.
  const currentResults = new Map();
  for (const candidate of candidates) {
    if (!candidate?.condition?.regexFilter) continue;
    const key = regexSupportKey(candidate.condition);
    const cached = regexSupportCache.get(key);
    if (cached) {
      currentResults.set(key, cached);
    } else if (!uniqueChecks.has(key)) {
      uniqueChecks.set(key, candidate.condition);
    }
  }

  if (uniqueChecks.size > 0) {
    const isRegexSupported = resolveRegexSupportChecker(checker);
    const checks = Array.from(uniqueChecks.entries());
    let nextIndex = 0;
    const workerCount = Math.min(
      checks.length,
      Math.max(1, Math.min(32, Number.isInteger(concurrency)
        ? concurrency
        : DEFAULT_REGEX_PREFLIGHT_CONCURRENCY))
    );

    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < checks.length) {
        const index = nextIndex++;
        const [key, condition] = checks[index];
        let result;
        try {
          result = await isRegexSupported({
            regex: condition.regexFilter,
            isCaseSensitive: condition.isUrlFilterCaseSensitive === true,
            requireCapturing: false
          });
        } catch (err) {
          throw new Error(`Browser regex compatibility check failed: ${err?.message || err}`);
        }
        if (!result || typeof result.isSupported !== 'boolean') {
          throw new Error('Browser regex compatibility check returned an invalid result');
        }
        const normalized = {
          isSupported: result.isSupported,
          reason: result.isSupported ? null : (result.reason || 'unsupported')
        };
        currentResults.set(key, normalized);
        rememberRegexSupport(key, normalized);
      }
    });
    await Promise.all(workers);
  }

  const compatible = [];
  const unsupported = [];
  for (const candidate of candidates) {
    if (!candidate?.condition?.regexFilter) {
      compatible.push(candidate);
      continue;
    }
    const result = currentResults.get(regexSupportKey(candidate.condition));
    if (!result) {
      throw new Error('Browser regex compatibility result was not available');
    }
    if (result.isSupported) compatible.push(candidate);
    else unsupported.push({ candidate, reason: result.reason || 'unsupported' });
  }
  return { compatible, unsupported };
}

function normalizeLimit(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function takePrioritizedCandidates(candidates, count) {
  const takeCount = Math.min(candidates.length, Math.max(0, count));
  if (takeCount === 0) return [];
  if (takeCount === candidates.length) return candidates.slice();

  const byId = new Map(candidates.map(candidate => [candidate._candidateId, candidate]));
  const { allocated } = allocate(candidates, takeCount);
  return allocated.map(candidate => byId.get(candidate._candidateId));
}

/**
 * Validates the highest-priority quota candidates first, then examines a
 * bounded reserve only when unsupported rules leave holes. Lower-priority
 * candidates that are never examined are deterministic quota overflow, not
 * browser incompatibilities.
 */
async function selectSupportedRegexCandidates(
  candidates,
  regexRuleLimit,
  checker,
  concurrency
) {
  const maxExamined = Math.min(
    candidates.length,
    regexRuleLimit * REGEX_PREFLIGHT_WORK_MULTIPLIER
  );
  // Rank the unbounded candidate set once, then keep every backfill pass inside
  // the bounded work pool. Re-ranking the full remainder for each small
  // backfill batch can otherwise multiply O(n log n) work on large caches.
  const preflightPool = takePrioritizedCandidates(candidates, maxExamined);
  const preflightPoolIds = new Set(
    preflightPool.map(candidate => candidate._candidateId)
  );
  const quotaTrimmedIds = new Set();
  for (const candidate of candidates) {
    if (!preflightPoolIds.has(candidate._candidateId)) {
      quotaTrimmedIds.add(candidate._candidateId);
    }
  }
  let remaining = preflightPool;
  const supported = [];
  const unsupported = [];
  let examinedCount = 0;
  let initialBatch = true;

  while (
    supported.length < regexRuleLimit &&
    remaining.length > 0 &&
    examinedCount < maxExamined
  ) {
    const missing = regexRuleLimit - supported.length;
    const minimumBackfill = Math.min(
      REGEX_PREFLIGHT_MIN_BACKFILL_BATCH,
      regexRuleLimit
    );
    const requested = initialBatch ? missing : Math.max(missing, minimumBackfill);
    const batchSize = Math.min(requested, remaining.length, maxExamined - examinedCount);
    const batch = takePrioritizedCandidates(remaining, batchSize);
    const batchIds = new Set(batch.map(candidate => candidate._candidateId));
    remaining = remaining.filter(candidate => !batchIds.has(candidate._candidateId));

    const result = await preflightRegexCandidates(batch, checker, concurrency);
    supported.push(...result.compatible);
    unsupported.push(...result.unsupported);
    examinedCount += batch.length;
    initialBatch = false;
  }

  const { allocated } = allocate(supported, regexRuleLimit);
  const selectedIds = new Set(allocated.map(candidate => candidate._candidateId));
  for (const candidate of remaining) {
    quotaTrimmedIds.add(candidate._candidateId);
  }
  for (const candidate of supported) {
    if (!selectedIds.has(candidate._candidateId)) {
      quotaTrimmedIds.add(candidate._candidateId);
    }
  }

  return {
    supported,
    unsupported,
    selectedIds,
    quotaTrimmedIds
  };
}

/**
 * Combines cached rules for enabled subscriptions and applies the deterministic
 * subscription budget. Stored subscription order and per-list order are kept.
 */
export async function buildSubscriptionRuleApplication(
  subscriptions = [],
  perSubRules = {},
  {
    isRegexSupported,
    regexRuleLimit = DEFAULT_DYNAMIC_REGEX_RULE_LIMIT,
    regexPreflightConcurrency = DEFAULT_REGEX_PREFLIGHT_CONCURRENCY,
    ruleLimit
  } = {}
) {
  const allRules = [];
  const statsBySub = new Map();
  let candidateId = 0;
  for (const sub of subscriptions) {
    if (
      sub?.cosmeticOnly ||
      sub?.pendingRemoval === true ||
      !sub?.enabled ||
      typeof sub?.id !== 'string' ||
      !sub.id
    ) continue;
    const cachedRules = Array.isArray(perSubRules[sub.id]) ? perSubRules[sub.id] : [];
    const stats = {
      sourceVersion: sub.version ?? null,
      networkCompilerVersion: sub.networkCompilerVersion ?? null,
      cachedNetworkRuleCount: cachedRules.length,
      candidateNetworkRuleCount: 0,
      compatibleNetworkRuleCount: 0,
      eligibleNetworkRuleCount: 0,
      appliedNetworkRuleCount: 0,
      structurallySkippedNetworkRuleCount: 0,
      browserUnsupportedRegexRuleCount: 0,
      regexQuotaTrimCount: 0,
      budgetTrimCount: 0
    };
    statsBySub.set(sub.id, stats);
    for (let sourceIndex = 0; sourceIndex < cachedRules.length; sourceIndex++) {
      const rule = cachedRules[sourceIndex];
      if (isSafeCachedRule(rule)) {
        allRules.push({
          ...rule,
          _subId: sub.id,
          _sourceIndex: sourceIndex,
          _candidateId: candidateId++
        });
        stats.candidateNetworkRuleCount++;
      } else {
        stats.structurallySkippedNetworkRuleCount++;
      }
    }
  }

  const normalizedRegexRuleLimit = normalizeLimit(
    regexRuleLimit,
    DEFAULT_DYNAMIC_REGEX_RULE_LIMIT
  );
  const regexCandidates = allRules.filter(rule => rule?.condition?.regexFilter);
  const {
    supported: supportedRegexCandidates,
    unsupported,
    selectedIds: selectedRegexCandidateIds,
    quotaTrimmedIds: regexQuotaTrimmedCandidateIds
  } = await selectSupportedRegexCandidates(
    regexCandidates,
    normalizedRegexRuleLimit,
    isRegexSupported,
    regexPreflightConcurrency
  );
  const browserUnsupportedRegexRulesPerSub = new Map(
    Array.from(statsBySub.keys(), id => [id, 0])
  );
  const browserUnsupportedRegexRules = [];
  for (const { candidate, reason } of unsupported) {
    const stats = statsBySub.get(candidate._subId);
    if (stats) stats.browserUnsupportedRegexRuleCount++;
    incrementCount(browserUnsupportedRegexRulesPerSub, candidate._subId);
    browserUnsupportedRegexRules.push({
      subId: candidate._subId,
      sourceIndex: candidate._sourceIndex,
      reason
    });
  }
  for (const candidate of allRules) {
    if (candidate?.condition?.regexFilter) continue;
    const stats = statsBySub.get(candidate._subId);
    if (stats) stats.compatibleNetworkRuleCount++;
  }
  for (const candidate of supportedRegexCandidates) {
    const stats = statsBySub.get(candidate._subId);
    if (stats) stats.compatibleNetworkRuleCount++;
  }

  const eligible = allRules.filter(candidate =>
    !candidate?.condition?.regexFilter || selectedRegexCandidateIds.has(candidate._candidateId)
  );
  const regexQuotaTrimmedRules = allRules.filter(candidate =>
    regexQuotaTrimmedCandidateIds.has(candidate._candidateId)
  );
  const regexQuotaTrimmedRulesPerSub = new Map(
    Array.from(statsBySub.keys(), id => [id, 0])
  );
  for (const candidate of regexQuotaTrimmedRules) {
    const stats = statsBySub.get(candidate._subId);
    if (stats) stats.regexQuotaTrimCount++;
    incrementCount(regexQuotaTrimmedRulesPerSub, candidate._subId);
  }
  for (const candidate of eligible) {
    const stats = statsBySub.get(candidate._subId);
    if (stats) stats.eligibleNetworkRuleCount++;
  }

  const allocationLimit = normalizeLimit(ruleLimit, undefined);
  const { allocated, trimCount } = allocationLimit === undefined
    ? allocate(eligible)
    : allocate(eligible, allocationLimit);
  if (DEBUG && trimCount > 0) {
    console.warn(`[Chroma Subscriptions] Budget trim: dropped ${trimCount} rules.`);
  }

  const appliedNetworkRulesPerSub = new Map(
    Array.from(statsBySub.keys(), id => [id, 0])
  );
  const allocatedCandidateIds = new Set(allocated.map(rule => rule._candidateId));
  for (const candidate of eligible) {
    const stats = statsBySub.get(candidate._subId);
    if (!stats) continue;
    if (allocatedCandidateIds.has(candidate._candidateId)) stats.appliedNetworkRuleCount++;
    else stats.budgetTrimCount++;
  }
  const networkRules = allocated.map(({
    _subId,
    _sourceIndex,
    _candidateId,
    ...rule
  }) => {
    if (_subId) incrementCount(appliedNetworkRulesPerSub, _subId);
    return rule;
  });

  const browserUnsupportedRegexRuleCount = unsupported.length;
  const regexQuotaTrimCount = regexQuotaTrimmedRules.length;

  return {
    networkRules,
    appliedNetworkRuleCount: networkRules.length,
    appliedNetworkRulesPerSub: countObject(appliedNetworkRulesPerSub),
    browserUnsupportedRegexRuleCount,
    browserUnsupportedRegexRulesPerSub: countObject(browserUnsupportedRegexRulesPerSub),
    browserUnsupportedRegexRules,
    regexQuotaTrimCount,
    regexQuotaTrimmedRulesPerSub: countObject(regexQuotaTrimmedRulesPerSub),
    budgetTrimCount: trimCount,
    subscriptionStats: countObject(statsBySub)
  };
}

/**
 * Assigns stable subscription IDs and validates every rule before a DNR commit.
 */
export function prepareSubscriptionRules(networkRules = []) {
  const prepared = networkRules.map((rule, index) => ({
    ...rule,
    id: SUBSCRIPTION_ID_START + index
  }));
  for (let index = 0; index < prepared.length; index++) {
    validateSubscriptionRule(prepared[index], index);
  }
  return prepared;
}
