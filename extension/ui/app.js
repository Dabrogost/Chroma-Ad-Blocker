/**
 * Chroma Ad-Blocker - Shared UI logic.
 * Coordinates shared popup/settings controls and delegates proxy rendering.
 */

'use strict';

const ChromaApp = (() => {
  const $ = id => document.getElementById(id);

  function escapeHTML(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function appendElement(parent, tagName, className = '', textContent = '') {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (textContent !== '') element.textContent = textContent;
    parent.appendChild(element);
    return element;
  }

  const RELEASES_PAGE = 'https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/latest';
  const PROXY_SETTINGS_PATH = 'ui/settings.html#proxySection';
  const HEALTH_REFRESH_KEYS = [
    'config',
    'subscriptions',
    'appliedNetworkRuleCount',
    'localCosmeticRules',
    'subscriptionCosmeticRules',
    'subscriptionScriptletRules',
    'proxyConfigs',
    'whitelist',
    'fprWhitelist',
    'statsV2'
  ];
  const HEALTH_STATUS_CLASSES = new Set(['healthy', 'degraded', 'disabled', 'error']);
  const HEALTH_ISSUE_CLASSES = new Set(['info', 'warning', 'error']);
  const CONFIG_TOGGLES = [
    ['toggleNetwork',      'networkBlocking',          true],
    ['toggleTrackingUrlCleanup', 'trackingUrlCleanup', true],
    ['toggleDeAmpLinks',   'deAmpLinks',               false],
    ['toggleStripping',    'stripping',                true],
    ['toggleAcceleration', 'acceleration',             false],
    ['toggleCosmetic',     'cosmetic',                 true],
    ['toggleShorts',       'hideShorts',               false],
    ['toggleMerch',        'hideMerch',                true],
    ['toggleOffers',       'hideOffers',               true],
    ['toggleWarnings',     'suppressWarnings',         true],
    ['toggleFingerprintRandomization', 'fingerprintRandomization', false],
    ['toggleBrowserPrivacyHardening', 'browserPrivacyHardening', false],
    ['toggleGeolocationProtection', 'geolocationProtection', false],
  ];
  let healthLoadSerial = 0;

  function isSettingsPage() {
    const path = globalThis.location?.pathname || '';
    return path.endsWith('/settings.html') || path.endsWith('\\settings.html');
  }

  function openProxySettings() {
    const url = chrome.runtime.getURL(PROXY_SETTINGS_PATH);
    if (chrome.tabs?.create) {
      chrome.tabs.create({ url });
    } else if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(url);
    }
  }

  function openSettingsPage() {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('ui/settings.html'));
    }
  }

  function formatCount(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString() : '0';
  }

  function trimCompactDecimal(value) {
    return value.toFixed(1).replace(/\.0$/, '');
  }

  function formatCompactCount(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '0';
    const absolute = Math.abs(number);
    if (absolute < 1000) return Math.round(number).toLocaleString();

    const units = [
      { value: 1e12, suffix: 't' },
      { value: 1e9, suffix: 'b' },
      { value: 1e6, suffix: 'm' },
      { value: 1e3, suffix: 'k' }
    ];

    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (absolute < unit.value) continue;

      const scaled = number / unit.value;
      if (Math.abs(Number(scaled.toFixed(1))) >= 1000 && i > 0) {
        const larger = units[i - 1];
        return `${trimCompactDecimal(number / larger.value)}${larger.suffix}`;
      }
      return `${trimCompactDecimal(scaled)}${unit.suffix}`;
    }

    return formatCount(number);
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    if (total < 60) return `${Math.round(total)}s`;
    if (total < 3600) return `${Math.round(total / 60)}m`;
    return `${(total / 3600).toFixed(total < 36000 ? 1 : 0)}h`;
  }

  function formatStatusLabel(value) {
    const label = String(value || 'unknown');
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  function normalizeHealthStatus(value) {
    const status = String(value || '').toLowerCase();
    return HEALTH_STATUS_CLASSES.has(status) ? status : 'error';
  }

  function normalizeHealthIssueSeverity(value) {
    const severity = String(value || '').toLowerCase();
    return HEALTH_ISSUE_CLASSES.has(severity) ? severity : 'info';
  }

  function addHealthMetric(parent, label, value, state = '') {
    const row = appendElement(parent, 'div', 'health-metric');
    appendElement(row, 'span', 'health-metric__label', label);
    appendElement(row, 'span', state ? `health-metric__value health-metric__value--${state}` : 'health-metric__value', value);
    return row;
  }

  function addHealthSection(parent, title, metrics) {
    const section = appendElement(parent, 'div', 'health-section');
    appendElement(section, 'div', 'health-section__title', title);
    for (const metric of metrics) {
      addHealthMetric(section, metric[0], metric[1], metric[2] || '');
    }
    return section;
  }

  function getWebRtcHealthMetric(health) {
    const webrtc = health.webrtc || {};
    const globalProxyActive = health.proxy?.globalProxyEnabled && health.proxy?.globalProxyConfigured;
    const mode = String(webrtc.mode || 'auto');
    const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
    if (!webrtc.available) {
      return ['WebRTC leak protection', `${modeLabel} (Unavailable)`, globalProxyActive ? 'warning' : 'disabled'];
    }
    if (webrtc.levelOfControl && !webrtc.controllable) {
      return ['WebRTC leak protection', `${modeLabel} (Controlled elsewhere)`, webrtc.recommended ? 'warning' : 'disabled'];
    }
    if (webrtc.protected) {
      return ['WebRTC leak protection', mode === 'strict' ? 'Strict' : `${modeLabel} (Strict)`, 'ok'];
    }
    if (webrtc.partial) {
      return ['WebRTC leak protection', mode === 'balanced' ? 'Balanced' : `${modeLabel} (Partial)`, globalProxyActive ? 'warning' : 'ok'];
    }
    return ['WebRTC leak protection', mode === 'off' ? 'Off' : `${modeLabel} (Off)`, globalProxyActive ? 'warning' : 'disabled'];
  }

  function getBrowserPrivacySetting(health, key) {
    const settings = Array.isArray(health.browserPrivacy?.settings)
      ? health.browserPrivacy.settings
      : [];
    return settings.find(setting => setting?.key === key) || null;
  }

  function getBrowserPrivacySettingLabel(health, key) {
    const setting = getBrowserPrivacySetting(health, key);
    if (!health.browserPrivacy?.enabled) return 'Disabled';
    if (!setting?.available) return 'Unavailable';
    if (setting.levelOfControl && !setting.controllable && !setting.hardened) return 'Controlled elsewhere';
    return setting.hardened ? 'Hardened' : 'Not hardened';
  }

  function getBrowserPrivacySettingStatus(health, key) {
    const setting = getBrowserPrivacySetting(health, key);
    if (!health.browserPrivacy?.enabled) return 'disabled';
    if (!setting?.available) return 'warning';
    return setting.hardened ? 'ok' : 'warning';
  }

  function getPrivacySandboxSettings(health) {
    return ['adMeasurementEnabled', 'topicsEnabled', 'fledgeEnabled']
      .map(key => getBrowserPrivacySetting(health, key))
      .filter(Boolean);
  }

  function getPrivacySandboxLabel(health) {
    if (!health.browserPrivacy?.enabled) return 'Disabled';
    const settings = getPrivacySandboxSettings(health);
    if (settings.length === 0) return 'Unavailable';
    const hardened = settings.filter(setting => setting.hardened).length;
    return hardened === settings.length ? 'Hardened' : `${formatCount(hardened)} / ${formatCount(settings.length)} hardened`;
  }

  function getPrivacySandboxStatus(health) {
    if (!health.browserPrivacy?.enabled) return 'disabled';
    const settings = getPrivacySandboxSettings(health);
    if (settings.length === 0) return 'warning';
    return settings.every(setting => setting.hardened) ? 'ok' : 'warning';
  }

  function getGeolocationProtectionLabel(health) {
    const geo = health.geolocation || {};
    if (!geo.enabled) return 'Disabled';
    if (!geo.available) return 'Unavailable';
    return geo.active ? 'Blocked' : 'Not blocked';
  }

  function getGeolocationProtectionStatus(health) {
    const geo = health.geolocation || {};
    if (!geo.enabled) return 'disabled';
    if (!geo.available) return 'warning';
    return geo.active ? 'ok' : 'warning';
  }

  function getFprProtectedSurfaceLabel(health) {
    const surfaces = Array.isArray(health.fpr?.protectedSurfaces)
      ? health.fpr.protectedSurfaces
      : [];
    return surfaces.length ? surfaces.join(', ') : 'Unknown';
  }

  function getRegisteredScriptletLabel(health) {
    const scriptlets = health.scriptlets || {};
    if (scriptlets.apiAvailable === false) return 'Unavailable';
    return scriptlets.registeredUserScriptCount === null
      ? 'Unknown'
      : formatCount(scriptlets.registeredUserScriptCount);
  }

  function getRegisteredScriptletStatus(health) {
    const scriptlets = health.scriptlets || {};
    if (scriptlets.apiAvailable === false) {
      return scriptlets.storedRuleCount > 0 ? 'warning' : 'disabled';
    }
    if (scriptlets.storedRuleCount > 0 && scriptlets.registeredUserScriptCount === 0) return 'warning';
    return '';
  }

  function getTrackingUrlCleanupLabel(health, networkBlockingActive) {
    if (!health.master?.trackingUrlCleanup || !networkBlockingActive) return 'Disabled';
    return health.dnr?.trackingUrlCleanupActive ? 'Active' : 'Not registered';
  }

  function getTrackingUrlCleanupStatus(health, networkBlockingActive) {
    if (!health.master?.trackingUrlCleanup || !networkBlockingActive) return 'disabled';
    return health.dnr?.trackingUrlCleanupActive ? 'ok' : 'warning';
  }

  function getStatsTotals(stats) {
    return stats?.totals || {};
  }

  function getCleanupTotal(totals) {
    return (Number(totals?.cosmeticHides) || 0) + (Number(totals?.youtubePayloadCleans) || 0);
  }

  function getProxyActivityTotal(totals) {
    return (Number(totals?.proxyTests) || 0) + (Number(totals?.proxyAuthChallenges) || 0);
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  function setSectionLoading(id) {
    const el = $(id);
    if (!el) return;
    el.classList.add('is-loading');
    el.classList.remove('is-hydrated', 'hydration-fade-in');
  }

  function setSectionReady(id) {
    const el = $(id);
    if (!el) return;
    el.classList.remove('is-loading');
    el.classList.add('is-hydrated', 'hydration-fade-in');
  }

  function setSectionError(id, message) {
    const el = $(id);
    if (!el) return;
    el.innerHTML = '';
    appendElement(el, 'div', 'hydration-error', message);
    setSectionReady(id);
  }

  function setStatsControlsPending(pending) {
    ['statsModeSelect', 'statsRetentionSelect'].forEach(id => {
      const el = $(id);
      if (!el) return;
      el.disabled = pending;
      el.classList.toggle('control-pending', pending);
    });
  }

  function setControlsPending(pending) {
    const ids = ['toggleEnabled', 'toggleWhitelist', 'toggleFprWhitelist', ...CONFIG_TOGGLES.map(([id]) => id)];
    ids.forEach(id => {
      const el = $(id);
      if (!el) return;
      el.disabled = pending;
      el.classList.toggle('control-pending', pending);
      el.closest?.('.toggle-row')?.classList.toggle('control-pending', pending);
    });
    document.querySelectorAll('.speed-btn').forEach(btn => {
      btn.disabled = pending;
      btn.classList.toggle('control-pending', pending);
    });
  }

  function setControlPending(id, pending) {
    const el = $(id);
    if (!el) return;
    el.disabled = pending;
    el.classList.toggle('control-pending', pending);
    el.closest?.('.toggle-row')?.classList.toggle('control-pending', pending);
  }

  async function safeHydrateSection(name, fn) {
    try {
      return await fn();
    } catch (error) {
      console.error(`Chroma ${name} hydration failed:`, error);
      return null;
    }
  }

  function renderStatsHero(stats) {
    const totals = getStatsTotals(stats);
    setText('statProtectionEvents', formatCompactCount(totals.protectionEvents));
    setText('statBreakdownNetwork', formatCompactCount(totals.networkBlocks));
    setText('statBreakdownCleanup', formatCompactCount(getCleanupTotal(totals)));
    setText('statBreakdownScriptlets', formatCompactCount(totals.scriptletHits));
    setText('statBreakdownProxy', formatCompactCount(getProxyActivityTotal(totals)));
  }

  function addStatsMiniCard(parent, label, value) {
    const card = appendElement(parent, 'div', 'stats-mini-card');
    appendElement(card, 'div', 'stats-mini-card__label', label);
    appendElement(card, 'div', 'stats-mini-card__value', value);
    return card;
  }

  function addStatsRow(parent, title, meta, value) {
    const row = appendElement(parent, 'div', 'stats-row');
    const main = appendElement(row, 'div');
    appendElement(main, 'div', 'stats-row__title', title);
    if (meta) appendElement(main, 'div', 'stats-row__meta', meta);
    appendElement(row, 'div', 'stats-row__value', value);
    return row;
  }

  function renderEmptyStatsList(parent, text) {
    appendElement(parent, 'div', 'stats-empty', text);
  }

  function getStatsBucketTotal(bucket) {
    return (
      (Number(bucket?.protectionEvents) || 0) +
      (Number(bucket?.networkAllows) || 0) +
      (Number(bucket?.unknownDnrMatches) || 0) +
      (Number(bucket?.scriptletErrors) || 0)
    );
  }

  function getRuleDisplayTitle(rule) {
    if (rule?.scriptlet) return rule.scriptlet;
    if (!rule?.ruleId) return rule?.key || 'Rule';
    const blocks = Number(rule.networkBlocks) || 0;
    const allows = Number(rule.networkAllows) || 0;
    if (allows > 0 && blocks === 0) return `Allow Rule ${rule.ruleId}`;
    if (allows > 0 && blocks > 0) return `Mixed Rule ${rule.ruleId}`;
    return `Rule ${rule.ruleId}`;
  }

  function getRuleDisplayMeta(rule) {
    const meta = [rule?.ruleSource, rule?.rulesetId].filter(Boolean);
    const blocks = Number(rule?.networkBlocks) || 0;
    const allows = Number(rule?.networkAllows) || 0;
    const unknown = Number(rule?.unknownDnrMatches) || 0;
    if (blocks > 0) meta.push(`Blocks ${formatCompactCount(blocks)}`);
    if (allows > 0) meta.push(`Allows ${formatCompactCount(allows)}`);
    if (unknown > 0) meta.push(`Matches ${formatCompactCount(unknown)}`);
    return meta.join(' - ');
  }

  function getEventTitle(event) {
    if (event?.layer === 'youtube' && event?.type === 'payload') {
      const modified = (Number(event.payloadsModified) || 0) + (Number(event.fieldsPruned) || 0) + (Number(event.adObjectsRemoved) || 0);
      return modified > 0 ? 'Payload cleanup' : 'Payload inspection';
    }
    const layer = event?.layer || 'event';
    const type = event?.type || 'match';
    return `${layer} - ${type}`;
  }

  function getEventMeta(event) {
    const metaParts = [event.domain, event.resourceType, event.ruleSource, event.scriptlet].filter(Boolean);
    if (event.layer === 'youtube' && event.type === 'payload') {
      if (event.source) metaParts.push(event.source);
      if (Number(event.payloadsModified)) metaParts.push(`Modified ${formatCount(event.payloadsModified)}`);
      if (Number(event.fieldsPruned)) metaParts.push(`Fields ${formatCount(event.fieldsPruned)}`);
      if (Number(event.adObjectsRemoved)) metaParts.push(`Ad objects ${formatCount(event.adObjectsRemoved)}`);
    }
    if (event.url) metaParts.push(event.url);
    return metaParts.join(' - ');
  }

  function getEventValue(event) {
    if (event?.layer === 'youtube' && event?.type === 'payload') {
      return event.payloadsModified || event.payloadsInspected || event.count || 1;
    }
    return event?.count || 1;
  }

  function getEmptyStats() {
    return {
      settings: { mode: 'aggregated', retentionDays: 90 },
      totals: {},
      ranges: {
        today: {},
        last7Days: {},
        last30Days: {},
        allTime: {}
      },
      bySite: {},
      byRule: {},
      byDay: {},
      recentEvents: [],
      timeSavedSeconds: 0
    };
  }

  function renderStatsPanel(stats, { unavailable = false } = {}) {
    if (!isSettingsPage()) return;
    const totals = getStatsTotals(stats);
    const topCards = $('statisticsTopCards');
    const rangeSummary = $('statsRangeSummary');
    const sitesList = $('statsSitesList');
    const rulesList = $('statsRulesList');
    const timelineList = $('statsTimelineList');
    const eventsList = $('statsEventsList');
    const modeSelect = $('statsModeSelect');
    const retentionSelect = $('statsRetentionSelect');
    if (!topCards) return;
    const emptyText = unavailable ? 'No stats available.' : null;

    topCards.innerHTML = '';
    addStatsMiniCard(topCards, 'Total Protection Events', formatCompactCount(totals.protectionEvents));
    addStatsMiniCard(topCards, 'Network Blocks', formatCompactCount(totals.networkBlocks));
    addStatsMiniCard(topCards, 'Ad Cleanups', formatCompactCount(getCleanupTotal(totals)));
    addStatsMiniCard(topCards, 'Scriptlet Hits', formatCompactCount(totals.scriptletHits));
    addStatsMiniCard(topCards, 'Warnings Suppressed', formatCompactCount(totals.warningSuppressions));
    addStatsMiniCard(topCards, 'Local Zapper Hits', formatCompactCount(totals.zapperHits));
    addStatsMiniCard(topCards, 'Proxy Activity', formatCompactCount(getProxyActivityTotal(totals)));
    addStatsMiniCard(topCards, 'Time Saved (est.)', formatDuration(stats?.timeSavedSeconds));

    if (rangeSummary) {
      rangeSummary.innerHTML = '';
      addStatsMiniCard(rangeSummary, 'Today', formatCompactCount(stats?.ranges?.today?.protectionEvents));
      addStatsMiniCard(rangeSummary, '7 Days', formatCompactCount(stats?.ranges?.last7Days?.protectionEvents));
      addStatsMiniCard(rangeSummary, '30 Days', formatCompactCount(stats?.ranges?.last30Days?.protectionEvents));
      addStatsMiniCard(rangeSummary, 'All Time', formatCompactCount(stats?.ranges?.allTime?.protectionEvents));
    }

    if (sitesList) {
      sitesList.innerHTML = '';
      const sites = Object.values(stats?.bySite || {})
        .sort((a, b) => getStatsBucketTotal(b) - getStatsBucketTotal(a))
        .slice(0, 10);
      if (sites.length === 0) renderEmptyStatsList(sitesList, emptyText || 'No site stats yet.');
      for (const site of sites) {
        const last = site.lastSeen ? new Date(site.lastSeen).toLocaleString() : 'Never';
        const meta = `Network ${formatCompactCount(site.networkBlocks)} - Allows ${formatCompactCount(site.networkAllows)} - Cleanup ${formatCompactCount(getCleanupTotal(site))} - Last seen ${last}`;
        addStatsRow(sitesList, site.domain || 'unknown', meta, formatCompactCount(getStatsBucketTotal(site)));
      }
    }

    if (rulesList) {
      rulesList.innerHTML = '';
      const rules = Object.values(stats?.byRule || {})
        .sort((a, b) => getStatsBucketTotal(b) - getStatsBucketTotal(a))
        .slice(0, 10);
      if (rules.length === 0) renderEmptyStatsList(rulesList, emptyText || 'No rule stats yet.');
      for (const rule of rules) {
        const title = getRuleDisplayTitle(rule);
        const meta = getRuleDisplayMeta(rule);
        const value = formatCompactCount(getStatsBucketTotal(rule));
        addStatsRow(rulesList, title, meta, value);
      }
    }

    if (timelineList) {
      timelineList.innerHTML = '';
      const days = Object.values(stats?.byDay || {})
        .sort((a, b) => String(a.day).localeCompare(String(b.day)))
        .slice(-14);
      const max = Math.max(1, ...days.map(day => Number(day.protectionEvents) || 0));
      if (days.length === 0) renderEmptyStatsList(timelineList, emptyText || 'No timeline data yet.');
      for (const day of days) {
        const row = addStatsRow(timelineList, day.day, '', formatCompactCount(day.protectionEvents));
        const bar = appendElement(row.firstChild, 'div', 'stats-bar');
        const fill = appendElement(bar, 'div', 'stats-bar__fill');
        fill.style.setProperty('--bar-width', `${Math.max(2, ((day.protectionEvents || 0) / max) * 100)}%`);
      }
    }

    if (eventsList) {
      eventsList.innerHTML = '';
      const events = Array.isArray(stats?.recentEvents) ? stats.recentEvents.slice(0, 12) : [];
      if (events.length === 0) renderEmptyStatsList(eventsList, emptyText || 'No recent events yet.');
      for (const event of events) {
        addStatsRow(eventsList, getEventTitle(event), getEventMeta(event), formatCompactCount(getEventValue(event)));
      }
    }

    if (modeSelect) modeSelect.value = stats?.settings?.mode || 'aggregated';
    if (retentionSelect) retentionSelect.value = String(stats?.settings?.retentionDays || 90);
    [
      'statisticsTopCards',
      'statsRangeSummary',
      'statsSitesList',
      'statsRulesList',
      'statsTimelineList',
      'statsEventsList'
    ].forEach(setSectionReady);
  }

  async function loadStatsUI() {
    let stats = null;
    let available = false;
    [
      'statisticsTopCards',
      'statsRangeSummary',
      'statsSitesList',
      'statsRulesList',
      'statsTimelineList',
      'statsEventsList'
    ].forEach(setSectionLoading);
    setStatsControlsPending(true);
    try {
      stats = await notifyBackground({ type: MSG.STATS_GET }) || null;
      available = !!stats;
    } catch (error) {
      console.error('Chroma stats failed to load:', error);
      stats = null;
    }
    renderStatsHero(stats);
    renderStatsPanel(available ? stats : getEmptyStats(), { unavailable: !available });
    setStatsControlsPending(!available);
    return stats;
  }

  function renderHealthIssues(parent, issues) {
    const section = appendElement(parent, 'div', 'health-section health-section--wide');
    appendElement(section, 'div', 'health-section__title', 'Issues');
    const list = appendElement(section, 'div', 'health-issues');
    if (!Array.isArray(issues) || issues.length === 0) {
      appendElement(list, 'div', 'health-issue health-issue--healthy', 'No issues detected.');
      return;
    }

    for (const issue of issues) {
      const severity = normalizeHealthIssueSeverity(issue.severity);
      const item = appendElement(list, 'div', `health-issue health-issue--${severity}`);
      appendElement(item, 'div', 'health-issue__message', issue.message || 'Diagnostic issue');
      if (issue.action) appendElement(item, 'div', 'health-issue__action', issue.action);
    }
  }

  async function loadHealthPanel() {
    if (!isSettingsPage()) return;
    const panel = $('healthPanel');
    const body = $('healthPanelBody');
    const overallLabel = $('healthOverallLabel');
    const versionText = $('healthVersionText');
    const refreshBtn = $('refreshHealthBtn');
    if (!panel || !body) return;

    const loadId = ++healthLoadSerial;
    setSectionLoading('healthPanelBody');
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Refreshing...';
    }

    let health = null;
    try {
      health = await notifyBackground({ type: MSG.HEALTH_GET });
    } catch (error) {
      console.error('Chroma health failed to load:', error);
    }
    if (loadId !== healthLoadSerial) return;
    body.innerHTML = '';

    if (!health) {
      if (overallLabel) {
        overallLabel.className = 'health-status health-status--error';
        overallLabel.textContent = 'Unavailable';
      }
      if (versionText) versionText.textContent = 'Health endpoint did not respond.';
      appendElement(body, 'div', 'health-empty', 'Could not load health diagnostics.');
      setSectionReady('healthPanelBody');
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Refresh Health';
      }
      return;
    }

    const overall = normalizeHealthStatus(health.overall?.status);
    if (overallLabel) {
      overallLabel.className = `health-status health-status--${overall}`;
      overallLabel.textContent = formatStatusLabel(overall);
    }
    if (versionText) {
      const version = health.manifest?.version ? `v${health.manifest.version}` : 'Version unknown';
      const chromeMin = health.manifest?.minimumChromeVersion ? `Chrome ${health.manifest.minimumChromeVersion}+` : 'Chrome version unknown';
      versionText.textContent = `${version} \u00b7 ${chromeMin}`;
    }
    const networkBlockingActive = health.master?.networkBlocking && health.master?.enabled;
    const deAmpLinksActive = health.master?.deAmpLinks && health.master?.enabled;

    addHealthSection(body, 'Core', [
      ['Network blocking', networkBlockingActive ? 'Active' : 'Disabled', networkBlockingActive ? 'ok' : 'disabled'],
      ['Tracking URL cleanup', getTrackingUrlCleanupLabel(health, networkBlockingActive), getTrackingUrlCleanupStatus(health, networkBlockingActive)],
      ['De-AMP links', deAmpLinksActive ? 'Active' : 'Disabled', deAmpLinksActive ? 'ok' : 'disabled'],
      ['Static rulesets', `${formatCount(health.dnr?.enabledStaticRulesets?.length)} / ${formatCount(health.dnr?.expectedStaticRulesets?.length)} enabled`, health.dnr?.staticRulesetsOk ? 'ok' : (health.master?.networkBlocking ? 'error' : 'disabled')],
      ['Dynamic rules', `${formatCount(health.dnr?.appliedNetworkRuleCount)} active`, ''],
      ['Whitelist rules', formatCount(health.dnr?.whitelistRuleCount), '']
    ]);

    addHealthSection(body, 'Subscriptions', [
      ['Enabled lists', `${formatCount(health.subscriptions?.enabled)} / ${formatCount(health.subscriptions?.total)}`, health.subscriptions?.withErrors ? 'warning' : 'ok'],
      ['Applied network rules', formatCount(health.subscriptions?.appliedNetwork), ''],
      ['Cosmetic rules', formatCount(health.subscriptions?.cosmetic), ''],
      ['Scriptlet rules', formatCount(health.subscriptions?.scriptlet), ''],
      ['Errors', health.subscriptions?.withErrors ? formatCount(health.subscriptions.withErrors) : 'None', health.subscriptions?.withErrors ? 'warning' : 'ok']
    ]);

    addHealthSection(body, 'Scriptlets', [
      ['UserScripts API', health.scriptlets?.apiAvailable ? 'Available' : 'Unavailable', health.scriptlets?.apiAvailable ? 'ok' : (health.scriptlets?.storedRuleCount > 0 ? 'warning' : 'disabled')],
      ['Registered scripts', getRegisteredScriptletLabel(health), getRegisteredScriptletStatus(health)],
      ['Stored scriptlet rules', formatCount(health.scriptlets?.storedRuleCount), '']
    ]);

    addHealthSection(body, 'Fingerprint', [
      ['Fingerprint Randomization', health.fpr?.enabled ? (health.fpr?.active ? 'Active' : 'Not registered') : 'Disabled', health.fpr?.enabled ? (health.fpr?.active ? 'ok' : 'warning') : 'disabled'],
      ['Protected surfaces', health.fpr?.enabled ? getFprProtectedSurfaceLabel(health) : 'Disabled', health.fpr?.enabled ? (health.fpr?.active ? 'ok' : 'warning') : 'disabled'],
      ['FPR whitelist', `${formatCount(health.whitelist?.fprDomainCount)} domain(s)`, '']
    ]);

    addHealthSection(body, 'Cosmetic & Local', [
      ['Subscription cosmetic rules', formatCount(health.cosmetic?.subscriptionCosmeticRuleCount), ''],
      ['Local zapper rules', `${formatCount(health.cosmetic?.enabledLocalZapperRuleCount)} / ${formatCount(health.cosmetic?.localZapperRuleCount)}`, '']
    ]);

    addHealthSection(body, 'Proxy', [
      ['Configured proxies', formatCount(health.proxy?.configuredCount), ''],
      ['Accepted proxies', formatCount(health.proxy?.acceptedCount), ''],
      ['Routed domains', formatCount(health.proxy?.routedDomainCount), ''],
      ['Global proxy', health.proxy?.globalProxyEnabled ? (health.proxy?.globalProxyConfigured ? 'Enabled' : 'Misconfigured') : 'Disabled', health.proxy?.globalProxyEnabled ? (health.proxy?.globalProxyConfigured ? 'ok' : 'warning') : 'disabled'],
      getWebRtcHealthMetric(health)
    ]);

    addHealthSection(body, 'Browser Privacy', [
      ['Chrome Privacy Hardening', health.browserPrivacy?.enabled ? (health.browserPrivacy?.active ? 'Active' : `${formatCount(health.browserPrivacy?.hardenedCount)} / ${formatCount(health.browserPrivacy?.totalCount)} active`) : 'Disabled', health.browserPrivacy?.enabled ? (health.browserPrivacy?.active ? 'ok' : 'warning') : 'disabled'],
      ['Geolocation Protection', getGeolocationProtectionLabel(health), getGeolocationProtectionStatus(health)],
      ['Third-party cookies', getBrowserPrivacySettingLabel(health, 'thirdPartyCookiesAllowed'), getBrowserPrivacySettingStatus(health, 'thirdPartyCookiesAllowed')],
      ['Do Not Track', getBrowserPrivacySettingLabel(health, 'doNotTrackEnabled'), getBrowserPrivacySettingStatus(health, 'doNotTrackEnabled')],
      ['Privacy Sandbox ads', getPrivacySandboxLabel(health), getPrivacySandboxStatus(health)]
    ]);

    addHealthSection(body, 'Debug Logging', [
      ['DNR match logging', health.requestLog?.available ? 'Available' : 'Unavailable', health.requestLog?.available ? 'ok' : 'disabled'],
      ['Request log entries', `${formatCount(health.requestLog?.entryCount)} / ${formatCount(health.requestLog?.maxEntries)}`, ''],
      ['Note', health.requestLog?.note || 'Blocking can still work when debug logging is unavailable.', '']
    ]);

    renderHealthIssues(body, health.overall?.issues || []);
    setSectionReady('healthPanelBody');

    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Refresh Health';
    }
  }

  async function initSharedUI() {
    const settingsMode = isSettingsPage();
    globalThis.ChromaComponents?.renderPageShell({ settingsMode });

    const manifest = chrome.runtime.getManifest();
    if ($('versionText')) {
      $('versionText').textContent = `v${manifest.version} \u00b7 MV3`;
    }

    notifyBackground({ type: MSG.UPDATE_CHECK }).then(result => {
      if (!result || !result.updateAvailable) return;
      const banner = document.createElement('div');
      banner.id = 'updateBanner';
      banner.className = 'update-banner';

      const updateLink = document.createElement('a');
      updateLink.href = RELEASES_PAGE;
      updateLink.target = '_blank';
      updateLink.className = 'update-banner__link';
      updateLink.textContent = `\u2191 v${result.latestVersion} available`;

      const githubSpan = document.createElement('span');
      githubSpan.className = 'update-banner__source';
      githubSpan.textContent = 'on GitHub';

      const dismissBtn = document.createElement('button');
      dismissBtn.id = 'dismissUpdate';
      dismissBtn.className = 'update-banner__dismiss';
      dismissBtn.title = 'Dismiss';
      dismissBtn.textContent = '\u2715';

      banner.appendChild(updateLink);
      banner.appendChild(githubSpan);
      banner.appendChild(dismissBtn);
      document.querySelector('.section-title')?.before(banner);
      dismissBtn.addEventListener('click', () => banner.remove());
    }).catch(error => console.error('Chroma update check failed:', error));

    const syncUI = (cfg, masterOn) => {
      for (const [elId, key, def] of CONFIG_TOGGLES) {
        if ($(elId)) $(elId).checked = masterOn ? (cfg[key] ?? def) : false;
      }
    };

    function syncSpeedUI(speed, accelerationOn) {
      const row = $('speedSelectorRow');
      if (row) row.classList.toggle('disabled', !accelerationOn);
      document.querySelectorAll('.speed-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.speed) === speed);
      });
    }

    function updateStatusDot(active) {
      const dot = $('statusDot');
      if (!dot) return;
      if (active) {
        dot.classList.remove('off');
        dot.title = 'Active';
      } else {
        dot.classList.add('off');
        dot.title = 'Disabled';
      }
    }

    function showConfigLoadError(message) {
      const controls = $('toggleNetwork')?.closest?.('.protection-list');
      if (!controls || controls.querySelector('.hydration-error')) return;
      const error = document.createElement('div');
      error.className = 'hydration-error hydration-error--inline';
      error.textContent = message;
      controls.prepend(error);
    }

    function failSettingsHydration(message) {
      showConfigLoadError(message);
      [
        'healthPanelBody',
        'statisticsTopCards',
        'statsRangeSummary',
        'statsSitesList',
        'statsRulesList',
        'statsTimelineList',
        'statsEventsList',
        'subscriptionList',
        'proxyRouterContainer',
        'localZapperRules'
      ].forEach(id => setSectionError(id, 'Unavailable until the extension background responds.'));
      setStatsControlsPending(true);
      setControlsPending(true);
    }

    setControlsPending(true);
    setStatsControlsPending(true);

    let config = {};
    try {
      const configResponse = await notifyBackground({ type: MSG.CONFIG_GET });
      if (!configResponse && settingsMode) {
        failSettingsHydration('Settings are unavailable until the extension background responds.');
        return;
      }
      config = configResponse || {};
    } catch (error) {
      console.error('Chroma config failed to load:', error);
      if (settingsMode) {
        failSettingsHydration('Settings are unavailable until the extension background responds.');
      } else {
        showConfigLoadError('Settings are unavailable until the extension background responds.');
      }
      return;
    }

    const isEnabled = config.enabled !== false;
    if ($('toggleEnabled')) {
      $('toggleEnabled').checked = isEnabled;
      updateStatusDot(isEnabled);
    }
    syncUI(config, isEnabled);
    syncSpeedUI(config.accelerationSpeed ?? 8, isEnabled && (config.acceleration !== false));
    setControlsPending(false);
    setControlPending('toggleWhitelist', true);
    setControlPending('toggleFprWhitelist', true);

    document.querySelectorAll('.speed-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const speed = parseInt(btn.dataset.speed);
        syncSpeedUI(speed, $('toggleAcceleration')?.checked);
        await notifyBackground({ type: MSG.CONFIG_SET, config: { accelerationSpeed: speed } });
      });
    });

    for (const [elId, key] of CONFIG_TOGGLES) {
      $(elId)?.addEventListener('change', async (e) => {
        const isChecked = e.target.checked;
        await notifyBackground({ type: MSG.CONFIG_SET, config: { [key]: isChecked } });

        if (isChecked && !$('toggleEnabled')?.checked) {
          $('toggleEnabled').checked = true;
          updateStatusDot(true);
          await notifyBackground({ type: MSG.CONFIG_SET, config: { enabled: true } });
        } else if (!isChecked) {
          const anyOn = CONFIG_TOGGLES.some(([id]) => $(id)?.checked);
          if (!anyOn && $('toggleEnabled')) {
            $('toggleEnabled').checked = false;
            updateStatusDot(false);
            await notifyBackground({ type: MSG.CONFIG_SET, config: { enabled: false } });
          }
        }
      });
    }

    $('toggleAcceleration')?.addEventListener('change', (e) => {
      const currentActiveSpeed = parseInt(document.querySelector('.speed-btn.active')?.dataset.speed ?? 8);
      syncSpeedUI(currentActiveSpeed, e.target.checked);
    });

    $('toggleEnabled')?.addEventListener('change', async (e) => {
      const active = e.target.checked;
      updateStatusDot(active);
      await notifyBackground({ type: MSG.CONFIG_SET, config: { enabled: active } });

      if (!active) {
        syncUI({}, false);
      } else {
        const activeConfig = await notifyBackground({ type: MSG.CONFIG_GET });
        if (activeConfig) syncUI(activeConfig, true);
      }
    });

    $('refreshHealthBtn')?.addEventListener('click', loadHealthPanel);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.statsV2) {
        safeHydrateSection('stats', loadStatsUI);
      }
      if (area === 'local' && settingsMode && HEALTH_REFRESH_KEYS.some(key => changes[key])) {
        safeHydrateSection('health panel', loadHealthPanel);
      }
    });

    wireStatsControls();
    wireSharedLinks();
    wireAddSubscriptionForm();
    wireRequestLog();

    safeHydrateSection('site controls', hydrateSiteControls);
    safeHydrateSection('stats', loadStatsUI);
    safeHydrateSection('subscriptions', loadSubscriptionUI);
    if (settingsMode) {
      safeHydrateSection('health panel', loadHealthPanel);
      safeHydrateSection('proxy router', loadProxyRouterSection);
      safeHydrateSection('local zapper rules', loadLocalZapperRulesUI);
    } else {
      safeHydrateSection('proxy router', loadProxyRouterSection);
    }

    function wireStatsControls() {
      async function saveStatsSettingsFromControls() {
        const mode = $('statsModeSelect')?.value || 'aggregated';
        const retentionDays = Number($('statsRetentionSelect')?.value || 90);
        await notifyBackground({
          type: MSG.STATS_SETTINGS_SET,
          settings: {
            mode,
            retentionDays,
            storeFullUrls: mode === 'debug'
          }
        });
        await loadStatsUI();
      }

      $('statsModeSelect')?.addEventListener('change', saveStatsSettingsFromControls);
      $('statsRetentionSelect')?.addEventListener('change', saveStatsSettingsFromControls);
      $('resetAllStats')?.addEventListener('click', async () => {
        if (!confirm('Reset all local statistics?')) return;
        await notifyBackground({ type: MSG.STATS_RESET, scope: 'all' });
        await loadStatsUI();
      });
      $('resetSiteStats')?.addEventListener('click', async () => {
        await notifyBackground({ type: MSG.STATS_RESET, scope: 'sites' });
        await loadStatsUI();
      });
      $('resetRequestLogOnly')?.addEventListener('click', async () => {
        await notifyBackground({ type: MSG.STATS_RESET, scope: 'debugLog' });
      });
      $('exportStatsJson')?.addEventListener('click', async () => {
        const exported = await notifyBackground({ type: MSG.STATS_EXPORT });
        if (!exported) return;
        const text = JSON.stringify(exported, null, 2);
        try {
          const blob = new Blob([text], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `chroma-stats-${new Date().toISOString().slice(0, 10)}.json`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (_) {}
      });

      $('resetStats')?.addEventListener('click', async () => {
        await notifyBackground({ type: MSG.STATS_RESET, scope: 'all' });
        await loadStatsUI();
      });
    }

    function wireSharedLinks() {
      document.querySelectorAll('a[target="_blank"]').forEach(link => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          chrome.tabs.create({ url: link.href });
        });
      });

      const settingsIcon = $('settingsIcon');
      if (settingsIcon) {
        settingsIcon.addEventListener('click', (event) => {
          event.stopPropagation();
          openSettingsPage();
        });
      }

      const cardNetwork = $('cardNetwork');
      if (cardNetwork && settingsIcon) {
        cardNetwork.classList.add('stat-card--clickable');
        cardNetwork.title = 'Open Settings';
        cardNetwork.addEventListener('click', openSettingsPage);
      }
    }

    async function hydrateSiteControls() {
      let activeTab = null;
      try {
        [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      } catch (error) {
        console.error('Chroma active tab lookup failed:', error);
      }

      let currentDomain = '';
      if (activeTab?.url) {
        try {
          const url = new URL(activeTab.url);
          if (url.protocol.startsWith('http')) currentDomain = url.hostname;
        } catch (_) {}
      }

      if (!currentDomain) {
        $('toggleWhitelist')?.closest?.('.toggle-row')?.classList.add('disabled');
        const whitelist = $('toggleWhitelist');
        if (whitelist) {
          whitelist.disabled = true;
          whitelist.classList.remove('control-pending');
        }
        const rowFpr = $('rowFprWhitelist');
        if (rowFpr) rowFpr.classList.remove('is-visible');
        const zapBtn = $('zapElementBtn');
        if (zapBtn) zapBtn.disabled = true;
        if ($('zapperStatus')) $('zapperStatus').textContent = 'Unavailable on this page';
        return;
      }

      const parts = currentDomain.split('.');
      const baseDomain = parts.length > 2 ? parts.slice(-2).join('.') : currentDomain;
      const { whitelist = [] } = await notifyBackground({ type: MSG.WHITELIST_GET }) || { whitelist: [] };
      if ($('toggleWhitelist')) {
        $('toggleWhitelist').checked = whitelist.includes(baseDomain);
        setControlPending('toggleWhitelist', false);
        $('toggleWhitelist').addEventListener('change', async (e) => {
          const isChecked = e.target.checked;
          await notifyBackground({ type: isChecked ? MSG.WHITELIST_ADD : MSG.WHITELIST_REMOVE, domain: baseDomain });
          chrome.tabs.reload(activeTab.id);
        });
      }

      const rowFpr = $('rowFprWhitelist');
      const fprToggle = $('toggleFingerprintRandomization');
      const fprSiteToggle = $('toggleFprWhitelist');
      const updateFprRowVisibility = () => {
        const visible = !!(fprToggle && fprToggle.checked && $('toggleEnabled')?.checked);
        if (rowFpr) rowFpr.classList.toggle('is-visible', visible);
      };
      updateFprRowVisibility();
      fprToggle?.addEventListener('change', updateFprRowVisibility);
      $('toggleEnabled')?.addEventListener('change', updateFprRowVisibility);

      const { fprWhitelist = [] } = await notifyBackground({ type: MSG.FPR_WHITELIST_GET }) || { fprWhitelist: [] };
      if (fprSiteToggle) {
        fprSiteToggle.checked = fprWhitelist.includes(baseDomain);
        setControlPending('toggleFprWhitelist', false);
        fprSiteToggle.addEventListener('change', async (e) => {
          await notifyBackground({ type: e.target.checked ? MSG.FPR_WHITELIST_ADD : MSG.FPR_WHITELIST_REMOVE, domain: baseDomain });
          chrome.tabs.reload(activeTab.id);
        });
      }

      const zapBtn = $('zapElementBtn');
      const zapStatus = $('zapperStatus');
      if (!zapBtn) return;
      if (!activeTab?.id) {
        zapBtn.disabled = true;
        if (zapStatus) zapStatus.textContent = 'Unavailable on this page';
        return;
      }
      zapBtn.addEventListener('click', async () => {
        zapBtn.disabled = true;
        if (zapStatus) zapStatus.textContent = 'Starting...';
        const result = await notifyBackground({ type: MSG.ZAPPER_START, tabId: activeTab.id });
        if (result?.ok) {
          if (zapStatus) zapStatus.textContent = 'Click an element on the page';
          setTimeout(() => window.close?.(), 250);
        } else {
          if (zapStatus) zapStatus.textContent = result?.error || 'Could not start zapper';
          zapBtn.disabled = false;
        }
      });
    }

    async function loadSubscriptionUI() {
      const list = $('subscriptionList');
      if (!list) return;
      setSectionLoading('subscriptionList');

      let subscriptions = [];
      try {
        subscriptions = await notifyBackground({ type: MSG.SUBSCRIPTION_GET }) || [];
        subscriptions = subscriptions.filter(s => {
          if (s.id !== 'chroma-hotfix') return true;
          const totalRules = (s.ruleCount?.network || 0) + (s.ruleCount?.cosmetic || 0) + (s.ruleCount?.scriptlet || 0);
          return totalRules > 0;
        });
        subscriptions.sort((a, b) => {
          if (a.id === 'chroma-hotfix') return 1;
          if (b.id === 'chroma-hotfix') return -1;
          return 0;
        });

        const { appliedNetworkRuleCount = 0, appliedNetworkRulesPerSub = {} } =
          await chrome.storage.local.get(['appliedNetworkRuleCount', 'appliedNetworkRulesPerSub']);
        const totalParsed = subscriptions.reduce((sum, s) => sum + (s.ruleCount?.network || 0), 0);

        if (subscriptions.length === 0) {
          list.innerHTML = '<div class="toggle-row loading-row"><span class="loading-text">No subscriptions configured.</span></div>';
          setSectionReady('subscriptionList');
          return;
        }

        const summaryBar = document.createElement('div');
        summaryBar.className = 'subscription-summary';
        const totalCosmetic = subscriptions.reduce((sum, s) => sum + (s.ruleCount?.cosmetic || 0), 0);
        const totalScriptlet = subscriptions.reduce((sum, s) => sum + (s.ruleCount?.scriptlet || 0), 0);
        summaryBar.textContent = `${totalParsed.toLocaleString()} parsed \u00b7 ${appliedNetworkRuleCount.toLocaleString()} applied \u00b7 ${totalCosmetic.toLocaleString()} cosmetic \u00b7 ${totalScriptlet.toLocaleString()} scriptlets`;

        list.innerHTML = '';
        list.appendChild(summaryBar);

        for (const sub of subscriptions) {
          const row = document.createElement('div');
          row.className = 'toggle-row';
          const lastUpdatedText = sub.lastUpdated ? new Date(sub.lastUpdated).toLocaleDateString() : 'Never';
          const info = appendElement(row, 'div', 'toggle-info');
          appendElement(info, 'div', 'name', sub.name);
          appendElement(info, 'div', 'desc', `Updated: ${lastUpdatedText}`);

          if (sub.ruleCount) {
            const parts = [];
            if (!sub.cosmeticOnly && sub.ruleCount.network > 0) {
              const applied = sub.enabled ? (appliedNetworkRulesPerSub[sub.id] || 0) : 0;
              parts.push(`${applied.toLocaleString()} / ${sub.ruleCount.network.toLocaleString()} network`);
            }
            if (sub.ruleCount.cosmetic > 0) parts.push(`${sub.ruleCount.cosmetic.toLocaleString()} cosmetic`);
            if (sub.ruleCount.scriptlet > 0) parts.push(`${sub.ruleCount.scriptlet.toLocaleString()} scriptlets`);
            if (parts.length) appendElement(info, 'div', 'desc', parts.join(' \u00b7 '));
          }

          if (sub.lastError) {
            const error = appendElement(info, 'div', 'subscription-error', `Error: ${sub.lastError}`);
            error.title = sub.lastError;
          }

          const actions = appendElement(row, 'div', 'subscription-actions');
          if (sub.isCustom) {
            const deleteBtn = appendElement(actions, 'button', 'sub-delete-btn reset-btn inline-danger-btn subscription-icon-btn', '\u00d7');
            deleteBtn.dataset.id = sub.id;
            deleteBtn.title = 'Remove List';
            appendElement(actions, 'span', 'inline-separator');
          }

          const refreshBtn = appendElement(actions, 'button', 'sub-refresh-btn reset-btn compact-action-btn', '\u21bb');
          refreshBtn.dataset.id = sub.id;
          refreshBtn.title = 'Force refresh';

          const toggleLabel = appendElement(actions, 'label', 'switch');
          const toggleInput = appendElement(toggleLabel, 'input', 'sub-toggle');
          toggleInput.type = 'checkbox';
          toggleInput.dataset.id = sub.id;
          toggleInput.checked = !!sub.enabled;
          appendElement(toggleLabel, 'span', 'slider');
          list.appendChild(row);
        }
      } catch (error) {
        console.error('Chroma subscriptions failed to load:', error);
        setSectionError('subscriptionList', 'Subscriptions unavailable.');
        return;
      }

      setSectionReady('subscriptionList');
      list.querySelectorAll('.sub-toggle').forEach(input => {
        input.addEventListener('change', async (e) => {
          await notifyBackground({ type: MSG.SUBSCRIPTION_SET, id: e.target.dataset.id, enabled: e.target.checked });
          await loadHealthPanel();
        });
      });
      list.querySelectorAll('.sub-refresh-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const id = e.target.dataset.id;
          e.target.textContent = '\u2026';
          e.target.disabled = true;
          const result = await notifyBackground({ type: MSG.SUBSCRIPTION_REFRESH, id });
          e.target.textContent = result && result.ok ? '\u2713' : '\u2717';
          setTimeout(() => {
            e.target.textContent = '\u21bb';
            e.target.disabled = false;
            loadSubscriptionUI();
            loadHealthPanel();
          }, 1500);
        });
      });
      list.querySelectorAll('.sub-delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          if (!confirm('Remove this filter list?')) return;
          await notifyBackground({ type: MSG.SUBSCRIPTION_REMOVE, id: e.target.dataset.id });
          loadSubscriptionUI();
          loadHealthPanel();
        });
      });
    }

    function wireAddSubscriptionForm() {
      const addBtn = $('addSubscriptionBtn');
      const form = $('addSubscriptionForm');
      const nameInput = $('newSubName');
      const urlInput = $('newSubUrl');
      const errEl = $('newSubError');
      const submitBtn = $('newSubAddBtn');
      const cancelBtn = $('newSubCancelBtn');
      if (!addBtn || !form) return;

      const showError = (message) => {
        if (!errEl) return;
        errEl.textContent = message;
        errEl.style.display = 'block';
      };
      const closeForm = () => {
        form.style.display = 'none';
        if (nameInput) nameInput.value = '';
        if (urlInput) urlInput.value = '';
        if (errEl) {
          errEl.style.display = 'none';
          errEl.textContent = '';
        }
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Add';
        }
      };

      addBtn.addEventListener('click', () => {
        if (form.style.display === 'none' || form.style.display === '') {
          form.style.display = 'block';
          urlInput?.focus?.();
        } else {
          closeForm();
        }
      });
      cancelBtn?.addEventListener('click', closeForm);

      const submitAdd = async () => {
        if (errEl) errEl.style.display = 'none';
        const url = urlInput?.value.trim() || '';
        if (!url) return showError('URL required.');
        let parsed;
        try { parsed = new URL(url); } catch { return showError('Invalid URL.'); }
        if (parsed.protocol !== 'https:') return showError('Only https:// URLs are allowed.');

        const name = nameInput?.value.trim() || parsed.hostname;
        const id = 'custom_' + Date.now();
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Adding\u2026';
        }

        const addRes = await notifyBackground({ type: MSG.SUBSCRIPTION_ADD, subscription: { id, name, url } });
        if (!addRes || !addRes.ok) {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Add';
          }
          return showError(addRes?.error || 'Add failed.');
        }

        const refRes = await notifyBackground({ type: MSG.SUBSCRIPTION_REFRESH, id });
        if (!refRes || !refRes.ok) {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Add';
          }
          showError('Added, but fetch failed: ' + (refRes?.error || 'unknown'));
          await loadSubscriptionUI();
          return;
        }

        closeForm();
        await loadSubscriptionUI();
        await loadHealthPanel();
      };

      submitBtn?.addEventListener('click', submitAdd);
      urlInput?.addEventListener('keypress', (e) => { if (e.key === 'Enter') submitAdd(); });
      nameInput?.addEventListener('keypress', (e) => { if (e.key === 'Enter') submitAdd(); });
    }

    async function loadProxyRouterSection() {
      if (globalThis.ChromaProxyUI?.loadProxyRouterUI) {
        await globalThis.ChromaProxyUI.loadProxyRouterUI();
        scrollToProxyHash();
      }
    }

    async function loadLocalZapperRulesUI() {
      if (!settingsMode) return;
      const list = $('localZapperRules');
      if (!list) return;
      setSectionLoading('localZapperRules');

      let rules = [];
      try {
        const res = await notifyBackground({ type: MSG.ZAPPER_RULES_GET }) || { rules: [] };
        rules = Array.isArray(res.rules) ? res.rules : [];
      } catch (error) {
        console.error('Chroma local zapper rules failed to load:', error);
        setSectionError('localZapperRules', 'Local zapper rules unavailable.');
        return;
      }

      list.innerHTML = '';
      if (rules.length === 0) {
        list.innerHTML = '<div class="toggle-row loading-row"><span class="loading-text">No local zapper rules saved.</span></div>';
        setSectionReady('localZapperRules');
        return;
      }

      const grouped = rules.reduce((map, rule) => {
        const key = rule.domain || 'unknown';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(rule);
        return map;
      }, new Map());

      for (const [domain, domainRules] of grouped) {
        const header = document.createElement('div');
        header.className = 'zapper-domain-header';
        header.textContent = domain;
        list.appendChild(header);

        for (const rule of domainRules) {
          const row = document.createElement('div');
          row.className = 'toggle-row';
          const info = appendElement(row, 'div', 'toggle-info');
          const selector = appendElement(info, 'div', 'zapper-rule-selector', rule.selector);
          selector.title = rule.selector;
          appendElement(info, 'div', 'desc', `Saved ${new Date(rule.createdAt || Date.now()).toLocaleDateString()}`);

          const actions = appendElement(row, 'div', 'zapper-rule-actions');
          const toggleLabel = appendElement(actions, 'label', 'switch switch-sm');
          toggleLabel.title = rule.enabled ? 'Disable rule' : 'Enable rule';
          const toggleInput = appendElement(toggleLabel, 'input', 'zapper-rule-toggle');
          toggleInput.type = 'checkbox';
          toggleInput.dataset.id = rule.id;
          toggleInput.checked = !!rule.enabled;
          appendElement(toggleLabel, 'span', 'slider');

          const deleteBtn = appendElement(actions, 'button', 'reset-btn zapper-rule-delete inline-danger-btn compact-action-btn', 'Delete');
          deleteBtn.dataset.id = rule.id;
          deleteBtn.title = 'Delete rule';
          list.appendChild(row);
        }
      }

      setSectionReady('localZapperRules');
      list.querySelectorAll('.zapper-rule-toggle').forEach(input => {
        input.addEventListener('change', async (event) => {
          await notifyBackground({
            type: MSG.ZAPPER_RULE_SET,
            id: event.target.dataset.id,
            enabled: event.target.checked
          });
        });
      });
      list.querySelectorAll('.zapper-rule-delete').forEach(button => {
        button.addEventListener('click', async (event) => {
          await notifyBackground({ type: MSG.ZAPPER_RULE_REMOVE, id: event.target.dataset.id });
          await loadLocalZapperRulesUI();
        });
      });
    }

    function wireRequestLog() {
      const toggleRow = $('logToggleRow');
      const toggleBtn = $('logToggleBtn');
      const entries = $('logEntries');
      if (!toggleRow || !entries) return;

      const RT_BADGE = {
        script: { label: 'JS', className: 'script' },
        xmlhttprequest: { label: 'XHR', className: 'xhr' },
        image: { label: 'IMG', className: 'image' },
        sub_frame: { label: 'FRM', className: 'frame' },
        main_frame: { label: 'DOC', className: 'document' },
        stylesheet: { label: 'CSS', className: 'css' },
        media: { label: 'MED', className: 'media' },
        websocket: { label: 'WS', className: 'websocket' },
        ping: { label: 'PNG', className: 'muted' },
        other: { label: 'OTH', className: 'muted' },
        object: { label: 'OBJ', className: 'muted' },
      };

      const formatLogUrl = (url) => {
        try {
          const parsed = new URL(url);
          const userPath = parsed.pathname.length > 22 ? parsed.pathname.slice(0, 20) + '\u2026' : parsed.pathname;
          return parsed.hostname + userPath;
        } catch {
          return String(url || '').slice(0, 40);
        }
      };
      const formatTimeAgo = (ts) => {
        const seconds = Math.floor((Date.now() - ts) / 1000);
        if (seconds < 60) return `${seconds}s`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
        return `${Math.floor(seconds / 3600)}h`;
      };

      let isOpen = false;
      async function renderLog() {
        const log = await notifyBackground({ type: MSG.LOG_GET }) || [];
        entries.innerHTML = '';
        if (log.length === 0) {
          entries.innerHTML = '<div class="log-empty">No entries yet.</div>';
          return;
        }

        for (const entry of log) {
          const badge = RT_BADGE[entry.rt] || { label: '???', className: 'unknown' };
          const row = document.createElement('div');
          row.className = 'log-entry';
          appendElement(row, 'span', `log-rt log-rt--${badge.className}`, badge.label);
          const url = appendElement(row, 'span', 'log-url', formatLogUrl(entry.url));
          url.title = entry.url;
          appendElement(row, 'span', 'log-time', formatTimeAgo(entry.ts));
          entries.appendChild(row);
        }
      }

      toggleRow.addEventListener('click', async () => {
        isOpen = !isOpen;
        toggleBtn?.classList.toggle('open', isOpen);
        entries.classList.toggle('visible', isOpen);
        if (isOpen) await renderLog();
      });
    }
  }

  function scrollToProxyHash() {
    if (!['#proxy', '#proxySection'].includes(globalThis.location?.hash)) return;
    const scroll = (behavior = 'smooth') => {
      const section = $('proxySection') || $('proxyRouterContainer');
      section?.scrollIntoView({ behavior, block: 'start' });
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => scroll());
    } else {
      Promise.resolve().then(scroll);
    }
    [120, 360, 720].forEach(delay => {
      setTimeout(() => scroll('auto'), delay);
    });
  }

  return {
    $,
    escapeHTML,
    isSettingsPage,
    openProxySettings,
    initSharedUI,
    scrollToProxyHash
  };
})();

globalThis.ChromaApp = ChromaApp;
globalThis.openProxySettings = ChromaApp.openProxySettings;
