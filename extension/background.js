/**
 * Chroma Ad-Blocker - Service Worker (MV3 Background)
 * Handles: dynamic rule updates, stat tracking, config persistence
 *
 * MV3 NOTE: This service worker is ephemeral and may restart at any time. 
 * All persistent state must be stored in chrome.storage.
 */

'use strict';

import { getDefaultDynamicRules } from './defaultDynamicRules.js';

const DEBUG = false;

// ─── INSTALL / STARTUP ────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    // Set default config on first install
    await chrome.storage.local.set({
      config: {
        networkBlocking: true,
        acceleration: true,
        cosmetic: true,
        hideShorts: false,
        hideMerch: true,
        hideOffers: true,
        suppressWarnings: true,
        accelerationSpeed: 16,
        blockPopUnders: true,
        blockPushNotifications: true,
        enabled: true,
      },
      stats: { networkBlocked: 0 },
      lastHarvestTime: Date.now(),
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
        '.ads-by-google', '[id^="ad-"]', '[class^="ad-"]'
      ],
      WARNING_SELECTORS: [
        'tp-yt-iron-overlay-backdrop', 'ytd-enforcement-message-view-model',
        '.ytd-enforcement-message-view-model', '#header-ad-container',
        '.yt-playability-error-supported-renderers'
      ],
      whitelist: []
    });
    if (DEBUG) console.log('[Chroma Ad-Blocker] Installed. Default config applied.');
  }

  // Load any saved dynamic rules on startup
  const { config: storedConfig } = await chrome.storage.local.get('config');
  const isEnabled = storedConfig ? storedConfig.enabled : true;
  const isNetworkBlocking = storedConfig && storedConfig.networkBlocking !== undefined ? storedConfig.networkBlocking : true;
  await updateDNRState(isEnabled && isNetworkBlocking);
});

chrome.runtime.onStartup.addListener(async () => {
  const { config: storedConfig } = await chrome.storage.local.get('config');
  const isEnabled = storedConfig ? storedConfig.enabled : true;
  const isNetworkBlocking = storedConfig && storedConfig.networkBlocking !== undefined ? storedConfig.networkBlocking : true;
  await updateDNRState(isEnabled && isNetworkBlocking);
});

// ─── DYNAMIC RULE UPDATES ─────────────────────────────────────────────────────
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
  'yt_ad_rules_part9'
];

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
 */
async function syncDynamicRules() {
  try {
    const stored = await chrome.storage.local.get('dynamicRules');
    const rules = stored.dynamicRules || getDefaultDynamicRules();

    // Only remove rules that are NOT whitelist rules (whitelist is 9,000,000+)
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existing.filter(r => r.id < 9000000).map(r => r.id);

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removeIds,
      addRules: rules,
    });

    if (DEBUG) console.log(`[Chroma Ad-Blocker] Synced ${rules.length} dynamic rules.`);
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
    
    // Whitelist rules use a safe high range (9,000,000+)
    const WHITELIST_START_ID = 9000000;
    
    // Remove all existing whitelist rules
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existing.filter(r => r.id >= WHITELIST_START_ID).map(r => r.id);
    
    const addRules = whitelist.map((domain, index) => ({
      id: WHITELIST_START_ID + index,
      priority: 999999, // Absolute priority
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

// Initial load and listen for updates
let config = { 
  enabled: true, 
  networkBlocking: true,
  hideShorts: false,
  hideMerch: true,
  hideOffers: true,
  blockPopUnders: true, 
  blockPushNotifications: true 
};

let whitelist = [];

chrome.storage.local.get(['config', 'whitelist']).then((data) => {
  if (data.config) config = { ...config, ...data.config };
  if (data.whitelist) whitelist = data.whitelist;
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.config) {
    config = { ...config, ...changes.config.newValue };
  }
  if (changes.whitelist) {
    whitelist = changes.whitelist.newValue || [];
  }
});

// ─── POP-UNDER DETECTION STATE ───────────────────────────────────────────────
// Keep track of window.open attempts per tab to prevent cross-tab interference
// Keyed by tabId to ensure strict isolation and prevent state-spoofing across browser sessions.
// SESSION_DATA: Stored in chrome.storage.session to survive Service Worker sleep cycles.
// Format: { popunderRequests: { tabId: data }, sessionTokens: { tabId: token }, tokenRetrievalLocked: { tabId: true } }
// Fallback: Captures the most recent window.open attempt for scenarios where 
// openerTabId is stripped by the browser (e.g. certain async popup methods).
let lastGlobalRequest = null; 

async function getSessionData() {
  const data = await chrome.storage.session.get(['popunderRequests', 'sessionTokens', 'tokenRetrievalLocked']);
  return {
    popunderRequests: data.popunderRequests || {},
    sessionTokens: data.sessionTokens || {},
    tokenRetrievalLocked: data.tokenRetrievalLocked || {}
  };
}

async function updateSessionData(key, value) {
  await chrome.storage.session.set({ [key]: value });
}

// Active listeners for tabs waiting on pop-under metadata from their opener during the creation handshake.
const popunderResolvers = new Map(); // openerTabId -> [ (request) => void ]

// PERIODIC CLEANUP: Remove stale pop-under requests every 30 seconds
setInterval(async () => {
  const now = Date.now();
  const { popunderRequests } = await getSessionData();
  let changed = false;

  for (const [tabId, data] of Object.entries(popunderRequests)) {
    if (now - data.time > 15000) { // Keep for 15s
      delete popunderRequests[tabId];
      changed = true;
    }
  }
  if (changed) {
    await updateSessionData('popunderRequests', popunderRequests);
  }

  if (lastGlobalRequest && now - lastGlobalRequest.time > 15000) {
    lastGlobalRequest = null;
  }
}, 30000);

// ─── MESSAGE TYPES ──────────────────────────────────────────────────────────
/**
 * Maintain parity with messaging.js. Content scripts and background workers 
 * operate in isolated scopes, requiring manual synchronization of constants.
 */
const MSG = {
  CONFIG_GET: 'CONFIG_GET',
  CONFIG_SET: 'CONFIG_SET',
  CONFIG_UPDATE: 'CONFIG_UPDATE',
  STATS_RESET: 'STATS_RESET',
  WINDOW_OPEN_NOTIFY: 'WINDOW_OPEN_NOTIFY',
  SUSPICIOUS_ACTIVITY: 'SUSPICIOUS_ACTIVITY',
  GET_TOKEN: 'GET_TOKEN',
  WHITELIST_GET: 'WHITELIST_GET',
  WHITELIST_ADD: 'WHITELIST_ADD',
  WHITELIST_REMOVE: 'WHITELIST_REMOVE'
};

// ─── CONFIGURATION VALIDATION ───────────────────────────────────────────────
function validateConfig(inputConfig) {
  const allowed = ['networkBlocking', 'acceleration', 'cosmetic', 'hideShorts', 'hideMerch', 'hideOffers', 'suppressWarnings', 'accelerationSpeed', 'blockPopUnders', 'blockPushNotifications', 'enabled'];
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


// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = async () => {
    try {
      const sessionData = await getSessionData();
      const tabId = _sender.tab?.id;

      // SECURITY: ORIGIN AUTHENTICATION
      const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
      const isFromInternal = _sender.origin === extensionOrigin;

      const SENSITIVE_TYPES = [
        MSG.CONFIG_GET,
        MSG.CONFIG_SET,
        MSG.STATS_RESET
      ];

      if (SENSITIVE_TYPES.includes(msg.type) && !isFromInternal) {
        if (DEBUG) console.error('[Chroma Security] Blocked unauthorized message from:', _sender.origin, msg.type);
        return;
      }

      switch (msg.type) {

        case MSG.WINDOW_OPEN_NOTIFY:
          const winToken = tabId ? sessionData.sessionTokens[tabId] : null;
          if (!winToken || msg.token !== winToken) return;
          if (tabId) {
            const existing = sessionData.popunderRequests[tabId] || { createdTabIds: [] };
            const request = {
              ...existing,
              tabId,
              time: Date.now(),
              isSuspicious: msg.isSuspicious,
              url: msg.url,
              popupCount: msg.popupCount,
              gestureType: msg.gestureType,
              stack: msg.stack
            };
            sessionData.popunderRequests[tabId] = request;
            await updateSessionData('popunderRequests', sessionData.popunderRequests);
            lastGlobalRequest = request;
            const resolvers = popunderResolvers.get(tabId);
            if (resolvers) {
              resolvers.forEach(res => res(request));
              popunderResolvers.delete(tabId);
            }
          }
          break;

        case MSG.SUSPICIOUS_ACTIVITY:
          const suspToken = tabId ? sessionData.sessionTokens[tabId] : null;
          if (!suspToken || msg.token !== suspToken) return;
          const { config: sConf, stats: sStats = {} } = await chrome.storage.local.get(['config', 'stats']);
          if (sConf && sConf.enabled === false) return;
          if (tabId) {
            const existing = sessionData.popunderRequests[tabId] || { time: Date.now(), createdTabIds: [] };
            existing.isSuspicious = true;
            existing.activity = msg.activity;
            sessionData.popunderRequests[tabId] = existing;
            if (existing.createdTabIds && existing.createdTabIds.length > 0) {
              existing.createdTabIds.forEach(id => chrome.tabs.remove(id).catch(() => {}));
              sStats.networkBlocked = (sStats.networkBlocked || 0) + existing.createdTabIds.length;
              await chrome.storage.local.set({ stats: sStats });
              existing.createdTabIds = [];
            }
            await updateSessionData('popunderRequests', sessionData.popunderRequests);
          }
          break;

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
          if (isDNRActive !== wasDNRActive) await updateDNRState(isDNRActive);
          const tabs = await chrome.tabs.query({});
          await Promise.all(tabs.map(t => chrome.tabs.sendMessage(t.id, { type: MSG.CONFIG_UPDATE, config: newConfig }).catch(() => {})));
          sendResponse({ ok: true });
          break;


        case MSG.STATS_RESET:
          await chrome.storage.local.set({ stats: { networkBlocked: 0 } });
          sendResponse({ ok: true });
          break;

        case MSG.GET_TOKEN:
          if (!_sender.tab || !_sender.url) return sendResponse({ error: 'Invalid Sender' });
          if (tabId) {
            if (sessionData.tokenRetrievalLocked[tabId]) return sendResponse({ error: 'Locked' });
            sessionData.tokenRetrievalLocked[tabId] = true;
            await updateSessionData('tokenRetrievalLocked', sessionData.tokenRetrievalLocked);
            const buffer = new Uint8Array(16);
            crypto.getRandomValues(buffer);
            const token = Array.from(buffer).map(b => b.toString(16).padStart(2, '0')).join('');
            sessionData.sessionTokens[tabId] = token;
            await updateSessionData('sessionTokens', sessionData.sessionTokens);
            sendResponse({ token });
          }
          break;

        case MSG.WHITELIST_GET:
          const { whitelist: wlGet = [] } = await chrome.storage.local.get('whitelist');
          sendResponse({ whitelist: wlGet });
          break;

        case MSG.WHITELIST_ADD:
          const { whitelist: wlAdd = [] } = await chrome.storage.local.get('whitelist');
          if (!wlAdd.includes(msg.domain)) {
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
      }
    } catch (err) {
      if (DEBUG) console.error('[Chroma] Error in message handler:', err);
    }
  };

  const p = handler();
  if (typeof globalThis !== 'undefined' && globalThis.__TESTING__) return p;
  return true;
});

// ─── TAB MONITORING (Pop-Under Blocker) ───────────────────────────────────────
chrome.tabs.onCreated.addListener(async (tab) => {
  const { config, whitelist } = await chrome.storage.local.get(['config', 'whitelist']);
  if (!config || config.enabled === false || config.blockPopUnders === false) return;

  // Kill Switch: Check if the opener tab is whitelisted
  const openerId = tab.openerTabId;
  if (openerId) {
    try {
      const openerTab = await chrome.tabs.get(openerId);
      if (openerTab && openerTab.url) {
        const u = new URL(openerTab.url);
        if (whitelist.some(d => u.hostname === d || u.hostname.endsWith('.' + d))) {
          if (DEBUG) console.log(`[Chroma] Not blocking popup from whitelisted domain: ${u.hostname}`);
          return;
        }
      }
    } catch (e) {
      // Opener might be closed or URL unavailable due to lack of permissions/timing
    }
  }

  // Timing Bridge: Wait up to 1000ms for the content script to deliver pop-under metadata 
  // via the secure pipe before making a blocking decision on the newly created tab.
  const sessionData = await getSessionData();
  let request = openerId ? sessionData.popunderRequests[openerId] : null;
  
  if (!request && lastGlobalRequest && (Date.now() - lastGlobalRequest.time < 2000)) {
    request = lastGlobalRequest;
  }

  // If no match yet, wait for the notification to arrive via promise resolution
  if (!request && openerId) {
    request = await new Promise(resolve => {
      const resolvers = popunderResolvers.get(openerId) || [];
      const timeout = setTimeout(() => {
        const list = popunderResolvers.get(openerId);
        if (list) {
          const idx = list.indexOf(resolve);
          if (idx !== -1) list.splice(idx, 1);
          if (list.length === 0) popunderResolvers.delete(openerId);
        }
        resolve(null);
      }, (typeof globalThis !== 'undefined' && globalThis.__CHROMA_TEST_TIMEOUT__) || 1000); // Configurable wait for sync

      resolvers.push((req) => {
        clearTimeout(timeout);
        resolve(req);
      });
      popunderResolvers.set(openerId, resolvers);
    });
  }

  const now = Date.now();
  if (!request) return;
  if (!request.createdTabIds) request.createdTabIds = [];

  const timeSinceNotify = now - request.time;
  
  const stackLower = (request.stack || '').toLowerCase();
  const isAdScript = stackLower.includes('pop') || 
                      stackLower.includes('ad') || 
                      stackLower.includes('promo') || 
                      stackLower.includes('test') || 
                      stackLower.includes('click');

  if ((request.isSuspicious || request.popupCount > 1 || isAdScript) && timeSinceNotify < 3000) {
    if (DEBUG) console.warn(`[Chroma Ad-Blocker] Blocking suspicious pop-under: ${tab.pendingUrl || tab.url || 'unknown'}`);
    
    // Close the tab
    chrome.tabs.remove(tab.id).catch(() => {});
    
    // Increment stats
    chrome.storage.local.get('stats').then(({ stats = {} }) => {
      stats.networkBlocked = (stats.networkBlocked || 0) + 1;
      chrome.storage.local.set({ stats });
    });

    if (openerId) {
      delete sessionData.popunderRequests[openerId];
      await updateSessionData('popunderRequests', sessionData.popunderRequests);
    }
    if (request === lastGlobalRequest) lastGlobalRequest = null;
  } else {
    // If it's not immediately suspicious, store the tabId for potential retroactive closing
    request.createdTabIds.push(tab.id);
    await updateSessionData('popunderRequests', sessionData.popunderRequests);
  }
});

// ─── NETWORK BLOCK TRACKING (DNR) ───────────────────────────────────────────
/**
 * Developer Mode Check: onRuleMatchedDebug only provides real-time updates 
 * when the extension is loaded as an unpacked directory.
 */
if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    chrome.storage.local.get('stats').then(({ stats = {} }) => {
      stats.networkBlocked = (stats.networkBlocked || 0) + 1;
      chrome.storage.local.set({ stats });
    });
  });
}

/**
 * Production Path: Accumulate matches via getMatchedRules since 
 * onRuleMatchedDebug is limited to developer installs.
 */
async function harvestNetworkStats() {
  try {
    const { stats = {}, lastHarvestTime = 0 } = await chrome.storage.local.get(['stats', 'lastHarvestTime']);
    
    // Use the native minTimeStamp filter (requires declarativeNetRequestFeedback)
    // We add +1 to avoid re-counting the exact same match at the boundary
    const matchedRules = await chrome.declarativeNetRequest.getMatchedRules({
      minTimeStamp: lastHarvestTime + 1
    });
    
    const newMatches = matchedRules.rulesMatched || [];
    
    if (newMatches.length > 0) {
      const latestMatchTime = Math.max(...newMatches.map(m => m.timeStamp));
      stats.networkBlocked = (stats.networkBlocked || 0) + newMatches.length;
      
      await chrome.storage.local.set({ 
        stats, 
        lastHarvestTime: latestMatchTime 
      });
      if (DEBUG) console.log(`[Chroma Ad-Blocker] Harvested ${newMatches.length} network blocks. Total: ${stats.networkBlocked}`);
    }
  } catch (err) {
    if (DEBUG) console.warn('[Chroma Ad-Blocker] Error harvesting network stats:', err);
  }
}

// PERIODIC HARVEST: Every 2 minutes while active
setInterval(harvestNetworkStats, 120000);

// Clean up and final harvest
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const sessionData = await getSessionData();
  let changed = false;

  if (sessionData.popunderRequests[tabId]) {
    delete sessionData.popunderRequests[tabId];
    changed = true;
  }
  if (sessionData.sessionTokens[tabId]) {
    delete sessionData.sessionTokens[tabId];
    changed = true;
  }
  if (sessionData.tokenRetrievalLocked[tabId]) {
    delete sessionData.tokenRetrievalLocked[tabId];
    changed = true;
  }

  if (changed) {
    await chrome.storage.session.set(sessionData);
  }
  
  harvestNetworkStats().catch(() => {});
});

// ─── TESTING EXPORTS ────────────────────────────────────────────────────────
if (typeof globalThis !== 'undefined' && globalThis.__TESTING__) {
  globalThis.CONFIG = config;
  globalThis.MSG = MSG;
  globalThis.updateDNRState = updateDNRState;
  globalThis.syncDynamicRules = syncDynamicRules;
  globalThis.harvestNetworkStats = harvestNetworkStats;
}
