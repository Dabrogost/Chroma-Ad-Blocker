const { performance } = require('perf_hooks');

// Mock DOM
class MockElement {
  constructor(tagName, id = '', className = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.className = className;
    this.classList = {
      contains: (c) => this.className.includes(c)
    };
    this.children = [];
    this.parentElement = null;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
  }

  getElementsByClassName(className) {
    let results = [];
    if (this.className.includes(className)) results.push(this);
    for (const child of this.children) {
      results = results.concat(child.getElementsByClassName(className));
    }
    return results;
  }

  querySelector(selector) {
    let results = this.querySelectorAll(selector);
    return results.length > 0 ? results[0] : null;
  }

  querySelectorAll(selector) {
    let results = [];
    // very basic match
    if (selector.startsWith('.') && this.className.includes(selector.substring(1))) {
       results.push(this);
    }
    for (const child of this.children) {
      results = results.concat(child.querySelectorAll(selector));
    }
    return results;
  }

  closest(selector) {
      if (selector === '.html5-video-player' && this.className.includes('html5-video-player')) {
          return this;
      }
      if (this.parentElement) return this.parentElement.closest(selector);
      return null;
  }
}

const documentMock = new MockElement('HTML');
const bodyMock = new MockElement('BODY');
documentMock.appendChild(bodyMock);

// Build a large-ish DOM to simulate youtube
for (let i = 0; i < 2000; i++) {
  const div = new MockElement('DIV', `item-${i}`, `class-${i}`);
  bodyMock.appendChild(div);
}

const videoPlayer = new MockElement('DIV', 'player', 'html5-video-player');
bodyMock.appendChild(videoPlayer);
const videoMock = new MockElement('VIDEO', 'video');
videoPlayer.appendChild(videoMock);


function originalDetect(document, video) {
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

function optimizedDetect(document, video) {
  // Try caching the root player container, then query inside it.
  // Or combine into a single querySelector where possible.
  // Also, we know video is inside .html5-video-player most of the time.
  const player = video ? video.closest('.html5-video-player') : null;
  if (player && player.classList.contains('ad-showing')) {
      return true;
  }

  return document.getElementsByClassName('ad-showing').length > 0 ||
    document.getElementsByClassName('ytp-ad-player-overlay').length > 0 ||
    document.getElementsByClassName('ytp-ad-progress').length > 0 ||
    document.getElementsByClassName('ytp-ad-player-overlay-layout').length > 0 ||
    document.getElementsByClassName('ytp-ad-player-overlay-skip-or-preview').length > 0 ||
    document.querySelector('.html5-video-player.ad-showing, [class*="ytp-ad-persistent-progress-bar"], .ytp-ad-module .ytp-ad-player-overlay, div.video-ads.ytp-ad-module, .ytp-ad-skip-button, .ytp-ad-skip-button-container, .ytp-ad-skip-button-slot, .ytp-ad-skip-button-modern, .ytp-ad-text, .ytp-ad-preview-text, .ytp-ad-simple-ad-badge, .ytp-ad-badge-label') !== null;
}

const ITERATIONS = 10000;

const startOriginal = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  originalDetect(documentMock, videoMock);
}
const endOriginal = performance.now();
const originalTime = endOriginal - startOriginal;


const startOptimized = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  optimizedDetect(documentMock, videoMock);
}
const endOptimized = performance.now();
const optimizedTime = endOptimized - startOptimized;

console.log(`Original: ${originalTime.toFixed(4)}ms`);
console.log(`Optimized: ${optimizedTime.toFixed(4)}ms`);
console.log(`Improvement: ${((originalTime - optimizedTime) / originalTime * 100).toFixed(2)}%`);
