/**
 * Chroma Ad-Blocker - Service Worker (MV3 Background)
 * Handles: dynamic rule updates, stat tracking, config persistence
 *
 * MV3 NOTE: This service worker is ephemeral and may restart at any time. 
 * All persistent state must be stored in chrome.storage.
 */

'use strict';

import {
  initSubscriptions,
  ensureAlarm,
  refreshAllStale
} from '../subscriptions/manager.js';
import { initScriptletEngine, recoverUserScriptsIfNeeded } from '../scriptlets/engine.js';
import { MSG } from '../core/messageTypes.js';
import * as router from '../core/messageRouter.js';
import { registerAll } from './handlers.js';
import { createDefaultStatsV2 } from './stats.js';
import './proxy.js';
import { syncWebRtcLeakProtection } from './webrtc.js';
import { syncBrowserPrivacyHardening, syncGeolocationProtection } from './browserPrivacy.js';
import { clearHealthDiagnostic, recordHealthDiagnostic } from './diagnostics.js';
import { updateDNRState, syncDynamicRules } from './dnrState.js';
import { initRequestLogListener } from './requestLog.js';

const DEBUG = false;

// --- INSTALL / STARTUP ---
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
        globalProxyEnabled: false,
        globalProxyId: null,
        chromeServiceProxyBypass: true,
        webRtcLeakProtection: 'auto',
        fingerprintRandomization: false,
        browserPrivacyHardening: false,
        geolocationProtection: false,
        trackingUrlCleanup: true,
        deAmpLinks: false,
      },
      statsV2: createDefaultStatsV2(),
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
      fprWhitelist: [],
      proxyConfigs: []
    });
    if (DEBUG) console.log('[Chroma Ad-Blocker] Installed. Default config applied.');
  }

  const { config: storedConfig, proxyConfigs: storedProxyConfigs = [] } = await chrome.storage.local.get(['config', 'proxyConfigs']);
  const isEnabled = storedConfig ? storedConfig.enabled : true;
  const isNetworkBlocking = storedConfig && storedConfig.networkBlocking !== undefined ? storedConfig.networkBlocking : true;
  await syncWebRtcLeakProtection(storedConfig || {}, storedProxyConfigs || []);
  await syncBrowserPrivacyHardening(storedConfig || {});
  await syncGeolocationProtection(storedConfig || {});
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
  const { config: storedConfig, proxyConfigs: storedProxyConfigs = [] } = await chrome.storage.local.get(['config', 'proxyConfigs']);
  const isEnabled = storedConfig ? storedConfig.enabled : true;
  const isNetworkBlocking = storedConfig && storedConfig.networkBlocking !== undefined ? storedConfig.networkBlocking : true;
  await syncWebRtcLeakProtection(storedConfig || {}, storedProxyConfigs || []);
  await syncBrowserPrivacyHardening(storedConfig || {});
  await syncGeolocationProtection(storedConfig || {});
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

initRequestLogListener();

// --- SUBSCRIPTION ALARM ---
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'chroma-subscription-check') {
    refreshAllStale().then(() => {
      clearHealthDiagnostic('subscriptionAlarmRefresh');
    }).catch(err => {
      recordHealthDiagnostic('subscriptionAlarmRefresh', {
        area: 'subscriptions',
        severity: 'warning',
        message: 'Scheduled subscription refresh did not complete.',
        action: 'Open settings and refresh the affected subscription lists.',
        error: err?.message || err
      });
      if (DEBUG) console.error('[Chroma Subscriptions] Alarm refresh failed:', err);
    });
  }
});

// --- TESTING EXPORTS -----
if (typeof globalThis !== 'undefined' && globalThis.__CHROMA_INTERNAL_TEST_STRICT__ === true) {
  globalThis.syncDynamicRules = syncDynamicRules;
}

// --- MESSAGE ROUTER WIRING -----
// Must come after all exported handler dependencies are defined so that
// handlers.js sees resolved bindings through the live ES-module import.
registerAll(router);
router.attachListener();

// MV3 service workers wake without firing runtime.onStartup. If the user
// enables Chrome's Allow User Scripts toggle after install, a normal worker
// wake should be enough to register already-parsed subscription scriptlets.
recoverUserScriptsIfNeeded().catch(err => {
  recordHealthDiagnostic('userScriptsRecovery', {
    area: 'scriptlets',
    severity: 'warning',
    message: 'Stored scriptlets could not be recovered after service-worker wake.',
    action: 'Open Chrome extension details and confirm Allow User Scripts is enabled.',
    error: err?.message || err
  });
  if (DEBUG) console.error('[Chroma Scriptlets] Wake sync failed:', err);
});
