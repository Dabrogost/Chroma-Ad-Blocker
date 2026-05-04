const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert');
const {
  createPage,
  evaluate,
  getTabs,
  openExtensionPage,
  sendRuntimeMessage,
  startExtensionBrowser,
  waitFor
} = require('./helpers/extension-fixture');

function startServer() {
  const html = `<!doctype html>
    <html>
      <head>
        <title>Zapper Fixture</title>
        <style>
          body { font-family: sans-serif; min-height: 900px; }
          #zapper-target, #normal-box, #danger-root { width: 180px; height: 80px; margin: 20px; padding: 8px; }
          #zapper-target { background: #ffd6d6; }
          #normal-box { background: #d6ffd6; }
          #nested-popup { padding: 12px; margin: 20px; background: #eee; }
          .popup-ad { width: 120px; height: 40px; background: #ffeb99; }
        </style>
      </head>
      <body>
        <main id="danger-root">
          <div id="zapper-target" class="fixture-target">zapper fixture</div>
          <div id="normal-box">normal content</div>
          <div id="nested-popup"><div class="popup-ad">popup ad</div></div>
        </main>
      </body>
    </html>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/fixture.html` });
    });
  });
}

async function clickCenter(browser, sessionId, selector) {
  await evaluate(browser.cdp, sessionId, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const r = el.getBoundingClientRect();
    const options = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      button: 0,
      buttons: 1
    };
    el.dispatchEvent(new MouseEvent('mousemove', options));
    el.dispatchEvent(new MouseEvent('mousedown', options));
    el.dispatchEvent(new MouseEvent('mouseup', options));
    el.dispatchEvent(new MouseEvent('click', options));
    return true;
  })()`);
}

async function activateFixturePage(browser, page) {
  await browser.cdp.send('Target.activateTarget', { targetId: page.targetId });
}

async function reloadPage(browser, sessionId) {
  await evaluate(browser.cdp, sessionId, 'window.__chromaReloadMarker = true; true');
  await browser.cdp.send('Page.reload', { ignoreCache: true }, sessionId);
  await waitFor(() => evaluate(
    browser.cdp,
    sessionId,
    'document.readyState === "complete" && window.__chromaReloadMarker !== true'
  ), 'page reload');
}

async function displayOf(browser, sessionId, selector) {
  return evaluate(browser.cdp, sessionId, `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).display`);
}

async function startZapper(browser, extensionPage, tabId) {
  const result = await sendRuntimeMessage(browser.cdp, extensionPage.sessionId, { type: 'ZAPPER_START', tabId });
  assert.deepStrictEqual(result, { ok: true });
}

test('zapper browser interaction E2E', async (t) => {
  const fixture = await startServer();
  const browser = await startExtensionBrowser();
  t.after(async () => {
    fixture.server.close();
    await browser.cleanup();
  });

  const page = await createPage(browser.cdp, fixture.url);
  const extensionPage = await openExtensionPage(browser.cdp, browser.extensionId, 'ui/settings.html');
  const tabId = await waitFor(async () => {
    const tabs = await getTabs(browser.cdp, browser.workerSession);
    return tabs.find(tab => tab.url === fixture.url)?.id || null;
  }, 'fixture tab id');

  await t.test('Hide once affects only the current page session', async () => {
    await startZapper(browser, extensionPage, tabId);
    await activateFixturePage(browser, page);
    await clickCenter(browser, page.sessionId, '#zapper-target');
    await waitFor(() => evaluate(browser.cdp, page.sessionId, '!!document.querySelector("[data-chroma-zapper-menu]")'), 'zapper menu');
    await evaluate(browser.cdp, page.sessionId, 'document.querySelector("[data-chroma-zapper-menu] button[data-action=\\"hideOnce\\"]").click()');
    await waitFor(async () => (await displayOf(browser, page.sessionId, '#zapper-target')) === 'none', 'hide once display none');

    await reloadPage(browser, page.sessionId);
    assert.notStrictEqual(await displayOf(browser, page.sessionId, '#zapper-target'), 'none', 'hide once should not persist after reload');
  });

  await t.test('Save for this site persists, applies on reload, and can be disabled/deleted', async () => {
    await startZapper(browser, extensionPage, tabId);
    await activateFixturePage(browser, page);
    await clickCenter(browser, page.sessionId, '#zapper-target');
    await waitFor(() => evaluate(browser.cdp, page.sessionId, '!!document.querySelector("[data-chroma-zapper-menu]")'), 'zapper menu');
    await evaluate(browser.cdp, page.sessionId, 'document.querySelector("[data-chroma-zapper-menu] button[data-action=\\"save\\"]").click()');
    await waitFor(() => evaluate(browser.cdp, page.sessionId, '!!document.querySelector("[data-chroma-zapper-menu] button[data-action=\\"confirmSave\\"]")'), 'save confirmation');
    await evaluate(browser.cdp, page.sessionId, 'document.querySelector("[data-chroma-zapper-menu] button[data-action=\\"confirmSave\\"]").click()');

    const savedRules = await waitFor(async () => {
      const res = await sendRuntimeMessage(browser.cdp, extensionPage.sessionId, { type: 'ZAPPER_RULES_GET' });
      return res.rules?.length ? res.rules : null;
    }, 'saved zapper rule');
    assert.strictEqual(savedRules[0].domain, '127.0.0.1');

    await reloadPage(browser, page.sessionId);
    await waitFor(async () => (await displayOf(browser, page.sessionId, '#zapper-target')) === 'none', 'persistent zapper rule');
    assert.notStrictEqual(await displayOf(browser, page.sessionId, '#normal-box'), 'none', 'normal content should remain visible');

    await sendRuntimeMessage(browser.cdp, extensionPage.sessionId, { type: 'ZAPPER_RULE_SET', id: savedRules[0].id, enabled: false });
    await waitFor(async () => {
      const res = await sendRuntimeMessage(browser.cdp, extensionPage.sessionId, { type: 'ZAPPER_RULES_GET' });
      const rule = res.rules?.find(item => item.id === savedRules[0].id);
      return rule?.enabled === false ? rule : null;
    }, 'disabled zapper rule');
    await reloadPage(browser, page.sessionId);
    await waitFor(async () => (await displayOf(browser, page.sessionId, '#zapper-target')) !== 'none', 'disabled zapper rule not applied')
      .catch(async (err) => {
        const diagnostic = await evaluate(browser.cdp, page.sessionId, `(() => {
          const el = document.querySelector('#zapper-target');
          return {
            display: el ? getComputedStyle(el).display : null,
            inlineStyle: el?.getAttribute('style') || '',
            adoptedSheets: Array.from(document.adoptedStyleSheets || []).map(sheet => {
              try {
                return Array.from(sheet.cssRules || []).map(rule => rule.cssText).join('\\n').slice(0, 500);
              } catch {
                return '[unreadable]';
              }
            }).filter(Boolean)
          };
        })()`);
        throw new Error(`${err.message}\nDisabled rule diagnostic: ${JSON.stringify(diagnostic)}`);
      });

    await sendRuntimeMessage(browser.cdp, extensionPage.sessionId, { type: 'ZAPPER_RULE_REMOVE', id: savedRules[0].id });
    const afterDelete = await waitFor(async () => {
      const res = await sendRuntimeMessage(browser.cdp, extensionPage.sessionId, { type: 'ZAPPER_RULES_GET' });
      return res.rules?.some(item => item.id === savedRules[0].id) ? null : res;
    }, 'deleted zapper rule');
    assert.strictEqual(afterDelete.rules.length, 0);
  });

  await t.test('root-like body/html targets do not open the zapper menu', async () => {
    await startZapper(browser, extensionPage, tabId);
    await activateFixturePage(browser, page);
    await evaluate(browser.cdp, page.sessionId, `(() => {
      const options = { bubbles: true, cancelable: true, composed: true, clientX: 5, clientY: 5, button: 0, buttons: 1 };
      document.documentElement.dispatchEvent(new MouseEvent('mousemove', options));
      document.documentElement.dispatchEvent(new MouseEvent('click', options));
      return true;
    })()`);
    assert.strictEqual(
      await evaluate(browser.cdp, page.sessionId, '!!document.querySelector("[data-chroma-zapper-menu]")'),
      false
    );
    await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' }, page.sessionId);
  });
});
