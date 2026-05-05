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
  const PROXY_SETTINGS_PATH = 'ui/settings.html#proxy';

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

  async function initSharedUI() {
    globalThis.ChromaComponents?.renderPageShell({ settingsMode: isSettingsPage() });

    const manifest = chrome.runtime.getManifest();
    if ($('versionText')) {
      $('versionText').textContent = `v${manifest.version} \u00b7 MV3`;
    }

    // Update check - runs async, inserts banner if update available
    notifyBackground({ type: MSG.UPDATE_CHECK }).then(result => {
      if (!result || !result.updateAvailable) return;
      const latestVersion = result.latestVersion;

      const banner = document.createElement('div');
      banner.id = 'updateBanner';
      banner.className = 'update-banner';

      const updateLink = document.createElement('a');
      updateLink.href = RELEASES_PAGE;
      updateLink.target = '_blank';
      updateLink.className = 'update-banner__link';
      updateLink.textContent = `\u2191 v${latestVersion} available`;

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

      // Insert before the Protection Layers section title
      const sectionTitle = document.querySelector('.section-title');
      if (sectionTitle) sectionTitle.before(banner);

      document.getElementById('dismissUpdate')?.addEventListener('click', () => {
        banner.remove();
      });
    });

    const TOGGLES = [
      ['toggleNetwork',      'networkBlocking',          true],
      ['toggleStripping',    'stripping',                true],
      ['toggleAcceleration', 'acceleration',             false],
      ['toggleCosmetic',     'cosmetic',                 true],
      ['toggleShorts',       'hideShorts',               false],
      ['toggleMerch',        'hideMerch',                true],
      ['toggleOffers',       'hideOffers',               true],
      ['toggleWarnings',     'suppressWarnings',         true],
      ['toggleFingerprintRandomization', 'fingerprintRandomization', false],
    ];

    const syncUI = (cfg, masterOn) => {
      for (const [elId, key, def] of TOGGLES) {
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

    const config = await notifyBackground({ type: MSG.CONFIG_GET }) || {};
    const isEnabled = config.enabled !== false;
    
    if ($('toggleEnabled')) {
      $('toggleEnabled').checked = isEnabled;
      updateStatusDot(isEnabled);
    }
    
    syncUI(config, isEnabled);

    const currentSpeed = config.accelerationSpeed ?? 8;
    syncSpeedUI(currentSpeed, isEnabled && (config.acceleration !== false));

    document.querySelectorAll('.speed-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const speed = parseInt(btn.dataset.speed);
        syncSpeedUI(speed, $('toggleAcceleration').checked);
        await notifyBackground({ type: MSG.CONFIG_SET, config: { accelerationSpeed: speed } });
      });
    });

    const { stats = { networkBlocked: 0 } } = await chrome.storage.local.get('stats');
    if ($('statNetworkBlocked')) $('statNetworkBlocked').textContent = stats.networkBlocked ?? 0;

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.stats) {
        const newStats = changes.stats.newValue || { networkBlocked: 0 };
        if ($('statNetworkBlocked')) $('statNetworkBlocked').textContent = newStats.networkBlocked ?? 0;
      }
    });

    for (const [elId, key] of TOGGLES) {
      if ($(elId)) {
        $(elId).addEventListener('change', async (e) => {
          const isChecked = e.target.checked;
          await notifyBackground({ type: MSG.CONFIG_SET, config: { [key]: isChecked } });
          
          if (isChecked && !$('toggleEnabled').checked) {
            $('toggleEnabled').checked = true;
            updateStatusDot(true);
            await notifyBackground({ type: MSG.CONFIG_SET, config: { enabled: true } });
          } else if (!isChecked) {
            const anyOn = TOGGLES.some(([id]) => $(id).checked);
            if (!anyOn) {
              $('toggleEnabled').checked = false;
              updateStatusDot(false);
              await notifyBackground({ type: MSG.CONFIG_SET, config: { enabled: false } });
            }
          }
        });
      }
    }

    $('toggleAcceleration').addEventListener('change', (e) => {
      const currentActiveSpeed = parseInt(document.querySelector('.speed-btn.active')?.dataset.speed ?? 8);
      syncSpeedUI(currentActiveSpeed, e.target.checked);
    });

    $('toggleEnabled').addEventListener('change', async (e) => {
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

    function updateStatusDot(active) {
      if (active) {
        $('statusDot').classList.remove('off');
        $('statusDot').title = 'Active';
      } else {
        $('statusDot').classList.add('off');
        $('statusDot').title = 'Disabled';
      }
    }

    // WHITELIST LOGIC
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let currentDomain = '';
    if (activeTab && activeTab.url) {
      try {
        const url = new URL(activeTab.url);
        if (url.protocol.startsWith('http')) {
          currentDomain = url.hostname;
        }
      } catch (e) {}
    }
    if (currentDomain) {
      const parts = currentDomain.split('.');
      const baseDomain = parts.length > 2 ? parts.slice(-2).join('.') : currentDomain;
      
      const { whitelist = [] } = await notifyBackground({ type: MSG.WHITELIST_GET }) || { whitelist: [] };
      const isWhitelisted = whitelist.includes(baseDomain);

      $('toggleWhitelist').checked = isWhitelisted;

      $('toggleWhitelist').addEventListener('change', async (e) => {
        const isChecked = e.target.checked;

        if (isChecked) {
          await notifyBackground({ type: MSG.WHITELIST_ADD, domain: baseDomain });
        } else {
          await notifyBackground({ type: MSG.WHITELIST_REMOVE, domain: baseDomain });
        }

        chrome.tabs.reload(activeTab.id);
      });

      // FPR PER-SITE WHITELIST
      // Row only shown when global FPR toggle is on (and master is on). Lets
      // the user disable just FPR on the current domain - independent of the
      // main whitelist that disables ad-blocking too.
      const rowFpr = $('rowFprWhitelist');
      const fprToggle = $('toggleFingerprintRandomization');
      const fprSiteToggle = $('toggleFprWhitelist');

      const updateFprRowVisibility = () => {
        const visible = !!(fprToggle && fprToggle.checked && $('toggleEnabled').checked);
        if (rowFpr) rowFpr.classList.toggle('is-visible', visible);
      };
      updateFprRowVisibility();
      if (fprToggle) fprToggle.addEventListener('change', updateFprRowVisibility);
      $('toggleEnabled').addEventListener('change', updateFprRowVisibility);

      const { fprWhitelist = [] } = await notifyBackground({ type: MSG.FPR_WHITELIST_GET }) || { fprWhitelist: [] };
      if (fprSiteToggle) fprSiteToggle.checked = fprWhitelist.includes(baseDomain);

      if (fprSiteToggle) {
        fprSiteToggle.addEventListener('change', async (e) => {
          const isChecked = e.target.checked;
          if (isChecked) {
            await notifyBackground({ type: MSG.FPR_WHITELIST_ADD, domain: baseDomain });
          } else {
            await notifyBackground({ type: MSG.FPR_WHITELIST_REMOVE, domain: baseDomain });
          }
          chrome.tabs.reload(activeTab.id);
        });
      }
    } else {
      $('toggleWhitelist').parentElement.parentElement.classList.add('disabled');
      const rowFpr = $('rowFprWhitelist');
      if (rowFpr) rowFpr.classList.remove('is-visible');
    }

    // EXTERNAL LINKS
    const zapBtn = $('zapElementBtn');
    const zapStatus = $('zapperStatus');
    if (zapBtn) {
      if (!activeTab?.id || !currentDomain) {
        zapBtn.disabled = true;
        if (zapStatus) zapStatus.textContent = 'Unavailable on this page';
      } else {
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
    }

    document.querySelectorAll('a[target="_blank"]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: link.href });
      });
    });

    $('resetStats').addEventListener('click', async () => {
      await notifyBackground({ type: MSG.STATS_RESET });
      if ($('statNetworkBlocked')) $('statNetworkBlocked').textContent = '0';
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

    // SUBSCRIPTION UI
    async function loadSubscriptionUI() {
      const list = document.getElementById('subscriptionList');
      if (!list) return;

      let subscriptions = await notifyBackground({ type: MSG.SUBSCRIPTION_GET }) || [];

      // Filter out chroma-hotfix if it has 0 rules (as it is rarely used)
      subscriptions = subscriptions.filter(s => {
        if (s.id !== 'chroma-hotfix') return true;
        const totalRules = (s.ruleCount?.network || 0) + (s.ruleCount?.cosmetic || 0) + (s.ruleCount?.scriptlet || 0);
        return totalRules > 0;
      });

      // Sort: chroma-hotfix always at the bottom
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

        const lastUpdatedText = sub.lastUpdated
          ? new Date(sub.lastUpdated).toLocaleDateString()
          : 'Never';

        let countText = '';
        if (sub.ruleCount) {
          const parts = [];
          if (!sub.cosmeticOnly && sub.ruleCount.network > 0) {
            const applied = sub.enabled ? (appliedNetworkRulesPerSub[sub.id] || 0) : 0;
            parts.push(`${applied.toLocaleString()} / ${sub.ruleCount.network.toLocaleString()} network`);
          }
          if (sub.ruleCount.cosmetic > 0) parts.push(`${sub.ruleCount.cosmetic.toLocaleString()} cosmetic`);
          if (sub.ruleCount.scriptlet > 0) parts.push(`${sub.ruleCount.scriptlet.toLocaleString()} scriptlets`);
          countText = parts.join(' \u00b7 ');
        }

        const info = appendElement(row, 'div', 'toggle-info');
        appendElement(info, 'div', 'name', sub.name);
        appendElement(info, 'div', 'desc', `Updated: ${lastUpdatedText}`);
        if (countText) appendElement(info, 'div', 'desc', countText);
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

      // Toggle handler
      list.querySelectorAll('.sub-toggle').forEach(input => {
        input.addEventListener('change', async (e) => {
          await notifyBackground({ type: MSG.SUBSCRIPTION_SET, id: e.target.dataset.id, enabled: e.target.checked });
        });
      });

      // Refresh button handler
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
          }, 1500); // 1500ms visual feedback delay before resetting refresh button state
        });
      });

      // Delete button handler (custom lists only)
      list.querySelectorAll('.sub-delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const id = e.target.dataset.id;
          if (!confirm('Remove this filter list?')) return;
          await notifyBackground({ type: MSG.SUBSCRIPTION_REMOVE, id });
          loadSubscriptionUI();
        });
      });
    }

    await loadSubscriptionUI();

    // ADD-SUBSCRIPTION FORM
    (() => {
      const addBtn    = $('addSubscriptionBtn');
      const form      = $('addSubscriptionForm');
      const nameInput = $('newSubName');
      const urlInput  = $('newSubUrl');
      const errEl     = $('newSubError');
      const submitBtn = $('newSubAddBtn');
      const cancelBtn = $('newSubCancelBtn');
      if (!addBtn || !form) return;

      const showError = (m) => { errEl.textContent = m; errEl.style.display = 'block'; };
      const closeForm = () => {
        form.style.display = 'none';
        nameInput.value = '';
        urlInput.value = '';
        errEl.style.display = 'none';
        errEl.textContent = '';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Add';
      };

      addBtn.addEventListener('click', () => {
        if (form.style.display === 'none' || form.style.display === '') {
          form.style.display = 'block';
          urlInput.focus();
        } else {
          closeForm();
        }
      });
      cancelBtn.addEventListener('click', closeForm);

      const submitAdd = async () => {
        errEl.style.display = 'none';
        const url = urlInput.value.trim();
        if (!url) return showError('URL required.');
        let parsed;
        try { parsed = new URL(url); } catch { return showError('Invalid URL.'); }
        if (parsed.protocol !== 'https:') return showError('Only https:// URLs are allowed.');

        const name = nameInput.value.trim() || parsed.hostname;
        const id = 'custom_' + Date.now();
        submitBtn.disabled = true;
        submitBtn.textContent = 'Adding\u2026';

        const addRes = await notifyBackground({ type: MSG.SUBSCRIPTION_ADD, subscription: { id, name, url } });
        if (!addRes || !addRes.ok) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Add';
          return showError(addRes?.error || 'Add failed.');
        }

        const refRes = await notifyBackground({ type: MSG.SUBSCRIPTION_REFRESH, id });
        if (!refRes || !refRes.ok) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Add';
          showError('Added, but fetch failed: ' + (refRes?.error || 'unknown'));
          await loadSubscriptionUI();
          return;
        }

        closeForm();
        await loadSubscriptionUI();
      };

      submitBtn.addEventListener('click', submitAdd);
      urlInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') submitAdd(); });
      nameInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') submitAdd(); });
    })();

    // PROXY ROUTER UI
    if (globalThis.ChromaProxyUI?.loadProxyRouterUI) {
      await globalThis.ChromaProxyUI.loadProxyRouterUI();
    }

    // REQUEST LOG UI
    async function loadLocalZapperRulesUI() {
      if (!isSettingsPage()) return;
      const list = $('localZapperRules');
      if (!list) return;

      const res = await notifyBackground({ type: MSG.ZAPPER_RULES_GET }) || { rules: [] };
      const rules = Array.isArray(res.rules) ? res.rules : [];
      list.innerHTML = '';

      if (rules.length === 0) {
        list.innerHTML = '<div class="toggle-row loading-row"><span class="loading-text">No local zapper rules saved.</span></div>';
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

    await loadLocalZapperRulesUI();

    const RT_BADGE = {
      script:         { label: 'JS',  className: 'script' },
      xmlhttprequest: { label: 'XHR', className: 'xhr' },
      image:          { label: 'IMG', className: 'image' },
      sub_frame:      { label: 'FRM', className: 'frame' },
      main_frame:     { label: 'DOC', className: 'document' },
      stylesheet:     { label: 'CSS', className: 'css' },
      media:          { label: 'MED', className: 'media' },
      websocket:      { label: 'WS',  className: 'websocket' },
      ping:           { label: 'PNG', className: 'muted' },
      other:          { label: 'OTH', className: 'muted' },
      object:         { label: 'OBJ', className: 'muted' },
    };

    function formatLogUrl(url) {
      try {
        const u = new URL(url);
        const userPath = u.pathname.length > 22 ? u.pathname.slice(0, 20) + '\u2026' : u.pathname;
        return u.hostname + userPath;
      } catch {
        return url.slice(0, 40);
      }
    }

    function formatTimeAgo(ts) {
      const s = Math.floor((Date.now() - ts) / 1000);
      if (s < 60)   return `${s}s`;
      if (s < 3600) return `${Math.floor(s / 60)}m`;
      return `${Math.floor(s / 3600)}h`;
    }

    async function loadRequestLog() {
      const toggleRow = $('logToggleRow');
      const toggleBtn = $('logToggleBtn');
      const entries   = $('logEntries');
      if (!toggleRow || !entries) return;

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
        toggleBtn.classList.toggle('open', isOpen);
        entries.classList.toggle('visible', isOpen);
        if (isOpen) await renderLog();
      });
    }

    await loadRequestLog();
  }

  function scrollToProxyHash() {
    if (globalThis.location?.hash !== '#proxy') return;
    setTimeout(() => {
      const section = $('proxySection') || $('proxyRouterContainer');
      section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
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
