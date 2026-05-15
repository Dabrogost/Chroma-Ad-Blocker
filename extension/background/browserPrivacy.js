/**
 * Browser privacy hardening controller.
 *
 * Uses Chrome's privacy API to apply a small set of browser-level settings
 * that make Chrome behave more like a privacy-focused browser without
 * duplicating Chroma's existing network/content protection layers.
 */

'use strict';

const PRIVACY_SCOPE = { scope: 'regular' };
const CONTROLLABLE_LEVELS = new Set([
  'controllable_by_this_extension',
  'controlled_by_this_extension'
]);
const BLOCKED_LEVELS = new Set([
  'not_controllable',
  'controlled_by_other_extensions'
]);

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

async function readSetting(definition) {
  const setting = getChromeSetting(definition);
  const base = {
    key: definition.key,
    label: definition.label,
    desiredValue: definition.desiredValue,
    available: !!setting,
    value: null,
    levelOfControl: null,
    controllable: false,
    hardened: false,
    error: null
  };

  if (!setting || typeof setting.get !== 'function') {
    return { ...base, available: false, error: 'Chrome privacy setting unavailable' };
  }

  try {
    const details = await chromeSettingCall(setting, 'get', {});
    const value = details?.value ?? null;
    const levelOfControl = details?.levelOfControl || null;
    return {
      ...base,
      value,
      levelOfControl,
      controllable: CONTROLLABLE_LEVELS.has(levelOfControl),
      hardened: value === definition.desiredValue,
      error: BLOCKED_LEVELS.has(levelOfControl) ? 'Chrome privacy setting is controlled elsewhere' : null
    };
  } catch (err) {
    return { ...base, error: sanitizeError(err) };
  }
}

export async function getBrowserPrivacyHardeningStatus(config = {}) {
  const enabled = config?.browserPrivacyHardening === true;
  const settings = await Promise.all(BROWSER_PRIVACY_SETTINGS.map(readSetting));
  const availableCount = settings.filter(setting => setting.available).length;
  const hardenedCount = settings.filter(setting => setting.hardened).length;
  const blockedCount = settings.filter(setting =>
    setting.available &&
    setting.hardened !== true &&
    setting.levelOfControl &&
    !setting.controllable
  ).length;

  return {
    enabled,
    available: availableCount === settings.length,
    active: enabled && hardenedCount === settings.length,
    partial: enabled && hardenedCount > 0 && hardenedCount < settings.length,
    hardenedCount,
    totalCount: settings.length,
    blockedCount,
    settings
  };
}

export async function syncBrowserPrivacyHardening(config = {}) {
  const enabled = config?.browserPrivacyHardening === true;
  const results = [];

  for (const definition of BROWSER_PRIVACY_SETTINGS) {
    const setting = getChromeSetting(definition);
    const result = {
      key: definition.key,
      action: enabled ? 'set' : 'clear',
      ok: false,
      available: !!setting,
      value: null,
      levelOfControl: null,
      error: null
    };

    if (!setting || typeof setting.get !== 'function') {
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

      if (!controllable) {
        result.ok = !enabled || result.value === definition.desiredValue;
        result.error = BLOCKED_LEVELS.has(levelOfControl)
          ? 'Chrome privacy setting is controlled elsewhere'
          : 'Chrome privacy setting is not controllable';
        results.push(result);
        continue;
      }

      if (!enabled) {
        await chromeSettingCall(setting, 'clear', PRIVACY_SCOPE);
        result.ok = true;
        result.value = null;
        results.push(result);
        continue;
      }

      if (details?.value !== definition.desiredValue) {
        await chromeSettingCall(setting, 'set', {
          ...PRIVACY_SCOPE,
          value: definition.desiredValue
        });
      }

      result.ok = true;
      result.value = definition.desiredValue;
      results.push(result);
    } catch (err) {
      result.error = sanitizeError(err);
      results.push(result);
    }
  }

  return {
    ok: results.every(result => result.ok),
    enabled,
    results
  };
}

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.config) return;

    syncBrowserPrivacyHardening(changes.config.newValue || {})
      .catch(() => {});
  });
}
