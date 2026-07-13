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
    if (byteLength(condition.urlFilter) > MAX_FILTER_BYTES) {
      throw new Error(`${label}.condition.urlFilter exceeds ${MAX_FILTER_BYTES} bytes`);
    }
  }
  if (hasRegexFilter) {
    if (typeof condition.regexFilter !== 'string' || condition.regexFilter.length === 0) {
      throw new Error(`${label}.condition.regexFilter must be a non-empty string`);
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

/**
 * Combines cached rules for enabled subscriptions and applies the deterministic
 * subscription budget. Stored subscription order and per-list order are kept.
 */
export function buildSubscriptionRuleApplication(subscriptions = [], perSubRules = {}) {
  const allRules = [];
  for (const sub of subscriptions) {
    if (sub?.cosmeticOnly || !sub?.enabled || !Array.isArray(perSubRules[sub?.id])) continue;
    for (const rule of perSubRules[sub.id]) {
      if (isSafeCachedRule(rule)) {
        allRules.push({ ...rule, _subId: sub.id });
      }
    }
  }

  const { allocated, trimCount } = allocate(allRules);
  if (DEBUG && trimCount > 0) {
    console.warn(`[Chroma Subscriptions] Budget trim: dropped ${trimCount} rules.`);
  }

  const appliedNetworkRulesPerSub = {};
  const networkRules = allocated.map(({ _subId, ...rule }) => {
    if (_subId) {
      appliedNetworkRulesPerSub[_subId] = (appliedNetworkRulesPerSub[_subId] || 0) + 1;
    }
    return rule;
  });

  return {
    networkRules,
    appliedNetworkRuleCount: networkRules.length,
    appliedNetworkRulesPerSub
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
