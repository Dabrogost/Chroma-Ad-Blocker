/**
 * Shared domain validation helpers for background message handlers.
 */

'use strict';

const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

export function isValidHostname(host) {
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

export function normalizeDomain(input) {
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

export function domainMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith('.' + domain);
}
