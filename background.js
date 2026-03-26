/**
 * Chroma Ad-Blocker - Service Worker (MV3 Background)
 * Handles: dynamic rule updates, stat tracking, config persistence
 *
 * MV3 NOTE: This service worker is ephemeral — it shuts down after
 * ~30 seconds of inactivity. All persistent state uses chrome.storage.
 */

'use strict';

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

    // Remove all existing dynamic rules first
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existing.map(r => r.id);

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
 * Default dynamic rules — these supplement the static rules.json.
 * Because these are dynamic, they can be updated at runtime without
 * going through the extension store review process.
 */
function getDefaultDynamicRules() {
  return [
    // Allow YouTube's ad measurement ping endpoints (Exemption)
    {
      id: 1001,
      priority: 1,
      action: { type: 'allow' },
      condition: {
        urlFilter: '/api/stats/ads',
        initiatorDomains: ['youtube.com', 'www.youtube.com'],
        resourceTypes: ['xmlhttprequest', 'image', 'ping'],
      },
    },
    {
      id: 1002,
      priority: 1,
      action: { type: 'allow' },
      condition: {
        urlFilter: '/pagead/viewthroughconversion',
        resourceTypes: ['image', 'xmlhttprequest', 'ping'],
      },
    },
    // Allow ad companion banners fetched via XHR (Exemption)
    {
      id: 1003,
      priority: 1,
      action: { type: 'allow' },
      condition: {
        urlFilter: '/get_video_info?*adformat',
        initiatorDomains: ['youtube.com', 'www.youtube.com'],
        resourceTypes: ['xmlhttprequest'],
      },
    },
    // Allow DoubleClick pixel tracking (Exemption)
    {
      id: 1004,
      priority: 1,
      action: { type: 'allow' },
      condition: {
        urlFilter: '||cm.g.doubleclick.net^',
        resourceTypes: ['image', 'ping', 'xmlhttprequest'],
      },
    },
    {
      id: 1005,
      priority: 1,
      action: { type: 'allow' },
      condition: {
        urlFilter: '||ad.doubleclick.net^',
        resourceTypes: ['image', 'ping', 'xmlhttprequest', 'script'],
      },
    },
    // Allow YouTube's "Engagement Panel" ad calls (Exemption)
    {
      id: 1006,
      priority: 1,
      action: { type: 'allow' },
      condition: {
        urlFilter: '/youtubei/v1/log_event',
        initiatorDomains: ['youtube.com', 'www.youtube.com'],
        resourceTypes: ['xmlhttprequest'],
      },
    },
  ];
}

// ─── CONFIGURATION STATE ──────────────────────────────────────────────────
let config = { 
  enabled: true, 
  networkBlocking: true,
  hideShorts: false,
  hideMerch: true,
  hideOffers: true,
  blockPopUnders: true, 
  blockPushNotifications: true 
};

// Initial load and listen for updates
chrome.storage.local.get('config').then(({ config: storedConfig }) => {
  if (storedConfig) config = { ...config, ...storedConfig };
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.config) {
    config = { ...config, ...changes.config.newValue };
  }
});

// ─── POP-UNDER DETECTION STATE ───────────────────────────────────────────────
// Keep track of window.open attempts per tab to prevent cross-tab interference
const popunderRequests = new Map(); // tabId -> { time: number, isSuspicious: boolean, createdTabIds: number[], ... }
let lastGlobalRequest = null; // Fallback for when openerTabId is missing

// RESOLVER SYNC: Track tabs waiting for a WINDOW_OPEN_NOTIFY from their opener
const popunderResolvers = new Map(); // openerTabId -> [ (request) => void ]

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
  WINDOW_OPEN_NOTIFY: 'WINDOW_OPEN_NOTIFY',
  SUSPICIOUS_ACTIVITY: 'SUSPICIOUS_ACTIVITY'
};

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // SECURITY: Restrict sensitive message types to internal extension pages (e.g. popup)
  // Content scripts always have a sender.tab property. Internal pages do not.
  const isFromInternal = !_sender.tab;
  const SENSITIVE_TYPES = [
    MSG.STATS_GET,
    MSG.CONFIG_GET,
    MSG.CONFIG_SET,
    MSG.DYNAMIC_RULE_ADD,
    MSG.STATS_RESET
  ];

  if (SENSITIVE_TYPES.includes(msg.type) && !isFromInternal) {
    return false;
  }

  if (msg.type === MSG.STATS_UPDATE) {
    // Accumulate stats from content scripts
    chrome.storage.local.get(['config', 'stats']).then(({ config: storedConfig, stats = {} }) => {
      if (storedConfig && storedConfig.enabled === false) return;
      
      const accelerated = Number.isInteger(msg.stats?.accelerated) ? msg.stats.accelerated : 0;
      // We no longer track 'blocked' (cosmetic) in the main stats row per user request
      
      stats.accelerated = (stats.accelerated || 0) + accelerated;
      chrome.storage.local.set({ stats });
    });
    return false;
  }

  if (msg.type === MSG.WINDOW_OPEN_NOTIFY) {
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

  if (msg.type === MSG.STATS_GET) {
    // Attempt to harvest matches before returning stats
    harvestNetworkStats().catch(() => {}).finally(() => {
      chrome.storage.local.get('stats').then(({ stats }) => {
        sendResponse(stats || { networkBlocked: 0, accelerated: 0 });
      });
    });
    return true; // keep channel open for async response
  }

  if (msg.type === MSG.CONFIG_GET) {
    chrome.storage.local.get('config').then(({ config }) => {
      sendResponse(config);
    });
    return true;
  }

  if (msg.type === MSG.CONFIG_SET) {
    chrome.storage.local.get('config').then(async ({ config }) => {
      // Validate and extract only allowed properties
      const allowed = ['networkBlocking', 'acceleration', 'cosmetic', 'hideShorts', 'hideMerch', 'hideOffers', 'suppressWarnings', 'accelerationSpeed', 'blockPopUnders', 'blockPushNotifications', 'enabled'];
      const validatedConfig = {};

      if (msg.config && typeof msg.config === 'object') {
        for (const key of allowed) {
          if (Object.prototype.hasOwnProperty.call(msg.config, key)) {
            const val = msg.config[key];
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
    // Allow popup/user to inject new block rules at runtime
    chrome.storage.local.get(['dynamicRules', 'ruleCounter']).then(async ({ dynamicRules = [], ruleCounter }) => {
      // Force initialization for legacy users who didn't get it via onInstalled
      if (!ruleCounter) {
        ruleCounter = 5000000;
      }

      const validatedRule = {};

      if (msg.rule && typeof msg.rule === 'object') {
        if (typeof msg.rule.priority === 'number') {
          validatedRule.priority = msg.rule.priority;
        }

        if (msg.rule.action && typeof msg.rule.action === 'object') {
          const type = msg.rule.action.type;
          if (type === 'block' || type === 'allow') {
            validatedRule.action = { type };
          }
        }

        if (msg.rule.condition && typeof msg.rule.condition === 'object') {
          const condition = {};
          if (typeof msg.rule.condition.urlFilter === 'string') {
            condition.urlFilter = msg.rule.condition.urlFilter;
          }
          if (typeof msg.rule.condition.regexFilter === 'string') {
            condition.regexFilter = msg.rule.condition.regexFilter;
          }
          if (Array.isArray(msg.rule.condition.initiatorDomains)) {
            condition.initiatorDomains = msg.rule.condition.initiatorDomains.filter(d => typeof d === 'string');
          }
          if (Array.isArray(msg.rule.condition.excludedInitiatorDomains)) {
            condition.excludedInitiatorDomains = msg.rule.condition.excludedInitiatorDomains.filter(d => typeof d === 'string');
          }
          if (Array.isArray(msg.rule.condition.requestDomains)) {
            condition.requestDomains = msg.rule.condition.requestDomains.filter(d => typeof d === 'string');
          }
          if (Array.isArray(msg.rule.condition.excludedRequestDomains)) {
            condition.excludedRequestDomains = msg.rule.condition.excludedRequestDomains.filter(d => typeof d === 'string');
          }
          if (Array.isArray(msg.rule.condition.resourceTypes)) {
            condition.resourceTypes = msg.rule.condition.resourceTypes.filter(r => typeof r === 'string');
          }
          if (Array.isArray(msg.rule.condition.excludedResourceTypes)) {
            condition.excludedResourceTypes = msg.rule.condition.excludedResourceTypes.filter(r => typeof r === 'string');
          }
          if (Array.isArray(msg.rule.condition.requestMethods)) {
            condition.requestMethods = msg.rule.condition.requestMethods.filter(m => typeof m === 'string');
          }
          if (Array.isArray(msg.rule.condition.excludedRequestMethods)) {
            condition.excludedRequestMethods = msg.rule.condition.excludedRequestMethods.filter(m => typeof m === 'string');
          }

          validatedRule.condition = condition;
        }
      }

      // Basic validation for mandatory rule fields
      if (!validatedRule.action || !validatedRule.condition || Object.keys(validatedRule.condition).length === 0) {
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

  if (msg.type === MSG.STATS_RESET) {
    chrome.storage.local.get('stats').then(({ stats = {} }) => {
      stats.networkBlocked = 0;
      stats.accelerated = 0;
      chrome.storage.local.set({ stats })
        .then(() => sendResponse({ ok: true }));
    });
    return true;
  }
});

// ─── TAB MONITORING (Pop-Under Blocker) ───────────────────────────────────────
chrome.tabs.onCreated.addListener(async (tab) => {
  const { config: storedConfig } = await chrome.storage.local.get('config');
  if (storedConfig && (storedConfig.enabled === false || storedConfig.blockPopUnders === false)) return;

  // Give a small grace period for the WINDOW_OPEN_NOTIFY to arrive from content script
  // since postMessage -> runtime.sendMessage is slightly slower than tab creation.
  const openerId = tab.openerTabId;
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
