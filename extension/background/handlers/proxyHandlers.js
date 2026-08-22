/**
 * Proxy configuration and test message handlers.
 */

'use strict';

import { encryptAuth } from '../../core/crypto.js';
import { runProxyTest } from '../proxy.js';
import { isValidHostname, normalizeDomain } from './domainValidation.js';

const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const PROXY_TYPES = new Set(['PROXY', 'HTTPS', 'SOCKS4', 'SOCKS5']);
const MAX_PROXY_NAME_LEN = 80;
const MAX_PROXY_CREDENTIAL_LEN = 256;
const MAX_PROXY_AUTH_IV_LEN = 128;
const MAX_PROXY_AUTH_CIPHER_LEN = 2048;

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
    enabled: pc.enabled !== false,
    domains
  };

  return { value: normalized, errors: [] };
}

function hasEncryptedProxyAuth(pc) {
  const validBlob = (value, maxLen) => (
    (typeof value === 'string' && value.length > 0 && value.length <= maxLen) ||
    (Array.isArray(value) && value.length > 0 && value.length <= maxLen && value.every(n => Number.isInteger(n) && n >= 0 && n <= 255))
  );
  return !!(
    pc &&
    validBlob(pc.authIv, MAX_PROXY_AUTH_IV_LEN) &&
    validBlob(pc.authCipher, MAX_PROXY_AUTH_CIPHER_LEN)
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

export async function validateProxyConfigsForStorage(proxyConfigs, existingProxyConfigs = []) {
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
        errors.push(`proxy[${i}]: failed to store credentials`);
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
      // Intentionally leave stored auth fields unset.
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

export async function handleProxyConfigGet() {
  const { proxyConfigs = [] } = await chrome.storage.local.get('proxyConfigs');
  return proxyConfigs.map(pc => ({
    id: pc.id,
    name: pc.name,
    host: pc.host,
    port: pc.port,
    type: pc.type,
    accepted: pc.accepted,
    enabled: pc.enabled !== false,
    domains: Array.isArray(pc.domains) ? pc.domains : [],
    hasCredentials: hasEncryptedProxyAuth(pc)
  }));
}

export async function handleProxyConfigSet(msg) {
  const { proxyConfigs: existingProxyConfigs = [] } = await chrome.storage.local.get('proxyConfigs');
  const { ok, configs, droppedCount, errors } = await validateProxyConfigsForStorage(msg.proxyConfigs, existingProxyConfigs);
  if (!ok) return { ok: false, error: errors[0] };
  await chrome.storage.local.set({ proxyConfigs: configs });
  return { ok: true, storedCount: configs.length, droppedCount, errors };
}

export async function handleProxyTest(msg) {
  if (msg.proxyId !== undefined && (typeof msg.proxyId !== 'number' || !Number.isSafeInteger(msg.proxyId))) {
    return { ok: false, error: 'Invalid proxy ID' };
  }
  return runProxyTest(msg.proxyId);
}
