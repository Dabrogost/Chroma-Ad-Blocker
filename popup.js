'use strict';

const $ = id => document.getElementById(id);

async function sendBg(msg) {
  return chrome.runtime.sendMessage(msg).catch(err => {
    console.warn('[YT Chroma] Messaging error (Worker waking up?):', err);
    return null; 
  });
}

async function init() {
  // Load config
  const config = await sendBg({ type: 'GET_CONFIG' }) || {
    networkBlocking: true,
    acceleration: true,
    cosmetic: true,
    hideShorts: false,
    hideMerch: true,
    hideOffers: true,
    suppressWarnings: true,
    blockPopUnders: true,
    blockPushNotifications: true,
    enabled: true,
  };

  const isEnabled = config.enabled ?? true;
  $('toggleEnabled').checked = isEnabled;
  updateStatusDot(isEnabled);

  $('toggleNetwork').checked = isEnabled ? (config.networkBlocking ?? true) : false;
  $('toggleAcceleration').checked = isEnabled ? (config.acceleration ?? true) : false;
  $('toggleCosmetic').checked = isEnabled ? (config.cosmetic ?? true) : false;
  $('toggleShorts').checked = isEnabled ? (config.hideShorts ?? false) : false;
  $('toggleMerch').checked = isEnabled ? (config.hideMerch ?? true) : false;
  $('toggleOffers').checked = isEnabled ? (config.hideOffers ?? true) : false;
  $('toggleWarnings').checked = isEnabled ? (config.suppressWarnings ?? true) : false;
  $('togglePopUnders').checked = isEnabled ? (config.blockPopUnders ?? true) : false;
  $('togglePush').checked = isEnabled ? (config.blockPushNotifications ?? true) : false;

  // Load stats
  const stats = await sendBg({ type: 'GET_STATS' }) || { networkBlocked: 0, accelerated: 0 };
  $('statAccelerated').textContent = stats.accelerated ?? 0;
  $('statNetworkBlocked').textContent = stats.networkBlocked ?? 0;

  // Toggle handlers
  const TOGGLES = [
    ['toggleNetwork',      'networkBlocking'],
    ['toggleAcceleration', 'acceleration'],
    ['toggleCosmetic',     'cosmetic'],
    ['toggleShorts',       'hideShorts'],
    ['toggleMerch',        'hideMerch'],
    ['toggleOffers',       'hideOffers'],
    ['toggleWarnings',     'suppressWarnings'],
    ['togglePopUnders',    'blockPopUnders'],
    ['togglePush',         'blockPushNotifications'],
  ];

  for (const [elId, key] of TOGGLES) {
    $(elId).addEventListener('change', async (e) => {
      const isChecked = e.target.checked;
      await sendBg({ type: 'SET_CONFIG', config: { [key]: isChecked } });
      
      // If any individual toggle is turned on, ensure master is also on
      if (isChecked && !$('toggleEnabled').checked) {
        $('toggleEnabled').checked = true;
        updateStatusDot(true);
        await sendBg({ type: 'SET_CONFIG', config: { enabled: true } });
      } else if (!isChecked) {
        const anyOn = TOGGLES.some(([id]) => $(id).checked);
        if (!anyOn) {
          $('toggleEnabled').checked = false;
          updateStatusDot(false);
          await sendBg({ type: 'SET_CONFIG', config: { enabled: false } });
        }
      }
    });
  }

  // Master toggle handler
  $('toggleEnabled').addEventListener('change', async (e) => {
    const isEnabled = e.target.checked;
    updateStatusDot(isEnabled);
    
    // We only update the 'enabled' flag in the background, 
    // NOT the individual feature flags. This lets us restore them.
    await sendBg({ type: 'SET_CONFIG', config: { enabled: isEnabled } });

    if (!isEnabled) {
      // Visually turn off all sub-toggles (but don't save to config)
      for (const [elId] of TOGGLES) {
        $(elId).checked = false;
      }
    } else {
      // Restore visual state from the actual (persistent) config
      const config = await sendBg({ type: 'GET_CONFIG' });
      if (config) {
        $('toggleNetwork').checked = config.networkBlocking ?? true;
        $('toggleAcceleration').checked = config.acceleration ?? true;
        $('toggleCosmetic').checked = config.cosmetic ?? true;
        $('toggleShorts').checked = config.hideShorts ?? false;
        $('toggleMerch').checked = config.hideMerch ?? true;
        $('toggleOffers').checked = config.hideOffers ?? true;
        $('toggleWarnings').checked = config.suppressWarnings ?? true;
        $('togglePopUnders').checked = config.blockPopUnders ?? true;
        $('togglePush').checked = config.blockPushNotifications ?? true;
      }
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

  // Reset stats
  $('resetStats').addEventListener('click', async () => {
    await sendBg({ type: 'RESET_STATS' });
    $('statAccelerated').textContent = '0';
    $('statNetworkBlocked').textContent = '0';
  });
}

init();
