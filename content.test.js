
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
      createElement: () => ({ style: {}, appendChild: () => {} }),
      head: { appendChild: () => {} },
      documentElement: { appendChild: () => {} },
      readyState: 'complete',
      addEventListener: () => {},
      querySelector: () => {},
      querySelectorAll: () => [],
      body: { style: { removeProperty: () => {} } }
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
    Promise: Promise,
    Error: Error
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
        addEventListener: () => {},
        querySelector: () => {},
        querySelectorAll: () => [],
        body: { style: { removeProperty: () => {} } }
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
      Promise: Promise,
      Error: Error
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
        createdElement = { tag };
        return createdElement;
      };
      doc.head = {
        appendChild: (child) => {
          appendedChild = child;
        }
      };
      doc.documentElement = {
        appendChild: () => {
          throw new Error('Should not append to documentElement if head exists');
        }
      };
    });

    // We can call injectCosmeticCSS manually to test explicitly
    sandbox.injectCosmeticCSS();

    assert.ok(appendedChild, 'A child should have been appended');
    assert.strictEqual(appendedChild, createdElement, 'Appended child should be the created element');
    assert.strictEqual(appendedChild.tag, 'style', 'Created element should be a <style>');
    assert.strictEqual(appendedChild.id, 'yt-shield-cosmetic', 'Should have correct ID');
    assert.ok(appendedChild.textContent.includes('display: none !important'), 'Should contain display: none !important');
    assert.ok(appendedChild.textContent.includes('visibility: hidden !important'), 'Should contain visibility: hidden !important');
  });

  await t.test('should fallback to appending to document.documentElement when head is missing', () => {
    let appendedChild = null;
    let createdElement = null;

    const sandbox = createSandbox((doc) => {
      doc.createElement = (tag) => {
        createdElement = { tag };
        return createdElement;
      };
      // Simulate document.head missing
      doc.head = null;
      doc.documentElement = {
        appendChild: (child) => {
          appendedChild = child;
        }
      };
    });

    sandbox.injectCosmeticCSS();

    assert.ok(appendedChild, 'A child should have been appended to documentElement');
    assert.strictEqual(appendedChild, createdElement, 'Appended child should be the created element');
    assert.strictEqual(appendedChild.id, 'yt-shield-cosmetic', 'Should have correct ID');
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
        addEventListener: () => {},
        querySelector: () => {},
        querySelectorAll: () => [],
        body: { style: { removeProperty: () => {} } },
        createElement: () => ({ style: {}, appendChild: () => {} }),
        head: { appendChild: () => {} },
        documentElement: { appendChild: () => {} }
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
      Promise: Promise,
      Error: Error,
      requestAnimationFrame: (cb) => cb()
    };

    if (setupDoc) setupDoc(sandbox.document);

    vm.createContext(sandbox);
    vm.runInContext(contentJsCode, sandbox);
    return sandbox;
  };

  await t.test('should set display to none for matching ad containers', () => {
    let queriedSelector = null;
    const ad1 = { id: 'ad-container-1', style: {}, remove: () => {} };
    const ad2 = { id: 'some_ad_container_2', style: {}, remove: () => {} };
    const ad3 = { className: 'ad-slot-3', style: {}, remove: () => {} };

    const sandbox = createSandbox((doc) => {
      doc.querySelectorAll = (selector) => {
        queriedSelector = selector;
        return [ad1, ad2, ad3];
      };
    });

    sandbox.removeLeftoverAdContainers();

    assert.strictEqual(queriedSelector, '[id*="ad-container"], [id*="ad_container"], [class*="ad-slot"]');
    assert.strictEqual(ad1.style.display, 'none');
    assert.strictEqual(ad2.style.display, 'none');
    assert.strictEqual(ad3.style.display, 'none');
  });

  await t.test('should ignore elements with id "yt-shield-cosmetic"', () => {
    const cosmeticStyleEl = { id: 'yt-shield-cosmetic', style: {}, remove: () => {} };
    const ad = { id: 'ad-container', style: {}, remove: () => {} };

    const sandbox = createSandbox((doc) => {
      doc.querySelectorAll = () => [cosmeticStyleEl, ad];
    });

    sandbox.removeLeftoverAdContainers();

    assert.strictEqual(cosmeticStyleEl.style.display, undefined);
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
