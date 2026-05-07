/**
 * Chroma health diagnostics.
 *
 * This module intentionally returns counts and coarse statuses only. It must
 * never expose request URLs, proxy credentials, stored auth data, or raw rules.
 */

'use strict';

const DEFAULT_RULE_ID_START = 1000;
const DEFAULT_RULE_ID_END = 99999;
const SUBSCRIPTION_RULE_ID_START = 100000;
const SUBSCRIPTION_RULE_ID_END = 8999999;
const WHITELIST_RULE_ID_START = 9000000;
const REQUEST_LOG_MAX_ENTRIES = 500;
const FPR_CONTENT_SCRIPT_ID = 'chroma_fpr';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function bool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function countByRange(rules, start, end = Number.MAX_SAFE_INTEGER) {
  return asArray(rules).filter(rule =>
    Number.isInteger(rule?.id) &&
    rule.id >= start &&
    rule.id <= end
  ).length;
}

function sanitizeText(value, maxLength = 160) {
  return String(value ?? '')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[^\S\r\n]+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function sumRuleCount(subscriptions, key) {
  return asArray(subscriptions).reduce((sum, sub) => sum + (Number(sub?.ruleCount?.[key]) || 0), 0);
}

function getTotalRuleCount(sub) {
  return (
    (Number(sub?.ruleCount?.network) || 0) +
    (Number(sub?.ruleCount?.cosmetic) || 0) +
    (Number(sub?.ruleCount?.scriptlet) || 0)
  );
}

function isVisibleSubscription(sub) {
  return sub?.id !== 'chroma-hotfix' || getTotalRuleCount(sub) > 0;
}

function getLastUpdatedBounds(subscriptions) {
  const updated = asArray(subscriptions)
    .map(sub => Number(sub?.lastUpdated) || 0)
    .filter(ts => ts > 0);

  return {
    newest: updated.length > 0 ? Math.max(...updated) : null,
    oldest: updated.length > 0 ? Math.min(...updated) : null
  };
}

function isConfiguredProxy(pc) {
  const port = Number(pc?.port);
  return !!(
    pc &&
    typeof pc.host === 'string' &&
    pc.host.trim() &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535
  );
}

function countEnabledProxyDomains(proxyConfigs) {
  let count = 0;
  for (const pc of asArray(proxyConfigs)) {
    if (!isConfiguredProxy(pc) || pc.accepted !== true) continue;
    count += asArray(pc.domains).filter(domain => domain?.enabled !== false).length;
  }
  return count;
}

function makeIssue(severity, area, message, action = null) {
  return { severity, area, message, action };
}

function getExpectedStaticRulesets(manifest) {
  return asArray(manifest?.declarative_net_request?.rule_resources)
    .map(resource => resource?.id)
    .filter(id => typeof id === 'string' && id.length > 0);
}

async function getDnrSnapshot(masterEnabled, networkBlocking, expectedStaticRulesets) {
  const dnrApi = chrome.declarativeNetRequest;
  const available = !!dnrApi;
  const snapshot = {
    available,
    enabledStaticRulesets: [],
    dynamicRules: [],
    error: null
  };

  if (!available) {
    snapshot.error = 'DNR API unavailable';
    return snapshot;
  }

  try {
    snapshot.enabledStaticRulesets = typeof dnrApi.getEnabledRulesets === 'function'
      ? await dnrApi.getEnabledRulesets()
      : [];
    snapshot.dynamicRules = typeof dnrApi.getDynamicRules === 'function'
      ? await dnrApi.getDynamicRules()
      : [];
  } catch (err) {
    snapshot.error = sanitizeText(err?.message || err);
  }

  snapshot.staticRulesetsOk = (
    masterEnabled &&
    networkBlocking &&
    snapshot.error === null &&
    expectedStaticRulesets.every(id => snapshot.enabledStaticRulesets.includes(id))
  );

  return snapshot;
}

async function getScriptletStatus(storedRuleCount) {
  const apiAvailable = !!chrome.userScripts?.register;
  const status = {
    apiAvailable,
    registeredUserScriptCount: null,
    registrationStatus: apiAvailable ? 'empty' : 'unavailable',
    error: null
  };

  if (!apiAvailable) return status;

  try {
    const registered = typeof chrome.userScripts.getScripts === 'function'
      ? await chrome.userScripts.getScripts()
      : [];
    status.registeredUserScriptCount = asArray(registered).length;
    status.registrationStatus = storedRuleCount > 0
      ? (status.registeredUserScriptCount > 0 ? 'active' : 'empty')
      : 'empty';
  } catch (err) {
    status.registrationStatus = 'error';
    status.error = sanitizeText(err?.message || err);
  }

  return status;
}

async function getFprStatus(fprEnabled) {
  const status = {
    enabled: fprEnabled,
    registered: null,
    error: null
  };

  if (!fprEnabled) return status;

  try {
    const registered = typeof chrome.scripting?.getRegisteredContentScripts === 'function'
      ? await chrome.scripting.getRegisteredContentScripts({ ids: [FPR_CONTENT_SCRIPT_ID] })
      : [];
    status.registered = asArray(registered).some(script => script?.id === FPR_CONTENT_SCRIPT_ID);
  } catch (err) {
    status.registered = null;
    status.error = sanitizeText(err?.message || err);
  }

  return status;
}

function computeOverall({
  masterEnabled,
  networkBlocking,
  dnrError,
  dnrAvailable,
  staticRulesetsOk,
  expectedStaticRulesets,
  enabledStaticRulesets,
  storedScriptletRuleCount,
  scriptlets,
  subscriptionErrors,
  debugLoggingAvailable
}) {
  const issues = [];

  if (!masterEnabled) {
    issues.push(makeIssue('info', 'master', 'Chroma protection is disabled.', 'Turn on the main protection switch to re-enable layers.'));
  }

  if (masterEnabled && !networkBlocking) {
    issues.push(makeIssue('info', 'dnr', 'Network blocking is disabled.', 'Turn on Network Blocking to enable DNR request filtering.'));
  }

  if (!debugLoggingAvailable) {
    issues.push(makeIssue(
      'info',
      'requestLog',
      'DNR match logging is unavailable in this install context; blocking can still work.',
      null
    ));
  }

  if (masterEnabled && networkBlocking && (!dnrAvailable || dnrError)) {
    issues.push(makeIssue('error', 'dnr', 'Core DNR diagnostics failed.', 'Reload the extension and check browser support.'));
  }

  if (masterEnabled && networkBlocking && !dnrError && dnrAvailable && !staticRulesetsOk) {
    const enabledCount = asArray(enabledStaticRulesets).length;
    issues.push(makeIssue(
      'error',
      'dnr',
      `Static rulesets enabled: ${enabledCount} / ${expectedStaticRulesets.length}.`,
      'Turn Network Blocking off and on, or reload the extension.'
    ));
  }

  if (!scriptlets.apiAvailable && storedScriptletRuleCount > 0) {
    issues.push(makeIssue(
      'warning',
      'scriptlets',
      'Scriptlet engine unavailable. Enable Allow User Scripts for this extension in Chrome extension details.',
      'Open Chrome extension details and enable Allow User Scripts.'
    ));
  } else if (scriptlets.registrationStatus === 'error') {
    issues.push(makeIssue('warning', 'scriptlets', 'Scriptlet registration could not be inspected.', 'Reload the extension and check User Scripts access.'));
  }

  if (subscriptionErrors.length > 0) {
    issues.push(makeIssue('warning', 'subscriptions', `${subscriptionErrors.length} subscription list(s) have refresh errors.`, 'Refresh the affected lists or disable broken lists.'));
  }

  if (!masterEnabled || !networkBlocking) {
    return { status: 'disabled', issues };
  }
  if (!dnrAvailable || dnrError || !staticRulesetsOk) {
    return { status: 'error', issues };
  }
  if ((!scriptlets.apiAvailable && storedScriptletRuleCount > 0) || subscriptionErrors.length > 0 || scriptlets.registrationStatus === 'error') {
    return { status: 'degraded', issues };
  }
  return { status: 'healthy', issues };
}

export async function getHealthStatus() {
  const manifestData = chrome.runtime.getManifest();
  const storage = await chrome.storage.local.get([
    'config',
    'subscriptions',
    'subscriptionCosmeticRules',
    'localCosmeticRules',
    'subscriptionScriptletRules',
    'proxyConfigs',
    'whitelist',
    'fprWhitelist',
    'statsV2',
    'requestLog',
    'appliedNetworkRuleCount'
  ]);

  const config = storage.config || {};
  const masterEnabled = config.enabled !== false;
  const networkBlocking = config.networkBlocking !== false;
  const expectedStaticRulesets = getExpectedStaticRulesets(manifestData);
  const dnrSnapshot = await getDnrSnapshot(masterEnabled, networkBlocking, expectedStaticRulesets);
  const dynamicRules = asArray(dnrSnapshot.dynamicRules);
  const defaultDynamicRuleCount = countByRange(dynamicRules, DEFAULT_RULE_ID_START, DEFAULT_RULE_ID_END);
  const subscriptionDynamicRuleCount = countByRange(dynamicRules, SUBSCRIPTION_RULE_ID_START, SUBSCRIPTION_RULE_ID_END);
  const whitelistRuleCount = countByRange(dynamicRules, WHITELIST_RULE_ID_START);

  const subscriptions = asArray(storage.subscriptions).filter(isVisibleSubscription);
  const subscriptionErrors = subscriptions
    .filter(sub => sub?.lastError)
    .map(sub => ({
      id: sanitizeText(sub.id, 80),
      name: sanitizeText(sub.name, 120),
      error: sanitizeText(sub.lastError)
    }));
  const lastUpdated = getLastUpdatedBounds(subscriptions);
  const subscriptionScriptletRules = asArray(storage.subscriptionScriptletRules);
  const localCosmeticRules = asArray(storage.localCosmeticRules);
  const proxyConfigs = asArray(storage.proxyConfigs);
  const configuredProxies = proxyConfigs.filter(isConfiguredProxy);
  const acceptedProxies = configuredProxies.filter(pc => pc.accepted === true);
  const globalProxyId = config.globalProxyId;
  const globalProxyConfigured = globalProxyId != null && acceptedProxies.some(pc => pc.id === globalProxyId);
  const scriptlets = await getScriptletStatus(subscriptionScriptletRules.length);
  const fpr = await getFprStatus(masterEnabled && config.fingerprintRandomization === true);
  const requestLogAvailable = !!chrome.declarativeNetRequest?.onRuleMatchedDebug;

  const health = {
    generatedAt: Date.now(),
    manifest: {
      version: manifestData.version || null,
      minimumChromeVersion: manifestData.minimum_chrome_version || null
    },
    master: {
      enabled: masterEnabled,
      networkBlocking,
      cosmetic: config.cosmetic !== false,
      stripping: config.stripping !== false,
      acceleration: bool(config.acceleration, false),
      fingerprintRandomization: bool(config.fingerprintRandomization, false)
    },
    dnr: {
      available: !!chrome.declarativeNetRequest,
      enabledStaticRulesets: asArray(dnrSnapshot.enabledStaticRulesets),
      expectedStaticRulesets,
      staticRulesetsOk: !!dnrSnapshot.staticRulesetsOk,
      dynamicRuleCount: dynamicRules.length,
      defaultDynamicRuleCount,
      subscriptionDynamicRuleCount,
      whitelistRuleCount,
      appliedNetworkRuleCount: defaultDynamicRuleCount + subscriptionDynamicRuleCount + whitelistRuleCount,
      debugLoggingAvailable: requestLogAvailable,
      statsProtectionEvents: Number(storage.statsV2?.totals?.protectionEvents) || 0,
      statsNetworkBlocks: Number(storage.statsV2?.totals?.networkBlocks) || 0
    },
    subscriptions: {
      total: subscriptions.length,
      enabled: subscriptions.filter(sub => sub?.enabled !== false).length,
      disabled: subscriptions.filter(sub => sub?.enabled === false).length,
      cosmeticOnly: subscriptions.filter(sub => sub?.cosmeticOnly === true).length,
      withErrors: subscriptionErrors.length,
      parsedNetwork: sumRuleCount(subscriptions, 'network'),
      appliedNetwork: Number(storage.appliedNetworkRuleCount) || subscriptionDynamicRuleCount,
      cosmetic: sumRuleCount(subscriptions, 'cosmetic'),
      scriptlet: sumRuleCount(subscriptions, 'scriptlet'),
      lastUpdatedNewest: lastUpdated.newest,
      lastUpdatedOldest: lastUpdated.oldest,
      errors: subscriptionErrors
    },
    cosmetic: {
      subscriptionCosmeticRuleCount: asArray(storage.subscriptionCosmeticRules).length,
      localZapperRuleCount: localCosmeticRules.length,
      enabledLocalZapperRuleCount: localCosmeticRules.filter(rule => rule?.enabled !== false).length
    },
    scriptlets: {
      apiAvailable: scriptlets.apiAvailable,
      storedRuleCount: subscriptionScriptletRules.length,
      registeredUserScriptCount: scriptlets.registeredUserScriptCount,
      registrationStatus: scriptlets.registrationStatus,
      error: scriptlets.error
    },
    fpr,
    proxy: {
      configuredCount: configuredProxies.length,
      acceptedCount: acceptedProxies.length,
      routedDomainCount: countEnabledProxyDomains(proxyConfigs),
      globalProxyEnabled: config.globalProxyEnabled === true,
      globalProxyConfigured
    },
    whitelist: {
      domainCount: asArray(storage.whitelist).length,
      fprDomainCount: asArray(storage.fprWhitelist).length
    },
    requestLog: {
      available: requestLogAvailable,
      entryCount: asArray(storage.requestLog).length,
      maxEntries: REQUEST_LOG_MAX_ENTRIES,
      note: requestLogAvailable
        ? 'Debug match logging is available in this install context.'
        : 'DNR match logging is unavailable in this install context; blocking can still work.'
    },
    overall: null
  };

  health.overall = computeOverall({
    masterEnabled,
    networkBlocking,
    dnrError: dnrSnapshot.error,
    dnrAvailable: health.dnr.available,
    staticRulesetsOk: health.dnr.staticRulesetsOk,
    expectedStaticRulesets,
    enabledStaticRulesets: health.dnr.enabledStaticRulesets,
    storedScriptletRuleCount: health.scriptlets.storedRuleCount,
    scriptlets: health.scriptlets,
    subscriptionErrors,
    debugLoggingAvailable: requestLogAvailable
  });

  return health;
}
