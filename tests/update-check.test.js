const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const updateCheckCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'updateCheck.js'), 'utf8')
  .replace(/^export\s+/gm, '')
  + '\nglobalThis.__updateCheckExports = { checkForUpdate, selectReleaseAsset, selectUpdateManifestAsset, normalizeReleaseMetadata };';

function createSandbox({
  manifestVersion = '1.0.1',
  releaseResponse,
  initialStorage = {}
} = {}) {
  const storageState = { ...initialStorage };
  const fetchCalls = [];
  const sandbox = {
    console,
    Date,
    chrome: {
      runtime: {
        getManifest: () => ({ name: 'Chroma Ad-Blocker', version: manifestVersion })
      },
      storage: {
        local: {
          get: async key => ({ [key]: storageState[key] }),
          set: async value => Object.assign(storageState, value)
        }
      }
    },
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return releaseResponse || { ok: false };
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(updateCheckCode, sandbox);
  return {
    sandbox,
    storageState,
    fetchCalls,
    api: sandbox.__updateCheckExports
  };
}

function makeRelease({
  tag = 'v1.0.2',
  assetName = 'chroma-ad-blocker-v1.0.2.zip',
  assetUrl,
  size = 153600,
  includeUpdateManifest = true
} = {}) {
  const assets = [];
  if (assetName) {
    assets.push({
      name: assetName,
      browser_download_url: assetUrl || `https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/${tag}/${assetName}`,
      size,
      content_type: 'application/zip',
      updated_at: '2026-06-20T00:00:00Z'
    });
  }
  if (includeUpdateManifest) {
    assets.push({
      name: 'updates.json',
      browser_download_url: `https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/${tag}/updates.json`,
      size: 160,
      content_type: 'application/json',
      updated_at: '2026-06-20T00:00:00Z'
    });
  }

  return {
    tag_name: tag,
    name: `Chroma ${tag}`,
    html_url: `https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/tag/${tag}`,
    published_at: '2026-06-20T00:00:00Z',
    prerelease: false,
    draft: false,
    assets
  };
}

test('update check release ZIP metadata', async (t) => {
  await t.test('selects only the exact versioned Chroma release ZIP', () => {
    const { api } = createSandbox();
    const release = makeRelease({
      tag: 'v1.0.2',
      assetName: 'chroma-ad-blocker-v1.0.2.zip'
    });

    const asset = api.selectReleaseAsset(release, '1.0.2');
    assert.strictEqual(asset.name, 'chroma-ad-blocker-v1.0.2.zip');
    assert.strictEqual(asset.downloadUrl, 'https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/v1.0.2/chroma-ad-blocker-v1.0.2.zip');
    assert.strictEqual(api.selectUpdateManifestAsset(release).name, 'updates.json');

    assert.strictEqual(api.selectReleaseAsset(makeRelease({ assetName: 'source.zip' }), '1.0.2'), null);
    assert.strictEqual(api.selectReleaseAsset(makeRelease({
      assetUrl: 'https://example.com/chroma-ad-blocker-v1.0.2.zip'
    }), '1.0.2'), null);
    assert.strictEqual(api.selectUpdateManifestAsset(makeRelease({ includeUpdateManifest: false })), null);
  });

  await t.test('returns and caches direct ZIP metadata for available updates', async () => {
    const release = makeRelease();
    const { api, storageState, fetchCalls } = createSandbox({
      releaseResponse: {
        ok: true,
        json: async () => release
      }
    });

    const result = await api.checkForUpdate();
    assert.strictEqual(result.updateAvailable, true);
    assert.strictEqual(result.latestVersion, '1.0.2');
    assert.strictEqual(result.release.version, '1.0.2');
    assert.strictEqual(result.assetStatus, 'found');
    assert.strictEqual(result.asset.name, 'chroma-ad-blocker-v1.0.2.zip');
    assert.strictEqual(result.updateManifestStatus, 'found');
    assert.strictEqual(result.updateManifestAsset.name, 'updates.json');
    assert.strictEqual(fetchCalls.length, 1);

    assert.strictEqual(storageState.updateCheckCache.latestVersion, '1.0.2');
    assert.strictEqual(storageState.updateCheckCache.asset.downloadUrl, result.asset.downloadUrl);
    assert.strictEqual(storageState.updateCheckCache.updateManifestAsset.downloadUrl, result.updateManifestAsset.downloadUrl);

    const cached = await api.checkForUpdate();
    assert.strictEqual(cached.updateAvailable, true);
    assert.strictEqual(cached.asset.name, 'chroma-ad-blocker-v1.0.2.zip');
    assert.strictEqual(cached.updateManifestAsset.name, 'updates.json');
    assert.strictEqual(fetchCalls.length, 1);
  });

  await t.test('reports missing asset without hiding the available update', async () => {
    const { api } = createSandbox({
      releaseResponse: {
        ok: true,
        json: async () => makeRelease({ assetName: null })
      }
    });

    const result = await api.checkForUpdate();
    assert.strictEqual(result.updateAvailable, true);
    assert.strictEqual(result.latestVersion, '1.0.2');
    assert.strictEqual(result.assetStatus, 'missing');
    assert.strictEqual(result.asset, null);
  });
});
