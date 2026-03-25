/**
 * YT Chroma - Service Worker (MV3 Background)
 * Handles: dynamic rule updates, stat tracking, config persistence
 *
 * MV3 NOTE: This service worker is ephemeral — it shuts down after
 * ~30 seconds of inactivity. All persistent state uses chrome.storage.
 */

'use strict';

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
        suppressWarnings: true,
        accelerationSpeed: 16,
        blockPopUnders: true,
        blockPushNotifications: true,
        enabled: true,
      },
      stats: { blocked: 0, accelerated: 0 },
    });
    console.log('[YT Chroma] Installed. Default config applied.');
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
async function updateDNRState(isEnabled) {
  const ruleIds = [
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
    'yt_ad_rules_part10'
  ];
  try {
    if (isEnabled) {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ruleIds });
      await syncDynamicRules();
    } else {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: ruleIds });
      const existing = await chrome.declarativeNetRequest.getDynamicRules();
      const removeIds = existing.map(r => r.id);
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds });
    }
  } catch (err) {
    console.error('[YT Chroma] Error updating DNR state:', err);
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

    console.log(`[YT Chroma] Synced ${rules.length} dynamic rules.`);
  } catch (err) {
    console.error('[YT Chroma] Dynamic rule sync failed:', err);
  }
}

/**
 * Default dynamic rules — these supplement the static rules.json.
 * Because these are dynamic, they can be updated at runtime without
 * going through the extension store review process.
 */
function getDefaultDynamicRules() {
  return [
    // Block YouTube's ad measurement ping endpoints
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
    // Block ad companion banners fetched via XHR
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
    // Block DoubleClick pixel tracking
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
    // Block YouTube's "Engagement Panel" ad calls
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

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // SECURITY: Restrict sensitive message types to internal extension pages (e.g. popup)
  // Content scripts always have a sender.tab property. Internal pages do not.
  const isFromInternal = !_sender.tab;
  const SENSITIVE_TYPES = ['GET_STATS', 'GET_CONFIG', 'SET_CONFIG', 'ADD_DYNAMIC_RULE', 'RESET_STATS'];

  if (SENSITIVE_TYPES.includes(msg.type) && !isFromInternal) {
    console.error(`[YT Chroma] Blocked unauthorized ${msg.type} attempt from tab ${_sender.tab.id}`);
    return false;
  }

  if (msg.type === 'STAT_UPDATE') {
    // Accumulate stats from content scripts
    chrome.storage.local.get('stats').then(({ stats = {} }) => {
      const accelerated = Number.isInteger(msg.stats?.accelerated) ? msg.stats.accelerated : 0;
      const blocked = Number.isInteger(msg.stats?.blocked) ? msg.stats.blocked : 0;

      stats.accelerated = (stats.accelerated || 0) + accelerated;
      stats.blocked = (stats.blocked || 0) + blocked;
      chrome.storage.local.set({ stats });
    });
    return false;
  }

  if (msg.type === 'WINDOW_OPEN_NOTIFY') {
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
      console.log(`[YT Chroma] Window open notification from tab ${tabId}:`, msg);
    }
    return false;
  }

  if (msg.type === 'SUSPICIOUS_ACTIVITY') {
    const tabId = _sender.tab?.id;
    if (tabId) {
      const existing = popunderRequests.get(tabId) || { time: Date.now(), createdTabIds: [] };
      existing.isSuspicious = true;
      existing.activity = msg.activity;
      popunderRequests.set(tabId, existing);

      // RETROACTIVE CLOSING: If any tabs were just opened from this opener, close them now
      if (existing.createdTabIds && existing.createdTabIds.length > 0) {
        console.log(`[YT Chroma] Successfully blocked ${existing.createdTabIds.length} pop-under(s) (Retroactive: ${msg.activity})`);
        existing.createdTabIds.forEach(id => {
          chrome.tabs.remove(id).catch(() => {});
        });
        
        // Update stats
        chrome.storage.local.get('stats').then(({ stats = {} }) => {
          stats.blocked = (stats.blocked || 0) + existing.createdTabIds.length;
          chrome.storage.local.set({ stats });
        });
        
        existing.createdTabIds = [];
      }
      
      console.log(`[YT Chroma] Suspicious activity notification from tab ${tabId}:`, msg);
    }
    return false;
  }

  if (msg.type === 'GET_STATS') {
    chrome.storage.local.get('stats').then(({ stats }) => {
      sendResponse(stats || { blocked: 0, accelerated: 0 });
    });
    return true; // keep channel open for async response
  }

  if (msg.type === 'GET_CONFIG') {
    chrome.storage.local.get('config').then(({ config }) => {
      sendResponse(config);
    });
    return true;
  }

  if (msg.type === 'SET_CONFIG') {
    chrome.storage.local.get('config').then(async ({ config }) => {
      // Validate and extract only allowed properties
      const allowed = ['networkBlocking', 'acceleration', 'cosmetic', 'hideShorts', 'suppressWarnings', 'accelerationSpeed', 'blockPopUnders', 'blockPushNotifications', 'enabled'];
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
        chrome.tabs.sendMessage(tab.id, { type: 'CONFIG_UPDATE', config: newConfig }).catch(() => {})
      ));
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'ADD_DYNAMIC_RULE') {
    // Allow popup/user to inject new block rules at runtime
    chrome.storage.local.get('dynamicRules').then(async ({ dynamicRules = [] }) => {
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

      const newRule = { id: (Date.now() % 100000) + 2000, ...validatedRule };
      dynamicRules.push(newRule);
      await chrome.storage.local.set({ dynamicRules });
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [newRule] });
      sendResponse({ ok: true, ruleId: newRule.id });
    });
    return true;
  }

  if (msg.type === 'RESET_STATS') {
    chrome.storage.local.get('stats').then(({ stats = {} }) => {
      stats.blocked = 0;
      stats.accelerated = 0;
      chrome.storage.local.set({ stats })
        .then(() => sendResponse({ ok: true }));
    });
    return true;
  }
});

// ─── TAB MONITORING (Pop-Under Blocker) ───────────────────────────────────────
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!config?.enabled || !config?.blockPopUnders) return;

  // Give a small grace period for the WINDOW_OPEN_NOTIFY to arrive from content script
  // since postMessage -> runtime.sendMessage is slightly slower than tab creation.
  let request = null;
  const now = Date.now();
  const openerId = tab.openerTabId;

  for (let i = 0; i < 5; i++) { // Retry up to 5 times (250ms total)
    request = openerId ? popunderRequests.get(openerId) : null;
    if (!request && lastGlobalRequest && (Date.now() - lastGlobalRequest.time < 2000)) {
      request = lastGlobalRequest;
    }
    
    if (request) break;
    await new Promise(r => setTimeout(r, 50));
  }

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
    console.warn(`[YT Chroma] Blocking suspicious pop-under: ${tab.pendingUrl || tab.url || 'unknown'}`);
    
    // Close the tab
    chrome.tabs.remove(tab.id).catch(() => {});
    
    // Increment stats
    chrome.storage.local.get('stats').then(({ stats = {} }) => {
      stats.blocked = (stats.blocked || 0) + 1;
      chrome.storage.local.set({ stats });
    });

    if (openerId) popunderRequests.delete(openerId);
    if (request === lastGlobalRequest) lastGlobalRequest = null;
  } else {
    // If it's not immediately suspicious, store the tabId for potential retroactive closing
    request.createdTabIds.push(tab.id);
  }
});

// Clean up map when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  popunderRequests.delete(tabId);
});
