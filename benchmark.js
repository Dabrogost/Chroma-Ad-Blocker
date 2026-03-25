const { performance } = require('perf_hooks');

const HIDE_SELECTORS = [
  '.ytp-ad-overlay-container', '.ytp-ad-overlay-slot', '.ytp-ad-text-overlay',
  '.ytp-ad-image-overlay', '.ytp-ad-progress', '.ytp-ad-progress-list',
  '.ytd-display-ad-renderer', 'ytd-display-ad-renderer', '#masthead-ad',
  'ytd-banner-promo-renderer', '#banner-ad', '#player-ads',
  '.ytd-promoted-sparkles-web-renderer', 'ytd-promoted-sparkles-web-renderer',
  '.ytd-promoted-video-renderer', 'ytd-promoted-video-renderer',
  'ytd-search-pyv-renderer', 'ytd-ad-slot-renderer', 'ytd-in-feed-ad-layout-renderer',
  'ytd-reel-shelf-renderer[is-ad]', '.ytd-mealbar-promo-renderer',
  'ytd-mealbar-promo-renderer', '.ytp-suggested-action'
];

const WARNING_SELECTORS = [
  'tp-yt-iron-overlay-backdrop', 'ytd-enforcement-message-view-model',
  '.ytd-enforcement-message-view-model', '#header-ad-container',
  '.yt-playability-error-supported-renderers'
];

const WARNING_SELECTOR_COMBINED = WARNING_SELECTORS.join(',');

let CONFIG = {
  suppressWarnings: true
};

let stats = { blocked: 0 };

// Mock DOM setup (simplified)
const mockNode = {
  querySelectorAll: () => {
    // Return an array of mock elements
    return Array(5).fill({ remove: () => {} });
  }
};
const mockDocument = {
  querySelectorAll: mockNode.querySelectorAll,
  querySelector: () => null,
  body: {
    style: {
      removeProperty: () => {}
    }
  }
};

function suppressAdblockWarnings(node) {
  if (!CONFIG.suppressWarnings) return;

  const els = (node || mockDocument).querySelectorAll(WARNING_SELECTOR_COMBINED);
  els.forEach(el => {
    el.remove();
    stats.blocked++;
  });

  const video = mockDocument.querySelector('video');
  if (video && video.paused) {
    const hasEnforcement = mockDocument.querySelector('ytd-enforcement-message-view-model');
    if (!hasEnforcement) {
      video.play().catch(() => {});
    }
  }

  if (mockDocument.body) {
    mockDocument.body.style.removeProperty('overflow');
  }
}

function removeLeftoverAdContainers() {
  const adElements = mockDocument.querySelectorAll(
    '[id*="ad-container"], [id*="ad_container"], [class*="ad-slot"]'
  );
  adElements.forEach(el => {
    if (el.id !== 'yt-chroma-cosmetic') {
      el.style = { display: 'none' };
    }
  });
}

function runBenchmark(callback, label, runs) {
  const mutations = [{ addedNodes: [1] }];

  const start = performance.now();
  for (let i = 0; i < runs; i++) {
    callback(mutations);
  }
  const end = performance.now();
  const time = end - start;

  console.log(`${label}: ${time.toFixed(2)}ms for ${runs} runs`);
  return time;
}

// 1. Original
function originalCallback(mutations) {
  if (mutations.some(m => m.addedNodes.length > 0)) {
    suppressAdblockWarnings();
    removeLeftoverAdContainers();
  }
}

// 2. Throttled RequestAnimationFrame (ideal for visual updates)
let rAFPending = false;
function rafCallback(mutations) {
  if (!rAFPending && mutations.some(m => m.addedNodes.length > 0)) {
    rAFPending = true;
    // mock requestAnimationFrame
    setTimeout(() => {
      suppressAdblockWarnings();
      removeLeftoverAdContainers();
      rAFPending = false;
    }, 16); // ~60fps
  }
}

async function run() {
  console.log("=== MutationObserver Performance Benchmark ===");
  const runs = 10000; // 10k rapid mutations

  const originalTime = runBenchmark(originalCallback, "Original (Unthrottled)", runs);

  const rafTime = runBenchmark(rafCallback, "Throttled (requestAnimationFrame mock)", runs);

  // Wait for the final execution
  await new Promise(resolve => setTimeout(resolve, 50));

  const improvement = ((originalTime - rafTime) / originalTime) * 100;
  console.log(`\nImprovement: ${improvement.toFixed(2)}% faster main-thread execution during mutation bursts.`);
}

run();
