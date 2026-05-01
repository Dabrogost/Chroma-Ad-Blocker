/**
 * Chroma Ad-Blocker — Popup UI Controller
 * Manages the extension popup: feature toggles, stats display,
 * subscription management, proxy router configuration, and request log.
 */

'use strict';

const $ = id => document.getElementById(id);

function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

async function init() {
  const manifest = chrome.runtime.getManifest();
  if ($('versionText')) {
    $('versionText').textContent = `v${manifest.version} · MV3`;
  }

  // Update check — runs async, inserts banner if update available
  notifyBackground({ type: MSG.UPDATE_CHECK }).then(result => {
    if (!result || !result.updateAvailable) return;
    const latestVersion = result.latestVersion;

    const banner = document.createElement('div');
    banner.id = 'updateBanner';

    const updateLink = document.createElement('a');
    updateLink.href = RELEASES_PAGE;
    updateLink.target = '_blank';
    updateLink.style.cssText = 'color:var(--c-cyan);text-decoration:none;font-weight:600;';
    updateLink.textContent = `↑ v${latestVersion} available`;

    const githubSpan = document.createElement('span');
    githubSpan.style.cssText = 'color:var(--text-muted);margin-left:4px;font-size:9px;';
    githubSpan.textContent = 'on GitHub';

    const dismissBtn = document.createElement('button');
    dismissBtn.id = 'dismissUpdate';
    dismissBtn.style.cssText = 'margin-left:auto;background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:11px;padding:0 2px;line-height:1;';
    dismissBtn.title = 'Dismiss';
    dismissBtn.textContent = '✕';

    banner.appendChild(updateLink);
    banner.appendChild(githubSpan);
    banner.appendChild(dismissBtn);
    banner.style.cssText = `
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 7px 14px;
      font-size: 11px;
      background: rgba(0, 255, 204, 0.06);
      border-top: 1px solid rgba(0, 255, 204, 0.15);
      border-bottom: 1px solid rgba(0, 255, 204, 0.15);
      font-family: 'JetBrains Mono', monospace;
    `;

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

  // ─── WHITELIST LOGIC ─────
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

    // ─── FPR PER-SITE WHITELIST ─────
    // Row only shown when global FPR toggle is on (and master is on). Lets
    // the user disable just FPR on the current domain — independent of the
    // main whitelist that disables ad-blocking too.
    const rowFpr = $('rowFprWhitelist');
    const fprToggle = $('toggleFingerprintRandomization');
    const fprSiteToggle = $('toggleFprWhitelist');

    const updateFprRowVisibility = () => {
      const visible = !!(fprToggle && fprToggle.checked && $('toggleEnabled').checked);
      if (rowFpr) rowFpr.style.display = visible ? '' : 'none';
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
    if (rowFpr) rowFpr.style.display = 'none';
  }

  // ─── EXTERNAL LINKS ─────
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
    settingsIcon.addEventListener('click', () => {
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      } else {
        window.open(chrome.runtime.getURL('ui/settings.html'));
      }
    });
  }

  // ─── SUBSCRIPTION UI ─────
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
      list.innerHTML = '<div class="toggle-row" style="justify-content: center;"><span style="font-size:11px;color:var(--text-muted);">No subscriptions configured.</span></div>';
      return;
    }

    const summaryBar = document.createElement('div');
    summaryBar.style.cssText = 'padding: 8px 14px 4px; font-size: 10px; color: var(--text-muted); text-align: center; letter-spacing: 0.03em;';
    const totalCosmetic = subscriptions.reduce((sum, s) => sum + (s.ruleCount?.cosmetic || 0), 0);
    const totalScriptlet = subscriptions.reduce((sum, s) => sum + (s.ruleCount?.scriptlet || 0), 0);
    summaryBar.textContent = `${totalParsed.toLocaleString()} parsed · ${appliedNetworkRuleCount.toLocaleString()} applied · ${totalCosmetic.toLocaleString()} cosmetic · ${totalScriptlet.toLocaleString()} scriptlets`;

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
        countText = parts.join(' · ');
      }

      const safeName  = escapeHTML(sub.name);
      const safeId    = escapeHTML(sub.id);
      const safeError = sub.lastError ? escapeHTML(sub.lastError) : '';

      const errorText = safeError
        ? `<div style="font-size:10px;color:var(--c-red);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${safeError}">Error: ${safeError}</div>`
        : '';

      const deleteBtnHtml = sub.isCustom
        ? `<button data-id="${safeId}" class="sub-delete-btn reset-btn" style="padding: 1px 4px; border: none; background: transparent; color: var(--c-red); opacity: 0.7; font-size: 12px;" title="Remove List">✕</button><span style="display:inline-block; width:1px; height:14px; background:rgba(255,255,255,0.08); align-self:center;"></span>`
        : '';

      row.innerHTML = `
        <div class="toggle-info">
          <div class="name">${safeName}</div>
          <div class="desc">Updated: ${lastUpdatedText}</div>
          ${countText ? `<div class="desc">${countText}</div>` : ''}
          ${errorText}
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
          ${deleteBtnHtml}
          <button data-id="${safeId}" class="sub-refresh-btn reset-btn" style="font-size:9px;padding:3px 8px;" title="Force refresh">↻</button>
          <label class="switch">
            <input type="checkbox" class="sub-toggle" data-id="${safeId}" ${sub.enabled ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
        </div>
      `;

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
        e.target.textContent = '…';
        e.target.disabled = true;
        const result = await notifyBackground({ type: MSG.SUBSCRIPTION_REFRESH, id });
        e.target.textContent = result && result.ok ? '✓' : '✗';
        setTimeout(() => {
          e.target.textContent = '↻';
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

  // ─── ADD-SUBSCRIPTION FORM ─────
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
      if (form.style.display === 'none') {
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
      submitBtn.textContent = 'Adding…';

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

  // ─── PROXY ROUTER UI ─────
  async function loadProxyRouterUI() {
    const container = $('proxyRouterContainer');
    const addBtn = $('addProxyServerBtn');
    if (!container) return;

    const settingsMode = isSettingsPage();
    if (settingsMode && !addBtn) return;
    let proxyConfigs = await notifyBackground({ type: MSG.PROXY_CONFIG_GET }) || [];
    proxyConfigs.forEach(pc => {
      pc.credentialAction = 'preserve';
      delete pc.username;
      delete pc.password;
      delete pc.authIv;
      delete pc.authCipher;
    });

    if (!settingsMode) {
      const { config: proxyConfigState = {} } = await chrome.storage.local.get('config');
      if (addBtn) {
        addBtn.title = 'Manage Proxies';
        addBtn.onclick = openProxySettings;
      }

      const renderPopupCard = (pc, index) => {
        const accepted = !!(pc.accepted && pc.host && pc.port);
        const activeDomainCount = (pc.domains || []).filter(d => d.enabled).length;
        const isGlobal = !!(accepted && proxyConfigState.globalProxyEnabled && proxyConfigState.globalProxyId === pc.id);
        const routeSummary = isGlobal
          ? 'global fallback'
          : `${activeDomainCount} routed`;
        const card = document.createElement('div');
        card.className = 'protection-list';
        card.style.marginBottom = '12px';
        card.innerHTML = `
          <div style="padding: 12px 14px; display: flex; align-items: center; justify-content: space-between; gap: 12px;">
            <div style="min-width: 0;">
              <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; font-weight: 700; letter-spacing: 0.05em; margin-bottom: 2px;">${escapeHTML(pc.name || 'Server ' + (index + 1))}</div>
              <div style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${accepted ? `${escapeHTML(pc.host)}:${escapeHTML(pc.port)}` : 'Not configured'}</div>
              <div class="proxy-meta-text" style="font-size: 9px; color: var(--text-dim); margin-top: 2px;">${escapeHTML(pc.type || 'PROXY')} &middot; ${pc.hasCredentials ? 'credentials saved' : 'no credentials'} &middot; ${routeSummary}</div>
              <div class="proxy-status-line" style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                <span class="proxy-status-dot" style="width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); box-shadow: 0 0 5px rgba(255,255,255,0.1);"></span>
                <span class="proxy-status-text" style="font-size: 9px; color: var(--text-dim); text-transform: uppercase; font-weight: 600; letter-spacing: 0.03em;">${accepted ? 'Checking...' : 'Open settings to configure'}</span>
              </div>
            </div>
            <div style="display: flex; align-items: center; justify-content: center; gap: 8px; flex-shrink: 0;">
              ${accepted ? `
                <button class="reset-btn proxy-refresh-btn" style="font-size:9px;padding:3px 8px;" title="Refresh Connection">↻</button>
                <label class="switch switch-sm" title="Use as Global Fallback">
                  <input type="checkbox" class="proxy-global-toggle" />
                  <span class="slider"></span>
                </label>
              ` : ''}
            </div>
          </div>
        `;

        const txt = card.querySelector('.proxy-status-text');
        const dot = card.querySelector('.proxy-status-dot');
        const meta = card.querySelector('.proxy-meta-text');
        const refreshBtn = card.querySelector('.proxy-refresh-btn');
        const globalToggle = card.querySelector('.proxy-global-toggle');

        const setConnectedStatus = (ip = '') => {
          if (!txt || !dot) return;
          const ipSuffix = ip ? ` (${ip})` : '';
          if (globalToggle?.checked) {
            txt.textContent = `GLOBAL VPN ACTIVE${ipSuffix}`;
            if (meta) meta.textContent = `${pc.type || 'PROXY'} · ${pc.hasCredentials ? 'credentials saved' : 'no credentials'} · global fallback`;
          } else if (activeDomainCount > 0) {
            txt.textContent = `ROUTING ${activeDomainCount} DOMAIN${activeDomainCount > 1 ? 'S' : ''}${ipSuffix}`;
            if (meta) meta.textContent = `${pc.type || 'PROXY'} · ${pc.hasCredentials ? 'credentials saved' : 'no credentials'} · ${activeDomainCount} routed`;
          } else {
            txt.textContent = `CONNECTED${ipSuffix}`;
            if (meta) meta.textContent = `${pc.type || 'PROXY'} · ${pc.hasCredentials ? 'credentials saved' : 'no credentials'} · 0 routed`;
          }
          dot.style.background = 'var(--c-cyan)';
          dot.style.boxShadow = '0 0 8px var(--c-cyan)';
        };

        if (globalToggle) {
          globalToggle.checked = !!(proxyConfigState.globalProxyEnabled && proxyConfigState.globalProxyId === pc.id);
          globalToggle.addEventListener('change', async (e) => {
            const isChecked = e.target.checked;
            if (isChecked && typeof confirm === 'function' && !confirm('Global proxy mode can route all browser traffic through this proxy when no domain-specific route matches. Enable it?')) {
              e.target.checked = false;
              return;
            }
            const result = await notifyBackground({
              type: MSG.CONFIG_SET,
              config: {
                globalProxyEnabled: isChecked,
                globalProxyId: isChecked ? pc.id : null
              }
            });
            if (!result || result.ok === false) {
              e.target.checked = !isChecked;
              setConnectedStatus();
              return;
            }
            if (isChecked) {
              document.querySelectorAll('.proxy-global-toggle').forEach(t => {
                if (t !== globalToggle) t.checked = false;
              });
            }
            await loadProxyRouterUI();
          });
        }

        const testConnection = async () => {
          if (!accepted || !txt || !dot) return;
          dot.style.background = 'var(--text-muted)';
          txt.textContent = 'Verifying...';
          const res = await notifyBackground({ type: MSG.PROXY_TEST, proxyId: pc.id });
          if (res && res.ok) {
            setConnectedStatus(res.ip);
          } else {
            dot.style.background = 'var(--c-red)';
            dot.style.boxShadow = '0 0 8px var(--c-red)';
            txt.textContent = res ? `Offline (${res.error})` : 'Offline';
          }
        };

        refreshBtn?.addEventListener('click', testConnection);
        if (accepted) testConnection();
        return card;
      };

      container.innerHTML = '';
      if (proxyConfigs.length === 0) {
        container.innerHTML = '<div class="protection-list" style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 11px;">No proxy servers configured.</div>';
      } else {
        proxyConfigs.forEach((pc, i) => container.appendChild(renderPopupCard(pc, i)));
      }

      const manage = document.createElement('button');
      manage.className = 'reset-btn';
      manage.style.cssText = 'width: calc(100% - 24px); margin: 0 12px 12px; padding: 8px; font-size: 11px;';
      manage.textContent = 'Manage proxies';
      manage.addEventListener('click', openProxySettings);
      container.appendChild(manage);
      return;
    }

    const buildProxySavePayload = (credentialById = new Map()) => proxyConfigs
      .filter(pc => pc.accepted === true)
      .map(pc => {
      const credential = credentialById.get(pc.id) || {};
      const action = credential.action || pc.credentialAction || 'preserve';
      const out = {
        id: pc.id,
        name: pc.name,
        host: pc.host,
        port: pc.port,
        type: pc.type,
        accepted: pc.accepted,
        domains: pc.domains,
        credentialAction: action
      };
      if (out.credentialAction === 'replace') {
        out.username = credential.username || '';
        out.password = credential.password || '';
      }
      return out;
    });

    const saveAllConfigs = async (credentialById = new Map()) => {
      return notifyBackground({ type: MSG.PROXY_CONFIG_SET, proxyConfigs: buildProxySavePayload(credentialById) });
    };

    const renderProxyCard = (pc, index) => {
      const card = document.createElement('div');
      card.className = 'protection-list';
      card.style.marginBottom = '12px';
      card.dataset.index = index;

      const inputGroupId = `proxyInputGroup_${index}`;
      const activeGroupId = `proxyActiveGroup_${index}`;

      card.innerHTML = `
        <div id="${inputGroupId}" class="proxy-grid" style="display: ${pc.accepted && pc.host && pc.port ? 'none' : 'grid'}">
          <select class="chroma-input proxy-type" style="grid-column: 1 / -1; margin-bottom: 4px;">
            <option value="PROXY" ${(pc.type === 'PROXY' || !pc.type) ? 'selected' : ''}>HTTP (Default)</option>
            <option value="HTTPS" ${pc.type === 'HTTPS' ? 'selected' : ''}>HTTPS</option>
            <option value="SOCKS4" ${pc.type === 'SOCKS4' ? 'selected' : ''}>SOCKS4</option>
            <option value="SOCKS5" ${pc.type === 'SOCKS5' ? 'selected' : ''}>SOCKS5</option>
          </select>
          <input type="text" class="chroma-input proxy-name" value="${escapeHTML(pc.name || '')}" placeholder="Display name (optional)" style="grid-column: 1 / -1;" />
          <input type="text" class="chroma-input proxy-host" value="${escapeHTML(pc.host)}" placeholder="Proxy Host (e.g. 1.2.3.4)" />
          <input type="text" class="chroma-input proxy-port" value="${escapeHTML(pc.port)}" placeholder="Port (e.g. 80)" />
          <input type="text" class="chroma-input proxy-user" value="" placeholder="Username" />
          <input type="password" class="chroma-input proxy-pass" value="" placeholder="${pc.hasCredentials ? 'Password saved' : 'Password'}" />
          <div style="grid-column: 1 / -1; font-size: 10px; color: var(--text-muted); margin-top: -2px; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
            <span class="proxy-credential-help">${pc.hasCredentials ? 'Credentials saved locally. Leave fields blank to keep them.' : 'Credentials are stored locally in encrypted extension storage and used only for proxy authentication.'}</span>
            <button class="reset-btn proxy-clear-credentials-btn" style="display: ${pc.hasCredentials ? 'inline-block' : 'none'}; padding: 1px 6px; border: none; background: transparent; color: var(--c-red); opacity: 0.7; font-size: 10px;">Clear credentials</button>
          </div>
          <div class="proxy-auth-note" style="grid-column: 1 / -1; font-size: 10px; color: var(--text-muted); margin-top: -2px; display: none;">SOCKS auth isn't supported by Chrome — use IP whitelisting on your provider.</div>
          <div class="proxy-error" style="grid-column: 1 / -1; display: none; font-size: 10px; color: var(--c-red);"></div>
          <div style="grid-column: 1 / -1; display: flex; gap: 8px;">
            <button class="reset-btn proxy-accept-btn" style="flex: 1; padding: 6px;">Accept Settings</button>
            <button class="reset-btn proxy-del-server-btn" style="padding: 1px 8px; border: none; background: transparent; color: var(--c-red); opacity: 0.7; font-size: 10px;" title="Delete Server">Delete</button>
          </div>
        </div>
        
        <div id="${activeGroupId}" style="display: ${pc.accepted && pc.host && pc.port ? 'flex' : 'none'}; padding: 12px 14px; align-items: center; justify-content: space-between;">
          <div>
            <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; font-weight: 700; letter-spacing: 0.05em; margin-bottom: 2px;">Active: ${escapeHTML(pc.name || 'Server ' + (index + 1))}</div>
            <div style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--text);">${escapeHTML(pc.host)}:${escapeHTML(pc.port)}</div>
            <div class="proxy-status-line" style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
              <span class="proxy-status-dot" style="width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); box-shadow: 0 0 5px rgba(255,255,255,0.1);"></span>
              <span class="proxy-status-text" style="font-size: 9px; color: var(--text-dim); text-transform: uppercase; font-weight: 600; letter-spacing: 0.03em;">Checking...</span>
              <button class="reset-btn proxy-edit-btn" style="font-size: 10px; padding: 1px 4px; line-height: 1; border: none; background: transparent; opacity: 0.7;" title="Edit Server">Edit</button>
              <button class="reset-btn proxy-refresh-btn" style="font-size:9px;padding:3px 8px;" title="Refresh Connection">↻</button>
              <span style="display:inline-block; width:1px; height:12px; background:rgba(255,255,255,0.08); align-self:center;"></span>
              <button class="reset-btn proxy-clear-settings-btn" style="font-size: 10px; padding: 1px 4px; line-height: 1; border: none; background: transparent; color: var(--c-red); opacity: 0.7;" title="Clear Settings">Clear</button>
            </div>
          </div>
          <div style="display: flex; align-items: center; justify-content: center; height: 100%;">
            <label class="switch switch-sm" title="Use as Global Fallback">
              <input type="checkbox" class="proxy-global-toggle" />
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <div class="proxy-grid-full" style="padding: 10px 14px; border-top: 1px solid rgba(255,255,255,0.03);">
          <input type="text" class="chroma-input proxy-domain-input" placeholder="Domain (e.g. youtube.com)" style="font-size: 11px;" />
          <button class="reset-btn proxy-add-domain-btn" style="padding: 6px 12px; font-size: 11px;">ADD</button>
        </div>
        <div class="proxy-domain-list" style="max-height: 100px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.1) transparent;">
          <!-- Domains will be injected here -->
        </div>
      `;

      const typeSelect = card.querySelector('.proxy-type');
      const nameInput = card.querySelector('.proxy-name');
      const hostInput = card.querySelector('.proxy-host');
      const portInput = card.querySelector('.proxy-port');
      const userInput = card.querySelector('.proxy-user');
      const passInput = card.querySelector('.proxy-pass');
      const authNote = card.querySelector('.proxy-auth-note');
      const clearCredentialsBtn = card.querySelector('.proxy-clear-credentials-btn');
      const errorEl = card.querySelector('.proxy-error');

      const replaceThisCard = () => {
        card.replaceWith(renderProxyCard(pc, proxyConfigs.indexOf(pc)));
      };

      let pendingCredentialAction = pc.credentialAction || 'preserve';
      let displayedHasCredentials = !!pc.hasCredentials;

      const resetCredentialStateAfterSave = () => {
        pc.credentialAction = 'preserve';
        pendingCredentialAction = 'preserve';
      };

      const showProxyError = (message) => {
        if (!errorEl) return;
        errorEl.textContent = message;
        errorEl.style.display = message ? 'block' : 'none';
      };

      const clearCredentialInputs = () => {
        userInput.value = '';
        passInput.value = '';
      };

      const updateCredentialHelp = () => {
        const help = card.querySelector('.proxy-credential-help');
        if (help) {
          help.textContent = displayedHasCredentials
            ? 'Credentials saved locally. Leave fields blank to keep them.'
            : 'Credentials are stored locally in encrypted extension storage and used only for proxy authentication.';
        }
        if (passInput) passInput.placeholder = displayedHasCredentials ? 'Password saved' : 'Password';
        if (clearCredentialsBtn) clearCredentialsBtn.style.display = displayedHasCredentials ? 'inline-block' : 'none';
      };

      const readCredentialAction = () => {
        const username = userInput.value.trim();
        const password = passInput.value;
        const isSocks = typeSelect.value === 'SOCKS4' || typeSelect.value === 'SOCKS5';
        if (isSocks) return { ok: true, credential: { action: pendingCredentialAction === 'clear' ? 'clear' : 'preserve' } };
        if (username && password) return { ok: true, credential: { action: 'replace', username, password } };
        if (!username && !password) return { ok: true, credential: { action: pendingCredentialAction === 'clear' ? 'clear' : 'preserve' } };
        return { ok: false, error: 'Enter both username and password, or leave both blank to keep saved credentials.' };
      };

      // Chrome's webRequest.onAuthRequired only fires for HTTP(S) 407 challenges,
      // so SOCKS4/5 username+password auth can never succeed — hide the fields.
      let previousType = typeSelect.value;
      const applyAuthVisibility = (fromUserChange = false) => {
        const isSocks = typeSelect.value === 'SOCKS4' || typeSelect.value === 'SOCKS5';
        userInput.disabled = isSocks;
        passInput.disabled = isSocks;
        userInput.style.display = isSocks ? 'none' : '';
        passInput.style.display = isSocks ? 'none' : '';
        if (authNote) {
          authNote.textContent = 'SOCKS username/password auth is not supported by Chrome here. Use provider-side IP allowlisting or an HTTP/HTTPS proxy.';
          authNote.style.display = isSocks ? 'block' : 'none';
        }
        if (isSocks && fromUserChange && (displayedHasCredentials || userInput.value || passInput.value)) {
          if (typeof confirm === 'function' && !confirm('SOCKS username/password auth is not supported by Chrome here. Clear saved credentials for this proxy?')) {
            typeSelect.value = previousType;
            return applyAuthVisibility(false);
          }
          clearCredentialInputs();
          pendingCredentialAction = 'clear';
          displayedHasCredentials = false;
          updateCredentialHelp();
        }
        previousType = typeSelect.value;
      };
      applyAuthVisibility();
      typeSelect.addEventListener('change', () => applyAuthVisibility(true));
      const domainInput = card.querySelector('.proxy-domain-input');
      const addDomainBtn = card.querySelector('.proxy-add-domain-btn');
      const domainList = card.querySelector('.proxy-domain-list');
      const acceptBtn = card.querySelector('.proxy-accept-btn');
      const clearBtn = card.querySelector('.proxy-clear-settings-btn');
      const delServerBtn = card.querySelector('.proxy-del-server-btn');
      const editBtn = card.querySelector('.proxy-edit-btn');
      const refreshBtn = card.querySelector('.proxy-refresh-btn');
      const globalToggle = card.querySelector('.proxy-global-toggle');

      clearCredentialsBtn?.addEventListener('click', async () => {
        clearCredentialInputs();
        pc.credentialAction = 'clear';
        pc.hasCredentials = false;
        pendingCredentialAction = 'clear';
        displayedHasCredentials = false;
        updateCredentialHelp();
        await saveAllConfigs(new Map([[pc.id, { action: 'clear' }]]));
        resetCredentialStateAfterSave();
        replaceThisCard();
      });

      const updateGlobalUI = async () => {
        if (!globalToggle) return;
        const { config: c } = await chrome.storage.local.get('config');
        const isGlobal = (c?.globalProxyEnabled && c?.globalProxyId === pc.id);
        globalToggle.checked = isGlobal;
        
        // Hide domain controls if this is the global catch-all
        const domainGrid = card.querySelector('.proxy-grid-full');
        const domainList = card.querySelector('.proxy-domain-list');
        if (domainGrid) domainGrid.style.display = isGlobal ? 'none' : 'flex';
        if (domainList) domainList.style.display = isGlobal ? 'none' : 'block';
        
        updateStatusLine();
      };

      const updateStatusLine = (ip = null) => {
        const txt = card.querySelector('.proxy-status-text');
        const dot = card.querySelector('.proxy-status-dot');
        if (!txt || !dot) return;

        // If we're verifying and don't have an IP yet, don't overwrite the 'Verifying...' state
        if (!ip && (txt.textContent === 'Checking...' || txt.textContent === 'Verifying...')) return;
        
        // If we're offline, don't overwrite unless we have a new IP
        if (!ip && txt.textContent.startsWith('Offline')) return;

        const { globalProxyEnabled: ge, globalProxyId: gi } = config; // config is from the outer scope if available, but let's be safe
        const isGlobal = (globalToggle && globalToggle.checked);
        const activeDomainCount = (pc.domains || []).filter(d => d.enabled).length;

        const currentIp = ip || txt.textContent.match(/\((.*?)\)/)?.[1] || '';
        const ipSuffix = currentIp ? ` (${currentIp})` : '';

        if (isGlobal) {
          txt.textContent = `GLOBAL VPN ACTIVE${ipSuffix}`;
          dot.style.background = 'var(--c-cyan)';
          dot.style.boxShadow = '0 0 8px var(--c-cyan)';
        } else if (activeDomainCount > 0) {
          txt.textContent = `ROUTING ${activeDomainCount} DOMAIN${activeDomainCount > 1 ? 'S' : ''}${ipSuffix}`;
          dot.style.background = 'var(--c-cyan)';
          dot.style.boxShadow = '0 0 8px var(--c-cyan)';
        } else {
          txt.textContent = `CONNECTED${ipSuffix}`;
          dot.style.background = 'var(--c-cyan)';
          dot.style.boxShadow = '0 0 8px var(--c-cyan)';
        }
      };

      const testConnection = async () => {
        const dot = card.querySelector('.proxy-status-dot');
        const txt = card.querySelector('.proxy-status-text');
        if (!dot || !txt) return;

        dot.style.background = 'var(--text-muted)';
        txt.textContent = 'Verifying...';

        const res = await notifyBackground({ type: MSG.PROXY_TEST, proxyId: pc.id });
        if (res && res.ok) {
          updateStatusLine(res.ip);
        } else {
          dot.style.background = 'var(--c-red)';
          dot.style.boxShadow = '0 0 8px var(--c-red)';
          txt.textContent = res ? `Offline (${res.error})` : 'Offline';
        }
      };

      const renderDomains = () => {
        domainList.innerHTML = '';
        if (!pc.domains || pc.domains.length === 0) {
          domainList.innerHTML = '<div class="toggle-row" style="justify-content: center;"><span style="font-size:10px;color:var(--text-muted);">No domains.</span></div>';
          return;
        }

        pc.domains.forEach((d, dIdx) => {
          const dRow = document.createElement('div');
          dRow.className = 'toggle-row';
          dRow.style.padding = '6px 14px';
          dRow.style.borderTop = '1px solid rgba(255,255,255,0.03)';

          const safeHost = escapeHTML(d.host);
          const isLinked = ['youtube.com', 'twitch.tv', 'netflix.com', 'amazon.com', 'primevideo.com', 'disneyplus.com', 'hulu.com', 'max.com', 'spotify.com'].some(h => safeHost === h || safeHost.endsWith('.' + h));
          const badgeHtml = isLinked ? `<span class="badge purple" style="font-size:7px;" title="Automatically routed proxy domain">Smart-Link</span>` : '';

          dRow.innerHTML = `
            <div class="toggle-info">
              <div class="name" style="font-family: 'JetBrains Mono', monospace; font-size: 10px;">${safeHost} ${badgeHtml}</div>
            </div>
            <div style="display:flex;align-items:center;gap:12px;">
              <button class="reset-btn d-del-btn" style="padding: 1px 4px; border: none; background: transparent; color: var(--c-red); opacity: 0.7; font-size: 10px;" title="Remove Domain">Remove</button>
              <span style="display:inline-block; width:1px; height:14px; background:rgba(255,255,255,0.08); align-self:center;"></span>
              <label class="switch switch-sm">
                <input type="checkbox" class="d-toggle" ${d.enabled ? 'checked' : ''} />
                <span class="slider"></span>
              </label>
            </div>
          `;
          
          dRow.querySelector('.d-toggle').addEventListener('change', async (e) => {
            pc.domains[dIdx].enabled = e.target.checked;
            await saveAllConfigs();
            updateStatusLine();
          });

          dRow.querySelector('.d-del-btn').addEventListener('click', async () => {
            pc.domains.splice(dIdx, 1);
            await saveAllConfigs();
            renderDomains();
            updateStatusLine();
          });

          domainList.appendChild(dRow);
        });
      };

      renderDomains();

      if (pc.accepted && pc.host && pc.port) {
        testConnection();
        updateGlobalUI();
      }

      globalToggle?.addEventListener('change', async (e) => {
        const isChecked = e.target.checked;
        if (isChecked && typeof confirm === 'function' && !confirm('Global proxy mode can route all browser traffic through this proxy when no domain-specific route matches. Enable it?')) {
          e.target.checked = false;
          return;
        }
        await notifyBackground({ 
          type: MSG.CONFIG_SET, 
          config: { 
            globalProxyEnabled: isChecked,
            globalProxyId: isChecked ? pc.id : null 
          } 
        });
        
        // If we turned this one ON, we need to turn others OFF in the UI
        if (isChecked) {
          document.querySelectorAll('.proxy-global-toggle').forEach(t => {
            if (t !== globalToggle) {
              t.checked = false;
              // Trigger a UI update for the other cards to show their domain lists again
              const otherCard = t.closest('.protection-list');
              const dGrid = otherCard?.querySelector('.proxy-grid-full');
              const dList = otherCard?.querySelector('.proxy-domain-list');
              if (dGrid) dGrid.style.display = 'flex';
              if (dList) dList.style.display = 'block';
            }
          });
        }
        
        // Update this card's domain visibility
        const domainGrid = card.querySelector('.proxy-grid-full');
        const domainList = card.querySelector('.proxy-domain-list');
        if (domainGrid) domainGrid.style.display = isChecked ? 'none' : 'flex';
        if (domainList) domainList.style.display = isChecked ? 'none' : 'block';
        updateStatusLine();
      });

      acceptBtn.addEventListener('click', async () => {
        showProxyError('');
        let host = hostInput.value.trim();
        if (host.includes('.com') && !host.includes('://')) {
          host = 'https://' + host;
          hostInput.value = host;
        }
        pc.name = nameInput.value.trim();
        pc.type = typeSelect.value;
        pc.host = host;
        pc.port = portInput.value.trim();
        const credentialResult = readCredentialAction();
        if (!credentialResult.ok) {
          showProxyError(credentialResult.error);
          return;
        }
        pc.accepted = true;
        
        const result = await saveAllConfigs(new Map([[pc.id, credentialResult.credential]])); // Force immediate save and wait for background to sync
        if (!result || result.ok === false || result.errors?.length) {
          showProxyError(result?.error || result?.errors?.[0] || 'Unable to save proxy settings.');
          return;
        }
        if (credentialResult.credential.action === 'replace') pc.hasCredentials = true;
        if (credentialResult.credential.action === 'clear') pc.hasCredentials = false;
        clearCredentialInputs();
        resetCredentialStateAfterSave();

        replaceThisCard();
      });

      clearBtn.addEventListener('click', async () => {
        pc.accepted = false;
        await saveAllConfigs();
        replaceThisCard();
      });

      editBtn?.addEventListener('click', () => {
        const inputGroup = document.getElementById(inputGroupId);
        const activeGroup = document.getElementById(activeGroupId);
        if (inputGroup) inputGroup.style.display = 'grid';
        if (activeGroup) activeGroup.style.display = 'none';
        hostInput.focus?.();
      });

      delServerBtn.addEventListener('click', async () => {
        const idx = proxyConfigs.findIndex(p => p.id === pc.id);
        if (idx > -1) proxyConfigs.splice(idx, 1);
        await saveAllConfigs();
        if (proxyConfigs.length === 0) {
          renderAll();
        } else {
          card.remove();
        }
      });

      refreshBtn?.addEventListener('click', testConnection);

      addDomainBtn.addEventListener('click', async () => {
        let d = domainInput.value.trim().toLowerCase();
        d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (d) {
          if (!pc.domains) pc.domains = [];
          if (!pc.domains.find(x => x.host === d)) {
            pc.domains.push({ host: d, enabled: true });
            domainInput.value = '';
            if (pc.accepted) await saveAllConfigs();
            renderDomains();
          }
        }
      });

      domainInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addDomainBtn.click();
      });

      return card;
    };

    const renderAll = () => {
      container.innerHTML = '';
      if (proxyConfigs.length === 0) {
        container.innerHTML = '<div class="protection-list" style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 11px;">No proxy servers configured. Click + to add one.</div>';
      } else {
        proxyConfigs.forEach((pc, i) => {
          container.appendChild(renderProxyCard(pc, i));
        });
      }
    };

    addBtn.onclick = async () => {
      const newPc = {
        id: Date.now(),
        type: 'PROXY',
        host: '',
        port: '',
        accepted: false,
        domains: [],
        hasCredentials: false,
        credentialAction: 'preserve'
      };
      proxyConfigs.push(newPc);
      renderAll();
      // Scroll to bottom
      container.lastElementChild?.scrollIntoView({ behavior: 'smooth' });
    };

    renderAll();
  }

  await loadProxyRouterUI();

  if (isSettingsPage() && globalThis.location?.hash === '#proxy') {
    setTimeout(() => {
      const section = $('proxySection') || $('proxyRouterContainer');
      section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }

  // ─── REQUEST LOG UI ─────
  const RT_BADGE = {
    script:         { label: 'JS',  color: 'rgba(0,255,204,0.15)',  text: 'var(--c-cyan)' },
    xmlhttprequest: { label: 'XHR', color: 'rgba(0,136,255,0.15)', text: 'var(--c-blue)' },
    image:          { label: 'IMG', color: 'rgba(153,0,255,0.15)', text: '#b388ff' },
    sub_frame:      { label: 'FRM', color: 'rgba(230,126,34,0.15)', text: '#e67e22' },
    main_frame:     { label: 'DOC', color: 'rgba(231,76,60,0.15)',  text: '#e74c3c' },
    stylesheet:     { label: 'CSS', color: 'rgba(39,174,96,0.15)',  text: '#2ecc71' },
    media:          { label: 'MED', color: 'rgba(243,156,18,0.15)', text: '#f39c12' },
    websocket:      { label: 'WS',  color: 'rgba(26,188,156,0.15)', text: '#1abc9c' },
    ping:           { label: 'PNG', color: 'rgba(149,165,166,0.1)', text: '#95a5a6' },
    other:          { label: 'OTH', color: 'rgba(149,165,166,0.1)', text: '#95a5a6' },
    object:         { label: 'OBJ', color: 'rgba(149,165,166,0.1)', text: '#95a5a6' },
  };

  function formatLogUrl(url) {
    try {
      const u = new URL(url);
      const userPath = u.pathname.length > 22 ? u.pathname.slice(0, 20) + '…' : u.pathname;
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
        const badge = RT_BADGE[entry.rt] || { label: '???', color: 'rgba(255,255,255,0.05)', text: 'var(--text-muted)' };
        const row = document.createElement('div');
        row.className = 'log-entry';
        row.innerHTML = `
          <span class="log-rt" style="background:${badge.color};color:${badge.text};">${badge.label}</span>
          <span class="log-url" title="${escapeHTML(entry.url)}">${escapeHTML(formatLogUrl(entry.url))}</span>
          <span class="log-time">${formatTimeAgo(entry.ts)}</span>
        `;
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

  loadRequestLog();
}

init();
