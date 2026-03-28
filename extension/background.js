/**
 * Chroma Ad-Blocker - Service Worker (MV3 Background)
 * Handles: dynamic rule updates, stat tracking, config persistence
 *
 * MV3 NOTE: This service worker is ephemeral — it shuts down after
 * ~30 seconds of inactivity. All persistent state uses chrome.storage.
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
      stats: { networkBlocked: 0, accelerated: 0 },
      ruleCounter: 5000000,
      lastHarvestTime: Date.now(),
      // Primary copy of cosmetic selectors (Synchronized with extension/utils/selectors.js)
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
const popunderRequests = new Map(); // tabId -> { time: number, isSuspicious: boolean, createdTabIds: number[], ... }
let lastGlobalRequest = null; // Fallback for when openerTabId is missing

// RESOLVER SYNC: Track tabs waiting for a WINDOW_OPEN_NOTIFY from their opener
const popunderResolvers = new Map(); // openerTabId -> [ (request) => void ]

// SESSION TOKENS: track secure tokens per tab to prevent spoofing (VULN-02 Fix)
const sessionTokens = new Map(); // tabId -> token
const tokenRetrievalLocked = new Set(); // tabId

// PERIODIC CLEANUP: Remove stale pop-under requests every 30 seconds
setInterval(() => {
  const now = Date.now();
  for (const [tabId, data] of popunderRequests.entries()) {
    if (now - data.time > 15000) { // Keep for 15s
      popunderRequests.delete(tabId);
    }
  }
  if (lastGlobalRequest && now - lastGlobalRequest.time > 15000) {
    lastGlobalRequest = null;
  }
}, 30000);

// ─── MESSAGE TYPES ──────────────────────────────────────────────────────────
/**
 * NOTE: This constant must be kept in sync with messaging.js.
 * Since background.js is a module in MV3, it doesn't share the same
 * global scope as content scripts.
 */
const MSG = {
  CONFIG_GET: 'CONFIG_GET',
  CONFIG_SET: 'CONFIG_SET',
  CONFIG_UPDATE: 'CONFIG_UPDATE',
  STATS_GET: 'STATS_GET',
  STATS_RESET: 'STATS_RESET',
  STATS_UPDATE: 'STATS_UPDATE',
  DYNAMIC_RULE_ADD: 'DYNAMIC_RULE_ADD',
  DYNAMIC_RULE_REMOVE: 'DYNAMIC_RULE_REMOVE',
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


function validateDynamicRule(rule) {
  const validatedRule = {};

  if (!rule || typeof rule !== 'object') {
    return null;
  }

  // 1. Priority validation
  if (typeof rule.priority === 'number') {
    validatedRule.priority = rule.priority;
  }

  // 2. Action validation
  if (rule.action && typeof rule.action === 'object') {
    const type = rule.action.type;
    if (type === 'block' || type === 'allow') {
      validatedRule.action = { type };
    }
  }

  // 3. Condition validation
  if (rule.condition && typeof rule.condition === 'object') {
    const condition = {};
    if (typeof rule.condition.urlFilter === 'string') {
      const filter = rule.condition.urlFilter;
      
      // SECURITY: Domain/Filter length sanitization (RFC 1035 limits)
      if (filter.length > 253) return null;

      // SECURITY: Hardcoded Denylist (Never whitelist core ad/tracking domains)
      const ABSOLUTE_DENYLIST = ['doubleclick.net', 'googlesyndication.com', 'google-analytics.com'];
      if (rule.action?.type === 'allow') {
        if (ABSOLUTE_DENYLIST.some(d => filter.includes(d))) {
          if (DEBUG) console.error('[Chroma Security] Blocked attempt to whitelist denylisted domain:', filter);
          return null;
        }
      }

      condition.urlFilter = filter;
    }
    
    if (typeof rule.condition.regexFilter === 'string') {
      // SECURITY: Basic regex length limit to prevent ReDoS in background context
      if (rule.condition.regexFilter.length > 500) return null;
      condition.regexFilter = rule.condition.regexFilter;
    }

    const arrayProps = [
      'initiatorDomains',
      'excludedInitiatorDomains',
      'requestDomains',
      'excludedRequestDomains',
      'resourceTypes',
      'excludedResourceTypes',
      'requestMethods',
      'excludedRequestMethods'
    ];

    for (const prop of arrayProps) {
      if (Array.isArray(rule.condition[prop])) {
        condition[prop] = rule.condition[prop].filter(item => typeof item === 'string' && item.length < 253);
      }
    }

    validatedRule.condition = condition;
  }

  // Basic validation for mandatory rule fields
  if (!validatedRule.action || !validatedRule.condition || Object.keys(validatedRule.condition).length === 0) {
    return null;
  }

  return validatedRule;
}

/**
 * Handle CLOSE_TAB request from content script.
 * SECURITY RULE: Only ever close the tab that the message originated from.
 */
function handleCloseTab(sender, sendResponse) {
  const targetTabId = sender.tab?.id;
  if (!targetTabId) {
    if (DEBUG) console.error('[Chroma] Cannot close tab: Sender tab ID undefined.');
    sendResponse({ ok: false, error: 'No tabId found' });
    return;
  }

  chrome.tabs.remove(targetTabId)
    .then(() => {
      sendResponse({ ok: true, action: 'TAB_CLOSED' });
    })
    .catch(err => {
      if (DEBUG) console.error(`[Chroma] Failed to close tab ${targetTabId}:`, err);
      sendResponse({ ok: false, error: err.message });
    });
}


// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // ROUTER: Handle messages forwarded by protection.js from the Main World
  if (msg.source === 'chroma_interceptor') {
    if (DEBUG) console.log('[Chroma Ad-Blocker] Routed action from interceptor:', msg.action, msg.payload);
    
    // SECURITY: Verify the token for all MAIN world commands (VULN-02 Fix)
    const storedToken = sessionTokens.get(_sender.tab?.id);
    if (!storedToken || msg.token !== storedToken) {
      if (DEBUG) console.error('[Chroma Security] Rejected MAIN world command: Invalid Token.');
      sendResponse({ ok: false, error: 'Unauthorized' });
      return;
    }

    // SECURITY: Whitelist allowed bridge actions (VULN: Messaging Bridge Abuse)
    const ALLOWED_INTERCEPTOR_ACTIONS = ['STATS_UPDATE', 'CLOSE_TAB'];
    
    if (!ALLOWED_INTERCEPTOR_ACTIONS.includes(msg.action)) {
      if (DEBUG) console.error(`[Chroma Security] Rejected unauthorized action from interceptor: ${msg.action}`);
      sendResponse({ ok: false, error: 'Unauthorized Action' });
      return;
    }

    switch (msg.action) {
      case 'CLOSE_TAB':
        handleCloseTab(_sender, sendResponse);
        break;
      case 'STATS_UPDATE':
        // ACCUMULATE STATS FROM MAIN WORLD
        chrome.storage.local.get(['stats']).then(({ stats = {} }) => {
          if (msg.payload && msg.payload.type === 'accelerated') {
            stats.accelerated = (stats.accelerated || 0) + 1;
            chrome.storage.local.set({ stats });
            if (DEBUG) console.log('[Chroma] Stat incremented via secure port:', stats.accelerated);
          }
        });
        sendResponse({ ok: true });
        break;
    }
    return true; // Keep channel open for async responses
  }

  // SECURITY: ORIGIN AUTHENTICATION
  // Strictly reject sensitive commands from any origin that isn't our extension's own UI/Background.
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
  const isFromInternal = _sender.origin === extensionOrigin;

  const SENSITIVE_TYPES = [
    MSG.STATS_GET,
    MSG.CONFIG_GET,
    MSG.CONFIG_SET,
    MSG.DYNAMIC_RULE_ADD,
    MSG.DYNAMIC_RULE_REMOVE,
    MSG.STATS_RESET
  ];

  if (SENSITIVE_TYPES.includes(msg.type) && !isFromInternal) {
    if (DEBUG) console.error('[Chroma Security] Blocked unauthorized message from:', _sender.origin, msg.type);
    return false; // Fail closed
  }

  if (msg.type === MSG.STATS_UPDATE) {
    // Only accept from extension context (popup) or if specifically allowed
    // Note: Main world handlers now use the 'chroma_interceptor' block above.
    if (!isFromInternal) {
      if (DEBUG) console.warn('[Chroma Security] Rejected legacy STATS_UPDATE from external origin.');
      return false;
    }

    chrome.storage.local.get(['config', 'stats']).then(({ config: storedConfig, stats = {} }) => {
      if (storedConfig && storedConfig.enabled === false) return;
      
      const accelerated = Number.isInteger(msg.stats?.accelerated) ? msg.stats.accelerated : 0;
      stats.accelerated = (stats.accelerated || 0) + accelerated;
      chrome.storage.local.set({ stats });
    });
    return false;
  }

  if (msg.type === MSG.WINDOW_OPEN_NOTIFY) {
    const storedToken = sessionTokens.get(_sender.tab?.id);
    if (!storedToken || msg.token !== storedToken) {
      if (DEBUG) console.error('[Chroma Security] Rejected WINDOW_OPEN_NOTIFY: Invalid Token.');
      return false;
    }
    const tabId = _sender.tab?.id;
    if (tabId) {
      const existing = popunderRequests.get(tabId) || { createdTabIds: [] };
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
      popunderRequests.set(tabId, request);
      lastGlobalRequest = request; // Store as global fallback
      
      // RESOLVE PENDING: Notify any tabs created by this opener that were waiting for synchronization
      const resolvers = popunderResolvers.get(tabId);
      if (resolvers) {
        resolvers.forEach(res => res(request));
        popunderResolvers.delete(tabId);
      }

      if (DEBUG) console.log(`[Chroma Ad-Blocker] Window open notification from tab ${tabId}:`, msg);
    }
    return false;
  }

  if (msg.type === MSG.SUSPICIOUS_ACTIVITY) {
    const storedToken = sessionTokens.get(_sender.tab?.id);
    if (!storedToken || msg.token !== storedToken) {
      if (DEBUG) console.error('[Chroma Security] Rejected SUSPICIOUS_ACTIVITY: Invalid Token.');
      return false;
    }
    chrome.storage.local.get(['config', 'stats']).then(({ config: storedConfig, stats = {} }) => {
      if (storedConfig && storedConfig.enabled === false) return;

      const tabId = _sender.tab?.id;
      if (tabId) {
        const existing = popunderRequests.get(tabId) || { time: Date.now(), createdTabIds: [] };
        existing.isSuspicious = true;
        existing.activity = msg.activity;
        popunderRequests.set(tabId, existing);

        // RETROACTIVE CLOSING: If any tabs were just opened from this opener, close them now
        if (existing.createdTabIds && existing.createdTabIds.length > 0) {
          if (DEBUG) console.log(`[Chroma Ad-Blocker] Successfully blocked ${existing.createdTabIds.length} pop-under(s) (Retroactive: ${msg.activity})`);
          existing.createdTabIds.forEach(id => {
            chrome.tabs.remove(id).catch(() => {});
          });
          
          // Update stats (Network/Pop-under blocks)
          stats.networkBlocked = (stats.networkBlocked || 0) + existing.createdTabIds.length;
          chrome.storage.local.set({ stats });
          
          existing.createdTabIds = [];
        }
        
        if (DEBUG) console.log(`[Chroma Ad-Blocker] Suspicious activity notification from tab ${tabId}:`, msg);
      }
    });
    return false;
  }

  // MSG.STATS_GET removed in favor of reactive storage listeners in popup.js

  if (msg.type === MSG.CONFIG_GET) {
    chrome.storage.local.get('config').then(({ config }) => {
      sendResponse(config);
    });
    return true;
  }

  if (msg.type === MSG.CONFIG_SET) {
    chrome.storage.local.get('config').then(async ({ config }) => {
      const validatedConfig = validateConfig(msg.config);
      const newConfig = { ...config, ...validatedConfig };
      await chrome.storage.local.set({ config: newConfig });
      
      const wasDNRActive = config.enabled !== false && config.networkBlocking !== false;
      const isDNRActive = newConfig.enabled !== false && newConfig.networkBlocking !== false;

      if (isDNRActive !== wasDNRActive) {
        await updateDNRState(isDNRActive);
      }

      // Broadcast to all tabs
      const tabs = await chrome.tabs.query({});
      await Promise.all(tabs.map(tab =>
        chrome.tabs.sendMessage(tab.id, { type: MSG.CONFIG_UPDATE, config: newConfig }).catch(() => {})
      ));
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === MSG.DYNAMIC_RULE_ADD) {
    // Allow popup/user to inject new rules (block or allow) at runtime
    chrome.storage.local.get(['dynamicRules', 'ruleCounter']).then(async ({ dynamicRules = [], ruleCounter }) => {
      if (!ruleCounter) ruleCounter = 5000000;

      const validatedRule = validateDynamicRule(msg.rule);
      if (!validatedRule) {
        return sendResponse({ ok: false, error: 'Invalid rule structure' });
      }

      const newRule = { id: ruleCounter++, ...validatedRule };
      dynamicRules.push(newRule);
      
      await chrome.storage.local.set({ 
        dynamicRules,
        ruleCounter: ruleCounter
      });
      
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [newRule] });
      sendResponse({ ok: true, ruleId: newRule.id });
    });
    return true;
  }

  if (msg.type === MSG.DYNAMIC_RULE_REMOVE) {
    chrome.storage.local.get('dynamicRules').then(async ({ dynamicRules = [] }) => {
      const ruleId = msg.ruleId;
      const initialLength = dynamicRules.length;
      const updatedRules = dynamicRules.filter(r => r.id !== ruleId);
      
      if (updatedRules.length === initialLength) {
        return sendResponse({ ok: false, error: 'Rule not found' });
      }

      await chrome.storage.local.set({ dynamicRules: updatedRules });
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === MSG.STATS_RESET) {
    chrome.storage.local.get('stats').then(({ stats = {} }) => {
      stats.networkBlocked = 0;
      stats.accelerated = 0;
      chrome.storage.local.set({ stats })
        .then(() => sendResponse({ ok: true }));
    });
    return true;
  }

  if (msg.type === MSG.GET_TOKEN) {
    // SECURITY: Ensure request is from a legitimate content script (VULN: Token Hijack)
    if (!_sender.tab || !_sender.url) {
        if (DEBUG) console.error('[Chroma Security] Rejected token request: Missing sender context.');
        return sendResponse({ error: 'Invalid Sender' });
    }

    const tabId = _sender.tab.id;
    
    // SECURITY: Once a token is retrieved, lock subsequent requests for this tab (VULN-02 Fix)
    if (tokenRetrievalLocked.has(tabId)) {
      if (DEBUG) console.error(`[Chroma Security] Blocked duplicate token retrieval for tab ${tabId}`);
      return sendResponse({ error: 'Locked' });
    }
    tokenRetrievalLocked.add(tabId);

    // Generate a unique session token
    const buffer = new Uint8Array(16);
    crypto.getRandomValues(buffer);
    const token = Array.from(buffer).map(b => b.toString(16).padStart(2, '0')).join('');
    
    sessionTokens.set(tabId, token);
    sendResponse({ token });
    return;
  }

  if (msg.type === MSG.WHITELIST_GET) {
    chrome.storage.local.get('whitelist').then(({ whitelist = [] }) => {
      sendResponse({ whitelist });
    });
    return true;
  }

  if (msg.type === MSG.WHITELIST_ADD) {
    chrome.storage.local.get('whitelist').then(async ({ whitelist = [] }) => {
      if (!whitelist.includes(msg.domain)) {
        whitelist.push(msg.domain);
        await chrome.storage.local.set({ whitelist });
        await syncWhitelistRules();
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === MSG.WHITELIST_REMOVE) {
    chrome.storage.local.get('whitelist').then(async ({ whitelist = [] }) => {
      const updated = whitelist.filter(d => d !== msg.domain);
      if (updated.length !== whitelist.length) {
        await chrome.storage.local.set({ whitelist: updated });
        await syncWhitelistRules();
      }
      sendResponse({ ok: true });
    });
    return true;
  }
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

  // Give a small grace period for the WINDOW_OPEN_NOTIFY to arrive from content script
  // since postMessage -> runtime.sendMessage is slightly slower than tab creation.
  let request = openerId ? popunderRequests.get(openerId) : null;
  
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
      }, 1000); // 1s max wait for sync

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

    if (openerId) popunderRequests.delete(openerId);
    if (request === lastGlobalRequest) lastGlobalRequest = null;
  } else {
    // If it's not immediately suspicious, store the tabId for potential retroactive closing
    request.createdTabIds.push(tab.id);
  }
});

// ─── NETWORK BLOCK TRACKING (DNR) ───────────────────────────────────────────
/**
 * FAST-PATH: onRuleMatchedDebug ONLY works in Developer Mode (unpacked).
 * It provides real-time updates which is great for the developer experience.
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
 * PRODUCTION-PATH: In packed extensions, we must harvest stats manually.
 * We use getMatchedRules with minTimeStamp for efficiency.
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
chrome.tabs.onRemoved.addListener((tabId) => {
  popunderRequests.delete(tabId);
  sessionTokens.delete(tabId); // Cleanup session token (VULN-02 Fix)
  tokenRetrievalLocked.delete(tabId);
  harvestNetworkStats().catch(() => {});
});

// ─── TESTING EXPORTS ────────────────────────────────────────────────────────
if (typeof globalThis !== 'undefined' && globalThis.__TESTING__) {
  globalThis.CONFIG = config;
  globalThis.MSG = MSG;
  globalThis.updateDNRState = updateDNRState;
  globalThis.syncDynamicRules = syncDynamicRules;
  globalThis.harvestNetworkStats = harvestNetworkStats;
  globalThis.validateDynamicRule = validateDynamicRule;
}
