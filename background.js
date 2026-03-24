/**
 * YT Shield - Service Worker (MV3 Background)
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
        acceleration: true,
        cosmetic: true,
        suppressWarnings: true,
        accelerationSpeed: 16,
      },
      stats: { blocked: 0, accelerated: 0 },
    });
    console.log('[YT Shield] Installed. Default config applied.');
  }

  // Load any saved dynamic rules on startup
  await syncDynamicRules();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncDynamicRules();
});

// ─── DYNAMIC RULE UPDATES ─────────────────────────────────────────────────────
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

    console.log(`[YT Shield] Synced ${rules.length} dynamic rules.`);
  } catch (err) {
    console.error('[YT Shield] Dynamic rule sync failed:', err);
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
      action: { type: 'block' },
      condition: {
        urlFilter: '/api/stats/ads',
        initiatorDomains: ['youtube.com', 'www.youtube.com'],
        resourceTypes: ['xmlhttprequest', 'image', 'ping'],
      },
    },
    {
      id: 1002,
      priority: 1,
      action: { type: 'block' },
      condition: {
        urlFilter: '/pagead/viewthroughconversion',
        resourceTypes: ['image', 'xmlhttprequest', 'ping'],
      },
    },
    // Block ad companion banners fetched via XHR
    {
      id: 1003,
      priority: 1,
      action: { type: 'block' },
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
      action: { type: 'block' },
      condition: {
        urlFilter: '||cm.g.doubleclick.net^',
        resourceTypes: ['image', 'ping', 'xmlhttprequest'],
      },
    },
    {
      id: 1005,
      priority: 1,
      action: { type: 'block' },
      condition: {
        urlFilter: '||ad.doubleclick.net^',
        resourceTypes: ['image', 'ping', 'xmlhttprequest', 'script'],
      },
    },
    // Block YouTube's "Engagement Panel" ad calls
    {
      id: 1006,
      priority: 1,
      action: { type: 'block' },
      condition: {
        urlFilter: '/youtubei/v1/log_event',
        initiatorDomains: ['youtube.com', 'www.youtube.com'],
        resourceTypes: ['xmlhttprequest'],
      },
    },
  ];
}

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === 'STAT_UPDATE') {
    // Accumulate stats from content scripts
    chrome.storage.local.get('stats').then(({ stats = {} }) => {
      const accelerated = typeof msg.stats?.accelerated === 'number' ? msg.stats.accelerated : 0;
      const blocked = typeof msg.stats?.blocked === 'number' ? msg.stats.blocked : 0;

      stats.accelerated = (stats.accelerated || 0) + accelerated;
      stats.blocked = (stats.blocked || 0) + blocked;
      chrome.storage.local.set({ stats });
    });
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
      const allowed = ['acceleration', 'cosmetic', 'suppressWarnings', 'accelerationSpeed'];
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

      // Broadcast to all YouTube tabs
      const tabs = await chrome.tabs.query({ url: ['*://youtube.com/*', '*://www.youtube.com/*'] });
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'CONFIG_UPDATE', config: newConfig }).catch(() => {});
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'ADD_DYNAMIC_RULE') {
    // Allow popup/user to inject new block rules at runtime
    chrome.storage.local.get('dynamicRules').then(async ({ dynamicRules = [] }) => {
      const validatedRule = {};
      const allowedProperties = ['priority', 'action', 'condition'];

      if (msg.rule && typeof msg.rule === 'object') {
        for (const prop of allowedProperties) {
          if (Object.prototype.hasOwnProperty.call(msg.rule, prop)) {
            validatedRule[prop] = msg.rule[prop];
          }
        }
      }

      // Basic validation for mandatory rule fields
      if (!validatedRule.action || !validatedRule.condition) {
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
    chrome.storage.local.set({ stats: { blocked: 0, accelerated: 0 } })
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});
