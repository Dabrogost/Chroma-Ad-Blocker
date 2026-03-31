/**
 * Chroma Ad-Blocker — Subscription DNR Application Layer
 * Manages the subscription ID range within chrome.declarativeNetRequest.
 * Full rebuild strategy: remove all subscription IDs, apply new set atomically.
 */

'use strict';

import { SUBSCRIPTION_ID_START, SUBSCRIPTION_ID_END } from './budget.js';

const DEBUG = false;

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
