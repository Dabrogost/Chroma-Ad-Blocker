/**
 * Chroma Ad-Blocker - User-provided scriptlet resources.
 *
 * This is intentionally separate from filter-list subscriptions. Filter lists
 * may only call bundled scriptlets; this module manages code the user
 * explicitly adds through the Advanced settings UI and registers via
 * chrome.userScripts.
 */

'use strict';

import { parseScriptletRule } from '../subscriptions/parser.js';

const FETCH_TIMEOUT = 30000;
const MAX_RESOURCE_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESOURCE_CODE_BYTES = 512 * 1024;
const MAX_RESOURCE_COUNT = 100;
const MAX_USER_SOURCES = 20;
const MAX_RULE_TEXT_BYTES = 256 * 1024;
const MAX_USER_RULES = 1000;
const MAX_RULE_LINE_LENGTH = 8192;
const MAX_SOURCE_NAME_LEN = 120;
const RESOURCE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const JS_MIME_RE = /^(?:application|text)\/(?:x-)?(?:javascript|ecmascript)$/i;

export const USER_SCRIPTLET_STORAGE_KEYS = Object.freeze({
  sources: 'userScriptletSources',
  resources: 'userScriptletResources',
  ruleText: 'userScriptletRuleText',
  rules: 'userScriptletRules'
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function utf8ByteLength(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function safeString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function isBlockedIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map(part => Number(part));
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return (
    nums[0] === 0 ||
    nums[0] === 10 ||
    nums[0] === 127 ||
    (nums[0] === 100 && nums[1] >= 64 && nums[1] <= 127) ||
    (nums[0] === 172 && nums[1] >= 16 && nums[1] <= 31) ||
    (nums[0] === 192 && nums[1] === 168) ||
    (nums[0] === 169 && nums[1] === 254) ||
    (nums[0] === 198 && (nums[1] === 18 || nums[1] === 19)) ||
    nums[0] >= 224
  );
}

function isBlockedUserResourceHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  const isIpv6 = host.includes(':');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    isBlockedIpv4(host) ||
    (isIpv6 && (
      host === '::' ||
      host === '::1' ||
      host.startsWith('::ffff:') ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe8') ||
      host.startsWith('fe9') ||
      host.startsWith('fea') ||
      host.startsWith('feb')
    ))
  );
}

export function validateUserScriptletSourceUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, error: 'URL required' };
  }

  let parsed;
  try {
    parsed = new URL(input.trim());
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }

  if (parsed.protocol !== 'https:') return { ok: false, error: 'Only https:// URLs are allowed' };
  if (parsed.username || parsed.password) return { ok: false, error: 'Resource URLs cannot include credentials' };
  if (parsed.port && parsed.port !== '443') return { ok: false, error: 'Resource URL must use the default HTTPS port' };
  if (isBlockedUserResourceHost(parsed.hostname)) return { ok: false, error: 'Local or private resource URLs are not allowed' };

  parsed.hash = '';
  return { ok: true, url: parsed.href, hostname: parsed.hostname };
}

export function normalizeUserScriptletName(name) {
  const cleaned = String(name || '').trim().toLowerCase();
  return cleaned.endsWith('.js') ? cleaned.slice(0, -3) : cleaned;
}

function resourceAliases(name) {
  const full = String(name || '').trim().toLowerCase();
  const normalized = normalizeUserScriptletName(full);
  return Array.from(new Set([full, normalized].filter(Boolean)));
}

function parseHeaderLine(line) {
  const match = line.match(/^([a-z0-9][a-z0-9._-]{0,127})\s+([a-z]+\/[a-z0-9.+-]+)(?:\s+(.*))?$/i);
  if (!match) return null;
  return {
    name: match[1],
    mime: match[2].toLowerCase(),
    rest: match[3] ?? ''
  };
}

function isCommentLine(line) {
  return line.startsWith('!') || line.startsWith('#') || line.startsWith('[') || line.startsWith('//');
}

export function parseUserScriptletResourceText(text, options = {}) {
  if (typeof text !== 'string') throw new Error('Resource response must be text');
  const maxBytes = options.maxBytes || MAX_RESOURCE_RESPONSE_BYTES;
  const responseBytes = utf8ByteLength(text);
  if (responseBytes > maxBytes) {
    throw new Error(`User scriptlet resource is too large: ${responseBytes} bytes exceeds ${maxBytes} byte limit`);
  }

  const resources = [];
  const skipped = {
    malformed: 0,
    unsupportedMime: 0,
    empty: 0,
    duplicate: 0,
    overlong: 0,
    limit: 0
  };
  const seen = new Set();
  let current = null;
  let skippingUnsupported = false;

  const finalize = () => {
    if (!current) return;
    const pending = current;
    current = null;
    const code = pending.lines.join('\n').trim();
    if (!code) {
      skipped.empty++;
      return;
    }
    const codeBytes = utf8ByteLength(code);
    if (codeBytes > MAX_RESOURCE_CODE_BYTES) {
      skipped.overlong++;
      return;
    }
    if (resources.length >= MAX_RESOURCE_COUNT) {
      skipped.limit++;
      return;
    }

    const canonicalName = normalizeUserScriptletName(pending.name);
    if (!canonicalName || !RESOURCE_NAME_RE.test(canonicalName)) {
      skipped.malformed++;
      return;
    }
    if (seen.has(canonicalName)) {
      skipped.duplicate++;
      return;
    }
    seen.add(canonicalName);
    resources.push({
      name: canonicalName,
      displayName: pending.name,
      aliases: resourceAliases(pending.name),
      mime: pending.mime,
      code,
      codeBytes
    });
  };

  const normalizedText = text.replace(/\r\n?/g, '\n');
  const lines = normalizedText.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const header = line ? parseHeaderLine(line) : null;

    if (header) {
      finalize();
      skippingUnsupported = false;
      if (!RESOURCE_NAME_RE.test(header.name)) {
        skipped.malformed++;
        continue;
      }
      if (!JS_MIME_RE.test(header.mime)) {
        skipped.unsupportedMime++;
        skippingUnsupported = true;
        continue;
      }
      current = {
        name: header.name,
        mime: header.mime,
        lines: header.rest ? [header.rest] : []
      };
      continue;
    }

    if (!current) {
      if (!line || isCommentLine(line) || skippingUnsupported) continue;
      skipped.malformed++;
      continue;
    }

    current.lines.push(rawLine);
  }

  finalize();

  if (resources.length === 0) {
    throw new Error('No JavaScript scriptlet resources found');
  }

  return { resources, skipped };
}

export function parseUserScriptletRuleText(text, options = {}) {
  if (typeof text !== 'string') {
    return { ok: false, rules: [], errors: [{ line: 0, message: 'Rules must be text' }] };
  }
  const maxBytes = options.maxBytes || MAX_RULE_TEXT_BYTES;
  const textBytes = utf8ByteLength(text);
  if (textBytes > maxBytes) {
    return {
      ok: false,
      rules: [],
      errors: [{ line: 0, message: `Rules exceed ${maxBytes} byte limit` }]
    };
  }

  const rules = [];
  const errors = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (!line || isCommentLine(line)) continue;

    if (line.length > MAX_RULE_LINE_LENGTH) {
      errors.push({ line: lineNumber, message: 'Rule line is too long' });
      continue;
    }
    if (rules.length >= MAX_USER_RULES) {
      errors.push({ line: lineNumber, message: `User scriptlet rule limit is ${MAX_USER_RULES}` });
      break;
    }

    const parsed = parseScriptletRule(line);
    if (!parsed) {
      errors.push({ line: lineNumber, message: 'Invalid scriptlet rule' });
      continue;
    }

    rules.push({
      ...parsed,
      scriptlet: normalizeUserScriptletName(parsed.scriptlet),
      source: 'user'
    });
  }

  return { ok: errors.length === 0, rules, errors };
}

function getHeader(res, name) {
  if (!res.headers || typeof res.headers.get !== 'function') return null;
  return res.headers.get(name);
}

async function readResponseTextWithLimit(res, maxBytes) {
  const contentLength = Number(getHeader(res, 'content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`User scriptlet resource is too large: ${contentLength} bytes exceeds ${maxBytes} byte limit`);
  }

  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    const bytes = utf8ByteLength(text);
    if (bytes > maxBytes) {
      throw new Error(`User scriptlet resource is too large: ${bytes} bytes exceeds ${maxBytes} byte limit`);
    }
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let bytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength !== undefined ? value.byteLength : utf8ByteLength(String(value));
    if (bytes > maxBytes) {
      if (typeof reader.cancel === 'function') await reader.cancel().catch(() => {});
      throw new Error(`User scriptlet resource is too large: exceeds ${maxBytes} byte limit`);
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}

async function sha256Hex(text) {
  try {
    if (!globalThis.crypto?.subtle || typeof TextEncoder === 'undefined') return null;
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

function makeSourceId() {
  const bytes = new Uint8Array(8);
  if (globalThis.crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  const suffix = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `usr_${Date.now().toString(36)}_${suffix}`;
}

async function fetchUserScriptletSource(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  const headers = {};
  if (source.etag) headers['If-None-Match'] = source.etag;
  if (source.lastModified) headers['If-Modified-Since'] = source.lastModified;

  try {
    const res = await fetch(source.url, { signal: controller.signal, cache: 'no-cache', headers });
    const etag = getHeader(res, 'etag');
    const lastModified = getHeader(res, 'last-modified');
    if (res.status === 304) {
      return {
        notModified: true,
        etag: etag || source.etag || null,
        lastModified: lastModified || source.lastModified || null
      };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return {
      text: await readResponseTextWithLimit(res, MAX_RESOURCE_RESPONSE_BYTES),
      etag: etag || null,
      lastModified: lastModified || null
    };
  } finally {
    clearTimeout(timer);
  }
}

function sourceSafeView(source) {
  const item = asObject(source);
  return {
    id: item.id,
    name: item.name,
    url: item.url,
    addedAt: item.addedAt || null,
    lastUpdated: item.lastUpdated || 0,
    lastError: item.lastError || null,
    sha256: item.sha256 || null,
    resourceCount: Number(item.resourceCount) || 0,
    resourceNames: asArray(item.resourceNames).slice(0, MAX_RESOURCE_COUNT)
  };
}

function buildResourceEntries(parsedResources, sourceId, updatedAt) {
  return parsedResources.map(resource => ({
    name: resource.name,
    displayName: resource.displayName,
    aliases: resource.aliases,
    sourceId,
    mime: resource.mime,
    code: resource.code,
    codeBytes: resource.codeBytes,
    updatedAt
  }));
}

async function attachHashes(entries) {
  return Promise.all(entries.map(async entry => ({
    ...entry,
    sha256: await sha256Hex(entry.code)
  })));
}

function mergeSourceResources(existingResources, sourceId, entries) {
  const next = { ...asObject(existingResources) };
  for (const [name, resource] of Object.entries(next)) {
    if (resource?.sourceId === sourceId) delete next[name];
  }

  for (const entry of entries) {
    if (next[entry.name] && next[entry.name]?.sourceId !== sourceId) {
      throw new Error(`Scriptlet resource name already exists: ${entry.name}`);
    }
    next[entry.name] = entry;
  }

  return next;
}

async function persistRefreshedSource(source, fetched, existingSources, existingResources) {
  const now = Date.now();
  if (fetched.notModified) {
    const nextSources = existingSources.map(item => item.id === source.id
      ? {
          ...item,
          lastUpdated: now,
          lastError: null,
          etag: fetched.etag,
          lastModified: fetched.lastModified
        }
      : item
    );
    await chrome.storage.local.set({ [USER_SCRIPTLET_STORAGE_KEYS.sources]: nextSources });
    return { ok: true, notModified: true };
  }

  const parsed = parseUserScriptletResourceText(fetched.text || '');
  const entries = await attachHashes(buildResourceEntries(parsed.resources, source.id, now));
  const nextResources = mergeSourceResources(existingResources, source.id, entries);
  const sourceHash = await sha256Hex(fetched.text || '');
  const resourceNames = entries.map(entry => entry.displayName || entry.name);

  const nextSources = existingSources.map(item => item.id === source.id
    ? {
        ...item,
        lastUpdated: now,
        lastError: null,
        etag: fetched.etag,
        lastModified: fetched.lastModified,
        sha256: sourceHash,
        resourceCount: entries.length,
        resourceNames
      }
    : item
  );

  await chrome.storage.local.set({
    [USER_SCRIPTLET_STORAGE_KEYS.sources]: nextSources,
    [USER_SCRIPTLET_STORAGE_KEYS.resources]: nextResources
  });

  return {
    ok: true,
    resourceCount: entries.length,
    resourceNames,
    skipped: parsed.skipped
  };
}

export async function getUserScriptletSettings() {
  const {
    userScriptletSources = [],
    userScriptletResources = {},
    userScriptletRuleText = '',
    userScriptletRules = []
  } = await chrome.storage.local.get([
    USER_SCRIPTLET_STORAGE_KEYS.sources,
    USER_SCRIPTLET_STORAGE_KEYS.resources,
    USER_SCRIPTLET_STORAGE_KEYS.ruleText,
    USER_SCRIPTLET_STORAGE_KEYS.rules
  ]);

  return {
    sources: asArray(userScriptletSources).map(sourceSafeView),
    ruleText: typeof userScriptletRuleText === 'string' ? userScriptletRuleText : '',
    parsedRuleCount: asArray(userScriptletRules).length,
    availableResourceNames: Object.values(asObject(userScriptletResources))
      .map(resource => resource?.displayName || resource?.name)
      .filter(Boolean)
      .sort()
  };
}

export async function addUserScriptletSource(input) {
  const validation = validateUserScriptletSourceUrl(input?.url);
  if (!validation.ok) return { ok: false, error: validation.error };

  const { userScriptletSources = [], userScriptletResources = {} } = await chrome.storage.local.get([
    USER_SCRIPTLET_STORAGE_KEYS.sources,
    USER_SCRIPTLET_STORAGE_KEYS.resources
  ]);
  const sources = asArray(userScriptletSources);
  if (sources.length >= MAX_USER_SOURCES) return { ok: false, error: `User resource limit is ${MAX_USER_SOURCES}` };
  if (sources.some(source => source?.url === validation.url)) return { ok: false, error: 'Resource URL already added' };

  const now = Date.now();
  const source = {
    id: makeSourceId(),
    name: safeString(input?.name, MAX_SOURCE_NAME_LEN) || validation.hostname,
    url: validation.url,
    addedAt: now,
    lastUpdated: 0,
    lastError: null,
    etag: null,
    lastModified: null,
    sha256: null,
    resourceCount: 0,
    resourceNames: []
  };

  try {
    const fetched = await fetchUserScriptletSource(source);
    const nextSources = sources.concat(source);
    const result = await persistRefreshedSource(source, fetched, nextSources, userScriptletResources);
    const settings = await getUserScriptletSettings();
    return {
      ...result,
      source: settings.sources.find(item => item.id === source.id) || sourceSafeView(source)
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function refreshUserScriptletSource(id) {
  const { userScriptletSources = [], userScriptletResources = {} } = await chrome.storage.local.get([
    USER_SCRIPTLET_STORAGE_KEYS.sources,
    USER_SCRIPTLET_STORAGE_KEYS.resources
  ]);
  const sources = asArray(userScriptletSources);
  const source = sources.find(item => item?.id === id);
  if (!source) return { ok: false, error: 'User scriptlet resource not found' };

  try {
    const fetched = await fetchUserScriptletSource(source);
    return persistRefreshedSource(source, fetched, sources, userScriptletResources);
  } catch (err) {
    const error = err?.message || String(err);
    const nextSources = sources.map(item => item.id === id ? { ...item, lastError: error } : item);
    await chrome.storage.local.set({ [USER_SCRIPTLET_STORAGE_KEYS.sources]: nextSources });
    return { ok: false, error };
  }
}

export async function removeUserScriptletSource(id) {
  const { userScriptletSources = [], userScriptletResources = {} } = await chrome.storage.local.get([
    USER_SCRIPTLET_STORAGE_KEYS.sources,
    USER_SCRIPTLET_STORAGE_KEYS.resources
  ]);
  const sources = asArray(userScriptletSources);
  const nextSources = sources.filter(source => source?.id !== id);
  if (nextSources.length === sources.length) return { ok: false, error: 'User scriptlet resource not found' };

  const nextResources = { ...asObject(userScriptletResources) };
  for (const [name, resource] of Object.entries(nextResources)) {
    if (resource?.sourceId === id) delete nextResources[name];
  }

  await chrome.storage.local.set({
    [USER_SCRIPTLET_STORAGE_KEYS.sources]: nextSources,
    [USER_SCRIPTLET_STORAGE_KEYS.resources]: nextResources
  });
  return { ok: true };
}

export async function setUserScriptletRuleText(text) {
  const ruleText = typeof text === 'string' ? text : '';
  const parsed = parseUserScriptletRuleText(ruleText);
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.errors[0]?.line
        ? `Line ${parsed.errors[0].line}: ${parsed.errors[0].message}`
        : (parsed.errors[0]?.message || 'Invalid user scriptlet rules'),
      errors: parsed.errors.slice(0, 20)
    };
  }

  await chrome.storage.local.set({
    [USER_SCRIPTLET_STORAGE_KEYS.ruleText]: ruleText,
    [USER_SCRIPTLET_STORAGE_KEYS.rules]: parsed.rules
  });
  return { ok: true, parsedRuleCount: parsed.rules.length };
}

export async function exportUserScriptletSettings() {
  const { userScriptletSources = [], userScriptletRuleText = '' } = await chrome.storage.local.get([
    USER_SCRIPTLET_STORAGE_KEYS.sources,
    USER_SCRIPTLET_STORAGE_KEYS.ruleText
  ]);
  const sources = asArray(userScriptletSources).map(source => ({
    name: safeString(source?.name, MAX_SOURCE_NAME_LEN),
    url: source?.url
  })).filter(source => validateUserScriptletSourceUrl(source.url).ok);

  return {
    sources,
    ruleText: typeof userScriptletRuleText === 'string' ? userScriptletRuleText : ''
  };
}

export async function importUserScriptletSettings(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: true, importedSources: 0, importedRules: 0 };
  }

  const sources = [];
  const usedUrls = new Set();
  for (const candidate of asArray(payload.sources).slice(0, MAX_USER_SOURCES)) {
    const validation = validateUserScriptletSourceUrl(candidate?.url);
    if (!validation.ok || usedUrls.has(validation.url)) continue;
    usedUrls.add(validation.url);
    sources.push({
      id: makeSourceId(),
      name: safeString(candidate?.name, MAX_SOURCE_NAME_LEN) || validation.hostname,
      url: validation.url,
      addedAt: Date.now(),
      lastUpdated: 0,
      lastError: null,
      etag: null,
      lastModified: null,
      sha256: null,
      resourceCount: 0,
      resourceNames: []
    });
  }

  const ruleText = typeof payload.ruleText === 'string' ? payload.ruleText : '';
  const parsed = parseUserScriptletRuleText(ruleText);
  const safeRuleText = parsed.ok ? ruleText : '';
  const rules = parsed.ok ? parsed.rules : [];

  await chrome.storage.local.set({
    [USER_SCRIPTLET_STORAGE_KEYS.sources]: sources,
    [USER_SCRIPTLET_STORAGE_KEYS.resources]: {},
    [USER_SCRIPTLET_STORAGE_KEYS.ruleText]: safeRuleText,
    [USER_SCRIPTLET_STORAGE_KEYS.rules]: rules
  });

  return {
    ok: true,
    importedSources: sources.length,
    importedRules: rules.length
  };
}
