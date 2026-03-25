
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * Creates a robust mock DOM element for the sandbox
 */
function createMockElement(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    classList: {
      add: () => {},
      remove: () => {},
      contains: () => false,
      toggle: () => {}
    },
    style: {
      setProperty: () => {},
      removeProperty: () => {},
      display: '',
      width: '',
      height: ''
    },
    dataset: {},
    appendChild: (child) => child,
    remove: () => {},
    closest: (selector) => null,
    contains: (other) => false,
    textContent: '',
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => [],
    parentElement: null,
    getAttribute: () => null,
    setAttribute: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dataset: {}
  };
  el.classList.add = () => {};
  el.classList.remove = () => {};
  el.classList.contains = () => false;
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

test('startExtensionServices functionality', async (t) => {
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

  await t.test('should call all required startup functions', () => {
    const sandbox = createSandbox();

    // Setup tracking for all the functions that should be called
    vm.runInContext(`
      calls = {
        startObserver: false,
        startPolling: false,
        suppressAdblockWarnings: false,
        signalMainWorld: false,
        startChromaClock: false,
        initSkipButtonListener: false,
        initAdOverlay: false
      };

      // Mock the functions to track calls
      startObserver = () => calls.startObserver = true;
      startPolling = () => calls.startPolling = true;
      suppressAdblockWarnings = () => calls.suppressAdblockWarnings = true;
      signalMainWorld = () => calls.signalMainWorld = true;
      startChromaClock = () => calls.startChromaClock = true;
      initSkipButtonListener = () => calls.initSkipButtonListener = true;
      initAdOverlay = () => calls.initAdOverlay = true;

      // Call the function under test
      startExtensionServices();
    `, sandbox);

    // Verify all functions were called
    assert.strictEqual(sandbox.calls.startObserver, true, 'startObserver should be called');
    assert.strictEqual(sandbox.calls.startPolling, true, 'startPolling should be called');
    assert.strictEqual(sandbox.calls.suppressAdblockWarnings, true, 'suppressAdblockWarnings should be called');
    assert.strictEqual(sandbox.calls.signalMainWorld, true, 'signalMainWorld should be called');
    assert.strictEqual(sandbox.calls.startChromaClock, true, 'startChromaClock should be called');
    assert.strictEqual(sandbox.calls.initSkipButtonListener, true, 'initSkipButtonListener should be called');
    assert.strictEqual(sandbox.calls.initAdOverlay, true, 'initAdOverlay should be called');
  });
});
