/**
 * Chroma Power Statistics.
 *
 * Owns the local-only statsV2 schema, event aggregation, retention, caps,
 * privacy normalization, reset, and export behavior.
 */

'use strict';

export const STATS_STORAGE_KEY = 'statsV2';

const STATS_VERSION = 1;
const DEFAULT_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 365;
const RECENT_EVENTS_CAP = 500;
const BY_SITE_CAP = 250;
const BY_RULE_CAP = 500;
const BY_RESOURCE_TYPE_CAP = 50;
const FLUSH_DELAY_MS = 500;
const QUEUE_CAP = 1000;
const TIME_SAVED_SECONDS_PER_PROTECTION_EVENT = 0.005;

const MODE_VALUES = new Set(['basic', 'aggregated', 'debug']);

const TOTAL_COUNTER_KEYS = [
  'protectionEvents',
  'networkBlocks',
  'networkAllows',
  'unknownDnrMatches',
  'cosmeticHides',
  'warningSuppressions',
  'youtubePayloadInspections',
  'youtubePayloadsModified',
  'youtubePayloadCleans',
  'youtubeFieldsPruned',
  'youtubeAdObjectsRemoved',
  'scriptletHits',
  'scriptletErrors',
  'zapperHits',
  'proxyTests',
  'proxyTestPasses',
  'proxyTestFailures',
  'proxyAuthChallenges',
  'fprActivations'
];
const TOTAL_COUNTER_KEY_SET = new Set(TOTAL_COUNTER_KEYS);

function emptyTotals() {
  const totals = {};
  for (const key of TOTAL_COUNTER_KEYS) totals[key] = 0;
  return totals;
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function safeCount(value, fallback = 1) {
  return clampInteger(value, fallback, 0, 100000);
}

function normalizeMode(value) {
  return MODE_VALUES.has(value) ? value : 'aggregated';
}

function normalizeSettings(input = {}) {
  const mode = normalizeMode(input.mode);
  return {
    mode,
    retentionDays: clampInteger(input.retentionDays, DEFAULT_RETENTION_DAYS, 1, MAX_RETENTION_DAYS),
    storeFullUrls: mode === 'debug' && input.storeFullUrls !== false
  };
}

export function createDefaultStatsV2(settings = {}) {
  return {
    version: STATS_VERSION,
    settings: normalizeSettings(settings),
    totals: emptyTotals(),
    byDay: {},
    bySite: {},
    byResourceType: {},
    byRule: {},
    recentEvents: []
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function extractDomainFromUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return normalizeDomain(parsed.hostname);
  } catch {
    return null;
  }
}

function normalizeDomain(input) {
  if (typeof input !== 'string') return null;
  const domain = input.trim().toLowerCase().replace(/\.$/, '');
  if (
    !domain ||
    domain.length > 253 ||
    domain.includes('/') ||
    domain.includes(':') ||
    domain.includes(' ') ||
    domain.includes('?') ||
    domain.includes('#') ||
    domain.startsWith('.') ||
    domain.endsWith('.') ||
    !/^[a-z0-9.-]+$/i.test(domain) ||
    domain.includes('..')
  ) {
    return null;
  }
  return domain;
}

function sanitizeToken(value, maxLength = 120) {
  if (value === undefined || value === null) return null;
  const out = String(value)
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[^\w.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLength);
  return out || null;
}

export function sanitizeErrorText(value, maxLength = 180) {
  if (value === undefined || value === null) return null;
  const out = String(value)
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[email]')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  return out || null;
}

function sanitizeFullUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.username = '';
    parsed.password = '';
    return parsed.href.slice(0, 2048);
  } catch {
    return null;
  }
}

function dayKey(ts) {
  const date = new Date(Number(ts) || Date.now());
  return date.toISOString().slice(0, 10);
}

function normalizeCounters(input) {
  const out = emptyTotals();
  if (!input || typeof input !== 'object') return out;
  for (const key of TOTAL_COUNTER_KEYS) {
    const value = Number(input[key]);
    out[key] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }
  return out;
}

function normalizeCounterBucket(input, base = {}) {
  return {
    ...base,
    ...normalizeCounters(input)
  };
}

function addPayloadDetails(out, event) {
  out.source = sanitizeToken(event.source, 80);
  const payloadsInspected = safeCount(event.payloadsInspected ?? event.inspected, 0);
  const payloadsModified = safeCount(event.payloadsModified ?? event.modified, 0);
  const fieldsPruned = safeCount(event.fieldsPruned, 0);
  const adObjectsRemoved = safeCount(event.adObjectsRemoved, 0);

  if (payloadsInspected > 0) out.payloadsInspected = payloadsInspected;
  if (payloadsModified > 0) out.payloadsModified = payloadsModified;
  if (fieldsPruned > 0) out.fieldsPruned = fieldsPruned;
  if (adObjectsRemoved > 0) out.adObjectsRemoved = adObjectsRemoved;
}

function normalizeStats(raw) {
  const settings = normalizeSettings(raw?.settings);
  const stats = createDefaultStatsV2(settings);

  if (!raw || typeof raw !== 'object') return stats;

  stats.totals = normalizeCounters(raw.totals);

  if (raw.byDay && typeof raw.byDay === 'object' && !Array.isArray(raw.byDay)) {
    for (const [key, value] of Object.entries(raw.byDay)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
        stats.byDay[key] = normalizeCounterBucket(value, { day: key });
      }
    }
  }

  if (raw.bySite && typeof raw.bySite === 'object' && !Array.isArray(raw.bySite)) {
    for (const [key, value] of Object.entries(raw.bySite)) {
      const domain = normalizeDomain(value?.domain || key);
      if (!domain) continue;
      stats.bySite[domain] = normalizeCounterBucket(value, {
        domain,
        lastSeen: Number(value?.lastSeen) || 0
      });
    }
  }

  if (raw.byResourceType && typeof raw.byResourceType === 'object' && !Array.isArray(raw.byResourceType)) {
    for (const [key, value] of Object.entries(raw.byResourceType)) {
      const resourceType = sanitizeToken(value?.resourceType || key, 40);
      if (!resourceType) continue;
      stats.byResourceType[resourceType] = normalizeCounterBucket(value, {
        resourceType,
        lastSeen: Number(value?.lastSeen) || 0
      });
    }
  }

  if (raw.byRule && typeof raw.byRule === 'object' && !Array.isArray(raw.byRule)) {
    for (const [key, value] of Object.entries(raw.byRule)) {
      const safeKey = sanitizeToken(key, 180);
      if (!safeKey) continue;
      stats.byRule[safeKey] = normalizeCounterBucket(value, {
        key: safeKey,
        ruleId: Number.isSafeInteger(Number(value?.ruleId)) ? Number(value.ruleId) : null,
        rulesetId: sanitizeToken(value?.rulesetId, 80),
        ruleSource: sanitizeToken(value?.ruleSource, 80),
        scriptlet: sanitizeToken(value?.scriptlet, 120),
        lastSeen: Number(value?.lastSeen) || 0
      });
    }
  }

  stats.recentEvents = Array.isArray(raw.recentEvents)
    ? raw.recentEvents
      .slice(0, RECENT_EVENTS_CAP)
      .map(event => sanitizeStoredRecentEvent(event, stats.settings.storeFullUrls))
      .filter(Boolean)
    : [];

  if (stats.settings.mode === 'basic') clearDetailedStats(stats);
  pruneStats(stats);
  return stats;
}

function sanitizeStoredRecentEvent(event, storeFullUrls = false) {
  if (!event || typeof event !== 'object') return null;
  const layer = sanitizeToken(event.layer, 40);
  const type = sanitizeToken(event.type, 40);
  if (!layer || !type) return null;
  const out = {
    ts: Number(event.ts) || Date.now(),
    layer,
    type,
    domain: normalizeDomain(event.domain),
    resourceType: sanitizeToken(event.resourceType, 40),
    ruleId: Number.isSafeInteger(Number(event.ruleId)) ? Number(event.ruleId) : null,
    rulesetId: sanitizeToken(event.rulesetId, 80),
    ruleSource: sanitizeToken(event.ruleSource, 80),
    scriptlet: sanitizeToken(event.scriptlet, 120),
    count: safeCount(event.count, 1),
    error: sanitizeErrorText(event.error)
  };
  if (layer === 'youtube' && type === 'payload') addPayloadDetails(out, event);
  if (storeFullUrls) out.url = sanitizeFullUrl(event.url);
  Object.keys(out).forEach(key => {
    if (out[key] === null || out[key] === undefined) delete out[key];
  });
  return out;
}

async function readStoredStats() {
  const data = await chrome.storage.local.get(STATS_STORAGE_KEY);
  return normalizeStats(data?.[STATS_STORAGE_KEY]);
}

async function writeStoredStats(stats) {
  await chrome.storage.local.set({ [STATS_STORAGE_KEY]: stats });
}

async function ensureStatsV2() {
  const data = await chrome.storage.local.get(STATS_STORAGE_KEY);
  const existing = data?.[STATS_STORAGE_KEY];
  const normalized = normalizeStats(existing);
  if (!existing || existing.version !== STATS_VERSION || JSON.stringify(existing) !== JSON.stringify(normalized)) {
    await writeStoredStats(normalized);
  }
  return normalized;
}

let statsQueue = [];
let flushTimer = null;
let flushChain = Promise.resolve();

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushStatsQueue().catch(() => {});
  }, FLUSH_DELAY_MS);
}

export function recordStatsEvent(event) {
  if (!event || typeof event !== 'object') return;
  statsQueue.push(event);
  if (statsQueue.length > QUEUE_CAP) {
    statsQueue = statsQueue.slice(-QUEUE_CAP);
  }
  scheduleFlush();
}

export function recordStatsEvents(events) {
  if (!Array.isArray(events)) return;
  for (const event of events) recordStatsEvent(event);
}

export async function flushStatsQueue() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  const batch = statsQueue.splice(0);
  if (batch.length === 0) {
    await ensureStatsV2();
    return;
  }

  flushChain = flushChain.then(async () => {
    const stats = await readStoredStats();
    applyStatsBatch(stats, batch);
    await writeStoredStats(stats);
  });

  await flushChain;

  if (statsQueue.length > 0) {
    return flushStatsQueue();
  }
}

function applyStatsBatch(stats, batch) {
  for (const event of batch) {
    applyStatsEvent(stats, event);
  }
  pruneStats(stats);
}

function buildCounterPatch(event) {
  const layer = sanitizeToken(event.layer, 40);
  const type = sanitizeToken(event.type, 40);
  const count = safeCount(event.count, 1);
  const patch = {};

  const add = (key, amount = count) => {
    if (!TOTAL_COUNTER_KEY_SET.has(key)) return;
    patch[key] = (patch[key] || 0) + safeCount(amount, 0);
  };

  if (layer === 'network') {
    if (type === 'block') {
      add('networkBlocks');
      add('protectionEvents');
    } else if (type === 'allow') {
      add('networkAllows');
    } else {
      add('unknownDnrMatches');
    }
  } else if (layer === 'cosmetic') {
    add('cosmeticHides');
    add('protectionEvents');
  } else if (layer === 'warning') {
    add('warningSuppressions');
    add('protectionEvents');
  } else if (layer === 'youtube') {
    const inspected = safeCount(event.payloadsInspected ?? event.inspected, type === 'payload' ? count : 0);
    const modified = safeCount(event.payloadsModified ?? event.modified, 0);
    const cleans = safeCount(event.cleans, modified || (type === 'payload_clean' ? count : 0));
    const fields = safeCount(event.fieldsPruned, type === 'field_pruned' ? count : 0);
    const objects = safeCount(event.adObjectsRemoved, 0);
    add('youtubePayloadInspections', inspected);
    add('youtubePayloadsModified', modified);
    add('youtubePayloadCleans', cleans);
    add('youtubeFieldsPruned', fields);
    add('youtubeAdObjectsRemoved', objects);
    if (cleans > 0 || fields > 0 || objects > 0 || modified > 0) {
      add('protectionEvents', Math.max(cleans, modified, count));
    }
  } else if (layer === 'scriptlet') {
    if (type === 'error') {
      add('scriptletErrors');
    } else {
      add('scriptletHits');
      add('protectionEvents');
    }
  } else if (layer === 'zapper') {
    add('zapperHits');
    add('protectionEvents');
  } else if (layer === 'proxy') {
    if (type === 'test_pass') {
      add('proxyTests');
      add('proxyTestPasses');
    } else if (type === 'test_failure') {
      add('proxyTests');
      add('proxyTestFailures');
    } else if (type === 'auth_challenge') {
      add('proxyAuthChallenges');
    } else if (type === 'test') {
      add('proxyTests');
    }
  } else if (layer === 'fingerprint') {
    add('fprActivations');
    add('protectionEvents');
  }

  return patch;
}

function addPatch(target, patch) {
  for (const [key, amount] of Object.entries(patch)) {
    if (!TOTAL_COUNTER_KEY_SET.has(key)) continue;
    target[key] = (Number(target[key]) || 0) + amount;
  }
}

function applyStatsEvent(stats, rawEvent) {
  const settings = stats.settings;
  const ts = Number(rawEvent.ts) || Date.now();
  const domain = normalizeDomain(rawEvent.domain) || extractDomainFromUrl(rawEvent.url);
  const resourceType = sanitizeToken(rawEvent.resourceType, 40);
  const event = {
    ...rawEvent,
    ts,
    domain,
    resourceType,
    layer: sanitizeToken(rawEvent.layer, 40),
    type: sanitizeToken(rawEvent.type, 40),
    ruleId: Number.isSafeInteger(Number(rawEvent.ruleId)) ? Number(rawEvent.ruleId) : null,
    rulesetId: sanitizeToken(rawEvent.rulesetId, 80),
    ruleSource: sanitizeToken(rawEvent.ruleSource, 80),
    scriptlet: sanitizeToken(rawEvent.scriptlet, 120),
    source: sanitizeToken(rawEvent.source, 80),
    error: sanitizeErrorText(rawEvent.error)
  };
  if (!event.layer || !event.type) return;

  const patch = buildCounterPatch(event);
  if (Object.keys(patch).length === 0) return;

  addPatch(stats.totals, patch);

  if (settings.mode === 'basic') return;

  const day = dayKey(ts);
  if (!stats.byDay[day]) stats.byDay[day] = normalizeCounterBucket(null, { day });
  addPatch(stats.byDay[day], patch);

  if (domain) {
    if (!stats.bySite[domain]) stats.bySite[domain] = normalizeCounterBucket(null, { domain, lastSeen: 0 });
    stats.bySite[domain].lastSeen = Math.max(Number(stats.bySite[domain].lastSeen) || 0, ts);
    addPatch(stats.bySite[domain], patch);
  }

  if (resourceType) {
    if (!stats.byResourceType[resourceType]) {
      stats.byResourceType[resourceType] = normalizeCounterBucket(null, { resourceType, lastSeen: 0 });
    }
    stats.byResourceType[resourceType].lastSeen = Math.max(Number(stats.byResourceType[resourceType].lastSeen) || 0, ts);
    addPatch(stats.byResourceType[resourceType], patch);
  }

  const ruleKey = getRuleKey(event);
  if (ruleKey) {
    if (!stats.byRule[ruleKey]) {
      stats.byRule[ruleKey] = normalizeCounterBucket(null, {
        key: ruleKey,
        ruleId: event.ruleId,
        rulesetId: event.rulesetId,
        ruleSource: event.ruleSource,
        scriptlet: event.scriptlet,
        lastSeen: 0
      });
    }
    stats.byRule[ruleKey].lastSeen = Math.max(Number(stats.byRule[ruleKey].lastSeen) || 0, ts);
    addPatch(stats.byRule[ruleKey], patch);
  }

  stats.recentEvents.unshift(buildRecentEvent(event, settings));
}

function getRuleKey(event) {
  if (event.layer === 'scriptlet' && event.scriptlet) {
    return sanitizeToken(`scriptlet:${event.ruleSource || 'subscription'}:${event.scriptlet}`, 180);
  }
  if (event.ruleId !== null && event.ruleId !== undefined) {
    const source = event.ruleSource || 'dnr';
    const ruleset = event.rulesetId || 'dynamic';
    return sanitizeToken(`${source}:${ruleset}:${event.ruleId}`, 180);
  }
  return null;
}

function buildRecentEvent(event, settings) {
  const out = {
    ts: event.ts,
    layer: event.layer,
    type: event.type,
    domain: event.domain,
    resourceType: event.resourceType,
    ruleId: event.ruleId,
    rulesetId: event.rulesetId,
    ruleSource: event.ruleSource,
    scriptlet: event.scriptlet,
    count: safeCount(event.count, 1),
    error: event.error
  };

  if (event.layer === 'youtube' && event.type === 'payload') addPayloadDetails(out, event);

  if (settings.storeFullUrls) {
    out.url = sanitizeFullUrl(event.url);
  }

  Object.keys(out).forEach(key => {
    if (out[key] === null || out[key] === undefined) delete out[key];
  });
  return out;
}

function pruneStats(stats) {
  pruneByDay(stats);
  stats.recentEvents = stats.recentEvents.slice(0, RECENT_EVENTS_CAP);
  stats.bySite = capObject(stats.bySite, BY_SITE_CAP);
  stats.byRule = capObject(stats.byRule, BY_RULE_CAP);
  stats.byResourceType = capObject(stats.byResourceType, BY_RESOURCE_TYPE_CAP);
}

function clearDetailedStats(stats) {
  stats.byDay = {};
  stats.bySite = {};
  stats.byResourceType = {};
  stats.byRule = {};
  stats.recentEvents = [];
}

function pruneByDay(stats) {
  const retentionDays = stats.settings.retentionDays;
  const cutoff = Date.now() - (retentionDays - 1) * 24 * 60 * 60 * 1000;
  const cutoffDay = dayKey(cutoff);
  for (const key of Object.keys(stats.byDay)) {
    if (key < cutoffDay) delete stats.byDay[key];
  }
}

function capObject(input, cap) {
  const entries = Object.entries(input || {});
  if (entries.length <= cap) return input || {};
  entries.sort((a, b) => {
    const aValue = bucketActivity(a[1]);
    const bValue = bucketActivity(b[1]);
    if (bValue !== aValue) return bValue - aValue;
    return (Number(b[1]?.lastSeen) || 0) - (Number(a[1]?.lastSeen) || 0);
  });
  return Object.fromEntries(entries.slice(0, cap));
}

function bucketActivity(bucket) {
  if (!bucket || typeof bucket !== 'object') return 0;
  return (
    (Number(bucket.protectionEvents) || 0) +
    (Number(bucket.networkAllows) || 0) +
    (Number(bucket.unknownDnrMatches) || 0) +
    (Number(bucket.scriptletErrors) || 0) +
    (Number(bucket.proxyTests) || 0) +
    (Number(bucket.proxyAuthChallenges) || 0)
  );
}

function sumRange(stats, days) {
  const out = emptyTotals();
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    const key = dayKey(now - i * 24 * 60 * 60 * 1000);
    if (stats.byDay[key]) addPatch(out, stats.byDay[key]);
  }
  return out;
}

function estimateTimeSavedSeconds(totals = {}) {
  // Estimate only: each protection event is worth 5ms, floored to avoid rounding up.
  const events = Number(totals.protectionEvents) || 0;
  return Math.max(0, Math.floor(events * TIME_SAVED_SECONDS_PER_PROTECTION_EVENT));
}

export async function getStatsSnapshot(options = {}) {
  await flushStatsQueue();
  const stats = await ensureStatsV2();
  const snapshot = cloneJson(stats);

  snapshot.ranges = {
    today: sumRange(stats, 1),
    last7Days: sumRange(stats, 7),
    last30Days: sumRange(stats, 30),
    allTime: cloneJson(stats.totals)
  };
  snapshot.timeSavedSeconds = estimateTimeSavedSeconds(stats.totals);
  snapshot.limits = {
    recentEvents: RECENT_EVENTS_CAP,
    bySite: BY_SITE_CAP,
    byRule: BY_RULE_CAP,
    byResourceType: BY_RESOURCE_TYPE_CAP,
    byDayRetentionDays: stats.settings.retentionDays
  };

  if (options.includeRecentEvents === false) {
    snapshot.recentEvents = [];
  }
  return snapshot;
}

export async function resetStats(scope = 'all') {
  const normalizedScope = typeof scope === 'string' ? scope : scope?.scope;

  if (normalizedScope === 'all' || normalizedScope === undefined || normalizedScope === null) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    statsQueue = [];
    const current = await ensureStatsV2();
    await writeStoredStats(createDefaultStatsV2(current.settings));
    return { ok: true };
  }

  await flushStatsQueue();
  const stats = await ensureStatsV2();

  if (normalizedScope === 'sites' || normalizedScope === 'site') {
    stats.bySite = {};
  } else if (normalizedScope === 'rules' || normalizedScope === 'rule') {
    stats.byRule = {};
  } else if (normalizedScope === 'events' || normalizedScope === 'recent') {
    stats.recentEvents = [];
  } else if (normalizedScope === 'timeline' || normalizedScope === 'days') {
    stats.byDay = {};
  } else {
    return { ok: false, error: 'Unknown stats reset scope' };
  }

  await writeStoredStats(stats);
  return { ok: true };
}

export async function setStatsSettings(input = {}) {
  await flushStatsQueue();
  const stats = await ensureStatsV2();
  stats.settings = normalizeSettings({ ...stats.settings, ...input });

  if (stats.settings.mode === 'basic') {
    clearDetailedStats(stats);
  } else if (!stats.settings.storeFullUrls) {
    stats.recentEvents = stats.recentEvents.map(event => {
      const { url, ...rest } = event;
      return rest;
    });
  }

  pruneStats(stats);
  await writeStoredStats(stats);
  return { ok: true, settings: cloneJson(stats.settings) };
}

export async function exportStats() {
  const snapshot = await getStatsSnapshot({ includeRecentEvents: true });
  return {
    exportedAt: Date.now(),
    stats: snapshot
  };
}
