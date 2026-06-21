const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const {
  REQUIRED_RELEASE_FILES,
  RELEASE_DOC_FILES,
  FORBIDDEN_RELEASE_PATH_PATTERNS,
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
  verifyReleaseEntries
} = require('../scripts/package-extension');
const fs = require('fs');
const path = require('path');

const validReleaseEntries = [
  'manifest.json',
  'README.md',
  'LICENSE.md',
  ...RELEASE_DOC_FILES,
  'background/background.js',
  'rules/rules_oisd_1.json'
];

test('package verification accepts the expected release contents', () => {
  assert.ok(Array.isArray(REQUIRED_RELEASE_FILES));
  assert.ok(RELEASE_DOC_FILES.includes('docs/TEST_GUIDE.md'));
  assert.ok(RELEASE_DOC_FILES.includes('docs/DISTRIBUTION.md'));
  assert.ok(!RELEASE_DOC_FILES.includes('docs/testing.md'));
  assert.ok(!RELEASE_DOC_FILES.includes('docs/dist.md'));
  assert.strictEqual(UPDATE_MANIFEST_FILE, 'updates.json');
  assert.ok(Array.isArray(FORBIDDEN_RELEASE_PATH_PATTERNS));
  assert.deepStrictEqual(verifyReleaseEntries(validReleaseEntries), []);
});

test('package script builds update manifest metadata for guided updater verification', () => {
  const manifest = buildUpdateManifest({
    version: '1.5.3',
    zipName: 'chroma-ad-blocker-v1.5.3.zip',
    zipBytes: 1234,
    sha256: 'a'.repeat(64)
  });

  assert.deepStrictEqual(manifest, {
    schema: UPDATE_MANIFEST_SCHEMA,
    version: '1.5.3',
    package: {
      name: 'chroma-ad-blocker-v1.5.3.zip',
      bytes: 1234,
      sha256: 'a'.repeat(64)
    }
  });
});

test('package script signs update manifest metadata with ECDSA P-256', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const manifest = buildUpdateManifest({
    version: '1.5.3',
    zipName: 'chroma-ad-blocker-v1.5.3.zip',
    zipBytes: 1234,
    sha256: 'A'.repeat(64)
  });

  const signed = signUpdateManifest(
    manifest,
    privateKey.export({ format: 'jwk' }),
    { keyId: UPDATE_SIGNING_KEY_ID }
  );
  const signature = Buffer.from(
    signed.signature.value.replace(/-/g, '+').replace(/_/g, '/'),
    'base64'
  );

  assert.strictEqual(signed.signature.algorithm, UPDATE_SIGNATURE_ALGORITHM);
  assert.strictEqual(signed.signature.keyId, UPDATE_SIGNING_KEY_ID);
  assert.strictEqual(signature.length, 64);
  assert.strictEqual(signed.package.sha256, 'A'.repeat(64));
  assert.match(canonicalizeUpdateManifest(signed), /"sha256":"a{64}"/);
  assert.strictEqual(
    crypto.verify(
      'sha256',
      Buffer.from(canonicalizeUpdateManifest(signed), 'utf8'),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      signature
    ),
    true
  );
});

test('package script validates signing private key against bundled public key', () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  const publicJwk = publicKeyFromPrivateJwk(privateJwk);

  assert.strictEqual(validateUpdateSigningPrivateKey(privateJwk, publicJwk), true);
});

test('package script rejects a signing private key that does not match the bundled public key', () => {
  const first = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const second = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateJwk = first.privateKey.export({ format: 'jwk' });
  const otherPublicJwk = publicKeyFromPrivateJwk(second.privateKey.export({ format: 'jwk' }));

  assert.throws(
    () => validateUpdateSigningPrivateKey(privateJwk, otherPublicJwk),
    /does not match the bundled public key/
  );
});

test('package script reads the bundled update public key', () => {
  const publicJwk = readBundledUpdatePublicKey();

  assert.deepStrictEqual(Object.keys(publicJwk).sort(), ['crv', 'kty', 'x', 'y']);
  assert.strictEqual(publicJwk.kty, 'EC');
  assert.strictEqual(publicJwk.crv, 'P-256');
  assert.match(publicJwk.x, /^[A-Za-z0-9_-]+$/);
  assert.match(publicJwk.y, /^[A-Za-z0-9_-]+$/);
});

test('package verification rejects missing required release files', () => {
  const errors = verifyReleaseEntries([
    'manifest.json',
    'README.md',
    'background/background.js'
  ]);

  assert.ok(errors.some(error => error.includes('LICENSE.md')));
  assert.ok(errors.some(error => error.includes('docs/README.md')));
  assert.ok(errors.some(error => error.includes('docs/PRIVACY_POLICY.md')));
});

test('package verification rejects repo-only and temporary paths', () => {
  const errors = verifyReleaseEntries([
    ...validReleaseEntries,
    'tests/package-extension.test.js',
    'node_modules/jsdom/index.js',
    '.git/config',
    '.github/workflows/test.yml',
    'logs/package.log',
    'tmp/package.tmp'
  ]);

  for (const entry of ['tests/', 'node_modules/', '.git/', '.github/', 'logs/', 'tmp/']) {
    assert.ok(
      errors.some(error => error.includes(entry)),
      `expected ${entry} to be rejected`
    );
  }
});

test('package verification rejects duplicate release entries', () => {
  const errors = verifyReleaseEntries([
    ...validReleaseEntries,
    'background/background.js',
    'background\\background.js'
  ]);

  assert.ok(
    errors.some(error => error.includes('duplicate release entry: background/background.js')),
    'expected duplicate normalized ZIP entry to be rejected'
  );
});

test('manifest and permissions doc document browser privacy permissions', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
  const permissions = fs.readFileSync(path.join(__dirname, '..', 'docs', 'PERMISSIONS.md'), 'utf8');

  assert.ok(manifest.permissions.includes('privacy'));
  assert.ok(manifest.permissions.includes('contentSettings'));
  assert.match(permissions, /\|\s*`privacy`\s*\|[^|]*WebRTC leak protection/i);
  assert.match(permissions, /\|\s*`contentSettings`\s*\|[^|]*Geolocation Protection/i);
});

test('docs document broad host permission and remote list trust boundary', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
  const permissions = fs.readFileSync(path.join(__dirname, '..', 'docs', 'PERMISSIONS.md'), 'utf8');
  const filterLists = fs.readFileSync(path.join(__dirname, '..', 'docs', 'FILTER_LISTS.md'), 'utf8');
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

  assert.ok(manifest.host_permissions.includes('<all_urls>'));
  assert.match(permissions, /\|\s*Host permission:\s*`<all_urls>`\s*\|[^|]*sensitive settings[^|]*local/i);
  assert.match(filterLists, /does not ship a maintainer-controlled hotfix subscription/i);
  assert.match(filterLists, /GitHub release packages/i);
  assert.match(filterLists, /custom subscription/i);
  assert.match(readme, /\[Permissions\]\(docs\/PERMISSIONS\.md\)/);
});

test('privacy and security docs document remote list behavior', () => {
  const privacy = fs.readFileSync(path.join(__dirname, '..', 'docs', 'PRIVACY_POLICY.md'), 'utf8');
  const security = fs.readFileSync(path.join(__dirname, '..', 'docs', 'SECURITY.md'), 'utf8');
  const threatModel = fs.readFileSync(path.join(__dirname, '..', 'docs', 'THREAT_MODEL.md'), 'utf8');

  assert.match(privacy, /Remote List Trust Boundary/i);
  assert.match(privacy, /does not ship a maintainer-controlled hotfix subscription/i);
  assert.match(privacy, /scriptlets are limited to Chroma's shipped scriptlet implementations/i);
  assert.match(security, /Remote List Trust Boundary/i);
  assert.match(security, /not through a default maintainer-controlled hotfix subscription/i);
  assert.match(security, /Scriptlet rules can only call implementations already shipped/i);
  assert.match(security, /Guided Update Trust Boundary/i);
  assert.match(security, /signed `updates\.json`/i);
  assert.match(threatModel, /Compromised GitHub release asset/i);
  assert.match(threatModel, /private update-signing key/i);
});

test('docs document guided updater requirements and fallback', () => {
  const install = fs.readFileSync(path.join(__dirname, '..', 'docs', 'INSTALL.md'), 'utf8');
  const distribution = fs.readFileSync(path.join(__dirname, '..', 'docs', 'DISTRIBUTION.md'), 'utf8');
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const privacy = fs.readFileSync(path.join(__dirname, '..', 'docs', 'PRIVACY_POLICY.md'), 'utf8');

  assert.match(install, /Settings -> Updates/);
  assert.match(install, /chroma-ad-blocker-vX\.Y\.Z\.zip/);
  assert.match(install, /manual update fallback/i);
  assert.match(distribution, /Guided Updater Requirements/);
  assert.match(distribution, /exact generated asset name/i);
  assert.match(distribution, /updates\.json/);
  assert.match(distribution, /Update Signing Key/);
  assert.match(distribution, /chroma-update-signing-2026-06/);
  assert.match(distribution, /CHROMA_REQUIRE_SIGNED_UPDATES=1/);
  assert.match(distribution, /validates that the private key matches the bundled public key/i);
  assert.match(distribution, /rejects unsigned release manifests/i);
  assert.match(readme, /guided updater/i);
  assert.match(privacy, /download signed `updates\.json` and the exact GitHub release ZIP into memory/i);
});
