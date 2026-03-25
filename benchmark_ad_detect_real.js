const { performance } = require('perf_hooks');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;

const dom = new JSDOM(`<!DOCTYPE html><html><body><div class="html5-video-player"><video></video></div></body></html>`);
const document = dom.window.document;
const video = document.querySelector('video');

// Add some elements
for (let i=0; i<1000; i++) {
  const div = document.createElement('div');
  div.className = `dummy-class-${i}`;
  document.body.appendChild(div);
}

function originalDetect() {
  return document.getElementsByClassName('ad-showing').length > 0 ||
    document.getElementsByClassName('ytp-ad-player-overlay').length > 0 ||
    document.getElementsByClassName('ytp-ad-progress').length > 0 ||
    document.getElementsByClassName('ytp-ad-player-overlay-layout').length > 0 ||
    document.getElementsByClassName('ytp-ad-player-overlay-skip-or-preview').length > 0 ||
    document.querySelector('.html5-video-player.ad-showing') !== null ||
    document.querySelector('[class*="ytp-ad-persistent-progress-bar"]') !== null ||
    document.querySelector('.ytp-ad-module .ytp-ad-player-overlay') !== null ||
    document.querySelector('div.video-ads.ytp-ad-module') !== null ||
    document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-container, .ytp-ad-skip-button-slot, .ytp-ad-skip-button-modern') !== null ||
    document.querySelector('.ytp-ad-text, .ytp-ad-preview-text, .ytp-ad-simple-ad-badge, .ytp-ad-badge-label') !== null ||
    (video && video.closest('.html5-video-player')?.classList?.contains('ad-showing'));
}

let _cachedPlayer = null;

const AD_SELECTORS = [
    '.html5-video-player.ad-showing',
    '[class*="ytp-ad-persistent-progress-bar"]',
    '.ytp-ad-module .ytp-ad-player-overlay',
    'div.video-ads.ytp-ad-module',
    '.ytp-ad-skip-button, .ytp-ad-skip-button-container, .ytp-ad-skip-button-slot, .ytp-ad-skip-button-modern',
    '.ytp-ad-text, .ytp-ad-preview-text, .ytp-ad-simple-ad-badge, .ytp-ad-badge-label'
].join(',');

function optimizedDetect() {
  // Try caching the root player, which contains almost all of these elements
  if (video) {
      if (!_cachedPlayer || !document.contains(_cachedPlayer)) {
          _cachedPlayer = video.closest('.html5-video-player');
      }
      if (_cachedPlayer && _cachedPlayer.classList.contains('ad-showing')) {
          return true;
      }
  }

  // Fast path: getElementsByClassName is O(1) in live collections or very fast
  if (
    document.getElementsByClassName('ad-showing').length > 0 ||
    document.getElementsByClassName('ytp-ad-player-overlay').length > 0 ||
    document.getElementsByClassName('ytp-ad-progress').length > 0 ||
    document.getElementsByClassName('ytp-ad-player-overlay-layout').length > 0 ||
    document.getElementsByClassName('ytp-ad-player-overlay-skip-or-preview').length > 0
  ) {
      return true;
  }

  // Slow path: scoped querySelector inside the cached player is vastly faster than querying entire document
  if (_cachedPlayer) {
      return _cachedPlayer.querySelector(AD_SELECTORS) !== null;
  }

  // Fallback: full document query
  return document.querySelector(AD_SELECTORS) !== null;
}

const ITERATIONS = 10000;

const startOriginal = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  originalDetect();
}
const endOriginal = performance.now();
const originalTime = endOriginal - startOriginal;

const startOptimized = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  optimizedDetect();
}
const endOptimized = performance.now();
const optimizedTime = endOptimized - startOptimized;

console.log(`Original: ${originalTime.toFixed(4)}ms`);
console.log(`Optimized: ${optimizedTime.toFixed(4)}ms`);
console.log(`Improvement: ${((originalTime - optimizedTime) / originalTime * 100).toFixed(2)}%`);
