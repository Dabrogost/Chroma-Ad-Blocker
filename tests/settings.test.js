const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const componentsJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'components.js'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'app.js'), 'utf8');
const proxyUiJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'proxy-ui.js'), 'utf8');
const uiCss = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'ui.css'), 'utf8');

async function settleDomAsyncWork(turns = 20) {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

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
    const addHandler = proxyUiJs.match(/addBtn\.onclick = async \(\) => \{[\s\S]*?scrollIntoView/);
    assert.ok(addHandler, 'expected settings add-proxy handler');
    assert.match(addHandler[0], /container\.insertBefore\(renderProxyCard\(newPc, proxyConfigs\.length - 1\), container\.querySelector\('\.proxy-chrome-service-bypass-control'\)\)/);
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

  await t.test('proxy router cards separate enabled toggle from GLOBAL selection', async () => {
    const dom = new JSDOM('<!doctype html><div id="proxyRouterContainer"></div><button id="addProxyServerBtn"></button>', {
      url: 'chrome-extension://test/ui/settings.html#proxy',
      runScripts: 'outside-only'
    });
    let proxyConfigs = [
      {
        id: 1,
        name: 'VPN',
        host: 'vpn.example.com',
        port: 8080,
        type: 'PROXY',
        accepted: true,
        enabled: true,
        domains: [],
        hasCredentials: false
      },
      {
        id: 2,
        name: 'BZ1',
        host: 'bz1.example.com',
        port: 8080,
        type: 'PROXY',
        accepted: true,
        enabled: true,
        domains: [
          { host: 'youtube.com', enabled: true },
          { host: 'twitch.tv', enabled: true }
        ],
        hasCredentials: false
      }
    ];
    const config = { globalProxyEnabled: true, globalProxyId: 1 };
    const messages = [];
    const sandbox = {
      window: dom.window,
      document: dom.window.document,
      console,
      confirm: () => true,
      setTimeout,
      clearTimeout,
      MSG: {
        CONFIG_GET: 'CONFIG_GET',
        CONFIG_SET: 'CONFIG_SET',
        PROXY_CONFIG_GET: 'PROXY_CONFIG_GET',
        PROXY_CONFIG_SET: 'PROXY_CONFIG_SET',
        PROXY_TEST: 'PROXY_TEST'
      },
      ChromaApp: {
        $: id => dom.window.document.getElementById(id),
        escapeHTML: value => String(value ?? '').replace(/[&<>"']/g, ch => ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;'
        }[ch])),
        isSettingsPage: () => true,
        openProxySettings: () => {}
      },
      chrome: {
        storage: {
          local: {
            get: async key => {
              if (key === 'config') return { config };
              return {};
            }
          }
        }
      },
      notifyBackground: async msg => {
        messages.push(msg);
        if (msg.type === 'CONFIG_GET') return config;
        if (msg.type === 'PROXY_CONFIG_GET') return proxyConfigs;
        if (msg.type === 'PROXY_TEST') return { ok: true, ip: msg.proxyId === 1 ? '198.51.100.1' : '198.51.100.2' };
        if (msg.type === 'PROXY_CONFIG_SET') {
          proxyConfigs = msg.proxyConfigs;
          return { ok: true };
        }
        if (msg.type === 'CONFIG_SET') {
          Object.assign(config, msg.config);
          return { ok: true };
        }
        return {};
      }
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(proxyUiJs, sandbox);

    await sandbox.ChromaProxyUI.loadProxyRouterUI();
    await settleDomAsyncWork();

    const chromeBypassToggle = dom.window.document.querySelector('.proxy-chrome-service-bypass-toggle');
    const chromeBypassWarning = dom.window.document.querySelector('.proxy-chrome-service-bypass-warning');
    assert.ok(chromeBypassToggle, 'expected Chrome service bypass toggle');
    assert.strictEqual(chromeBypassToggle.checked, true);
    assert.match(
      dom.window.document.querySelector('.proxy-chrome-service-bypass-control .desc').textContent,
      /Chrome AI \/ Gemini Nano/
    );
    assert.strictEqual(chromeBypassWarning.classList.contains('is-hidden'), true);

    chromeBypassToggle.checked = false;
    chromeBypassToggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(config.chromeServiceProxyBypass, false);
    assert.strictEqual(chromeBypassWarning.classList.contains('is-hidden'), false);
    assert.ok(messages.some(msg =>
      msg.type === 'CONFIG_SET' &&
      msg.config.chromeServiceProxyBypass === false
    ));

    chromeBypassToggle.checked = true;
    chromeBypassToggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(config.chromeServiceProxyBypass, true);
    assert.strictEqual(chromeBypassWarning.classList.contains('is-hidden'), true);

    const cards = [...dom.window.document.querySelectorAll('.proxy-card')];
    assert.strictEqual(cards.length, 2);
    const proxyChildren = [...dom.window.document.querySelectorAll('#proxyRouterContainer > *')];
    assert.ok(
      proxyChildren.indexOf(cards[1]) <
        proxyChildren.indexOf(dom.window.document.querySelector('.proxy-chrome-service-bypass-control')),
      'proxy cards should render before global compatibility controls'
    );
    assert.strictEqual(cards[1].querySelector('.proxy-enabled-toggle').checked, true);
    assert.match(cards[1].querySelector('.proxy-status-text').textContent, /ROUTING 2 DOMAINS/);
    assert.strictEqual(cards[0].querySelector('.proxy-global-btn').classList.contains('is-active'), true);
    assert.strictEqual(cards[1].querySelector('.proxy-global-btn').classList.contains('is-active'), false);
    assert.strictEqual(cards[0].querySelector('.proxy-domain-tools').classList.contains('is-hidden'), true);
    assert.strictEqual(cards[1].querySelector('.proxy-domain-tools').classList.contains('is-hidden'), false);

    cards[1].querySelector('.proxy-global-btn').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(config.globalProxyEnabled, true);
    assert.strictEqual(config.globalProxyId, 2);
    assert.strictEqual(proxyConfigs.find(pc => pc.id === 2).enabled, true);
    assert.strictEqual(cards[0].querySelector('.proxy-global-btn').classList.contains('is-active'), false);
    assert.strictEqual(cards[1].querySelector('.proxy-global-btn').classList.contains('is-active'), true);
    assert.strictEqual(cards[0].querySelector('.proxy-domain-tools').classList.contains('is-hidden'), false);
    assert.strictEqual(cards[1].querySelector('.proxy-domain-tools').classList.contains('is-hidden'), true);
    assert.ok(messages.some(msg =>
      msg.type === 'PROXY_CONFIG_SET' &&
      msg.proxyConfigs.some(pc => pc.id === 2 && pc.enabled === true)
    ));

    const bz1EnabledToggle = cards[1].querySelector('.proxy-enabled-toggle');
    bz1EnabledToggle.checked = false;
    bz1EnabledToggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(config.globalProxyEnabled, true);
    assert.strictEqual(config.globalProxyId, 2);
    assert.strictEqual(proxyConfigs.find(pc => pc.id === 2).enabled, false);
    assert.strictEqual(cards[1].querySelector('.proxy-global-btn').classList.contains('is-active'), true);
    assert.strictEqual(cards[1].querySelector('.proxy-domain-tools').classList.contains('is-hidden'), true);
    assert.match(cards[1].querySelector('.proxy-status-text').textContent, /DISABLED/);

    bz1EnabledToggle.checked = true;
    bz1EnabledToggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(config.globalProxyEnabled, true);
    assert.strictEqual(config.globalProxyId, 2);
    assert.strictEqual(proxyConfigs.find(pc => pc.id === 2).enabled, true);
    assert.strictEqual(cards[1].querySelector('.proxy-global-btn').classList.contains('is-active'), true);
    assert.strictEqual(cards[1].querySelector('.proxy-domain-tools').classList.contains('is-hidden'), true);

    cards[1].querySelector('.proxy-global-btn').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(config.globalProxyEnabled, false);
    assert.strictEqual(config.globalProxyId, null);
    assert.strictEqual(cards[1].querySelector('.proxy-global-btn').classList.contains('is-active'), false);
    assert.strictEqual(cards[1].querySelector('.proxy-domain-tools').classList.contains('is-hidden'), false);

    chromeBypassToggle.checked = false;
    chromeBypassToggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(config.chromeServiceProxyBypass, false);
    assert.strictEqual(chromeBypassWarning.classList.contains('is-hidden'), true);

    cards[1].querySelector('.proxy-global-btn').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(config.globalProxyEnabled, true);
    assert.strictEqual(config.globalProxyId, 2);
    assert.strictEqual(chromeBypassWarning.classList.contains('is-hidden'), false);
  });

  await t.test('proxy domain names override generic toggle heading size', () => {
    assert.match(uiCss, /\.toggle-info \.name \{ font-size: 16px/);
    assert.match(uiCss, /\.toggle-info \.proxy-domain-name\s*\{[\s\S]*font-size: 13px/);
  });

  await t.test('active proxy global button has a distinct highlighted style', () => {
    assert.match(proxyUiJs, /proxy-global-btn compact-action-btn" title="Use as Global Fallback">GLOBAL/);
    assert.match(proxyUiJs, /proxy-enabled-toggle/);
    assert.match(uiCss, /\.proxy-global-btn\.is-active\s*\{/);
    assert.match(uiCss, /\.proxy-global-btn\.is-active\s*\{[\s\S]*box-shadow:/);
    assert.doesNotMatch(proxyUiJs, /proxy-global-toggle/);
  });

  await t.test('Chrome service bypass control is visible and wraps its description', () => {
    assert.match(proxyUiJs, /Bypass Chrome Browser Services/);
    assert.match(proxyUiJs, /chromeServiceProxyBypass: toggle\.checked/);
    assert.match(proxyUiJs, /config\.chromeServiceProxyBypass !== false/);
    assert.match(uiCss, /\.proxy-chrome-service-bypass-control \.desc\s*\{[\s\S]*white-space: normal/);
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

  await t.test('settings statistics panel is local-only and uses stats messages', () => {
    assert.match(componentsJs, /Protection Intelligence/);
    assert.match(componentsJs, /All statistics are stored locally/);
    assert.match(componentsJs, /statBreakdownProxy/);
    assert.doesNotMatch(componentsJs, /statBreakdownYoutube/);
    assert.match(componentsJs, /id="statisticsPanel"/);
    assert.match(componentsJs, /id="resetAllStats"/);
    assert.match(componentsJs, /id="resetSiteStats"/);
    assert.match(componentsJs, /id="resetRequestLogOnly"/);
    assert.match(componentsJs, /id="exportStatsJson"/);
    assert.match(appJs, /type: MSG\.STATS_GET/);
    assert.match(appJs, /type: MSG\.STATS_RESET, scope: 'sites'/);
    assert.match(appJs, /type: MSG\.STATS_RESET, scope: 'debugLog'/);
    assert.match(appJs, /type: MSG\.STATS_EXPORT/);
    assert.match(appJs, /type: MSG\.STATS_SETTINGS_SET/);
    assert.match(appJs, /Ad Cleanups/);
    assert.match(appJs, /Proxy Activity/);
    assert.match(appJs, /Time Saved \(est\.\)/);
    assert.match(appJs, /Allow Rule/);
    assert.match(appJs, /Allows \$\{formatCompactCount\(allows\)\}/);
    assert.doesNotMatch(appJs, /YouTube Payload Cleans/);
  });
});
