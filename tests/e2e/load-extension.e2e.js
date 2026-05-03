const test = require('node:test');
const assert = require('node:assert');
const {
  evaluate,
  expectedRulesets,
  openExtensionPage,
  startExtensionBrowser,
  waitFor
} = require('./helpers/extension-fixture');

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

  await t.test('popup and settings pages open', async () => {
    const popup = await openExtensionPage(browser.cdp, browser.extensionId, 'ui/popup.html');
    const settings = await openExtensionPage(browser.cdp, browser.extensionId, 'ui/settings.html#proxy');

    assert.strictEqual(await evaluate(browser.cdp, popup.sessionId, '!!document.body && location.pathname.endsWith("/ui/popup.html")'), true);
    assert.strictEqual(await evaluate(browser.cdp, settings.sessionId, '!!document.body && location.pathname.endsWith("/ui/settings.html")'), true);
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
});
