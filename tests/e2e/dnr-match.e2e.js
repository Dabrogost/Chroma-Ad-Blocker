const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const {
  closeTarget,
  createPage,
  evaluate,
  expectedRulesets,
  openExtensionPage,
  sendRuntimeMessage,
  startExtensionBrowser,
  waitFor
} = require('./helpers/extension-fixture');

async function testMatchOutcome(browser, request) {
  return evaluate(browser.cdp, browser.workerSession, `
    chrome.declarativeNetRequest.testMatchOutcome(${JSON.stringify(request)})
  `);
}

function ruleSummary(outcome) {
  return (outcome?.matchedRules || [])
    .map(rule => `${rule.rulesetId || 'dynamic'}:${rule.ruleId}`)
    .join(', ') || 'none';
}

function outcomeHasRule(outcome, ruleId) {
  return (outcome?.matchedRules || []).some(rule => rule.ruleId === ruleId);
}

test('DNR match/outcome E2E', async (t) => {
  const browser = await startExtensionBrowser();
  t.after(async () => {
    await browser.cleanup();
  });

  const hasTestMatchOutcome = await evaluate(
    browser.cdp,
    browser.workerSession,
    'typeof chrome.declarativeNetRequest.testMatchOutcome === "function"'
  );
  if (!hasTestMatchOutcome) {
    t.skip('chrome.declarativeNetRequest.testMatchOutcome is unavailable in this browser; DNR match assertions skipped explicitly.');
    return;
  }

  await t.test('static rulesets and dynamic rules are present', async () => {
    const enabledRulesets = await waitFor(async () => {
      const ids = await evaluate(browser.cdp, browser.workerSession, 'chrome.declarativeNetRequest.getEnabledRulesets().then(ids => ids.sort())');
      return ids.length === expectedRulesets.length ? ids : null;
    }, 'enabled rulesets');
    const dynamicRules = await waitFor(async () => {
      const rules = await evaluate(browser.cdp, browser.workerSession, 'chrome.declarativeNetRequest.getDynamicRules()');
      return rules.length ? rules : null;
    }, 'dynamic rules');

    assert.deepStrictEqual(enabledRulesets, expectedRulesets);
    assert.ok(dynamicRules.length > 0, 'dynamic rules should be installed after background startup');
  });

  await t.test('issue #134 wildcard-host exception remains a native urlFilter with scoped matches', async (t) => {
    const ruleId = 8999999;
    const urlFilter = '||estaticos.*/elementosWeb/ew/js/multimedia/player/videojs-contrib-ads/videojs.ads.min.js';
    const resourceUrl = 'https://estaticos.example/elementosWeb/ew/js/multimedia/player/videojs-contrib-ads/videojs.ads.min.js';
    const initiatorDomains = [
      'diaridegirona.cat',
      'diariodeibiza.es',
      'diariodemallorca.es',
      'diarioinformacion.com',
      'eldia.es',
      'emporda.info',
      'farodevigo.es',
      'laopinioncoruna.es',
      'laopiniondemalaga.es',
      'laopiniondemurcia.es',
      'laopiniondezamora.es',
      'laprovincia.es',
      'levante-emv.com',
      'lne.es',
      'mallorcazeitung.es',
      'regio7.cat',
      'superdeporte.es'
    ];
    const rule = {
      id: ruleId,
      priority: 10000,
      action: { type: 'allow' },
      condition: {
        urlFilter,
        resourceTypes: ['xmlhttprequest'],
        initiatorDomains
      }
    };

    const existingRule = await evaluate(
      browser.cdp,
      browser.workerSession,
      `chrome.declarativeNetRequest.getDynamicRules().then(rules => rules.find(rule => rule.id === ${ruleId}) || null)`
    );
    assert.strictEqual(existingRule, null, `reserved E2E rule id ${ruleId} should be unused`);

    t.after(async () => {
      await evaluate(
        browser.cdp,
        browser.workerSession,
        `chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [${ruleId}] })`
      );
    });
    await evaluate(
      browser.cdp,
      browser.workerSession,
      `chrome.declarativeNetRequest.updateDynamicRules({ addRules: [${JSON.stringify(rule)}] })`
    );

    const installedRule = await evaluate(
      browser.cdp,
      browser.workerSession,
      `chrome.declarativeNetRequest.getDynamicRules().then(rules => rules.find(rule => rule.id === ${ruleId}) || null)`
    );
    assert.ok(installedRule, 'issue #134 rule should install in Chromium');
    assert.strictEqual(installedRule.condition.urlFilter, urlFilter);
    assert.strictEqual(installedRule.condition.regexFilter, undefined);
    assert.deepStrictEqual(installedRule.condition.resourceTypes, ['xmlhttprequest']);
    assert.deepStrictEqual(installedRule.condition.initiatorDomains, initiatorDomains);

    const cases = [
      {
        label: 'base host, exact path, allowed initiator, and XHR',
        request: {
          url: resourceUrl,
          type: 'xmlhttprequest',
          initiator: 'https://diaridegirona.cat'
        },
        matches: true
      },
      {
        label: 'subdomain host',
        request: {
          url: resourceUrl.replace('://estaticos.', '://cdn.estaticos.'),
          type: 'xmlhttprequest',
          initiator: 'https://superdeporte.es'
        },
        matches: true
      },
      {
        label: 'wrong host',
        request: {
          url: resourceUrl.replace('://estaticos.', '://notestaticos.'),
          type: 'xmlhttprequest',
          initiator: 'https://diaridegirona.cat'
        },
        matches: false
      },
      {
        label: 'wrong path',
        request: {
          url: resourceUrl.replace('/elementosWeb/', '/other/'),
          type: 'xmlhttprequest',
          initiator: 'https://diaridegirona.cat'
        },
        matches: false
      },
      {
        label: 'wrong initiator',
        request: {
          url: resourceUrl,
          type: 'xmlhttprequest',
          initiator: 'https://unrelated.example'
        },
        matches: false
      },
      {
        label: 'wrong resource type',
        request: {
          url: resourceUrl,
          type: 'script',
          initiator: 'https://diaridegirona.cat'
        },
        matches: false
      }
    ];

    for (const matchCase of cases) {
      const outcome = await testMatchOutcome(browser, matchCase.request);
      console.log(`DNR issue #134 ${matchCase.label}: ${ruleSummary(outcome)}`);
      assert.strictEqual(
        outcomeHasRule(outcome, ruleId),
        matchCase.matches,
        `issue #134 rule should ${matchCase.matches ? '' : 'not '}match ${matchCase.label}`
      );
    }
  });

  await t.test('known tracker URL matches a blocking rule', async () => {
    const outcome = await testMatchOutcome(browser, {
      url: 'https://www.google-analytics.com/analytics.js',
      type: 'script',
      initiator: 'https://example.com'
    });
    console.log(`DNR block match: ${ruleSummary(outcome)}`);
    assert.ok(outcome.matchedRules.length > 0, 'google-analytics script should match at least one DNR rule');
  });

  await t.test('safe normal URL does not match', async () => {
    const outcome = await testMatchOutcome(browser, {
      url: 'https://example.com/assets/app.js',
      type: 'script',
      initiator: 'https://example.com'
    });
    console.log(`DNR safe match: ${ruleSummary(outcome)}`);
    assert.strictEqual(outcome.matchedRules.length, 0, 'plain first-party application script should not match');
  });

  await t.test('Tracking URL Cleanup rule matches known tracking query params', async () => {
    const outcome = await testMatchOutcome(browser, {
      url: 'https://example.com/story?id=42&utm_source=newsletter&fbclid=abc',
      type: 'main_frame',
      initiator: 'https://example.com'
    });
    console.log(`DNR cleanup match: ${ruleSummary(outcome)}`);
    assert.ok(
      outcome.matchedRules.some(rule => rule.ruleId >= 2000 && rule.ruleId <= 2099),
      'tracking cleanup redirect rule should match known tracking query params'
    );
  });

  await t.test('recipe/blog clutter URL matches recipe rules when covered', async () => {
    const outcome = await testMatchOutcome(browser, {
      url: 'https://raptive.com/script.js',
      type: 'script',
      initiator: 'https://www.allrecipes.com'
    });
    console.log(`DNR recipe match: ${ruleSummary(outcome)}`);
    assert.ok(outcome.matchedRules.some(rule => rule.rulesetId === 'recipe_ad_rules'), 'raptive script should match recipe_ad_rules');
  });

  await t.test('YouTube measurement allow rule wins for scoped allowlisted endpoint', async () => {
    const outcome = await testMatchOutcome(browser, {
      url: 'https://cm.g.doubleclick.net/pixel',
      type: 'image',
      initiator: 'https://www.youtube.com'
    });
    console.log(`DNR YouTube allow match: ${ruleSummary(outcome)}`);
    assert.ok(outcome.matchedRules.some(rule => rule.ruleId === 1004), 'dynamic YouTube allow rule 1004 should match');
  });

  await t.test('whitelist bypasses subscription blocks throughout cross-origin frame trees', async (t) => {
    // Finish install-time subscription initialization before replacing its cache.
    await waitFor(() => evaluate(browser.cdp, browser.workerSession,
      "chrome.alarms.get('chroma-subscription-check').then(Boolean)"), 'subscription initialization');
    const original = await evaluate(browser.cdp, browser.workerSession,
      "chrome.storage.local.get(['subscriptions', 'sub_network_rules', 'whitelist'])");
    const pages = [];
    const page = await openExtensionPage(browser.cdp, browser.extensionId, 'ui/popup.html');
    const server = http.createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (req.url === '/probe.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end('window.probeLoaded = true;');
        return;
      }
      const level = req.url === '/child' ? 'child' : req.url === '/nested' ? 'nested' : 'top';
      const origin = `http://localhost:${server.address().port}`;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><body>
        <script>
          window.results = {};
          addEventListener('message', event => {
            if (event.data && event.data.probe) results[event.data.probe] = event.data.loaded;
          });
          function report() {
            const loaded = window.probeLoaded === true;
            if (window === top) results.top = loaded;
            else top.postMessage({ probe: '${level}', loaded }, '*');
          }
        </script>
        <script src="${origin}/probe.js" onload="report()" onerror="report()"></script>
        ${level === 'nested' ? '' : `<iframe src="${origin}/${level === 'top' ? 'child' : 'nested'}"></iframe>`}
      </body></html>`);
    });
    t.after(async () => {
      for (const page of pages) await closeTarget(browser.cdp, page);
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await evaluate(browser.cdp, page.sessionId, `(async () => {
        await chrome.storage.local.remove(['subscriptions', 'sub_network_rules', 'whitelist']);
        await chrome.storage.local.set(${JSON.stringify(original)});
        await (await import('../background/dnrState.js')).reconcileNetworkDnr('e2e-restore');
      })()`);
      await closeTarget(browser.cdp, page);
    });
    await new Promise(resolve => server.listen(0, resolve));
    await evaluate(browser.cdp, page.sessionId, `(async () => {
      const { parseList } = await import('../subscriptions/parser.js');
      const parsed = parseList('/probe.js$script,important');
      await chrome.storage.local.set({
        whitelist: [],
        subscriptions: [{ id: 'e2e-whitelist', enabled: true }],
        sub_network_rules: { 'e2e-whitelist': parsed.networkRules }
      });
      await (await import('../background/dnrState.js')).reconcileNetworkDnr('e2e-whitelist');
    })()`);

    async function checkPage(host, expected) {
      assert.strictEqual(await evaluate(browser.cdp, browser.workerSession,
        "chrome.declarativeNetRequest.getDynamicRules().then(rules => rules.some(rule => rule.condition.urlFilter === '/probe.js' && rule.action.type === 'block' && rule.priority === 3))"),
      true, 'the subscription block must stay installed while whitelisted');
      const fixture = await createPage(browser.cdp, `http://${host}:${server.address().port}/top`);
      pages.push(fixture);
      const results = await waitFor(() => evaluate(browser.cdp, fixture.sessionId,
        'Object.keys(window.results || {}).length === 3 ? window.results : null'), 'frame probe results');
      assert.deepStrictEqual(results, { top: expected, child: expected, nested: expected }, host);
    }

    await checkPage('127.0.0.1', false);
    assert.deepStrictEqual(await sendRuntimeMessage(browser.cdp, page.sessionId,
      { type: 'WHITELIST_ADD', domain: '127.0.0.1' }), { ok: true });
    await checkPage('127.0.0.1', true);
    await checkPage('localhost', false);
    assert.deepStrictEqual(await sendRuntimeMessage(browser.cdp, page.sessionId,
      { type: 'WHITELIST_REMOVE', domain: '127.0.0.1' }), { ok: true });
    await checkPage('127.0.0.1', false);
  });

  await t.test('whitelist adds high-priority allow diagnostic rule', async () => {
    const page = await openExtensionPage(browser.cdp, browser.extensionId, 'ui/popup.html');
    await sendRuntimeMessage(browser.cdp, page.sessionId, { type: 'WHITELIST_ADD', domain: 'example.com' });
    const outcome = await testMatchOutcome(browser, {
      url: 'https://www.google-analytics.com/analytics.js',
      type: 'script',
      initiator: 'https://example.com'
    });
    console.log(`DNR whitelist match: ${ruleSummary(outcome)}`);
    assert.ok(outcome.matchedRules.some(rule => rule.ruleId >= 9000000), 'whitelist allow rule should be visible in match outcome');
  });
});
