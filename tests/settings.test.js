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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createSettingsHarness({
  url = 'chrome-extension://test/ui/settings.html',
  responses = {},
  pending = {}
} = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="appShell"></div></body>', {
    url,
    runScripts: 'outside-only'
  });
  const messages = [];
  const storageState = {};
  const defaultStats = {
    settings: { mode: 'aggregated', retentionDays: 90 },
    totals: { protectionEvents: 42, networkBlocks: 7, cosmeticHides: 2, youtubePayloadCleans: 1, scriptletHits: 3 },
    ranges: {
      today: { protectionEvents: 1 },
      last7Days: { protectionEvents: 7 },
      last30Days: { protectionEvents: 30 },
      allTime: { protectionEvents: 42 }
    },
    bySite: { example: { domain: 'example.com', protectionEvents: 4, lastSeen: Date.now() } },
    byRule: { r1: { ruleId: 1, networkBlocks: 4, ruleSource: 'test' } },
    byDay: { today: { day: '2026-05-12', protectionEvents: 4 } },
    recentEvents: [{ layer: 'network', type: 'block', domain: 'example.com', count: 2 }],
    timeSavedSeconds: 12
  };
  const defaultHealth = {
    overall: { status: 'healthy', issues: [] },
    manifest: { version: '1.0.1', minimumChromeVersion: '120' },
    master: { enabled: true, networkBlocking: true, trackingUrlCleanup: true },
    dnr: { enabledStaticRulesets: ['a'], expectedStaticRulesets: ['a'], staticRulesetsOk: true, appliedNetworkRuleCount: 12, whitelistRuleCount: 0, trackingUrlCleanupRuleCount: 1, trackingUrlCleanupActive: true },
    subscriptions: { enabled: 1, total: 1, appliedNetwork: 12, cosmetic: 4, scriptlet: 2, withErrors: 0 },
    scriptlets: { apiAvailable: true, registeredUserScriptCount: 2, storedRuleCount: 2 },
    fpr: { enabled: true, active: true, protectedSurfaces: ['Canvas', 'WebGL', 'Audio', 'Navigator', 'Language APIs'] },
    cosmetic: { subscriptionCosmeticRuleCount: 4, enabledLocalZapperRuleCount: 0, localZapperRuleCount: 0 },
    proxy: { configuredCount: 0, acceptedCount: 0, routedDomainCount: 0, globalProxyEnabled: false, globalProxyConfigured: false },
    webrtc: { available: true, mode: 'auto', protected: true },
    requestLog: { available: true, entryCount: 0, maxEntries: 200, note: '' }
  };

  const sandbox = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    console,
    confirm: () => true,
    setTimeout,
    clearTimeout,
    Blob: dom.window.Blob,
    URL: dom.window.URL,
    MSG: {
      CONFIG_GET: 'CONFIG_GET',
      CONFIG_SET: 'CONFIG_SET',
      UPDATE_CHECK: 'UPDATE_CHECK',
      STATS_GET: 'STATS_GET',
      STATS_RESET: 'STATS_RESET',
      STATS_EXPORT: 'STATS_EXPORT',
      STATS_SETTINGS_SET: 'STATS_SETTINGS_SET',
      HEALTH_GET: 'HEALTH_GET',
      PROXY_CONFIG_GET: 'PROXY_CONFIG_GET',
      PROXY_CONFIG_SET: 'PROXY_CONFIG_SET',
      PROXY_TEST: 'PROXY_TEST',
      SUBSCRIPTION_GET: 'SUBSCRIPTION_GET',
      SUBSCRIPTION_SET: 'SUBSCRIPTION_SET',
      SUBSCRIPTION_REFRESH: 'SUBSCRIPTION_REFRESH',
      SUBSCRIPTION_REMOVE: 'SUBSCRIPTION_REMOVE',
      SUBSCRIPTION_ADD: 'SUBSCRIPTION_ADD',
      ZAPPER_RULES_GET: 'ZAPPER_RULES_GET',
      ZAPPER_RULE_SET: 'ZAPPER_RULE_SET',
      ZAPPER_RULE_REMOVE: 'ZAPPER_RULE_REMOVE',
      ZAPPER_START: 'ZAPPER_START',
      WHITELIST_GET: 'WHITELIST_GET',
      WHITELIST_ADD: 'WHITELIST_ADD',
      WHITELIST_REMOVE: 'WHITELIST_REMOVE',
      FPR_WHITELIST_GET: 'FPR_WHITELIST_GET',
      FPR_WHITELIST_ADD: 'FPR_WHITELIST_ADD',
      FPR_WHITELIST_REMOVE: 'FPR_WHITELIST_REMOVE',
      LOG_GET: 'LOG_GET'
    },
    chrome: {
      runtime: {
        getManifest: () => ({ version: '1.0.1' }),
        getURL: path => `chrome-extension://test/${path}`,
        openOptionsPage: () => {}
      },
      storage: {
        local: {
          get: async keys => {
            if (typeof keys === 'string') return { [keys]: storageState[keys] };
            if (Array.isArray(keys)) {
              const result = {};
              keys.forEach(key => { result[key] = storageState[key]; });
              return result;
            }
            return storageState;
          },
          set: async value => Object.assign(storageState, value)
        },
        onChanged: { addListener: () => {} }
      },
      tabs: {
        query: async () => [{ id: 7, url: 'https://www.example.com/watch' }],
        create: async () => {},
        reload: () => {}
      }
    },
    notifyBackground: msg => {
      messages.push(msg);
      if (pending[msg.type]) return pending[msg.type].promise;
      if (Object.prototype.hasOwnProperty.call(responses, msg.type)) {
        const value = responses[msg.type];
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
      }
      if (msg.type === 'CONFIG_GET') return Promise.resolve({ enabled: true, acceleration: false, cosmetic: true });
      if (msg.type === 'UPDATE_CHECK') return Promise.resolve({ updateAvailable: false });
      if (msg.type === 'STATS_GET') return Promise.resolve(defaultStats);
      if (msg.type === 'HEALTH_GET') return Promise.resolve(defaultHealth);
      if (msg.type === 'SUBSCRIPTION_GET') return Promise.resolve([]);
      if (msg.type === 'PROXY_CONFIG_GET') return Promise.resolve([]);
      if (msg.type === 'ZAPPER_RULES_GET') return Promise.resolve({ rules: [] });
      if (msg.type === 'WHITELIST_GET') return Promise.resolve({ whitelist: [] });
      if (msg.type === 'FPR_WHITELIST_GET') return Promise.resolve({ fprWhitelist: [] });
      if (msg.type === 'LOG_GET') return Promise.resolve([]);
      return Promise.resolve({ ok: true });
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext([componentsJs, appJs, proxyUiJs].join('\n'), sandbox);
  return { dom, sandbox, messages, pending };
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
    assert.strictEqual(cards[0].querySelector('.proxy-global-btn').classList.contains('is-active'), false);
    assert.strictEqual(cards[1].querySelector('.proxy-global-btn').classList.contains('is-active'), true);
    assert.strictEqual(cards[0].querySelector('.proxy-domain-tools').classList.contains('is-hidden'), false);
    assert.strictEqual(cards[1].querySelector('.proxy-domain-tools').classList.contains('is-hidden'), true);
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
    assert.strictEqual(cards[1].querySelector('.proxy-global-btn').classList.contains('is-active'), false);
    assert.strictEqual(cards[1].querySelector('.proxy-domain-tools').classList.contains('is-hidden'), false);
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
    assert.match(appJs, /PROXY_SETTINGS_PATH = 'ui\/settings\.html#proxySection'/);
    assert.match(appJs, /\['#proxy', '#proxySection'\]\.includes\(globalThis\.location\?\.hash\)/);
    assert.match(appJs, /scrollIntoView\(\{ behavior, block: 'start' \}\)/);
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

  await t.test('settings shell renders section skeletons synchronously', () => {
    const dom = new JSDOM('<!doctype html><body><div id="appShell"></div></body>', {
      url: 'chrome-extension://test/ui/settings.html',
      runScripts: 'outside-only'
    });
    const sandbox = { document: dom.window.document, globalThis: null };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(componentsJs, sandbox);

    sandbox.ChromaComponents.renderPageShell({ settingsMode: true });

    assert.ok(dom.window.document.querySelector('#healthPanelBody .skeleton-card'));
    assert.ok(dom.window.document.querySelector('#statisticsTopCards .skeleton-card'));
    assert.ok(dom.window.document.querySelector('#statsSitesList .skeleton-row'));
    assert.ok(dom.window.document.querySelector('#subscriptionList .skeleton-row'));
    assert.ok(dom.window.document.querySelector('#proxyRouterContainer .skeleton-row'));
    assert.ok(dom.window.document.querySelector('#localZapperRules .skeleton-row'));
    assert.strictEqual(dom.window.document.querySelector('#statsModeSelect').disabled, true);
  });

  await t.test('popup shell does not render settings-only skeleton sections', () => {
    const dom = new JSDOM('<!doctype html><body><div id="appShell"></div></body>', {
      url: 'chrome-extension://test/ui/popup.html',
      runScripts: 'outside-only'
    });
    const sandbox = { document: dom.window.document, globalThis: null };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(componentsJs, sandbox);

    sandbox.ChromaComponents.renderPageShell({ settingsMode: false });

    assert.strictEqual(dom.window.document.querySelector('#healthPanelBody'), null);
    assert.strictEqual(dom.window.document.querySelector('#statisticsTopCards'), null);
    assert.strictEqual(dom.window.document.querySelector('#localZapperRules'), null);
    assert.strictEqual(dom.window.document.querySelector('#subscriptionList .skeleton-row'), null);
    assert.strictEqual(dom.window.document.querySelector('#proxyRouterContainer .skeleton-row'), null);
  });

  await t.test('health skeleton is replaced on success and on unavailable response', async () => {
    const success = createSettingsHarness();
    await success.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    assert.strictEqual(success.dom.window.document.querySelector('#healthPanelBody .skeleton-card'), null);
    assert.match(success.dom.window.document.querySelector('#healthOverallLabel').textContent, /Healthy/);
    assert.ok(success.dom.window.document.querySelector('#healthPanelBody .health-section'));
    assert.match(success.dom.window.document.querySelector('#healthPanelBody').textContent, /De-AMP links\s*Disabled/);
    assert.match(success.dom.window.document.querySelector('#healthPanelBody').textContent, /Fingerprint Randomization\s*Active/);
    assert.match(success.dom.window.document.querySelector('#healthPanelBody').textContent, /Language APIs/);

    const failure = createSettingsHarness({ responses: { HEALTH_GET: null } });
    await failure.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    assert.strictEqual(failure.dom.window.document.querySelector('#healthPanelBody .skeleton-card'), null);
    assert.match(failure.dom.window.document.querySelector('#healthOverallLabel').textContent, /Unavailable/);
    assert.match(failure.dom.window.document.querySelector('#healthPanelBody').textContent, /Could not load health diagnostics/);
  });

  await t.test('health panel surfaces Allow User Scripts diagnostic', async () => {
    const harness = createSettingsHarness({
      responses: {
        HEALTH_GET: {
          overall: {
            status: 'degraded',
            issues: [{
              severity: 'warning',
              area: 'scriptlets',
              message: 'Scriptlet engine unavailable. Enable Allow User Scripts for this extension in Chrome extension details.',
              action: 'Open Chrome extension details and enable Allow User Scripts.'
            }]
          },
          manifest: { version: '1.0.1', minimumChromeVersion: '120' },
          master: { enabled: true, networkBlocking: true },
          dnr: { enabledStaticRulesets: ['a'], expectedStaticRulesets: ['a'], staticRulesetsOk: true, appliedNetworkRuleCount: 12, whitelistRuleCount: 0 },
          subscriptions: { enabled: 1, total: 1, appliedNetwork: 12, cosmetic: 4, scriptlet: 1, withErrors: 0 },
          scriptlets: {
            apiAvailable: false,
            registeredUserScriptCount: null,
            storedRuleCount: 1,
            registrationStatus: 'unavailable',
            error: null
          },
          cosmetic: { subscriptionCosmeticRuleCount: 4, enabledLocalZapperRuleCount: 0, localZapperRuleCount: 0 },
          proxy: { configuredCount: 0, acceptedCount: 0, routedDomainCount: 0, globalProxyEnabled: false, globalProxyConfigured: false },
          webrtc: { available: true, mode: 'auto', protected: true },
          requestLog: { available: true, entryCount: 0, maxEntries: 200, note: '' }
        }
      }
    });

    await harness.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    const bodyText = harness.dom.window.document.querySelector('#healthPanelBody').textContent;

    assert.match(bodyText, /UserScripts API\s*Unavailable/i);
    assert.match(bodyText, /Registered scripts\s*Unavailable/i);
    assert.match(bodyText, /Enable Allow User Scripts/i);
    assert.match(bodyText, /Chrome extension details/i);
  });

  await t.test('health panel reports Tracking URL Cleanup when its DNR rule is missing', async () => {
    const harness = createSettingsHarness({
      responses: {
        HEALTH_GET: {
          overall: {
            status: 'degraded',
            issues: [{
              severity: 'warning',
              area: 'trackingUrlCleanup',
              message: 'Tracking URL Cleanup is enabled but its DNR redirect rule is not registered.',
              action: 'Reload the extension, or turn Tracking URL Cleanup off and on.'
            }]
          },
          manifest: { version: '1.0.1', minimumChromeVersion: '120' },
          master: { enabled: true, networkBlocking: true, trackingUrlCleanup: true },
          dnr: {
            enabledStaticRulesets: ['a'],
            expectedStaticRulesets: ['a'],
            staticRulesetsOk: true,
            appliedNetworkRuleCount: 12,
            whitelistRuleCount: 0,
            trackingUrlCleanupRuleCount: 0,
            trackingUrlCleanupActive: false
          },
          subscriptions: { enabled: 1, total: 1, appliedNetwork: 12, cosmetic: 4, scriptlet: 0, withErrors: 0 },
          scriptlets: { apiAvailable: true, registeredUserScriptCount: 0, storedRuleCount: 0 },
          cosmetic: { subscriptionCosmeticRuleCount: 4, enabledLocalZapperRuleCount: 0, localZapperRuleCount: 0 },
          proxy: { configuredCount: 0, acceptedCount: 0, routedDomainCount: 0, globalProxyEnabled: false, globalProxyConfigured: false },
          webrtc: { available: true, mode: 'auto', protected: true },
          requestLog: { available: true, entryCount: 0, maxEntries: 200, note: '' }
        }
      }
    });

    await harness.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    const bodyText = harness.dom.window.document.querySelector('#healthPanelBody').textContent;
    assert.match(bodyText, /Tracking URL cleanup\s*Not registered/i);
    assert.match(bodyText, /DNR redirect rule is not registered/i);
  });

  await t.test('stats skeleton is replaced on success and on unavailable response', async () => {
    const success = createSettingsHarness();
    await success.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    assert.strictEqual(success.dom.window.document.querySelector('#statisticsTopCards .skeleton-card'), null);
    assert.match(success.dom.window.document.querySelector('#statisticsTopCards').textContent, /Total Protection Events/);
    assert.strictEqual(success.dom.window.document.querySelector('#statsModeSelect').disabled, false);

    const failure = createSettingsHarness({ responses: { STATS_GET: null } });
    await failure.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    assert.strictEqual(failure.dom.window.document.querySelector('#statisticsTopCards .skeleton-card'), null);
    assert.match(failure.dom.window.document.querySelector('#statsSitesList').textContent, /No stats available/);
    assert.strictEqual(failure.dom.window.document.querySelector('#statsModeSelect').disabled, true);
  });

  await t.test('config-backed toggles stay pending until CONFIG_GET resolves', async () => {
    const pendingConfig = deferred();
    const harness = createSettingsHarness({ pending: { CONFIG_GET: pendingConfig } });

    const initPromise = harness.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork(2);

    assert.strictEqual(harness.dom.window.document.querySelector('#toggleEnabled').disabled, true);
    assert.ok(harness.dom.window.document.querySelector('#toggleNetwork').classList.contains('control-pending'));

    pendingConfig.resolve({ enabled: true, networkBlocking: false, acceleration: true, accelerationSpeed: 12 });
    await initPromise;

    assert.strictEqual(harness.dom.window.document.querySelector('#toggleEnabled').disabled, false);
    assert.strictEqual(harness.dom.window.document.querySelector('#toggleNetwork').checked, false);
    assert.strictEqual(harness.dom.window.document.querySelector('#toggleAcceleration').checked, true);
    assert.ok(harness.dom.window.document.querySelector('.speed-btn[data-speed="12"]').classList.contains('active'));
  });

  await t.test('settings config null keeps controls disabled and shows an error', async () => {
    const harness = createSettingsHarness({ responses: { CONFIG_GET: null } });

    await harness.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    assert.strictEqual(harness.dom.window.document.querySelector('#toggleEnabled').disabled, true);
    assert.strictEqual(harness.dom.window.document.querySelector('#toggleNetwork').disabled, true);
    assert.match(harness.dom.window.document.querySelector('.hydration-error--inline').textContent, /Settings are unavailable/);
    [
      'healthPanelBody',
      'statisticsTopCards',
      'statsRangeSummary',
      'statsSitesList',
      'statsRulesList',
      'statsTimelineList',
      'statsEventsList',
      'subscriptionList',
      'proxyRouterContainer',
      'localZapperRules'
    ].forEach(id => {
      const section = harness.dom.window.document.getElementById(id);
      assert.ok(section, `${id} should exist`);
      assert.strictEqual(section.querySelector('.skeleton-row, .skeleton-card, .skeleton-grid'), null, `${id} should not keep skeletons`);
      assert.match(section.textContent, /Unavailable until the extension background responds/);
    });
    assert.strictEqual(harness.messages.some(message => message.type === 'STATS_GET'), false);
  });

  await t.test('initSharedUI does not await slow settings section hydration', async () => {
    const slow = {
      STATS_GET: deferred(),
      HEALTH_GET: deferred(),
      SUBSCRIPTION_GET: deferred(),
      PROXY_CONFIG_GET: deferred(),
      ZAPPER_RULES_GET: deferred()
    };
    const harness = createSettingsHarness({ pending: slow });

    await harness.sandbox.ChromaApp.initSharedUI();

    assert.ok(harness.messages.some(message => message.type === 'STATS_GET'));
    assert.ok(harness.messages.some(message => message.type === 'HEALTH_GET'));
    assert.ok(harness.messages.some(message => message.type === 'SUBSCRIPTION_GET'));
    assert.ok(harness.messages.some(message => message.type === 'PROXY_CONFIG_GET'));
    assert.ok(harness.messages.some(message => message.type === 'ZAPPER_RULES_GET'));
    assert.ok(harness.dom.window.document.querySelector('#statisticsTopCards .skeleton-card'));

    slow.STATS_GET.resolve(null);
    slow.HEALTH_GET.resolve(null);
    slow.SUBSCRIPTION_GET.resolve([]);
    slow.PROXY_CONFIG_GET.resolve([]);
    slow.ZAPPER_RULES_GET.resolve({ rules: [] });
  });

  await t.test('settings proxy hash scrolls proxy header after synchronous shell render', async () => {
    const harness = createSettingsHarness({ url: 'chrome-extension://test/ui/settings.html#proxySection' });
    await harness.sandbox.ChromaApp.initSharedUI();
    const section = harness.dom.window.document.querySelector('#proxySection');
    let scrollOptions = null;
    section.scrollIntoView = options => {
      scrollOptions = options;
    };

    harness.sandbox.ChromaApp.scrollToProxyHash();
    await settleDomAsyncWork();

    assert.strictEqual(scrollOptions?.behavior, 'smooth');
    assert.strictEqual(scrollOptions?.block, 'start');
  });

  await t.test('settings proxy hash ignores requestAnimationFrame timestamps', async () => {
    const harness = createSettingsHarness({ url: 'chrome-extension://test/ui/settings.html#proxySection' });
    await harness.sandbox.ChromaApp.initSharedUI();
    const section = harness.dom.window.document.querySelector('#proxySection');
    let scrollOptions = null;
    section.scrollIntoView = options => {
      scrollOptions = options;
    };
    harness.sandbox.requestAnimationFrame = callback => {
      callback(83.1);
    };

    harness.sandbox.ChromaApp.scrollToProxyHash();

    assert.strictEqual(scrollOptions?.behavior, 'smooth');
    assert.strictEqual(scrollOptions?.block, 'start');
  });

  await t.test('settings proxy hash still supports legacy proxy hash', async () => {
    const harness = createSettingsHarness({ url: 'chrome-extension://test/ui/settings.html#proxy' });
    await harness.sandbox.ChromaApp.initSharedUI();
    const section = harness.dom.window.document.querySelector('#proxySection');
    let scrolled = false;
    section.scrollIntoView = () => {
      scrolled = true;
    };

    harness.sandbox.ChromaApp.scrollToProxyHash();
    await settleDomAsyncWork();

    assert.strictEqual(scrolled, true);
  });

  await t.test('settings proxy hash scrolls proxy header again after proxy hydration', async () => {
    const slow = { PROXY_CONFIG_GET: deferred() };
    const harness = createSettingsHarness({
      url: 'chrome-extension://test/ui/settings.html#proxySection',
      pending: slow
    });
    await harness.sandbox.ChromaApp.initSharedUI();
    const section = harness.dom.window.document.querySelector('#proxySection');
    const scrollBlocks = [];
    section.scrollIntoView = options => {
      scrollBlocks.push(options?.block);
    };
    slow.PROXY_CONFIG_GET.resolve([]);
    await settleDomAsyncWork();

    assert.ok(scrollBlocks.includes('start'));
  });

  await t.test('settings proxy hash keeps realigning proxy header after delayed layout growth', async () => {
    const harness = createSettingsHarness({ url: 'chrome-extension://test/ui/settings.html#proxySection' });
    await harness.sandbox.ChromaApp.initSharedUI();
    const section = harness.dom.window.document.querySelector('#proxySection');
    const scrollCalls = [];
    section.scrollIntoView = options => {
      scrollCalls.push(options);
    };

    harness.sandbox.ChromaApp.scrollToProxyHash();
    await new Promise(resolve => setTimeout(resolve, 180));

    assert.strictEqual(scrollCalls.at(-1)?.behavior, 'auto');
    assert.strictEqual(scrollCalls.at(-1)?.block, 'start');
  });

  await t.test('skeleton CSS includes reduced-motion handling', () => {
    assert.match(uiCss, /\.skeleton-line/);
    assert.match(uiCss, /@keyframes skeleton-shimmer/);
    assert.match(uiCss, /prefers-reduced-motion: reduce/);
    assert.match(uiCss, /\.hydration-fade-in/);
  });
});
