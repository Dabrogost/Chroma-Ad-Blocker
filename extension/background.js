/**
 * Chroma Ad-Blocker - Service Worker (MV3 Background)
 * Handles: dynamic rule updates, stat tracking, config persistence
 *
 * MV3 NOTE: This service worker is ephemeral and may restart at any time. 
 * All persistent state must be stored in chrome.storage.
 */

'use strict';

import { getDefaultDynamicRules } from './defaultDynamicRules.js';
import {
  initSubscriptions,
  ensureAlarm,
  refreshAllStale,
  refreshSubscription,
  getSubscriptions,
  setSubscriptionEnabled,
  addSubscription,
  removeSubscription
} from './subscriptions/manager.js';
import { initScriptletEngine } from './scriptlets/engine.js';
import { decryptAuth } from './crypto.js';

const DEBUG = false;

// ─── UPDATE CHECK ─────
const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000; // 6-hour cache window to avoid GitHub API rate limits
const RELEASES_URL = 'https://api.github.com/repos/Dabrogost/Chroma-Ad-Blocker/releases/latest';

function isNewerVersion(local, remote) {
  const parse = v => v.replace(/^v/, '').split('.').map(Number);
  const [lMaj, lMin, lPat] = parse(local);
  const [rMaj, rMin, rPat] = parse(remote);
  if (rMaj !== lMaj) return rMaj > lMaj;
  if (rMin !== lMin) return rMin > lMin;
  return rPat > lPat;
}

async function checkForUpdate() {
  try {
    const { updateCheckCache: cache } = await chrome.storage.local.get('updateCheckCache');
    const now = Date.now();
    const local = chrome.runtime.getManifest().version;

    if (cache && (now - cache.checkedAt) < UPDATE_CHECK_TTL_MS) {
      return (cache.latestVersion && isNewerVersion(local, cache.latestVersion))
        ? { updateAvailable: true, latestVersion: cache.latestVersion }
        : { updateAvailable: false, latestVersion: null };
    }

    const res = await fetch(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-cache'
    });

    if (!res.ok) return { updateAvailable: false, latestVersion: null };

    const data = await res.json();
    const latestVersion = (data.tag_name || '').replace(/^v/, '');
    if (!latestVersion) return { updateAvailable: false, latestVersion: null };

    await chrome.storage.local.set({ updateCheckCache: { latestVersion, checkedAt: now } });

    return isNewerVersion(local, latestVersion)
      ? { updateAvailable: true, latestVersion }
      : { updateAvailable: false, latestVersion: null };
  } catch {
    return { updateAvailable: false, latestVersion: null };
  }
}


// ─── REQUEST LOG BUFFER ─────
const LOG_MAX_ENTRIES = 500; // Cap to bound chrome.storage.local write size per flush
let _logBuffer = [];
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
let _pendingBlocked = 0;
let _flushTimer = null;

// ─── INSTALL / STARTUP ─────
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await chrome.storage.local.set({
      config: {
        networkBlocking: true,
        stripping: true,
        acceleration: false,
        cosmetic: true,
        hideShorts: false,
        hideMerch: true,
        hideOffers: true,
        suppressWarnings: true,
        accelerationSpeed: 8,
        enabled: true,
      },
      stats: { networkBlocked: 0 },
      requestLog: [],
      HIDE_SELECTORS: [
        '.ytd-display-ad-renderer', 'ytd-display-ad-renderer', '#masthead-ad',
        'ytd-banner-promo-renderer', '#banner-ad', '#player-ads',
        '.ytd-promoted-sparkles-web-renderer', 'ytd-promoted-sparkles-web-renderer',
        '.ytd-promoted-video-renderer', 'ytd-promoted-video-renderer',
        'ytd-search-pyv-renderer', 'ytd-ad-slot-renderer', 'ytd-in-feed-ad-layout-renderer',
        'ytd-rich-item-renderer:has(ytd-ad-slot-renderer)',
        'ytd-rich-item-renderer:has(.ytd-ad-slot-renderer)',
        'ytd-rich-section-renderer:has(ytd-ad-slot-renderer)',
        'ytd-rich-section-renderer:has(.ytd-ad-slot-renderer)',
        'ytd-rich-item-renderer:has(#ad-badge)',
        'ytd-rich-section-renderer:has(#ad-badge)',
        'ytd-statement-banner-renderer', 'ytd-video-masthead-ad-v3-renderer',
        'ytd-reel-shelf-renderer[is-ad]', '.ytd-mealbar-promo-renderer',
        'ytd-mealbar-promo-renderer', '.ytp-suggested-action',
        '.adbox.banner_ads.adsbox', '.textads', '.ad_unit', '.ad-server',
        '.ad-wrapper', '#ad-test', '.ad-test', '.advertisement',
        'img[src*="/ad/gif.gif"]', 'img[src*="/ad/static.png"]',
        'img[src*="advmaker"]', 'div[class*="advmaker"]', 'a[href*="advmaker"]',
        '.advmaker', '#advmaker', '.ad-slot', '.ad-container',
        '.ads-by-google', '[id^="ad-"]', '[class^="ad-"]',
        'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]'
      ],
      WARNING_SELECTORS: [
        'tp-yt-iron-overlay-backdrop', 'ytd-enforcement-message-view-model',
        '.ytd-enforcement-message-view-model', 'ytd-enforcement-dialog-view-model',
        'tp-yt-paper-dialog:has(ytd-enforcement-dialog-view-model)',
        '#header-ad-container', '.yt-playability-error-supported-renderers'
      ],
      whitelist: [],
      proxyConfig: { host: '', port: '', username: '', password: '', domains: [] }
    });
    if (DEBUG) console.log('[Chroma Ad-Blocker] Installed. Default config applied.');
  }

  const { config: storedConfig } = await chrome.storage.local.get('config');
  const isEnabled = storedConfig ? storedConfig.enabled : true;
  const isNetworkBlocking = storedConfig && storedConfig.networkBlocking !== undefined ? storedConfig.networkBlocking : true;
  await updateDNRState(isEnabled && isNetworkBlocking);
  await initSubscriptions();
  await refreshAllStale();
  await initScriptletEngine();
  
  // Force-sync all open tabs with the current config to prevent "ghost" states during install/update
  const tabs = await chrome.tabs.query({});
  const { config } = await chrome.storage.local.get('config');
  if (config) {
    await Promise.all(tabs.map(t => chrome.tabs.sendMessage(t.id, { type: MSG.CONFIG_UPDATE, config }).catch(() => {})));
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const { config: storedConfig } = await chrome.storage.local.get('config');
  const isEnabled = storedConfig ? storedConfig.enabled : true;
  const isNetworkBlocking = storedConfig && storedConfig.networkBlocking !== undefined ? storedConfig.networkBlocking : true;
  await updateDNRState(isEnabled && isNetworkBlocking);
  await chrome.storage.local.set({ requestLog: [] });
  await ensureAlarm();
  await initScriptletEngine();

  // Re-broadcast state to existing tabs to recover from service worker restarts
  const tabs = await chrome.tabs.query({});
  if (storedConfig) {
    await Promise.all(tabs.map(t => chrome.tabs.sendMessage(t.id, { type: MSG.CONFIG_UPDATE, config: storedConfig }).catch(() => {})));
  }
});

// ─── DYNAMIC RULE UPDATES ─────
const STATIC_RULESETS = [
  'yt_original_rules',
  'yt_ad_rules_part1',
  'yt_ad_rules_part2',
  'yt_ad_rules_part3',
  'yt_ad_rules_part4',
  'yt_ad_rules_part5',
  'yt_ad_rules_part6',
  'yt_ad_rules_part7',
  'yt_ad_rules_part8',
  'yt_ad_rules_part9',
  'twitch_ad_rules'
];

// Range 1000 - 99999 reserved for local/default dynamic rules (Anti-Detection/Acceleration)
const DEFAULT_RULE_ID_START = 1000;
const DEFAULT_RULE_ID_END   = 99999;

async function updateDNRState(isEnabled) {
  try {
    if (isEnabled) {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: STATIC_RULESETS });
      await syncDynamicRules();
      await syncWhitelistRules();
    } else {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: STATIC_RULESETS });
      const existing = await chrome.declarativeNetRequest.getDynamicRules();
      const removeIds = existing.map(r => r.id);
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds });
    }
  } catch (err) {
    if (DEBUG) console.error('[Chroma Ad-Blocker] Error updating DNR state:', err);
  }
}

/**
 * Dynamic rules let us update blocking patterns WITHOUT a Chrome Web Store
 * review cycle — critical because YouTube changes ad delivery domains rapidly.
 * Up to 30,000 "safe" dynamic rules (block/allow) are supported.
 * @returns {Promise<void>}
 */
async function syncDynamicRules() {
  try {
    const { config } = await chrome.storage.local.get('config');
    const isAccelerationEnabled = config?.acceleration !== false;

    const stored = await chrome.storage.local.get('dynamicRules');
    let rules = stored.dynamicRules || getDefaultDynamicRules();

    if (!isAccelerationEnabled) {
      // Reverse logic: Change 'allow' (Anti-Detection) to 'block'
      // when Acceleration is disabled, so ads are blocked by dynamic rules.
      rules = rules.map(r => ({
        ...r,
        action: { ...r.action, type: 'block' }
      }));
    }

    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existing
      .filter(r => r.id >= DEFAULT_RULE_ID_START && r.id <= DEFAULT_RULE_ID_END)
      .map(r => r.id);

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removeIds,
      addRules: rules,
    });

    if (DEBUG) {
      console.log(`[Chroma Ad-Blocker] Synced ${rules.length} dynamic rules (${isAccelerationEnabled ? 'ALLOW' : 'BLOCK'}).`);
    }
  } catch (err) {
    if (DEBUG) console.error('[Chroma Ad-Blocker] Dynamic rule sync failed:', err);
  }
}

/**
 * Syncs high-priority "allow" rules for whitelisted domains.
 * This ensures the extension is completely disabled on those sites even
 * if global blocking rules would otherwise match.
 */
async function syncWhitelistRules() {
  try {
    const { whitelist = [] } = await chrome.storage.local.get('whitelist');
    
    const WHITELIST_START_ID = 9000000; // High ID range to avoid collisions with default dynamic rules (1000-99999) and subscription rules
    
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existing.filter(r => r.id >= WHITELIST_START_ID).map(r => r.id);
    
    const addRules = whitelist.map((domain, index) => ({
      id: WHITELIST_START_ID + index,
      priority: 999999, // Highest priority to unconditionally override all other DNR rules
      action: { type: 'allow' },
      condition: {
        initiatorDomains: [domain],
        resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other']
      }
    }));

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removeIds,
      addRules: addRules,
    });

    if (DEBUG) console.log(`[Chroma Ad-Blocker] Synced ${whitelist.length} whitelist domains to DNR.`);
  } catch (err) {
    if (DEBUG) console.error('[Chroma Ad-Blocker] Whitelist sync failed:', err);
  }
}






// ─── MESSAGE TYPES ─────
/**
 * Maintain parity with messaging.js. Content scripts and background workers 
 * operate in isolated scopes, requiring manual synchronization of constants.
 */
const MSG = {
  CONFIG_GET: 'CONFIG_GET',
  CONFIG_SET: 'CONFIG_SET',
  CONFIG_UPDATE: 'CONFIG_UPDATE',
  STATS_RESET: 'STATS_RESET',
  WHITELIST_GET: 'WHITELIST_GET',
  WHITELIST_ADD: 'WHITELIST_ADD',
  WHITELIST_REMOVE: 'WHITELIST_REMOVE',
  SUBSCRIPTION_GET:     'SUBSCRIPTION_GET',
  SUBSCRIPTION_SET:     'SUBSCRIPTION_SET',
  SUBSCRIPTION_REFRESH: 'SUBSCRIPTION_REFRESH',
  SUBSCRIPTION_ADD:     'SUBSCRIPTION_ADD',
  SUBSCRIPTION_REMOVE:  'SUBSCRIPTION_REMOVE',
  LOG_GET: 'LOG_GET',
  UPDATE_CHECK: 'UPDATE_CHECK',
  PROXY_CONFIG_GET: 'PROXY_CONFIG_GET',
  PROXY_CONFIG_SET: 'PROXY_CONFIG_SET'
};

// ─── CONFIGURATION VALIDATION ─────
function validateConfig(inputConfig) {
  const allowed = ['networkBlocking', 'stripping', 'acceleration', 'cosmetic', 'hideShorts', 'hideMerch', 'hideOffers', 'suppressWarnings', 'accelerationSpeed', 'enabled'];
  const validatedConfig = {};

  if (inputConfig && typeof inputConfig === 'object') {
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(inputConfig, key)) {
        const val = inputConfig[key];
        if (key === 'accelerationSpeed') {
          if (typeof val === 'number' && val > 0 && val <= 16) {
            validatedConfig[key] = val;
          }
        } else if (typeof val === 'boolean') {
          validatedConfig[key] = val;
        }
      }
    }
  }

  return validatedConfig;
}


// ─── MESSAGE HANDLER ─────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = async () => {
    try {
      // SECURITY: Origin Authentication
      const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
      const isFromInternal = _sender.origin === extensionOrigin;

      const SENSITIVE_TYPES = [
        MSG.CONFIG_GET,
        MSG.CONFIG_SET,
        MSG.STATS_RESET,
        MSG.PROXY_CONFIG_GET,
        MSG.PROXY_CONFIG_SET
      ];

      if (SENSITIVE_TYPES.includes(msg.type) && !isFromInternal) {
        if (DEBUG) console.error('[Chroma Security] Blocked unauthorized message from:', _sender.origin, msg.type);
        return;
      }

      switch (msg.type) {


        case MSG.CONFIG_GET:
          const { config: cGet } = await chrome.storage.local.get('config');
          sendResponse(cGet);
          break;

        case MSG.CONFIG_SET:
          const { config: cCurr } = await chrome.storage.local.get('config');
          const validatedConfig = validateConfig(msg.config);
          const newConfig = { ...cCurr, ...validatedConfig };
          await chrome.storage.local.set({ config: newConfig });
          const wasDNRActive = cCurr.enabled !== false && cCurr.networkBlocking !== false;
          const isDNRActive = newConfig.enabled !== false && newConfig.networkBlocking !== false;
          if (isDNRActive !== wasDNRActive) {
            await updateDNRState(isDNRActive);
          } else if (isDNRActive && (cCurr.acceleration !== newConfig.acceleration)) {
            // Acceleration toggle requires re-syncing default dynamic rules
            await syncDynamicRules();
          }
          const tabs = await chrome.tabs.query({});
          await Promise.all(tabs.map(t => chrome.tabs.sendMessage(t.id, { type: MSG.CONFIG_UPDATE, config: newConfig }).catch(() => {})));
          sendResponse({ ok: true });
          break;

        case MSG.PROXY_CONFIG_GET:
          const { proxyConfig: pcGet } = await chrome.storage.local.get('proxyConfig');
          sendResponse(pcGet || { host: '', port: '', username: '', password: '', domains: [] });
          break;

        case MSG.PROXY_CONFIG_SET:
          const { proxyConfig: pcCurr } = await chrome.storage.local.get('proxyConfig');
          const pcNew = { ...pcCurr, ...msg.proxyConfig };
          await chrome.storage.local.set({ proxyConfig: pcNew });
          sendResponse({ ok: true });
          break;

        case MSG.STATS_RESET:
          _logBuffer = [];
          _pendingBlocked = 0;
          if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
          await chrome.storage.local.set({ stats: { networkBlocked: 0 }, requestLog: [] });
          sendResponse({ ok: true });
          break;


        case MSG.WHITELIST_GET:
          const { whitelist: wlGet = [] } = await chrome.storage.local.get('whitelist');
          sendResponse({ whitelist: wlGet });
          break;

        case MSG.WHITELIST_ADD:
          const { whitelist: wlAdd = [] } = await chrome.storage.local.get('whitelist');
          if (
            typeof msg.domain === 'string' &&
            msg.domain.length > 0 &&
            msg.domain.length <= 253 &&
            /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(msg.domain) &&
            !wlAdd.includes(msg.domain)
          ) {
            wlAdd.push(msg.domain);
            await chrome.storage.local.set({ whitelist: wlAdd });
            await syncWhitelistRules();
          }
          sendResponse({ ok: true });
          break;

        case MSG.WHITELIST_REMOVE:
          const { whitelist: wlRem = [] } = await chrome.storage.local.get('whitelist');
          const wlNew = wlRem.filter(d => d !== msg.domain);
          if (wlNew.length !== wlRem.length) {
            await chrome.storage.local.set({ whitelist: wlNew });
            await syncWhitelistRules();
          }
          sendResponse({ ok: true });
          break;

        case MSG.SUBSCRIPTION_GET:
          sendResponse(await getSubscriptions());
          break;

        case MSG.SUBSCRIPTION_SET:
          sendResponse(await setSubscriptionEnabled(msg.id, msg.enabled));
          break;

        case MSG.SUBSCRIPTION_REFRESH:
          sendResponse(await refreshSubscription(msg.id));
          break;

        case MSG.SUBSCRIPTION_ADD:
          sendResponse(await addSubscription(msg.subscription));
          break;

        case MSG.SUBSCRIPTION_REMOVE:
          sendResponse(await removeSubscription(msg.id));
          break;

        case MSG.LOG_GET: {
          // Merge in-memory buffer with stored log so unflushed entries are visible
          const { requestLog: storedLog = [] } = await chrome.storage.local.get('requestLog');
          const merged = [..._logBuffer, ...storedLog].slice(0, LOG_MAX_ENTRIES);
          sendResponse(merged);
          break;
        }

        case MSG.UPDATE_CHECK:
          sendResponse(await checkForUpdate());
          break;
      }
    } catch (err) {
      if (DEBUG) console.error('[Chroma] Error in message handler:', err);
    }
  };

  const p = handler();
  if (typeof globalThis !== 'undefined' && globalThis.__CHROMA_INTERNAL_TEST_STRICT__ === true) return p;
  return true;
});


// ─── NETWORK BLOCK TRACKING (DNR) ─────
/**
 * Developer Mode Check: onRuleMatchedDebug only fires when the extension
 * is loaded unpacked. Chroma is exclusively distributed unpacked via GitHub,
 * so this is the authoritative source for both stats and the request log.
 * Stats and log writes are batched to avoid excessive storage churn.
 */
async function flushLog() {
  _flushTimer = null;
  const batch = _logBuffer.splice(0);
  const blocked = _pendingBlocked;
  _pendingBlocked = 0;

  if (batch.length === 0 && blocked === 0) return;

  try {
    const { requestLog = [], stats = {} } = await chrome.storage.local.get(['requestLog', 'stats']);
    const updates = {};
    if (batch.length > 0) {
      updates.requestLog = [...batch, ...requestLog].slice(0, LOG_MAX_ENTRIES);
    }
    if (blocked > 0) {
      updates.stats = { ...stats, networkBlocked: (stats.networkBlocked || 0) + blocked };
    }
    await chrome.storage.local.set(updates);
  } catch (err) {
    if (DEBUG) console.error('[Chroma] Log flush failed:', err);
  }
}

if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    _logBuffer.push({
      ts:  Date.now(),
      url: info.request.url,
      rt:  info.request.type,
      rid: info.rule.ruleId
    });
    _pendingBlocked++;

    if (!_flushTimer) {
      _flushTimer = setTimeout(flushLog, 500); // 500ms batch window to coalesce rapid rule-match events
    }
  });
}

// ─── PROXY ROUTER & AUTHENTICATION ─────
const PROXY_DOMAIN_EXPANSION = {
  'youtube.com':   ['googlevideo.com', 'ytimg.com', 'ggpht.com', 'youtube-nocookie.com', 'nhacmp3abc.com'],
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

async function syncProxyState(proxyConfig) {
  if (!proxyConfig) return;
  const { host, port, domains = [], accepted } = proxyConfig;
  const activeDomains = expandDomains(domains.filter(d => d.enabled).map(d => d.host));

  let scriptData = "function FindProxyForURL(url, host) { return 'DIRECT'; }";

  if (accepted && activeDomains.length > 0 && host && port) {
    let proxyStr = `"PROXY ${host}:${port}"`;
    let cleanHost = host;
    
    if (host.startsWith('socks5://')) {
      cleanHost = host.replace('socks5://', '');
      proxyStr = `"SOCKS5 ${cleanHost}:${port}; SOCKS ${cleanHost}:${port}"`;
    } else if (host.startsWith('https://')) {
      cleanHost = host.replace('https://', '');
      proxyStr = `"HTTPS ${cleanHost}:${port}"`;
    } else if (host.startsWith('http://')) {
      cleanHost = host.replace('http://', '');
      proxyStr = `"PROXY ${cleanHost}:${port}"`;
    }

    const conditions = activeDomains.map(d => `shExpMatch(host, "${d}") || shExpMatch(host, "*.${d}")`).join(' || ');
    scriptData = `
      function FindProxyForURL(url, host) {
        if (${conditions}) {
          return ${proxyStr};
        }
        return "DIRECT";
      }
    `;
  }

  try {
    await chrome.proxy.settings.set({
      value: { mode: 'pac_script', pacScript: { data: scriptData } },
      scope: 'regular'
    });
    if (DEBUG) console.log('[Chroma Ad-Blocker] Proxy PAC script synced. Active domains:', activeDomains.length);
  } catch (err) {
    if (DEBUG) console.error('[Chroma Ad-Blocker] Failed to set proxy PAC script:', err);
  }
}

// Listen for proxy config changes to update PAC script dynamically
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.proxyConfig) {
    syncProxyState(changes.proxyConfig.newValue);
  }
});

// Initialize proxy state on startup
chrome.storage.local.get('proxyConfig').then(({ proxyConfig }) => {
  if (proxyConfig) syncProxyState(proxyConfig);
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

    chrome.storage.local.get('proxyConfig').then(async ({ proxyConfig }) => {
      if (!proxyConfig || (!proxyConfig.username && !proxyConfig.authCipher)) {
        if (DEBUG) console.warn('[Chroma Ad-Blocker] Proxy auth required but credentials missing.');
        callback({ cancel: true });
        return;
      }

      let username = proxyConfig.username;
      let password = proxyConfig.password;

      if (proxyConfig.authCipher && proxyConfig.authIv) {
        const auth = await decryptAuth(proxyConfig.authIv, proxyConfig.authCipher);
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

// ─── SUBSCRIPTION ALARM ─────
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'chroma-subscription-check') {
    refreshAllStale().catch(err => {
      if (DEBUG) console.error('[Chroma Subscriptions] Alarm refresh failed:', err);
    });
  }
});

// ─── TESTING EXPORTS ─────
if (typeof globalThis !== 'undefined' && globalThis.__CHROMA_INTERNAL_TEST_STRICT__ === true) {
  /** @returns {Promise<void>} */
  globalThis.syncDynamicRules = syncDynamicRules;
}
