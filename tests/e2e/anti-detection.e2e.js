const test = require('node:test');
const assert = require('node:assert/strict');
const {
  attach, closeTarget, createPage, evaluate, openExtensionPage, refreshExtensionWorker, sendRuntimeMessage,
  startExtensionBrowser, waitFor
} = require('./helpers/extension-fixture');

// Real extension registrations execute against deterministic site fixtures.
// No production scripts are substituted or manually injected into the page.
async function fixture(browser, hostname, embedded = false) {
  const { cdp } = browser;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const sessionId = await attach(cdp, targetId);
  await cdp.send('Page.enable', {}, sessionId);
  const removeListener = cdp.on('Fetch.requestPaused', event => {
    const host = new URL(event.request.url).hostname;
    const mlive = host === 'www.mlive.com';
    const pinterest = host === 'www.pinterest.com';
    const html = `<!doctype html><html><head><script>
      window.__state = { canary: window.__NATIVEADS_CANARY__ === true };
      ${pinterest ? `
        window.__pins = JSON.parse('{"resource_response":{"data":[{"id":"ad","pin_promotion_id":"campaign"},{"id":"organic"}]}}');
      ` : ''}
      window.addEventListener('message', event => {
        if (event.origin === 'https://geo.dailymotion.com') window.__child = event.data;
      });
      ${mlive ? `
        window._sp_ = { consent: 'preserved' };
        try { window._sp_._networkListenerData; window.__state.detectorBlocked = false; }
        catch (_) { window.__state.detectorBlocked = true; }
        window.__state.consent = window._sp_.consent;
        window.__state.loaderStub = typeof window.admiral === 'function' && window.admrlLoaded === true;
      ` : ''}
    </script></head><body>
      <div class="ad-test" style="height:10px">bait</div>
      <div class="WatchingDiscovery__adSection___fixture">display ad</div>
      ${pinterest ? `<main id="feed">
        <div id="organic" data-grid-item="true"><a href="/pin/123/">Sponsored post design ideas</a></div>
        <div id="promoted" data-grid-item="true"><a href="https://example.com/?item=1&amp;epik=campaign">Promoted</a></div>
        <div id="one-tap" data-grid-item="true"><div data-test-pin-id="ad"><div data-test-id="one-tap-desktop-ad"><a href="https://example.com/" rel="nofollow">Ad</a></div></div></div>
        <div id="new-ad" data-grid-item="true"><span data-test-id="x3f8q1">Sponsored</span></div>
        <div id="organic-marker" data-grid-item="true"><span data-test-id="x3f8q1"></span><a href="/pin/456/">Organic pin</a></div>
      </main>` : ''}
      ${embedded && host === hostname ? '<iframe src="https://geo.dailymotion.com/player/chroma-fixture"></iframe>' : ''}
      ${mlive ? `<script>
        // admiral recovery payload
        document.createElement('script'); window.__recoveryRan = true;
      </script>` : ''}
      <script>
        document.createElement('article'); window.__ordinaryScriptRan = true;
        window.__ready = true;
        if (window !== window.top) parent.postMessage(window.__state, '*');
      </script>
    </body></html>`;
    cdp.send('Fetch.fulfillRequest', {
      requestId: event.requestId, responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'text/html' }],
      body: Buffer.from(html).toString('base64')
    }, sessionId).catch(() => {});
  }, sessionId);
  try {
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document' }] }, sessionId);
    await cdp.send('Page.navigate', { url: `https://${hostname}/chroma-fixture` }, sessionId);
    await waitFor(() => evaluate(cdp, sessionId,
      `window.__ready && ${embedded ? '!!window.__child' : 'true'}`), 'anti-detection fixture');
    return { sessionId, close: async () => { removeListener(); await closeTarget(cdp, targetId); } };
  } catch (error) {
    removeListener();
    await closeTarget(cdp, targetId);
    throw error;
  }
}

test('bundled site rules in Chrome', async (t) => {
  const browser = await startExtensionBrowser();
  let original;
  let popup;
  const scriptsInitiallyEnabled = await evaluate(browser.cdp, browser.workerSession, '!!chrome.userScripts');
  t.after(async () => {
    try {
      if (original && popup) {
        await evaluate(browser.cdp, browser.workerSession, `chrome.storage.local.set({ whitelist: ${JSON.stringify(original.whitelist || [])} })`);
        await sendRuntimeMessage(browser.cdp, popup.sessionId, { type: 'CONFIG_SET', config: original.config });
      }
      if (!scriptsInitiallyEnabled) {
        const settings = await createPage(browser.cdp, 'chrome://extensions/');
        await evaluate(browser.cdp, settings.sessionId,
          `chrome.developerPrivate.updateExtensionConfiguration({ extensionId: '${browser.extensionId}', userScriptsAccess: false })`);
        await closeTarget(browser.cdp, settings.targetId);
      }
      if (popup) await closeTarget(browser.cdp, popup.targetId);
    } finally { await browser.cleanup(); }
  });
  const settings = await createPage(browser.cdp, 'chrome://extensions/');
  // Modern Chrome requires the same per-extension opt-in documented for users.
  // This changes only the disposable test profile.
  await evaluate(browser.cdp, settings.sessionId,
    `chrome.developerPrivate.updateExtensionConfiguration({ extensionId: '${browser.extensionId}', userScriptsAccess: true })`);
  await closeTarget(browser.cdp, settings.targetId);
  await refreshExtensionWorker(browser);
  original = await evaluate(browser.cdp, browser.workerSession,
    `chrome.storage.local.get(['config', 'whitelist'])`);
  popup = await openExtensionPage(browser.cdp, browser.extensionId, 'ui/popup.html');
  const scripts = () => evaluate(browser.cdp, browser.workerSession, 'chrome.userScripts.getScripts()');
  await evaluate(browser.cdp, browser.workerSession,
    `chrome.storage.local.set({ whitelist: [] })`);
  // The permission may just have been enabled after the worker initialized.
  // Cycle protection through the normal UI messages to await registration.
  for (const enabled of [false, true]) {
    const result = await sendRuntimeMessage(browser.cdp, popup.sessionId,
      { type: 'CONFIG_SET', config: { enabled, cosmetic: true } });
    assert.equal(result.ok, true);
  }
  const refreshed = await sendRuntimeMessage(browser.cdp, popup.sessionId,
    { type: 'SUBSCRIPTION_REFRESH', id: 'chroma-lib' });
  assert.equal(refreshed.ok, true);
  await waitFor(async () => (await scripts()).some(script => script.js?.some(source => source.code?.includes('__NATIVEADS_CANARY__'))),
    'bundled scriptlet registration');

  await t.test('canary is present before page scripts in top-level and embedded players', async () => {
    const page = await fixture(browser, 'www.dailymotion.com', true);
    try {
      assert.deepEqual(await evaluate(browser.cdp, page.sessionId, '({ top: __state.canary, frame: __child.canary })'),
        { top: true, frame: true });
      await waitFor(() => evaluate(browser.cdp, page.sessionId,
        `getComputedStyle(document.querySelector('[class^="WatchingDiscovery"]')).display === 'none'`), 'scoped ad hiding');
      assert.equal(await evaluate(browser.cdp, page.sessionId, 'document.querySelector(".ad-test").offsetHeight'), 10);
    } finally { await page.close(); }
  });

  await t.test('MLive late initialization and recovery are contained while article code runs', async () => {
    const page = await fixture(browser, 'www.mlive.com');
    try {
      assert.deepEqual(await evaluate(browser.cdp, page.sessionId,
        '({ detector: __state.detectorBlocked, consent: __state.consent, loader: __state.loaderStub, recovery: !!window.__recoveryRan, ordinary: __ordinaryScriptRan })'),
      { detector: true, consent: 'preserved', loader: true, recovery: false, ordinary: true });
    } finally { await page.close(); }
  });

  await t.test('Pinterest prunes feed data and hides sponsored cards across scrolling and recycling', async () => {
    const page = await fixture(browser, 'www.pinterest.com');
    try {
      assert.deepEqual(await evaluate(browser.cdp, page.sessionId, '__pins.resource_response.data'), [{ id: 'organic' }]);
      await waitFor(() => evaluate(browser.cdp, page.sessionId,
        `['promoted', 'one-tap', 'new-ad'].every(id => getComputedStyle(document.getElementById(id)).display === 'none')`),
      'Pinterest cosmetic fallback');
      assert.equal(await evaluate(browser.cdp, page.sessionId,
        `['feed', 'organic', 'organic-marker'].every(id => getComputedStyle(document.getElementById(id)).display !== 'none')`), true);
      await evaluate(browser.cdp, page.sessionId, `
        const next = document.getElementById('new-ad').cloneNode(true);
        next.id = 'scroll-ad';
        document.getElementById('feed').appendChild(next);
        document.querySelector('#promoted a').href = '/pin/789/';
        window.__laterPins = JSON.parse('{"resource_response":{"data":{"results":[{"id":"organic"},{"id":"ad","pin_promotion_id":"next-campaign"}],"bookmark":"next"}}}');
      `);
      await waitFor(() => evaluate(browser.cdp, page.sessionId,
        `getComputedStyle(document.getElementById('scroll-ad')).display === 'none' &&
         getComputedStyle(document.getElementById('promoted')).display !== 'none'`), 'new and recycled Pinterest cards');
      assert.deepEqual(await evaluate(browser.cdp, page.sessionId, '__laterPins.resource_response.data'),
        { results: [{ id: 'organic' }], bookmark: 'next' });
    } finally { await page.close(); }
  });

  await t.test('frame whitelist excludes the player without disabling its parent', async () => {
    await evaluate(browser.cdp, browser.workerSession, `chrome.storage.local.set({ whitelist: ['geo.dailymotion.com'] })`);
    await waitFor(async () => {
      const registered = await scripts();
      return registered.length > 0 && registered.every(script => script.excludeMatches?.includes('*://geo.dailymotion.com/*'));
    }, 'frame whitelist registration');
    const page = await fixture(browser, 'www.dailymotion.com', true);
    try {
      assert.deepEqual(await evaluate(browser.cdp, page.sessionId, '({ top: __state.canary, frame: __child.canary })'),
        { top: true, frame: false });
    } finally { await page.close(); }
  });

  await t.test('master off leaves new documents and frames unmodified', async () => {
    const result = await sendRuntimeMessage(browser.cdp, popup.sessionId, { type: 'CONFIG_SET', config: { enabled: false } });
    assert.equal(result.ok, true);
    await waitFor(async () => (await scripts()).length === 0, 'master off unregisters scriptlets');
    const page = await fixture(browser, 'www.dailymotion.com', true);
    try {
      assert.deepEqual(await evaluate(browser.cdp, page.sessionId, '({ top: __state.canary, frame: __child.canary })'),
        { top: false, frame: false });
    } finally { await page.close(); }
  });
});
