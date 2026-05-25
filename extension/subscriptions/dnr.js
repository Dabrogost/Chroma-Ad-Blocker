/**
 * Chroma Ad-Blocker — Subscription DNR Application Layer
 * Manages the subscription ID range within chrome.declarativeNetRequest.
 * Full rebuild strategy: remove all subscription IDs, apply new set atomically.
 */

'use strict';

import { SUBSCRIPTION_ID_START, SUBSCRIPTION_ID_END } from './budget.js';

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

function validateStringArray(values, label, { allowEmpty = false, valueSet = null } = {}) {
  if (values === undefined) return;
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    throw new Error(`${label} must be a non-empty array`);
  }
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${label} entries must be non-empty strings`);
    }
    if (valueSet && !valueSet.has(value)) {
      throw new Error(`${label} contains unsupported value: ${value}`);
    }
  }
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
  validateStringArray(condition.initiatorDomains, `${label}.condition.initiatorDomains`);
  validateStringArray(condition.excludedInitiatorDomains, `${label}.condition.excludedInitiatorDomains`);
}

function validateSubscriptionRules(rules) {
  for (let index = 0; index < rules.length; index++) {
    validateSubscriptionRule(rules[index], index);
  }
}

/**
 * Assigns sequential IDs to rules starting from SUBSCRIPTION_ID_START.
 * @param {Object[]} rules - Rules without IDs
 * @returns {Object[]}
 */
function assignIds(rules) {
  return rules.map((rule, i) => ({ ...rule, id: SUBSCRIPTION_ID_START + i }));
}

/**
 * Applies subscription network rules to DNR via full rebuild.
 * Removes all existing IDs in subscription range, then applies new set in one call.
 * @param {Object[]} networkRules - Parsed rule objects without IDs
 * @returns {Promise<void>}
 */
export async function applySubscriptionRules(networkRules) {
  try {
    const existing  = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existing
      .filter(r => r.id >= SUBSCRIPTION_ID_START && r.id <= SUBSCRIPTION_ID_END)
      .map(r => r.id);

    const rulesToAdd = assignIds(networkRules);
    validateSubscriptionRules(rulesToAdd);

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removeIds,
      addRules: rulesToAdd
    });

    if (DEBUG) console.log(`[Chroma Subscriptions] Applied ${rulesToAdd.length} network rules to DNR.`);
  } catch (err) {
    if (DEBUG) console.error('[Chroma Subscriptions] DNR apply failed:', err);
    throw err;
  }
}

/**
 * Removes all subscription rules from DNR. Called when network blocking is disabled.
 * @returns {Promise<void>}
 */
export async function clearSubscriptionRules() {
  try {
    const existing  = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existing
      .filter(r => r.id >= SUBSCRIPTION_ID_START && r.id <= SUBSCRIPTION_ID_END)
      .map(r => r.id);

    if (removeIds.length === 0) return;

    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds });

    if (DEBUG) console.log(`[Chroma Subscriptions] Cleared ${removeIds.length} subscription rules from DNR.`);
  } catch (err) {
    if (DEBUG) console.error('[Chroma Subscriptions] DNR clear failed:', err);
    throw err;
  }
}
