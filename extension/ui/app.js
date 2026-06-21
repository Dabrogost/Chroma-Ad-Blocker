/**
 * Chroma Ad-Blocker - Shared UI logic.
 * Coordinates shared popup/settings controls and delegates proxy rendering.
 */

'use strict';

const ChromaApp = (() => {
  const { $, escapeHTML, appendElement, clearElement, setText, addKeyboardActivation } = globalThis.ChromaDom;
  const { getRegistrableDomain } = globalThis.ChromaDomain;

  const RELEASES_PAGE = 'https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/latest';
  const PROXY_SETTINGS_PATH = 'ui/settings.html#proxySection';
  const UPDATE_SETTINGS_PATH = 'ui/settings.html#updatesSection';
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

  function publishUpdateCheckResult(result) {
    globalThis.ChromaLatestUpdateCheck = result || null;
    const EventCtor = globalThis.CustomEvent || globalThis.window?.CustomEvent;
    const target = typeof globalThis.dispatchEvent === 'function' ? globalThis : globalThis.window;
    if (typeof EventCtor === 'function' && typeof target?.dispatchEvent === 'function') {
      target.dispatchEvent(new EventCtor('chroma:update-check-result', { detail: result || null }));
    }
  }

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

  function openUpdatesSettings() {
    const url = chrome.runtime.getURL(UPDATE_SETTINGS_PATH);
    if (isSettingsPage()) {
      globalThis.location.hash = '#updatesSection';
      const section = $('updatesSection') || $('updaterPanel');
      section?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    } else if (chrome.tabs?.create) {
      chrome.tabs.create({ url });
    } else {
      window.open(url);
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

  function formatSubscriptionCompatibility(sub) {
    const compatibility = sub?.compatibility || {};
    const translated = Number(compatibility.translatedRegexFilter) || 0;
    const unsupported = Number(compatibility.unsupportedUrlFilter) || 0;
    const parts = [];
    if (translated > 0) {
      parts.push(`${formatCount(translated)} translated`);
    }
    if (unsupported > 0) {
      parts.push(`${formatCount(unsupported)} skipped`);
    }
    return parts.length ? `Network compatibility: ${parts.join(' \u00b7 ')}` : '';
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

  function getStatsTotals(stats) {
    return stats?.totals || {};
  }

  function getCleanupTotal(totals) {
    return (Number(totals?.cosmeticHides) || 0) + (Number(totals?.youtubePayloadCleans) || 0);
  }

  function getProxyActivityTotal(totals) {
    return (Number(totals?.proxyTests) || 0) + (Number(totals?.proxyAuthChallenges) || 0);
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
    clearElement(el);
    appendElement(el, 'div', 'hydration-error', message);
    setSectionReady(id);
  }

  function appendLoadingRow(parent, text) {
    const row = appendElement(parent, 'div', 'toggle-row loading-row');
    appendElement(row, 'span', 'loading-text', text);
    return row;
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

  function setControlPending(id, pending, options = {}) {
    const el = $(id);
    if (!el) return;
    const disable = options.disable ?? true;
    const visual = options.visual ?? true;
    el.disabled = pending && disable;
    el.classList.toggle('control-pending', pending && visual);
    el.closest?.('.toggle-row')?.classList.toggle('control-pending', pending && visual);
  }

  async function safeHydrateSection(name, fn) {
    try {
      return await fn();
    } catch (error) {
      console.error(`Chroma ${name} hydration failed:`, error);
      return null;
    }
  }

  const healthPanel = globalThis.ChromaHealthUI?.createController({
    $,
    appendElement,
    formatCount,
    formatStatusLabel,
    setSectionLoading,
    setSectionReady,
    notifyBackground,
    MSG,
    isSettingsPage
  }) || { loadHealthPanel: async () => {} };

  function loadHealthPanel() {
    return healthPanel.loadHealthPanel();
  }

  async function sendMutation(message) {
    try {
      const result = await notifyBackground(message);
      if (!result || result.ok === false) return null;
      return result;
    } catch (error) {
      console.error('Chroma mutation failed:', error);
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

    clearElement(topCards);
    addStatsMiniCard(topCards, 'Total Protection Events', formatCompactCount(totals.protectionEvents));
    addStatsMiniCard(topCards, 'Network Blocks', formatCompactCount(totals.networkBlocks));
    addStatsMiniCard(topCards, 'Ad Cleanups', formatCompactCount(getCleanupTotal(totals)));
    addStatsMiniCard(topCards, 'Scriptlet Hits', formatCompactCount(totals.scriptletHits));
    addStatsMiniCard(topCards, 'Warnings Suppressed', formatCompactCount(totals.warningSuppressions));
    addStatsMiniCard(topCards, 'Local Zapper Hits', formatCompactCount(totals.zapperHits));
    addStatsMiniCard(topCards, 'Proxy Activity', formatCompactCount(getProxyActivityTotal(totals)));
    addStatsMiniCard(topCards, 'Time Saved (est.)', formatDuration(stats?.timeSavedSeconds));

    if (rangeSummary) {
      clearElement(rangeSummary);
      addStatsMiniCard(rangeSummary, 'Today', formatCompactCount(stats?.ranges?.today?.protectionEvents));
      addStatsMiniCard(rangeSummary, '7 Days', formatCompactCount(stats?.ranges?.last7Days?.protectionEvents));
      addStatsMiniCard(rangeSummary, '30 Days', formatCompactCount(stats?.ranges?.last30Days?.protectionEvents));
      addStatsMiniCard(rangeSummary, 'All Time', formatCompactCount(stats?.ranges?.allTime?.protectionEvents));
    }

    if (sitesList) {
      clearElement(sitesList);
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
      clearElement(rulesList);
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
      clearElement(timelineList);
      const days = Object.values(stats?.byDay || {})
        .sort((a, b) => String(a.day).localeCompare(String(b.day)))
        .slice(-14);
      const max = Math.max(1, ...days.map(day => Number(day.protectionEvents) || 0));
      if (days.length === 0) renderEmptyStatsList(timelineList, emptyText || 'No timeline data yet.');
      for (const day of days) {
        const row = addStatsRow(timelineList, day.day, '', formatCompactCount(day.protectionEvents));
        const bar = appendElement(row.firstChild, 'div', 'stats-bar');
        const fill = appendElement(bar, 'div', 'stats-bar__fill');
        const fillLevel = Math.max(1, Math.min(20, Math.ceil(((day.protectionEvents || 0) / max) * 20)));
        fill.classList.add(`stats-bar__fill--${fillLevel}`);
      }
    }

    if (eventsList) {
      clearElement(eventsList);
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
      const message = isSettingsPage()
        ? { type: MSG.STATS_GET }
        : { type: MSG.STATS_GET, options: { summaryOnly: true } };
      stats = await notifyBackground(message) || null;
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

  async function initSharedUI() {
    const settingsMode = isSettingsPage();
    globalThis.ChromaComponents?.renderPageShell({ settingsMode });

    const manifest = chrome.runtime.getManifest();
    if ($('versionText')) {
      $('versionText').textContent = `v${manifest.version} \u00b7 MV3`;
    }

    notifyBackground({ type: MSG.UPDATE_CHECK }).then(result => {
      publishUpdateCheckResult(result);
      if (!result || !result.updateAvailable) return;
      const guidedInstallReady = (
        result.assetStatus === 'found'
        && result.asset?.downloadUrl
        && result.updateManifestStatus === 'found'
        && result.updateManifestAsset?.downloadUrl
      );
      const banner = document.createElement('div');
      banner.id = 'updateBanner';
      banner.className = 'update-banner';

      const updateLink = document.createElement('a');
      updateLink.href = guidedInstallReady ? chrome.runtime.getURL(UPDATE_SETTINGS_PATH) : RELEASES_PAGE;
      if (!guidedInstallReady) {
        updateLink.target = '_blank';
        updateLink.rel = 'noopener';
      }
      updateLink.className = 'update-banner__link';
      updateLink.textContent = guidedInstallReady
        ? `Update to v${result.latestVersion}`
        : `\u2191 v${result.latestVersion} available`;

      const githubSpan = document.createElement('span');
      githubSpan.className = 'update-banner__source';
      githubSpan.textContent = guidedInstallReady ? 'guided install' : 'on GitHub';

      const dismissBtn = document.createElement('button');
      dismissBtn.id = 'dismissUpdate';
      dismissBtn.className = 'update-banner__dismiss';
      dismissBtn.title = 'Dismiss';
      dismissBtn.textContent = '\u2715';

      banner.appendChild(updateLink);
      banner.appendChild(githubSpan);
      banner.appendChild(dismissBtn);
      document.querySelector('.section-title')?.before(banner);
      if (guidedInstallReady) {
        updateLink.addEventListener('click', event => {
          event.preventDefault();
          openUpdatesSettings();
        });
      }
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

    function getActiveSpeed() {
      return parseInt(document.querySelector('.speed-btn.active')?.dataset.speed ?? config.accelerationSpeed ?? 8);
    }

    function captureProtectionState() {
      return {
        enabled: $('toggleEnabled')?.checked ?? true,
        speed: getActiveSpeed(),
        toggles: Object.fromEntries(CONFIG_TOGGLES.map(([id, key, def]) => [id, $(id)?.checked ?? (config[key] ?? def)]))
      };
    }

    function restoreProtectionState(state) {
      if (!state) return;
      if ($('toggleEnabled')) $('toggleEnabled').checked = state.enabled;
      updateStatusDot(state.enabled);
      for (const [id, checked] of Object.entries(state.toggles || {})) {
        if ($(id)) $(id).checked = checked;
      }
      syncSpeedUI(state.speed ?? 8, !!state.toggles?.toggleAcceleration && state.enabled);
      const rowFpr = $('rowFprWhitelist');
      const fprEnabled = $('toggleFingerprintRandomization')?.checked ?? state.toggles?.toggleFingerprintRandomization ?? !!config.fingerprintRandomization;
      if (rowFpr) rowFpr.classList.toggle('is-visible', !!(fprEnabled && $('toggleEnabled')?.checked));
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
      const anchor = $('toggleNetwork') || $('toggleWhitelist');
      const controls = anchor?.closest?.('.protection-list');
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
        'userScriptletSourceList',
        'proxyRouterContainer',
        'localZapperRules'
      ].forEach(id => setSectionError(id, 'Unavailable until the extension background responds.'));
      setStatsControlsPending(true);
      setControlsPending(true);
    }

    setControlsPending(true);
    setStatsControlsPending(true);

    function setProtectionTogglePending(id, pending) {
      setControlPending(id, pending, { disable: settingsMode, visual: settingsMode });
    }

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
        const previous = captureProtectionState();
        const speed = parseInt(btn.dataset.speed);
        syncSpeedUI(speed, $('toggleAcceleration')?.checked);
        document.querySelectorAll('.speed-btn').forEach(speedBtn => {
          speedBtn.disabled = true;
          speedBtn.classList.add('control-pending');
        });
        const result = await sendMutation({ type: MSG.CONFIG_SET, config: { accelerationSpeed: speed } });
        if (result) {
          config.accelerationSpeed = speed;
        } else {
          restoreProtectionState(previous);
        }
        document.querySelectorAll('.speed-btn').forEach(speedBtn => {
          speedBtn.disabled = false;
          speedBtn.classList.remove('control-pending');
        });
      });
    });

    for (const [elId, key] of CONFIG_TOGGLES) {
      $(elId)?.addEventListener('change', async (e) => {
        const isChecked = e.target.checked;
        const previous = captureProtectionState();
        previous.toggles[elId] = !isChecked;
        setProtectionTogglePending(elId, true);
        const nextConfig = { [key]: isChecked };
        let nextEnabled = $('toggleEnabled')?.checked;
        if (isChecked && !$('toggleEnabled')?.checked) {
          nextEnabled = true;
          nextConfig.enabled = true;
          $('toggleEnabled').checked = true;
          updateStatusDot(true);
        } else if (!isChecked) {
          const anyOn = CONFIG_TOGGLES.some(([id]) => $(id)?.checked);
          if (!anyOn && $('toggleEnabled')) {
            nextEnabled = false;
            nextConfig.enabled = false;
            $('toggleEnabled').checked = false;
            updateStatusDot(false);
          }
        }

        const result = await sendMutation({ type: MSG.CONFIG_SET, config: nextConfig });
        if (!result) {
          restoreProtectionState(previous);
          setProtectionTogglePending(elId, false);
          return;
        }
        config[key] = isChecked;
        if (typeof nextEnabled === 'boolean') config.enabled = nextEnabled;
        setProtectionTogglePending(elId, false);
      });
    }

    $('toggleAcceleration')?.addEventListener('change', (e) => {
      const currentActiveSpeed = parseInt(document.querySelector('.speed-btn.active')?.dataset.speed ?? 8);
      syncSpeedUI(currentActiveSpeed, e.target.checked);
    });

    $('toggleEnabled')?.addEventListener('change', async (e) => {
      const active = e.target.checked;
      const previous = captureProtectionState();
      previous.enabled = !active;
      updateStatusDot(active);
      if (!settingsMode) syncUI(config, active);
      setProtectionTogglePending('toggleEnabled', true);
      const result = await sendMutation({ type: MSG.CONFIG_SET, config: { enabled: active } });
      if (!result) {
        restoreProtectionState(previous);
        setProtectionTogglePending('toggleEnabled', false);
        return;
      }
      config.enabled = active;

      if (!active) {
        syncUI({}, false);
      } else {
        const activeConfig = await notifyBackground({ type: MSG.CONFIG_GET });
        if (activeConfig) {
          config = activeConfig;
          syncUI(activeConfig, true);
        } else {
          syncUI(config, true);
        }
      }
      setProtectionTogglePending('toggleEnabled', false);
    });

    $('refreshHealthBtn')?.addEventListener('click', loadHealthPanel);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.statsV2) {
        safeHydrateSection('stats', loadStatsUI);
      }
    });

    wireStatsControls();
    wireSharedLinks();
    wireAddSubscriptionForm();
    wireUserScriptletControls();
    wireRequestLog();

    safeHydrateSection('site controls', hydrateSiteControls);
    safeHydrateSection('stats', loadStatsUI);
    if (settingsMode) {
      safeHydrateSection('subscriptions', loadSubscriptionUI);
      safeHydrateSection('health panel', loadHealthPanel);
      safeHydrateSection('user scriptlets', loadUserScriptletUI);
      safeHydrateSection('proxy router', loadProxyRouterSection);
      safeHydrateSection('local zapper rules', loadLocalZapperRulesUI);
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

      $('exportConfigJson')?.addEventListener('click', async () => {
        const exported = await notifyBackground({ type: MSG.CONFIG_EXPORT });
        if (!exported) return;
        const text = JSON.stringify(exported, null, 2);
        try {
          const blob = new Blob([text], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `chroma-settings-${new Date().toISOString().slice(0, 10)}.json`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          setText('settingsBackupStatus', 'Settings exported.');
        } catch (_) {
          setText('settingsBackupStatus', 'Settings export failed.');
        }
      });

      const importFile = $('importConfigFile');
      $('importConfigJson')?.addEventListener('click', () => importFile?.click());
      importFile?.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        setText('settingsBackupStatus', 'Importing settings...');
        let parsed;
        try {
          parsed = JSON.parse(await file.text());
        } catch {
          setText('settingsBackupStatus', 'Invalid settings JSON.');
          return;
        }

        const result = await notifyBackground({ type: MSG.CONFIG_IMPORT, settings: parsed });
        if (!result?.ok) {
          setText('settingsBackupStatus', result?.error || 'Settings import failed.');
          return;
        }
        setText('settingsBackupStatus', 'Settings imported. Refreshing UI...');
        try {
          const nextConfig = await notifyBackground({ type: MSG.CONFIG_GET });
          if (nextConfig) {
            config = nextConfig;
            const enabled = config.enabled !== false;
            const masterToggle = $('toggleEnabled');
            if (masterToggle) masterToggle.checked = enabled;
            updateStatusDot(enabled);
            syncUI(config, enabled);
            syncSpeedUI(config.accelerationSpeed ?? 8, enabled && (config.acceleration !== false));
          }
          await Promise.all([
            loadSubscriptionUI(),
            loadUserScriptletUI(),
            loadProxyRouterSection(),
            loadHealthPanel()
          ]);
          setText('settingsBackupStatus', 'Settings imported.');
        } catch {
          setText('settingsBackupStatus', 'Settings imported. Reopen settings to refresh.');
        }
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
        cardNetwork.setAttribute('role', 'button');
        cardNetwork.setAttribute('tabindex', '0');
        cardNetwork.setAttribute('aria-label', 'Open Settings');
        addKeyboardActivation(cardNetwork, openSettingsPage);
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

      const baseDomain = getRegistrableDomain(currentDomain);
      const { whitelist = [] } = await notifyBackground({ type: MSG.WHITELIST_GET }) || { whitelist: [] };
      if ($('toggleWhitelist')) {
        $('toggleWhitelist').checked = whitelist.includes(baseDomain);
        setControlPending('toggleWhitelist', false);
        $('toggleWhitelist').addEventListener('change', async (e) => {
          const isChecked = e.target.checked;
          const previous = !isChecked;
          setControlPending('toggleWhitelist', true);
          const result = await sendMutation({ type: isChecked ? MSG.WHITELIST_ADD : MSG.WHITELIST_REMOVE, domain: baseDomain });
          if (result) {
            chrome.tabs.reload(activeTab.id);
          } else {
            e.target.checked = previous;
          }
          setControlPending('toggleWhitelist', false);
        });
      }

      const rowFpr = $('rowFprWhitelist');
      const fprToggle = $('toggleFingerprintRandomization');
      const fprSiteToggle = $('toggleFprWhitelist');
      const updateFprRowVisibility = () => {
        const fprEnabled = fprToggle ? fprToggle.checked : !!config.fingerprintRandomization;
        const visible = !!(fprEnabled && $('toggleEnabled')?.checked);
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
          const isChecked = e.target.checked;
          const previous = !isChecked;
          setControlPending('toggleFprWhitelist', true);
          const result = await sendMutation({ type: isChecked ? MSG.FPR_WHITELIST_ADD : MSG.FPR_WHITELIST_REMOVE, domain: baseDomain });
          if (result) {
            chrome.tabs.reload(activeTab.id);
          } else {
            e.target.checked = previous;
          }
          setControlPending('toggleFprWhitelist', false);
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
          clearElement(list);
          appendLoadingRow(list, 'No subscriptions configured.');
          setSectionReady('subscriptionList');
          return;
        }

        const summaryBar = document.createElement('div');
        summaryBar.className = 'subscription-summary';
        const totalCosmetic = subscriptions.reduce((sum, s) => sum + (s.ruleCount?.cosmetic || 0), 0);
        const totalScriptlet = subscriptions.reduce((sum, s) => sum + (s.ruleCount?.scriptlet || 0), 0);
        summaryBar.textContent = `${totalParsed.toLocaleString()} parsed \u00b7 ${appliedNetworkRuleCount.toLocaleString()} applied \u00b7 ${totalCosmetic.toLocaleString()} cosmetic \u00b7 ${totalScriptlet.toLocaleString()} scriptlets`;

        clearElement(list);
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
          const compatibilityText = formatSubscriptionCompatibility(sub);
          if (compatibilityText) appendElement(info, 'div', 'desc', compatibilityText);

          if (sub.lastError) {
            const error = appendElement(info, 'div', 'subscription-error', `Error: ${sub.lastError}`);
            error.title = sub.lastError;
          }

          const actions = appendElement(row, 'div', 'subscription-actions');
          if (sub.isCustom) {
            const deleteBtn = appendElement(actions, 'button', 'sub-delete-btn reset-btn inline-danger-btn subscription-icon-btn', '\u00d7');
            deleteBtn.dataset.id = sub.id;
            deleteBtn.title = 'Remove List';
            deleteBtn.setAttribute('aria-label', `Remove ${sub.name || 'filter list'}`);
            appendElement(actions, 'span', 'inline-separator');
          }

          const refreshBtn = appendElement(actions, 'button', 'sub-refresh-btn reset-btn compact-action-btn', '\u21bb');
          refreshBtn.dataset.id = sub.id;
          refreshBtn.title = 'Force refresh';
          refreshBtn.setAttribute('aria-label', `Refresh ${sub.name || 'filter list'}`);

          const toggleLabel = appendElement(actions, 'label', 'switch');
          const toggleInput = appendElement(toggleLabel, 'input', 'sub-toggle');
          toggleInput.type = 'checkbox';
          toggleInput.dataset.id = sub.id;
          toggleInput.checked = !!sub.enabled;
          toggleInput.setAttribute('aria-label', `Enable ${sub.name || 'filter list'}`);
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
          const previous = !e.target.checked;
          e.target.disabled = true;
          e.target.classList.add('control-pending');
          const result = await sendMutation({ type: MSG.SUBSCRIPTION_SET, id: e.target.dataset.id, enabled: e.target.checked });
          if (result) {
            await loadHealthPanel();
          } else {
            e.target.checked = previous;
          }
          e.target.disabled = false;
          e.target.classList.remove('control-pending');
        });
      });
      list.querySelectorAll('.sub-refresh-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const id = e.target.dataset.id;
          e.target.textContent = '\u2026';
          e.target.disabled = true;
          const result = await sendMutation({ type: MSG.SUBSCRIPTION_REFRESH, id });
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
          e.target.disabled = true;
          const result = await sendMutation({ type: MSG.SUBSCRIPTION_REMOVE, id: e.target.dataset.id });
          if (result) {
            loadSubscriptionUI();
            loadHealthPanel();
          } else {
            e.target.disabled = false;
            e.target.title = 'Remove failed';
          }
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
        errEl.classList.remove('is-hidden');
      };
      const closeForm = () => {
        form.classList.add('is-hidden');
        if (nameInput) nameInput.value = '';
        if (urlInput) urlInput.value = '';
        if (errEl) {
          errEl.classList.add('is-hidden');
          errEl.textContent = '';
        }
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Add';
        }
      };

      addBtn.addEventListener('click', () => {
        if (form.classList.contains('is-hidden')) {
          form.classList.remove('is-hidden');
          urlInput?.focus?.();
        } else {
          closeForm();
        }
      });
      cancelBtn?.addEventListener('click', closeForm);

      const submitAdd = async () => {
        if (errEl) errEl.classList.add('is-hidden');
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

    function formatUserScriptletSourceUpdated(source) {
      if (source?.lastUpdated) return new Date(source.lastUpdated).toLocaleString();
      return 'Never';
    }

    function setUserScriptletRulesStatus(message, isError = false) {
      const status = $('userScriptletRulesStatus');
      if (!status) return;
      status.textContent = message || '';
      status.classList.toggle('form-error', !!isError);
    }

    function setUserScriptletRulesPending(pending) {
      const textarea = $('userScriptletRulesText');
      const saveBtn = $('saveUserScriptletRulesBtn');
      if (textarea) {
        textarea.readOnly = !!pending;
        textarea.classList.toggle('control-pending', !!pending);
        textarea.setAttribute('aria-busy', pending ? 'true' : 'false');
      }
      if (saveBtn) {
        saveBtn.disabled = !!pending;
        saveBtn.classList.toggle('control-pending', !!pending);
      }
    }

    function normalizeUserScriptletResourceName(name) {
      const cleaned = String(name || '').trim().toLowerCase();
      return cleaned.endsWith('.js') ? cleaned.slice(0, -3) : cleaned;
    }

    function extractUserScriptletRuleNames(ruleText) {
      const counts = new Map();
      const lines = String(ruleText || '').replace(/\r\n?/g, '\n').split('\n');
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('!') || line.startsWith('#') || line.startsWith('[') || line.startsWith('//')) continue;
        const match = line.match(/##\+js\(\s*([^,\s)]+)/);
        const name = normalizeUserScriptletResourceName(match?.[1]?.replace(/^['"]|['"]$/g, ''));
        if (name) counts.set(name, (counts.get(name) || 0) + 1);
      }
      return counts;
    }

    function getUserScriptletLinkState(names, ruleText) {
      const ruleCounts = extractUserScriptletRuleNames(ruleText);
      const resources = Array.isArray(names)
        ? names.map(name => String(name || '').trim()).filter(Boolean)
        : [];
      const resourceKeys = new Set(resources.map(normalizeUserScriptletResourceName));
      const missing = [];
      for (const [name, ruleCount] of ruleCounts) {
        if (!resourceKeys.has(name)) missing.push({ name, ruleCount });
      }
      return {
        resources: resources.map(name => ({
          name,
          ruleCount: ruleCounts.get(normalizeUserScriptletResourceName(name)) || 0
        })),
        missing
      };
    }

    function formatLinkedResourceStatus(settings, linkState) {
      const savedRules = Number(settings?.parsedRuleCount || 0);
      const linkedResources = linkState.resources.filter(resource => resource.ruleCount > 0).length;
      const missingResources = linkState.missing.length;
      const parts = [`${savedRules.toLocaleString()} saved rule(s)`];
      if (linkedResources > 0) parts.push(`${linkedResources.toLocaleString()} linked resource(s)`);
      if (missingResources > 0) parts.push(`${missingResources.toLocaleString()} missing resource(s)`);
      return `${parts.join(' \u00b7 ')}.`;
    }

    function renderUserScriptletResourceChips(names, linkState) {
      const wrap = $('userScriptletAvailableResources');
      const list = $('userScriptletAvailableResourceList');
      if (!wrap || !list) return;
      clearElement(list);
      const resources = linkState?.resources || getUserScriptletLinkState(names, '').resources;
      const missing = linkState?.missing || [];
      list.classList.remove('is-loading');
      resources.slice(0, 30).forEach(resource => {
        const linked = resource.ruleCount > 0;
        const chip = appendElement(
          list,
          'span',
          `user-scriptlet-chip${linked ? ' user-scriptlet-chip--linked' : ''}`
        );
        appendElement(chip, 'span', 'user-scriptlet-chip__name', resource.name);
        appendElement(chip, 'span', 'user-scriptlet-chip__status', linked ? 'Linked' : 'Unused');
      });
      missing.slice(0, 10).forEach(resource => {
        const chip = appendElement(list, 'span', 'user-scriptlet-chip user-scriptlet-chip--missing');
        appendElement(chip, 'span', 'user-scriptlet-chip__name', resource.name);
        appendElement(chip, 'span', 'user-scriptlet-chip__status', 'Missing');
      });
      if (resources.length === 0 && missing.length === 0) {
        appendElement(list, 'span', 'user-scriptlet-chip user-scriptlet-chip--muted', 'No parsed resources');
      }
      if (resources.length > 30) {
        appendElement(list, 'span', 'user-scriptlet-chip user-scriptlet-chip--muted', `+${resources.length - 30}`);
      }
      if (missing.length > 10) {
        appendElement(list, 'span', 'user-scriptlet-chip user-scriptlet-chip--muted', `+${missing.length - 10} missing`);
      }
    }

    async function loadUserScriptletUI() {
      if (!settingsMode) return;
      const list = $('userScriptletSourceList');
      const textarea = $('userScriptletRulesText');
      if (!list) return;
      setSectionLoading('userScriptletPanel');
      setSectionLoading('userScriptletSourceList');
      setUserScriptletRulesPending(true);
      setUserScriptletRulesStatus('Loading rules...');

      let settings = null;
      try {
        settings = await notifyBackground({ type: MSG.USER_SCRIPTLETS_GET });
      } catch (error) {
        console.error('Chroma user scriptlets failed to load:', error);
      }

      if (!settings) {
        setSectionError('userScriptletSourceList', 'User scriptlets unavailable.');
        setUserScriptletRulesStatus('User scriptlets unavailable.', true);
        setSectionReady('userScriptletPanel');
        return;
      }

      const sources = Array.isArray(settings.sources) ? settings.sources : [];
      clearElement(list);

      const summary = document.createElement('div');
      summary.className = 'subscription-summary';
      summary.textContent = `${sources.length.toLocaleString()} resource URL(s) \u00b7 ${Number(settings.availableResourceNames?.length || 0).toLocaleString()} resource(s) \u00b7 ${Number(settings.parsedRuleCount || 0).toLocaleString()} rule(s)`;
      list.appendChild(summary);

      if (sources.length === 0) {
        appendLoadingRow(list, 'No user scriptlet resources added.');
      } else {
        for (const source of sources) {
          const row = document.createElement('div');
          row.className = 'toggle-row user-scriptlet-source-row';
          const info = appendElement(row, 'div', 'toggle-info');
          appendElement(info, 'div', 'name', source.name || 'User scriptlet resource');
          const urlLine = appendElement(info, 'div', 'desc user-scriptlet-source-url', source.url || '');
          urlLine.title = source.url || '';
          appendElement(info, 'div', 'desc', `Updated: ${formatUserScriptletSourceUpdated(source)}`);
          const names = Array.isArray(source.resourceNames) ? source.resourceNames.filter(Boolean) : [];
          if (names.length > 0) {
            const shown = names.slice(0, 8).join(', ');
            appendElement(info, 'div', 'desc user-scriptlet-resource-names', `${source.resourceCount || names.length} resource(s): ${shown}${names.length > 8 ? '...' : ''}`);
          } else {
            appendElement(info, 'div', 'desc user-scriptlet-resource-names', 'No parsed resources yet.');
          }
          if (source.lastError) {
            const error = appendElement(info, 'div', 'subscription-error', `Error: ${source.lastError}`);
            error.title = source.lastError;
          }

          const actions = appendElement(row, 'div', 'subscription-actions');
          const refreshBtn = appendElement(actions, 'button', 'user-scriptlet-refresh-btn reset-btn compact-action-btn', 'Refresh');
          refreshBtn.dataset.id = source.id;
          refreshBtn.title = 'Refresh resource';
          refreshBtn.setAttribute('aria-label', `Refresh ${source.name || 'user scriptlet resource'}`);
          const deleteBtn = appendElement(actions, 'button', 'user-scriptlet-delete-btn reset-btn inline-danger-btn compact-action-btn', 'Remove');
          deleteBtn.dataset.id = source.id;
          deleteBtn.title = 'Remove resource';
          deleteBtn.setAttribute('aria-label', `Remove ${source.name || 'user scriptlet resource'}`);
          list.appendChild(row);
        }
      }

      if (textarea && document.activeElement !== textarea) {
        textarea.value = typeof settings.ruleText === 'string' ? settings.ruleText : '';
      }
      const linkState = getUserScriptletLinkState(settings.availableResourceNames, settings.ruleText);
      renderUserScriptletResourceChips(settings.availableResourceNames, linkState);
      setUserScriptletRulesStatus(formatLinkedResourceStatus(settings, linkState), linkState.missing.length > 0);
      setUserScriptletRulesPending(false);
      setSectionReady('userScriptletSourceList');
      setSectionReady('userScriptletPanel');

      list.querySelectorAll('.user-scriptlet-refresh-btn').forEach(btn => {
        btn.addEventListener('click', async (event) => {
          const target = event.target;
          target.disabled = true;
          target.textContent = '...';
          const result = await sendMutation({ type: MSG.USER_SCRIPTLET_SOURCE_REFRESH, id: target.dataset.id });
          target.textContent = result?.ok ? 'Done' : 'Failed';
          setTimeout(() => {
            loadUserScriptletUI();
            loadHealthPanel();
          }, 800);
        });
      });

      list.querySelectorAll('.user-scriptlet-delete-btn').forEach(btn => {
        btn.addEventListener('click', async (event) => {
          if (!confirm('Remove this user scriptlet resource?')) return;
          const target = event.target;
          target.disabled = true;
          const result = await sendMutation({ type: MSG.USER_SCRIPTLET_SOURCE_REMOVE, id: target.dataset.id });
          if (result) {
            await loadUserScriptletUI();
            await loadHealthPanel();
          } else {
            target.disabled = false;
            target.title = 'Remove failed';
          }
        });
      });
    }

    function wireUserScriptletControls() {
      if (!settingsMode) return;
      const addBtn = $('addUserScriptletSourceBtn');
      const form = $('addUserScriptletSourceForm');
      const nameInput = $('newUserScriptletSourceName');
      const urlInput = $('newUserScriptletSourceUrl');
      const errEl = $('newUserScriptletSourceError');
      const submitBtn = $('newUserScriptletSourceAddBtn');
      const cancelBtn = $('newUserScriptletSourceCancelBtn');
      const saveRulesBtn = $('saveUserScriptletRulesBtn');
      const rulesText = $('userScriptletRulesText');
      if (!addBtn || !form) return;

      const showError = (message) => {
        if (!errEl) return;
        errEl.textContent = message;
        errEl.classList.remove('is-hidden');
      };
      const closeForm = () => {
        form.classList.add('is-hidden');
        if (nameInput) nameInput.value = '';
        if (urlInput) urlInput.value = '';
        if (errEl) {
          errEl.classList.add('is-hidden');
          errEl.textContent = '';
        }
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Add';
        }
      };

      addBtn.addEventListener('click', () => {
        if (form.classList.contains('is-hidden')) {
          form.classList.remove('is-hidden');
          urlInput?.focus?.();
        } else {
          closeForm();
        }
      });
      cancelBtn?.addEventListener('click', closeForm);

      const submitAdd = async () => {
        if (errEl) errEl.classList.add('is-hidden');
        const url = urlInput?.value.trim() || '';
        if (!url) return showError('URL required.');
        let parsed;
        try { parsed = new URL(url); } catch { return showError('Invalid URL.'); }
        if (parsed.protocol !== 'https:') return showError('Only https:// URLs are allowed.');

        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Adding...';
        }
        let result = null;
        try {
          result = await notifyBackground({
            type: MSG.USER_SCRIPTLET_SOURCE_ADD,
            source: {
              name: nameInput?.value.trim() || '',
              url
            }
          });
        } catch (error) {
          console.error('Chroma user scriptlet source add failed:', error);
        }
        if (!result?.ok) {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Add';
          }
          return showError(result?.error || 'Add failed.');
        }
        closeForm();
        await loadUserScriptletUI();
        await loadHealthPanel();
      };

      submitBtn?.addEventListener('click', submitAdd);
      urlInput?.addEventListener('keypress', (event) => { if (event.key === 'Enter') submitAdd(); });
      nameInput?.addEventListener('keypress', (event) => { if (event.key === 'Enter') submitAdd(); });

      saveRulesBtn?.addEventListener('click', async () => {
        if (!rulesText) return;
        saveRulesBtn.disabled = true;
        saveRulesBtn.textContent = 'Saving...';
        setUserScriptletRulesStatus('Saving rules...');
        let result = null;
        try {
          result = await notifyBackground({
            type: MSG.USER_SCRIPTLET_RULES_SET,
            ruleText: rulesText.value
          });
        } catch (error) {
          console.error('Chroma user scriptlet rules save failed:', error);
        }
        if (result?.ok) {
          setUserScriptletRulesStatus(`${Number(result.parsedRuleCount || 0).toLocaleString()} saved rule(s).`);
          await loadUserScriptletUI();
          await loadHealthPanel();
        } else {
          setUserScriptletRulesStatus(result?.error || 'Rules save failed.', true);
        }
        saveRulesBtn.disabled = false;
        saveRulesBtn.textContent = 'Save Rules';
      });
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

      clearElement(list);
      if (rules.length === 0) {
        appendLoadingRow(list, 'No local zapper rules saved.');
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
          toggleInput.setAttribute('aria-label', `${rule.enabled ? 'Disable' : 'Enable'} zapper rule for ${domain}`);
          appendElement(toggleLabel, 'span', 'slider');

          const deleteBtn = appendElement(actions, 'button', 'reset-btn zapper-rule-delete inline-danger-btn compact-action-btn', 'Delete');
          deleteBtn.dataset.id = rule.id;
          deleteBtn.title = 'Delete rule';
          deleteBtn.setAttribute('aria-label', `Delete zapper rule for ${domain}`);
          list.appendChild(row);
        }
      }

      setSectionReady('localZapperRules');
      list.querySelectorAll('.zapper-rule-toggle').forEach(input => {
        input.addEventListener('change', async (event) => {
          const previous = !event.target.checked;
          event.target.disabled = true;
          event.target.classList.add('control-pending');
          const result = await sendMutation({
            type: MSG.ZAPPER_RULE_SET,
            id: event.target.dataset.id,
            enabled: event.target.checked
          });
          if (!result) event.target.checked = previous;
          event.target.disabled = false;
          event.target.classList.remove('control-pending');
        });
      });
      list.querySelectorAll('.zapper-rule-delete').forEach(button => {
        button.addEventListener('click', async (event) => {
          event.target.disabled = true;
          const result = await sendMutation({ type: MSG.ZAPPER_RULE_REMOVE, id: event.target.dataset.id });
          if (result) {
            await loadLocalZapperRulesUI();
          } else {
            event.target.disabled = false;
            event.target.title = 'Delete failed';
          }
        });
      });
    }

    function wireRequestLog() {
      const toggleRow = $('logToggleRow');
      const toggleBtn = $('logToggleBtn');
      const freezeBtn = $('logFreezeBtn');
      const entries = $('logEntries');
      if (!toggleRow || !entries) return;
      toggleRow.setAttribute('role', 'button');
      toggleRow.setAttribute('tabindex', '0');
      toggleRow.setAttribute('aria-expanded', 'false');
      toggleRow.setAttribute('aria-controls', 'logEntries');

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
      let isFrozen = false;
      async function renderLog() {
        if (isFrozen) return;
        const log = await notifyBackground({ type: MSG.LOG_GET }) || [];
        clearElement(entries);
        if (log.length === 0) {
          appendElement(entries, 'div', 'log-empty', 'No entries yet.');
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

      async function toggleRequestLog() {
        isOpen = !isOpen;
        toggleRow.setAttribute('aria-expanded', String(isOpen));
        if (toggleBtn) toggleBtn.setAttribute('aria-label', isOpen ? 'Collapse request log' : 'Expand request log');
        toggleBtn?.classList.toggle('open', isOpen);
        entries.classList.toggle('visible', isOpen);
        if (isOpen) await renderLog();
      }

      freezeBtn?.addEventListener('click', async (event) => {
        event.stopPropagation();
        isFrozen = !isFrozen;
        freezeBtn.classList.toggle('is-active', isFrozen);
        freezeBtn.textContent = isFrozen ? 'Frozen' : 'Freeze';
        freezeBtn.setAttribute('aria-label', isFrozen ? 'Unfreeze request log' : 'Freeze request log');
        if (!isFrozen && isOpen) await renderLog();
      });
      addKeyboardActivation(toggleRow, toggleRequestLog);
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
    openUpdatesSettings,
    initSharedUI,
    scrollToProxyHash
  };
})();

globalThis.ChromaApp = ChromaApp;
globalThis.openProxySettings = ChromaApp.openProxySettings;
globalThis.openUpdatesSettings = ChromaApp.openUpdatesSettings;
