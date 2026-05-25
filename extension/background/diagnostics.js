/**
 * Coarse persisted health diagnostics for material background failures.
 *
 * Entries here are intentionally sanitized and status-oriented. Do not store
 * request URLs, proxy hosts, credentials, raw rules, or subscription bodies.
 */

'use strict';

const HEALTH_DIAGNOSTICS_KEY = 'healthDiagnostics';
const MAX_TEXT_LENGTH = 180;

function sanitizeText(value, maxLength = MAX_TEXT_LENGTH) {
  return String(value ?? '')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, '[host]')
    .replace(/[^\S\r\n]+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeSeverity(value) {
  return ['info', 'warning', 'error'].includes(value) ? value : 'warning';
}

function normalizeArea(value) {
  const area = String(value || 'system').replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
  return area || 'system';
}

function normalizeEntry(entry = {}) {
  return {
    area: normalizeArea(entry.area),
    severity: normalizeSeverity(entry.severity),
    message: sanitizeText(entry.message || 'Background health diagnostic recorded.'),
    action: entry.action ? sanitizeText(entry.action, 220) : null,
    error: entry.error ? sanitizeText(entry.error) : null,
    ts: Number.isSafeInteger(entry.ts) ? entry.ts : Date.now()
  };
}

async function readDiagnostics() {
  const { [HEALTH_DIAGNOSTICS_KEY]: diagnostics = {} } = await chrome.storage.local.get(HEALTH_DIAGNOSTICS_KEY);
  return diagnostics && typeof diagnostics === 'object' && !Array.isArray(diagnostics)
    ? diagnostics
    : {};
}

export async function recordHealthDiagnostic(id, entry = {}) {
  try {
    const key = normalizeArea(id);
    const diagnostics = await readDiagnostics();
    diagnostics[key] = normalizeEntry(entry);
    await chrome.storage.local.set({ [HEALTH_DIAGNOSTICS_KEY]: diagnostics });
  } catch {
    // Diagnostics must never break the sync path they are observing.
  }
}

export async function clearHealthDiagnostic(id) {
  try {
    const key = normalizeArea(id);
    const diagnostics = await readDiagnostics();
    if (!Object.prototype.hasOwnProperty.call(diagnostics, key)) return;
    delete diagnostics[key];
    await chrome.storage.local.set({ [HEALTH_DIAGNOSTICS_KEY]: diagnostics });
  } catch {
    // Diagnostics must never break the sync path they are observing.
  }
}
