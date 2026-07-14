/**
 * Developer-mode DNR request log buffering.
 */

'use strict';

import {
  classifyDnrMatch,
  hydrateDynamicRuleClassifications,
  isDynamicRuleClassificationReady
} from './dnrState.js';
import { recordStatsEvent } from './stats.js';

const DEBUG = false;
const LOG_MAX_ENTRIES = 500; // Cap to bound chrome.storage.local write size per flush
const EARLY_MATCH_BUFFER_CAP = 500;
let _logBuffer = [];
let _flushTimer = null;
let _flushChain = Promise.resolve();
let _earlyMatchBuffer = [];
let _classificationInitialization = null;

function queueLogStorageOperation(task) {
  const operation = _flushChain.then(task);
  _flushChain = operation.catch(() => {});
  return operation;
}

// State Bridge: Exposes in-memory log access for automated testing.
// Without this, background request log tests would be slow and timing-dependent
// due to the 500ms batched storage flush timer.
if (typeof globalThis !== 'undefined' && globalThis.__CHROMA_INTERNAL_TEST_STRICT__ === true) {
  globalThis.__CHROMA_STATE_BRIDGE__ = {
    flushLog: () => {
      const log = [..._logBuffer];
      _logBuffer = [];
      return log;
    }
  };
}

export async function resetRequestLog() {
  _logBuffer = [];
  _earlyMatchBuffer = [];
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  // Serialize the reset with any already-started write. A new match flush will
  // queue behind this operation, so it cannot resurrect pre-reset entries.
  await queueLogStorageOperation(() => chrome.storage.local.set({ requestLog: [] }));
}

export async function getMergedLog() {
  // Entries already spliced from memory belong to the in-flight flush. Queue
  // the read on the same chain so it cannot temporarily omit them.
  return queueLogStorageOperation(async () => {
    const { requestLog: storedLog = [] } = await chrome.storage.local.get('requestLog');
    return [..._logBuffer, ...storedLog].slice(0, LOG_MAX_ENTRIES);
  });
}

async function flushLog() {
  _flushTimer = null;
  const batch = _logBuffer.splice(0);

  if (batch.length === 0) return;

  try {
    await queueLogStorageOperation(async () => {
      const { requestLog = [] } = await chrome.storage.local.get('requestLog');
      await chrome.storage.local.set({
        requestLog: [...batch, ...requestLog].slice(0, LOG_MAX_ENTRIES)
      });
    });
  } catch (err) {
    if (DEBUG) console.error('[Chroma] Log flush failed:', err);
  }
}

function recordMatchedRule(info) {
  const classification = classifyDnrMatch(info);
  const ts = Date.now();
  const url = typeof info?.request?.url === 'string' ? info.request.url : '';
  const resourceType = typeof info?.request?.type === 'string' ? info.request.type : 'other';
  _logBuffer.push({
    ts,
    url,
    rt: resourceType,
    rid: classification.ruleId,
    action: classification.type,
    source: classification.ruleSource,
    rulesetId: classification.rulesetId
  });
  if (_logBuffer.length > LOG_MAX_ENTRIES) {
    _logBuffer = _logBuffer.slice(-LOG_MAX_ENTRIES);
  }

  recordStatsEvent({
    layer: 'network',
    type: classification.type,
    url,
    resourceType,
    ruleId: classification.ruleId,
    rulesetId: classification.rulesetId,
    ruleSource: classification.ruleSource,
    ts
  });

  if (!_flushTimer) {
    _flushTimer = setTimeout(flushLog, 500); // 500ms batch window to coalesce rapid rule-match events
  }
}

function finishClassificationInitialization() {
  const pending = _earlyMatchBuffer.splice(0);
  for (const info of pending) recordMatchedRule(info);
}

function ensureClassificationInitialization() {
  if (isDynamicRuleClassificationReady()) {
    finishClassificationInitialization();
    return Promise.resolve();
  }
  if (_classificationInitialization) return _classificationInitialization;

  _classificationInitialization = hydrateDynamicRuleClassifications()
    .catch(() => ({ ok: false }))
    .then(finishClassificationInitialization)
    .finally(() => {
      _classificationInitialization = null;
    });
  return _classificationInitialization;
}

export function initRequestLogListener() {
  // Start hydration on every worker evaluation, even when Chrome's optional
  // developer-mode match event is unavailable in this profile.
  ensureClassificationInitialization();
  if (!chrome.declarativeNetRequest.onRuleMatchedDebug) return;

  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    if (isDynamicRuleClassificationReady()) {
      recordMatchedRule(info);
      return;
    }

    // Diagnostics are non-enforcement data. Bound the early queue and drop
    // excess events instead of risking unbounded service-worker memory.
    if (_earlyMatchBuffer.length < EARLY_MATCH_BUFFER_CAP) {
      _earlyMatchBuffer.push(info);
    }
    ensureClassificationInitialization();
  });
}
