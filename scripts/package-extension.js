const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const repoRoot = path.join(__dirname, '..');
const extensionRoot = path.join(repoRoot, 'extension');
const manifestPath = path.join(extensionRoot, 'manifest.json');
const distDir = path.join(repoRoot, 'dist');
const UPDATE_MANIFEST_FILE = 'updates.json';
const UPDATE_MANIFEST_SCHEMA = 'chroma-update-manifest-v1';
const UPDATE_SIGNATURE_ALGORITHM = 'ECDSA_P256_SHA256';
const UPDATE_SIGNING_KEY_ID = 'chroma-update-signing-2026-06';
const UPDATE_SIGNING_PRIVATE_KEY_FILE_ENV = 'CHROMA_UPDATE_SIGNING_PRIVATE_KEY_FILE';
const UPDATE_SIGNING_PRIVATE_KEY_JWK_ENV = 'CHROMA_UPDATE_SIGNING_PRIVATE_KEY_JWK';
const REQUIRE_SIGNED_UPDATES_ENV = 'CHROMA_REQUIRE_SIGNED_UPDATES';
const DEFAULT_UPDATE_SIGNING_PRIVATE_KEY_FILE = path.join(repoRoot, 'secrets', 'chroma-update-signing-private-key.jwk');
const updateTrustPath = path.join(extensionRoot, 'background', 'updateTrust.js');

const RELEASE_DOC_FILES = [
  'docs/README.md',
  'docs/INSTALL.md',
  'docs/FEATURES.md',
  'docs/ARCHITECTURE.md',
  'docs/PERFORMANCE.md',
  'docs/MEDIA_PROXY_ROUTER.md',
  'docs/YOUTUBE.md',
  'docs/FILTER_LISTS.md',
  'docs/PERMISSIONS.md',
  'docs/STATISTICS.md',
  'docs/PRIVACY_POLICY.md',
  'docs/SECURITY.md',
  'docs/THREAT_MODEL.md',
  'docs/CONTRIBUTING.md',
  'docs/TEST_GUIDE.md',
  'docs/DISTRIBUTION.md',
  'docs/ToS.md',
  'docs/PROJECT_PHILOSOPHY.md'
];

const REQUIRED_RELEASE_FILES = [
  'manifest.json',
  'README.md',
  'LICENSE.md',
  ...RELEASE_DOC_FILES
];

const FORBIDDEN_RELEASE_PATH_PATTERNS = [
  { label: 'tests/', regex: /^tests\// },
  { label: 'node_modules/', regex: /^node_modules\// },
  { label: '.git/', regex: /^\.git\// },
  { label: '.github/', regex: /^\.github\// },
  { label: 'logs/', regex: /(^|\/)logs\// },
  { label: 'tmp/', regex: /(^|\/)(tmp|temp)\// },
  { label: 'temporary files', regex: /(^|\/)(Thumbs\.db|\.DS_Store|.*\.(log|tmp|temp|swp))$/i }
];

function crc32(buffer) {
  let crc = 0 ^ -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function dosTimeDate() {
  // Fixed timestamp keeps the archive stable across repeated local builds.
  const year = 2026;
  const month = 1;
  const day = 1;
  const hour = 0;
  const minute = 0;
  const second = 0;
  const time = (hour << 11) | (minute << 5) | Math.floor(second / 2);
  const date = ((year - 1980) << 9) | (month << 5) | day;
  return { time, date };
}

function listExtensionFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '_metadata') continue;
    const absolute = path.join(dir, entry.name);
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...listExtensionFiles(absolute, relative));
    else if (entry.isFile()) {
      out.push({
        source: path.join(extensionRoot, relative),
        zipName: relative
      });
    }
  }
  return out;
}

function addRepoFile(files, relativePath) {
  const absolute = path.join(repoRoot, relativePath);
  if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
    files.push({
      source: absolute,
      zipName: relativePath
    });
  }
}

function releaseFiles() {
  const files = listExtensionFiles(extensionRoot);
  addRepoFile(files, 'README.md');
  addRepoFile(files, 'LICENSE.md');
  for (const docPath of RELEASE_DOC_FILES) addRepoFile(files, docPath);
  return files.sort((a, b) => a.zipName.localeCompare(b.zipName));
}

function normalizeZipEntry(entryName) {
  return entryName.replace(/\\/g, '/');
}

function verifyReleaseEntries(entries) {
  const normalizedEntries = entries.map(normalizeZipEntry);
  const entrySet = new Set(normalizedEntries);
  const seenEntries = new Set();
  const errors = [];

  for (const requiredFile of REQUIRED_RELEASE_FILES) {
    if (!entrySet.has(requiredFile)) {
      errors.push(`Release ZIP is missing required file: ${requiredFile}`);
    }
  }

  for (const entry of normalizedEntries) {
    if (seenEntries.has(entry)) {
      errors.push(`Release ZIP contains duplicate release entry: ${entry}`);
    } else {
      seenEntries.add(entry);
    }

    if (path.posix.isAbsolute(entry) || entry.split('/').includes('..')) {
      errors.push(`Release ZIP contains unsafe path: ${entry}`);
    }

    for (const pattern of FORBIDDEN_RELEASE_PATH_PATTERNS) {
      if (pattern.regex.test(entry)) {
        errors.push(`Release ZIP contains forbidden ${pattern.label} entry: ${entry}`);
      }
    }
  }

  return errors;
}

function readZipEntries(zipBuffer) {
  const endSignature = 0x06054b50;
  let endOffset = -1;
  const minEndOffset = Math.max(0, zipBuffer.length - 22 - 0xffff);
  for (let offset = zipBuffer.length - 22; offset >= minEndOffset; offset--) {
    if (zipBuffer.readUInt32LE(offset) === endSignature) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset === -1) {
    throw new Error('Release ZIP is missing an end-of-central-directory record.');
  }

  const entryCount = zipBuffer.readUInt16LE(endOffset + 10);
  let offset = zipBuffer.readUInt32LE(endOffset + 16);
  const entries = [];

  for (let index = 0; index < entryCount; index++) {
    if (zipBuffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Release ZIP central directory entry ${index} is malformed.`);
    }
    const nameLength = zipBuffer.readUInt16LE(offset + 28);
    const extraLength = zipBuffer.readUInt16LE(offset + 30);
    const commentLength = zipBuffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    entries.push(normalizeZipEntry(zipBuffer.subarray(nameStart, nameEnd).toString('utf8')));
    offset = nameEnd + extraLength + commentLength;
  }

  return entries;
}

function verifyZipContents(zipBuffer) {
  return verifyReleaseEntries(readZipEntries(zipBuffer));
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function canonicalUpdateManifestPayload(updateManifest) {
  return {
    schema: updateManifest.schema,
    version: updateManifest.version,
    package: {
      name: updateManifest.package.name,
      bytes: updateManifest.package.bytes,
      sha256: String(updateManifest.package.sha256).toLowerCase()
    }
  };
}

function canonicalizeUpdateManifest(updateManifest) {
  return stableStringify(canonicalUpdateManifestPayload(updateManifest));
}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function readUpdateSigningPrivateKey() {
  const inlineJwk = process.env[UPDATE_SIGNING_PRIVATE_KEY_JWK_ENV];
  if (inlineJwk) return JSON.parse(inlineJwk);

  const keyPath = process.env[UPDATE_SIGNING_PRIVATE_KEY_FILE_ENV] || DEFAULT_UPDATE_SIGNING_PRIVATE_KEY_FILE;
  if (!fs.existsSync(keyPath)) return null;
  return JSON.parse(fs.readFileSync(keyPath, 'utf8'));
}

function readBundledUpdatePublicKey() {
  const source = fs.readFileSync(updateTrustPath, 'utf8');
  const readField = field => {
    const match = source.match(new RegExp(`\\b${field}: '([^']+)'`));
    if (!match) throw new Error(`Bundled update public key is missing ${field}.`);
    return match[1];
  };
  return {
    kty: readField('kty'),
    crv: readField('crv'),
    x: readField('x'),
    y: readField('y')
  };
}

function publicKeyFromPrivateJwk(privateJwk) {
  const privateKey = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
  const publicJwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  return {
    kty: publicJwk.kty,
    crv: publicJwk.crv,
    x: publicJwk.x,
    y: publicJwk.y
  };
}

function validateUpdateSigningPrivateKey(privateJwk, expectedPublicJwk = readBundledUpdatePublicKey()) {
  const actualPublicJwk = publicKeyFromPrivateJwk(privateJwk);
  for (const field of ['kty', 'crv', 'x', 'y']) {
    if (actualPublicJwk[field] !== expectedPublicJwk[field]) {
      throw new Error('Update signing private key does not match the bundled public key.');
    }
  }
  return true;
}

function signUpdateManifest(updateManifest, privateJwk, { keyId = UPDATE_SIGNING_KEY_ID } = {}) {
  if (!privateJwk || typeof privateJwk !== 'object') {
    throw new Error('Missing update signing private key JWK.');
  }

  const key = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
  const payload = Buffer.from(canonicalizeUpdateManifest(updateManifest), 'utf8');
  const signature = crypto.sign('sha256', payload, {
    key,
    dsaEncoding: 'ieee-p1363'
  });

  return {
    ...updateManifest,
    signature: {
      algorithm: UPDATE_SIGNATURE_ALGORITHM,
      keyId,
      value: base64UrlEncode(signature)
    }
  };
}

function shouldRequireSignedUpdates() {
  return /^(1|true|yes)$/i.test(String(process.env[REQUIRE_SIGNED_UPDATES_ENV] || ''));
}

function buildUpdateManifest({ version, zipName, zipBytes, sha256 }) {
  return {
    schema: UPDATE_MANIFEST_SCHEMA,
    version,
    package: {
      name: zipName,
      bytes: zipBytes,
      sha256
    }
  };
}

function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { time, date } = dosTimeDate();

  for (const file of files) {
    const name = Buffer.from(file.zipName.replace(/\\/g, '/'));
    const data = fs.readFileSync(file.source);
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function main() {
  if (!fs.existsSync(manifestPath)) {
    console.error('Missing extension/manifest.json; cannot package extension.');
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = manifest.version;
  if (typeof version !== 'string' || !/^\d+(?:\.\d+){1,3}$/.test(version)) {
    console.error('extension/manifest.json must have a numeric dotted version before packaging.');
    process.exit(1);
  }
  const zipName = `chroma-ad-blocker-v${version}.zip`;
  const zipPath = path.join(distDir, zipName);
  const updateManifestPath = path.join(distDir, UPDATE_MANIFEST_FILE);

  fs.mkdirSync(distDir, { recursive: true });
  const files = releaseFiles();
  const zip = makeZip(files);
  const verificationErrors = verifyZipContents(zip);
  if (verificationErrors.length > 0) {
    console.error('Release ZIP verification failed:');
    verificationErrors.forEach(error => console.error(`- ${error}`));
    process.exit(1);
  }

  fs.writeFileSync(zipPath, zip);

  const hash = crypto.createHash('sha256').update(zip).digest('hex');
  let updateManifest = buildUpdateManifest({
    version,
    zipName,
    zipBytes: zip.length,
    sha256: hash
  });
  const signingPrivateKey = readUpdateSigningPrivateKey();
  if (signingPrivateKey) {
    validateUpdateSigningPrivateKey(signingPrivateKey);
    updateManifest = signUpdateManifest(updateManifest, signingPrivateKey);
  } else {
    if (shouldRequireSignedUpdates()) {
      console.error(`Missing update signing key. Set ${UPDATE_SIGNING_PRIVATE_KEY_FILE_ENV} or ${UPDATE_SIGNING_PRIVATE_KEY_JWK_ENV}, or create ${DEFAULT_UPDATE_SIGNING_PRIVATE_KEY_FILE}.`);
      process.exit(1);
    }
    console.warn(`Update manifest is unsigned. Guided updater verification requires a signing key at ${DEFAULT_UPDATE_SIGNING_PRIVATE_KEY_FILE} or ${UPDATE_SIGNING_PRIVATE_KEY_FILE_ENV}.`);
  }
  fs.writeFileSync(updateManifestPath, `${JSON.stringify(updateManifest, null, 2)}\n`);

  console.log(`ZIP: ${zipPath}`);
  console.log(`Bytes: ${zip.length}`);
  console.log(`SHA-256: ${hash}`);
  console.log(`Update manifest: ${updateManifestPath}`);
  console.log(`Update manifest signature: ${updateManifest.signature ? updateManifest.signature.keyId : 'unsigned'}`);
  console.log('ZIP verification passed.');
}

if (require.main === module) {
  main();
}

module.exports = {
  FORBIDDEN_RELEASE_PATH_PATTERNS,
  RELEASE_DOC_FILES,
  REQUIRED_RELEASE_FILES,
  UPDATE_MANIFEST_FILE,
  UPDATE_MANIFEST_SCHEMA,
  UPDATE_SIGNATURE_ALGORITHM,
  UPDATE_SIGNING_KEY_ID,
  buildUpdateManifest,
  canonicalizeUpdateManifest,
  publicKeyFromPrivateJwk,
  readBundledUpdatePublicKey,
  signUpdateManifest,
  validateUpdateSigningPrivateKey,
  readZipEntries,
  verifyReleaseEntries,
  verifyZipContents
};
