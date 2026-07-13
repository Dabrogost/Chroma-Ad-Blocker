/**
 * Validation shared by user-configurable remote data sources.
 *
 * This deliberately operates on literal addresses only. Hostname resolution is
 * owned by the browser, but a URL which already names a non-public address must
 * never cross the subscription/user-resource trust boundary.
 */

'use strict';

function parseIpv4(host) {
  const parts = String(host || '').split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return null;
  const bytes = parts.map(Number);
  return bytes.every(byte => byte >= 0 && byte <= 255) ? bytes : null;
}

function isBlockedIpv4Bytes(bytes) {
  if (!bytes) return false;
  const [a, b, c] = bytes;
  return (
    a === 0 ||                                      // unspecified/current network
    a === 10 ||                                     // private
    (a === 100 && b >= 64 && b <= 127) ||           // carrier-grade NAT
    a === 127 ||                                    // loopback
    (a === 169 && b === 254) ||                     // link-local
    (a === 172 && b >= 16 && b <= 31) ||            // private
    (a === 192 && b === 0 && c === 0) ||            // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) ||            // documentation
    (a === 192 && b === 88 && c === 99) ||          // deprecated 6to4 relay anycast
    (a === 192 && b === 168) ||                     // private
    (a === 198 && (b === 18 || b === 19)) ||        // benchmarking
    (a === 198 && b === 51 && c === 100) ||         // documentation
    (a === 203 && b === 0 && c === 113) ||          // documentation
    a >= 224                                        // multicast and reserved
  );
}

function parseIpv6(hostname) {
  let host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host.includes('%')) return null;

  // Support the dotted form even though URL normally canonicalizes it to two
  // hexadecimal words (for example ::ffff:7f00:1).
  const lastColon = host.lastIndexOf(':');
  if (host.includes('.') && lastColon >= 0) {
    const ipv4 = parseIpv4(host.slice(lastColon + 1));
    if (!ipv4) return null;
    host = `${host.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  const halves = host.split('::');
  if (halves.length > 2) return null;
  const parseHalf = value => value === '' ? [] : value.split(':');
  const left = parseHalf(halves[0]);
  const right = halves.length === 2 ? parseHalf(halves[1]) : [];
  if (left.concat(right).some(word => !/^[0-9a-f]{1,4}$/.test(word))) return null;

  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return left.map(word => parseInt(word, 16))
    .concat(Array(missing).fill(0), right.map(word => parseInt(word, 16)));
}

function isBlockedIpv6(host) {
  const words = parseIpv6(host);
  // A colon-bearing host that cannot be verified is rejected rather than
  // accidentally treated as a public DNS name.
  if (!words) return true;

  const isIpv4Mapped = words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff;
  if (isIpv4Mapped) {
    return isBlockedIpv4Bytes([
      words[6] >> 8,
      words[6] & 0xff,
      words[7] >> 8,
      words[7] & 0xff
    ]);
  }

  const first = words[0];
  // IPv6 global unicast is 2000::/3. Reject every other address family here;
  // the remaining checks cover special-purpose ranges inside that allocation.
  if ((first & 0xe000) !== 0x2000) return true;

  return (
    (first === 0x2001 && words[1] < 0x0200) ||       // special-purpose assignments
    (first === 0x2001 && words[1] === 0x0db8) ||     // documentation
    first === 0x2002 ||                              // deprecated 6to4
    (first === 0x3fff && words[1] <= 0x0fff)         // documentation
  );
}

export function isBlockedRemoteHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const ipv4 = parseIpv4(host);
  if (ipv4) return isBlockedIpv4Bytes(ipv4);
  return host.includes(':') ? isBlockedIpv6(host) : false;
}

/**
 * Validate an HTTPS URL used to load extension-controlled data.
 * @param {*} input
 * @param {{ label?: string, stripHash?: boolean }} options
 */
export function validateRemoteHttpsUrl(input, options = {}) {
  const label = typeof options.label === 'string' && options.label ? options.label : 'Remote';
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, error: `${label} URL required` };
  }

  let parsed;
  try {
    parsed = new URL(input.trim());
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }

  if (parsed.protocol !== 'https:') return { ok: false, error: 'Only https:// URLs are allowed' };
  if (parsed.username || parsed.password) return { ok: false, error: `${label} URLs cannot include credentials` };
  if (parsed.port && parsed.port !== '443') return { ok: false, error: `${label} URL must use the default HTTPS port` };
  if (isBlockedRemoteHostname(parsed.hostname)) {
    return { ok: false, error: `Local, private, or special-use ${label.toLowerCase()} URLs are not allowed` };
  }

  if (options.stripHash === true) parsed.hash = '';
  return { ok: true, url: parsed.href, hostname: parsed.hostname };
}
