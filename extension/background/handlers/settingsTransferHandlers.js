/**
 * Versioned settings backup export and transactional settings import.
 */

'use strict';

import {
  getSubscriptions,
  stageCustomSubscriptions,
  reconcileSubscriptionRuntimeState
} from '../../subscriptions/manager.js';
import {
  exportUserScriptletSettings,
  stageUserScriptletSettings
} from '../../scriptlets/userResources.js';
import { syncUserScripts } from '../../scriptlets/engine.js';
import { CONFIG_KEYS, validateConfig } from '../configState.js';
import { serializeConfigMutation } from '../configCoordinator.js';
import { updateDNRState } from '../dnrState.js';
import { syncProxyState } from '../proxy.js';
import { syncWebRtcLeakProtection } from '../webrtc.js';
import { syncBrowserPrivacyHardening, syncGeolocationProtection } from '../browserPrivacy.js';
import { normalizeDomain } from './domainValidation.js';
import { sanitizeDomainList } from './whitelistHandlers.js';
import { validateProxyConfigsForStorage } from './proxyHandlers.js';
import {
  isValidSubscriptionId,
  validateCustomSubscriptionInput
} from './subscriptionHandlers.js';
import { notifyConfigChanged } from './configHandlers.js';

const SETTINGS_IMPORT_VERSION = 1;
const SETTINGS_IMPORT_COMMIT_KEYS = Object.freeze([
  'config',
  'whitelist',
  'fprWhitelist',
  'proxyConfigs',
  'subscriptions',
  'sub_network_rules',
  'sub_cosmetic_rules',
  'sub_scriptlet_rules',
  'subscriptionCosmeticRules',
  'subscriptionScriptletRules',
  'userScriptletSources',
  'userScriptletResources',
  'userScriptletRuleText',
  'userScriptletRules'
]);
const SETTINGS_IMPORT_SNAPSHOT_KEYS = Object.freeze([
  ...SETTINGS_IMPORT_COMMIT_KEYS
]);

function exportProxyConfig(pc) {
  return {
    id: pc.id,
    name: pc.name,
    host: pc.host,
    port: pc.port,
    type: pc.type,
    accepted: pc.accepted,
    enabled: pc.enabled !== false,
    domains: Array.isArray(pc.domains) ? pc.domains : []
  };
}

function exportSubscription(sub) {
  return {
    id: sub.id,
    name: sub.name,
    url: sub.url,
    enabled: sub.enabled !== false,
    isCustom: sub.isCustom === true,
    intervalHours: sub.intervalHours
  };
}

function sanitizeImportedSubscription(sub) {
  const validation = validateCustomSubscriptionInput(sub);
  if (!validation.ok) return null;
  return {
    ...validation.subscription,
    enabled: sub.enabled !== false,
    isCustom: true,
    lastUpdated: 0,
    version: null,
    networkCompilerVersion: 0,
    lastError: null,
    lastErrorScope: null,
    lastErrorAt: null,
    ruleCount: { network: 0, cosmetic: 0, scriptlet: 0 },
    compatibility: { translatedRegexFilter: 0, unsupportedUrlFilter: 0 }
  };
}

function isImportObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function importErrorMessage(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error) return error;
  return 'Unknown import failure';
}

function importValidationFailure(error, step = 'backup') {
  return {
    ok: false,
    phase: 'validation',
    step,
    error,
    rollback: {
      attempted: false,
      succeeded: true,
      storageRestored: true,
      runtimeRestored: true,
      errors: []
    }
  };
}

function validateImportDomainList(value, path) {
  if (!Array.isArray(value)) {
    return { ok: false, error: `${path} must be an array` };
  }
  for (let index = 0; index < value.length; index++) {
    if (!normalizeDomain(value[index])) {
      return { ok: false, error: `${path}[${index}] is invalid` };
    }
  }
  return { ok: true, value: sanitizeDomainList(value) };
}

async function validateSettingsImportPayload(payload) {
  if (!isImportObject(payload)) {
    return importValidationFailure('Invalid settings backup');
  }
  if (payload.schema !== 'chroma-settings') {
    return importValidationFailure('Unsupported settings backup schema', 'schema');
  }
  if (!Number.isSafeInteger(payload.version) || payload.version !== SETTINGS_IMPORT_VERSION) {
    return importValidationFailure('Unsupported settings backup version', 'version');
  }
  if (!isImportObject(payload.config)) {
    return importValidationFailure('Settings backup config must be an object', 'config');
  }
  const config = validateConfig(payload.config);
  const allowedConfigKeys = new Set(CONFIG_KEYS);
  for (const key of Object.keys(payload.config)) {
    if (!allowedConfigKeys.has(key)) {
      return importValidationFailure(`Unknown config key in settings backup: ${key}`, 'config');
    }
    if (!Object.prototype.hasOwnProperty.call(config, key) || !Object.is(config[key], payload.config[key])) {
      return importValidationFailure(`Invalid config value in settings backup: ${key}`, 'config');
    }
  }

  const whitelist = validateImportDomainList(payload.whitelist, 'whitelist');
  if (!whitelist.ok) return importValidationFailure(whitelist.error, 'whitelist');
  const fprWhitelist = validateImportDomainList(payload.fprWhitelist, 'fprWhitelist');
  if (!fprWhitelist.ok) return importValidationFailure(fprWhitelist.error, 'fprWhitelist');

  if (!Array.isArray(payload.proxyConfigs)) {
    return importValidationFailure('proxyConfigs must be an array', 'proxyConfigs');
  }
  if (payload.proxyConfigs.length > 100) {
    return importValidationFailure('Proxy config limit is 100', 'proxyConfigs');
  }
  const proxyValidation = await validateProxyConfigsForStorage(
    payload.proxyConfigs.map(pc => ({ ...pc, credentialAction: 'clear' })),
    []
  );
  if (!proxyValidation.ok || proxyValidation.droppedCount > 0 || proxyValidation.errors.length > 0) {
    return importValidationFailure(
      proxyValidation.errors[0] || 'Invalid proxy configuration in settings backup',
      'proxyConfigs'
    );
  }

  if (!Array.isArray(payload.subscriptions)) {
    return importValidationFailure('subscriptions must be an array', 'subscriptions');
  }
  if (payload.subscriptions.length > 50) {
    return importValidationFailure('Subscription import limit is 50', 'subscriptions');
  }
  const subscriptions = [];
  for (let index = 0; index < payload.subscriptions.length; index++) {
    const candidate = payload.subscriptions[index];
    if (!isImportObject(candidate) || !isValidSubscriptionId(candidate.id)) {
      return importValidationFailure(`Invalid subscription at index ${index}`, 'subscriptions');
    }
    if (candidate.name !== undefined && typeof candidate.name !== 'string') {
      return importValidationFailure(`Invalid subscription name at index ${index}`, 'subscriptions');
    }
    if (candidate.enabled !== undefined && typeof candidate.enabled !== 'boolean') {
      return importValidationFailure(`Invalid subscription enabled state at index ${index}`, 'subscriptions');
    }
    const sanitized = sanitizeImportedSubscription(candidate);
    if (!sanitized) {
      return importValidationFailure(`Invalid subscription at index ${index}`, 'subscriptions');
    }
    subscriptions.push(sanitized);
  }

  const userScriptlets = stageUserScriptletSettings(payload.userScriptlets, { importedAt: Date.now() });
  if (!userScriptlets.ok) {
    return importValidationFailure(userScriptlets.error || 'Invalid user-scriptlet settings', 'userScriptlets');
  }

  return {
    ok: true,
    config,
    whitelist: whitelist.value,
    fprWhitelist: fprWhitelist.value,
    proxyValidation,
    subscriptions,
    userScriptlets
  };
}

async function reconcileSettingsImportRuntime(config, proxyConfigs, options = {}) {
  const steps = [
    ['dnr', () => updateDNRState()],
    ['subscription-runtime', () => reconcileSubscriptionRuntimeState()],
    ['user-scripts', () => syncUserScripts()],
    ['proxy', () => syncProxyState(proxyConfigs)],
    ['webrtc', () => syncWebRtcLeakProtection(config, proxyConfigs)],
    ['browser-privacy', () => syncBrowserPrivacyHardening(config)],
    ['geolocation', () => syncGeolocationProtection(config)]
  ];
  const errors = [];
  for (const [step, task] of steps) {
    try {
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        result = await task();
        if (result?.stale !== true) break;
      }
      if (result && typeof result === 'object' && (result.ok === false || result.stale === true)) {
        const nestedError = Array.isArray(result.results)
          ? result.results.find(item => item?.error)?.error
          : null;
        throw new Error(result.error || nestedError || `${step} did not reach the requested state`);
      }
    } catch (error) {
      errors.push({ step, error: importErrorMessage(error) });
      if (options.continueOnError !== true) break;
    }
  }
  return { ok: errors.length === 0, errors };
}

async function restoreSettingsImportSnapshot(snapshot) {
  const restoreValues = {};
  const removeKeys = [];
  for (const key of SETTINGS_IMPORT_SNAPSHOT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) restoreValues[key] = snapshot[key];
    else removeKeys.push(key);
  }

  const storageErrors = [];
  if (Object.keys(restoreValues).length > 0) {
    try {
      await chrome.storage.local.set(restoreValues);
    } catch (error) {
      storageErrors.push({ step: 'storage-set', error: importErrorMessage(error) });
    }
  }
  if (removeKeys.length > 0) {
    try {
      await chrome.storage.local.remove(removeKeys);
    } catch (error) {
      storageErrors.push({ step: 'storage-remove', error: importErrorMessage(error) });
    }
  }

  const oldConfig = isImportObject(snapshot.config) ? snapshot.config : {};
  const oldProxyConfigs = Array.isArray(snapshot.proxyConfigs) ? snapshot.proxyConfigs : [];
  const runtime = await reconcileSettingsImportRuntime(oldConfig, oldProxyConfigs, { continueOnError: true });

  const errors = [...storageErrors, ...runtime.errors];
  return {
    attempted: true,
    succeeded: errors.length === 0,
    storageRestored: storageErrors.length === 0,
    runtimeRestored: storageErrors.length === 0 && runtime.ok,
    errors
  };
}

async function settingsImportFailure(phase, step, error, snapshot) {
  const rollback = await restoreSettingsImportSnapshot(snapshot);
  if (!rollback.succeeded) {
    return {
      ok: false,
      phase: 'rollback',
      failedPhase: phase,
      step,
      error: 'Settings import failed and rollback was incomplete',
      cause: importErrorMessage(error),
      rollback
    };
  }
  return {
    ok: false,
    phase,
    step,
    error: `Settings import ${phase} failed: ${importErrorMessage(error)}`,
    rollback
  };
}

export async function handleConfigExport() {
  const {
    config = {},
    whitelist = [],
    fprWhitelist = [],
    proxyConfigs = []
  } = await chrome.storage.local.get(['config', 'whitelist', 'fprWhitelist', 'proxyConfigs']);
  const subscriptions = await getSubscriptions();
  return {
    schema: 'chroma-settings',
    version: SETTINGS_IMPORT_VERSION,
    exportedAt: Date.now(),
    config: validateConfig(config),
    whitelist: sanitizeDomainList(whitelist),
    fprWhitelist: sanitizeDomainList(fprWhitelist),
    proxyConfigs: Array.isArray(proxyConfigs) ? proxyConfigs.map(exportProxyConfig) : [],
    subscriptions: subscriptions
      .filter(sub => sub?.isCustom === true && sub?.pendingRemoval !== true)
      .map(exportSubscription),
    userScriptlets: await exportUserScriptletSettings()
  };
}

export function handleConfigImport(msg) {
  return serializeConfigMutation(() => performConfigImport(msg));
}

async function performConfigImport(msg) {
  const payload = msg?.settings;
  let validation;
  try {
    validation = await validateSettingsImportPayload(payload);
  } catch (error) {
    return importValidationFailure(`Settings backup validation failed: ${importErrorMessage(error)}`);
  }
  if (!validation.ok) return validation;

  let snapshot;
  try {
    snapshot = await chrome.storage.local.get(SETTINGS_IMPORT_SNAPSHOT_KEYS);
  } catch (error) {
    return {
      ok: false,
      phase: 'commit',
      step: 'storage-snapshot',
      error: `Settings import snapshot failed: ${importErrorMessage(error)}`,
      rollback: { attempted: false, succeeded: true, storageRestored: true, runtimeRestored: true, errors: [] }
    };
  }

  let subscriptionImport;
  try {
    subscriptionImport = stageCustomSubscriptions(
      validation.subscriptions,
      snapshot,
      validation.config
    );
  } catch (error) {
    return importValidationFailure(`Subscription staging failed: ${importErrorMessage(error)}`, 'subscriptions');
  }
  if (!subscriptionImport.ok) {
    return importValidationFailure(subscriptionImport.error || 'Invalid subscription settings', 'subscriptions');
  }

  const config = validation.config;
  const proxyConfigs = validation.proxyValidation.configs;
  const stagedStorage = {
    config,
    whitelist: validation.whitelist,
    fprWhitelist: validation.fprWhitelist,
    proxyConfigs,
    ...subscriptionImport.storage,
    ...validation.userScriptlets.storage
  };

  try {
    await chrome.storage.local.set(stagedStorage);
  } catch (error) {
    return settingsImportFailure('commit', 'storage-commit', error, snapshot);
  }

  const reconciliation = await reconcileSettingsImportRuntime(config, proxyConfigs);
  if (!reconciliation.ok) {
    const failure = reconciliation.errors[0];
    return settingsImportFailure('reconciliation', failure.step, failure.error, snapshot);
  }

  try {
    await notifyConfigChanged(config);
  } catch {
    // Content notifications are best-effort. Stored state and authoritative
    // background runtime have already reconciled successfully.
  }

  return {
    ok: true,
    imported: {
      configKeys: Object.keys(config).length,
      whitelist: validation.whitelist.length,
      fprWhitelist: validation.fprWhitelist.length,
      proxyConfigs: proxyConfigs.length,
      subscriptions: subscriptionImport.importedCount || 0,
      userScriptletSources: validation.userScriptlets.importedSources || 0,
      userScriptletRules: validation.userScriptlets.importedRules || 0
    },
    droppedProxyCount: validation.proxyValidation.droppedCount,
    proxyErrors: validation.proxyValidation.errors
  };
}
