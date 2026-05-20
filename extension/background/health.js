/**
 * Chroma health diagnostics.
 *
 * This module intentionally returns counts and coarse statuses only. It must
 * never expose request URLs, proxy credentials, stored auth data, or raw rules.
 */

'use strict';

import {
  getWebRtcLeakProtectionStatus,
  syncWebRtcLeakProtection
} from './webrtc.js';
import {
  getBrowserPrivacyHardeningStatus,
  getGeolocationProtectionStatus,
  syncBrowserPrivacyHardening,
  syncGeolocationProtection
} from './browserPrivacy.js';
import { syncUserScripts } from '../scriptlets/engine.js';

const DEFAULT_RULE_ID_START = 1000;
const DEFAULT_RULE_ID_END = 99999;
const TRACKING_URL_CLEANUP_RULE_ID_START = 2000;
const TRACKING_URL_CLEANUP_RULE_ID_END = 2099;
const SUBSCRIPTION_RULE_ID_START = 100000;
const SUBSCRIPTION_RULE_ID_END = 8999999;
const WHITELIST_RULE_ID_START = 9000000;
const REQUEST_LOG_MAX_ENTRIES = 500;
const FPR_CONTENT_SCRIPT_ID = 'chroma_fpr';
const FPR_PROTECTED_SURFACES = [
  'Canvas',
  'WebGL',
  'Audio',
  'Navigator',
  'Language APIs'
];
const USER_SCRIPTS_ACTION = 'Open Chrome extension details and enable Allow User Scripts.';

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
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, '[host]')
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

function hasUserScriptsApi() {
  return !!(
    chrome.userScripts &&
    typeof chrome.userScripts.getScripts === 'function' &&
    typeof chrome.userScripts.register === 'function' &&
    typeof chrome.userScripts.unregister === 'function'
  );
}

function isActiveProxy(pc) {
  return pc?.accepted === true && pc.enabled !== false;
}

function summarizeWebRtcStatus(status, config) {
  const mode = typeof config?.webRtcLeakProtection === 'string'
    ? config.webRtcLeakProtection
    : 'auto';

  return {
    available: status?.available === true,
    mode,
    value: status?.value ?? null,
    levelOfControl: status?.levelOfControl ?? null,
    controllable: status?.controllable === true,
    protected: status?.protected === true,
    partial: status?.partial === true,
    recommended: config?.globalProxyEnabled === true,
    error: status?.error || null
  };
}

function countEnabledProxyDomains(proxyConfigs) {
  let count = 0;
  for (const pc of asArray(proxyConfigs)) {
    if (!isConfiguredProxy(pc) || !isActiveProxy(pc)) continue;
    count += asArray(pc.domains).filter(domain => domain?.enabled !== false).length;
  }
  return count;
}

function makeIssue(severity, area, message, action = null) {
  return { severity, area, message, action };
}

function normalizeHealthDiagnostics(raw) {
  const entries = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? Object.entries(raw)
    : [];
  return entries
    .map(([id, entry]) => ({
      id: sanitizeText(id, 80),
      area: sanitizeText(entry?.area || 'system', 40) || 'system',
      severity: ['info', 'warning', 'error'].includes(entry?.severity) ? entry.severity : 'warning',
      message: sanitizeText(entry?.message || 'Background health diagnostic recorded.'),
      action: entry?.action ? sanitizeText(entry.action, 220) : null,
      error: entry?.error ? sanitizeText(entry.error) : null,
      ts: Number.isSafeInteger(entry?.ts) ? entry.ts : null
    }))
    .filter(entry => entry.message)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
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
  const apiAvailable = hasUserScriptsApi();
  const status = {
    apiAvailable,
    registeredUserScriptCount: null,
    registrationStatus: apiAvailable ? 'empty' : 'unavailable',
    error: null
  };

  if (!apiAvailable) return status;

  try {
    const registered = await chrome.userScripts.getScripts();
    status.registeredUserScriptCount = asArray(registered).length;
    status.registrationStatus = storedRuleCount > 0
      ? (status.registeredUserScriptCount > 0 ? 'active' : 'empty')
      : 'empty';
  } catch (err) {
    status.apiAvailable = false;
    status.registrationStatus = 'unavailable';
    status.error = sanitizeText(err?.message || err);
  }

  return status;
}

function shouldRetryScriptletRegistration(scriptlets, storedRuleCount) {
  return (
    storedRuleCount > 0 &&
    scriptlets?.apiAvailable === true &&
    scriptlets?.registeredUserScriptCount === 0
  );
}

async function getFprStatus(fprEnabled) {
  const status = {
    enabled: fprEnabled,
    registered: null,
    active: false,
    registrationStatus: fprEnabled ? 'unknown' : 'disabled',
    protectedSurfaces: FPR_PROTECTED_SURFACES,
    error: null
  };

  if (!fprEnabled) return status;

  try {
    if (typeof chrome.scripting?.getRegisteredContentScripts !== 'function') {
      status.registrationStatus = 'unavailable';
      return status;
    }
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [FPR_CONTENT_SCRIPT_ID] });
    status.registered = asArray(registered).some(script => script?.id === FPR_CONTENT_SCRIPT_ID);
    status.active = status.registered === true;
    status.registrationStatus = status.active ? 'active' : 'missing';
  } catch (err) {
    status.registered = null;
    status.registrationStatus = 'unavailable';
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
  trackingUrlCleanupEnabled,
  trackingUrlCleanupRuleCount,
  storedScriptletRuleCount,
  scriptlets,
  subscriptionErrors,
  debugLoggingAvailable,
  webrtc,
  globalProxyEnabled,
  globalProxyConfigured,
  fpr,
  browserPrivacy,
  geolocation,
  diagnostics
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
      USER_SCRIPTS_ACTION
    ));
  } else if (shouldRetryScriptletRegistration(scriptlets, storedScriptletRuleCount)) {
    issues.push(makeIssue(
      'warning',
      'scriptlets',
      'Scriptlet rules are parsed but not registered.',
      'Open Chroma settings or reload the extension to retry scriptlet registration.'
    ));
  }

  if (
    masterEnabled &&
    networkBlocking &&
    trackingUrlCleanupEnabled &&
    trackingUrlCleanupRuleCount === 0
  ) {
    issues.push(makeIssue(
      'warning',
      'trackingUrlCleanup',
      'Tracking URL Cleanup is enabled but its DNR redirect rule is not registered.',
      'Reload the extension, or turn Tracking URL Cleanup off and on.'
    ));
  }

  if (subscriptionErrors.length > 0) {
    issues.push(makeIssue('warning', 'subscriptions', `${subscriptionErrors.length} subscription list(s) have refresh errors.`, 'Refresh the affected lists or disable broken lists.'));
  }

  if (globalProxyEnabled && !webrtc?.available) {
    issues.push(makeIssue('warning', 'webrtc', 'WebRTC leak protection could not inspect Chrome privacy settings.', 'Check browser support for Chrome privacy settings.'));
  } else if (globalProxyEnabled && webrtc?.levelOfControl && !webrtc.controllable) {
    issues.push(makeIssue(
      'warning',
      'webrtc',
      'WebRTC leak protection is controlled by another extension or browser policy.',
      'Disable the conflicting extension or browser policy if you want Chroma to control WebRTC leak protection.'
    ));
  } else if (globalProxyEnabled && globalProxyConfigured && !webrtc?.protected) {
    issues.push(makeIssue(
      'warning',
      'webrtc',
      'Global proxy is enabled, but WebRTC leak protection is not fully active.',
      'Set WebRTC Leak Protection to Auto or Strict.'
    ));
  }

  if (browserPrivacy?.enabled && !browserPrivacy.available) {
    issues.push(makeIssue(
      'warning',
      'browserPrivacy',
      'Browser privacy hardening could not inspect every Chrome privacy setting.',
      'Check browser support for Chrome privacy settings.'
    ));
  } else if (browserPrivacy?.enabled && browserPrivacy.blockedCount > 0) {
    issues.push(makeIssue(
      'warning',
      'browserPrivacy',
      'Browser privacy hardening is partially controlled by another extension or browser policy.',
      'Disable the conflicting extension or browser policy if you want Chroma to control these settings.'
    ));
  } else if (browserPrivacy?.enabled && !browserPrivacy.active) {
    issues.push(makeIssue(
      'warning',
      'browserPrivacy',
      'Browser privacy hardening is not fully active.',
      'Turn Chrome Privacy Hardening off and on, or reload the extension.'
    ));
  }

  if (geolocation?.enabled && !geolocation.available) {
    issues.push(makeIssue(
      'warning',
      'geolocation',
      'Geolocation protection could not inspect Chrome location settings.',
      'Check browser support for Chrome content settings.'
    ));
  } else if (geolocation?.enabled && !geolocation.active) {
    issues.push(makeIssue(
      'warning',
      'geolocation',
      'Geolocation protection is enabled but Chrome location access is not blocked.',
      'Turn Geolocation Protection off and on, or reload the extension.'
    ));
  }

  if (fpr?.enabled && fpr.active !== true) {
    issues.push(makeIssue(
      'warning',
      'fingerprint',
      'Fingerprint Randomization is enabled but its MAIN-world script is not registered.',
      'Turn Fingerprint Randomization off and on, or reload the extension.'
    ));
  }

  for (const diagnostic of diagnostics) {
    issues.push(makeIssue(
      diagnostic.severity,
      diagnostic.area,
      diagnostic.message,
      diagnostic.action
    ));
  }

  if (!masterEnabled || !networkBlocking) {
    return { status: 'disabled', issues };
  }
  if (!dnrAvailable || dnrError || !staticRulesetsOk || diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
    return { status: 'error', issues };
  }
  if (
    (!scriptlets.apiAvailable && storedScriptletRuleCount > 0) ||
    subscriptionErrors.length > 0 ||
    diagnostics.some(diagnostic => diagnostic.severity === 'warning') ||
    issues.some(issue => issue.severity === 'warning')
  ) {
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
    'appliedNetworkRuleCount',
    'healthDiagnostics'
  ]);

  const config = storage.config || {};
  const masterEnabled = config.enabled !== false;
  const networkBlocking = config.networkBlocking !== false;
  const expectedStaticRulesets = getExpectedStaticRulesets(manifestData);
  const dnrSnapshot = await getDnrSnapshot(masterEnabled, networkBlocking, expectedStaticRulesets);
  const dynamicRules = asArray(dnrSnapshot.dynamicRules);
  const defaultDynamicRuleCount = countByRange(dynamicRules, DEFAULT_RULE_ID_START, DEFAULT_RULE_ID_END);
  const trackingUrlCleanupRuleCount = countByRange(
    dynamicRules,
    TRACKING_URL_CLEANUP_RULE_ID_START,
    TRACKING_URL_CLEANUP_RULE_ID_END
  );
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
  const activeProxies = configuredProxies.filter(isActiveProxy);
  const globalProxyId = config.globalProxyId;
  const globalProxyConfigured = globalProxyId != null && activeProxies.some(pc => pc.id === globalProxyId);
  let scriptlets = await getScriptletStatus(subscriptionScriptletRules.length);
  if (shouldRetryScriptletRegistration(scriptlets, subscriptionScriptletRules.length)) {
    await syncUserScripts();
    scriptlets = await getScriptletStatus(subscriptionScriptletRules.length);
  }
  const fpr = await getFprStatus(masterEnabled && config.fingerprintRandomization === true);
  const diagnostics = normalizeHealthDiagnostics(storage.healthDiagnostics);
  const requestLogAvailable = !!chrome.declarativeNetRequest?.onRuleMatchedDebug;
  await syncWebRtcLeakProtection(config, proxyConfigs);
  await syncBrowserPrivacyHardening(config);
  await syncGeolocationProtection(config);
  const webrtc = summarizeWebRtcStatus(
    await getWebRtcLeakProtectionStatus(config, proxyConfigs),
    config
  );
  const browserPrivacy = await getBrowserPrivacyHardeningStatus(config);
  const geolocation = await getGeolocationProtectionStatus(config);

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
      fingerprintRandomization: bool(config.fingerprintRandomization, false),
      browserPrivacyHardening: bool(config.browserPrivacyHardening, false),
      geolocationProtection: bool(config.geolocationProtection, false),
      trackingUrlCleanup: config.trackingUrlCleanup !== false,
      deAmpLinks: bool(config.deAmpLinks, false)
    },
    dnr: {
      available: !!chrome.declarativeNetRequest,
      enabledStaticRulesets: asArray(dnrSnapshot.enabledStaticRulesets),
      expectedStaticRulesets,
      staticRulesetsOk: !!dnrSnapshot.staticRulesetsOk,
      dynamicRuleCount: dynamicRules.length,
      defaultDynamicRuleCount,
      trackingUrlCleanupRuleCount,
      trackingUrlCleanupActive: masterEnabled && networkBlocking && config.trackingUrlCleanup !== false && trackingUrlCleanupRuleCount > 0,
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
    webrtc,
    browserPrivacy,
    geolocation,
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
    diagnostics,
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
    trackingUrlCleanupEnabled: health.master.trackingUrlCleanup,
    trackingUrlCleanupRuleCount: health.dnr.trackingUrlCleanupRuleCount,
    storedScriptletRuleCount: health.scriptlets.storedRuleCount,
    scriptlets: health.scriptlets,
    subscriptionErrors,
    debugLoggingAvailable: requestLogAvailable,
    webrtc,
    globalProxyEnabled: health.proxy.globalProxyEnabled,
    globalProxyConfigured,
    fpr,
    browserPrivacy,
    geolocation,
    diagnostics
  });

  return health;
}
