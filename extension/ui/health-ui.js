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

    return { loadHealthPanel };
  }

  return { createController };
})();

globalThis.ChromaHealthUI = ChromaHealthUI;
