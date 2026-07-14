/**
 * Browser privacy hardening controller.
 *
 * Uses Chrome's privacy and contentSettings APIs to apply a small set of browser-level settings
 * that make Chrome behave more like a privacy-focused browser without
 * duplicating Chroma's existing network/content protection layers.
 */

'use strict';

const PRIVACY_SCOPE = { scope: 'regular' };
const GEOLOCATION_CONTENT_SETTING = {
  primaryPattern: '<all_urls>',
  secondaryPattern: '<all_urls>',
  scope: 'regular'
};
const CONTROLLABLE_LEVELS = new Set([
  'controllable_by_this_extension',
  'controlled_by_this_extension'
]);
const BLOCKED_LEVELS = new Set([
  'not_controllable',
  'controlled_by_other_extensions'
]);
let _browserPrivacyGeneration = 0;
let _browserPrivacyQueue = Promise.resolve();
let _browserPrivacyRecoveryQueued = false;
let _browserPrivacyRecoveryDirty = false;
let _geolocationGeneration = 0;
let _geolocationQueue = Promise.resolve();
const _releasedBrowserPrivacySettings = new Set();

const BROWSER_PRIVACY_SETTINGS = Object.freeze([
  {
    key: 'thirdPartyCookiesAllowed',
    area: 'websites',
    label: 'Third-party cookies',
    desiredValue: false
  },
  {
    key: 'doNotTrackEnabled',
    area: 'websites',
    label: 'Do Not Track',
    desiredValue: false
  },
  {
    key: 'adMeasurementEnabled',
    area: 'websites',
    label: 'Ad measurement APIs',
    desiredValue: false
  },
  {
    key: 'topicsEnabled',
    area: 'websites',
    label: 'Topics API',
    desiredValue: false
  },
  {
    key: 'fledgeEnabled',
    area: 'websites',
    label: 'Protected Audience API',
    desiredValue: false
  }
]);

function getChromeSetting(definition) {
  return typeof chrome !== 'undefined'
    ? chrome.privacy?.[definition.area]?.[definition.key] || null
    : null;
}

function getGeolocationSetting() {
  return typeof chrome !== 'undefined'
    ? chrome.contentSettings?.location || null
    : null;
}

function isMasterProtectionEnabled(config) {
  return config?.enabled !== false;
}

function isBrowserPrivacyRequested(config) {
  return config?.browserPrivacyHardening === true;
}

function isBrowserPrivacyEnabled(config) {
  return isMasterProtectionEnabled(config) && isBrowserPrivacyRequested(config);
}

function isGeolocationRequested(config) {
  return config?.geolocationProtection === true;
}

function isGeolocationEnabled(config) {
  return isMasterProtectionEnabled(config) && isGeolocationRequested(config);
}

async function readAuthoritativeConfig(fallback = {}) {
  if (typeof chrome === 'undefined' || typeof chrome.storage?.local?.get !== 'function') return fallback;
  try {
    const stored = await chrome.storage.local.get('config');
    return stored?.config && typeof stored.config === 'object' ? stored.config : fallback;
  } catch {
    return fallback;
  }
}

async function readAuthoritativeConfigStrict() {
  if (typeof chrome === 'undefined' || typeof chrome.storage?.local?.get !== 'function') {
    throw new Error('Chrome storage is unavailable');
  }
  const stored = await chrome.storage.local.get('config');
  return stored?.config && typeof stored.config === 'object' ? stored.config : {};
}

function sanitizeError(err) {
  return String(err?.message || err || 'Chrome privacy setting unavailable')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[^\S\r\n]+/g, ' ')
    .trim()
    .slice(0, 160);
}

function chromeSettingCall(target, methodName, details) {
  const method = target?.[methodName];
  if (typeof method !== 'function') {
    return Promise.reject(new Error(`ChromeSetting.${methodName} unavailable`));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      const lastError = chrome.runtime?.lastError;
      if (lastError) {
        reject(new Error(lastError.message || String(lastError)));
        return;
      }
      resolve(value);
    };

    try {
      const maybePromise = details === undefined
        ? method.call(target, finish)
        : method.call(target, details, finish);
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(finish, reject);
      }
    } catch (err) {
      reject(err);
    }
  });
}

function contentSettingCall(target, methodName, details) {
  const method = target?.[methodName];
  if (typeof method !== 'function') {
    return Promise.reject(new Error(`ContentSetting.${methodName} unavailable`));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      const lastError = chrome.runtime?.lastError;
      if (lastError) {
        reject(new Error(lastError.message || String(lastError)));
        return;
      }
      resolve(value);
    };

    try {
      const maybePromise = details === undefined
        ? method.call(target, finish)
        : method.call(target, details, finish);
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(finish, reject);
      }
    } catch (err) {
      reject(err);
    }
  });
}

async function readSetting(definition, enabled = false) {
  const setting = getChromeSetting(definition);
  const base = {
    key: definition.key,
    label: definition.label,
    desiredValue: definition.desiredValue,
    available: !!setting,
    value: null,
    levelOfControl: null,
    controllable: false,
    controlledByThisExtension: false,
    hardened: false,
    effective: false,
    error: null
  };

  if (!setting || typeof setting.get !== 'function') {
    return { ...base, available: false, error: 'Chrome privacy setting unavailable' };
  }

  try {
    const details = await chromeSettingCall(setting, 'get', {});
    const value = details?.value ?? null;
    const levelOfControl = details?.levelOfControl || null;
    const hardened = value === definition.desiredValue;
    const blocked = BLOCKED_LEVELS.has(levelOfControl);
    return {
      ...base,
      value,
      levelOfControl,
      controllable: CONTROLLABLE_LEVELS.has(levelOfControl),
      controlledByThisExtension: levelOfControl === 'controlled_by_this_extension',
      hardened,
      effective: enabled && hardened,
      error: enabled && blocked
        ? 'Chrome privacy setting is controlled elsewhere'
        : null
    };
  } catch (err) {
    return { ...base, available: false, error: sanitizeError(err) };
  }
}

export async function getBrowserPrivacyHardeningStatus(config = {}, { authoritative = true } = {}) {
  if (authoritative) config = await readAuthoritativeConfig(config);
  const requested = isBrowserPrivacyRequested(config);
  const enabled = isBrowserPrivacyEnabled(config);
  const settings = await Promise.all(BROWSER_PRIVACY_SETTINGS.map(definition => readSetting(definition, enabled)));
  const availableCount = settings.filter(setting => setting.available).length;
  const hardenedCount = settings.filter(setting => setting.hardened).length;
  const controlledCount = settings.filter(setting => setting.controlledByThisExtension).length;
  const blockedCount = settings.filter(setting =>
    enabled &&
    setting.available &&
    setting.levelOfControl &&
    !setting.controllable
  ).length;

  return {
    requested,
    enabled,
    available: availableCount === settings.length,
    active: enabled && hardenedCount === settings.length,
    effective: enabled && hardenedCount === settings.length,
    controlled: controlledCount === settings.length,
    partial: enabled && hardenedCount > 0 && hardenedCount < settings.length,
    hardenedCount,
    controlledCount,
    totalCount: settings.length,
    blockedCount,
    settings
  };
}

export function syncBrowserPrivacyHardening(config = {}) {
  const generation = ++_browserPrivacyGeneration;
  const requestedConfig = { ...config };
  const operation = _browserPrivacyQueue.then(async () => {
    const authoritativeConfig = await readAuthoritativeConfig(requestedConfig);
    if (generation !== _browserPrivacyGeneration) {
      return { ok: false, stale: true, requested: false, enabled: false, results: [] };
    }
    return syncBrowserPrivacyHardeningImpl(authoritativeConfig, generation);
  });
  _browserPrivacyQueue = operation.then(() => {}, () => {});
  return operation;
}

async function syncBrowserPrivacyHardeningImpl(config, generation) {
  const requested = isBrowserPrivacyRequested(config);
  const enabled = isBrowserPrivacyEnabled(config);
  const results = [];

  for (const definition of BROWSER_PRIVACY_SETTINGS) {
    if (generation !== _browserPrivacyGeneration) break;
    const setting = getChromeSetting(definition);
    const result = {
      key: definition.key,
      action: enabled ? 'set' : 'clear',
      ok: false,
      available: !!setting,
      value: null,
      levelOfControl: null,
      controlledByThisExtension: false,
      effective: false,
      error: null
    };

    if (!setting) {
      result.error = 'Chrome privacy setting unavailable';
      results.push(result);
      continue;
    }

    if (!enabled) {
      if (typeof setting.clear !== 'function') {
        result.error = 'Chrome privacy setting cannot be released';
        results.push(result);
        continue;
      }
      try {
        let beforeClear = null;
        if (typeof setting.get === 'function') {
          try {
            beforeClear = await chromeSettingCall(setting, 'get', {});
            result.value = beforeClear?.value ?? null;
            result.levelOfControl = beforeClear?.levelOfControl || null;
            result.controlledByThisExtension = result.levelOfControl === 'controlled_by_this_extension';
          } catch (inspectionError) {
            result.available = false;
            result.error = sanitizeError(inspectionError);
          }
        }
        const shouldClear = !_releasedBrowserPrivacySettings.has(definition.key) && (
          !beforeClear ||
          result.controlledByThisExtension ||
          BLOCKED_LEVELS.has(result.levelOfControl)
        );
        if (shouldClear) {
          await chromeSettingCall(setting, 'clear', PRIVACY_SCOPE);
          _releasedBrowserPrivacySettings.add(definition.key);
        }
        if (generation !== _browserPrivacyGeneration) break;
        result.ok = true;
        if (typeof setting.get === 'function') {
          try {
            const afterClear = await chromeSettingCall(setting, 'get', {});
            result.value = afterClear?.value ?? null;
            result.levelOfControl = afterClear?.levelOfControl || null;
            result.controlledByThisExtension = result.levelOfControl === 'controlled_by_this_extension';
            result.ok = !result.controlledByThisExtension;
            if (!result.ok) {
              _releasedBrowserPrivacySettings.delete(definition.key);
              result.error = 'Chrome privacy setting could not be released';
            }
          } catch (inspectionError) {
            result.available = false;
            result.ok = false;
            result.error = `Release applied but could not be verified: ${sanitizeError(inspectionError)}`;
          }
        }
      } catch (err) {
        result.error = sanitizeError(err);
      }
      results.push(result);
      continue;
    }

    _releasedBrowserPrivacySettings.delete(definition.key);

    if (typeof setting.get !== 'function') {
      result.error = 'Chrome privacy setting unavailable';
      results.push(result);
      continue;
    }

    try {
      const details = await chromeSettingCall(setting, 'get', {});
      const levelOfControl = details?.levelOfControl || null;
      const controllable = CONTROLLABLE_LEVELS.has(levelOfControl);
      result.value = details?.value ?? null;
      result.levelOfControl = levelOfControl;
      result.controlledByThisExtension = levelOfControl === 'controlled_by_this_extension';

      if (generation !== _browserPrivacyGeneration) break;

      if (!controllable) {
        result.effective = result.value === definition.desiredValue;
        result.ok = false;
        result.error = BLOCKED_LEVELS.has(levelOfControl)
          ? 'Chrome privacy setting is controlled elsewhere'
          : 'Chrome privacy setting is not controllable';
        results.push(result);
        continue;
      }

      if (details?.value !== definition.desiredValue || !result.controlledByThisExtension) {
        if (generation !== _browserPrivacyGeneration) break;
        await chromeSettingCall(setting, 'set', {
          ...PRIVACY_SCOPE,
          value: definition.desiredValue
        });
      }

      if (generation !== _browserPrivacyGeneration) break;
      const afterSet = await chromeSettingCall(setting, 'get', {});
      result.value = afterSet?.value ?? null;
      result.levelOfControl = afterSet?.levelOfControl || null;
      result.controlledByThisExtension = result.levelOfControl === 'controlled_by_this_extension';
      result.effective = result.value === definition.desiredValue;
      result.ok = result.effective && result.controlledByThisExtension;
      if (!result.ok) result.error = 'Chrome privacy setting did not reach the requested value';
      results.push(result);
    } catch (err) {
      result.error = sanitizeError(err);
      results.push(result);
    }
  }

  return {
    ok: generation === _browserPrivacyGeneration &&
      results.length === BROWSER_PRIVACY_SETTINGS.length &&
      results.every(result => result.ok),
    stale: generation !== _browserPrivacyGeneration,
    requested,
    enabled,
    results
  };
}

export async function getGeolocationProtectionStatus(config = {}, { authoritative = true } = {}) {
  if (authoritative) config = await readAuthoritativeConfig(config);
  const requested = isGeolocationRequested(config);
  const enabled = isGeolocationEnabled(config);
  const setting = getGeolocationSetting();
  const base = {
    requested,
    enabled,
    available: !!setting,
    active: false,
    effective: false,
    controlled: null,
    setting: null,
    error: null
  };

  if (!setting || typeof setting.get !== 'function') {
    return { ...base, available: false, error: 'Chrome geolocation content setting unavailable' };
  }

  try {
    const details = await contentSettingCall(setting, 'get', {
      primaryUrl: 'https://example.com/',
      secondaryUrl: 'https://example.com/'
    });
    const effective = enabled && details?.setting === 'block';
    return {
      ...base,
      setting: details?.setting || null,
      active: effective,
      effective
    };
  } catch (err) {
    return { ...base, available: false, error: sanitizeError(err) };
  }
}

export function syncGeolocationProtection(config = {}) {
  const generation = ++_geolocationGeneration;
  const requestedConfig = { ...config };
  const operation = _geolocationQueue.then(async () => {
    const authoritativeConfig = await readAuthoritativeConfig(requestedConfig);
    if (generation !== _geolocationGeneration) {
      return { ok: false, stale: true, requested: false, enabled: false };
    }
    return syncGeolocationProtectionImpl(authoritativeConfig, generation);
  });
  _geolocationQueue = operation.then(() => {}, () => {});
  return operation;
}

async function syncGeolocationProtectionImpl(config, generation) {
  const requested = isGeolocationRequested(config);
  const enabled = isGeolocationEnabled(config);
  const setting = getGeolocationSetting();
  const result = {
    ok: false,
    stale: false,
    requested,
    enabled,
    available: !!setting,
    action: enabled ? 'set' : 'clear',
    setting: null,
    effective: false,
    controlled: null,
    error: null
  };

  if (!setting || typeof setting.set !== 'function' || typeof setting.clear !== 'function') {
    result.error = 'Chrome geolocation content setting unavailable';
    return result;
  }

  try {
    if (!enabled) {
      await contentSettingCall(setting, 'clear', { scope: 'regular' });
      if (generation !== _geolocationGeneration) {
        result.stale = true;
        return result;
      }
      const afterClear = typeof setting.get === 'function'
        ? await contentSettingCall(setting, 'get', {
            primaryUrl: 'https://example.com/',
            secondaryUrl: 'https://example.com/'
          })
        : null;
      result.ok = true;
      result.setting = afterClear?.setting || null;
      return result;
    }

    await contentSettingCall(setting, 'set', {
      ...GEOLOCATION_CONTENT_SETTING,
      setting: 'block'
    });
    if (generation !== _geolocationGeneration) {
      result.stale = true;
      return result;
    }
    const afterSet = typeof setting.get === 'function'
      ? await contentSettingCall(setting, 'get', {
          primaryUrl: 'https://example.com/',
          secondaryUrl: 'https://example.com/'
        })
      : { setting: 'block' };
    result.setting = afterSet?.setting || null;
    result.effective = result.setting === 'block';
    result.ok = result.effective;
    if (!result.ok) result.error = 'Chrome geolocation setting did not reach block';
    return result;
  } catch (err) {
    result.error = sanitizeError(err);
    return result;
  }
}

export async function recoverBrowserPrivacyControls() {
  const config = await readAuthoritativeConfigStrict();
  return Promise.all([
    syncBrowserPrivacyHardening(config),
    syncGeolocationProtection(config)
  ]);
}

function scheduleBrowserPrivacyRecovery() {
  _browserPrivacyRecoveryDirty = true;
  if (_browserPrivacyRecoveryQueued) return;
  _browserPrivacyRecoveryQueued = true;
  Promise.resolve().then(async () => {
    while (_browserPrivacyRecoveryDirty) {
      await _browserPrivacyQueue;
      _browserPrivacyRecoveryDirty = false;
      const config = await readAuthoritativeConfigStrict();
      await syncBrowserPrivacyHardening(config);
    }
  }).catch(() => {}).finally(() => {
    _browserPrivacyRecoveryQueued = false;
    if (_browserPrivacyRecoveryDirty) scheduleBrowserPrivacyRecovery();
  });
}

if (typeof chrome !== 'undefined') {
  for (const definition of BROWSER_PRIVACY_SETTINGS) {
    const setting = getChromeSetting(definition);
    setting?.onChange?.addListener?.(scheduleBrowserPrivacyRecovery);
  }

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes.config) return;
    scheduleBrowserPrivacyRecovery();
    syncGeolocationProtection(changes.config.newValue || {}).catch(() => {});
  });
}
