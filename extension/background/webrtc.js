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

export function resolveWebRtcPolicy(config = {}, proxyConfigs = []) {
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

async function readStoredState(config, proxyConfigs) {
  if (config !== undefined && proxyConfigs !== undefined) {
    return { config: config || {}, proxyConfigs: Array.isArray(proxyConfigs) ? proxyConfigs : [] };
  }

  const stored = await chrome.storage.local.get(['config', 'proxyConfigs']);
  return {
    config: stored.config || {},
    proxyConfigs: Array.isArray(stored.proxyConfigs) ? stored.proxyConfigs : []
  };
}

export async function getWebRtcLeakProtectionStatus(config, proxyConfigs) {
  const setting = getWebRtcSetting();
  const { config: storedConfig, proxyConfigs: storedProxyConfigs } = await readStoredState(config, proxyConfigs);
  const desired = resolveWebRtcPolicy(storedConfig, storedProxyConfigs);
  const base = {
    available: !!setting,
    mode: desired.mode,
    value: null,
    levelOfControl: null,
    controllable: false,
    active: false,
    protected: false,
    partial: false,
    recommended: storedConfig.globalProxyEnabled === true,
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

    return {
      ...base,
      value,
      levelOfControl,
      controllable: CONTROLLABLE_LEVELS.has(levelOfControl),
      active: protectedState || partial,
      protected: protectedState,
      partial,
      error: blocked ? 'WebRTC privacy setting is controlled elsewhere' : null
    };
  } catch (err) {
    return { ...base, error: sanitizeError(err) };
  }
}

export async function syncWebRtcLeakProtection(config = {}, proxyConfigs = []) {
  const setting = getWebRtcSetting();
  const desired = resolveWebRtcPolicy(config, proxyConfigs);

  if (!setting || typeof setting.get !== 'function') {
    return {
      ok: false,
      available: false,
      controllable: false,
      mode: desired.mode,
      action: desired.action,
      value: null,
      levelOfControl: null,
      error: 'Chrome privacy WebRTC setting unavailable'
    };
  }

  try {
    const details = await chromeSettingCall(setting, 'get', WEBRTC_GET_DETAILS);
    const levelOfControl = details?.levelOfControl || null;
    const controllable = CONTROLLABLE_LEVELS.has(levelOfControl);

    if (!controllable) {
      return {
        ok: false,
        available: true,
        controllable: false,
        mode: desired.mode,
        action: desired.action,
        value: details?.value ?? null,
        levelOfControl,
        error: BLOCKED_LEVELS.has(levelOfControl)
          ? 'WebRTC privacy setting is controlled elsewhere'
          : 'WebRTC privacy setting is not controllable'
      };
    }

    if (desired.action === 'clear') {
      await chromeSettingCall(setting, 'clear', WEBRTC_SCOPE);
      return {
        ok: true,
        available: true,
        controllable: true,
        mode: desired.mode,
        action: 'clear',
        value: null,
        levelOfControl
      };
    }

    if (details?.value !== desired.value) {
      await chromeSettingCall(setting, 'set', { ...WEBRTC_SCOPE, value: desired.value });
    }

    return {
      ok: true,
      available: true,
      controllable: true,
      mode: desired.mode,
      action: 'set',
      value: desired.value,
      levelOfControl
    };
  } catch (err) {
    return {
      ok: false,
      available: true,
      controllable: false,
      mode: desired.mode,
      action: desired.action,
      value: null,
      levelOfControl: null,
      error: sanitizeError(err)
    };
  }
}

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes.config && !changes.proxyConfigs)) return;

    chrome.storage.local.get(['config', 'proxyConfigs'])
      .then(({ config, proxyConfigs }) => syncWebRtcLeakProtection(config || {}, proxyConfigs || []))
      .catch(() => {});
  });
}
