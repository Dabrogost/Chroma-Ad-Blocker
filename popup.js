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
  };

  $('toggleAcceleration').checked = config.acceleration ?? true;
  $('toggleCosmetic').checked = config.cosmetic ?? true;
  $('toggleWarnings').checked = config.suppressWarnings ?? true;

  // Load stats
  const stats = await sendBg({ type: 'GET_STATS' }) || { blocked: 0, accelerated: 0 };
  $('statAccelerated').textContent = stats.accelerated ?? 0;
  $('statBlocked').textContent = stats.blocked ?? 0;

  // Toggle handlers
  const TOGGLES = [
    ['toggleAcceleration', 'acceleration'],
    ['toggleCosmetic',     'cosmetic'],
    ['toggleWarnings',     'suppressWarnings'],
  ];

  for (const [elId, key] of TOGGLES) {
    $(elId).addEventListener('change', async (e) => {
      await sendBg({ type: 'SET_CONFIG', config: { [key]: e.target.checked } });
    });
  }

  // Reset stats
  $('resetStats').addEventListener('click', async () => {
    await sendBg({ type: 'RESET_STATS' });
    $('statAccelerated').textContent = '0';
    $('statBlocked').textContent = '0';
  });
}

init();
