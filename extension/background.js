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

// ─── INSTALL / STARTUP ─────
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await chrome.storage.local.set({
      config: {
        networkBlocking: true,
        acceleration: true,
        cosmetic: true,
        hideShorts: false,
        hideMerch: true,
        hideOffers: true,
        suppressWarnings: true,
        accelerationSpeed: 16, // Maximum playback rate supported for ad acceleration
        blockPushNotifications: true,
        enabled: true,
      },
      stats: { networkBlocked: 0 },
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
 * @returns {Promise<void>}
 */
async function syncDynamicRules() {
  try {
    const stored = await chrome.storage.local.get('dynamicRules');
    const rules = stored.dynamicRules || getDefaultDynamicRules();

    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existing.filter(r => r.id < 9000000).map(r => r.id); // Exclude whitelist range (9,000,000+)

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
    
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existing.filter(r => r.id >= WHITELIST_START_ID).map(r => r.id);
    
    const addRules = whitelist.map((domain, index) => ({
      id: WHITELIST_START_ID + index,
      priority: 999999, // Absolute Priority
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



async function getSessionData() {
  const data = await chrome.storage.session.get(['sessionTokens', 'tokenRetrievalLocked']);
  return {
    sessionTokens: data.sessionTokens || {},
    tokenRetrievalLocked: data.tokenRetrievalLocked || {}
  };
}

async function updateSessionData(key, value) {
  await chrome.storage.session.set({ [key]: value });
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
  GET_TOKEN: 'GET_TOKEN',
  WHITELIST_GET: 'WHITELIST_GET',
  WHITELIST_ADD: 'WHITELIST_ADD',
  WHITELIST_REMOVE: 'WHITELIST_REMOVE',
  SUSPICIOUS_ACTIVITY: 'SUSPICIOUS_ACTIVITY'
};

// ─── CONFIGURATION VALIDATION ─────
function validateConfig(inputConfig) {
  const allowed = ['networkBlocking', 'acceleration', 'cosmetic', 'hideShorts', 'hideMerch', 'hideOffers', 'suppressWarnings', 'accelerationSpeed', 'blockPushNotifications', 'enabled'];
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
      const sessionData = await getSessionData();
      const tabId = _sender.tab?.id;
      const docId = _sender.documentId;

      // SECURITY: Origin Authentication
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
          
          // Use documentId as primary identifier (MV3 best practice); fallback to tabId for compatibility.
          const sessionKey = docId || (tabId ? `${tabId}:${_sender.frameId || 0}` : null);

          if (sessionKey) {
            if (sessionData.tokenRetrievalLocked[sessionKey]) return sendResponse({ error: 'Locked' });
            sessionData.tokenRetrievalLocked[sessionKey] = true;
            await updateSessionData('tokenRetrievalLocked', sessionData.tokenRetrievalLocked);
            
            const buffer = new Uint8Array(16); // 128-bit entropy for session token generation
            crypto.getRandomValues(buffer);
            const token = Array.from(buffer).map(b => b.toString(16).padStart(2, '0')).join('');
            
            // Store both token and tabId to allow for precise cleanup on tab removal.
            sessionData.sessionTokens[sessionKey] = { token, tabId };
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
        case MSG.SUSPICIOUS_ACTIVITY:
          const actSessionKey = docId || (tabId ? `${tabId}:${_sender.frameId || 0}` : null);
          const sessionEntry = sessionData.sessionTokens[actSessionKey];
          if (sessionEntry && sessionEntry.token === msg.token) {
            if (DEBUG) console.warn(`[Chroma Security] Suspicious Activity on session ${actSessionKey}:`, msg.activity);
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


// ─── NETWORK BLOCK TRACKING (DNR) ─────
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



chrome.tabs.onRemoved.addListener(async (tabId) => {
  const sessionData = await getSessionData();
  let changed = false;

  // Cleanup all sessions (documentId or fallback keys) belonging to this tabId
  for (const key in sessionData.sessionTokens) {
    const entry = sessionData.sessionTokens[key];
    // Check if it's a new-style object entry or an old-style tabId fallback key
    if ((entry && entry.tabId === tabId) || key === String(tabId) || key.startsWith(`${tabId}:`)) {
      delete sessionData.sessionTokens[key];
      // Also clear corresponding lock
      delete sessionData.tokenRetrievalLocked[key];
      changed = true;
    }
  }

  if (changed) {
    await chrome.storage.session.set(sessionData);
  }
});

// ─── TESTING EXPORTS ────────────────────────────────────────────────────────
if (typeof globalThis !== 'undefined' && globalThis.__TESTING__) {
  /** @type {Function} */
  globalThis.syncDynamicRules = syncDynamicRules;
}
