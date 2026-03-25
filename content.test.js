
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * Creates a robust mock DOM element for the sandbox
 */
function createMockElement(tag = 'div') {
  const classes = new Set();
  const children = [];
  const el = {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c) => {
        if (classes.has(c)) {
          classes.delete(c);
          return false;
        } else {
          classes.add(c);
          return true;
        }
      }
    },
    style: {
      setProperty: () => {},
      removeProperty: () => {},
      display: '',
      width: '',
      height: ''
    },
    dataset: {},
    appendChild: (child) => {
      children.push(child);
      child.parentElement = el;
      return child;
    },
    remove: () => {},
    closest: (selector) => null,
    contains: (other) => children.includes(other),
    textContent: '',
    innerHTML: '',
    querySelector: (selector) => null,
    querySelectorAll: () => [],
    parentElement: null,
    getAttribute: () => null,
    setAttribute: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dataset: {}
  };

  // Getter/setter for className to sync with classList
  Object.defineProperty(el, 'className', {
    get: () => Array.from(classes).join(' '),
    set: (val) => {
      classes.clear();
      if (val) {
        val.split(/\s+/).forEach(c => classes.add(c));
      }
    }
  });

  return el;
}

// Read content.js
const contentJsCode = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');

test('notifyBackground error handling', async (t) => {
  // Setup sandbox with required globals for content.js
  const chromeMock = {
    runtime: {
      sendMessage: () => {},
      onMessage: {
        addListener: () => {}
      }
    }
  };

  const sandbox = {
    chrome: chromeMock,
    document: {
      readyState: 'complete',
      createElement: (tag) => createMockElement(tag),
      getElementById: () => null,
      querySelector: () => createMockElement(),
      querySelectorAll: () => [],
      head: createMockElement('head'),
      body: createMockElement('body'),
      documentElement: createMockElement('html'),
      addEventListener: () => {},
      removeEventListener: () => {},
      getElementsByClassName: () => []
    },
    setInterval: () => {},
    clearInterval: () => {},
    setTimeout: (fn) => fn(),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (cb) => {},
    console: console,
    Object: Object,
    Array: Array,
    Number: Number,
    String: String,
    Boolean: Boolean,
    Math: Math,
    Date: Date,
    Promise: Promise,
    Error: Error,
    window: { 
      location: { hostname: 'www.youtube.com' },
      addEventListener: () => {},
      removeEventListener: () => {},
      requestAnimationFrame: (cb) => {},
      innerHeight: 1000,
      innerWidth: 1000
    },
    location: { hostname: 'www.youtube.com' }
  };

  vm.createContext(sandbox);
  vm.runInContext(contentJsCode, sandbox);

  await t.test('should not crash when chrome.runtime.sendMessage throws an immediate error', () => {
    let called = false;
    chromeMock.runtime.sendMessage = (msg) => {
      called = true;
      throw new Error('Immediate failure');
    };

    assert.doesNotThrow(() => {
      sandbox.notifyBackground({ type: 'TEST' });
    });

    assert.strictEqual(called, true);
  });

  await t.test('should not crash when chrome.runtime.sendMessage returns a rejected promise', () => {
    let called = false;
    chromeMock.runtime.sendMessage = (msg) => {
      called = true;
      return Promise.reject('Async failure');
    };

    assert.doesNotThrow(() => {
      sandbox.notifyBackground({ type: 'TEST' });
    });

    assert.strictEqual(called, true);
  });

  await t.test('should send message successfully when no error occurs', () => {
    let called = false;
    chromeMock.runtime.sendMessage = (msg) => {
      called = true;
      return Promise.resolve();
    };

    sandbox.notifyBackground({ type: 'SUCCESS' });

    assert.strictEqual(called, true);
  });
});

test('injectCosmeticCSS functionality', async (t) => {
  // Common setup function for creating the sandbox
  const createSandbox = (setupDoc) => {
    const sandbox = {
      chrome: {
        runtime: {
          sendMessage: () => Promise.resolve(),
          onMessage: { addListener: () => {} }
        }
      },
      document: {
        readyState: 'complete',
        createElement: (tag) => createMockElement(tag),
        getElementById: () => null,
        querySelector: () => createMockElement(),
        querySelectorAll: () => [],
        head: createMockElement('head'),
        body: createMockElement('body'),
        documentElement: createMockElement('html'),
        addEventListener: () => {},
        removeEventListener: () => {},
        getElementsByClassName: () => []
      },
      setInterval: () => {},
      clearInterval: () => {},
      setTimeout: (fn) => fn(),
      requestAnimationFrame: (cb) => {},
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      console: console,
      Object: Object,
      Array: Array,
      Number: Number,
      String: String,
      Boolean: Boolean,
      Math: Math,
      Date: Date,
      Promise: Promise,
      Error: Error,
      window: { 
        location: { hostname: 'www.youtube.com' },
        addEventListener: () => {},
        removeEventListener: () => {},
        requestAnimationFrame: (cb) => {},
        innerHeight: 1000,
        innerWidth: 1000
      },
      location: { hostname: 'www.youtube.com' }
    };

    // Apply document overrides
    setupDoc(sandbox.document);

    vm.createContext(sandbox);
    // Execute content.js which calls injectCosmeticCSS() during init()
    vm.runInContext(contentJsCode, sandbox);
    return sandbox;
  };

  await t.test('should append style element to document.head when present', () => {
    let appendedChild = null;
    let createdElement = null;

    const sandbox = createSandbox((doc) => {
      doc.createElement = (tag) => {
        createdElement = createMockElement(tag);
        return createdElement;
      };
      doc.head = createMockElement('head');
      doc.head.appendChild = (child) => {
        appendedChild = child;
      };
      doc.documentElement = createMockElement('html');
      doc.documentElement.appendChild = () => {
        throw new Error('Should not append to documentElement if head exists');
      };
    });

    // We can call injectCosmeticCSS manually to test explicitly
    sandbox.injectCosmeticCSS();

    assert.ok(appendedChild, 'A child should have been appended');
    assert.strictEqual(appendedChild, createdElement, 'Appended child should be the created element');
    assert.strictEqual(appendedChild.tagName, 'STYLE', 'Created element should be a <style>');
    assert.strictEqual(appendedChild.id, 'yt-chroma-cosmetic', 'Should have correct ID');
    assert.ok(appendedChild.textContent.includes('display: none !important'), 'Should contain display: none !important');
    assert.ok(appendedChild.textContent.includes('visibility: hidden !important'), 'Should contain visibility: hidden !important');
  });

  await t.test('should fallback to appending to document.documentElement when head is missing', () => {
    let appendedChild = null;
    let createdElement = null;

    const sandbox = createSandbox((doc) => {
      doc.createElement = (tag) => {
        createdElement = createMockElement(tag);
        return createdElement;
      };
      // Simulate document.head missing
      doc.head = null;
      doc.documentElement = createMockElement('html');
      doc.documentElement.appendChild = (child) => {
        appendedChild = child;
      };
    });

    sandbox.injectCosmeticCSS();

    assert.ok(appendedChild, 'A child should have been appended to documentElement');
    assert.strictEqual(appendedChild, createdElement, 'Appended child should be the created element');
    assert.strictEqual(appendedChild.id, 'yt-chroma-cosmetic', 'Should have correct ID');
  });
});

test('removeLeftoverAdContainers functionality', async (t) => {
  const createSandbox = (setupDoc) => {
    const sandbox = {
      chrome: {
        runtime: {
          sendMessage: () => Promise.resolve(),
          onMessage: { addListener: () => {} }
        }
      },
      document: {
        readyState: 'complete',
        createElement: (tag) => createMockElement(tag),
        getElementById: () => null,
        querySelector: () => createMockElement(),
        querySelectorAll: () => [],
        head: createMockElement('head'),
        body: createMockElement('body'),
        documentElement: createMockElement('html'),
        addEventListener: () => {},
        removeEventListener: () => {},
        getElementsByClassName: () => []
      },
      setInterval: () => {},
      clearInterval: () => {},
      setTimeout: (fn) => fn(),
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      console: console,
      Object: Object,
      Array: Array,
      Number: Number,
      String: String,
      Boolean: Boolean,
      Math: Math,
      Date: Date,
      Promise: Promise,
      Error: Error,
      requestAnimationFrame: (cb) => {},
      window: { 
        location: { hostname: 'www.youtube.com' },
        addEventListener: () => {},
        removeEventListener: () => {},
        requestAnimationFrame: (cb) => {},
        innerHeight: 1000,
        innerWidth: 1000
      },
      location: { hostname: 'www.youtube.com' }
    };

    if (setupDoc) setupDoc(sandbox.document);

    vm.createContext(sandbox);
    vm.runInContext(contentJsCode, sandbox);
    return sandbox;
  };

  await t.test('should set display to none for matching ad containers', () => {
    const ad1 = createMockElement(); ad1.id = 'ad-container-1';
    ad1.matches = (sel) => sel.includes('ad-container');
    const ad2 = createMockElement(); ad2.id = 'some_ad_container_2';
    ad2.matches = (sel) => sel.includes('ad_container');
    const ad3 = createMockElement(); ad3.className = 'ad-slot-3'; // id will be empty string ''

    const sandbox = createSandbox((doc) => {
      doc.querySelectorAll = (selector) => {
        if (selector.includes('ad-container') || selector.includes('ad_container')) {
          return [ad1, ad2, ad3];
        }
        return [];
      };
    });

    sandbox.removeLeftoverAdContainers();

    assert.strictEqual(ad1.style.display, 'none');
    assert.strictEqual(ad2.style.display, 'none');
    assert.strictEqual(ad3.style.display, 'none');
  });

  await t.test('should trigger ad session when skip button is present', () => {
    const skipBtn = createMockElement();
    skipBtn.className = 'ytp-ad-skip-button';
    
    const sandbox = createSandbox((doc) => {
      doc.querySelector = (sel) => {
        if (sel.includes('ytp-ad-skip-button')) return skipBtn;
        if (sel === 'video') return createMockElement('video');
        return null;
      };
    });

    sandbox.handleAdAcceleration();
    assert.strictEqual(sandbox.window.chromaAdSessionActive, true, 'Session should be active when skip button is found');
  });

  await t.test('should ignore elements with id "yt-chroma-cosmetic"', () => {
    const cosmeticStyleEl = createMockElement(); cosmeticStyleEl.id = 'yt-chroma-cosmetic';
    cosmeticStyleEl.matches = (sel) => sel.includes('ad-container');
    const ad = createMockElement(); ad.id = 'ad-container';
    ad.matches = (sel) => sel.includes('ad-container');

    const sandbox = createSandbox((doc) => {
      doc.querySelectorAll = (selector) => {
        if (selector.includes('ad-container') || selector.includes('ad_container')) {
          return [cosmeticStyleEl, ad];
        }
        return [];
      };
    });

    sandbox.removeLeftoverAdContainers();

    assert.strictEqual(cosmeticStyleEl.style.display, '');
    assert.strictEqual(ad.style.display, 'none');
  });

  await t.test('should not throw error if no elements are found', () => {
    const sandbox = createSandbox((doc) => {
      doc.querySelectorAll = () => [];
    });

    assert.doesNotThrow(() => {
      sandbox.removeLeftoverAdContainers();
    });
  });
});

test('signalMainWorld functionality', async (t) => {
  const createSandbox = () => {
    const sandbox = {
      chrome: {
        runtime: {
          sendMessage: () => Promise.resolve(),
          onMessage: { addListener: () => {} }
        }
      },
      document: {
        readyState: 'complete',
        createElement: (tag) => createMockElement(tag),
        getElementById: () => null,
        querySelector: () => createMockElement(),
        querySelectorAll: () => [],
        head: createMockElement('head'),
        body: createMockElement('body'),
        documentElement: {
          dataset: {}
        },
        addEventListener: () => {},
        removeEventListener: () => {},
        getElementsByClassName: () => []
      },
      setInterval: () => {},
      clearInterval: () => {},
      setTimeout: (fn) => fn(),
      requestAnimationFrame: (cb) => {},
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      console: console,
      Object: Object,
      Array: Array,
      Number: Number,
      String: String,
      Boolean: Boolean,
      Math: Math,
      Date: Date,
      Promise: Promise,
      Error: Error,
      window: {
        location: { hostname: 'www.youtube.com' },
        addEventListener: () => {},
        removeEventListener: () => {},
        requestAnimationFrame: (cb) => {},
        innerHeight: 1000,
        innerWidth: 1000
      },
      location: { hostname: 'www.youtube.com' }
    };

    vm.createContext(sandbox);
    vm.runInContext(contentJsCode, sandbox);
    return sandbox;
  };

  await t.test('should set dataset.ytChromaPushActive to "true" when enabled and blockPushNotifications is true', () => {
    const sandbox = createSandbox();
    vm.runInContext(`
      CONFIG.enabled = true;
      CONFIG.blockPushNotifications = true;
      signalMainWorld();
    `, sandbox);
    assert.strictEqual(sandbox.document.documentElement.dataset.ytChromaPushActive, 'true');
  });

  await t.test('should delete dataset.ytChromaPushActive when enabled is false', () => {
    const sandbox = createSandbox();
    vm.runInContext(`
      // Setup initial state
      CONFIG.enabled = true;
      CONFIG.blockPushNotifications = true;
      signalMainWorld();

      // Test the false condition
      CONFIG.enabled = false;
      signalMainWorld();
    `, sandbox);
    assert.strictEqual(sandbox.document.documentElement.dataset.ytChromaPushActive, undefined);
  });

  await t.test('should delete dataset.ytChromaPushActive when blockPushNotifications is false', () => {
    const sandbox = createSandbox();
    vm.runInContext(`
      // Setup initial state
      CONFIG.enabled = true;
      CONFIG.blockPushNotifications = true;
      signalMainWorld();

      // Test the false condition
      CONFIG.blockPushNotifications = false;
      signalMainWorld();
    `, sandbox);
    assert.strictEqual(sandbox.document.documentElement.dataset.ytChromaPushActive, undefined);
  });
});

test('updateAdOverlay functionality', async (t) => {
  const createSandbox = () => {
    const sandbox = {
      CONFIG: {
        acceleration: true,
        enabled: true
      },
      chrome: {
        runtime: {
          sendMessage: () => Promise.resolve(),
          onMessage: { addListener: () => {} }
        }
      },
      document: {
        readyState: 'complete',
        createElement: (tag) => createMockElement(tag),
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        head: createMockElement('head'),
        body: createMockElement('body'),
        documentElement: createMockElement('html'),
        addEventListener: () => {},
        removeEventListener: () => {},
        getElementsByClassName: () => []
      },
      window: {
        location: { hostname: 'www.youtube.com' },
        addEventListener: () => {},
        removeEventListener: () => {},
        requestAnimationFrame: (cb) => {},
        innerHeight: 1000,
        innerWidth: 1000
      },
      setInterval: () => {},
      clearInterval: () => {},
      setTimeout: (fn) => fn(),
      requestAnimationFrame: (cb) => {},
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      console: { log: () => {}, warn: () => {}, error: () => {} },
      Object, Array, Number, String, Boolean, Math, Date, Promise, Error, parseInt,
      location: { hostname: 'www.youtube.com' }
    };
    vm.createContext(sandbox);
    vm.runInContext(contentJsCode, sandbox);
    return sandbox;
  };

  await t.test('exits early and resets state when effectiveAdShowing is false', () => {
    const sandbox = createSandbox();
    const adOverlayObj = createMockElement();
    adOverlayObj.classList.add('active');

    sandbox.adOverlayObj = adOverlayObj;

    // Set up existing state
    vm.runInContext(`
      adOverlay = adOverlayObj;
      window.cachedCurrentAd = 5;
      window.cachedTotalAds = 5;
      window.lastVideoDuration = 100;
      updateAdOverlay({}, false, false);
    `, sandbox);

    assert.strictEqual(adOverlayObj.classList.contains('active'), false);
    assert.strictEqual(sandbox.window.cachedCurrentAd, 1);
    assert.strictEqual(sandbox.window.cachedTotalAds, 1);
    assert.strictEqual(sandbox.window.lastVideoDuration, 0);
  });

  await t.test('initializes adOverlay if it does not exist', () => {
    const sandbox = createSandbox();
    const playerContainer = createMockElement();
    const videoObj = createMockElement('video');
    videoObj.closest = (sel) => sel === '.html5-video-player' ? playerContainer : null;

    // Mock document.querySelector to return playerContainer for initAdOverlay
    sandbox.document.querySelector = (sel) => {
      if (sel === '.html5-video-player' || sel === '#movie_player') return playerContainer;
      return null;
    };
    sandbox.videoObj = videoObj;

    vm.runInContext(`
      adOverlay = null; // Ensure null initially
      // Need to mock getElementById to return null so initAdOverlay runs
      document.getElementById = () => null;
      updateAdOverlay(videoObj, true, true);

      // Because adOverlay is defined in content.js without 'var' or 'let' at the top scope
      // in VM context sometimes it isn't properly exported to sandbox root unless explicitly assigned.
      // But actually, adOverlay is declared with 'let adOverlay = null;' in content.js
      // We need to fetch it explicitly.
      this.exportedAdOverlay = adOverlay;
    `, sandbox);

    assert.ok(sandbox.exportedAdOverlay);
    assert.strictEqual(sandbox.exportedAdOverlay.id, 'yt-chroma-overlay');
    assert.strictEqual(playerContainer.contains(sandbox.exportedAdOverlay), true);
    assert.strictEqual(sandbox.exportedAdOverlay.classList.contains('active'), true);
  });

  await t.test('updates trackers when rawAdShowing is true and parses player text', () => {
    const sandbox = createSandbox();
    const playerContainer = createMockElement();
    playerContainer.textContent = 'Ad 1 of 2';

    const videoObj = createMockElement('video');
    videoObj.closest = () => playerContainer;
    videoObj.duration = 15;
    videoObj.currentTime = 5;
    sandbox.videoObj = videoObj;

    vm.runInContext(`
      adOverlay = document.createElement('div');
      adOverlay.querySelector = () => document.createElement('div');
      window.cachedCurrentAd = 1;
      window.cachedTotalAds = 1;
      window.lastVideoDuration = 0;

      updateAdOverlay(videoObj, true, true);
    `, sandbox);

    assert.strictEqual(sandbox.window.cachedCurrentAd, 1);
    assert.strictEqual(sandbox.window.cachedTotalAds, 2);
    assert.strictEqual(sandbox.window.lastVideoDuration, 15);
  });

  await t.test('morphs spinner to checkmark when ad finishes', () => {
    const sandbox = createSandbox();
    const playerContainer = createMockElement();
    const videoObj = createMockElement('video');
    videoObj.closest = () => playerContainer;
    videoObj.duration = 30;
    videoObj.currentTime = 29.8; // < 0.5 difference => isAdMediaFinished = true

    const adOverlayObj = createMockElement();
    const spinner = createMockElement();
    spinner.className = 'chroma-spinner';
    const title = createMockElement();
    title.className = 'chroma-title';

    adOverlayObj.querySelector = (sel) => {
      if (sel === '.chroma-spinner, .chroma-checkmark') return spinner;
      if (sel === '.chroma-title') return title;
      return null;
    };

    sandbox.adOverlayObj = adOverlayObj;
    sandbox.videoObj = videoObj;

    vm.runInContext(`
      adOverlay = adOverlayObj;
      window.cachedCurrentAd = 2;
      window.cachedTotalAds = 2; // isOnFinalAd = true

      updateAdOverlay(videoObj, true, false); // rawAdShowing is false
    `, sandbox);

    assert.strictEqual(spinner.className, 'chroma-checkmark');
    assert.strictEqual(title.textContent, 'Ads Cleared');
  });
});
