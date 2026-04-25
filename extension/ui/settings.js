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
  } else {
    $('toggleWhitelist').parentElement.parentElement.classList.add('disabled');
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

    const subscriptions = await notifyBackground({ type: MSG.SUBSCRIPTION_GET }) || [];
    // Sort: chroma-hotfix always at the bottom
    subscriptions.sort((a, b) => {
      if (a.id === 'chroma-hotfix') return 1;
      if (b.id === 'chroma-hotfix') return -1;
      return 0;
    });

    const { appliedNetworkRuleCount = 0 } = await chrome.storage.local.get('appliedNetworkRuleCount');
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
        if (!sub.cosmeticOnly && sub.ruleCount.network > 0) parts.push(`${sub.ruleCount.network.toLocaleString()} network`);
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

      row.innerHTML = `
        <div class="toggle-info">
          <div class="name">${safeName}</div>
          <div class="desc">Updated: ${lastUpdatedText}</div>
          ${countText ? `<div class="desc">${countText}</div>` : ''}
          ${errorText}
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
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
  }

  await loadSubscriptionUI();

  // ─── PROXY ROUTER UI ─────
  async function loadProxyRouterUI() {
    const container = $('proxyRouterContainer');
    const addBtn = $('addProxyServerBtn');
    if (!container || !addBtn) return;

    let proxyConfigs = await notifyBackground({ type: MSG.PROXY_CONFIG_GET }) || [];

    let saveTimeout = null;
    const saveAllConfigs = (immediate = false) => {
      if (saveTimeout) clearTimeout(saveTimeout);
      const perform = async () => {
        await notifyBackground({ type: MSG.PROXY_CONFIG_SET, proxyConfigs });
        saveTimeout = null;
      };
      if (immediate) {
        return perform();
      } else {
        saveTimeout = setTimeout(perform, 400);
        return Promise.resolve();
      }
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
          <input type="text" class="chroma-input proxy-host" value="${escapeHTML(pc.host)}" placeholder="Proxy Host (e.g. 1.2.3.4)" />
          <input type="text" class="chroma-input proxy-port" value="${escapeHTML(pc.port)}" placeholder="Port (e.g. 80)" />
          <input type="text" class="chroma-input proxy-user" value="${escapeHTML(pc.username)}" placeholder="Username" />
          <input type="password" class="chroma-input proxy-pass" value="${escapeHTML(pc.password)}" placeholder="Password" />
          <div style="grid-column: 1 / -1; display: flex; gap: 8px;">
            <button class="reset-btn proxy-accept-btn" style="flex: 1; padding: 6px;">Accept Settings</button>
            <button class="reset-btn proxy-del-server-btn" style="padding: 1px 8px; border: none; background: transparent; color: var(--c-red); opacity: 0.7; font-size: 12px;" title="Delete Server">✕</button>
          </div>
        </div>
        
        <div id="${activeGroupId}" style="display: ${pc.accepted && pc.host && pc.port ? 'flex' : 'none'}; padding: 12px 14px; align-items: center; justify-content: space-between;">
          <div>
            <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; font-weight: 700; letter-spacing: 0.05em; margin-bottom: 2px;">Active: ${escapeHTML(pc.name || 'Server ' + (index + 1))}</div>
            <div style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--text);">${escapeHTML(pc.host)}:${escapeHTML(pc.port)}</div>
            <div class="proxy-status-line" style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
              <span class="proxy-status-dot" style="width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); box-shadow: 0 0 5px rgba(255,255,255,0.1);"></span>
              <span class="proxy-status-text" style="font-size: 9px; color: var(--text-dim); text-transform: uppercase; font-weight: 600; letter-spacing: 0.03em;">Checking...</span>
              <button class="reset-btn proxy-refresh-btn" style="font-size: 10px; padding: 1px 4px; line-height: 1; border: none; background: transparent; opacity: 0.5;" title="Refresh Connection">↻</button>
              <button class="reset-btn proxy-clear-settings-btn" style="font-size: 10px; padding: 1px 4px; line-height: 1; border: none; background: transparent; color: var(--c-red); opacity: 0.7;" title="Clear Settings">✕</button>
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

      const hostInput = card.querySelector('.proxy-host');
      const portInput = card.querySelector('.proxy-port');
      const userInput = card.querySelector('.proxy-user');
      const passInput = card.querySelector('.proxy-pass');
      const domainInput = card.querySelector('.proxy-domain-input');
      const addDomainBtn = card.querySelector('.proxy-add-domain-btn');
      const domainList = card.querySelector('.proxy-domain-list');
      const acceptBtn = card.querySelector('.proxy-accept-btn');
      const clearBtn = card.querySelector('.proxy-clear-settings-btn');
      const delServerBtn = card.querySelector('.proxy-del-server-btn');
      const refreshBtn = card.querySelector('.proxy-refresh-btn');
      const globalToggle = card.querySelector('.proxy-global-toggle');

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
              <button class="reset-btn d-del-btn" style="padding: 1px 4px; border: none; background: transparent; color: var(--c-red); opacity: 0.7; font-size: 10px;" title="Remove Domain">✕</button>
              <label class="switch switch-sm">
                <input type="checkbox" class="d-toggle" ${d.enabled ? 'checked' : ''} />
                <span class="slider"></span>
              </label>
            </div>
          `;
          
          dRow.querySelector('.d-toggle').addEventListener('change', async (e) => {
            pc.domains[dIdx].enabled = e.target.checked;
            await saveAllConfigs(true);
            updateStatusLine();
          });

          dRow.querySelector('.d-del-btn').addEventListener('click', async () => {
            pc.domains.splice(dIdx, 1);
            await saveAllConfigs(true);
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
        let host = hostInput.value.trim();
        if (host.includes('.com') && !host.includes('://')) {
          host = 'https://' + host;
          hostInput.value = host;
        }
        pc.host = host;
        pc.port = portInput.value.trim();
        pc.username = userInput.value.trim() || null;
        pc.password = passInput.value.trim() || null;
        pc.accepted = true;
        
        await saveAllConfigs(true); // Force immediate save and wait for background to sync
        
        container.innerHTML = '';
        proxyConfigs.forEach((p, i) => container.appendChild(renderProxyCard(p, i)));
      });

      clearBtn.addEventListener('click', async () => {
        pc.accepted = false;
        await saveAllConfigs();
        container.innerHTML = '';
        proxyConfigs.forEach((p, i) => container.appendChild(renderProxyCard(p, i)));
      });

      delServerBtn.addEventListener('click', async () => {
        proxyConfigs.splice(index, 1);
        await saveAllConfigs();
        container.innerHTML = '';
        proxyConfigs.forEach((p, i) => container.appendChild(renderProxyCard(p, i)));
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
            await saveAllConfigs();
            renderDomains();
          }
        }
      });

      domainInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addDomainBtn.click();
      });

      [hostInput, portInput, userInput, passInput].forEach(el => {
        el.addEventListener('input', () => {
          pc.host = hostInput.value.trim();
          pc.port = portInput.value.trim();
          pc.username = userInput.value.trim();
          pc.password = passInput.value.trim();
          saveAllConfigs();
        });
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
        host: '',
        port: '',
        username: '',
        password: '',
        accepted: false,
        domains: []
      };
      proxyConfigs.push(newPc);
      renderAll();
      // Scroll to bottom
      container.lastElementChild?.scrollIntoView({ behavior: 'smooth' });
    };

    window.addEventListener('pagehide', () => {
      saveAllConfigs(true);
    });

    renderAll();
  }

  await loadProxyRouterUI();

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
