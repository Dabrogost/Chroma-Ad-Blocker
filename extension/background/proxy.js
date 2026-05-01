/**
 * Proxy router: PAC script generation, domain expansion, auth handling,
 * and the per-proxy test runner.
 *
 * Importing this module installs the storage and webRequest listeners and
 * runs the legacy single-config migration.
 */

'use strict';

import { decryptAuth } from '../core/crypto.js';

const DEBUG = false;

let _currentlyTestingId = null;
let _proxyTestLock = Promise.resolve();
// Serializes PAC writes so back-to-back storage events can't race and let an
// older PAC win at chrome.proxy.settings.set().
let _syncQueue = Promise.resolve();
const PROXY_TEST_DOMAIN = 'icanhazip.com';
const VALID_PAC_TYPES = new Set(['PROXY', 'HTTPS', 'SOCKS4', 'SOCKS5']);
const PROXY_DOMAIN_EXPANSION = {
  'youtube.com':   ['googlevideo.com', 'ytimg.com', 'ggpht.com', 'youtube-nocookie.com'],
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

function hasStoredAuth(pc) {
  return !!(pc && pc.authIv && pc.authCipher);
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
  const validGlobalProxy = globalEnabled && globalId != null
    ? proxyConfigs.find(pc => pc.id === globalId && isSafeProxyConfig(pc))
    : null;

  if (globalEnabled && globalId != null && !validGlobalProxy) {
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
  let hasSpecificRules = false;
  let fallbackStr = "'DIRECT'";

  for (const pc of proxyConfigs) {
    if (!isSafeProxyConfig(pc)) continue;

    const { id } = pc;

    const proxyStr = getProxyString(pc);
    const isTest = (id === _currentlyTestingId);
    const activeDomains = expandDomains(getEnabledRouteDomains(pc));

    // 1. Add Domain-Specific Rules
    if (activeDomains.length > 0 || isTest) {
      // JSON.stringify safely escapes any quotes/backslashes in user-supplied domains,
      // preventing a malformed config from breaking the entire PAC script.
      const conditions = activeDomains.map(d => `host === ${JSON.stringify(d)} || dnsDomainIs(host, ${JSON.stringify('.' + d)})`);
      if (isTest) conditions.push(`host === ${JSON.stringify(PROXY_TEST_DOMAIN)}`);

      scriptData += `  if (${conditions.join(' || ')}) return ${proxyStr};\n`;
      hasSpecificRules = true;
    }

    // 2. Identify the Global Fallback
    if (validGlobalProxy && id === globalId) {
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
      if (DEBUG) console.log('[Chroma Ad-Blocker] No active proxies; released proxy settings.');
      return;
    }

    await chrome.proxy.settings.set({
      value: { mode: 'pac_script', pacScript: { data: scriptData } },
      scope: 'regular'
    });
    if (DEBUG) console.log('[Chroma Ad-Blocker] Proxy PAC script synced. Total configs:', proxyConfigs.length);
  } catch (err) {
    if (DEBUG) console.error('[Chroma Ad-Blocker] Failed to update proxy settings:', err);
  }
}

/**
 * Encapsulates the sequential lock + PAC-swap + fetch flow for a proxy test.
 */
export function runProxyTest(proxyId) {
  const currentLock = _proxyTestLock;
  const nextLock = (async () => {
    await currentLock;
    try {
      const { proxyConfigs = [] } = await chrome.storage.local.get('proxyConfigs');
      const pc = proxyId === undefined
        ? proxyConfigs.find(isSafeProxyConfig)
        : proxyConfigs.find(p => p.id === proxyId && isSafeProxyConfig(p));

      if (!pc) {
        return { ok: false, error: 'Proxy not configured' };
      }

      _currentlyTestingId = pc.id;
      await syncProxyState(proxyConfigs);
      await new Promise(r => setTimeout(r, 150)); // Tiny grace period for Chrome to apply PAC settings

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      try {
        // icanhazip.com is always proxied when a proxy is active (see PROXY_DOMAIN_EXPANSION)
        const res = await fetch('https://icanhazip.com', {
          signal: controller.signal,
          cache: 'no-cache'
        });
        clearTimeout(timeoutId);
        if (res.ok) {
          const ip = (await res.text()).trim();
          return { ok: true, proxyId: pc.id, ip };
        }
        return { ok: false, error: `HTTP ${res.status}` };
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        return { ok: false, error: fetchErr.name === 'AbortError' ? 'Timeout' : fetchErr.message };
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
      if (oldC?.globalProxyEnabled !== newC?.globalProxyEnabled || oldC?.globalProxyId !== newC?.globalProxyId) {
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
