const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  attach,
  closeTarget,
  evaluate,
  repoRoot,
  startExtensionBrowser,
  waitFor
} = require('./helpers/extension-fixture');

const fixtureUrl = 'https://www.youtube.com/watch?v=chroma-handshake';

async function evaluateInWorld(cdp, sessionId, contextId, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, contextId, awaitPromise: true, returnByValue: true
  }, sessionId);
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description);
  return result.result.value;
}

// Pause the actual manifest-injected isolated script immediately before its
// storage read. Hold only that promise, allowing the real MAIN script and page
// scripts to run normally. No extension code is substituted or reinjected.
async function createHandshakePage(browser) {
  const { cdp } = browser;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const sessionId = await attach(cdp, targetId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Debugger.enable', {}, sessionId);
  let protectionContext;
  let storageHeld = false;
  let pauseError;
  const removeScriptListener = cdp.on('Debugger.scriptParsed', event => {
    if (event.url === `chrome-extension://${browser.extensionId}/content/protection.js`) {
      protectionContext = event.executionContextId;
    }
  }, sessionId);
  const source = fs.readFileSync(path.join(repoRoot, 'extension/content/protection.js'), 'utf8');
  const storageLine = source.split(/\r?\n/).findIndex(line => line.includes("chrome.storage.local.get(['config', 'whitelist'])"));
  assert.ok(storageLine >= 0, 'initial storage read must be found for the debugger fixture');
  const breakpoint = await cdp.send('Debugger.setBreakpointByUrl', {
    url: `chrome-extension://${browser.extensionId}/content/protection.js`, lineNumber: storageLine
  }, sessionId);
  const removePauseListener = cdp.on('Debugger.paused', event => {
    (async () => {
      try {
        assert.ok(event.hitBreakpoints.includes(breakpoint.breakpointId));
        const result = await cdp.send('Debugger.evaluateOnCallFrame', {
          callFrameId: event.callFrames[0].callFrameId,
          expression: `(() => {
            // Delay only isolated-world handling of the first real ACK. MAIN
            // still receives INIT and commits normally, while an old isolated
            // 500ms timer would close the live port before this queued callback.
            const handlerDescriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
            const delayed = globalThis.__chromaE2EReadyDelay = { scheduled: 0, delivered: 0, elapsed: 0 };
            Object.defineProperty(MessagePort.prototype, 'onmessage', {
              ...handlerDescriptor,
              set(handler) {
                if (typeof handler !== 'function') return Reflect.apply(handlerDescriptor.set, this, [handler]);
                const port = this;
                return Reflect.apply(handlerDescriptor.set, port, [event => {
                  if (event.data?.type === 'CHROMA_READY' && delayed.scheduled === 0) {
                    Object.defineProperty(MessagePort.prototype, 'onmessage', handlerDescriptor);
                    delayed.scheduled++;
                    const started = performance.now();
                    setTimeout(() => {
                      Reflect.apply(handler, port, [event]);
                      delayed.delivered++;
                      delayed.elapsed = performance.now() - started;
                    }, 650);
                    return;
                  }
                  Reflect.apply(handler, port, [event]);
                }]);
              }
            });
            const originalGet = chrome.storage.local.get;
            chrome.storage.local.get = function(...args) {
              chrome.storage.local.get = originalGet;
              const actualRead = Reflect.apply(originalGet, chrome.storage.local, args);
              return new Promise((resolve, reject) => {
                globalThis.__chromaE2EReleaseStorage = () => {
                  delete globalThis.__chromaE2EReleaseStorage;
                  actualRead.then(resolve, reject);
                };
              });
            };
            return true;
          })()`,
          returnByValue: true
        }, sessionId);
        assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description);
        storageHeld = true;
        await cdp.send('Debugger.removeBreakpoint', breakpoint, sessionId);
      } catch (error) {
        pauseError = error;
      } finally {
        await cdp.send('Debugger.resume', {}, sessionId);
      }
    })().catch(error => { pauseError = error; });
  }, sessionId);

  const html = `<!doctype html><html><head><title>Hostile handshake fixture</title>
    <script>
      (() => {
        const NativeCustomEvent = window.CustomEvent;
        const fixture = window.__handshakeFixture = {
          bridgeAtPageStart: !!window.__CHROMA_INTERNAL__,
          revisionAtPageStart: window.__CHROMA_INTERNAL__?.revision,
          capturedEvents: [], constructedEvents: [], prototypeTokens: [],
          forgedPrototypeReads: 0, propagationOrder: []
        };
        for (const type of ['__CHROMA_MAIN_READY__', '__CHROMA_CONFIG_DELIVERY__']) {
          window.addEventListener(type, event => {
            if (!event.detail?.readyToken?.startsWith('page-forged-')) {
              fixture.capturedEvents.push({ type, detail: event.detail });
            }
          }, true);
        }
        window.CustomEvent = new Proxy(NativeCustomEvent, {
          construct(target, args) {
            if (args[0] === '__CHROMA_MAIN_READY__' || args[0] === '__CHROMA_CONFIG_DELIVERY__') {
              fixture.constructedEvents.push({ type: args[0], detail: args[1]?.detail });
            }
            return Reflect.construct(target, args);
          }
        });
        // Native WebIDL dictionary conversion reads inherited EventInit fields.
        // Capturing CustomEvent alone does not protect a normal options object
        // from this later page-installed Object.prototype getter.
        Object.defineProperty(Object.prototype, 'bubbles', {
          configurable: true,
          get() {
            const token = this.detail?.readyToken;
            if (typeof token === 'string') {
              if (token.startsWith('page-forged-')) fixture.forgedPrototypeReads++;
              else fixture.prototypeTokens.push(token);
            }
            return false;
          }
        });
        fixture.forgeReady = count => {
          for (let i = 0; i < count; i++) {
            window.dispatchEvent(new NativeCustomEvent('__CHROMA_MAIN_READY__', {
              detail: { readyToken: 'page-forged-ready-token-' + i }
            }));
          }
        };
        fixture.forgeUpdate = () => document.dispatchEvent(new NativeCustomEvent('__CHROMA_CONFIG_UPDATE__', {
          detail: { enabled: false, stripping: false, acceleration: true, accelerationSpeed: 16 }
        }));
        // Establish that this browser really exposes document-targeted events
        // to window capture before a document capture handler can stop them.
        window.addEventListener('chroma-capture-control', () => fixture.propagationOrder.push('window'), true);
        document.addEventListener('chroma-capture-control', event => {
          fixture.propagationOrder.push('document');
          event.stopImmediatePropagation();
        }, true);
        document.dispatchEvent(new NativeCustomEvent('chroma-capture-control'));
        fixture.forgeReady(1000);
      })();
    </script></head><body>Handshake fixture</body></html>`;
  const removeFetchListener = cdp.on('Fetch.requestPaused', event => {
    cdp.send('Fetch.fulfillRequest', {
      requestId: event.requestId,
      responseCode: event.resourceType === 'Document' ? 200 : 204,
      responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }],
      body: Buffer.from(event.resourceType === 'Document' ? html : '').toString('base64')
    }, sessionId).catch(() => {});
  }, sessionId);
  try {
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
    await cdp.send('Page.navigate', { url: fixtureUrl }, sessionId);
    await waitFor(async () => {
      if (pauseError) throw pauseError;
      return storageHeld && protectionContext && await evaluate(cdp, sessionId, '!!window.__handshakeFixture');
    }, 'hostile page with delayed isolated storage');
    if (pauseError) throw pauseError;
    assert.strictEqual(await evaluateInWorld(cdp, sessionId, protectionContext,
      'typeof globalThis.__chromaE2EReleaseStorage'), 'function');
    return {
      sessionId,
      releaseStorage: () => evaluateInWorld(cdp, sessionId, protectionContext, 'globalThis.__chromaE2EReleaseStorage()'),
      readyDelayState: () => evaluateInWorld(cdp, sessionId, protectionContext, 'globalThis.__chromaE2EReadyDelay'),
      close: async () => {
        removeScriptListener();
        removePauseListener();
        removeFetchListener();
        await closeTarget(cdp, targetId);
      }
    };
  } catch (error) {
    removeScriptListener();
    removePauseListener();
    removeFetchListener();
    await closeTarget(cdp, targetId);
    throw error;
  }
}

test('secure handshake across real extension execution worlds', async t => {
  const browser = await startExtensionBrowser();
  let original;
  let page;
  t.after(async () => {
    try {
      if (page) await page.close();
      if (original) await evaluate(browser.cdp, browser.workerSession, `chrome.storage.local.set(${JSON.stringify(original)})`);
    } finally {
      await browser.cleanup();
    }
  });
  original = await evaluate(browser.cdp, browser.workerSession, "chrome.storage.local.get(['config', 'whitelist'])");
  const configured = { ...original.config, enabled: true, stripping: true, acceleration: false, accelerationSpeed: 7 };
  await evaluate(browser.cdp, browser.workerSession,
    `chrome.storage.local.set({config: ${JSON.stringify(configured)}, whitelist: []})`);
  page = await createHandshakePage(browser);

  await t.test('window capture, replaced CustomEvent, and inherited WebIDL getters cannot inspect handshake secrets', async () => {
    // Give MAIN's real READY timer multiple turns while storage is held and
    // the parser-installed hostile listeners and constructor are already live.
    await evaluate(browser.cdp, page.sessionId, 'new Promise(resolve => setTimeout(resolve, 80))');
    const before = await evaluate(browser.cdp, page.sessionId, `({
      ...window.__handshakeFixture,
      revision: window.__CHROMA_INTERNAL__?.revision,
      enabled: window.__CHROMA_INTERNAL__?.config.enabled
    })`);
    assert.strictEqual(before.bridgeAtPageStart, true, 'manifest MAIN injection precedes normal page scripts');
    assert.strictEqual(before.revisionAtPageStart, 0);
    assert.deepStrictEqual(before.propagationOrder, ['window', 'document']);
    assert.strictEqual(before.revision, 0, 'MAIN stays inert pending authoritative storage');
    assert.strictEqual(before.enabled, false);
    assert.deepStrictEqual(before.capturedEvents, [], 'no real READY challenge reaches hostile window capture');
    assert.deepStrictEqual(before.constructedEvents, [], 'MAIN uses its captured CustomEvent constructor');
    assert.ok(before.forgedPrototypeReads >= 1000, 'native WebIDL conversion exercises the hostile prototype getter');
    assert.deepStrictEqual(before.prototypeTokens, [], 'native EventInit conversion cannot expose the real challenge');
    await page.releaseStorage();
    await evaluate(browser.cdp, page.sessionId, 'window.__handshakeFixture.forgeReady(1000)');
    await waitFor(() => evaluate(browser.cdp, page.sessionId,
      'window.__CHROMA_INTERNAL__?.revision > 0 && window.__CHROMA_INTERNAL__.config.accelerationSpeed === 7'),
    'authenticated initialization despite forged READY bursts');
    const after = await evaluate(browser.cdp, page.sessionId, `({
      captured: window.__handshakeFixture.capturedEvents,
      constructed: window.__handshakeFixture.constructedEvents,
      prototypeTokens: window.__handshakeFixture.prototypeTokens,
      config: window.__CHROMA_INTERNAL__.config,
      frozen: Object.isFrozen(window.__CHROMA_INTERNAL__),
      descriptor: Object.getOwnPropertyDescriptor(window, '__CHROMA_INTERNAL__')
    })`);
    assert.deepStrictEqual(after.captured, [], 'neither challenge nor config-delivery nonce reaches window capture');
    assert.deepStrictEqual(after.constructed, []);
    assert.deepStrictEqual(after.prototypeTokens, [], 'no genuine token reaches inherited dictionary getters');
    assert.deepStrictEqual(after.config, { enabled: true, stripping: true, acceleration: false, accelerationSpeed: 7 });
    assert.strictEqual(after.frozen, true);
    assert.strictEqual(after.descriptor.writable, false);
    assert.strictEqual(after.descriptor.configurable, false);
  });

  await t.test('a queued CHROMA_READY delayed beyond 500ms keeps the committed private channel usable', async () => {
    const delay = await waitFor(async () => {
      const state = await page.readyDelayState();
      return state.delivered === 1 ? state : null;
    }, 'isolated callback receives delayed CHROMA_READY');
    assert.strictEqual(delay.scheduled, 1);
    assert.ok(delay.elapsed > 500, 'the isolated ACK callback runs after the old 500ms deadline');
    const tabs = await evaluate(browser.cdp, browser.workerSession, `chrome.tabs.query({url: ${JSON.stringify(fixtureUrl)}})`);
    assert.strictEqual(tabs.length, 1);
    await evaluate(browser.cdp, browser.workerSession,
      `chrome.tabs.sendMessage(${tabs[0].id}, {type: 'CONFIG_UPDATE', config: {accelerationSpeed: 9}})`);
    await waitFor(() => evaluate(browser.cdp, page.sessionId, 'window.__CHROMA_INTERNAL__.config.accelerationSpeed === 9'),
      'private port remains usable after delayed ACK');
  });

  await t.test('private port preserves runtime config, rejects page updates, and follows whitelist changes', async () => {
    await evaluate(browser.cdp, page.sessionId, 'window.__handshakeFixture.forgeUpdate()');
    assert.strictEqual(await evaluate(browser.cdp, page.sessionId, 'window.__CHROMA_INTERNAL__.config.enabled'), true);
    const tabs = await evaluate(browser.cdp, browser.workerSession, `chrome.tabs.query({url: ${JSON.stringify(fixtureUrl)}})`);
    assert.strictEqual(tabs.length, 1);
    await evaluate(browser.cdp, browser.workerSession,
      `chrome.tabs.sendMessage(${tabs[0].id}, {type: 'CONFIG_UPDATE', config: {accelerationSpeed: 11}})`);
    await waitFor(() => evaluate(browser.cdp, page.sessionId, 'window.__CHROMA_INTERNAL__.config.accelerationSpeed === 11'),
      'runtime config over authenticated port');
    await evaluate(browser.cdp, browser.workerSession, "chrome.storage.local.set({whitelist: ['youtube.com']})");
    await waitFor(() => evaluate(browser.cdp, page.sessionId,
      '!window.__CHROMA_INTERNAL__.config.enabled && !window.__CHROMA_INTERNAL__.config.stripping'), 'live whitelist deactivation');
    await evaluate(browser.cdp, browser.workerSession, 'chrome.storage.local.set({whitelist: []})');
    await waitFor(() => evaluate(browser.cdp, page.sessionId,
      'window.__CHROMA_INTERNAL__.config.enabled && window.__CHROMA_INTERNAL__.config.stripping && window.__CHROMA_INTERNAL__.config.accelerationSpeed === 11'),
    'master config restored after whitelist removal');
  });
});
