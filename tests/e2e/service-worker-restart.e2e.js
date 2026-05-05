const test = require('node:test');
const assert = require('node:assert');
const {
  evaluate,
  expectedRulesets,
  openExtensionPage,
  refreshExtensionWorker,
  sendRuntimeMessage,
  startExtensionBrowser,
  waitFor
} = require('./helpers/extension-fixture');

async function workerDiagnostics(browser) {
  const enabledRulesets = await evaluate(browser.cdp, browser.workerSession, 'chrome.declarativeNetRequest.getEnabledRulesets().then(ids => ids.sort())');
  const dynamicRuleCount = await evaluate(browser.cdp, browser.workerSession, 'chrome.declarativeNetRequest.getDynamicRules().then(rules => rules.length)');
  const userScripts = await evaluate(browser.cdp, browser.workerSession, `({
    available: !!chrome.userScripts,
    diagnostic: chrome.userScripts ? 'chrome.userScripts is available' : 'chrome.userScripts is unavailable'
  })`);
  return { enabledRulesets, dynamicRuleCount, userScripts };
}

test('service worker restart resilience E2E', async (t) => {
  const browser = await startExtensionBrowser();
  t.after(async () => {
    await browser.cleanup();
  });

  const page = await openExtensionPage(browser.cdp, browser.extensionId, 'ui/settings.html');
  const beforeConfig = await sendRuntimeMessage(browser.cdp, page.sessionId, { type: 'CONFIG_GET' });
  const before = await workerDiagnostics(browser);

  assert.ok(beforeConfig && typeof beforeConfig === 'object', 'CONFIG_GET should respond before restart');
  assert.deepStrictEqual(before.enabledRulesets, expectedRulesets);
  assert.ok(before.dynamicRuleCount > 0, 'dynamic rules should exist before restart');
  assert.strictEqual(typeof before.userScripts.available, 'boolean');

  // MV3 service workers cannot be suspended deterministically from extension JS.
  // Reloading the extension forces Chrome to tear down and recreate the worker
  // inside the temporary E2E profile without touching the developer profile.
  await evaluate(browser.cdp, browser.workerSession, 'chrome.runtime.reload(); true', false).catch(() => true);
  await waitFor(async () => {
    const targets = await browser.cdp.send('Target.getTargets');
    return targets.targetInfos.some(target => target.type === 'service_worker' && target.url.startsWith('chrome-extension://'));
  }, 'service worker target after reload');
  await refreshExtensionWorker(browser);

  const afterPage = await openExtensionPage(browser.cdp, browser.extensionId, 'ui/settings.html');
  const afterConfig = await sendRuntimeMessage(browser.cdp, afterPage.sessionId, { type: 'CONFIG_GET' });
  const after = await workerDiagnostics(browser);

  assert.ok(afterConfig && typeof afterConfig === 'object', 'CONFIG_GET should respond after restart');
  assert.deepStrictEqual(after.enabledRulesets, expectedRulesets, 'enabled static rulesets should survive restart');
  assert.ok(after.dynamicRuleCount > 0, 'dynamic rules should remain sane after restart');
  assert.strictEqual(typeof after.userScripts.available, 'boolean');
  assert.match(after.userScripts.diagnostic, /chrome\.userScripts/);
});
