const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const updaterUiCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'updater-ui.js'), 'utf8');

function loadUpdaterUi() {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(updaterUiCode, sandbox);
  return sandbox.ChromaUpdaterUI._test;
}

function makeChromaManifest(overrides = {}) {
  return {
    manifest_version: 3,
    name: 'Chroma Ad-Blocker',
    version: '1.5.4',
    ...overrides
  };
}

function paths(files) {
  return Array.from(files, file => file.path);
}

test('updater UI install safety helpers', async (t) => {
  const api = loadUpdaterUi();

  await t.test('validates the selected folder manifest before install planning', () => {
    const ok = api.validateInstallManifest(makeChromaManifest(), { version: '1.5.4' });
    assert.strictEqual(ok.ok, true);
    assert.match(ok.reason, /Chroma v1\.5\.4 install folder verified/);

    const cases = [
      [null, /readable manifest/],
      [makeChromaManifest({ manifest_version: 2 }), /Manifest V3/],
      [makeChromaManifest({ name: 'Other Extension' }), /not Chroma Ad-Blocker/],
      [makeChromaManifest({ version: '1.5.5' }), /running copy is v1\.5\.4/]
    ];

    for (const [manifest, reasonPattern] of cases) {
      const result = api.validateInstallManifest(manifest, { version: '1.5.4' });
      assert.strictEqual(result.ok, false);
      assert.match(result.reason, reasonPattern);
    }
  });

  await t.test('normalizes candidate file paths into safe relative form', () => {
    assert.strictEqual(api.normalizeRelativePath('  \\ui\\popup.html  '), 'ui/popup.html');
    assert.strictEqual(api.normalizeRelativePath('/rules/rules_custom.json'), 'rules/rules_custom.json');
    assert.strictEqual(api.normalizeRelativePath('manifest.json'), 'manifest.json');

    const rejected = [
      '',
      'ui/',
      'icons//icon16.png',
      'icons/./icon16.png',
      '../manifest.json',
      'ui/../manifest.json',
      'C:\\Users\\example\\manifest.json',
      null
    ];

    for (const input of rejected) {
      assert.strictEqual(api.normalizeRelativePath(input), null, String(input));
    }
  });

  await t.test('recognizes updater-owned and platform-generated files to leave alone', () => {
    const ignored = [
      '.chroma-write-probe',
      '.DS_Store',
      'ui/.DS_Store',
      'Thumbs.db',
      'icons/thumbs.db',
      '_metadata',
      '_metadata/generated_indexed_rulesets/main',
      '.chroma-update-backup-20260621/manifest.json'
    ];

    for (const input of ignored) {
      assert.strictEqual(api.shouldIgnoreInstallPath(input), true, input);
    }

    const kept = [
      'manifest.json',
      'ui/popup.html',
      '_metadata.json',
      'metadata/generated.json',
      '.chroma-update-backup'
    ];

    for (const input of kept) {
      assert.strictEqual(api.shouldIgnoreInstallPath(input), false, input);
    }
  });

  await t.test('builds a dry-run plan without removing ignored local files', () => {
    const result = api.buildInstallPlan([
      { path: 'ui\\popup.html', size: '20' },
      { path: 'manifest.json', size: 100 },
      { name: 'rules/rules_custom.json', size: 7 },
      { path: '../evil.js', size: 999 },
      { path: 'manifest.json', size: 101 }
    ], [
      { path: 'manifest.json', size: 90 },
      { path: 'background/old.js', size: 3 },
      { path: '.chroma-write-probe', size: 0 },
      { path: '_metadata/generated.json', size: 1 },
      { path: '.chroma-update-backup-20260621/manifest.json', size: 2 },
      { name: 'Thumbs.db', size: 3 }
    ]);

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(paths(result.add), ['rules/rules_custom.json', 'ui/popup.html']);
    assert.deepStrictEqual(paths(result.overwrite), ['manifest.json']);
    assert.strictEqual(result.overwrite[0].size, 101);
    assert.deepStrictEqual(paths(result.remove), ['background/old.js']);
    assert.deepStrictEqual(paths(result.ignored), [
      '.chroma-write-probe',
      '_metadata/generated.json',
      '.chroma-update-backup-20260621/manifest.json',
      'Thumbs.db'
    ]);
    assert.strictEqual(result.totalPackageFiles, 3);
    assert.strictEqual(result.totalInstallFiles, 2);
    assert.match(result.reason, /2 add, 1 overwrite, 1 remove/);
  });

  await t.test('fails closed when package or install paths cannot be safely planned', () => {
    const emptyPackage = api.buildInstallPlan([{ path: '../evil.js', size: 1 }], []);
    assert.strictEqual(emptyPackage.ok, false);
    assert.match(emptyPackage.reason, /any installable files/);

    const unsafeInstallPath = api.buildInstallPlan(
      [{ path: 'manifest.json', size: 1 }],
      [{ path: '../outside.js', size: 1 }]
    );
    assert.strictEqual(unsafeInstallPath.ok, false);
    assert.match(unsafeInstallPath.reason, /cannot safely plan/);
  });
});
