/**
 * Settings health panel rendering and refresh behavior.
 */

'use strict';

const ChromaHealthUI = (() => {
  const HEALTH_STATUS_CLASSES = new Set(['healthy', 'degraded', 'disabled', 'error']);
  const HEALTH_ISSUE_CLASSES = new Set(['info', 'warning', 'error']);

  function normalizeHealthStatus(value) {
    const status = String(value || '').toLowerCase();
    return HEALTH_STATUS_CLASSES.has(status) ? status : 'error';
  }

  function normalizeHealthIssueSeverity(value) {
    const severity = String(value || '').toLowerCase();
    return HEALTH_ISSUE_CLASSES.has(severity) ? severity : 'info';
  }

  function createController({
    $,
    appendElement,
    formatCount,
    formatStatusLabel,
    setSectionLoading,
    setSectionReady,
    notifyBackground,
    MSG,
    isSettingsPage
  }) {
    let healthLoadSerial = 0;

    function clearElement(element) {
      if (!element) return;
      if (globalThis.ChromaDom?.clearElement) {
        globalThis.ChromaDom.clearElement(element);
      } else {
        element.textContent = '';
      }
    }

    function toCount(value) {
      const count = Number(value);
      return Number.isFinite(count) && count > 0 ? count : 0;
    }

    function addHealthMetric(parent, label, value, state = '') {
      const row = appendElement(parent, 'div', 'health-metric');
      appendElement(row, 'span', 'health-metric__label', label);
      appendElement(row, 'span', state ? `health-metric__value health-metric__value--${state}` : 'health-metric__value', value);
      return row;
    }

    function addHealthSummaryChip(parent, label, value, state = 'disabled') {
      const chip = appendElement(parent, 'div', `health-summary-chip health-summary-chip--${state}`);
      appendElement(chip, 'span', 'health-summary-chip__label', label);
      appendElement(chip, 'span', 'health-summary-chip__value', value);
      return chip;
    }

    function setHealthSummaryLoading() {
      const summary = $('healthSummary');
      if (!summary) return;
      summary.className = 'health-summary is-loading';
      clearElement(summary);
      appendElement(summary, 'span', 'health-summary-chip health-summary-chip--loading', 'Loading health...');
    }

    function renderHealthSummary(health, networkBlockingActive = false) {
      const summary = $('healthSummary');
      if (!summary) return;
      summary.className = 'health-summary';
      clearElement(summary);

      if (!health) {
        addHealthSummaryChip(summary, 'Health', 'Unavailable', 'error');
        return;
      }

      const subscriptionsTotal = toCount(health.subscriptions?.total);
      const subscriptionsEnabled = toCount(health.subscriptions?.enabled);
      const subscriptionErrors = toCount(health.subscriptions?.withErrors);
      const masterEnabled = health.master?.enabled !== false;
      addHealthSummaryChip(
        summary,
        'Core',
        networkBlockingActive ? 'Active' : 'Off',
        networkBlockingActive ? 'ok' : 'disabled'
      );
      addHealthSummaryChip(
        summary,
        'Lists',
        subscriptionsTotal
          ? (masterEnabled
              ? `${formatCount(subscriptionsEnabled)} / ${formatCount(subscriptionsTotal)}`
              : `${formatCount(subscriptionsEnabled)} / ${formatCount(subscriptionsTotal)} paused`)
          : 'None',
        subscriptionErrors ? 'warning' : (subscriptionsTotal && masterEnabled ? 'ok' : 'disabled')
      );

      const scriptlets = health.scriptlets || {};
      const storedScriptlets = toCount(scriptlets.storedRuleCount);
      const registeredScriptlets = toCount(scriptlets.registeredUserScriptCount);
      let scriptletValue = `${formatCount(registeredScriptlets)} active`;
      let scriptletState = 'ok';
      if (!masterEnabled) {
        scriptletValue = storedScriptlets ? 'Paused' : 'Off';
        scriptletState = 'disabled';
      } else if (scriptlets.apiAvailable === false) {
        scriptletValue = storedScriptlets ? 'Needs API' : 'Unavailable';
        scriptletState = storedScriptlets ? 'warning' : 'disabled';
      } else if (storedScriptlets && registeredScriptlets === 0) {
        scriptletValue = 'Check setup';
        scriptletState = 'warning';
      }
      addHealthSummaryChip(summary, 'Scriptlets', scriptletValue, scriptletState);

      const proxy = health.proxy || {};
      let proxyValue = 'Off';
      let proxyState = 'disabled';
      const proxyRequested = proxy.requestedRouting === true ||
        (proxy.globalProxyEnabled && proxy.globalProxyRouteEnabled) ||
        toCount(proxy.routedDomainCount) > 0;
      if (proxy.error || (!masterEnabled && proxy.effectiveRouting === true)) {
        proxyValue = 'Release incomplete';
        proxyState = 'warning';
      } else if (!masterEnabled && proxyRequested) {
        proxyValue = 'Paused';
        proxyState = 'disabled';
      } else if (proxyRequested) {
        if (proxy.effectiveRouting === true) {
          proxyValue = proxy.effectiveGlobalProxy ? 'Global' : `${formatCount(proxy.routedDomainCount)} routed`;
          proxyState = 'ok';
        } else {
          proxyValue = proxy.conflict ? 'Controlled elsewhere' : 'Not active';
          proxyState = 'warning';
        }
      } else if (proxy.globalProxyEnabled && proxy.globalProxyConfigured && !proxy.globalProxyRouteEnabled) {
        proxyValue = 'Paused';
      } else if (proxy.globalProxyEnabled && !proxy.globalProxyConfigured) {
        proxyValue = 'Check setup';
        proxyState = 'warning';
      } else if (toCount(proxy.acceptedCount)) {
        proxyValue = `${formatCount(proxy.acceptedCount)} ready`;
        proxyState = 'ok';
      }
      addHealthSummaryChip(summary, 'Proxy', proxyValue, proxyState);

      const browserPrivacy = health.browserPrivacy || {};
      addHealthSummaryChip(
        summary,
        'Privacy',
        browserPrivacy.enabled
          ? (browserPrivacy.active ? 'Hardened' : `${formatCount(browserPrivacy.hardenedCount)} / ${formatCount(browserPrivacy.totalCount)}`)
          : 'Off',
        browserPrivacy.enabled ? (browserPrivacy.active ? 'ok' : 'warning') : 'disabled'
      );

      const issues = Array.isArray(health.overall?.issues) ? health.overall.issues : [];
      const hasErrors = issues.some(issue => normalizeHealthIssueSeverity(issue.severity) === 'error');
      const hasWarnings = issues.some(issue => normalizeHealthIssueSeverity(issue.severity) === 'warning');
      addHealthSummaryChip(
        summary,
        'Issues',
        issues.length ? `${formatCount(issues.length)} issue${issues.length === 1 ? '' : 's'}` : 'Clear',
        hasErrors ? 'error' : (hasWarnings ? 'warning' : 'ok')
      );
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
      const mode = String(webrtc.requestedMode || webrtc.mode || 'auto');
      const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
      if (!webrtc.enabled && webrtc.controlledByThisExtension) {
        return ['WebRTC leak protection', 'Release incomplete', 'warning'];
      }
      if (webrtc.requested && !webrtc.enabled) {
        return ['WebRTC leak protection', `${modeLabel} (Paused)`, 'disabled'];
      }
      if (!webrtc.enabled) {
        return ['WebRTC leak protection', mode === 'off' ? 'Off' : `${modeLabel} (Off)`, 'disabled'];
      }
      if (!webrtc.available) {
        return ['WebRTC leak protection', `${modeLabel} (Unavailable)`, 'warning'];
      }
      if (!webrtc.controlledByThisExtension || webrtc.error) {
        const controlLabel = webrtc.levelOfControl && webrtc.controllable === false
          ? 'Controlled elsewhere'
          : 'Not applied';
        return ['WebRTC leak protection', `${modeLabel} (${controlLabel})`, 'warning'];
      }
      if (webrtc.effective && webrtc.protected) {
        return ['WebRTC leak protection', mode === 'strict' ? 'Strict' : `${modeLabel} (Strict)`, 'ok'];
      }
      if (webrtc.effective && webrtc.partial) {
        return ['WebRTC leak protection', mode === 'balanced' ? 'Balanced' : `${modeLabel} (Partial)`, 'ok'];
      }
      return ['WebRTC leak protection', `${modeLabel} (Not active)`, 'warning'];
    }

    function getBrowserPrivacySetting(health, key) {
      const settings = Array.isArray(health.browserPrivacy?.settings)
        ? health.browserPrivacy.settings
        : [];
      return settings.find(setting => setting?.key === key) || null;
    }

    function isBrowserPrivacySettingExternallyControlled(setting) {
      return !!setting?.levelOfControl && setting.controllable === false;
    }

    function getBrowserPrivacySettingLabel(health, key) {
      const setting = getBrowserPrivacySetting(health, key);
      if (!health.browserPrivacy?.requested) return 'Disabled';
      if (!health.browserPrivacy?.enabled && setting?.controlledByThisExtension) return 'Release incomplete';
      if (!health.browserPrivacy?.enabled) return 'Paused';
      if (!setting?.available) return 'Unavailable';
      if (isBrowserPrivacySettingExternallyControlled(setting)) return 'Controlled elsewhere';
      if (!setting.controlledByThisExtension || setting.error) return 'Not applied';
      return setting.effective ? 'Hardened' : 'Not hardened';
    }

    function getBrowserPrivacySettingStatus(health, key) {
      const setting = getBrowserPrivacySetting(health, key);
      if (!health.browserPrivacy?.enabled && setting?.controlledByThisExtension) return 'warning';
      if (!health.browserPrivacy?.requested || !health.browserPrivacy?.enabled) return 'disabled';
      if (!setting?.available) return 'warning';
      return setting.controlledByThisExtension && setting.effective ? 'ok' : 'warning';
    }

    function getPrivacySandboxSettings(health) {
      return ['adMeasurementEnabled', 'topicsEnabled', 'fledgeEnabled']
        .map(key => getBrowserPrivacySetting(health, key))
        .filter(Boolean);
    }

    function getPrivacySandboxLabel(health) {
      if (!health.browserPrivacy?.requested) return 'Disabled';
      if (!health.browserPrivacy?.enabled) return 'Paused';
      const settings = getPrivacySandboxSettings(health);
      if (settings.length === 0) return 'Unavailable';
      if (settings.some(isBrowserPrivacySettingExternallyControlled)) return 'Controlled elsewhere';
      if (settings.some(setting => !setting.controlledByThisExtension || setting.error)) return 'Not applied';
      const hardened = settings.filter(setting => setting.effective).length;
      return hardened === settings.length ? 'Hardened' : `${formatCount(hardened)} / ${formatCount(settings.length)} hardened`;
    }

    function getPrivacySandboxStatus(health) {
      if (!health.browserPrivacy?.requested || !health.browserPrivacy?.enabled) return 'disabled';
      const settings = getPrivacySandboxSettings(health);
      if (settings.length === 0) return 'warning';
      return settings.every(setting => setting.controlledByThisExtension && setting.effective) ? 'ok' : 'warning';
    }

    function getGeolocationProtectionLabel(health) {
      const geo = health.geolocation || {};
      if (!geo.enabled && geo.reconciliationError) return 'Release incomplete';
      if (!geo.requested) return 'Disabled';
      if (!geo.enabled) return 'Paused';
      if (!geo.available) return 'Unavailable';
      return geo.effective ? 'Blocked' : 'Not blocked';
    }

    function getGeolocationProtectionStatus(health) {
      const geo = health.geolocation || {};
      if (!geo.enabled && geo.reconciliationError) return 'warning';
      if (!geo.requested || !geo.enabled) return 'disabled';
      if (!geo.available) return 'warning';
      return geo.effective ? 'ok' : 'warning';
    }

    function getEffectiveProxyRoutingLabel(health) {
      const proxy = health.proxy || {};
      if (health.master?.enabled === false) {
        if (proxy.error || proxy.effectiveRouting) return 'Release incomplete';
        return proxy.requestedRouting ? 'Paused' : 'Off';
      }
      if (proxy.effectiveRouting) return 'Active';
      return proxy.requestedRouting ? 'Inactive' : 'Off';
    }

    function getEffectiveProxyRoutingStatus(health) {
      const proxy = health.proxy || {};
      if (health.master?.enabled === false) {
        return proxy.error || proxy.effectiveRouting ? 'warning' : 'disabled';
      }
      if (proxy.effectiveRouting) return 'ok';
      return proxy.requestedRouting || proxy.error ? 'warning' : 'disabled';
    }

    function getGlobalProxyLabel(health) {
      const proxy = health.proxy || {};
      if (!proxy.globalProxyEnabled) return 'Disabled';
      if (!proxy.globalProxyConfigured) return 'Misconfigured';
      if (health.master?.enabled === false) return 'Paused';
      return proxy.globalProxyRouteEnabled ? 'Requested' : 'Paused';
    }

    function getGlobalProxyStatus(health) {
      const proxy = health.proxy || {};
      if (!proxy.globalProxyEnabled) return 'disabled';
      if (!proxy.globalProxyConfigured) return 'warning';
      if (health.master?.enabled === false) return 'disabled';
      return proxy.globalProxyRouteEnabled ? '' : 'disabled';
    }

    function getBrowserPrivacyHardeningLabel(health) {
      const privacy = health.browserPrivacy || {};
      if (!privacy.requested) return 'Disabled';
      if (!privacy.enabled) return privacy.controlledCount > 0 ? 'Release incomplete' : 'Paused';
      if (privacy.controlled && privacy.effective) return 'Active';
      return privacy.blockedCount > 0 ? 'Controlled elsewhere' : 'Not fully applied';
    }

    function getBrowserPrivacyHardeningStatus(health) {
      const privacy = health.browserPrivacy || {};
      if (!privacy.enabled) return privacy.controlledCount > 0 ? 'warning' : 'disabled';
      return privacy.controlled && privacy.effective ? 'ok' : 'warning';
    }

    function getFprProtectedSurfaceLabel(health) {
      const surfaces = Array.isArray(health.fpr?.protectedSurfaces)
        ? health.fpr.protectedSurfaces
        : [];
      return surfaces.length ? surfaces.join(', ') : 'Unknown';
    }

    function getRegisteredScriptletLabel(health) {
      const scriptlets = health.scriptlets || {};
      if (health.master?.enabled === false && scriptlets.storedRuleCount > 0) return 'Paused';
      if (scriptlets.apiAvailable === false) return 'Unavailable';
      return scriptlets.registeredUserScriptCount === null
        ? 'Unknown'
        : formatCount(scriptlets.registeredUserScriptCount);
    }

    function getRegisteredScriptletStatus(health) {
      const scriptlets = health.scriptlets || {};
      if (health.master?.enabled === false) return 'disabled';
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
      setHealthSummaryLoading();
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
      clearElement(body);

      if (!health) {
        if (overallLabel) {
          overallLabel.className = 'health-status health-status--error';
          overallLabel.textContent = 'Unavailable';
        }
        if (versionText) versionText.textContent = 'Health endpoint did not respond.';
        renderHealthSummary(null);
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
      renderHealthSummary(health, networkBlockingActive);

      addHealthSection(body, 'Core', [
        ['Network blocking', networkBlockingActive ? 'Active' : 'Disabled', networkBlockingActive ? 'ok' : 'disabled'],
        [
          'Tracking URL cleanup',
          getTrackingUrlCleanupLabel(health, networkBlockingActive),
          getTrackingUrlCleanupStatus(health, networkBlockingActive)
        ],
        ['De-AMP links', deAmpLinksActive ? 'Active' : 'Disabled', deAmpLinksActive ? 'ok' : 'disabled'],
        [
          'Static rulesets',
          `${formatCount(health.dnr?.enabledStaticRulesets?.length)} / ${formatCount(health.dnr?.expectedStaticRulesets?.length)} enabled`,
          health.dnr?.staticRulesetsOk ? 'ok' : (networkBlockingActive ? 'error' : 'disabled')
        ],
        ['Dynamic rules', `${formatCount(health.dnr?.appliedNetworkRuleCount)} active`, ''],
        ['Whitelist rules', formatCount(health.dnr?.whitelistRuleCount), '']
      ]);

      addHealthSection(body, 'Subscriptions', [
        [
          'Requested lists',
          `${formatCount(health.subscriptions?.enabled)} / ${formatCount(health.subscriptions?.total)}` +
            (health.master?.enabled === false && health.subscriptions?.enabled ? ' (Paused)' : ''),
          health.subscriptions?.withErrors
            ? 'warning'
            : (health.master?.enabled === false ? 'disabled' : 'ok')
        ],
        ['Applied network rules', formatCount(health.subscriptions?.appliedNetwork), ''],
        ['Stored cosmetic rules', formatCount(health.subscriptions?.cosmetic), ''],
        ['Stored scriptlet rules', formatCount(health.subscriptions?.scriptlet), ''],
        ['Errors', health.subscriptions?.withErrors ? formatCount(health.subscriptions.withErrors) : 'None', health.subscriptions?.withErrors ? 'warning' : 'ok']
      ]);

      addHealthSection(body, 'Scriptlets', [
        [
          'UserScripts API',
          health.scriptlets?.apiAvailable ? 'Available' : 'Unavailable',
          health.scriptlets?.apiAvailable
            ? 'ok'
            : (health.scriptlets?.storedRuleCount > 0 ? 'warning' : 'disabled')
        ],
        ['Registered scripts', getRegisteredScriptletLabel(health), getRegisteredScriptletStatus(health)],
        ['Stored scriptlet rules', formatCount(health.scriptlets?.storedRuleCount), ''],
        ['User resource rules', formatCount(health.scriptlets?.userStoredRuleCount), ''],
        ['User resources', formatCount(health.scriptlets?.userResourceCount), health.scriptlets?.userResourceErrorCount ? 'warning' : '']
      ]);

      addHealthSection(body, 'Fingerprint', [
        [
          'Fingerprint Randomization',
          health.fpr?.enabled ? (health.fpr?.active ? 'Active' : 'Not registered') : 'Disabled',
          health.fpr?.enabled ? (health.fpr?.active ? 'ok' : 'warning') : 'disabled'
        ],
        [
          'Protected surfaces',
          health.fpr?.enabled ? getFprProtectedSurfaceLabel(health) : 'Disabled',
          health.fpr?.enabled ? (health.fpr?.active ? 'ok' : 'warning') : 'disabled'
        ],
        ['FPR whitelist', `${formatCount(health.whitelist?.fprDomainCount)} domain(s)`, '']
      ]);

      addHealthSection(body, 'Cosmetic & Local', [
        ['Stored subscription cosmetic rules', formatCount(health.cosmetic?.subscriptionCosmeticRuleCount), ''],
        ['Local zapper rules', `${formatCount(health.cosmetic?.enabledLocalZapperRuleCount)} / ${formatCount(health.cosmetic?.localZapperRuleCount)}`, '']
      ]);

      addHealthSection(body, 'Proxy', [
        ['Configured proxies', formatCount(health.proxy?.configuredCount), ''],
        ['Accepted proxies', formatCount(health.proxy?.acceptedCount), ''],
        ['Requested domains', formatCount(health.proxy?.routedDomainCount), ''],
        [
          'Requested routing',
          health.proxy?.requestedRouting
            ? (health.master?.enabled === false ? 'Paused' : 'Enabled')
            : 'Disabled',
          health.proxy?.requestedRouting && health.master?.enabled !== false ? 'ok' : 'disabled'
        ],
        ['Effective routing', getEffectiveProxyRoutingLabel(health), getEffectiveProxyRoutingStatus(health)],
        ['Proxy control', health.proxy?.levelOfControl || 'Unavailable', (health.proxy?.conflict || health.proxy?.error) ? 'warning' : ''],
        ['Global proxy', getGlobalProxyLabel(health), getGlobalProxyStatus(health)],
        getWebRtcHealthMetric(health)
      ]);

      addHealthSection(body, 'Browser Privacy', [
        [
          'Chrome Privacy Hardening',
          getBrowserPrivacyHardeningLabel(health),
          getBrowserPrivacyHardeningStatus(health)
        ],
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

    return { loadHealthPanel };
  }

  return { createController };
})();

globalThis.ChromaHealthUI = ChromaHealthUI;
