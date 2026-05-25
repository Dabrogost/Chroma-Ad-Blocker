/**
 * Developer-mode DNR request log buffering.
 */

'use strict';

import { classifyDnrMatch } from './dnrState.js';
import { recordStatsEvent } from './stats.js';

const DEBUG = false;
const LOG_MAX_ENTRIES = 500; // Cap to bound chrome.storage.local write size per flush
let _logBuffer = [];
let _flushTimer = null;

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
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  await chrome.storage.local.set({ requestLog: [] });
}

export async function getMergedLog() {
  const { requestLog: storedLog = [] } = await chrome.storage.local.get('requestLog');
  return [..._logBuffer, ...storedLog].slice(0, LOG_MAX_ENTRIES);
}

async function flushLog() {
  _flushTimer = null;
  const batch = _logBuffer.splice(0);

  if (batch.length === 0) return;

  try {
    const { requestLog = [] } = await chrome.storage.local.get('requestLog');
    const updates = {};
    if (batch.length > 0) {
      updates.requestLog = [...batch, ...requestLog].slice(0, LOG_MAX_ENTRIES);
    }
    await chrome.storage.local.set(updates);
  } catch (err) {
    if (DEBUG) console.error('[Chroma] Log flush failed:', err);
  }
}

export function initRequestLogListener() {
  if (!chrome.declarativeNetRequest.onRuleMatchedDebug) return;

  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    const classification = classifyDnrMatch(info);
    _logBuffer.push({
      ts:  Date.now(),
      url: info.request.url,
      rt:  info.request.type,
      rid: info.rule.ruleId,
      action: classification.type,
      source: classification.ruleSource,
      rulesetId: classification.rulesetId
    });

    recordStatsEvent({
      layer: 'network',
      type: classification.type,
      url: info.request.url,
      resourceType: info.request.type,
      ruleId: classification.ruleId,
      rulesetId: classification.rulesetId,
      ruleSource: classification.ruleSource,
      ts: Date.now()
    });

    if (!_flushTimer) {
      _flushTimer = setTimeout(flushLog, 500); // 500ms batch window to coalesce rapid rule-match events
    }
  });
}
