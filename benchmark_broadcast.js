const { performance } = require('perf_hooks');

// Mock chrome API
const chrome = {
  tabs: {
    query: async () => {
      return Array.from({ length: 100 }, (_, i) => ({ id: i }));
    },
    sendMessage: async (id, msg) => {
      // Simulate some async work
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  }
};

async function broadcastSequential() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    await chrome.tabs.sendMessage(tab.id, { type: 'CONFIG_UPDATE' }).catch(() => {});
  }
}

async function broadcastParallel() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(tab =>
    chrome.tabs.sendMessage(tab.id, { type: 'CONFIG_UPDATE' }).catch(() => {})
  ));
}

// But in the original code, `chrome.tabs.sendMessage` wasn't `await`ed!
// Original code:
//       for (const tab of tabs) {
//         chrome.tabs.sendMessage(tab.id, { type: 'CONFIG_UPDATE', config: newConfig }).catch(() => {});
//       }
async function broadcastOriginal() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'CONFIG_UPDATE' }).catch(() => {});
  }
}

async function broadcastOptimized() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type: 'CONFIG_UPDATE' }).catch(() => {})));
}

async function run() {
  console.log("=== Broadcast Performance Benchmark ===");

  // Warm up
  await broadcastOriginal();
  await broadcastOptimized();

  const runs = 1000;

  const startOriginal = performance.now();
  for (let i = 0; i < runs; i++) {
    await broadcastOriginal();
  }
  const endOriginal = performance.now();

  const startOptimized = performance.now();
  for (let i = 0; i < runs; i++) {
    await broadcastOptimized();
  }
  const endOptimized = performance.now();

  console.log(`Original: ${(endOriginal - startOriginal).toFixed(2)}ms`);
  console.log(`Optimized (Promise.all): ${(endOptimized - startOptimized).toFixed(2)}ms`);
  const improvement = ((endOriginal - startOriginal) - (endOptimized - startOptimized)) / (endOriginal - startOriginal) * 100;
  console.log(`Improvement: ${improvement.toFixed(2)}%`);
}

run();
