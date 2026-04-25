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
  let { host, port } = pc;
  if (!host || !port) return "'DIRECT'";

  let type = 'PROXY';
  let cleanHost = host;

  if (host.startsWith('socks5://')) {
    type = 'SOCKS5';
    cleanHost = host.replace('socks5://', '');
  } else if (host.startsWith('https://')) {
    type = 'HTTPS';
    cleanHost = host.replace('https://', '');
  } else if (host.startsWith('http://')) {
    type = 'PROXY';
    cleanHost = host.replace('http://', '');
  }

  // If the user embedded a port in the host string, it takes precedence —
  // it reflects more recent intent than the separately-stored port field.
  let effectivePort = port;
  if (cleanHost.includes(':')) {
    const [h, p] = cleanHost.split(':');
    cleanHost = h;
    if (p) effectivePort = p;
  }

  if (type === 'SOCKS5') {
    return `"SOCKS5 ${cleanHost}:${effectivePort}; SOCKS ${cleanHost}:${effectivePort}"`;
  }
  // Default to PROXY for better compatibility unless HTTPS was explicitly requested
  return `"${type} ${cleanHost}:${effectivePort}"`;
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

  let scriptData = "function FindProxyForURL(url, host) { \n";
  let hasSpecificRules = false;
  let fallbackStr = "'DIRECT'";

  for (const pc of proxyConfigs) {
    const { host, port, domains = [], accepted, id } = pc;
    if (!accepted || !host || !port) continue;

    const proxyStr = getProxyString(pc);
    const isTest = (id === _currentlyTestingId);
    const activeDomains = expandDomains(domains.filter(d => d.enabled).map(d => d.host));

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
    if (id === globalId && globalEnabled) {
      fallbackStr = proxyStr;
    }
  }

  scriptData += `  return ${fallbackStr};\n}`;

  // Simplified PAC if no routing is actually happening
  if (!hasSpecificRules && fallbackStr === "'DIRECT'") {
    scriptData = "function FindProxyForURL(url, host) { return 'DIRECT'; }";
  }

  try {
    await chrome.proxy.settings.set({
      value: { mode: 'pac_script', pacScript: { data: scriptData } },
      scope: 'regular'
    });
    if (DEBUG) console.log('[Chroma Ad-Blocker] Proxy PAC script synced. Total configs:', proxyConfigs.length);
  } catch (err) {
    if (DEBUG) console.error('[Chroma Ad-Blocker] Failed to set proxy PAC script:', err);
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
      const pc = proxyConfigs.find(p => p.id === proxyId) || proxyConfigs[0];

      if (!pc || !pc.host || !pc.port || !pc.accepted) {
        return { ok: false, error: 'Proxy not configured' };
      }

      _currentlyTestingId = pc.id;
      await syncProxyState(proxyConfigs);

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
          return { ok: true, ip };
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
            await chrome.storage.local.set({ config: { ...config, globalProxyId: null } });
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

// Initialize proxy state on startup and handle migration
chrome.storage.local.get(['proxyConfig', 'proxyConfigs']).then(async ({ proxyConfig, proxyConfigs }) => {
  if (proxyConfig && !proxyConfigs) {
    // Migrate legacy single config to new array format
    const migrated = { ...proxyConfig, id: Date.now(), name: 'Main Server' };
    await chrome.storage.local.set({ proxyConfigs: [migrated] });
    await chrome.storage.local.remove('proxyConfig');
    syncProxyState([migrated]);
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

      // Find the proxy config that matches the challenger
      const challengerHost = details.challenger.host;
      const challengerPort = details.challenger.port.toString();

      const pc = proxyConfigs.find(p => {
        const pHost = p.host.replace(/^(https?|socks5):\/\//, '');
        return pHost === challengerHost && p.port.toString() === challengerPort;
      });

      if (!pc || (!pc.username && !pc.authCipher)) {
        if (DEBUG) console.warn('[Chroma Ad-Blocker] Proxy auth required but matching credentials missing.');
        callback({ cancel: true });
        return;
      }

      let username = pc.username;
      let password = pc.password;

      if (pc.authCipher && pc.authIv) {
        const auth = await decryptAuth(pc.authIv, pc.authCipher);
        if (auth) {
          username = auth.username;
          password = auth.password;
        }
      }

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
