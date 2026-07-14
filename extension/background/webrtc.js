/**
 * WebRTC leak protection controller.
 *
 * Uses Chrome's privacy API to keep browser-level WebRTC traffic aligned with
 * Chroma's proxy fallback mode. This intentionally does not patch page APIs.
 */

'use strict';

const POLICY = Object.freeze({
  BALANCED: 'default_public_interface_only',
  STRICT: 'disable_non_proxied_udp'
});

const MODES = new Set(['off', 'auto', 'balanced', 'strict']);
const WEBRTC_GET_DETAILS = {};
const WEBRTC_SCOPE = { scope: 'regular' };
const CONTROLLABLE_LEVELS = new Set([
  'controllable_by_this_extension',
  'controlled_by_this_extension'
]);
const BLOCKED_LEVELS = new Set([
  'not_controllable',
  'controlled_by_other_extensions'
]);
let _webRtcGeneration = 0;
let _webRtcQueue = Promise.resolve();
let _webRtcRecoveryQueued = false;
let _webRtcRecoveryDirty = false;
let _webRtcPreferenceReleased = false;

function getWebRtcSetting() {
  return typeof chrome !== 'undefined'
    ? chrome.privacy?.network?.webRTCIPHandlingPolicy || null
    : null;
}

function sanitizeError(err) {
  return String(err?.message || err || 'WebRTC privacy setting unavailable')
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

function hasValidGlobalProxy(config, proxyConfigs) {
  if (config?.globalProxyEnabled !== true || config.globalProxyId == null) return false;
  if (!Array.isArray(proxyConfigs)) return false;

  return proxyConfigs.some(pc => {
    const port = Number(pc?.port);
    return (
      pc?.id === config.globalProxyId &&
      pc.accepted === true &&
      pc.enabled !== false &&
      typeof pc.host === 'string' &&
      pc.host.trim().length > 0 &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65535
    );
  });
}

function isMasterProtectionEnabled(config) {
  return config?.enabled !== false;
}

function resolveRequestedWebRtcPolicy(config = {}, proxyConfigs = []) {
  const storedMode = config?.webRtcLeakProtection;
  const mode = MODES.has(storedMode) ? storedMode : 'auto';

  if (mode === 'off') {
    return { mode, action: 'clear', value: null, recommended: false };
  }

  if (mode === 'balanced') {
    return { mode, action: 'set', value: POLICY.BALANCED, recommended: false };
  }

  if (mode === 'strict') {
    return { mode, action: 'set', value: POLICY.STRICT, recommended: true };
  }

  if (hasValidGlobalProxy(config, proxyConfigs)) {
    return { mode, action: 'set', value: POLICY.STRICT, recommended: true };
  }

  return { mode, action: 'clear', value: null, recommended: false };
}

export function resolveWebRtcPolicy(config = {}, proxyConfigs = []) {
  const requested = resolveRequestedWebRtcPolicy(config, proxyConfigs);
  return isMasterProtectionEnabled(config)
    ? requested
    : { ...requested, action: 'clear', value: null };
}

async function readStoredState(config, proxyConfigs) {
  const fallbackConfig = config || {};
  const fallbackProxyConfigs = Array.isArray(proxyConfigs) ? proxyConfigs : [];
  if (typeof chrome === 'undefined' || typeof chrome.storage?.local?.get !== 'function') {
    return { config: fallbackConfig, proxyConfigs: fallbackProxyConfigs };
  }
  let stored;
  try {
    stored = await chrome.storage.local.get(['config', 'proxyConfigs']);
  } catch {
    return { config: fallbackConfig, proxyConfigs: fallbackProxyConfigs };
  }
  return {
    config: stored?.config && typeof stored.config === 'object' ? stored.config : fallbackConfig,
    proxyConfigs: Array.isArray(stored?.proxyConfigs) ? stored.proxyConfigs : fallbackProxyConfigs
  };
}

async function readStoredStateStrict() {
  if (typeof chrome === 'undefined' || typeof chrome.storage?.local?.get !== 'function') {
    throw new Error('Chrome storage is unavailable');
  }
  const stored = await chrome.storage.local.get(['config', 'proxyConfigs']);
  return {
    config: stored?.config && typeof stored.config === 'object' ? stored.config : {},
    proxyConfigs: Array.isArray(stored?.proxyConfigs) ? stored.proxyConfigs : []
  };
}

export async function getWebRtcLeakProtectionStatus(config, proxyConfigs, { authoritative = true } = {}) {
  const setting = getWebRtcSetting();
  const { config: storedConfig, proxyConfigs: storedProxyConfigs } = authoritative
    ? await readStoredState(config, proxyConfigs)
    : {
        config: config || {},
        proxyConfigs: Array.isArray(proxyConfigs) ? proxyConfigs : []
      };
  const requestedPolicy = resolveRequestedWebRtcPolicy(storedConfig, storedProxyConfigs);
  const desired = resolveWebRtcPolicy(storedConfig, storedProxyConfigs);
  const requested = requestedPolicy.action === 'set';
  const enabled = desired.action === 'set';
  const base = {
    available: !!setting,
    mode: desired.mode,
    requestedMode: requestedPolicy.mode,
    requested,
    enabled,
    masterEnabled: isMasterProtectionEnabled(storedConfig),
    desiredAction: desired.action,
    desiredValue: desired.value,
    value: null,
    levelOfControl: null,
    controllable: false,
    controlledByThisExtension: false,
    effective: false,
    released: false,
    active: false,
    protected: false,
    partial: false,
    recommended: requestedPolicy.recommended,
    error: null
  };

  if (!setting || typeof setting.get !== 'function') {
    return { ...base, available: false, error: 'Chrome privacy WebRTC setting unavailable' };
  }

  try {
    const details = await chromeSettingCall(setting, 'get', WEBRTC_GET_DETAILS);
    const value = details?.value ?? null;
    const levelOfControl = details?.levelOfControl || null;
    const protectedState = value === POLICY.STRICT;
    const partial = value === POLICY.BALANCED;
    const blocked = BLOCKED_LEVELS.has(levelOfControl);
    const controlledByThisExtension = levelOfControl === 'controlled_by_this_extension';
    const effective = enabled && value === desired.value;
    const released = !enabled && !controlledByThisExtension;

    return {
      ...base,
      value,
      levelOfControl,
      controllable: CONTROLLABLE_LEVELS.has(levelOfControl),
      controlledByThisExtension,
      effective,
      released,
      active: protectedState || partial,
      protected: protectedState,
      partial,
      error: enabled && blocked
        ? 'WebRTC privacy setting is controlled elsewhere'
        : (!enabled && controlledByThisExtension
            ? 'WebRTC privacy setting remains controlled after release'
            : null)
    };
  } catch (err) {
    return { ...base, error: sanitizeError(err) };
  }
}

export function syncWebRtcLeakProtection(config = {}, proxyConfigs = []) {
  const generation = ++_webRtcGeneration;
  const fallbackConfig = { ...config };
  const fallbackProxyConfigs = Array.isArray(proxyConfigs) ? [...proxyConfigs] : [];
  const operation = _webRtcQueue.then(async () => {
    const stored = await readStoredState(fallbackConfig, fallbackProxyConfigs);
    if (generation !== _webRtcGeneration) {
      return { ok: false, stale: true, available: !!getWebRtcSetting() };
    }
    return syncWebRtcLeakProtectionImpl(stored.config, stored.proxyConfigs, generation);
  });
  _webRtcQueue = operation.then(() => {}, () => {});
  return operation;
}

async function syncWebRtcLeakProtectionImpl(config, proxyConfigs, generation) {
  const setting = getWebRtcSetting();
  const requestedPolicy = resolveRequestedWebRtcPolicy(config, proxyConfigs);
  const desired = resolveWebRtcPolicy(config, proxyConfigs);
  const requested = requestedPolicy.action === 'set';
  const enabled = desired.action === 'set';

  if (!setting || typeof setting.get !== 'function') {
    return {
      ok: false,
      stale: false,
      available: false,
      controllable: false,
      mode: desired.mode,
      requested,
      enabled,
      action: desired.action,
      value: null,
      levelOfControl: null,
      error: 'Chrome privacy WebRTC setting unavailable'
    };
  }

  try {
    const details = await chromeSettingCall(setting, 'get', WEBRTC_GET_DETAILS);
    if (generation !== _webRtcGeneration) {
      return { ok: false, stale: true, available: true, requested, enabled };
    }
    const levelOfControl = details?.levelOfControl || null;
    const controllable = CONTROLLABLE_LEVELS.has(levelOfControl);
    const controlledByThisExtension = levelOfControl === 'controlled_by_this_extension';

    if (desired.action === 'clear') {
      if (controlledByThisExtension || (BLOCKED_LEVELS.has(levelOfControl) && !_webRtcPreferenceReleased)) {
        await chromeSettingCall(setting, 'clear', WEBRTC_SCOPE);
        _webRtcPreferenceReleased = true;
      }
      if (generation !== _webRtcGeneration) {
        return { ok: false, stale: true, available: true, requested, enabled };
      }
      const afterClear = await chromeSettingCall(setting, 'get', WEBRTC_GET_DETAILS);
      const afterLevel = afterClear?.levelOfControl || null;
      const released = afterLevel !== 'controlled_by_this_extension';
      if (!released) _webRtcPreferenceReleased = false;
      return {
        ok: released,
        stale: false,
        available: true,
        controllable: CONTROLLABLE_LEVELS.has(afterLevel),
        controlledByThisExtension: !released,
        requested,
        enabled,
        mode: desired.mode,
        action: 'clear',
        value: afterClear?.value ?? null,
        levelOfControl: afterLevel,
        effective: false,
        released,
        error: released ? null : 'WebRTC privacy setting could not be released'
      };
    }

    _webRtcPreferenceReleased = false;

    if (!controllable) {
      return {
        ok: false,
        stale: false,
        available: true,
        controllable: false,
        controlledByThisExtension: false,
        requested,
        enabled,
        mode: desired.mode,
        action: desired.action,
        value: details?.value ?? null,
        levelOfControl,
        error: BLOCKED_LEVELS.has(levelOfControl)
          ? 'WebRTC privacy setting is controlled elsewhere'
          : 'WebRTC privacy setting is not controllable'
      };
    }

    if (details?.value !== desired.value || !controlledByThisExtension) {
      if (generation !== _webRtcGeneration) {
        return { ok: false, stale: true, available: true, requested, enabled };
      }
      await chromeSettingCall(setting, 'set', { ...WEBRTC_SCOPE, value: desired.value });
    }

    if (generation !== _webRtcGeneration) {
      return { ok: false, stale: true, available: true, requested, enabled };
    }
    const afterSet = await chromeSettingCall(setting, 'get', WEBRTC_GET_DETAILS);
    const afterLevel = afterSet?.levelOfControl || null;
    const ownsSetting = afterLevel === 'controlled_by_this_extension';
    const effective = afterSet?.value === desired.value;

    return {
      ok: ownsSetting && effective,
      stale: false,
      available: true,
      controllable: CONTROLLABLE_LEVELS.has(afterLevel),
      controlledByThisExtension: ownsSetting,
      requested,
      enabled,
      mode: desired.mode,
      action: 'set',
      value: afterSet?.value ?? null,
      levelOfControl: afterLevel,
      effective,
      released: false,
      error: ownsSetting && effective ? null : 'WebRTC privacy setting did not reach the requested state'
    };
  } catch (err) {
    return {
      ok: false,
      stale: false,
      available: true,
      controllable: false,
      mode: desired.mode,
      requested,
      enabled,
      action: desired.action,
      value: null,
      levelOfControl: null,
      error: sanitizeError(err)
    };
  }
}

export async function recoverWebRtcLeakProtection() {
  const stored = await readStoredStateStrict();
  return syncWebRtcLeakProtection(stored.config, stored.proxyConfigs);
}

function scheduleWebRtcRecovery() {
  _webRtcRecoveryDirty = true;
  if (_webRtcRecoveryQueued) return;
  _webRtcRecoveryQueued = true;
  Promise.resolve().then(async () => {
    while (_webRtcRecoveryDirty) {
      await _webRtcQueue;
      _webRtcRecoveryDirty = false;
      await recoverWebRtcLeakProtection();
    }
  }).catch(() => {}).finally(() => {
    _webRtcRecoveryQueued = false;
    if (_webRtcRecoveryDirty) scheduleWebRtcRecovery();
  });
}

if (typeof chrome !== 'undefined') {
  getWebRtcSetting()?.onChange?.addListener?.(scheduleWebRtcRecovery);
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || (!changes.config && !changes.proxyConfigs)) return;
    scheduleWebRtcRecovery();
  });
}
