/**
 * Statistics, request-log, health, and update message handlers.
 */

'use strict';

import { checkForUpdate } from '../updateCheck.js';
import { inspectLatestUpdatePackage } from '../updatePackage.js';
import { getMergedLog, resetRequestLog } from '../requestLog.js';
import { getHealthStatus } from '../health.js';
import {
  exportStats,
  getStatsSnapshot,
  recordContentStatsEvents,
  resetStats,
  setStatsSettings
} from '../stats.js';

export async function handleStatsGet(msg) {
  return getStatsSnapshot(msg?.options || {});
}

export async function handleStatsEventBatch(msg, sender) {
  return recordContentStatsEvents(msg?.events, sender);
}

export async function handleStatsReset(msg) {
  const scope = msg?.scope || 'all';
  if (scope === 'debugLog' || scope === 'requestLog') {
    await resetRequestLog();
    return { ok: true };
  }
  return resetStats(scope);
}

export async function handleStatsExport() {
  return exportStats();
}

export async function handleStatsSettingsSet(msg) {
  return setStatsSettings(msg?.settings || {});
}

export async function handleLogGet() {
  return getMergedLog();
}

export async function handleHealthGet() {
  return getHealthStatus();
}

export async function handleUpdateCheck(msg) {
  return checkForUpdate(msg?.options || {});
}

export async function handleUpdatePackageInspect(msg) {
  return inspectLatestUpdatePackage(msg?.options || {});
}
