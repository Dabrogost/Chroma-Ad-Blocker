'use strict';

const $ = id => document.getElementById(id);

async function init() {
  /** @returns {Promise<void>} */
  const manifest = chrome.runtime.getManifest();
  if ($('versionText')) {
    $('versionText').textContent = `v${manifest.version} · MV3`;
  }

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

  const config = await notifyBackground({ type: MSG.CONFIG_GET }) || {};
  const isEnabled = config.enabled !== false;
  
  if ($('toggleEnabled')) {
    $('toggleEnabled').checked = isEnabled;
    updateStatusDot(isEnabled);
  }
  
  syncUI(config, isEnabled);

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

  /** @param {boolean} active */
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
}

init();
