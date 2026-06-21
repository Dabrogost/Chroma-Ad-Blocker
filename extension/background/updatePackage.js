/**
 * Release package download and ZIP inspection for guided unpacked updates.
 * This module never writes files; it only validates package bytes in memory.
 */

'use strict';

import { checkForUpdate } from './updateCheck.js';
import { UPDATE_TRUST } from './updateTrust.js';

const EXPECTED_EXTENSION_NAME = 'Chroma Ad-Blocker';
const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/';
const UPDATE_MANIFEST_ASSET_NAME = 'updates.json';
const UPDATE_MANIFEST_SCHEMA = UPDATE_TRUST.schema;
const UPDATE_MANIFEST_VERIFICATION = 'signed-updates.json';
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const MAX_UPDATE_MANIFEST_BYTES = 64 * 1024;
const MAX_ENTRY_COUNT = 30000;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 350 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP64_SIZE_SENTINEL = 0xffffffff;

const FORBIDDEN_PACKAGE_PATH_PATTERNS = [
  { label: 'tests/', regex: /^tests\// },
  { label: 'node_modules/', regex: /^node_modules\// },
  { label: '.git/', regex: /^\.git\// },
  { label: '.github/', regex: /^\.github\// },
  { label: 'logs/', regex: /(^|\/)logs\// },
  { label: 'temporary files', regex: /(^|\/)(tmp|temp|Thumbs\.db|\.DS_Store|.*\.(log|tmp|temp|swp))$/i }
];

const CRC_TABLE = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

class PackageInspectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PackageInspectionError';
    this.code = code;
  }
}

function fail(code, message) {
  return { ok: false, code, reason: message };
}

function normalizeVersion(version) {
  return String(version || '').trim().replace(/^v/i, '');
}

function isNewerVersion(local, remote) {
  const parse = value => normalizeVersion(value).split('.').map(Number);
  const [lMaj, lMin, lPat] = parse(local);
  const [rMaj, rMin, rPat] = parse(remote);
  if (rMaj !== lMaj) return rMaj > lMaj;
  if (rMin !== lMin) return rMin > lMin;
  return rPat > lPat;
}

function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function crc32(bytes) {
  let crc = 0 ^ -1;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function toUint8Array(input) {
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (Object.prototype.toString.call(input) === '[object ArrayBuffer]') return new Uint8Array(input);
  throw new PackageInspectionError('invalid_zip', 'Package data is not a byte buffer.');
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function canonicalizeUpdateManifest(updateManifest) {
  return stableStringify({
    schema: updateManifest.schema,
    version: updateManifest.version,
    package: {
      name: updateManifest.package.name,
      bytes: updateManifest.package.bytes,
      sha256: String(updateManifest.package.sha256).toLowerCase()
    }
  });
}

function base64UrlToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new PackageInspectionError('invalid_update_signature', 'Release updates.json has an invalid signature encoding.');
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isSafeZipPath(name) {
  if (typeof name !== 'string' || !name) return false;
  if (name.includes('\\') || name.startsWith('/') || /^[a-z]:/i.test(name)) return false;
  if (name.endsWith('/')) return false;
  return name.split('/').every(part => part && part !== '.' && part !== '..');
}

function assertSafeZipPath(name) {
  if (!isSafeZipPath(name)) {
    throw new PackageInspectionError('unsafe_zip_path', `Release ZIP contains unsafe path: ${name || '(empty)'}.`);
  }
  for (const pattern of FORBIDDEN_PACKAGE_PATH_PATTERNS) {
    if (pattern.regex.test(name)) {
      throw new PackageInspectionError('forbidden_zip_path', `Release ZIP contains forbidden ${pattern.label} entry: ${name}.`);
    }
  }
}

function findEndOfCentralDirectory(view) {
  const minOffset = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= minOffset; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  throw new PackageInspectionError('invalid_zip', 'Release package is not a valid ZIP archive.');
}

export function readZipEntries(input) {
  const zipBytes = toUint8Array(input);
  if (zipBytes.byteLength < 22) {
    throw new PackageInspectionError('invalid_zip', 'Release package is too small to be a ZIP archive.');
  }

  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  let offset = view.getUint32(eocdOffset + 16, true);

  if (entryCount < 1 || entryCount > MAX_ENTRY_COUNT) {
    throw new PackageInspectionError('invalid_zip', 'Release ZIP has an unexpected number of entries.');
  }
  if (offset + centralDirectorySize > zipBytes.byteLength) {
    throw new PackageInspectionError('invalid_zip', 'Release ZIP central directory is out of bounds.');
  }

  const entries = [];
  const seen = new Set();
  let totalUncompressedBytes = 0;

  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > zipBytes.byteLength || view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new PackageInspectionError('invalid_zip', `Release ZIP central directory entry ${index} is malformed.`);
    }

    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const entryCrc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;

    if (nameEnd + extraLength + commentLength > zipBytes.byteLength) {
      throw new PackageInspectionError('invalid_zip', 'Release ZIP entry name is out of bounds.');
    }
    if (compressedSize === ZIP64_SIZE_SENTINEL || uncompressedSize === ZIP64_SIZE_SENTINEL) {
      throw new PackageInspectionError('unsupported_zip', 'Release ZIP uses ZIP64 entries, which are not supported by this updater.');
    }
    if ((flags & 0x1) !== 0) {
      throw new PackageInspectionError('unsupported_zip', 'Release ZIP contains encrypted entries.');
    }
    if (method !== 0 && method !== 8) {
      throw new PackageInspectionError('unsupported_zip', `Release ZIP uses unsupported compression method ${method}.`);
    }

    const name = decodeUtf8(zipBytes.subarray(nameStart, nameEnd));
    assertSafeZipPath(name);
    if (seen.has(name)) {
      throw new PackageInspectionError('duplicate_zip_entry', `Release ZIP contains duplicate entry: ${name}.`);
    }
    seen.add(name);

    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new PackageInspectionError('zip_too_large', 'Release ZIP expands beyond the updater safety limit.');
    }

    entries.push({
      name,
      flags,
      method,
      crc32: entryCrc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset
    });

    offset = nameEnd + extraLength + commentLength;
  }

  return { entries, totalUncompressedBytes };
}

function readCompressedEntryBytes(zipBytes, entry) {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const offset = entry.localHeaderOffset;
  if (offset + 30 > zipBytes.byteLength || view.getUint32(offset, true) !== LOCAL_FILE_SIGNATURE) {
    throw new PackageInspectionError('invalid_zip', `Release ZIP local header is malformed for ${entry.name}.`);
  }
  const fileNameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + fileNameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > zipBytes.byteLength) {
    throw new PackageInspectionError('invalid_zip', `Release ZIP data is out of bounds for ${entry.name}.`);
  }
  return zipBytes.subarray(dataStart, dataEnd);
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new PackageInspectionError('unsupported_zip', 'This browser cannot inspect compressed ZIP entries.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readEntryBytes(zipBytes, entry) {
  const compressed = readCompressedEntryBytes(zipBytes, entry);
  const bytes = entry.method === 0 ? compressed : await inflateRaw(compressed);
  if (bytes.byteLength !== entry.uncompressedSize) {
    throw new PackageInspectionError('invalid_zip', `Release ZIP entry has an invalid size: ${entry.name}.`);
  }
  if (crc32(bytes) !== entry.crc32) {
    throw new PackageInspectionError('invalid_zip', `Release ZIP entry failed checksum validation: ${entry.name}.`);
  }
  return bytes;
}

function normalizeManifestPath(path) {
  if (typeof path !== 'string' || path.includes('*')) return null;
  const normalized = path.trim().replace(/^\/+/, '').replace(/\\/g, '/');
  return isSafeZipPath(normalized) ? normalized : null;
}

function collectManifestReferencedPaths(manifest) {
  const paths = new Set(['manifest.json']);
  const add = value => {
    const normalized = normalizeManifestPath(value);
    if (normalized) paths.add(normalized);
  };
  const addIconMap = icons => {
    if (!icons || typeof icons !== 'object') return;
    Object.values(icons).forEach(add);
  };

  add(manifest?.background?.service_worker);
  add(manifest?.action?.default_popup);
  addIconMap(manifest?.action?.default_icon);
  addIconMap(manifest?.icons);
  add(manifest?.options_ui?.page);

  for (const script of manifest?.content_scripts || []) {
    for (const file of script.js || []) add(file);
    for (const file of script.css || []) add(file);
  }
  for (const resource of manifest?.declarative_net_request?.rule_resources || []) {
    add(resource.path);
  }
  for (const group of manifest?.web_accessible_resources || []) {
    for (const resource of group.resources || []) add(resource);
  }

  return [...paths].sort();
}

function buildPackageFileList(entries) {
  return entries
    .map(entry => ({
      path: entry.name,
      size: entry.uncompressedSize
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function validateManifest(manifest, expectedVersion, currentManifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new PackageInspectionError('invalid_manifest', 'Release ZIP manifest.json is not a JSON object.');
  }
  if (manifest.manifest_version !== 3) {
    throw new PackageInspectionError('invalid_manifest', 'Release ZIP is not a Manifest V3 extension.');
  }
  if (manifest.name !== EXPECTED_EXTENSION_NAME) {
    throw new PackageInspectionError('invalid_manifest', 'Release ZIP is not Chroma Ad-Blocker.');
  }

  const manifestVersion = normalizeVersion(manifest.version);
  const targetVersion = normalizeVersion(expectedVersion);
  if (!manifestVersion || manifestVersion !== targetVersion) {
    throw new PackageInspectionError('version_mismatch', `Release ZIP manifest is v${manifestVersion || 'unknown'}, expected v${targetVersion || 'unknown'}.`);
  }
  if (currentManifest?.version && !isNewerVersion(currentManifest.version, manifestVersion)) {
    throw new PackageInspectionError('version_not_newer', `Release ZIP v${manifestVersion} is not newer than the installed v${currentManifest.version}.`);
  }

  return manifestVersion;
}

async function sha256Hex(arrayBuffer) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function requiredSha256Hex(arrayBuffer) {
  const hash = await sha256Hex(arrayBuffer);
  if (!hash) {
    throw new PackageInspectionError('sha256_unavailable', 'This browser cannot verify the release ZIP SHA-256.');
  }
  return hash;
}

function validateGitHubReleaseAssetUrl(asset, expectedName) {
  if (!asset || typeof asset !== 'object') return false;
  if (asset.name !== expectedName) return false;
  if (typeof asset.downloadUrl !== 'string' || !asset.downloadUrl.startsWith(RELEASE_DOWNLOAD_PREFIX)) return false;
  try {
    const url = new URL(asset.downloadUrl);
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.endsWith(`/${expectedName}`);
  } catch {
    return false;
  }
}

function validateAssetDownloadUrl(asset) {
  if (typeof asset?.name !== 'string' || !asset.name.endsWith('.zip')) return false;
  return validateGitHubReleaseAssetUrl(asset, asset.name);
}

async function verifyUpdateManifestSignature(updateManifest) {
  const signature = updateManifest.signature;
  if (!signature || typeof signature !== 'object') {
    throw new PackageInspectionError('missing_update_signature', 'Release updates.json is not signed by Chroma.');
  }
  if (signature.algorithm !== UPDATE_TRUST.signatureAlgorithm) {
    throw new PackageInspectionError('invalid_update_signature', 'Release updates.json uses an unsupported signature algorithm.');
  }
  if (signature.keyId !== UPDATE_TRUST.keyId) {
    throw new PackageInspectionError('invalid_update_signature', 'Release updates.json was signed by an unknown key.');
  }

  const key = await crypto.subtle.importKey(
    'jwk',
    UPDATE_TRUST.publicKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  const payload = new TextEncoder().encode(canonicalizeUpdateManifest(updateManifest));
  const signatureBytes = base64UrlToBytes(signature.value);
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    signatureBytes,
    payload
  );

  if (!ok) {
    throw new PackageInspectionError('invalid_update_signature', 'Release updates.json signature could not be verified.');
  }

  return {
    algorithm: signature.algorithm,
    keyId: signature.keyId
  };
}

async function validateUpdateManifest(updateManifest, { expectedVersion, asset }) {
  if (!updateManifest || typeof updateManifest !== 'object') {
    throw new PackageInspectionError('invalid_update_manifest', 'Release updates.json is not a JSON object.');
  }
  if (updateManifest.schema !== UPDATE_MANIFEST_SCHEMA) {
    throw new PackageInspectionError('invalid_update_manifest', 'Release updates.json has an unsupported schema.');
  }
  const manifestVersion = normalizeVersion(updateManifest.version);
  const targetVersion = normalizeVersion(expectedVersion);
  if (!manifestVersion || manifestVersion !== targetVersion) {
    throw new PackageInspectionError('update_manifest_version_mismatch', `Release updates.json is v${manifestVersion || 'unknown'}, expected v${targetVersion || 'unknown'}.`);
  }

  const packageInfo = updateManifest.package;
  const expectedBytes = Number(packageInfo?.bytes);
  const expectedSha256 = String(packageInfo?.sha256 || '').trim().toLowerCase();
  if (!packageInfo || typeof packageInfo !== 'object') {
    throw new PackageInspectionError('invalid_update_manifest', 'Release updates.json is missing package metadata.');
  }
  if (packageInfo.name !== asset?.name) {
    throw new PackageInspectionError('update_manifest_asset_mismatch', 'Release updates.json does not name the expected ZIP asset.');
  }
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > MAX_ZIP_BYTES) {
    throw new PackageInspectionError('invalid_update_manifest', 'Release updates.json has an invalid ZIP byte size.');
  }
  if (Number(asset?.size) > 0 && expectedBytes !== Number(asset.size)) {
    throw new PackageInspectionError('update_manifest_size_mismatch', 'Release updates.json byte size does not match GitHub asset metadata.');
  }
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new PackageInspectionError('invalid_update_manifest', 'Release updates.json has an invalid ZIP SHA-256.');
  }

  const normalizedManifest = {
    schema: updateManifest.schema,
    version: manifestVersion,
    package: {
      name: packageInfo.name,
      bytes: expectedBytes,
      sha256: expectedSha256
    }
  };
  const signature = await verifyUpdateManifestSignature({
    ...normalizedManifest,
    signature: updateManifest.signature
  });

  return {
    ...normalizedManifest,
    signature
  };
}

async function downloadUpdateManifest(asset, update) {
  if (!validateGitHubReleaseAssetUrl(asset, UPDATE_MANIFEST_ASSET_NAME)) {
    throw new PackageInspectionError('invalid_update_manifest_url', 'Release updates.json does not use the expected direct GitHub asset URL.');
  }
  if (Number(asset.size) > MAX_UPDATE_MANIFEST_BYTES) {
    throw new PackageInspectionError('update_manifest_too_large', 'Release updates.json exceeds the updater safety limit.');
  }

  const response = await fetch(asset.downloadUrl, {
    headers: { Accept: 'application/json' },
    cache: 'no-cache'
  });
  if (!response.ok) {
    throw new PackageInspectionError('update_manifest_download_failed', 'Release updates.json download failed.');
  }

  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_UPDATE_MANIFEST_BYTES) {
    throw new PackageInspectionError('update_manifest_too_large', 'Release updates.json exceeds the updater safety limit.');
  }

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_UPDATE_MANIFEST_BYTES) {
    throw new PackageInspectionError('update_manifest_too_large', 'Release updates.json exceeds the updater safety limit.');
  }
  if (Number(asset.size) > 0 && bytes.byteLength !== Number(asset.size)) {
    throw new PackageInspectionError('update_manifest_size_mismatch', 'Downloaded updates.json size does not match GitHub release metadata.');
  }

  try {
    const manifest = JSON.parse(decodeUtf8(toUint8Array(bytes)));
    return await validateUpdateManifest(manifest, {
      expectedVersion: update.latestVersion,
      asset: update.asset
    });
  } catch (error) {
    if (error instanceof PackageInspectionError) throw error;
    throw new PackageInspectionError('invalid_update_manifest', 'Release updates.json is not valid JSON.');
  }
}

export async function inspectUpdateZip(arrayBuffer, { expectedVersion, currentManifest = chrome.runtime.getManifest() } = {}) {
  try {
    const zipBytes = toUint8Array(arrayBuffer);
    if (zipBytes.byteLength > MAX_ZIP_BYTES) {
      return fail('zip_too_large', 'Release ZIP exceeds the updater download safety limit.');
    }

    const { entries, totalUncompressedBytes } = readZipEntries(zipBytes);
    const entryNames = new Set(entries.map(entry => entry.name));
    const manifestEntry = entries.find(entry => entry.name === 'manifest.json');
    if (!manifestEntry) {
      return fail('missing_manifest', 'Release ZIP does not contain manifest.json at the archive root.');
    }

    const manifestBytes = await readEntryBytes(zipBytes, manifestEntry);
    const manifest = JSON.parse(decodeUtf8(manifestBytes));
    const version = validateManifest(manifest, expectedVersion, currentManifest);
    const referencedPaths = collectManifestReferencedPaths(manifest);
    const missingPaths = referencedPaths.filter(path => !entryNames.has(path));
    if (missingPaths.length > 0) {
      return fail('missing_manifest_files', `Release ZIP is missing manifest-referenced file: ${missingPaths[0]}.`);
    }

    return {
      ok: true,
      package: {
        version,
        manifest,
        entryCount: entries.length,
        totalUncompressedBytes,
        requiredEntryCount: referencedPaths.length,
        files: buildPackageFileList(entries)
      }
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return fail('invalid_manifest', 'Release ZIP manifest.json is not valid JSON.');
    }
    return fail(error?.code || 'invalid_zip', error?.message || 'Release ZIP could not be inspected.');
  }
}

async function downloadAssetBytes(asset) {
  if (!validateAssetDownloadUrl(asset)) {
    throw new PackageInspectionError('invalid_asset_url', 'Release asset does not use the expected direct GitHub ZIP URL.');
  }
  if (asset.size > MAX_ZIP_BYTES) {
    throw new PackageInspectionError('zip_too_large', 'Release ZIP exceeds the updater download safety limit.');
  }

  const response = await fetch(asset.downloadUrl, {
    headers: { Accept: 'application/zip, application/octet-stream' },
    cache: 'no-cache'
  });

  if (!response.ok) {
    throw new PackageInspectionError('download_failed', 'Release ZIP download failed.');
  }

  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_ZIP_BYTES) {
    throw new PackageInspectionError('zip_too_large', 'Release ZIP exceeds the updater download safety limit.');
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_ZIP_BYTES) {
    throw new PackageInspectionError('zip_too_large', 'Release ZIP exceeds the updater download safety limit.');
  }
  if (Number(asset.size) > 0 && arrayBuffer.byteLength !== Number(asset.size)) {
    throw new PackageInspectionError('download_size_mismatch', 'Downloaded ZIP size does not match GitHub release metadata.');
  }

  return arrayBuffer;
}

export async function inspectLatestUpdatePackage(options = {}) {
  try {
    const update = await checkForUpdate({ force: options.force === true });
    if (!update?.updateAvailable) {
      if (update?.assetStatus === 'unavailable' || update?.assetStatus === 'missing-version') {
        return {
          ok: false,
          updateAvailable: false,
          latestVersion: null,
          package: null,
          code: 'release_unavailable',
          reason: 'Latest release metadata could not be reached.'
        };
      }
      return {
        ok: true,
        updateAvailable: false,
        latestVersion: null,
        package: null,
        reason: 'No newer release package is available.'
      };
    }

    if (update.assetStatus !== 'found' || !update.asset) {
      return {
        ok: false,
        updateAvailable: true,
        latestVersion: update.latestVersion,
        release: update.release || null,
        asset: update.asset || null,
        code: 'missing_asset',
        reason: `Latest release is missing chroma-ad-blocker-v${normalizeVersion(update.latestVersion)}.zip.`
      };
    }
    if (update.updateManifestStatus !== 'found' || !update.updateManifestAsset) {
      return {
        ok: false,
        updateAvailable: true,
        latestVersion: update.latestVersion,
        release: update.release || null,
        asset: update.asset,
        updateManifestAsset: update.updateManifestAsset || null,
        code: 'missing_update_manifest',
        reason: 'Latest release is missing updates.json for guided package verification.'
      };
    }

    const updateManifest = await downloadUpdateManifest(update.updateManifestAsset, update);
    const bytes = await downloadAssetBytes(update.asset);
    const hash = await requiredSha256Hex(bytes);
    if (bytes.byteLength !== updateManifest.package.bytes) {
      throw new PackageInspectionError('download_size_mismatch', 'Downloaded ZIP size does not match updates.json.');
    }
    if (hash !== updateManifest.package.sha256) {
      throw new PackageInspectionError('download_hash_mismatch', 'Downloaded ZIP SHA-256 does not match updates.json.');
    }

    const inspection = await inspectUpdateZip(bytes, {
      expectedVersion: update.latestVersion,
      currentManifest: chrome.runtime.getManifest()
    });

    if (!inspection.ok) {
      return {
        ok: false,
        updateAvailable: true,
        latestVersion: update.latestVersion,
        release: update.release || null,
        asset: update.asset,
        updateManifest,
        code: inspection.code,
        reason: inspection.reason
      };
    }

    return {
      ok: true,
      updateAvailable: true,
      latestVersion: update.latestVersion,
      release: update.release || null,
      asset: update.asset,
      updateManifest,
      package: {
        ...inspection.package,
        downloadBytes: bytes.byteLength,
        sha256: hash,
        verifiedBy: UPDATE_MANIFEST_VERIFICATION,
        signatureKeyId: updateManifest.signature.keyId
      },
      reason: `Release ZIP inspected: v${inspection.package.version}, ${inspection.package.entryCount} files, ${formatBytes(bytes.byteLength)}.`
    };
  } catch (error) {
    return {
      ok: false,
      updateAvailable: false,
      latestVersion: null,
      package: null,
      code: error?.code || 'package_inspection_failed',
      reason: error?.message || 'Release package inspection failed.'
    };
  }
}
