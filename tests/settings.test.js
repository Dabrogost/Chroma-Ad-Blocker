const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const componentsJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'components.js'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'app.js'), 'utf8');
const proxyUiJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'proxy-ui.js'), 'utf8');
const uiCss = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'ui.css'), 'utf8');

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

  await t.test('adding another proxy preserves unsaved proxy card drafts', () => {
    const addHandler = proxyUiJs.match(/addBtn\.onclick = async \(\) => \{[\s\S]*?container\.lastElementChild\?\.scrollIntoView/);
    assert.ok(addHandler, 'expected settings add-proxy handler');
    assert.match(addHandler[0], /container\.appendChild\(renderProxyCard\(newPc, proxyConfigs\.length - 1\)\)/);
    assert.doesNotMatch(addHandler[0], /renderAll\(\)/);
  });

  await t.test('proxy destructive actions use compact button styling', () => {
    assert.match(proxyUiJs, /proxy-del-server-btn inline-danger-btn compact-action-btn/);
    assert.match(proxyUiJs, /d-del-btn inline-danger-btn compact-action-btn/);
    assert.match(proxyUiJs, /proxy-clear-settings-btn inline-danger-btn compact-action-btn/);
    assert.match(appJs, /zapper-rule-delete inline-danger-btn compact-action-btn/);
    assert.match(uiCss, /\.inline-danger-btn\.compact-action-btn\s*\{/);
    assert.match(uiCss, /\.inline-danger-btn\.compact-action-btn\s*\{[\s\S]*border: 1px solid var\(--border-glass\)/);
    assert.match(uiCss, /\.inline-danger-btn\.compact-action-btn\s*\{[\s\S]*background: rgba\(108, 92, 231, 0\.12\)/);
  });

  await t.test('proxy domain names override generic toggle heading size', () => {
    assert.match(uiCss, /\.toggle-info \.name \{ font-size: 16px/);
    assert.match(uiCss, /\.toggle-info \.proxy-domain-name\s*\{[\s\S]*font-size: 13px/);
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
