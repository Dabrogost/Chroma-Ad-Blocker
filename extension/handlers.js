/**
 * Runtime message handlers, grouped by domain.
 *
 * Each handler is a standalone async function; `registerAll` binds them
 * into the shared router (called from background.js at startup).
 */

'use strict';

import { MSG } from './messageTypes.js';
import { decryptAuth, encryptAuth } from './crypto.js';
import {
  getSubscriptions,
  setSubscriptionEnabled,
  refreshSubscription,
  addSubscription,
  removeSubscription
} from './subscriptions/manager.js';
import {
  validateConfig,
  updateDNRState,
  syncDynamicRules,
  syncWhitelistRules,
  checkForUpdate,
  runProxyTest,
  resetRequestLog,
  getMergedLog
} from './background.js';

const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

// ─── CONFIG ─────

async function handleConfigGet() {
  const { config } = await chrome.storage.local.get('config');
  return config;
}

async function handleConfigSet(msg) {
  const { config: currentConfig } = await chrome.storage.local.get('config');
  const validated = validateConfig(msg.config);
  const newConfig = { ...currentConfig, ...validated };
  await chrome.storage.local.set({ config: newConfig });

  const wasDNRActive = currentConfig.enabled !== false && currentConfig.networkBlocking !== false;
  const isDNRActive = newConfig.enabled !== false && newConfig.networkBlocking !== false;
  if (isDNRActive !== wasDNRActive) {
    await updateDNRState(isDNRActive);
  } else if (isDNRActive && currentConfig.acceleration !== newConfig.acceleration) {
    await syncDynamicRules();
  }

  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(t =>
    chrome.tabs.sendMessage(t.id, { type: MSG.CONFIG_UPDATE, config: newConfig }).catch(() => {})
  ));
  return { ok: true };
}

// ─── WHITELIST ─────

async function handleWhitelistGet() {
  const { whitelist = [] } = await chrome.storage.local.get('whitelist');
  return { whitelist };
}

async function handleWhitelistAdd(msg) {
  const { whitelist = [] } = await chrome.storage.local.get('whitelist');
  const domain = msg.domain;
  const valid =
    typeof domain === 'string' &&
    domain.length > 0 &&
    domain.length <= 253 &&
    DOMAIN_RE.test(domain) &&
    !whitelist.includes(domain);

  if (valid) {
    whitelist.push(domain);
    await chrome.storage.local.set({ whitelist });
    await syncWhitelistRules();
  }
  return { ok: true };
}

async function handleWhitelistRemove(msg) {
  const { whitelist = [] } = await chrome.storage.local.get('whitelist');
  const next = whitelist.filter(d => d !== msg.domain);
  if (next.length !== whitelist.length) {
    await chrome.storage.local.set({ whitelist: next });
    await syncWhitelistRules();
  }
  return { ok: true };
}

// ─── PROXY ─────

async function handleProxyConfigGet() {
  const { proxyConfigs = [] } = await chrome.storage.local.get('proxyConfigs');
  return Promise.all(proxyConfigs.map(async (pc) => {
    const out = { ...pc };
    if (out.authCipher && out.authIv) {
      const auth = await decryptAuth(out.authIv, out.authCipher);
      if (auth) {
        out.username = auth.username;
        out.password = auth.password;
      }
    }
    return out;
  }));
}

async function handleProxyConfigSet(msg) {
  const encrypted = await Promise.all(msg.proxyConfigs.map(async (pc) => {
    const out = { ...pc };
    if (out.username || out.password) {
      const enc = await encryptAuth(out.username, out.password);
      if (enc) {
        out.authIv = enc.iv;
        out.authCipher = enc.ciphertext;
        delete out.username;
        delete out.password;
      }
    }
    return out;
  }));
  await chrome.storage.local.set({ proxyConfigs: encrypted });
  return { ok: true };
}

async function handleProxyTest(msg) {
  return runProxyTest(msg.proxyId);
}

// ─── SUBSCRIPTIONS ─────

async function handleSubscriptionGet()        { return getSubscriptions(); }
async function handleSubscriptionSet(msg)     { return setSubscriptionEnabled(msg.id, msg.enabled); }
async function handleSubscriptionRefresh(msg) { return refreshSubscription(msg.id); }
async function handleSubscriptionAdd(msg)     { return addSubscription(msg.subscription); }
async function handleSubscriptionRemove(msg)  { return removeSubscription(msg.id); }

// ─── STATS / LOG ─────

async function handleStatsReset() {
  await resetRequestLog();
  return { ok: true };
}

async function handleLogGet() {
  return getMergedLog();
}

// ─── SYSTEM ─────

async function handleUpdateCheck() {
  return checkForUpdate();
}

// ─── REGISTRATION ─────

export function registerAll(router) {
  // Sensitive types are rejected when sent from outside the extension origin.
  router.markSensitive(MSG.CONFIG_GET);
  router.markSensitive(MSG.CONFIG_SET);
  router.markSensitive(MSG.STATS_RESET);
  router.markSensitive(MSG.PROXY_CONFIG_GET);
  router.markSensitive(MSG.PROXY_CONFIG_SET);

  router.registerHandler(MSG.CONFIG_GET,           handleConfigGet);
  router.registerHandler(MSG.CONFIG_SET,           handleConfigSet);
  router.registerHandler(MSG.WHITELIST_GET,        handleWhitelistGet);
  router.registerHandler(MSG.WHITELIST_ADD,        handleWhitelistAdd);
  router.registerHandler(MSG.WHITELIST_REMOVE,     handleWhitelistRemove);
  router.registerHandler(MSG.PROXY_CONFIG_GET,     handleProxyConfigGet);
  router.registerHandler(MSG.PROXY_CONFIG_SET,     handleProxyConfigSet);
  router.registerHandler(MSG.PROXY_TEST,           handleProxyTest);
  router.registerHandler(MSG.SUBSCRIPTION_GET,     handleSubscriptionGet);
  router.registerHandler(MSG.SUBSCRIPTION_SET,     handleSubscriptionSet);
  router.registerHandler(MSG.SUBSCRIPTION_REFRESH, handleSubscriptionRefresh);
  router.registerHandler(MSG.SUBSCRIPTION_ADD,     handleSubscriptionAdd);
  router.registerHandler(MSG.SUBSCRIPTION_REMOVE,  handleSubscriptionRemove);
  router.registerHandler(MSG.STATS_RESET,          handleStatsReset);
  router.registerHandler(MSG.LOG_GET,              handleLogGet);
  router.registerHandler(MSG.UPDATE_CHECK,         handleUpdateCheck);
}
