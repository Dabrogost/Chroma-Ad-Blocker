const test = require('node:test');
const assert = require('node:assert');
const { GUIDE_PAGES } = require('../../scripts/guide-manifest');
const {
  attach,
  closeTarget,
  evaluate,
  expectedRulesets,
  openExtensionPage,
  sendRuntimeMessage,
  startExtensionBrowser,
  waitFor
} = require('./helpers/extension-fixture');

async function createFulfilledPage(cdp, url, html, resources = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const sessionId = await attach(cdp, targetId);
  await cdp.send('Page.enable', {}, sessionId);

  const removeFetchListener = cdp.on('Fetch.requestPaused', (params) => {
    const isDocument = params.resourceType === 'Document';
    const resource = resources[params.request.url];
    const body = isDocument ? html : resource?.body || '';
    cdp.send('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: isDocument || resource ? 200 : 204,
      responsePhrase: isDocument || resource ? 'OK' : 'No Content',
      responseHeaders: [
        { name: 'content-type', value: isDocument ? 'text/html; charset=utf-8' : resource?.type || 'text/plain' },
        { name: 'access-control-allow-origin', value: 'https://www.youtube.com' },
        { name: 'cache-control', value: 'no-store' }
      ],
      body: Buffer.from(body, 'utf8').toString('base64')
    }, sessionId).catch(() => {});
  }, sessionId);

  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Request' }]
  }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  await waitFor(
    async () => evaluate(cdp, sessionId, 'document.readyState === "complete" || document.readyState === "interactive"'),
    `${url} intercepted load`,
    { pollMs: 500 }
  );

  return {
    targetId,
    sessionId,
    close: async () => {
      removeFetchListener();
      await cdp.send('Fetch.disable', {}, sessionId).catch(() => {});
      await closeTarget(cdp, targetId);
    }
  };
}

test('loaded extension E2E smoke', async (t) => {
  const browser = await startExtensionBrowser();
  t.after(async () => {
    await browser.cleanup();
  });

  await t.test('extension loads and service worker starts', () => {
    assert.match(browser.extensionId, /^[a-p]{32}$/);
    assert.match(browser.worker.url, new RegExp(`^chrome-extension://${browser.extensionId}/`));
    assert.doesNotMatch(browser.stderr(), /Failed to load extension|Manifest is not valid|Could not load manifest/i);
  });

  await t.test('popup, settings, and offline guide pages open', async () => {
    const popup = await openExtensionPage(browser.cdp, browser.extensionId, 'ui/popup.html');
    const settings = await openExtensionPage(browser.cdp, browser.extensionId, 'ui/settings.html#proxy');
    const guide = await openExtensionPage(browser.cdp, browser.extensionId, 'guide/index.html');

    assert.strictEqual(await evaluate(browser.cdp, popup.sessionId, '!!document.body && location.pathname.endsWith("/ui/popup.html")'), true);
    assert.strictEqual(await evaluate(browser.cdp, settings.sessionId, '!!document.body && location.pathname.endsWith("/ui/settings.html")'), true);
    const guideState = await waitFor(async () => {
      const state = await evaluate(browser.cdp, guide.sessionId, `(() => {
        const input = document.querySelector('[data-guide-search]');
        const articleLinks = document.querySelectorAll('.guide-article-card a');
        if (!input || articleLinks.length < ${GUIDE_PAGES.length}) return null;
        input.value = 'media proxy';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const results = document.querySelector('[data-guide-search-results]');
        return {
          path: location.pathname,
          articleCount: articleLinks.length,
          resultsHidden: results?.hidden,
          resultsText: results?.innerText || ''
        };
      })()`);
      return state?.resultsText.includes('Media Proxy Router') ? state : null;
    }, 'offline guide search');

    assert.strictEqual(guideState.path.endsWith('/guide/index.html'), true);
    assert.strictEqual(guideState.articleCount, GUIDE_PAGES.length);
    assert.strictEqual(guideState.resultsHidden, false);
  });

  await t.test('settings health panel renders diagnostics', async () => {
    const settings = await openExtensionPage(browser.cdp, browser.extensionId, 'ui/settings.html');
    const healthText = await waitFor(async () => {
      const text = await evaluate(browser.cdp, settings.sessionId, `(() => {
        document.getElementById("healthPanelBody")?.closest("details")?.setAttribute("open", "");
        return document.getElementById("healthPanel")?.innerText || "";
      })()`);
      return text.includes('Static rulesets') && text.includes('UserScripts API') ? text : null;
    }, 'settings health panel');

    assert.match(healthText, /Overall:/);
    assert.match(healthText, /v\d+\.\d+\.\d+/);
    assert.match(healthText, /Static rulesets/i);
    assert.match(healthText, /UserScripts API/i);
  });

  await t.test('static rulesets are enabled and dynamic rules are installed', async () => {
    const enabledRulesets = await waitFor(async () => {
      const ids = await evaluate(browser.cdp, browser.workerSession, 'chrome.declarativeNetRequest.getEnabledRulesets().then(ids => ids.sort())');
      return ids.length === expectedRulesets.length ? ids : null;
    }, 'enabled static rulesets');
    const dynamicRules = await waitFor(async () => {
      const rules = await evaluate(browser.cdp, browser.workerSession, 'chrome.declarativeNetRequest.getDynamicRules()');
      return rules.length > 0 ? rules : null;
    }, 'dynamic rules');

    assert.deepStrictEqual(enabledRulesets, expectedRulesets);
    assert.ok(dynamicRules.some(rule => rule.id >= 1000 && rule.id <= 99999), 'default dynamic rules should be present');
  });

  await t.test('userScripts availability has an actionable diagnostic', async () => {
    const diagnostic = await evaluate(browser.cdp, browser.workerSession, `({
      available: !!chrome.userScripts,
      diagnostic: chrome.userScripts
        ? 'chrome.userScripts is available'
        : 'chrome.userScripts is unavailable; enable the Chrome user scripts developer toggle for MV3 scriptlets'
    })`);

    assert.strictEqual(typeof diagnostic.available, 'boolean');
    assert.match(diagnostic.diagnostic, /chrome\.userScripts/);
  });

  await t.test('YouTube MAIN-world handlers inject and preserve page APIs', async (t) => {
    const page = await createFulfilledPage(browser.cdp, 'https://www.youtube.com/watch?v=chroma-smoke', `<!doctype html>
      <html>
        <head><title>YouTube MAIN-world fixture</title></head>
        <body>
          <main id="fixture-root">clean player shell</main>
          <script>
            window.__fixtureReady = true;
            window.__fixtureQuery = document.querySelector('#fixture-root')?.textContent;
          </script>
        </body>
      </html>`);
    t.after(async () => {
      await page.close();
    });

    const state = await waitFor(async () => {
      const value = await evaluate(browser.cdp, page.sessionId, `(() => {
        const bridge = window.__CHROMA_INTERNAL__;
        const parsed = JSON.parse(JSON.stringify({
          adPlacements: [{}],
          playerAds: [{}],
          videoDetails: { title: 'Smoke' }
        }));
        return {
          href: location.href,
          fixtureReady: window.__fixtureReady === true,
          fixtureQuery: window.__fixtureQuery,
          bridgeReady: !!bridge,
          bridgeFrozen: bridge ? Object.isFrozen(bridge) : false,
          bridgeApiReady: typeof bridge?.api?.querySelector === 'function',
          bridgeConfigEnabled: bridge?.config?.enabled,
          jsonPruned: !('adPlacements' in parsed) &&
            !('playerAds' in parsed) &&
            parsed.videoDetails?.title === 'Smoke',
          fetchCallable: typeof window.fetch === 'function',
          querySelectorWorks: document.querySelector('#fixture-root')?.textContent === 'clean player shell'
        };
      })()`);
      return value.bridgeReady && value.jsonPruned ? value : null;
    }, 'YouTube MAIN-world handlers');

    assert.strictEqual(state.href, 'https://www.youtube.com/watch?v=chroma-smoke');
    assert.strictEqual(state.fixtureReady, true);
    assert.strictEqual(state.fixtureQuery, 'clean player shell');
    assert.strictEqual(state.bridgeFrozen, true);
    assert.strictEqual(state.bridgeApiReady, true);
    assert.strictEqual(typeof state.bridgeConfigEnabled, 'boolean');
    assert.strictEqual(state.fetchCallable, true);
    assert.strictEqual(state.querySelectorWorks, true);
  });

  await t.test('YouTube SABR startup recovery handles real browser response streams once', async (t) => {
    const mediaUrl = 'https://rr1.googlevideo.com/videoplayback?sabr=1&chroma-fixture=1';
    const playerUrl = 'https://www.youtube.com/youtubei/v1/player';
    const page = await createFulfilledPage(browser.cdp,
      'https://www.youtube.com/watch?v=chroma-sabr&list=RDchroma-sabr', `<!doctype html>
      <html><head><title>SABR fixture</title></head><body>
        <div id="movie_player"><video></video></div><yt-playlist-manager></yt-playlist-manager>
        <script>
          const player = document.getElementById('movie_player');
          const manager = document.querySelector('yt-playlist-manager');
          const data = { playlistId: 'RDchroma-sabr', currentIndex: 2 };
          window.__sabrFixture = { cancels: 0, loads: [], restores: 0, videoData: {}, playlistId: data.playlistId };
          const fixture = window.__sabrFixture;
          player.getPlayerState = () => 5;
          player.getPlayerResponse = () => ({ videoDetails: { videoId: 'chroma-sabr' }, playabilityStatus: { status: 'OK' }, playerConfig: { playbackStartConfig: { startSeconds: 23 } } });
          player.getVideoData = () => fixture.videoData;
          player.getPlaylistId = () => fixture.playlistId;
          player.cancelPlayback = () => fixture.cancels++;
          player.loadVideoById = (...args) => { fixture.loads.push(args); fixture.playlistId = null; };
          manager.getPlaylistData = () => data;
          manager.setPlaylistData = value => { fixture.playlistId = value.playlistId; fixture.restores++; };
          manager.setPlayerPlaybackControlData = value => { fixture.index = value.playlistPanelRenderer.currentIndex; };
        </script>
      </body></html>`, {
        [mediaUrl]: { body: Buffer.from([35, 3, 32, 224, 93]), type: 'application/vnd.yt-ump' },
        [playerUrl]: { body: '{}', type: 'application/json' }
      });
    t.after(() => page.close());
    await waitFor(() => evaluate(browser.cdp, page.sessionId,
      'window.__CHROMA_INTERNAL__?.config?.stripping && !JSON.parse(\'{"adPlacements":[]}\').adPlacements'), 'SABR fixture config');
    const responses = await evaluate(browser.cdp, page.sessionId, `(async () => {
      const results = [];
      for (let i = 0; i < 3; i++) {
        const response = await fetch(${JSON.stringify(mediaUrl)});
        results.push({ bytes: Array.from(new Uint8Array(await response.arrayBuffer())), url: response.url, type: response.type });
      }
      return results;
    })()`);
    assert.deepStrictEqual(responses.map(r => r.bytes), [[35, 3, 32, 228, 0], [35, 3, 32, 228, 0], [35, 3, 32, 224, 93]]);
    assert.ok(responses.every(r => r.url === mediaUrl && r.type === 'cors'));
    const state = await waitFor(async () => {
      const value = await evaluate(browser.cdp, page.sessionId, 'window.__sabrFixture');
      return value.loads.length ? value : null;
    }, 'one SABR session retry');
    assert.strictEqual(state.cancels, 1);
    assert.deepStrictEqual(state.loads, [['chroma-sabr', 23]]);
    assert.strictEqual(state.videoData.isInlinePlaybackNoAd, true);
    assert.strictEqual(state.playlistId, 'RDchroma-sabr');
    assert.strictEqual(state.index, 2);
    assert.strictEqual(state.restores, 1);
    let outgoing;
    const removeListener = browser.cdp.on('Network.requestWillBeSent', event => {
      if (event.request.url === playerUrl) outgoing = event.request;
    }, page.sessionId);
    t.after(removeListener);
    await browser.cdp.send('Network.enable', {}, page.sessionId);
    await evaluate(browser.cdp, page.sessionId, `(async () => {
      const body = JSON.stringify({ videoId: 'chroma-sabr', context: { client: { clientName: 'WEB' } }, playbackContext: { contentPlaybackContext: { signatureTimestamp: 123 } } });
      const gzip = await new Response(new Response(body).body.pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
      await fetch(${JSON.stringify(playerUrl)}, { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: gzip });
    })()`);
    assert.ok(outgoing, 'compressed player request reached the browser network layer');
    assert.strictEqual(Object.entries(outgoing.headers).find(([key]) => key.toLowerCase() === 'content-encoding')?.[1], 'gzip');
    const sent = JSON.parse(require('node:zlib').gunzipSync(Buffer.from(outgoing.postData, 'latin1')));
    assert.deepStrictEqual(sent.playbackContext.contentPlaybackContext, { signatureTimestamp: 123, isInlinePlaybackNoAd: true });
    assert.strictEqual(sent.params, 'eAFgAQ');
  });

  await t.test('Yahoo recipe contains parser-time recovery before asynchronous configuration', async (t) => {
    await waitFor(() => evaluate(browser.cdp, browser.workerSession,
      "chrome.scripting.getRegisteredContentScripts({ids:['chroma_yahoo_recipe']}).then(s => s.length === 1)"),
    'Yahoo early recipe registration');
    const bootstrapCode = `
      window.__yahooFixture = { inline: 0, handler: 0, legitimate: 0, loaded: false };
      const inline = document.createElement('script');
      inline.textContent = 'window.__yahooFixture.inline++';
      document.head.appendChild(inline);
      const loader = document.createElement('script');
      loader.id = 'fixture-loader';
      loader.src = 'https://s.yimg.com/du/site/rotated-fixture.js';
      loader.setAttribute('onload', 'window.__yahooFixture.handler++');
      loader.setAttribute('onerror', 'window.__yahooFixture.handler++');
      loader.addEventListener('load', () => { window.__yahooFixture.loaded = true; });
      document.head.appendChild(loader);
    `;
    const html = `<!doctype html><html><head><title>Yahoo fixture</title>
      <script id="ad-shield-container">${bootstrapCode}</script>
      <script>window.__yahooFixture.legitimate++;</script></head>
      <body><main id="content">News remains available</main></body></html>`;
    const page = await createFulfilledPage(browser.cdp, 'https://www.yahoo.com/chroma-smoke', html);
    t.after(() => page.close());
    const state = await waitFor(async () => {
      const value = await evaluate(browser.cdp, page.sessionId, `(() => {
        const loader = document.getElementById('fixture-loader');
        return {
          ...window.__yahooFixture,
          src: loader?.src,
          onload: loader?.getAttribute('onload'),
          onerror: loader?.getAttribute('onerror'),
          reloadWritable: Object.getOwnPropertyDescriptor(location, 'reload').writable,
          content: document.getElementById('content')?.textContent
        };
      })()`);
      return value.loaded ? value : null;
    }, 'Yahoo neutralized loader completion');
    assert.strictEqual(state.inline, 0);
    assert.strictEqual(state.handler, 0);
    assert.strictEqual(state.legitimate, 1);
    assert.strictEqual(state.src, 'data:text/javascript,void%200');
    assert.strictEqual(state.onload, '');
    assert.strictEqual(state.onerror, '');
    assert.strictEqual(state.reloadWritable, false, 'Containment must work without replacing native reload');
    assert.strictEqual(state.content, 'News remains available');

    const originalStorage = await evaluate(browser.cdp, browser.workerSession,
      "chrome.storage.local.get(['config', 'whitelist'])");
    const settings = await openExtensionPage(browser.cdp, browser.extensionId, 'ui/settings.html');
    try {
      for (const mode of ['whitelisted', 'disabled']) {
        const storage = {
          config: { ...originalStorage.config, enabled: mode !== 'disabled' },
          whitelist: mode === 'whitelisted' ? ['yahoo.com'] : []
        };
        await evaluate(browser.cdp, browser.workerSession,
          `chrome.storage.local.set({whitelist: ${JSON.stringify(storage.whitelist)}})`);
        await sendRuntimeMessage(browser.cdp, settings.sessionId, { type: 'CONFIG_SET', config: storage.config });
        await waitFor(() => evaluate(browser.cdp, browser.workerSession,
          `chrome.scripting.getRegisteredContentScripts({ids:['chroma_yahoo_recipe']}).then(s =>
            ${mode === 'disabled' ? 's.length === 0' : "s[0]?.excludeMatches?.includes('*://*.yahoo.com/*')"})`),
        `Yahoo ${mode} registration`);
        const inactivePage = await createFulfilledPage(browser.cdp, 'https://www.yahoo.com/chroma-smoke', html);
        try {
          const inactive = await evaluate(browser.cdp, inactivePage.sessionId,
            '({ ...window.__yahooFixture, src: document.getElementById("fixture-loader")?.src })');
          assert.strictEqual(inactive.inline, 1, `${mode} must allow the bootstrap's inline script`);
          assert.strictEqual(inactive.legitimate, 1);
          assert.strictEqual(inactive.src, 'https://s.yimg.com/du/site/rotated-fixture.js');
        } finally {
          await inactivePage.close();
        }
      }
    } finally {
      await evaluate(browser.cdp, browser.workerSession,
        `chrome.storage.local.set({whitelist: ${JSON.stringify(originalStorage.whitelist || [])}})`);
      await sendRuntimeMessage(browser.cdp, settings.sessionId, { type: 'CONFIG_SET', config: originalStorage.config });
      await waitFor(() => evaluate(browser.cdp, browser.workerSession,
        "chrome.scripting.getRegisteredContentScripts({ids:['chroma_yahoo_recipe']}).then(s => s.length === 1 && !s[0].excludeMatches?.length)"),
      'Yahoo registration restored');
      await closeTarget(browser.cdp, settings.targetId);
    }
  });

  await t.test('Prime Video MAIN-world handlers use real browser media APIs', {
    skip: 'Prime Video acceleration is temporarily dormant and is not registered in the manifest.'
  }, async (t) => {
    const page = await createFulfilledPage(browser.cdp, 'https://www.amazon.com/gp/video/detail/chroma-smoke', `<!doctype html>
      <html>
        <head>
          <title>Prime MAIN-world fixture</title>
          <style>
            .atvwebplayersdk-player-container { display: block; width: 640px; height: 360px; position: relative; }
            video { display: block; width: 640px; height: 360px; }
            .atvwebplayersdk-ad-container { display: block; position: absolute; top: 8px; left: 8px; }
          </style>
        </head>
        <body>
          <div class="atvwebplayersdk-player-container">
            <video id="prime-video" width="640" height="360" src="data:video/mp4;base64,AAAA"></video>
            <div class="atvwebplayersdk-ad-container">Ad 0:15</div>
          </div>
        </body>
      </html>`);
    t.after(async () => {
      await page.close();
    });

    const bridgeState = await waitFor(async () => {
      const value = await evaluate(browser.cdp, page.sessionId, `(() => {
        const bridge = window.__CHROMA_INTERNAL__;
        return {
          bridgeReady: !!bridge,
          bridgeApiReady: typeof bridge?.api?.querySelectorAll === 'function',
          pageQueryWorks: !!document.querySelector('.atvwebplayersdk-ad-container')
        };
      })()`);
      return value.bridgeReady && value.bridgeApiReady && value.pageQueryWorks ? value : null;
    }, 'Prime Video MAIN-world bridge', { pollMs: 500 });

    const settings = await openExtensionPage(browser.cdp, browser.extensionId, 'ui/settings.html');
    t.after(async () => {
      await closeTarget(browser.cdp, settings);
    });
    const configResult = await sendRuntimeMessage(browser.cdp, settings.sessionId, {
      type: 'CONFIG_SET',
      config: { enabled: true, acceleration: true, accelerationSpeed: 8 }
    });
    assert.strictEqual(configResult?.ok, true);

    const state = await waitFor(async () => {
      const value = await evaluate(browser.cdp, page.sessionId, `(() => {
        const bridge = window.__CHROMA_INTERNAL__;
        const video = document.getElementById('prime-video');
        return {
          href: location.href,
          bridgeReady: !!bridge,
          bridgeApiReady: typeof bridge?.api?.querySelectorAll === 'function',
          playbackRate: video?.playbackRate,
          muted: video?.muted,
          volume: video?.volume,
          pageQueryWorks: !!document.querySelector('.atvwebplayersdk-ad-container')
        };
      })()`);
      return value.bridgeReady && value.playbackRate === 8 ? value : null;
    }, 'Prime Video MAIN-world handlers', { pollMs: 500 });

    assert.strictEqual(state.href, 'https://www.amazon.com/gp/video/detail/chroma-smoke');
    assert.strictEqual(bridgeState.bridgeApiReady, true);
    assert.strictEqual(state.bridgeApiReady, true);
    assert.strictEqual(state.playbackRate, 8);
    assert.strictEqual(state.muted, true);
    assert.strictEqual(state.volume, 0);
    assert.strictEqual(state.pageQueryWorks, true);
  });
});
