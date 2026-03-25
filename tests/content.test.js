
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
const contentJsCode = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

test('notifyBackground error handling', async (t) => {
  // Setup sandbox with required globals for content.js
  const chromeMock = {
    runtime: {
      sendMessage: () => {},
      onMessage: {
        addListener: () => {}
      }
    },
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve()
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
        },
        storage: {
          local: {
            get: () => Promise.resolve({}),
            set: () => Promise.resolve()
          }
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
        },
        storage: {
          local: {
            get: () => Promise.resolve({}),
            set: () => Promise.resolve()
          }
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

  await t.test('should trigger ad session when .ad-showing player is present', () => {
    const playerWithAd = createMockElement();
    playerWithAd.className = 'html5-video-player ad-showing';
    playerWithAd.querySelector = (sel) => {
        if (sel === 'video') return createMockElement('video');
        return null;
    };
    
    const sandbox = createSandbox((doc) => {
      doc.querySelector = (sel) => {
        if (sel.includes('.ad-showing')) return playerWithAd;
        if (sel === 'video') return createMockElement('video');
        return null;
      };
    });

    sandbox.handleAdAcceleration();
    assert.strictEqual(sandbox.window.chromaAdSessionActive, true, 'Session should be active when ad-showing player is found');
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

test('initAdOverlay functionality', async (t) => {
  const createSandbox = (setupDoc) => {
    const sandbox = {
      chrome: {
        runtime: {
          sendMessage: () => Promise.resolve(),
          onMessage: { addListener: () => {} }
        },
        storage: {
          local: {
            get: () => Promise.resolve({}),
            set: () => Promise.resolve()
          }
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

  await t.test('should create ad overlay and append child elements', () => {
    let createdElements = [];
    const sandbox = createSandbox((doc) => {
      const origCreate = doc.createElement;
      doc.createElement = (tag) => {
        const el = origCreate(tag);
        // Track appended children for this test
        el.childrenArray = [];
        el.appendChild = function(child) {
          this.childrenArray.push(child);
          return child;
        };
        createdElements.push(el);
        return el;
      };
    });

    // Evaluate inside sandbox
    vm.runInContext(`
      adOverlay = null;
      initAdOverlay();
    `, sandbox);

    // Evaluate and retrieve the value of adOverlay back from the context
    const overlay = vm.runInContext('adOverlay', sandbox);

    assert.ok(overlay, 'adOverlay should be created');
    assert.strictEqual(overlay.id, 'yt-chroma-overlay');

    // Check children
    const children = overlay.childrenArray || [];
    assert.strictEqual(children.length, 3, 'Should append 3 children');

    const spinner = children.find(c => c.className === 'chroma-spinner');
    assert.ok(spinner, 'Should contain spinner');

    const title = children.find(c => c.className === 'chroma-title');
    assert.ok(title, 'Should contain title');
    assert.strictEqual(title.textContent, 'Chroma Active');

    const subtitle = children.find(c => c.className === 'chroma-subtitle');
    assert.ok(subtitle, 'Should contain subtitle');
    assert.strictEqual(subtitle.textContent, 'Accelerating Ad...');
  });

  await t.test('should not create ad overlay if it already exists', () => {
    let createdElementsCount = 0;
    const mockExistingOverlay = createMockElement('div');
    const sandbox = createSandbox((doc) => {
      doc.getElementById = (id) => {
        if (id === 'yt-chroma-overlay') return mockExistingOverlay;
        return null;
      };
      const origCreate = doc.createElement;
      doc.createElement = (tag) => {
        createdElementsCount++;
        return origCreate(tag);
      };
    });

    // Reset adOverlay to null, and make sure that we reset createdElementsCount
    // in case createSandbox triggered any initialization.
    createdElementsCount = 0;
    vm.runInContext(`
      adOverlay = null;
      initAdOverlay();
    `, sandbox);

    assert.strictEqual(createdElementsCount, 0, 'Should not create any elements if overlay exists');
  });

  await t.test('should append overlay to .html5-video-player if it exists', () => {
    let appendedChild = null;
    const playerMock = createMockElement('div');
    playerMock.className = 'html5-video-player';
    playerMock.appendChild = (child) => {
      appendedChild = child;
    };

    const sandbox = createSandbox((doc) => {
      doc.querySelector = (sel) => {
        if (sel === '.html5-video-player' || sel === '#movie_player') {
          return playerMock;
        }
        return null;
      };
    });

    vm.runInContext(`
      adOverlay = null;
      initAdOverlay();
    `, sandbox);

    assert.ok(appendedChild, 'Overlay should be appended to the player container');
    assert.strictEqual(appendedChild.id, 'yt-chroma-overlay', 'Appended child should be the overlay');
  });

  await t.test('should append overlay to #movie_player if .html5-video-player is absent', () => {
    let appendedChild = null;
    const playerMock = createMockElement('div');
    playerMock.id = 'movie_player';
    playerMock.appendChild = (child) => {
      appendedChild = child;
    };

    const sandbox = createSandbox((doc) => {
      doc.querySelector = (sel) => {
        if (sel === '#movie_player') {
          return playerMock;
        }
        return null;
      };
    });

    vm.runInContext(`
      adOverlay = null;
      initAdOverlay();
    `, sandbox);

    assert.ok(appendedChild, 'Overlay should be appended to the player container');
    assert.strictEqual(appendedChild.id, 'yt-chroma-overlay', 'Appended child should be the overlay');
  });
});

test('signalMainWorld functionality', async (t) => {
  const createSandbox = () => {
    const sandbox = {
      chrome: {
        runtime: {
          sendMessage: () => Promise.resolve(),
          onMessage: { addListener: () => {} }
        },
        storage: {
          local: {
            get: () => Promise.resolve({}),
            set: () => Promise.resolve()
          }
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

test('suppressAdblockWarnings functionality', async (t) => {
  const createSandbox = (setupDoc) => {
    const sandbox = {
      chrome: {
        runtime: {
          sendMessage: () => Promise.resolve(),
          onMessage: { addListener: () => {} }
        },
        storage: {
          local: {
            get: () => Promise.resolve({}),
            set: () => Promise.resolve()
          }
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

  await t.test('should do nothing if disabled', () => {
    const sandbox = createSandbox();
    let removedCount = 0;

    const root = createMockElement();
    root.matches = (sel) => {
        if(sel === sandbox.WARNING_SELECTOR_COMBINED) return true;
        return false;
    };
    root.remove = () => { removedCount++; };

    sandbox.root = root;

    vm.runInContext(`
      CONFIG.enabled = false;
      suppressAdblockWarnings(root);
    `, sandbox);

    assert.strictEqual(removedCount, 0);

    vm.runInContext(`
      CONFIG.enabled = true;
      CONFIG.suppressWarnings = false;
      suppressAdblockWarnings(root);
    `, sandbox);

    assert.strictEqual(removedCount, 0);
  });

  await t.test('should remove root if root matches WARNING_SELECTOR_COMBINED', () => {
    const sandbox = createSandbox();
    let removedCount = 0;

    const root = createMockElement();
    root.matches = () => true;
    root.remove = () => { removedCount++; };

    sandbox.root = root;

    vm.runInContext(`
      CONFIG.enabled = true;
      CONFIG.suppressWarnings = true;
      suppressAdblockWarnings(root);
    `, sandbox);

    assert.strictEqual(removedCount, 1);
  });

  await t.test('should remove matching children elements and increment stats', () => {
    const sandbox = createSandbox();
    let removedCount = 0;

    const el1 = createMockElement(); el1.remove = () => { removedCount++; };
    const el2 = createMockElement(); el2.remove = () => { removedCount++; };

    const root = createMockElement();
    root.querySelectorAll = () => [el1, el2];
    root.matches = () => false;

    sandbox.root = root;

    vm.runInContext(`
      CONFIG.enabled = true;
      CONFIG.suppressWarnings = true;
      suppressAdblockWarnings(root);
    `, sandbox);

    assert.strictEqual(removedCount, 2);
  });

  await t.test('should attempt to play video if it is paused and warnings were removed', () => {
    let playCalled = false;
    const video = createMockElement('video');
    video.paused = true;
    video.play = () => {
      playCalled = true;
      return Promise.resolve();
    };

    const sandbox = createSandbox((doc) => {
      doc.querySelector = (sel) => {
        if (sel === 'video') return video;
        return null;
      };
    });

    const el1 = createMockElement();
    const root = createMockElement();
    root.querySelectorAll = () => [el1];
    root.matches = () => false;

    sandbox.root = root;

    vm.runInContext(`
      CONFIG.enabled = true;
      CONFIG.suppressWarnings = true;
      suppressAdblockWarnings(root);
    `, sandbox);

    assert.strictEqual(playCalled, true);
  });

  await t.test('should not attempt to play video if it is paused and NO warnings were removed', () => {
    let playCalled = false;
    const video = createMockElement('video');
    video.paused = true;
    video.play = () => {
      playCalled = true;
      return Promise.resolve();
    };

    const sandbox = createSandbox((doc) => {
      doc.querySelector = (sel) => {
        if (sel === 'video') return video;
        return null;
      };
    });

    const root = createMockElement();
    root.querySelectorAll = () => []; // No warnings
    root.matches = () => false;

    sandbox.root = root;

    vm.runInContext(`
      CONFIG.enabled = true;
      CONFIG.suppressWarnings = true;
      suppressAdblockWarnings(root);
    `, sandbox);

    assert.strictEqual(playCalled, false);
  });

  await t.test('should remove overflow style from document.body', () => {
    let removedProperty = '';

    const sandbox = createSandbox((doc) => {
      doc.body.style = {
        removeProperty: (prop) => {
          removedProperty = prop;
        }
      };
    });

    vm.runInContext(`
      CONFIG.enabled = true;
      CONFIG.suppressWarnings = true;
      suppressAdblockWarnings();
    `, sandbox);

    assert.strictEqual(removedProperty, 'overflow');
  });
});
