const { performance } = require('perf_hooks');

// Simplified selectors for benchmark
const AD_ID_SELECTORS = '[id*="ad-container"], [id*="ad_container"]';
const AD_SLOT_SELECTORS = 'ytd-ad-slot-renderer, .ytd-ad-slot-renderer, #ad-badge';

// Mock DOM
class MockElement {
  constructor(tagName, id = '', className = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.className = className;
    this.children = [];
    this.style = {};
    this.parentElement = null;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
  }

  querySelectorAll(selector) {
    let results = [];
    // Very basic selector matching for benchmark purposes
    if (selector.includes('[id*="ad-container"]')) {
      if (this.id.includes('ad-container')) results.push(this);
    }
    if (selector.includes('ytd-ad-slot-renderer')) {
      if (this.tagName === 'YTD-AD-SLOT-RENDERER') results.push(this);
    }

    for (const child of this.children) {
      results = results.concat(child.querySelectorAll(selector));
    }
    return results;
  }

  closest(selector) {
    if (selector.includes('ytd-rich-item-renderer')) {
        if (this.tagName === 'YTD-RICH-ITEM-RENDERER') return this;
    }
    if (this.parentElement) return this.parentElement.closest(selector);
    return null;
  }

  remove() {}
}

const documentMock = new MockElement('HTML');
const bodyMock = new MockElement('BODY');
documentMock.appendChild(bodyMock);

// Build a large-ish DOM
for (let i = 0; i < 1000; i++) {
  const div = new MockElement('DIV', `item-${i}`);
  bodyMock.appendChild(div);
  if (i % 100 === 0) {
      const ad = new MockElement('YTD-AD-SLOT-RENDERER', `ad-${i}`);
      div.appendChild(ad);
  }
}

function originalRemoveLeftoverAdContainers(doc) {
  const adIds = doc.querySelectorAll(AD_ID_SELECTORS);
  adIds.forEach(el => {
    el.style.display = 'none';
    el.remove();
  });

  const adSlots = doc.querySelectorAll(AD_SLOT_SELECTORS);
  adSlots.forEach(slot => {
    const parent = slot.closest('ytd-rich-item-renderer, ytd-rich-section-renderer');
    if (parent) {
      parent.style.display = 'none';
      parent.remove();
    } else {
      slot.style.display = 'none';
      slot.remove();
    }
  });
}

function optimizedRemoveLeftoverAdContainers(root) {
  const adIds = root.querySelectorAll(AD_ID_SELECTORS);
  adIds.forEach(el => {
    el.style.display = 'none';
    el.remove();
  });

  const adSlots = root.querySelectorAll(AD_SLOT_SELECTORS);
  adSlots.forEach(slot => {
    const parent = slot.closest('ytd-rich-item-renderer, ytd-rich-section-renderer');
    if (parent) {
      parent.style.display = 'none';
      parent.remove();
    } else {
      slot.style.display = 'none';
      slot.remove();
    }
  });
}

function runBenchmark() {
  const mutations = [];
  for (let i = 0; i < 100; i++) {
    const newDiv = new MockElement('DIV', `new-item-${i}`);
    if (i % 10 === 0) {
        newDiv.appendChild(new MockElement('YTD-AD-SLOT-RENDERER', `new-ad-${i}`));
    }
    mutations.push(newDiv);
  }

  console.log("Starting Benchmark...");

  // Baseline: Global query for each mutation
  const startOriginal = performance.now();
  for (const node of mutations) {
    bodyMock.appendChild(node);
    originalRemoveLeftoverAdContainers(documentMock);
  }
  const endOriginal = performance.now();
  const originalTime = endOriginal - startOriginal;

  // Cleanup for second run
  mutations.forEach(m => {
      // simulate removal from body
      bodyMock.children = bodyMock.children.filter(c => c !== m);
  });

  // Optimized: Scoped query for each mutation
  const startOptimized = performance.now();
  for (const node of mutations) {
    bodyMock.appendChild(node);
    optimizedRemoveLeftoverAdContainers(node);
  }
  const endOptimized = performance.now();
  const optimizedTime = endOptimized - startOptimized;

  console.log(`Original (Global Query): ${originalTime.toFixed(4)}ms`);
  console.log(`Optimized (Scoped Query): ${optimizedTime.toFixed(4)}ms`);
  console.log(`Improvement: ${((originalTime - optimizedTime) / originalTime * 100).toFixed(2)}%`);
}

runBenchmark();
