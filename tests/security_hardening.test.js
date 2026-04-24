const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backgroundJsCodeRaw = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
const backgroundJsCode = backgroundJsCodeRaw
  .replace('const DEBUG = false;', 'var DEBUG = true;')
  .replace("import { getDefaultDynamicRules } from './defaultDynamicRules.js';", "var getDefaultDynamicRules = () => [];")
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/subscriptions\/manager\.js['"];?/s, `
    var initSubscriptions      = async () => {};
    var ensureAlarm             = async () => {};
    var refreshAllStale         = async () => {};
    var refreshSubscription     = async () => ({ ok: true });
    var getSubscriptions        = async () => [];
    var setSubscriptionEnabled  = async () => ({ ok: true });
    var addSubscription         = async () => ({ ok: true });
    var removeSubscription      = async () => ({ ok: true });
  `)
  .replace("import { initScriptletEngine } from './scriptlets/engine.js';", "var initScriptletEngine = globalThis._mockInitScriptletEngine;")
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/crypto\.js['"];?/s, "var decryptAuth = globalThis._mockDecryptAuth; var encryptAuth = globalThis._mockEncryptAuth;")
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/messageTypes\.js['"];?/s, "var MSG = {};")
  .replace(/import\s*\*\s*as\s+router\s+from\s*['"]\.\/messageRouter\.js['"];?/s, "var router = { registerHandler: () => {}, markSensitive: () => {}, attachListener: () => {} };")
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/handlers\.js['"];?/s, "var registerAll = () => {};")
  .replace(/^export\s+/gm, "");

// ─── SECURITY HARDENING - BACKGROUND.JS ─────
test('Security Hardening - background.js', async (t) => {
  const sandbox = {};
  let messageHandler = null;
  let tabsRemoved = [];
  let dynamicRulesAdded = [];
  sandbox._sessionStore = {};

  const chromeMock = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { 
        addListener: (handler) => { messageHandler = handler; } 
      }
    },
    storage: {
      local: {
        get: async (keys) => {
          if (Array.isArray(keys)) {
             const res = {};
             if (keys.includes('dynamicRules')) res.dynamicRules = [];
             return res;
          }
          if (keys === 'dynamicRules') return { dynamicRules: [] };
          return { dynamicRules: [] };
        },
        set: () => Promise.resolve()
      },

      onChanged: { addListener: () => {} }
    },
    declarativeNetRequest: {
      getDynamicRules: () => Promise.resolve([]),
      updateDynamicRules: async (args) => {
        if (args.addRules) dynamicRulesAdded.push(...args.addRules);
        return Promise.resolve();
      },
      onRuleMatchedDebug: { addListener: () => {} }
    },
    tabs: {
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(),
      remove: async (id) => {
        tabsRemoved.push(id);
        return Promise.resolve();
      },
      onCreated: { addListener: () => {} },
      onRemoved: { 
        addListener: (fn) => { sandbox._onRemovedListener = fn; } 
      }
    },
    alarms: {
      create: () => {},
      get: () => Promise.resolve(null),
      onAlarm: { addListener: () => {} }
    },
  };
  sandbox.chrome = chromeMock;
  sandbox.crypto = {
    getRandomValues: (buffer) => {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] = Math.floor(Math.random() * 256);
      }
      return buffer;
    }
  };
  sandbox.console = {
    log: () => {},
    error: () => {},
    warn: () => {}
  };
  sandbox.setInterval = () => {};
  sandbox.setTimeout = setTimeout;
  sandbox.clearInterval = clearInterval;
  sandbox.clearTimeout = clearTimeout;
  sandbox.initScriptletEngine = async () => {};
  sandbox.Promise = Promise;
  sandbox.Object = Object;
  sandbox.Array = Array;
  sandbox.Error = Error;
  sandbox.Date = Date;
  sandbox.Map = Map;
  sandbox.Set = Set;
  sandbox.__CHROMA_INTERNAL_TEST_STRICT__ = true;
  chromeMock.tabs.get = (id) => Promise.resolve({ id, url: 'https://www.youtube.com/' });
  sandbox.globalThis = sandbox;
  sandbox.fetch = async () => ({ ok: false });
  sandbox.DEBUG = true;
  sandbox.__CHROMA_INTERNAL_TEST_STRICT__ = true;
  sandbox._mockInitScriptletEngine = async () => {};
  sandbox._mockDecryptAuth          = async () => ({ username: 'u', password: 'p' });
  sandbox._mockEncryptAuth          = async () => ({ iv: 'iv', ciphertext: 'ct' });
  chromeMock.proxy = {
    settings: {
      set: () => Promise.resolve(),
      get: () => Promise.resolve({})
    }
  };
  chromeMock.webRequest = {
    onAuthRequired: { addListener: () => {} }
  };

  vm.createContext(sandbox);
  vm.runInContext(backgroundJsCode, sandbox);


});
