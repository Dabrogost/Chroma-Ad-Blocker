/**
 * Proxy router: PAC script generation, domain expansion, auth handling,
 * and the per-proxy test runner.
 *
 * Importing this module installs the storage and webRequest listeners and
 * runs the legacy single-config migration.
 */

'use strict';

import { decryptAuth } from '../core/crypto.js';
import { recordStatsEvent } from './stats.js';
import { clearHealthDiagnostic, recordHealthDiagnostic } from './diagnostics.js';

const DEBUG = false;

let _currentlyTestingId = null;
let _proxyTestLock = Promise.resolve();
// Serializes PAC writes so back-to-back storage events can't race and let an
// older PAC win at chrome.proxy.settings.set().
let _syncQueue = Promise.resolve();
let _pendingProxyAuthChallenges = 0;
let _proxyAuthStatsTimer = null;
const PROXY_TEST_ENDPOINTS = Object.freeze([
  {
    id: 'cloudflare-trace',
    url: 'https://www.cloudflare.com/cdn-cgi/trace',
    domains: ['www.cloudflare.com', 'cloudflare.com'],
    parse: text => text.match(/^ip=(.+)$/m)?.[1]?.trim()
  },
  {
    id: 'aws-checkip',
    url: 'https://checkip.amazonaws.com/',
    domains: ['checkip.amazonaws.com'],
    parse: text => text.trim()
  },
  {
    id: 'ipify',
    url: 'https://api64.ipify.org?format=json',
    domains: ['api64.ipify.org'],
    parse: text => JSON.parse(text).ip
  },
  {
    id: 'icanhazip',
    url: 'https://icanhazip.com/',
    domains: ['icanhazip.com'],
    parse: text => text.trim()
  }
]);
const PROXY_TEST_DOMAINS = Object.freeze(
  [...new Set(PROXY_TEST_ENDPOINTS.flatMap(endpoint => endpoint.domains))]
);
const PROXY_TEST_CACHE_TTL_MS = 60_000;
const _proxyTestCache = new Map();
let _proxyConfigRevision = 0;
const VALID_PAC_TYPES = new Set(['PROXY', 'HTTPS', 'SOCKS4', 'SOCKS5']);
const PROXY_AUTH_STATS_FLUSH_MS = 10000;
const PROXY_AUTH_STATS_BATCH_CAP = 25;
const CHROME_SERVICE_BYPASS_DOMAINS = [
  'optimizationguide-pa.googleapis.com',
  'optimizationguide.googleapis.com',
  'gemini.google.com',
  'bard.google.com',
  'generativelanguage.googleapis.com',
  'accounts.google.com',
  'oauthaccountmanager.googleapis.com',
  'update.googleapis.com',
  'tools.google.com',
  'clients1.google.com',
  'clients2.google.com',
  'clients3.google.com',
  'clients4.google.com',
  'clients5.google.com',
  'clients6.google.com',
  'dl.google.com',
  'dl-ssl.google.com',
  'edgedl.me.gvt1.com',
  'redirector.gvt1.com',
  'redirector.gvt2.com',
  'gvt1.com',
  'gvt2.com',
  'gvt3.com',
  'storage.googleapis.com',
  'commondatastorage.googleapis.com',
  'www.googleapis.com',
  'aratea-pa.googleapis.com',
  'scone-pa.clients6.google.com',
  'gstatic.com',
  'googleusercontent.com'
];
const YOUTUBE_SMART_LINK_DOMAINS = [
  'googlevideo.com',
  'ytimg.com',
  'ggpht.com',
  'youtube-nocookie.com',
  'youtu.be',
  'youtubei.googleapis.com',
  'youtube.googleapis.com'
];
const PROXY_DOMAIN_EXPANSION = {
  'youtube.com':   YOUTUBE_SMART_LINK_DOMAINS,
  'youtu.be':      ['youtube.com', ...YOUTUBE_SMART_LINK_DOMAINS.filter(domain => domain !== 'youtu.be')],
  'twitch.tv':     ['ttvnw.net', 'jtvnw.net', 'twitchcdn.net'],
  'netflix.com':   ['netflix.net', 'nflxvideo.net', 'nflxext.com', 'nflximg.com', 'nflximg.net', 'nflxso.net', 'nflxsearch.net'],
  'amazon.com':    ['amazonvideo.com', 'primevideo.com', 'aiv-cdn.net', 'pv-cdn.net', 'aiv-delivery.net', 'media-amazon.com', 'ssl-images-amazon.com'],
  'primevideo.com':['amazon.com', 'amazonvideo.com', 'aiv-cdn.net', 'pv-cdn.net', 'aiv-delivery.net', 'media-amazon.com', 'ssl-images-amazon.com'],
  'disneyplus.com':['disney-plus.net', 'dssott.com', 'dssedge.com', 'bamgrid.com', 'disney-plus.com'],
  'hulu.com':      ['hulumail.com', 'huluim.com', 'hulu.hbomax.com'],
  'max.com':       ['hbomax.com', 'hbo.com', 'hbonow.com', 'hbogo.com'],
  'spotify.com':   ['scdn.co', 'spotify.net', 'audio-ak-spotify-com.akamaized.net']
};

function expandDomains(domains) {
  const expanded = new Set(domains);

  for (const d of domains) {
    // Exact match
    if (PROXY_DOMAIN_EXPANSION[d]) {
      PROXY_DOMAIN_EXPANSION[d].forEach(ext => expanded.add(ext));
    }

    // Handle 'www.' prefix
    const base = d.replace(/^www\./, '');
    if (PROXY_DOMAIN_EXPANSION[base]) {
      PROXY_DOMAIN_EXPANSION[base].forEach(ext => expanded.add(ext));
    }

    // Special Case: Amazon TLDs (amazon.co.uk, amazon.de, etc.)
    if (base.startsWith('amazon.') && base !== 'amazon.com') {
      PROXY_DOMAIN_EXPANSION['amazon.com'].forEach(ext => expanded.add(ext));
    }
  }
  return Array.from(expanded);
}

function buildPacDomainConditions(domains) {
  return domains
    .map(d => `host === ${JSON.stringify(d)} || dnsDomainIs(host, ${JSON.stringify('.' + d)})`)
    .join(' || ');
}

function shuffleEndpoints(endpoints) {
  const copy = [...endpoints];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function isLikelyIp(value) {
  if (typeof value !== 'string') return false;
  const ip = value.trim();
  if (!ip || ip.length > 64) return false;
  const ipv4Parts = ip.split('.');
  if (ipv4Parts.length === 4 && ipv4Parts.every(part => /^\d{1,3}$/.test(part))) {
    return ipv4Parts.every(part => Number(part) >= 0 && Number(part) <= 255);
  }
  return (
    ip.includes(':') &&
    /^[a-f0-9:]+$/i.test(ip)
  );
}

async function fetchProxyIp(signal) {
  const endpoints = shuffleEndpoints(PROXY_TEST_ENDPOINTS).slice(0, 2);
  let lastError = 'No verification endpoint available';

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint.url, {
        signal,
        cache: 'no-cache'
      });

      if (!res.ok) {
        lastError = `${endpoint.id}: HTTP ${res.status}`;
        continue;
      }

      const text = await res.text();
      const ip = endpoint.parse(text);

      if (!isLikelyIp(ip)) {
        lastError = `${endpoint.id}: invalid IP response`;
        continue;
      }

      return {
        ok: true,
        ip: ip.trim(),
        providerId: endpoint.id
      };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      lastError = `${endpoint.id}: ${err?.message || 'request failed'}`;
    }
  }

  return {
    ok: false,
    error: lastError
  };
}

function getProxyString(pc) {
  const type = VALID_PAC_TYPES.has(pc.type) ? pc.type : null;
  const host = typeof pc.host === 'string' ? pc.host : '';
  const port = Number(pc.port);

  if (!type || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return "'DIRECT'";
  }

  return JSON.stringify(`${type} ${host}:${port}`);
}

function isSafeHost(host) {
  return typeof host === 'string' &&
    host.length > 0 &&
    host.length <= 253 &&
    /^[a-z0-9.-]+$/i.test(host) &&
    !host.includes('..') &&
    !host.startsWith('.') &&
    !host.endsWith('.');
}

function isSafeProxyConfig(pc) {
  return !!(
    pc &&
    pc.accepted === true &&
    VALID_PAC_TYPES.has(pc.type) &&
    isSafeHost(pc.host) &&
    Number.isInteger(Number(pc.port)) &&
    Number(pc.port) >= 1 &&
    Number(pc.port) <= 65535
  );
}

function isProxyEnabled(pc) {
  return pc?.enabled !== false;
}

function hasStoredAuth(pc) {
  return !!(pc && pc.authIv && pc.authCipher);
}

function getProxyTestCacheFingerprint(pc) {
  return JSON.stringify({
    id: pc?.id,
    type: pc?.type,
    host: pc?.host,
    port: String(pc?.port ?? ''),
    hasAuth: hasStoredAuth(pc),
    revision: _proxyConfigRevision
  });
}

function flushProxyAuthStats() {
  if (_proxyAuthStatsTimer) {
    clearTimeout(_proxyAuthStatsTimer);
    _proxyAuthStatsTimer = null;
  }

  const count = _pendingProxyAuthChallenges;
  _pendingProxyAuthChallenges = 0;
  if (count > 0) {
    recordStatsEvent({ layer: 'proxy', type: 'auth_challenge', count });
  }
}

function recordProxyAuthChallenge() {
  _pendingProxyAuthChallenges++;

  if (_pendingProxyAuthChallenges >= PROXY_AUTH_STATS_BATCH_CAP) {
    flushProxyAuthStats();
    return;
  }

  if (!_proxyAuthStatsTimer) {
    _proxyAuthStatsTimer = setTimeout(flushProxyAuthStats, PROXY_AUTH_STATS_FLUSH_MS);
  }
}

function getEnabledRouteDomains(pc) {
  if (!Array.isArray(pc.domains)) return [];
  return pc.domains
    .filter(d => d && d.enabled !== false && typeof d.host === 'string')
    .map(d => d.host)
    .filter(h => /^[a-z0-9.-]+$/i.test(h) && !h.includes('..'));
}

function findAuthProxyConfig(proxyConfigs, challengerHost, challengerPort) {
  const host = String(challengerHost || '').toLowerCase().replace(/\.$/, '');
  const accepted = proxyConfigs.filter(p =>
    isSafeProxyConfig(p) &&
    hasStoredAuth(p) &&
    String(p.port) === String(challengerPort)
  );

  const exact = accepted.find(p => p.host === host);
  if (exact) return exact;

  const socks = accepted.filter(p => p.type === 'SOCKS4' || p.type === 'SOCKS5');
  return socks.length === 1 ? socks[0] : null;
}

export function syncProxyState(proxyConfigs) {
  const next = _syncQueue.then(() => _syncProxyStateImpl(proxyConfigs));
  _syncQueue = next.catch(() => {}); // never let a failure stall the queue
  return next;
}

async function _syncProxyStateImpl(proxyConfigs) {
  if (!proxyConfigs || !Array.isArray(proxyConfigs)) return;

  const { config } = await chrome.storage.local.get('config');
  const globalEnabled = config?.globalProxyEnabled === true;
  const globalId = config?.globalProxyId;
  const chromeServiceBypassEnabled = config?.chromeServiceProxyBypass !== false;
  const selectedGlobalProxy = globalEnabled && globalId != null
    ? proxyConfigs.find(pc => pc.id === globalId && isSafeProxyConfig(pc))
    : null;

  if (globalEnabled && globalId != null && !selectedGlobalProxy) {
    await chrome.storage.local.set({
      config: {
        ...config,
        globalProxyEnabled: false,
        globalProxyId: null
      }
    });
    return;
  }

  let scriptData = "function FindProxyForURL(url, host) { \n";
  scriptData += "  host = String(host || '').toLowerCase().replace(/\\.$/, '');\n";
  let hasSpecificRules = false;
  let fallbackStr = "'DIRECT'";

  if (chromeServiceBypassEnabled) {
    scriptData += `  if (${buildPacDomainConditions(CHROME_SERVICE_BYPASS_DOMAINS)}) return 'DIRECT';\n`;
  }

  for (const pc of proxyConfigs) {
    if (!isSafeProxyConfig(pc)) continue;

    const { id } = pc;

    const proxyStr = getProxyString(pc);
    const isTest = (id === _currentlyTestingId);
    const routeEnabled = isProxyEnabled(pc);
    const activeDomains = routeEnabled ? expandDomains(getEnabledRouteDomains(pc)) : [];

    // 1. Add Domain-Specific Rules
    if (activeDomains.length > 0 || isTest) {
      // JSON.stringify safely escapes any quotes/backslashes in user-supplied domains,
      // preventing a malformed config from breaking the entire PAC script.
      const conditions = [];
      if (activeDomains.length > 0) conditions.push(buildPacDomainConditions(activeDomains));
      if (isTest) conditions.push(buildPacDomainConditions(PROXY_TEST_DOMAINS));

      scriptData += `  if (${conditions.join(' || ')}) return ${proxyStr};\n`;
      hasSpecificRules = true;
    }

    // 2. Identify the Global Fallback
    if (routeEnabled && selectedGlobalProxy && id === globalId) {
      fallbackStr = proxyStr;
    }
  }

  scriptData += `  return ${fallbackStr};\n}`;

  try {
    // When we have no routing to do, release chrome.proxy.settings so other
    // proxy/VPN extensions can take control. Chrome only lets one extension
    // own this setting at a time, and calling .set() — even with a no-op
    // DIRECT PAC — would bump them to "controlled_by_other_extensions".
    if (!hasSpecificRules && fallbackStr === "'DIRECT'") {
      await chrome.proxy.settings.clear({ scope: 'regular' });
      await clearHealthDiagnostic('proxyPacSync');
      if (DEBUG) console.log('[Chroma Ad-Blocker] No active proxies; released proxy settings.');
      return;
    }

    await chrome.proxy.settings.set({
      value: { mode: 'pac_script', pacScript: { data: scriptData } },
      scope: 'regular'
    });
    await clearHealthDiagnostic('proxyPacSync');
    if (DEBUG) console.log('[Chroma Ad-Blocker] Proxy PAC script synced. Total configs:', proxyConfigs.length);
  } catch (err) {
    await recordHealthDiagnostic('proxyPacSync', {
      area: 'proxy',
      severity: 'warning',
      message: 'Proxy PAC settings could not be applied.',
      action: 'Check proxy settings, or disable and re-enable the selected proxy route.',
      error: err?.message || err
    });
    if (DEBUG) console.error('[Chroma Ad-Blocker] Failed to update proxy settings:', err);
  }
}

/**
 * Encapsulates the sequential lock + PAC-swap + fetch flow for a proxy test.
 */
export async function runProxyTest(proxyId) {
  const { proxyConfigs: cachedProxyConfigs = [] } = await chrome.storage.local.get('proxyConfigs');
  const cachedPc = proxyId === undefined
    ? cachedProxyConfigs.find(isSafeProxyConfig)
    : cachedProxyConfigs.find(p => p.id === proxyId && isSafeProxyConfig(p));

  if (!cachedPc) {
    recordStatsEvent({ layer: 'proxy', type: 'test_failure', error: 'Proxy not configured' });
    return { ok: false, error: 'Proxy not configured' };
  }

  const cacheFingerprint = getProxyTestCacheFingerprint(cachedPc);
  const cached = _proxyTestCache.get(cachedPc.id);
  if (
    cached?.ok === true &&
    cached.fingerprint === cacheFingerprint &&
    Date.now() - cached.checkedAt < PROXY_TEST_CACHE_TTL_MS
  ) {
    const { checkedAt, fingerprint, ...cachedResult } = cached;
    return cachedResult;
  }

  const currentLock = _proxyTestLock;
  const nextLock = (async () => {
    await currentLock;
    try {
      const { proxyConfigs = [] } = await chrome.storage.local.get('proxyConfigs');
      const pc = proxyId === undefined
        ? proxyConfigs.find(isSafeProxyConfig)
        : proxyConfigs.find(p => p.id === proxyId && isSafeProxyConfig(p));

      if (!pc) {
        recordStatsEvent({ layer: 'proxy', type: 'test_failure', error: 'Proxy not configured' });
        return { ok: false, error: 'Proxy not configured' };
      }

      const lockedCacheFingerprint = getProxyTestCacheFingerprint(pc);
      const lockedCached = _proxyTestCache.get(pc.id);
      if (
        lockedCached?.ok === true &&
        lockedCached.fingerprint === lockedCacheFingerprint &&
        Date.now() - lockedCached.checkedAt < PROXY_TEST_CACHE_TTL_MS
      ) {
        const { checkedAt, fingerprint, ...cachedResult } = lockedCached;
        return cachedResult;
      }

      _currentlyTestingId = pc.id;
      await syncProxyState(proxyConfigs);
      await new Promise(r => setTimeout(r, 150)); // Tiny grace period for Chrome to apply PAC settings

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      try {
        const result = await fetchProxyIp(controller.signal);
        clearTimeout(timeoutId);
        if (result.ok) {
          const { ip, providerId } = result;
          const success = {
            ok: true,
            proxyId: pc.id,
            ip,
            providerId,
            fingerprint: lockedCacheFingerprint,
            checkedAt: Date.now()
          };
          _proxyTestCache.set(pc.id, success);
          recordStatsEvent({ layer: 'proxy', type: 'test_pass', proxyId: pc.id });
          return { ok: true, proxyId: pc.id, ip, providerId };
        }
        recordStatsEvent({ layer: 'proxy', type: 'test_failure', proxyId: pc.id, error: result.error });
        return { ok: false, error: result.error };
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        const error = fetchErr.name === 'AbortError' ? 'Timeout' : fetchErr.message;
        recordStatsEvent({ layer: 'proxy', type: 'test_failure', proxyId: pc.id, error });
        return { ok: false, error };
      } finally {
        _currentlyTestingId = null;
        await syncProxyState(proxyConfigs);
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }
  })();

  _proxyTestLock = nextLock.then(() => {}, () => {}); // always release even on error
  return nextLock;
}

// Listen for proxy config changes to update PAC script dynamically
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local') {
    if (changes.proxyConfigs) {
      const oldConfigs = changes.proxyConfigs.oldValue || [];
      const newConfigs = changes.proxyConfigs.newValue || [];
      _proxyConfigRevision++;
      _proxyTestCache.clear();

      // Cleanup globalProxyId if the proxy was deleted
      if (oldConfigs.length > newConfigs.length) {
        const { config } = await chrome.storage.local.get('config');
        if (config?.globalProxyId) {
          const stillExists = newConfigs.some(pc => pc.id === config.globalProxyId);
          if (!stillExists) {
            await chrome.storage.local.set({
              config: {
                ...config,
                globalProxyEnabled: false,
                globalProxyId: null
              }
            });
          }
        }
      }
      syncProxyState(newConfigs);
    }

    if (changes.config) {
      const oldC = changes.config.oldValue;
      const newC = changes.config.newValue;
      if (
        oldC?.globalProxyEnabled !== newC?.globalProxyEnabled ||
        oldC?.globalProxyId !== newC?.globalProxyId ||
        oldC?.chromeServiceProxyBypass !== newC?.chromeServiceProxyBypass
      ) {
        const { proxyConfigs } = await chrome.storage.local.get('proxyConfigs');
        syncProxyState(proxyConfigs);
      }
    }
  }
});

// Initialize proxy state on startup and drop legacy single-config storage.
chrome.storage.local.get(['proxyConfig', 'proxyConfigs']).then(async ({ proxyConfig, proxyConfigs }) => {
  if (proxyConfig && !proxyConfigs) {
    await chrome.storage.local.remove('proxyConfig');
    syncProxyState([]);
  } else if (proxyConfigs) {
    syncProxyState(proxyConfigs);
  }
});

// Proxy Authentication Handler
const _authAttempted = new Set();
// Periodically clean up old auth attempts
setInterval(() => _authAttempted.clear(), 60000);

chrome.webRequest.onAuthRequired.addListener(
  function(details, callback) {
    if (!details.isProxy) {
      callback({});
      return;
    }

    recordProxyAuthChallenge();

    const requestId = details.requestId;
    if (_authAttempted.has(requestId)) {
      if (DEBUG) console.warn('[Chroma Ad-Blocker] Proxy auth looped. Cancelling request.', details.url);
      callback({ cancel: true });
      return;
    }

    chrome.storage.local.get('proxyConfigs').then(async ({ proxyConfigs }) => {
      if (!proxyConfigs || !Array.isArray(proxyConfigs)) {
        callback({ cancel: true });
        return;
      }

      const challengerHost = details.challenger?.host;
      const challengerPort = details.challenger?.port;
      const pc = findAuthProxyConfig(proxyConfigs, challengerHost, challengerPort);

      if (!pc) {
        if (DEBUG) console.warn('[Chroma Ad-Blocker] Proxy auth required but matching credentials missing.');
        callback({ cancel: true });
        return;
      }

      const auth = await decryptAuth(pc.authIv, pc.authCipher);
      const username = auth?.username;
      const password = auth?.password;

      if (!username || !password) {
        callback({ cancel: true });
        return;
      }

      _authAttempted.add(requestId);
      callback({
        authCredentials: {
          username: username,
          password: password
        }
      });
    }).catch(err => {
      if (DEBUG) console.error('[Chroma Ad-Blocker] Error in proxy auth:', err);
      callback({ cancel: true });
    });
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);
