/**
 * Local element-zapper message handlers and session validation.
 */

'use strict';

import { domainMatches, normalizeDomain } from './domainValidation.js';

const ZAPPER_SESSION_TTL_MS = 2 * 60 * 1000;
const ZAPPER_MAX_RULES = 500;
const ZAPPER_MAX_SELECTOR_LEN = 512;
const ZAPPER_MAX_MATCHES = 5;
const zapperSessions = new Map();

function clearZapperSession(tabId) {
  const session = zapperSessions.get(tabId);
  if (session?.timeoutId) clearTimeout(session.timeoutId);
  zapperSessions.delete(tabId);
}

function createZapperToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function startZapperSession(tabId) {
  clearZapperSession(tabId);
  const token = createZapperToken();
  const timeoutId = setTimeout(() => clearZapperSession(tabId), ZAPPER_SESSION_TTL_MS);
  zapperSessions.set(tabId, {
    token,
    createdAt: Date.now(),
    timeoutId
  });
  return token;
}

function isValidZapperSelectorText(input) {
  if (typeof input !== 'string') return false;
  const selector = input.trim();
  if (!selector || selector.length > ZAPPER_MAX_SELECTOR_LEN) return false;
  if (/[\x00-\x1f\x7f]/.test(selector)) return false;
  if (/^\s*(\/|xpath\s*:)/i.test(selector)) return false;
  if (/[{};]/.test(selector)) return false;
  if (/(^|[^\\]):has\s*\(/i.test(selector)) return false;
  if (/\b(?:script|javascript)\s*:/i.test(selector)) return false;
  return true;
}

async function validateZapperSelectorInTab(tabId, selector) {
  if (!isValidZapperSelectorText(selector)) {
    return { ok: false, error: 'Invalid selector' };
  }

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'ISOLATED',
      func: (sel, maxMatches) => {
        try {
          const matches = document.querySelectorAll(sel).length;
          return {
            ok: matches > 0 && matches <= maxMatches,
            count: matches
          };
        } catch {
          return { ok: false, count: 0 };
        }
      },
      args: [selector, ZAPPER_MAX_MATCHES]
    });

    const value = result?.result;
    if (!value?.ok) {
      return {
        ok: false,
        error: value?.count > ZAPPER_MAX_MATCHES ? 'Selector matches too many elements' : 'Invalid selector'
      };
    }
    return { ok: true, count: value.count };
  } catch {
    return { ok: false, error: 'Could not validate selector on this tab' };
  }
}

function sanitizeZapperRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
  const id = typeof rule.id === 'string' && /^zapper_[a-z0-9_-]{1,64}$/i.test(rule.id) ? rule.id : null;
  const domain = normalizeDomain(rule.domain);
  const selector = typeof rule.selector === 'string' ? rule.selector.trim() : '';
  const createdAt = Number.isSafeInteger(rule.createdAt) ? rule.createdAt : Date.now();
  if (!id || !domain || !isValidZapperSelectorText(selector)) return null;
  return {
    id,
    domain,
    selector,
    enabled: rule.enabled !== false,
    createdAt,
    source: 'zapper'
  };
}

async function getStoredZapperRules() {
  const { localCosmeticRules = [] } = await chrome.storage.local.get('localCosmeticRules');
  return Array.isArray(localCosmeticRules)
    ? localCosmeticRules.map(sanitizeZapperRule).filter(Boolean).slice(-ZAPPER_MAX_RULES)
    : [];
}

async function getActiveHttpTab(msg) {
  let tab = null;
  if (Number.isInteger(msg.tabId)) {
    try {
      tab = await chrome.tabs.get(msg.tabId);
    } catch {
      tab = null;
    }
  } else {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = activeTab || null;
  }

  if (!tab?.id || !tab.url) return null;
  try {
    const url = new URL(tab.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return tab;
}

export async function handleZapperStart(msg) {
  const tab = await getActiveHttpTab(msg);
  if (!tab) return { ok: false, error: 'Element zapper only works on http and https pages.' };

  const token = startZapperSession(tab.id);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      files: ['content/zapper.js'],
      world: 'ISOLATED'
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      world: 'ISOLATED',
      func: (sessionToken) => {
        globalThis.__CHROMA_START_ZAPPER__?.(sessionToken);
      },
      args: [token]
    });
    return { ok: true };
  } catch {
    clearZapperSession(tab.id);
    return { ok: false, error: 'Could not start the zapper on this site. Check extension site access for this page.' };
  }
}

export async function handleZapperSaveRule(msg, sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) return { ok: false, error: 'Missing tab context' };

  const session = zapperSessions.get(tabId);
  if (!session || typeof msg.token !== 'string' || msg.token !== session.token) {
    return { ok: false, error: 'Invalid zapper session' };
  }

  if (msg.action === 'cancel' || msg.action === 'hideOnce') {
    clearZapperSession(tabId);
    return { ok: true };
  }

  try {
    const pageUrl = sender.tab?.url ? new URL(sender.tab.url) : null;
    const senderHost = pageUrl?.hostname?.toLowerCase() || '';
    const domain = normalizeDomain(msg.domain);
    if (!domain || !senderHost || !domainMatches(senderHost, domain)) {
      return { ok: false, error: 'Invalid domain' };
    }

    const selector = typeof msg.selector === 'string' ? msg.selector.trim() : '';
    const validation = await validateZapperSelectorInTab(tabId, selector);
    if (!validation.ok) return validation;

    const existing = await getStoredZapperRules();
    const rule = {
      id: `zapper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      domain,
      selector,
      enabled: true,
      createdAt: Date.now(),
      source: 'zapper'
    };

    const next = [...existing, rule].slice(-ZAPPER_MAX_RULES);
    await chrome.storage.local.set({ localCosmeticRules: next });
    return { ok: true, rule };
  } finally {
    clearZapperSession(tabId);
  }
}

export async function handleZapperRulesGet() {
  return { rules: await getStoredZapperRules() };
}

export async function handleZapperRuleRemove(msg) {
  const id = typeof msg.id === 'string' ? msg.id : '';
  const existing = await getStoredZapperRules();
  const next = existing.filter(rule => rule.id !== id);
  if (next.length !== existing.length) {
    await chrome.storage.local.set({ localCosmeticRules: next });
  }
  return { ok: true };
}

export async function handleZapperRuleSet(msg) {
  const id = typeof msg.id === 'string' ? msg.id : '';
  if (typeof msg.enabled !== 'boolean') return { ok: false, error: 'Invalid rule state' };
  const enabled = msg.enabled === true;
  const existing = await getStoredZapperRules();
  let changed = false;
  const next = existing.map(rule => {
    if (rule.id !== id) return rule;
    changed = true;
    return { ...rule, enabled };
  });
  if (changed) {
    await chrome.storage.local.set({ localCosmeticRules: next });
  }
  return { ok: true };
}
