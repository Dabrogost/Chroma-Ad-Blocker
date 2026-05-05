const test = require('node:test');
const assert = require('node:assert');
const {
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

  await t.test('whitelist adds high-priority allow diagnostic rule', async () => {
    const page = await openExtensionPage(browser.cdp, browser.extensionId, 'ui/settings.html');
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
