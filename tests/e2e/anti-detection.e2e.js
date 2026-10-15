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
    </script>
      ${host.startsWith('streame.center') || host.includes('clearstreamdv.com') || host === 'embed.sportspatrika.com' ? `<script>
        // The live bootstrap tries several unrelated ad domains in succession.
        const options = [["popundersPerIP", "0"]];
        window.__popunderBootstrap = true;
      </script>` : ''}
    </head><body>
      <div class="ad-test" style="height:10px">bait</div>
      <a id="fake-play" href="https://knowacaliforniafarmer.com/4/campaign">Full HD Play Now</a>
      <a id="stream-provider" href="https://hitcast.st/totview.php?src=https://streame.center/embed/ch48.php">Watch</a>
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

// Reduced loader behaviours: parser scripts, delayed config-inserted scripts,
// and popup listeners. Every response is local; no ad destinations are opened.
async function streamingFixture(browser, hostname) {
  const cdp = browser.cdp;
  const page = await createPage(cdp, 'about:blank');
  const dynamicAd = `/* adserverDomain */
    document.addEventListener('pointerdown', () => { window.__stream.adClicks++; });
    window.__stream.dynamicAd = true;
    setTimeout(() => { window.__stream.delayedAd = true; }, 0);`;
  const removeListener = cdp.on('Fetch.requestPaused', event => {
    const url = new URL(event.request.url);
    const child = url.pathname === '/chroma-stream-frame';
    const html = `<!doctype html><html><head><script>
      window.__stream = { parserAd: false, redirectLoader: false, dynamicAd: false,
        delayedAd: false, adClicks: 0, played: 0, opens: 0 };
      window.open = () => { window.__stream.opens++; return null; };
      window.addEventListener('message', event => { window.__frameStream = event.data; });
    </script><script>
      /* adserverDomain */ window.__stream.parserAd = true;
    </script><script>
      /* unloaded_at */ window.__stream.redirectLoader = true;
    </script></head><body>
      <button id="play">Play</button><a id="watch" href="#watch-stream">Watch stream</a>
      ${child ? '' : '<iframe src="/chroma-stream-frame"></iframe>'}
      <script>
        document.getElementById('play').addEventListener('click', () => { window.__stream.played++; });
        document.addEventListener('keydown', () => window.open('about:blank'));
        // As in the captured player, the payload comes from fetch().json(),
        // so the bootstrap script itself does not contain the ad signature.
        window.addEventListener('load', async () => {
          const data = await fetch('/chroma-ad-config').then(r => r.json());
          const script = document.createElement('script');
          script.textContent = data.html;
          document.body.append(script);
          setTimeout(() => {
            document.getElementById('play').click();
            document.getElementById('watch').click();
            document.dispatchEvent(new Event('pointerdown'));
            document.dispatchEvent(new Event('keydown'));
            window.__stream.watch = location.hash === '#watch-stream';
            window.__stream.ready = true;
            if (parent !== window) parent.postMessage(window.__stream, '*');
          }, 30);
        });
      </script></body></html>`;
    const documentRequest = event.resourceType === 'Document';
    cdp.send('Fetch.fulfillRequest', {
      requestId: event.requestId, responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: documentRequest ? 'text/html' : 'application/json' }],
      body: Buffer.from(documentRequest ? html : JSON.stringify({ html: dynamicAd })).toString('base64')
    }, page.sessionId).catch(() => {});
  }, page.sessionId);
  try {
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, page.sessionId);
    await cdp.send('Page.navigate', { url: `https://${hostname}/chroma-stream-test` }, page.sessionId);
    await waitFor(() => evaluate(cdp, page.sessionId, 'window.__stream?.ready && window.__frameStream?.ready'),
      'streaming fixtures finish in parent and frame');
    return await evaluate(cdp, page.sessionId, '({ top: __stream, frame: __frameStream })');
  } finally {
    removeListener();
    await closeTarget(cdp, page.targetId);
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

  await t.test('streaming loaders stop while player buttons and native stream links work', async () => {
    for (const host of ['www.nflbite.is', 'links.nflbite.st', 'links.nflbite.run', 'live5.totalsportek.vg',
      'crackstreams.mx', 'crackstreams.courses', 'emb.apl601.online', 'methstreams.gs', 'streameast.fi',
      'fsportshdz.xyz', 'taifood-blog.asia', 'trendy48.online']) {
      const result = await streamingFixture(browser, host);
      for (const state of [result.top, result.frame]) {
        assert.deepEqual(state, { parserAd: false, redirectLoader: false, dynamicAd: false,
          delayedAd: false, adClicks: 0, played: 1, opens: host.endsWith('totalsportek.vg') ? 0 : 1,
          watch: true, ready: true }, host);
      }
    }
    const control = await streamingFixture(browser, 'nflbite.is.example');
    assert.equal(control.top.parserAd, true);
    assert.equal(control.top.redirectLoader, true);
    assert.equal(control.top.dynamicAd, true);
    assert.equal(control.top.delayedAd, true);
    assert.equal(control.top.adClicks, 1);
  });

  await t.test('streamed inline scripts stay blocked across separate network chunks', async () => {
    const http = require('node:http');
    const server = http.createServer(async (_req, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      // Separate writes reproduce the live loader's initially empty script,
      // text-node insertion, characterData updates, and remaining payload.
      for (const chunk of ['<!doctype html><html><head><script>',
        '/* adserver', 'Domain */', 'window.__streamedAdRan = true;', '</script></head><body>',
        '<script>window.__streamedReady = true;</script></body></html>']) {
        response.write(chunk);
        await new Promise(resolve => setTimeout(resolve, 60));
      }
      response.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const id = 'e2e_streamed_inline_script';
    try {
      for (const enabled of [false, true]) {
        if (enabled) {
          const source = (await scripts()).find(script => script.matches.some(pattern => pattern.includes('nflbite.run')) &&
            script.js.some(js => js.code?.includes('function removeNodeText')));
          assert.ok(source, 'use the production bundled remover');
          await evaluate(browser.cdp, browser.workerSession, `chrome.userScripts.register([${JSON.stringify({
            ...source, id, matches: ['http://127.0.0.1/*']
          })}])`);
        }
        const page = await createPage(browser.cdp, url);
        try {
          await waitFor(() => evaluate(browser.cdp, page.sessionId, 'window.__streamedReady'), 'chunked response parsed');
          assert.equal(await evaluate(browser.cdp, page.sessionId, '!!window.__streamedAdRan'), !enabled);
        } finally { await closeTarget(browser.cdp, page.targetId); }
      }
    } finally {
      await evaluate(browser.cdp, browser.workerSession, `chrome.userScripts.unregister({ ids: ['${id}'] })`);
      await new Promise(resolve => server.close(resolve));
    }
  });

  await t.test('captured external ad and detection scripts are blocked without blocking the player CDN', async () => {
    const requests = [
      ['https://fsportshdz.xyz/tgeFF869ex.js', 'https://fsportshdz.xyz'],
      ['https://trendy48.online/adcash-auto.js', 'https://trendy48.online'],
      ['https://crack-streams.st/ER2V869ex.js', 'https://crack-streams.st'],
      ['https://footy4u.st/V8695ex.js', 'https://footy4u.st'],
      ['https://hitcast.st/WEDasd869ex.js', 'https://hitcast.st'],
      ['https://cdn.jsdelivr.net/gh/vli-platform/adb-analytics@29f6e17/v1.0.min.js', 'https://hitcast.st'],
      ['https://musikazblai.org/22/996927b366b66157a89e1a943b00f855', 'https://hitcast.st']
    ];
    for (const [url, initiator] of requests) {
      const result = await evaluate(browser.cdp, browser.workerSession, `chrome.declarativeNetRequest.testMatchOutcome({
        url: ${JSON.stringify(url)}, type: 'script',
        initiator: ${JSON.stringify(initiator)}, tabId: -1
      })`);
      assert.ok(result.matchedRules.length > 0, url);
    }
    for (const [url, initiator] of [
      ['https://cdn.jsdelivr.net/npm/@clappr/player@0.14.5/dist/clappr.min.js', 'https://streame.center'],
      ['https://cdn.jsdelivr.net/npm/@clappr/level-selector@1.1.0/dist/level-selector.min.js', 'https://streame.center'],
      ['https://footy4u.st/player.js', 'https://footy4u.st'],
      ['https://cdn.jsdelivr.net/gh/vli-platform/adb-analytics@29f6e17/v1.0.min.js', 'https://example.com']
    ]) {
      const result = await evaluate(browser.cdp, browser.workerSession, `chrome.declarativeNetRequest.testMatchOutcome({
        url: ${JSON.stringify(url)}, type: 'script', initiator: ${JSON.stringify(initiator)}, tabId: -1
      })`);
      assert.equal(result.matchedRules.length, 0, `outside the scoped block: ${url} from ${initiator}`);
    }
  });

  await t.test('player fallback bootstraps stop across subdomains and fake ads hide without hiding provider links', async () => {
    for (const host of ['streame.center', 'streame.center.example', 'clearstreamdv.com',
      'a.clearstreamdv.com', 'm.clearstreamdv.com', 'z.clearstreamdv.com', 'clearstreamdv.com.example', 'embed.sportspatrika.com']) {
      const page = await fixture(browser, host);
      try {
        assert.equal(await evaluate(browser.cdp, page.sessionId, '!!window.__popunderBootstrap'), host.endsWith('.example'), host);
        assert.equal(await evaluate(browser.cdp, page.sessionId, 'window.__ordinaryScriptRan'), true);
      } finally { await page.close(); }
    }
    for (const host of ['crack-streams.st', 'footy4u.st']) {
      const page = await fixture(browser, host);
      try {
        await waitFor(() => evaluate(browser.cdp, page.sessionId,
          `getComputedStyle(document.getElementById('fake-play')).display === 'none'`), 'fake stream button hidden');
        assert.notEqual(await evaluate(browser.cdp, page.sessionId,
          `getComputedStyle(document.getElementById('stream-provider')).display`), 'none');
      } finally { await page.close(); }
    }
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
    const streaming = await streamingFixture(browser, 'live5.totalsportek.vg');
    assert.equal(streaming.top.parserAd, true);
    assert.equal(streaming.top.dynamicAd, true);
    assert.equal(streaming.top.opens, 1);
    const page = await fixture(browser, 'www.dailymotion.com', true);
    try {
      assert.deepEqual(await evaluate(browser.cdp, page.sessionId, '({ top: __state.canary, frame: __child.canary })'),
        { top: false, frame: false });
    } finally { await page.close(); }
  });
});
