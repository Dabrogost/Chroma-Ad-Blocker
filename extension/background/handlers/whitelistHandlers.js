/**
 * Main and fingerprint-randomization whitelist message handlers.
 */

'use strict';

import { serializeConfigMutation } from '../configCoordinator.js';
import { syncWhitelistRules } from '../dnrState.js';
import { normalizeDomain } from './domainValidation.js';

export async function handleWhitelistGet() {
  const { whitelist = [] } = await chrome.storage.local.get('whitelist');
  return { whitelist };
}

export function handleWhitelistAdd(msg) {
  return serializeConfigMutation(async () => {
    const { whitelist = [] } = await chrome.storage.local.get('whitelist');
    const domain = normalizeDomain(msg.domain);
    const valid = domain && !whitelist.includes(domain);

    if (valid) {
      await chrome.storage.local.set({ whitelist: [...whitelist, domain] });
      await syncWhitelistRules();
    }
    return { ok: true };
  });
}

export function sanitizeDomainList(value) {
  const out = [];
  const seen = new Set();
  const source = Array.isArray(value) ? value.slice(0, 1000) : [];
  for (const item of source) {
    const domain = normalizeDomain(item);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push(domain);
  }
  return out;
}

export function handleWhitelistRemove(msg) {
  return serializeConfigMutation(async () => {
    const { whitelist = [] } = await chrome.storage.local.get('whitelist');
    const domain = normalizeDomain(msg.domain);
    const next = domain ? whitelist.filter(d => d !== domain) : whitelist;
    if (next.length !== whitelist.length) {
      await chrome.storage.local.set({ whitelist: next });
      await syncWhitelistRules();
    }
    return { ok: true };
  });
}

// Kept separate from the main whitelist so users can disable Fingerprint
// Randomization on a site without also disabling ad blocking. The scriptlet
// engine watches storage.fprWhitelist, so no DNR-side sync is needed.
export async function handleFprWhitelistGet() {
  const { fprWhitelist = [] } = await chrome.storage.local.get('fprWhitelist');
  return { fprWhitelist };
}

export function handleFprWhitelistAdd(msg) {
  return serializeConfigMutation(async () => {
    const { fprWhitelist = [] } = await chrome.storage.local.get('fprWhitelist');
    const domain = normalizeDomain(msg.domain);
    const valid = domain && !fprWhitelist.includes(domain);

    if (valid) {
      await chrome.storage.local.set({ fprWhitelist: [...fprWhitelist, domain] });
    }
    return { ok: true };
  });
}

export function handleFprWhitelistRemove(msg) {
  return serializeConfigMutation(async () => {
    const { fprWhitelist = [] } = await chrome.storage.local.get('fprWhitelist');
    const domain = normalizeDomain(msg.domain);
    const next = domain ? fprWhitelist.filter(d => d !== domain) : fprWhitelist;
    if (next.length !== fprWhitelist.length) {
      await chrome.storage.local.set({ fprWhitelist: next });
    }
    return { ok: true };
  });
}
