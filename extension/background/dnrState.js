/**
 * DNR state and dynamic-rule synchronization.
 */

'use strict';

import { getDefaultDynamicRules } from './defaultDynamicRules.js';
import { clearHealthDiagnostic, recordHealthDiagnostic } from './diagnostics.js';

const DEBUG = false;

const STATIC_RULESETS = chrome.runtime.getManifest()
  .declarative_net_request
  .rule_resources
  .map(resource => resource.id);

// Range 1000 - 99999 reserved for local/default dynamic rules (Anti-Detection/Acceleration)
const DEFAULT_RULE_ID_START = 1000;
const DEFAULT_RULE_ID_END   = 99999;
const SUBSCRIPTION_RULE_ID_START = 100000;
const SUBSCRIPTION_RULE_ID_END = 8999999;
const WHITELIST_RULE_ID_START = 9000000;
const TRACKING_URL_CLEANUP_RULE_ID_START = 2000;
const TRACKING_URL_CLEANUP_RULE_ID_END = 2099;
const dynamicRuleClassifications = new Map();
const STATIC_RULE_ACTION_OVERRIDES = new Map([
  ['custom_static_rules:28', 'allow'],
  ['custom_static_rules:30014', 'allow'],
  ['custom_static_rules:30015', 'allow'],
  ['custom_static_rules:30027', 'allow']
]);

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
    const cached = dynamicRuleClassifications.get(ruleId);
    const actionType = cached?.actionType;
    if (actionType === 'block' || actionType === 'allow') {
      return { type: actionType, ruleSource: 'default_dynamic', ruleId, rulesetId };
    }
    return { type: 'match', ruleSource: 'default_dynamic', ruleId, rulesetId };
  }

  if (ruleId >= SUBSCRIPTION_RULE_ID_START && ruleId <= SUBSCRIPTION_RULE_ID_END) {
    return { type: 'block', ruleSource: 'subscription_dynamic', ruleId, rulesetId };
  }

  return { type: 'match', ruleSource: 'unknown', ruleId, rulesetId };
}

export async function updateDNRState(isEnabled) {
  try {
    if (isEnabled) {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: STATIC_RULESETS });
      await syncDynamicRules();
      await syncWhitelistRules();
    } else {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: STATIC_RULESETS });
      const existing = await chrome.declarativeNetRequest.getDynamicRules();
      const removeIds = existing.map(r => r.id);
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds });
    }
    await clearHealthDiagnostic('dnrState');
  } catch (err) {
    await recordHealthDiagnostic('dnrState', {
      area: 'dnr',
      severity: 'error',
      message: 'Core DNR state could not be synchronized.',
      action: 'Reload the extension, then turn Network Blocking off and on.',
      error: err?.message || err
    });
    if (DEBUG) console.error('[Chroma Ad-Blocker] Error updating DNR state:', err);
  }
}

/**
 * Dynamic rules let us update blocking patterns WITHOUT a Chrome Web Store
 * review cycle - critical because YouTube changes ad delivery domains rapidly.
 * Up to 30,000 "safe" dynamic rules (block/allow) are supported.
 */
export async function syncDynamicRules() {
  try {
    const { config } = await chrome.storage.local.get('config');
    const isAccelerationEnabled = config?.acceleration !== false;
    const isTrackingUrlCleanupEnabled = config?.trackingUrlCleanup !== false;
    const { whitelist = [] } = await chrome.storage.local.get('whitelist');
    const trackingUrlCleanupOptions = {
      trackingUrlCleanup: isTrackingUrlCleanupEnabled,
      trackingUrlCleanupExcludedRequestDomains: whitelist
    };

    const stored = await chrome.storage.local.get('dynamicRules');
    let rules = stored.dynamicRules || getDefaultDynamicRules(trackingUrlCleanupOptions);

    const isTrackingCleanupRule = rule =>
      rule?.id >= TRACKING_URL_CLEANUP_RULE_ID_START &&
      rule?.id <= TRACKING_URL_CLEANUP_RULE_ID_END;
    rules = rules.filter(rule => !isTrackingCleanupRule(rule));
    if (isTrackingUrlCleanupEnabled) {
      const trackingCleanupRules = getDefaultDynamicRules({
        ...trackingUrlCleanupOptions,
        trackingUrlCleanup: true
      })
        .filter(isTrackingCleanupRule);
      rules = [...rules, ...trackingCleanupRules];
    }

    if (!isAccelerationEnabled) {
      // Reverse logic: Change YouTube anti-detection 'allow' rules to 'block'
      // when Acceleration is disabled, so ads are blocked by dynamic rules.
      // Non-allow rules, such as URL cleanup redirects, must stay intact.
      rules = rules.map(r => ({
        ...r,
        action: r.action?.type === 'allow' ? { ...r.action, type: 'block' } : r.action
      }));
    }

    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existing
      .filter(r => r.id >= DEFAULT_RULE_ID_START && r.id <= DEFAULT_RULE_ID_END)
      .map(r => r.id);

    let appliedRules = rules;
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: removeIds,
        addRules: appliedRules,
      });
    } catch (err) {
      if (!rules.some(isTrackingCleanupRule)) throw err;
      appliedRules = rules.filter(rule => !isTrackingCleanupRule(rule));
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: removeIds,
        addRules: appliedRules,
      });
      await recordHealthDiagnostic('trackingUrlCleanupSync', {
        area: 'trackingUrlCleanup',
        severity: 'warning',
        message: 'Tracking URL Cleanup could not register its DNR redirect rule.',
        action: 'Reload the extension, or turn Tracking URL Cleanup off and on.',
        error: err?.message || err
      });
      if (DEBUG) console.warn('[Chroma Ad-Blocker] Tracking URL cleanup rule was not accepted by Chrome DNR:', err);
    }

    for (const id of removeIds) dynamicRuleClassifications.delete(id);
    for (const rule of appliedRules) {
      dynamicRuleClassifications.set(rule.id, {
        actionType: rule.action?.type || 'unknown',
        ruleSource: 'default_dynamic'
      });
    }

    await clearHealthDiagnostic('dnrDynamicRules');
    if (appliedRules.some(isTrackingCleanupRule) || !isTrackingUrlCleanupEnabled) {
      await clearHealthDiagnostic('trackingUrlCleanupSync');
    }
    if (DEBUG) console.log(`[Chroma Ad-Blocker] Synced ${appliedRules.length} dynamic rules (${isAccelerationEnabled ? 'ALLOW' : 'BLOCK'}).`);
  } catch (err) {
    await recordHealthDiagnostic('dnrDynamicRules', {
      area: 'dnr',
      severity: 'error',
      message: 'Dynamic DNR rules could not be synchronized.',
      action: 'Reload the extension, then turn Network Blocking off and on.',
      error: err?.message || err
    });
    if (DEBUG) console.error('[Chroma Ad-Blocker] Dynamic rule sync failed:', err);
  }
}

/**
 * Syncs high-priority "allow" rules for whitelisted domains.
 * This ensures the extension is completely disabled on those sites even
 * if global blocking rules would otherwise match.
 */
export async function syncWhitelistRules() {
  try {
    const { whitelist = [] } = await chrome.storage.local.get('whitelist');

    const WHITELIST_START_ID = 9000000; // High ID range to avoid collisions with default dynamic rules (1000-99999) and subscription rules

    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existing.filter(r => r.id >= WHITELIST_START_ID).map(r => r.id);

    const addRules = whitelist.map((domain, index) => ({
      id: WHITELIST_START_ID + index,
      priority: 999999, // Highest priority to unconditionally override all other DNR rules
      action: { type: 'allow' },
      condition: {
        initiatorDomains: [domain],
        resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other']
      }
    }));

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removeIds,
      addRules: addRules,
    });

    for (const id of removeIds) dynamicRuleClassifications.delete(id);
    for (const rule of addRules) {
      dynamicRuleClassifications.set(rule.id, {
        actionType: 'allow',
        ruleSource: 'whitelist'
      });
    }

    await clearHealthDiagnostic('whitelistSync');
    if (DEBUG) console.log(`[Chroma Ad-Blocker] Synced ${whitelist.length} whitelist domains to DNR.`);
  } catch (err) {
    await recordHealthDiagnostic('whitelistSync', {
      area: 'whitelist',
      severity: 'warning',
      message: 'Whitelist allow rules could not be synchronized to DNR.',
      action: 'Reload the extension, or remove and re-add the affected whitelist entry.',
      error: err?.message || err
    });
    if (DEBUG) console.error('[Chroma Ad-Blocker] Whitelist sync failed:', err);
  }
}
