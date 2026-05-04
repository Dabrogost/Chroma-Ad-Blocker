const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const repoRoot = path.join(__dirname, '..');
const extensionRoot = path.join(repoRoot, 'extension');
const manifestPath = path.join(extensionRoot, 'manifest.json');
const distDir = path.join(repoRoot, 'dist');

const REQUIRED_RELEASE_FILES = [
  'manifest.json',
  'README.md',
  'LICENSE.md',
  'docs/PRIVACY_POLICY.md'
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
  addRepoFile(files, path.join('docs', 'PRIVACY_POLICY.md'));
  return files.sort((a, b) => a.zipName.localeCompare(b.zipName));
}

function normalizeZipEntry(entryName) {
  return entryName.replace(/\\/g, '/');
}

function verifyReleaseEntries(entries) {
  const normalizedEntries = entries.map(normalizeZipEntry);
  const entrySet = new Set(normalizedEntries);
  const errors = [];

  for (const requiredFile of REQUIRED_RELEASE_FILES) {
    if (!entrySet.has(requiredFile)) {
      errors.push(`Release ZIP is missing required file: ${requiredFile}`);
    }
  }

  for (const entry of normalizedEntries) {
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
  const zipPath = path.join(distDir, `chroma-ad-blocker-v${version}.zip`);

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
  console.log(`ZIP: ${zipPath}`);
  console.log(`Bytes: ${zip.length}`);
  console.log(`SHA-256: ${hash}`);
  console.log('ZIP verification passed.');
}

if (require.main === module) {
  main();
}

module.exports = {
  FORBIDDEN_RELEASE_PATH_PATTERNS,
  REQUIRED_RELEASE_FILES,
  readZipEntries,
  verifyReleaseEntries,
  verifyZipContents
};
