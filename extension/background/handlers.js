/**
 * Runtime message handlers, grouped by domain.
 *
 * Each handler is a standalone async function; `registerAll` binds them
 * into the shared router (called from background.js at startup).
 */

'use strict';

import { MSG } from '../core/messageTypes.js';
import { encryptAuth } from '../core/crypto.js';
import {
  getSubscriptions,
  setSubscriptionEnabled,
  refreshSubscription,
  addSubscription,
  removeSubscription
} from '../subscriptions/manager.js';
import {
  validateConfig,
  updateDNRState,
  syncDynamicRules,
  syncWhitelistRules,
  checkForUpdate,
  resetRequestLog,
  getMergedLog
} from './background.js';
import { runProxyTest } from './proxy.js';

const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const SUBSCRIPTION_ID_RE = /^[a-z0-9_-]{1,80}$/i;
const PROXY_TYPES = new Set(['PROXY', 'HTTPS', 'SOCKS4', 'SOCKS5']);
const MAX_PROXY_NAME_LEN = 80;
const MAX_PROXY_CREDENTIAL_LEN = 256;
const MAX_PROXY_AUTH_IV_LEN = 128;
const MAX_PROXY_AUTH_CIPHER_LEN = 2048;
const MAX_SUBSCRIPTION_NAME_LEN = 120;
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 24 * 30;

function isValidHostname(host) {
  if (typeof host !== 'string' || host.length < 1 || host.length > 253) return false;
  if (host.startsWith('.') || host.endsWith('.')) return false;
  const labels = host.split('.');
  return labels.every(label =>
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9-]+$/i.test(label) &&
    !label.startsWith('-') &&
    !label.endsWith('-')
  );
}

function normalizeDomain(input) {
  if (typeof input !== 'string') return null;
  let domain = input.trim().toLowerCase();
  if (!domain) return null;

  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (domain.startsWith('*.')) domain = domain.slice(2);
  if (
    domain.length === 0 ||
    domain.length > 253 ||
    domain.includes(':') ||
    domain.includes(' ') ||
    domain.includes('?') ||
    domain.includes('#') ||
    domain.startsWith('.') ||
    domain.endsWith('.') ||
    !DOMAIN_RE.test(domain) ||
    !isValidHostname(domain)
  ) {
    return null;
  }
  return domain;
}

function parsePort(input) {
  const port = typeof input === 'number'
    ? input
    : (typeof input === 'string' && input.trim() !== '' ? Number(input.trim()) : NaN);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function normalizeProxyType(type) {
  if (typeof type !== 'string') return 'PROXY';
  const upper = type.trim().toUpperCase();
  if (upper === 'HTTP') return 'PROXY';
  return PROXY_TYPES.has(upper) ? upper : null;
}

function normalizeProxyHost(input, explicitType) {
  if (typeof input !== 'string') return null;
  let host = input.trim().toLowerCase();
  let inferredType = explicitType;
  let inferredPort = null;
  if (!host) return { host: '', type: inferredType, port: inferredPort };

  const schemeMatch = host.match(/^(https?|socks4|socks5|socks):\/\//);
  if (schemeMatch) {
    const scheme = schemeMatch[1];
    inferredType =
      scheme === 'https' ? 'HTTPS' :
      scheme === 'socks4' ? 'SOCKS4' :
      scheme === 'socks5' ? 'SOCKS5' :
      scheme === 'socks' ? 'SOCKS4' :
      'PROXY';
    host = host.slice(schemeMatch[0].length);
  }

  host = host.replace(/\/.*$/, '');
  const lastColon = host.lastIndexOf(':');
  if (lastColon > -1 && host.indexOf(':') === lastColon) {
    const maybePort = host.slice(lastColon + 1);
    const parsed = parsePort(maybePort);
    if (parsed) {
      inferredPort = parsed;
      host = host.slice(0, lastColon);
    }
  }

  if (
    !host ||
    host.length > 253 ||
    host.includes('/') ||
    host.includes(' ') ||
    host.includes('?') ||
    host.includes('#') ||
    !DOMAIN_RE.test(host) ||
    !isValidHostname(host)
  ) {
    return null;
  }

  return { host, type: inferredType, port: inferredPort };
}

function validateProxyConfig(pc, index) {
  const errors = [];
  if (!pc || typeof pc !== 'object' || Array.isArray(pc)) {
    return { value: null, errors: [`proxy[${index}]: expected object`] };
  }

  const id = typeof pc.id === 'number' && Number.isSafeInteger(pc.id) ? pc.id : null;
  if (id === null) errors.push('invalid id');

  const explicitType = pc.type === undefined || pc.type === null || pc.type === ''
    ? null
    : normalizeProxyType(pc.type);
  if (explicitType === null && pc.type) errors.push('invalid type');

  const hostParts = normalizeProxyHost(pc.host, explicitType);
  if (!hostParts) errors.push('invalid host');

  const effectivePort = hostParts?.port ?? parsePort(pc.port);
  const accepted = pc.accepted === true;

  if (accepted && (!hostParts?.host || !effectivePort)) errors.push('accepted proxy requires host and port');
  if (hostParts?.host && !effectivePort) errors.push('proxy host requires a valid port');

  if (errors.length > 0) {
    return { value: null, errors: [`proxy[${index}]: ${errors.join(', ')}`] };
  }

  const domains = [];
  if (Array.isArray(pc.domains)) {
    for (const d of pc.domains) {
      const host = normalizeDomain(d?.host);
      if (host) domains.push({ host, enabled: d?.enabled !== false });
    }
  }

  const normalized = {
    id,
    name: typeof pc.name === 'string' ? pc.name.trim().slice(0, MAX_PROXY_NAME_LEN) : '',
    host: hostParts.host,
    port: effectivePort || '',
    type: hostParts.type || 'PROXY',
    accepted,
    domains
  };

  return { value: normalized, errors: [] };
}

function hasEncryptedProxyAuth(pc) {
  return !!(
    pc &&
    typeof pc.authIv === 'string' &&
    typeof pc.authCipher === 'string' &&
    pc.authIv.length > 0 &&
    pc.authIv.length <= MAX_PROXY_AUTH_IV_LEN &&
    pc.authCipher.length > 0 &&
    pc.authCipher.length <= MAX_PROXY_AUTH_CIPHER_LEN
  );
}

function validateProxyCredentialInput(pc, index) {
  const username = typeof pc.username === 'string' ? pc.username.trim() : '';
  const password = typeof pc.password === 'string' ? pc.password : '';
  if (!username || !password) {
    return { ok: false, error: `proxy[${index}]: replacement credentials require username and password` };
  }
  if (username.length > MAX_PROXY_CREDENTIAL_LEN || password.length > MAX_PROXY_CREDENTIAL_LEN) {
    return { ok: false, error: `proxy[${index}]: credentials too long` };
  }
  return { ok: true, username, password };
}

async function validateProxyConfigsForStorage(proxyConfigs, existingProxyConfigs = []) {
  if (!Array.isArray(proxyConfigs)) {
    return { ok: false, configs: [], errors: ['proxyConfigs must be an array'], droppedCount: 0 };
  }

  const existingById = new Map(
    Array.isArray(existingProxyConfigs)
      ? existingProxyConfigs.map(pc => [pc?.id, pc])
      : []
  );
  const configs = [];
  const errors = [];
  for (let i = 0; i < proxyConfigs.length; i++) {
    const incoming = proxyConfigs[i];
    const result = validateProxyConfig(proxyConfigs[i], i);
    if (!result.value) {
      errors.push(...result.errors);
      continue;
    }
    const out = result.value;
    const action = incoming?.credentialAction || 'preserve';
    const existing = existingById.get(out.id);

    if (action === 'replace') {
      const credential = validateProxyCredentialInput(incoming, i);
      if (!credential.ok) {
        errors.push(credential.error);
        continue;
      }
      const enc = await encryptAuth(credential.username, credential.password);
      if (!enc) {
        errors.push(`proxy[${i}]: failed to encrypt credentials`);
        continue;
      }
      out.authIv = enc.iv;
      out.authCipher = enc.ciphertext;
    } else if (action === 'preserve') {
      if (hasEncryptedProxyAuth(existing)) {
        out.authIv = existing.authIv;
        out.authCipher = existing.authCipher;
      }
    } else if (action === 'clear') {
      // Intentionally leave encrypted auth fields unset.
    } else {
      errors.push(`proxy[${i}]: invalid credential action`);
      continue;
    }

    configs.push(out);
  }

  return {
    ok: true,
    configs,
    errors,
    droppedCount: proxyConfigs.length - configs.length
  };
}

function isValidSubscriptionId(id) {
  return typeof id === 'string' && SUBSCRIPTION_ID_RE.test(id);
}

function isPrivateIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map(p => Number(p));
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return (
    nums[0] === 10 ||
    nums[0] === 127 ||
    (nums[0] === 172 && nums[1] >= 16 && nums[1] <= 31) ||
    (nums[0] === 192 && nums[1] === 168) ||
    (nums[0] === 169 && nums[1] === 254)
  );
}

function isBlockedSubscriptionHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isIpv6 = host.includes(':');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    isPrivateIpv4(host) ||
    (isIpv6 && (
      host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe8') ||
      host.startsWith('fe9') ||
      host.startsWith('fea') ||
      host.startsWith('feb')
    ))
  );
}

function validateCustomSubscriptionInput(sub) {
  if (!sub || typeof sub !== 'object' || Array.isArray(sub)) {
    return { ok: false, error: 'Invalid subscription' };
  }
  if (!isValidSubscriptionId(sub.id)) {
    return { ok: false, error: 'Invalid subscription ID' };
  }

  let parsed;
  try {
    parsed = new URL(sub.url);
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }

  if (parsed.protocol !== 'https:') return { ok: false, error: 'Only https:// URLs are allowed' };
  if (parsed.username || parsed.password) return { ok: false, error: 'Subscription URLs cannot include credentials' };
  if (parsed.port && parsed.port !== '443') return { ok: false, error: 'Subscription URL must use the default HTTPS port' };
  if (isBlockedSubscriptionHost(parsed.hostname)) return { ok: false, error: 'Local or private subscription URLs are not allowed' };

  const name = typeof sub.name === 'string' ? sub.name.trim().slice(0, MAX_SUBSCRIPTION_NAME_LEN) : parsed.hostname;
  const intervalHours = sub.intervalHours === undefined
    ? undefined
    : Number(sub.intervalHours);
  if (
    intervalHours !== undefined &&
    (!Number.isInteger(intervalHours) || intervalHours < MIN_INTERVAL_HOURS || intervalHours > MAX_INTERVAL_HOURS)
  ) {
    return { ok: false, error: 'Invalid refresh interval' };
  }

  return {
    ok: true,
    subscription: {
      id: sub.id,
      name: name || parsed.hostname,
      url: parsed.href,
      intervalHours
    }
  };
}

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
  const domain = normalizeDomain(msg.domain);
  const valid = domain && !whitelist.includes(domain);

  if (valid) {
    whitelist.push(domain);
    await chrome.storage.local.set({ whitelist });
    await syncWhitelistRules();
  }
  return { ok: true };
}

async function handleWhitelistRemove(msg) {
  const { whitelist = [] } = await chrome.storage.local.get('whitelist');
  const domain = normalizeDomain(msg.domain);
  const next = domain ? whitelist.filter(d => d !== domain) : whitelist;
  if (next.length !== whitelist.length) {
    await chrome.storage.local.set({ whitelist: next });
    await syncWhitelistRules();
  }
  return { ok: true };
}

// ─── FPR WHITELIST ─────
// Separate from the main whitelist so users can disable Fingerprint
// Randomization on a site (e.g. for bot-check / login flows) without also
// disabling ad-blocking. The scriptlet engine watches storage.fprWhitelist
// and updates excludeMatches; no DNR-side sync is needed.

async function handleFprWhitelistGet() {
  const { fprWhitelist = [] } = await chrome.storage.local.get('fprWhitelist');
  return { fprWhitelist };
}

async function handleFprWhitelistAdd(msg) {
  const { fprWhitelist = [] } = await chrome.storage.local.get('fprWhitelist');
  const domain = normalizeDomain(msg.domain);
  const valid = domain && !fprWhitelist.includes(domain);

  if (valid) {
    fprWhitelist.push(domain);
    await chrome.storage.local.set({ fprWhitelist });
  }
  return { ok: true };
}

async function handleFprWhitelistRemove(msg) {
  const { fprWhitelist = [] } = await chrome.storage.local.get('fprWhitelist');
  const domain = normalizeDomain(msg.domain);
  const next = domain ? fprWhitelist.filter(d => d !== domain) : fprWhitelist;
  if (next.length !== fprWhitelist.length) {
    await chrome.storage.local.set({ fprWhitelist: next });
  }
  return { ok: true };
}

// ─── PROXY ─────

async function handleProxyConfigGet() {
  const { proxyConfigs = [] } = await chrome.storage.local.get('proxyConfigs');
  return proxyConfigs.map(pc => ({
    id: pc.id,
    name: pc.name,
    host: pc.host,
    port: pc.port,
    type: pc.type,
    accepted: pc.accepted,
    domains: Array.isArray(pc.domains) ? pc.domains : [],
    hasCredentials: hasEncryptedProxyAuth(pc)
  }));
}

async function handleProxyConfigSet(msg) {
  const { proxyConfigs: existingProxyConfigs = [] } = await chrome.storage.local.get('proxyConfigs');
  const { ok, configs, droppedCount, errors } = await validateProxyConfigsForStorage(msg.proxyConfigs, existingProxyConfigs);
  if (!ok) return { ok: false, error: errors[0] };
  await chrome.storage.local.set({ proxyConfigs: configs });
  return { ok: true, storedCount: configs.length, droppedCount, errors };
}

async function handleProxyTest(msg) {
  if (msg.proxyId !== undefined && (typeof msg.proxyId !== 'number' || !Number.isSafeInteger(msg.proxyId))) {
    return { ok: false, error: 'Invalid proxy ID' };
  }
  return runProxyTest(msg.proxyId);
}

// ─── SUBSCRIPTIONS ─────

async function handleSubscriptionGet()        { return getSubscriptions(); }
async function handleSubscriptionSet(msg) {
  if (!isValidSubscriptionId(msg.id) || typeof msg.enabled !== 'boolean') {
    return { ok: false, error: 'Invalid subscription update' };
  }
  return setSubscriptionEnabled(msg.id, msg.enabled);
}
async function handleSubscriptionRefresh(msg) {
  if (!isValidSubscriptionId(msg.id)) return { ok: false, error: 'Invalid subscription ID' };
  return refreshSubscription(msg.id);
}
async function handleSubscriptionAdd(msg) {
  const validation = validateCustomSubscriptionInput(msg.subscription);
  if (!validation.ok) return { ok: false, error: validation.error };
  return addSubscription(validation.subscription);
}
async function handleSubscriptionRemove(msg) {
  if (!isValidSubscriptionId(msg.id)) return { ok: false, error: 'Invalid subscription ID' };
  return removeSubscription(msg.id);
}

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
  router.markSensitive(MSG.LOG_GET);
  router.markSensitive(MSG.WHITELIST_ADD);
  router.markSensitive(MSG.WHITELIST_REMOVE);
  router.markSensitive(MSG.FPR_WHITELIST_ADD);
  router.markSensitive(MSG.FPR_WHITELIST_REMOVE);
  router.markSensitive(MSG.PROXY_CONFIG_GET);
  router.markSensitive(MSG.PROXY_CONFIG_SET);
  router.markSensitive(MSG.PROXY_TEST);
  router.markSensitive(MSG.SUBSCRIPTION_SET);
  router.markSensitive(MSG.SUBSCRIPTION_REFRESH);
  router.markSensitive(MSG.SUBSCRIPTION_ADD);
  router.markSensitive(MSG.SUBSCRIPTION_REMOVE);

  router.registerHandler(MSG.CONFIG_GET,           handleConfigGet);
  router.registerHandler(MSG.CONFIG_SET,           handleConfigSet);
  router.registerHandler(MSG.WHITELIST_GET,        handleWhitelistGet);
  router.registerHandler(MSG.WHITELIST_ADD,        handleWhitelistAdd);
  router.registerHandler(MSG.WHITELIST_REMOVE,     handleWhitelistRemove);
  router.registerHandler(MSG.FPR_WHITELIST_GET,    handleFprWhitelistGet);
  router.registerHandler(MSG.FPR_WHITELIST_ADD,    handleFprWhitelistAdd);
  router.registerHandler(MSG.FPR_WHITELIST_REMOVE, handleFprWhitelistRemove);
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
