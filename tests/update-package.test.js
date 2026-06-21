const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const updatePackageCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'updatePackage.js'), 'utf8')
  .replace("import { checkForUpdate } from './updateCheck.js';", 'var checkForUpdate = globalThis.checkForUpdate;')
  .replace("import { UPDATE_TRUST } from './updateTrust.js';", 'var UPDATE_TRUST = globalThis.UPDATE_TRUST;')
  .replace(/^export\s+/gm, '')
  + '\nglobalThis.__updatePackageExports = { inspectLatestUpdatePackage, inspectUpdateZip, readZipEntries };';

const TEST_UPDATE_TRUST = (() => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicJwk = publicKey.export({ format: 'jwk' });
  publicJwk.key_ops = ['verify'];
  publicJwk.ext = true;
  const privateJwk = privateKey.export({ format: 'jwk' });
  privateJwk.key_ops = ['sign'];
  privateJwk.ext = true;
  return {
    schema: 'chroma-update-manifest-v1',
    signatureAlgorithm: 'ECDSA_P256_SHA256',
    keyId: 'test-update-signing-key',
    publicKeyJwk: publicJwk,
    privateJwk
  };
})();

const CRC_TABLE = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0 ^ -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function exactArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content || '');
    const method = entry.method ?? 8;
    const compressed = method === 0 ? data : zlib.deflateRawSync(data);
    const entryCrc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(entryCrc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);

    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(entryCrc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function makeManifest(version = '1.0.2') {
  return {
    manifest_version: 3,
    name: 'Chroma Ad-Blocker',
    version,
    background: { service_worker: 'background/background.js' },
    action: {
      default_popup: 'ui/popup.html',
      default_icon: { 16: 'icons/icon16.png' }
    },
    options_ui: { page: 'ui/settings.html' },
    icons: { 16: 'icons/icon16.png' },
    content_scripts: [{ js: ['content/content.js'], css: ['content/content.css'] }],
    declarative_net_request: {
      rule_resources: [{ id: 'custom_static_rules', path: 'rules/rules_custom.json' }]
    }
  };
}

function makePackageZip({ manifest = makeManifest(), omit = [], extraEntries = [] } = {}) {
  const omitted = new Set(omit);
  const entries = [
    { name: 'manifest.json', content: JSON.stringify(manifest) },
    { name: 'background/background.js', content: "'use strict';" },
    { name: 'ui/popup.html', content: '<!doctype html>' },
    { name: 'ui/settings.html', content: '<!doctype html>' },
    { name: 'icons/icon16.png', content: 'png' },
    { name: 'content/content.js', content: "'use strict';" },
    { name: 'content/content.css', content: 'body{}' },
    { name: 'rules/rules_custom.json', content: '[]' },
    ...extraEntries
  ].filter(entry => !omitted.has(entry.name));
  return makeZip(entries);
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function canonicalizeUpdateManifest(manifest) {
  return stableStringify({
    schema: manifest.schema,
    version: manifest.version,
    package: {
      name: manifest.package.name,
      bytes: manifest.package.bytes,
      sha256: String(manifest.package.sha256).toLowerCase()
    }
  });
}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function signUpdateManifest(manifest, {
  privateJwk = TEST_UPDATE_TRUST.privateJwk,
  keyId = TEST_UPDATE_TRUST.keyId,
  algorithm = TEST_UPDATE_TRUST.signatureAlgorithm
} = {}) {
  const key = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
  const signature = crypto.sign('sha256', Buffer.from(canonicalizeUpdateManifest(manifest), 'utf8'), {
    key,
    dsaEncoding: 'ieee-p1363'
  });
  return {
    ...manifest,
    signature: {
      algorithm,
      keyId,
      value: base64UrlEncode(signature)
    }
  };
}

function makeUpdateManifestBuffer(zip, {
  version = '1.0.2',
  name = 'chroma-ad-blocker-v1.0.2.zip',
  bytes = zip.byteLength,
  sha256 = sha256Hex(zip),
  signed = true,
  signatureOverrides = {}
} = {}) {
  const manifest = {
    schema: 'chroma-update-manifest-v1',
    version,
    package: { name, bytes, sha256 }
  };
  let updateManifest = signed ? signUpdateManifest(manifest) : manifest;
  if (updateManifest.signature && Object.keys(signatureOverrides).length > 0) {
    updateManifest = {
      ...updateManifest,
      signature: {
        ...updateManifest.signature,
        ...signatureOverrides
      }
    };
  }
  return Buffer.from(JSON.stringify(updateManifest));
}

function makeUpdateManifestAsset(buffer, tag = 'v1.0.2') {
  return {
    name: 'updates.json',
    downloadUrl: `https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/${tag}/updates.json`,
    size: buffer.byteLength
  };
}

function loadUpdatePackage({ checkForUpdate, fetch, manifestVersion = '1.0.1' } = {}) {
  const sandbox = {
    console,
    Blob,
    Response,
    DecompressionStream,
    TextDecoder,
    TextEncoder,
    DataView,
    Uint8Array,
    ArrayBuffer,
    URL,
    atob: globalThis.atob,
    crypto: globalThis.crypto,
    UPDATE_TRUST: {
      schema: TEST_UPDATE_TRUST.schema,
      signatureAlgorithm: TEST_UPDATE_TRUST.signatureAlgorithm,
      keyId: TEST_UPDATE_TRUST.keyId,
      publicKeyJwk: TEST_UPDATE_TRUST.publicKeyJwk
    },
    checkForUpdate: checkForUpdate || (async () => ({ updateAvailable: false })),
    fetch: fetch || (async () => ({ ok: false })),
    chrome: {
      runtime: {
        getManifest: () => ({ name: 'Chroma Ad-Blocker', version: manifestVersion })
      }
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(updatePackageCode, sandbox);
  return sandbox.__updatePackageExports;
}

test('update package ZIP inspection', async (t) => {
  await t.test('inspects a valid release package ZIP without writing files', async () => {
    const api = loadUpdatePackage();
    const zip = makePackageZip();

    const result = await api.inspectUpdateZip(exactArrayBuffer(zip), {
      expectedVersion: '1.0.2',
      currentManifest: { version: '1.0.1' }
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.package.version, '1.0.2');
    assert.strictEqual(result.package.manifest.name, 'Chroma Ad-Blocker');
    assert.ok(result.package.entryCount >= result.package.requiredEntryCount);
    assert.ok(result.package.files.some(file => file.path === 'manifest.json' && file.size > 0));
    assert.ok(result.package.files.every(file => typeof file.path === 'string' && Number.isFinite(file.size)));
  });

  await t.test('rejects packages missing manifest-referenced files', async () => {
    const api = loadUpdatePackage();
    const zip = makePackageZip({ omit: ['background/background.js'] });

    const result = await api.inspectUpdateZip(exactArrayBuffer(zip), {
      expectedVersion: '1.0.2',
      currentManifest: { version: '1.0.1' }
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'missing_manifest_files');
    assert.match(result.reason, /background\/background\.js/);
  });

  await t.test('rejects unsafe paths before package installation exists', async () => {
    const api = loadUpdatePackage();
    const zip = makePackageZip({ extraEntries: [{ name: '../evil.js', content: 'bad' }] });

    const result = await api.inspectUpdateZip(exactArrayBuffer(zip), {
      expectedVersion: '1.0.2',
      currentManifest: { version: '1.0.1' }
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'unsafe_zip_path');
  });

  await t.test('downloads the exact release asset and inspects its package shape', async () => {
    const zip = makePackageZip();
    const updateManifestBytes = makeUpdateManifestBuffer(zip);
    const asset = {
      name: 'chroma-ad-blocker-v1.0.2.zip',
      downloadUrl: 'https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/v1.0.2/chroma-ad-blocker-v1.0.2.zip',
      size: zip.byteLength
    };
    const updateManifestAsset = makeUpdateManifestAsset(updateManifestBytes);
    const calls = [];
    const api = loadUpdatePackage({
      checkForUpdate: async options => {
        calls.push({ type: 'check', options });
        return {
          updateAvailable: true,
          latestVersion: '1.0.2',
          release: { version: '1.0.2', tagName: 'v1.0.2' },
          asset,
          assetStatus: 'found',
          updateManifestAsset,
          updateManifestStatus: 'found'
        };
      },
      fetch: async (url, options) => {
        calls.push({ type: 'fetch', url, options });
        if (url === updateManifestAsset.downloadUrl) {
          return {
            ok: true,
            headers: { get: name => name.toLowerCase() === 'content-length' ? String(updateManifestBytes.byteLength) : 'application/json' },
            arrayBuffer: async () => exactArrayBuffer(updateManifestBytes)
          };
        }
        return {
          ok: true,
          headers: { get: name => name.toLowerCase() === 'content-length' ? String(zip.byteLength) : 'application/zip' },
          arrayBuffer: async () => exactArrayBuffer(zip)
        };
      }
    });

    const result = await api.inspectLatestUpdatePackage({ force: true });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.updateAvailable, true);
    assert.strictEqual(result.package.version, '1.0.2');
    assert.strictEqual(result.package.downloadBytes, zip.byteLength);
    assert.strictEqual(result.package.sha256, sha256Hex(zip));
    assert.strictEqual(result.package.verifiedBy, 'signed-updates.json');
    assert.strictEqual(result.package.signatureKeyId, TEST_UPDATE_TRUST.keyId);
    assert.strictEqual(result.updateManifest.package.sha256, sha256Hex(zip));
    assert.strictEqual(result.updateManifest.signature.keyId, TEST_UPDATE_TRUST.keyId);
    assert.ok(result.package.files.some(file => file.path === 'background/background.js'));
    assert.strictEqual(calls[0].type, 'check');
    assert.strictEqual(calls[0].options.force, true);
    assert.strictEqual(calls[1].type, 'fetch');
    assert.strictEqual(calls[1].url, updateManifestAsset.downloadUrl);
    assert.strictEqual(calls[2].type, 'fetch');
    assert.strictEqual(calls[2].url, asset.downloadUrl);
  });

  await t.test('rejects downloads that do not match GitHub release metadata size', async () => {
    const zip = makePackageZip();
    const updateManifestBytes = makeUpdateManifestBuffer(zip, { bytes: zip.byteLength + 1 });
    const updateManifestAsset = makeUpdateManifestAsset(updateManifestBytes);
    const api = loadUpdatePackage({
      checkForUpdate: async () => ({
        updateAvailable: true,
        latestVersion: '1.0.2',
        asset: {
          name: 'chroma-ad-blocker-v1.0.2.zip',
          downloadUrl: 'https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/v1.0.2/chroma-ad-blocker-v1.0.2.zip',
          size: zip.byteLength + 1
        },
        assetStatus: 'found',
        updateManifestAsset,
        updateManifestStatus: 'found'
      }),
      fetch: async url => {
        if (url === updateManifestAsset.downloadUrl) {
          return {
            ok: true,
            headers: { get: () => String(updateManifestBytes.byteLength) },
            arrayBuffer: async () => exactArrayBuffer(updateManifestBytes)
          };
        }
        return {
          ok: true,
          headers: { get: () => String(zip.byteLength) },
          arrayBuffer: async () => exactArrayBuffer(zip)
        };
      }
    });

    const result = await api.inspectLatestUpdatePackage({ force: true });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'download_size_mismatch');
  });

  await t.test('requires updates.json before guided package inspection', async () => {
    const zip = makePackageZip();
    const api = loadUpdatePackage({
      checkForUpdate: async () => ({
        updateAvailable: true,
        latestVersion: '1.0.2',
        asset: {
          name: 'chroma-ad-blocker-v1.0.2.zip',
          downloadUrl: 'https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/v1.0.2/chroma-ad-blocker-v1.0.2.zip',
          size: zip.byteLength
        },
        assetStatus: 'found',
        updateManifestAsset: null,
        updateManifestStatus: 'missing'
      }),
      fetch: async () => {
        throw new Error('ZIP should not be fetched without updates.json');
      }
    });

    const result = await api.inspectLatestUpdatePackage({ force: true });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'missing_update_manifest');
    assert.match(result.reason, /updates\.json/);
  });

  await t.test('rejects unsigned updates.json before downloading the ZIP', async () => {
    const zip = makePackageZip();
    const updateManifestBytes = makeUpdateManifestBuffer(zip, { signed: false });
    const updateManifestAsset = makeUpdateManifestAsset(updateManifestBytes);
    const api = loadUpdatePackage({
      checkForUpdate: async () => ({
        updateAvailable: true,
        latestVersion: '1.0.2',
        asset: {
          name: 'chroma-ad-blocker-v1.0.2.zip',
          downloadUrl: 'https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/v1.0.2/chroma-ad-blocker-v1.0.2.zip',
          size: zip.byteLength
        },
        assetStatus: 'found',
        updateManifestAsset,
        updateManifestStatus: 'found'
      }),
      fetch: async url => {
        if (url !== updateManifestAsset.downloadUrl) {
          throw new Error('ZIP should not be fetched without a signed updates.json');
        }
        return {
          ok: true,
          headers: { get: () => String(updateManifestBytes.byteLength) },
          arrayBuffer: async () => exactArrayBuffer(updateManifestBytes)
        };
      }
    });

    const result = await api.inspectLatestUpdatePackage({ force: true });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'missing_update_signature');
    assert.match(result.reason, /not signed/i);
  });

  await t.test('rejects updates.json with an invalid signature before downloading the ZIP', async () => {
    const zip = makePackageZip();
    const updateManifestBytes = makeUpdateManifestBuffer(zip, {
      signatureOverrides: { value: base64UrlEncode(Buffer.alloc(64)) }
    });
    const updateManifestAsset = makeUpdateManifestAsset(updateManifestBytes);
    const api = loadUpdatePackage({
      checkForUpdate: async () => ({
        updateAvailable: true,
        latestVersion: '1.0.2',
        asset: {
          name: 'chroma-ad-blocker-v1.0.2.zip',
          downloadUrl: 'https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/v1.0.2/chroma-ad-blocker-v1.0.2.zip',
          size: zip.byteLength
        },
        assetStatus: 'found',
        updateManifestAsset,
        updateManifestStatus: 'found'
      }),
      fetch: async url => {
        if (url !== updateManifestAsset.downloadUrl) {
          throw new Error('ZIP should not be fetched when updates.json signature fails');
        }
        return {
          ok: true,
          headers: { get: () => String(updateManifestBytes.byteLength) },
          arrayBuffer: async () => exactArrayBuffer(updateManifestBytes)
        };
      }
    });

    const result = await api.inspectLatestUpdatePackage({ force: true });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'invalid_update_signature');
    assert.match(result.reason, /signature/i);
  });

  await t.test('rejects downloads whose SHA-256 does not match updates.json', async () => {
    const zip = makePackageZip();
    const updateManifestBytes = makeUpdateManifestBuffer(zip, { sha256: '0'.repeat(64) });
    const updateManifestAsset = makeUpdateManifestAsset(updateManifestBytes);
    const api = loadUpdatePackage({
      checkForUpdate: async () => ({
        updateAvailable: true,
        latestVersion: '1.0.2',
        asset: {
          name: 'chroma-ad-blocker-v1.0.2.zip',
          downloadUrl: 'https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/v1.0.2/chroma-ad-blocker-v1.0.2.zip',
          size: zip.byteLength
        },
        assetStatus: 'found',
        updateManifestAsset,
        updateManifestStatus: 'found'
      }),
      fetch: async url => {
        if (url === updateManifestAsset.downloadUrl) {
          return {
            ok: true,
            headers: { get: () => String(updateManifestBytes.byteLength) },
            arrayBuffer: async () => exactArrayBuffer(updateManifestBytes)
          };
        }
        return {
          ok: true,
          headers: { get: () => String(zip.byteLength) },
          arrayBuffer: async () => exactArrayBuffer(zip)
        };
      }
    });

    const result = await api.inspectLatestUpdatePackage({ force: true });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'download_hash_mismatch');
  });

  await t.test('reports unavailable release metadata as an inspection failure', async () => {
    const api = loadUpdatePackage({
      checkForUpdate: async () => ({
        updateAvailable: false,
        latestVersion: null,
        assetStatus: 'unavailable'
      })
    });

    const result = await api.inspectLatestUpdatePackage({ force: true });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.updateAvailable, false);
    assert.strictEqual(result.code, 'release_unavailable');
    assert.match(result.reason, /metadata could not be reached/i);
  });
});
