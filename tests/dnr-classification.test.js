const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const manifest = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'manifest.json'),
  'utf8'
));

const dnrStateCode = '{\n' + fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'background', 'dnrState.js'),
  'utf8'
)
  .replace("import { getDefaultDynamicRules } from './defaultDynamicRules.js';", 'var getDefaultDynamicRules = () => [];')
  .replace(
    "import { clearHealthDiagnostic, recordHealthDiagnostic } from './diagnostics.js';",
    'var clearHealthDiagnostic = async () => {}; var recordHealthDiagnostic = async () => {};'
  )
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*['"]\.\.\/subscriptions\/dnr\.js['"];?/, `
    var buildSubscriptionRuleApplication = () => ({
      networkRules: [],
      appliedNetworkRuleCount: 0,
      appliedNetworkRulesPerSub: {}
    });
    var prepareSubscriptionRules = rules => rules;
  `)
  .replace(/^export\s+/gm, '')
  + `
globalThis.__dnrClassification = {
  classifyDnrMatch,
  hydrateDynamicRuleClassifications,
  isDynamicRuleClassificationReady
};
` + '\n}\n';

const requestLogCode = '{\n' + fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'background', 'requestLog.js'),
  'utf8'
)
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/dnrState\.js['"];?/, `
    var classifyDnrMatch = globalThis.__dnrClassification.classifyDnrMatch;
    var hydrateDynamicRuleClassifications = globalThis.__dnrClassification.hydrateDynamicRuleClassifications;
    var isDynamicRuleClassificationReady = globalThis.__dnrClassification.isDynamicRuleClassificationReady;
  `)
  .replace("import { recordStatsEvent } from './stats.js';", 'var recordStatsEvent = globalThis.__recordStatsEvent;')
  .replace(/^export\s+/gm, '')
  + `
globalThis.__requestLog = { initRequestLogListener, getMergedLog, resetRequestLog, flushLog };
` + '\n}\n';

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function matchedInfo(ruleId, url = 'https://example.test/resource.js') {
  return {
    request: { url, type: 'script', tabId: 7 },
    rule: { ruleId }
  };
}

function loadHarness(options = {}) {
  const stored = { requestLog: [] };
  const storageWrites = [];
  const statsEvents = [];
  let listener = null;
  let dynamicRuleReads = 0;

  const chrome = {
    runtime: { getManifest: () => manifest },
    storage: {
      local: {
        get: async (keys) => {
          if (typeof keys === 'string') return { [keys]: stored[keys] };
          return { ...stored };
        },
        set: async (values) => {
          storageWrites.push(plain(values));
          Object.assign(stored, plain(values));
        }
      }
    },
    declarativeNetRequest: {
      getDynamicRules: async () => {
        dynamicRuleReads++;
        if (options.getDynamicRules) return options.getDynamicRules();
        return plain(options.dynamicRules || []);
      },
      updateDynamicRules: async () => {},
      updateEnabledRulesets: async () => {},
      onRuleMatchedDebug: options.withDebugEvent === false ? undefined : {
        addListener: callback => { listener = callback; }
      }
    }
  };

  const sandbox = {
    chrome,
    console,
    URL,
    Date,
    setTimeout: () => 1,
    clearTimeout: () => {},
    __recordStatsEvent: event => statsEvents.push(plain(event))
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(dnrStateCode, sandbox);
  vm.runInContext(requestLogCode, sandbox);

  return {
    dnr: sandbox.__dnrClassification,
    requestLog: sandbox.__requestLog,
    emit: info => listener(info),
    get listener() { return listener; },
    get dynamicRuleReads() { return dynamicRuleReads; },
    statsEvents,
    storageWrites,
    chrome,
    stored
  };
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

test('DNR diagnostics classify installed dynamic rule actions', async (t) => {
  await t.test('subscription allow and block actions come from the hydrated runtime rules', async () => {
    const harness = loadHarness({
      dynamicRules: [
        { id: 100000, action: { type: 'allow' }, condition: { urlFilter: '||allowed.example^' } },
        { id: 100001, action: { type: 'block' }, condition: { urlFilter: '||blocked.example^' } }
      ]
    });

    assert.strictEqual(harness.dnr.classifyDnrMatch(matchedInfo(100000)).type, 'match');
    await harness.dnr.hydrateDynamicRuleClassifications();

    assert.strictEqual(harness.dnr.classifyDnrMatch(matchedInfo(100000)).type, 'allow');
    assert.strictEqual(harness.dnr.classifyDnrMatch(matchedInfo(100001)).type, 'block');
    assert.strictEqual(harness.dnr.isDynamicRuleClassificationReady(), true);
    assert.strictEqual(harness.dynamicRuleReads, 1);
    assert.deepStrictEqual(harness.storageWrites, [], 'hydration must remain memory-only');
  });

  await t.test('early worker-wake matches wait for hydration and preserve allow classification', async () => {
    let resolveRules;
    const rulesReady = new Promise(resolve => { resolveRules = resolve; });
    const harness = loadHarness({ getDynamicRules: () => rulesReady });

    harness.requestLog.initRequestLogListener();
    harness.emit(matchedInfo(100000, 'https://allowed.example/private-path?token=secret'));
    assert.deepStrictEqual(harness.statsEvents, []);

    resolveRules([{
      id: 100000,
      action: { type: 'allow' },
      condition: { urlFilter: '||allowed.example^' }
    }]);
    await settle();

    const log = await harness.requestLog.getMergedLog();
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].action, 'allow');
    assert.strictEqual(harness.statsEvents.length, 1);
    assert.strictEqual(harness.statsEvents[0].type, 'allow');
    assert.strictEqual(harness.statsEvents[0].ruleSource, 'subscription_dynamic');
  });

  await t.test('a fresh worker rebuilds classification instead of reverting allows to blocks', async () => {
    const installedRules = [{ id: 100123, action: { type: 'allow' }, condition: { urlFilter: '||allow.example^' } }];

    for (let wake = 0; wake < 2; wake++) {
      const harness = loadHarness({ dynamicRules: installedRules });
      harness.requestLog.initRequestLogListener();
      harness.emit(matchedInfo(100123));
      await settle();

      assert.strictEqual(harness.statsEvents[0].type, 'allow', `worker wake ${wake + 1}`);
      assert.strictEqual(harness.dynamicRuleReads, 1, `worker wake ${wake + 1}`);
    }
  });

  await t.test('failed hydration resolves buffered events as neutral matches, never blocks', async () => {
    const harness = loadHarness({ getDynamicRules: async () => { throw new Error('runtime unavailable'); } });

    harness.requestLog.initRequestLogListener();
    harness.emit(matchedInfo(100000));
    await settle();

    const log = await harness.requestLog.getMergedLog();
    assert.strictEqual(log[0].action, 'match');
    assert.strictEqual(harness.statsEvents[0].type, 'match');
  });

  await t.test('the pre-hydration buffer is bounded', async () => {
    let resolveRules;
    const rulesReady = new Promise(resolve => { resolveRules = resolve; });
    const harness = loadHarness({ getDynamicRules: () => rulesReady });

    harness.requestLog.initRequestLogListener();
    for (let index = 0; index < 700; index++) {
      harness.emit(matchedInfo(100000, `https://example.test/${index}`));
    }
    resolveRules([{ id: 100000, action: { type: 'block' }, condition: { urlFilter: '||example.test^' } }]);
    await settle();

    assert.strictEqual(harness.statsEvents.length, 500);
    const log = await harness.requestLog.getMergedLog();
    assert.strictEqual(log.length, 500);
  });

  await t.test('worker wake hydrates even when debug match events are unavailable', async () => {
    const harness = loadHarness({
      withDebugEvent: false,
      dynamicRules: [{ id: 100000, action: { type: 'allow' }, condition: { urlFilter: '||allowed.example^' } }]
    });

    harness.requestLog.initRequestLogListener();
    await settle();

    assert.strictEqual(harness.dynamicRuleReads, 1);
    assert.strictEqual(harness.dnr.classifyDnrMatch(matchedInfo(100000)).type, 'allow');
  });

  await t.test('overlapping request-log flushes preserve both batches', async () => {
    const harness = loadHarness({ dynamicRules: [{ id: 100001, action: { type: 'block' } }] });
    harness.requestLog.initRequestLogListener();
    await settle();

    const originalGet = harness.chrome.storage.local.get;
    let releaseFirstRead;
    let signalFirstRead;
    const firstReadStarted = new Promise(resolve => { signalFirstRead = resolve; });
    const firstReadGate = new Promise(resolve => { releaseFirstRead = resolve; });
    let intercepted = false;
    harness.chrome.storage.local.get = async keys => {
      if (!intercepted && keys === 'requestLog') {
        intercepted = true;
        signalFirstRead();
        await firstReadGate;
      }
      return originalGet(keys);
    };

    harness.emit(matchedInfo(100001, 'https://one.example/ad.js'));
    const firstFlush = harness.requestLog.flushLog();
    await firstReadStarted;
    harness.emit(matchedInfo(100001, 'https://two.example/ad.js'));
    const secondFlush = harness.requestLog.flushLog();
    releaseFirstRead();
    await Promise.all([firstFlush, secondFlush]);

    assert.deepStrictEqual(
      harness.stored.requestLog.map(entry => entry.url),
      ['https://two.example/ad.js', 'https://one.example/ad.js']
    );
  });

  await t.test('request-log reset is ordered after an in-flight flush', async () => {
    const harness = loadHarness({ dynamicRules: [{ id: 100001, action: { type: 'block' } }] });
    harness.requestLog.initRequestLogListener();
    await settle();

    const originalSet = harness.chrome.storage.local.set;
    let releaseFirstWrite;
    let signalFirstWrite;
    const firstWriteStarted = new Promise(resolve => { signalFirstWrite = resolve; });
    const firstWriteGate = new Promise(resolve => { releaseFirstWrite = resolve; });
    let intercepted = false;
    harness.chrome.storage.local.set = async values => {
      if (!intercepted && Array.isArray(values?.requestLog) && values.requestLog.length > 0) {
        intercepted = true;
        signalFirstWrite();
        await firstWriteGate;
      }
      return originalSet(values);
    };

    harness.emit(matchedInfo(100001));
    const flush = harness.requestLog.flushLog();
    await firstWriteStarted;
    const reset = harness.requestLog.resetRequestLog();
    releaseFirstWrite();
    await Promise.all([flush, reset]);

    assert.deepStrictEqual(harness.stored.requestLog, []);
  });

  await t.test('the in-memory request-log batch retains only its newest entries', async () => {
    const harness = loadHarness({ dynamicRules: [{ id: 100001, action: { type: 'block' } }] });
    harness.requestLog.initRequestLogListener();
    await settle();

    for (let index = 0; index < 650; index++) {
      harness.emit(matchedInfo(100001, `https://example.test/${index}.js`));
    }
    await harness.requestLog.flushLog();

    assert.strictEqual(harness.stored.requestLog.length, 500);
    assert.strictEqual(harness.stored.requestLog[0].url, 'https://example.test/150.js');
    assert.strictEqual(harness.stored.requestLog[499].url, 'https://example.test/649.js');
  });
});
