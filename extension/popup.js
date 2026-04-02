'use strict';

const $ = id => document.getElementById(id);

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
    ['toggleAcceleration', 'acceleration',             true],
    ['toggleCosmetic',     'cosmetic',                 true],
    ['toggleShorts',       'hideShorts',               false],
    ['toggleMerch',        'hideMerch',                true],
    ['toggleOffers',       'hideOffers',               true],
    ['toggleWarnings',     'suppressWarnings',         true],
    ['togglePush',         'blockPushNotifications',   true],
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

  // ─── SUBSCRIPTION UI ─────
  /** @param {string} str */
  function escapeHTML(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function loadSubscriptionUI() {
    const list = document.getElementById('subscriptionList');
    if (!list) return;

    const subscriptions = await notifyBackground({ type: MSG.SUBSCRIPTION_GET }) || [];
    const { appliedNetworkRuleCount = 0 } = await chrome.storage.local.get('appliedNetworkRuleCount');
    const totalParsed = subscriptions.reduce((sum, s) => sum + (s.ruleCount?.network || 0), 0);

    if (subscriptions.length === 0) {
      list.innerHTML = '<div class="toggle-row" style="justify-content: center;"><span style="font-size:11px;color:var(--text-muted);">No subscriptions configured.</span></div>';
      return;
    }

    const summaryBar = document.createElement('div');
    summaryBar.style.cssText = 'padding: 8px 14px 4px; font-size: 10px; color: var(--text-muted); text-align: center; letter-spacing: 0.03em;';
    summaryBar.textContent = `${totalParsed.toLocaleString()} parsed · ${appliedNetworkRuleCount.toLocaleString()} applied to network filter`;

    list.innerHTML = '';
    list.appendChild(summaryBar);

    for (const sub of subscriptions) {
      const row = document.createElement('div');
      row.className = 'toggle-row';

      const lastUpdatedText = sub.lastUpdated
        ? new Date(sub.lastUpdated).toLocaleDateString()
        : 'Never';

      const countText = sub.ruleCount
        ? `${sub.ruleCount.network.toLocaleString()} network · ${sub.ruleCount.cosmetic.toLocaleString()} cosmetic`
        : '';

      const safeName  = escapeHTML(sub.name);
      const safeId    = escapeHTML(sub.id);
      const safeError = sub.lastError ? escapeHTML(sub.lastError) : '';

      const errorText = safeError
        ? `<div style="font-size:10px;color:var(--c-red);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${safeError}">Error: ${safeError}</div>`
        : '';

      row.innerHTML = `
        <div class="toggle-info">
          <div class="name">${safeName}</div>
          <div class="desc">Updated: ${lastUpdatedText}${countText ? ' · ' + countText : ''}</div>
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
          <span class="log-url" title="${entry.url}">${formatLogUrl(entry.url)}</span>
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
