const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const statsCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'stats.js'), 'utf8')
  .replace(/^export\s+/gm, '')
  + `
globalThis.__statsExports = {
  createDefaultStatsV2,
  extractDomainFromUrl,
  sanitizeErrorText,
  recordStatsEvent,
  recordStatsEvents,
  getStatsSnapshot,
  resetStats,
  exportStats,
  flushStatsQueue,
  setStatsSettings
};
`;

function loadStatsSandbox(initialStorage = {}) {
  const storage = { ...initialStorage };
  const writes = [];
  const chrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (typeof keys === 'string') return { [keys]: storage[keys] };
          if (Array.isArray(keys)) {
            const out = {};
            for (const key of keys) out[key] = storage[key];
            return out;
          }
          return { ...storage };
        },
        set: async (value) => {
          Object.assign(storage, value);
          writes.push(value);
        }
      }
    }
  };
  const sandbox = {
    chrome,
    console,
    URL,
    Date,
    Number,
    String,
    Object,
    Array,
    Set,
    Map,
    WeakSet,
    JSON,
    Math,
    Promise,
    setTimeout: () => 1,
    clearTimeout: () => {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(statsCode, sandbox);
  return { storage, writes, ...sandbox.__statsExports };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('statsV2 core aggregation and privacy', async (t) => {
  await t.test('creates default versioned schema', async () => {
    const stats = loadStatsSandbox();

    const snapshot = await stats.getStatsSnapshot();

    assert.strictEqual(snapshot.version, 1);
    assert.strictEqual(snapshot.settings.mode, 'aggregated');
    assert.strictEqual(snapshot.settings.retentionDays, 90);
    assert.strictEqual(snapshot.totals.protectionEvents, 0);
    assert.deepStrictEqual(snapshot.recentEvents, []);
    assert.ok(stats.storage.statsV2, 'default schema should be persisted');
  });

  await t.test('merges batched events into totals, byDay, bySite, byResourceType, and byRule', async () => {
    const stats = loadStatsSandbox();
    const ts = Date.UTC(2026, 4, 7, 12, 0, 0);

    stats.recordStatsEvents([
      {
        layer: 'network',
        type: 'block',
        url: 'https://ads.example.com/banner.js?user=secret',
        resourceType: 'script',
        ruleId: 101,
        rulesetId: 'static_a',
        ruleSource: 'static_ruleset',
        ts
      },
      {
        layer: 'network',
        type: 'allow',
        domain: 'example.com',
        resourceType: 'image',
        ruleId: 9000000,
        ruleSource: 'whitelist',
        ts
      },
      { layer: 'cosmetic', type: 'hide', domain: 'example.com', count: 3, ts },
      { layer: 'warning', type: 'suppression', domain: 'example.com', ts },
      { layer: 'youtube', type: 'payload', domain: 'youtube.com', source: 'fetch', payloadsInspected: 1, payloadsModified: 1, fieldsPruned: 2, adObjectsRemoved: 1, ts },
      { layer: 'scriptlet', type: 'hit', domain: 'example.com', scriptlet: 'set-constant', ruleSource: 'oisd', ts },
      { layer: 'zapper', type: 'hit', domain: 'example.com', ts }
    ]);
    await stats.flushStatsQueue();

    const snapshot = await stats.getStatsSnapshot();

    assert.strictEqual(snapshot.totals.networkBlocks, 1);
    assert.strictEqual(snapshot.totals.networkAllows, 1);
    assert.strictEqual(snapshot.totals.cosmeticHides, 3);
    assert.strictEqual(snapshot.totals.warningSuppressions, 1);
    assert.strictEqual(snapshot.totals.youtubePayloadCleans, 1);
    assert.strictEqual(snapshot.totals.youtubeFieldsPruned, 2);
    assert.strictEqual(snapshot.totals.youtubeAdObjectsRemoved, 1);
    assert.strictEqual(snapshot.totals.scriptletHits, 1);
    assert.strictEqual(snapshot.totals.zapperHits, 1);
    assert.strictEqual(snapshot.totals.protectionEvents, 8);
    assert.strictEqual(snapshot.byDay['2026-05-07'].protectionEvents, 8);
    assert.strictEqual(snapshot.bySite['example.com'].cosmeticHides, 3);
    assert.strictEqual(snapshot.bySite['ads.example.com'].networkBlocks, 1);
    assert.strictEqual(snapshot.byResourceType.script.networkBlocks, 1);
    assert.strictEqual(snapshot.byRule['static_ruleset:static_a:101'].networkBlocks, 1);
    assert.strictEqual(snapshot.byRule['whitelist:dynamic:9000000'].networkAllows, 1);
    assert.strictEqual(snapshot.byRule['scriptlet:oisd:set-constant'].scriptletHits, 1);
    const payloadEvent = snapshot.recentEvents.find(event => event.layer === 'youtube' && event.type === 'payload');
    assert.strictEqual(payloadEvent.source, 'fetch');
    assert.strictEqual(payloadEvent.payloadsModified, 1);
    assert.strictEqual(payloadEvent.fieldsPruned, 2);
    assert.strictEqual(payloadEvent.adObjectsRemoved, 1);
  });

  await t.test('estimates time saved with a tiny sub-second event weight', async () => {
    const stats = loadStatsSandbox();

    stats.recordStatsEvents([
      { layer: 'network', type: 'block', domain: 'ads.youtube.com', resourceType: 'script', count: 20 },
      { layer: 'cosmetic', type: 'hide', domain: 'youtube.com', count: 20 },
      {
        layer: 'youtube',
        type: 'payload',
        domain: 'youtube.com',
        payloadsInspected: 10,
        payloadsModified: 10,
        fieldsPruned: 60,
        adObjectsRemoved: 25
      },
      { layer: 'scriptlet', type: 'hit', domain: 'youtube.com', scriptlet: 'set-constant', count: 10 }
    ]);
    await stats.flushStatsQueue();

    let snapshot = await stats.getStatsSnapshot();
    assert.strictEqual(snapshot.totals.protectionEvents, 60);
    assert.strictEqual(snapshot.timeSavedSeconds, 0);

    stats.recordStatsEvents([
      { layer: 'warning', type: 'suppression', domain: 'example.com', count: 70 },
      { layer: 'zapper', type: 'hit', domain: 'example.com', count: 70 }
    ]);
    await stats.flushStatsQueue();

    snapshot = await stats.getStatsSnapshot();
    assert.strictEqual(snapshot.totals.protectionEvents, 200);
    assert.strictEqual(snapshot.timeSavedSeconds, 1);
  });

  await t.test('does not store raw URLs by default and sanitizes errors', async () => {
    const stats = loadStatsSandbox();

    stats.recordStatsEvent({
      layer: 'network',
      type: 'block',
      url: 'https://tracker.example.com/path?token=secret',
      resourceType: 'xmlhttprequest',
      ruleId: 1,
      ruleSource: 'static_ruleset'
    });
    stats.recordStatsEvent({
      layer: 'scriptlet',
      type: 'error',
      domain: 'example.com',
      scriptlet: 'set-constant',
      error: 'Failed at https://private.example.com/list.txt with user@example.com and detail'.repeat(8)
    });
    await stats.flushStatsQueue();

    const serialized = JSON.stringify(stats.storage.statsV2);

    assert.strictEqual(serialized.includes('token=secret'), false);
    assert.strictEqual(serialized.includes('private.example.com'), false);
    assert.strictEqual(serialized.includes('user@example.com'), false);
    assert.ok(stats.storage.statsV2.recentEvents.some(event => event.error && event.error.length <= 180));
  });

  await t.test('normalizes existing stats storage in place', async () => {
    const stats = loadStatsSandbox({
      statsV2: {
        version: 1,
        settings: { mode: 'aggregated', retentionDays: 90, storeFullUrls: false },
        totals: { networkBlocks: 1 },
        byDay: {},
        bySite: {},
        byResourceType: {},
        byRule: {},
        recentEvents: [{
          layer: 'network',
          type: 'block',
          url: 'https://ads.example.com/path?token=secret',
          count: 1
        }]
      }
    });

    const snapshot = await stats.getStatsSnapshot();
    const serialized = JSON.stringify(stats.storage.statsV2);

    assert.strictEqual(snapshot.totals.networkBlocks, 1);
    assert.strictEqual(serialized.includes('token=secret'), false);
    assert.ok(stats.writes.length > 0, 'normalized stats should be persisted');
  });

  await t.test('debug mode can include sanitized full recent URLs', async () => {
    const stats = loadStatsSandbox();

    await stats.setStatsSettings({ mode: 'debug', storeFullUrls: true });
    stats.recordStatsEvent({
      layer: 'network',
      type: 'block',
      url: 'https://user:pass@ads.example.com/path?debug=true',
      resourceType: 'script'
    });
    await stats.flushStatsQueue();

    const event = stats.storage.statsV2.recentEvents[0];
    assert.strictEqual(event.url, 'https://ads.example.com/path?debug=true');
  });

  await t.test('stats mode changes reduce stored detail safely', async () => {
    const stats = loadStatsSandbox();

    await stats.setStatsSettings({ mode: 'debug', storeFullUrls: true });
    stats.recordStatsEvent({
      layer: 'network',
      type: 'block',
      url: 'https://ads.example.com/path?debug=true',
      resourceType: 'script',
      ruleId: 1,
      ruleSource: 'static_ruleset'
    });
    await stats.flushStatsQueue();

    assert.ok(stats.storage.statsV2.recentEvents[0].url);

    await stats.setStatsSettings({ mode: 'aggregated' });
    assert.strictEqual('url' in stats.storage.statsV2.recentEvents[0], false);
    assert.ok(Object.keys(stats.storage.statsV2.bySite).length > 0);

    await stats.setStatsSettings({ mode: 'basic' });
    const snapshot = await stats.getStatsSnapshot();
    assert.strictEqual(snapshot.totals.networkBlocks, 1);
    assert.deepStrictEqual(plain(snapshot.byDay), {});
    assert.deepStrictEqual(plain(snapshot.bySite), {});
    assert.deepStrictEqual(plain(snapshot.byResourceType), {});
    assert.deepStrictEqual(plain(snapshot.byRule), {});
    assert.deepStrictEqual(plain(snapshot.recentEvents), []);
  });

  await t.test('invalid URLs do not crash and domain extraction is safe', async () => {
    const stats = loadStatsSandbox();

    assert.strictEqual(stats.extractDomainFromUrl('not a url'), null);
    assert.strictEqual(stats.extractDomainFromUrl('https://Sub.Example.com/path'), 'sub.example.com');

    stats.recordStatsEvent({ layer: 'network', type: 'block', url: 'not a url', resourceType: 'script' });
    await stats.flushStatsQueue();

    const snapshot = await stats.getStatsSnapshot();
    assert.strictEqual(snapshot.totals.networkBlocks, 1);
  });

  await t.test('enforces recentEvents, bySite, byRule, byResourceType, and retention caps', async () => {
    const stats = loadStatsSandbox();
    const now = Date.now();
    const events = [];
    for (let i = 0; i < 620; i++) {
      events.push({
        layer: 'network',
        type: 'block',
        domain: `site-${i}.example.com`,
        resourceType: `type_${i}`,
        ruleId: 100000 + i,
        ruleSource: 'subscription_dynamic',
        ts: now - i * 24 * 60 * 60 * 1000
      });
    }

    stats.recordStatsEvents(events);
    await stats.flushStatsQueue();

    const snapshot = await stats.getStatsSnapshot();
    assert.strictEqual(snapshot.recentEvents.length, 500);
    assert.strictEqual(Object.keys(snapshot.bySite).length, 250);
    assert.strictEqual(Object.keys(snapshot.byRule).length, 500);
    assert.strictEqual(Object.keys(snapshot.byResourceType).length, 50);
    const cutoffDay = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    assert.ok(Object.keys(snapshot.byDay).every(day => day >= cutoffDay));
    assert.ok(Object.keys(snapshot.byDay).length <= 90);
  });

  await t.test('reset all stats and reset site stats only are scoped', async () => {
    const stats = loadStatsSandbox();

    stats.recordStatsEvent({ layer: 'network', type: 'block', domain: 'ads.example.com', ruleId: 1, ruleSource: 'static_ruleset' });
    await stats.flushStatsQueue();

    await stats.resetStats('sites');
    let snapshot = await stats.getStatsSnapshot();
    assert.deepStrictEqual(plain(snapshot.bySite), {});
    assert.strictEqual(snapshot.totals.networkBlocks, 1);

    await stats.resetStats('all');
    snapshot = await stats.getStatsSnapshot();
    assert.strictEqual(snapshot.totals.networkBlocks, 0);
    assert.deepStrictEqual(plain(snapshot.byRule), {});
  });

  await t.test('export returns sanitized JSON-safe data', async () => {
    const stats = loadStatsSandbox();

    stats.recordStatsEvent({
      layer: 'network',
      type: 'block',
      url: 'https://ads.example.com/path?token=secret',
      resourceType: 'script'
    });
    await stats.flushStatsQueue();

    const exported = await stats.exportStats();
    const serialized = JSON.stringify(exported);

    assert.ok(exported.exportedAt);
    assert.strictEqual(serialized.includes('token=secret'), false);
    assert.strictEqual(exported.stats.totals.networkBlocks, 1);
  });
});
