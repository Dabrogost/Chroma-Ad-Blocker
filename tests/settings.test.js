const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const componentsJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'components.js'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'app.js'), 'utf8');
const proxyUiJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'proxy-ui.js'), 'utf8');

test('settings page proxy and zapper management safety', async (t) => {
  await t.test('proxy credential UI never hydrates password fields from stored config', () => {
    assert.match(proxyUiJs, /<input type="password" class="chroma-input proxy-pass" value=""/);
    assert.doesNotMatch(proxyUiJs, /value="\$\{[^}]*password/i);
    assert.match(proxyUiJs, /delete pc\.username;/);
    assert.match(proxyUiJs, /delete pc\.password;/);
    assert.match(proxyUiJs, /delete pc\.authIv;/);
    assert.match(proxyUiJs, /delete pc\.authCipher;/);
  });

  await t.test('preserve, replace, and clear credential actions are encoded intentionally', () => {
    assert.match(proxyUiJs, /credentialAction: action/);
    assert.match(proxyUiJs, /if \(out\.credentialAction === 'replace'\)/);
    assert.match(proxyUiJs, /out\.username = credential\.username \|\| '';/);
    assert.match(proxyUiJs, /out\.password = credential\.password \|\| '';/);
    assert.match(proxyUiJs, /action: pendingCredentialAction === 'clear' \? 'clear' : 'preserve'/);
    assert.match(proxyUiJs, /Enter both username and password, or leave both blank to keep saved credentials\./);
  });

  await t.test('zapper rules render selector text safely and expose disable/delete actions', () => {
    assert.match(appJs, /appendElement\(info, 'div', 'zapper-rule-selector', rule\.selector\)/);
    assert.match(appJs, /selector\.title = rule\.selector/);
    assert.match(appJs, /type: MSG\.ZAPPER_RULE_SET/);
    assert.match(appJs, /type: MSG\.ZAPPER_RULE_REMOVE/);
    assert.doesNotMatch(appJs, /escapeHTML\(rule\.selector\)/);
    assert.doesNotMatch(appJs, /zapper-rule-selector[\s\S]{0,200}innerHTML/);
  });

  await t.test('settings page supports direct proxy hash entry points', () => {
    assert.match(componentsJs, /id="proxySection"/);
    assert.match(appJs, /location\?\.hash !== '#proxy'/);
    assert.match(appJs, /scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/);
  });
});
