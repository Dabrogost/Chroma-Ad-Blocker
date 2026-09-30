const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const context = vm.createContext({});
vm.runInContext(read('extension/background/spotifyRules.js').replace('export function', 'function'), context);
const rules = (config, whitelist) => JSON.parse(JSON.stringify(context.getSpotifyRules(config, whitelist)));
const active = { enabled: true, spotifyAdBlocking: true };

test('Spotify rules fail closed and respect independent toggle and parent-domain whitelist', () => {
  for (const config of [undefined, {}, { enabled: true }, { ...active, enabled: false },
    { ...active, spotifyAdBlocking: false }, { ...active, spotifyAdBlocking: 'true' }]) assert.deepEqual(rules(config), []);
  for (const domain of ['open.spotify.com', 'spotify.com']) assert.deepEqual(rules(active, [domain]), []);
  assert.equal(rules({ ...active, networkBlocking: false, stripping: false }, ['example.com']).length, 14);
});

test('Spotify redirects only upstream ad-media patterns and preserves podcast exceptions', () => {
  const result = rules(active);
  assert.equal(new Set(result.map(r => r.id)).size, result.length);
  for (const rule of result) {
    assert.deepEqual(rule.condition.initiatorDomains, ['open.spotify.com']);
    assert.deepEqual(rule.condition.resourceTypes, ['media']);
    assert.ok(rule.condition.urlFilter || rule.condition.regexFilter);
  }
  assert.deepEqual(result.slice(0, 10).map(r => r.condition.urlFilter), [
    '||akamaized.net/audio/', '||scdn.co/audio/', '||scdn.co/mp3-ad/', '||scdn.co/mp3/',
    '||spotifycdn.com/audio/', '||amillionads.com^', '||2mdn.net^', '||adxcel.com^',
    '||adstudio-assets.scdn.co^', '||spotify.com/ad-logic/'
  ]);
  for (const rule of result.slice(0, 10)) assert.deepEqual(rule.action,
    { type: 'redirect', redirect: { extensionPath: '/media/noop-1s.mp4' } });
  assert.ok(result.slice(10, 13).every(r => r.action.type === 'allow' && r.priority > result[0].priority));
  assert.deepEqual(result.at(-1).condition.excludedRequestDomains, ['traffic.megaphone.fm']);
});

test('Spotify removes the MAIN handler and packages valid one-second audio/video', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  assert.ok(!fs.existsSync(path.join(__dirname, '../extension/content/spotify_handler.js')));
  assert.ok(!manifest.content_scripts.some(e => e.matches.includes('https://open.spotify.com/*')));
  assert.deepEqual(manifest.web_accessible_resources, [{ resources: ['media/noop-1s.mp4'], matches: ['https://open.spotify.com/*'] }]);
  const bytes = fs.readFileSync(path.join(__dirname, '../extension/media/noop-1s.mp4'));
  assert.ok(bytes.length < 5000);
  assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
  const mvhd = bytes.indexOf('mvhd');
  const duration = bytes.readUInt32BE(mvhd + 20) / bytes.readUInt32BE(mvhd + 16);
  assert.ok(duration >= 1 && duration < 1.2);
  for (const atom of ['mdat', 'moov', 'avc1', 'mp4a']) assert.ok(bytes.includes(Buffer.from(atom)));
});

test('Spotify reconciliation honors controls, deduplicates and survives worker restart', async () => {
  let config = { ...active, networkBlocking: false }, whitelist = [], installed = [];
  const chrome = {
    runtime: { getManifest: () => ({ declarative_net_request: { rule_resources: [] } }) },
    storage: { local: { get: async () => ({ config, whitelist }), set: async () => {} } },
    declarativeNetRequest: {
      getEnabledRulesets: async () => [], getDynamicRules: async () => installed,
      updateEnabledRulesets: async () => {},
      updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
        installed = installed.filter(r => !removeRuleIds.includes(r.id)).concat(addRules);
      }
    }
  };
  const code = read('extension/background/dnrState.js')
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*[^;]+;/g, '').replace(/^export /gm, '');
  const boot = () => {
    const c = vm.createContext({ chrome, getSpotifyRules: context.getSpotifyRules,
      getDefaultDynamicRules: () => [], clearHealthDiagnostic: async () => {}, recordHealthDiagnostic: async () => {},
      buildSubscriptionRuleApplication: async () => ({ networkRules: [] }), prepareSubscriptionRules: r => r });
    vm.runInContext(code, c);
    return () => c.reconcileNetworkDnr('test');
  };
  let reconcile = boot();
  await reconcile();
  assert.equal(installed.length, 14);
  await reconcile();
  assert.equal(installed.length, 14);
  reconcile = boot();
  await reconcile();
  assert.equal(installed.length, 14);
  whitelist = ['spotify.com'];
  await reconcile();
  assert.equal(installed.length, 0);
  whitelist = [];
  config.spotifyAdBlocking = false;
  await reconcile();
  assert.equal(installed.length, 0);
  config.spotifyAdBlocking = true;
  config.networkBlocking = true;
  config.acceleration = false;
  await reconcile();
  assert.equal(installed.filter(r => r.action.type === 'allow').length, 3);
  config.enabled = false;
  await reconcile();
  assert.equal(installed.length, 0);
});
