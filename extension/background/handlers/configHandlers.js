/**
 * Core configuration message handlers and config-change notifications.
 */

'use strict';

import { MSG } from '../../core/messageTypes.js';
import { reconcileSubscriptionRuntimeState } from '../../subscriptions/manager.js';
import { syncUserScripts } from '../../scriptlets/engine.js';
import { validateConfig } from '../configState.js';
import { serializeConfigMutation } from '../configCoordinator.js';
import { isNetworkProtectionActive, updateDNRState } from '../dnrState.js';
import { syncProxyState } from '../proxy.js';
import { syncWebRtcLeakProtection } from '../webrtc.js';
import { syncBrowserPrivacyHardening, syncGeolocationProtection } from '../browserPrivacy.js';

export async function notifyConfigChanged(config) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(t =>
    chrome.tabs.sendMessage(t.id, { type: MSG.CONFIG_UPDATE, config }).catch(() => {})
  ));
}

export async function handleConfigGet() {
  const { config } = await chrome.storage.local.get('config');
  return config;
}

export function handleConfigSet(msg) {
  // Queue config writes in request order as well as DNR commits. Otherwise two
  // concurrent toggles can overwrite storage before the DNR generation guard
  // has an authoritative state to read.
  return serializeConfigMutation(async () => {
    const { config: currentConfig = {} } = await chrome.storage.local.get('config');
    const validated = validateConfig(msg.config);
    const newConfig = { ...currentConfig, ...validated };
    await chrome.storage.local.set({ config: newConfig });
    const { proxyConfigs = [] } = await chrome.storage.local.get('proxyConfigs');

    // Reconcile immediately after the authoritative config write. The shared
    // predicate is evaluated again at the coordinator's final commit gate.
    const networkStateChanged = isNetworkProtectionActive(currentConfig) !==
      isNetworkProtectionActive(newConfig);
    const masterStateChanged = currentConfig.enabled !== newConfig.enabled;
    const proxyStateChanged = masterStateChanged ||
      currentConfig.globalProxyEnabled !== newConfig.globalProxyEnabled ||
      currentConfig.globalProxyId !== newConfig.globalProxyId ||
      currentConfig.chromeServiceProxyBypass !== newConfig.chromeServiceProxyBypass;
    const dynamicBehaviorChanged = currentConfig.acceleration !== newConfig.acceleration ||
      currentConfig.trackingUrlCleanup !== newConfig.trackingUrlCleanup;
    if (networkStateChanged || dynamicBehaviorChanged) {
      await updateDNRState();
    }
    if (masterStateChanged) {
      await reconcileSubscriptionRuntimeState();
      await syncUserScripts();
    }
    if (proxyStateChanged) {
      await syncProxyState(proxyConfigs);
    }
    await syncWebRtcLeakProtection(newConfig, proxyConfigs);
    await syncBrowserPrivacyHardening(newConfig);
    await syncGeolocationProtection(newConfig);

    await notifyConfigChanged(newConfig);
    return { ok: true };
  });
}
