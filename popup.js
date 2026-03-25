'use strict';

const $ = id => document.getElementById(id);

async function sendBg(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function init() {
  // Load config
  const config = await sendBg({ type: 'GET_CONFIG' }) || {
    acceleration: true,
    cosmetic: true,
    suppressWarnings: true,
    blockPopUnders: true,
    blockPushNotifications: true,
    enabled: true,
  };

  const isEnabled = config.enabled ?? true;
  $('toggleEnabled').checked = isEnabled;
  updateStatusDot(isEnabled);

  $('toggleAcceleration').checked = isEnabled ? (config.acceleration ?? true) : false;
  $('toggleCosmetic').checked = isEnabled ? (config.cosmetic ?? true) : false;
  $('toggleWarnings').checked = isEnabled ? (config.suppressWarnings ?? true) : false;
  $('togglePopUnders').checked = isEnabled ? (config.blockPopUnders ?? true) : false;
  $('togglePush').checked = isEnabled ? (config.blockPushNotifications ?? true) : false;

  // Load stats
  const stats = await sendBg({ type: 'GET_STATS' }) || { blocked: 0, accelerated: 0 };
  $('statAccelerated').textContent = stats.accelerated ?? 0;
  $('statBlocked').textContent = stats.blocked ?? 0;

  // Toggle handlers
  const TOGGLES = [
    ['toggleAcceleration', 'acceleration'],
    ['toggleCosmetic',     'cosmetic'],
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
        $('toggleAcceleration').checked = config.acceleration ?? true;
        $('toggleCosmetic').checked = config.cosmetic ?? true;
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
    $('statBlocked').textContent = '0';
  });
}

init();
