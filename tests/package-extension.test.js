const test = require('node:test');
const assert = require('node:assert');
const {
  REQUIRED_RELEASE_FILES,
  FORBIDDEN_RELEASE_PATH_PATTERNS,
  verifyReleaseEntries
} = require('../scripts/package-extension');
const fs = require('fs');
const path = require('path');

const validReleaseEntries = [
  'manifest.json',
  'README.md',
  'LICENSE.md',
  'docs/PRIVACY_POLICY.md',
  'background/background.js',
  'rules/rules_oisd_1.json'
];

test('package verification accepts the expected release contents', () => {
  assert.ok(Array.isArray(REQUIRED_RELEASE_FILES));
  assert.ok(Array.isArray(FORBIDDEN_RELEASE_PATH_PATTERNS));
  assert.deepStrictEqual(verifyReleaseEntries(validReleaseEntries), []);
});

test('package verification rejects missing required release files', () => {
  const errors = verifyReleaseEntries([
    'manifest.json',
    'README.md',
    'background/background.js'
  ]);

  assert.ok(errors.some(error => error.includes('LICENSE.md')));
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

test('manifest and README document browser privacy permissions', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

  assert.ok(manifest.permissions.includes('privacy'));
  assert.ok(manifest.permissions.includes('contentSettings'));
  assert.match(readme, /\|\s*`privacy`\s*\|[^|]*WebRTC leak protection/i);
  assert.match(readme, /\|\s*`contentSettings`\s*\|[^|]*Geolocation Protection/i);
});

test('README documents broad host permission and remote list trust boundary', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

  assert.ok(manifest.host_permissions.includes('<all_urls>'));
  assert.match(readme, /\|\s*Host permission:\s*`<all_urls>`\s*\|[^|]*sensitive settings[^|]*local/i);
  assert.match(readme, /Chroma Hotfix[\s\S]*maintainer-controlled GitHub raw file[\s\S]*6 hours/i);
  assert.match(readme, /main remote trust boundary/i);
  assert.match(readme, /not arbitrary remote JavaScript execution/i);
});

test('privacy and security docs document remote list behavior', () => {
  const privacy = fs.readFileSync(path.join(__dirname, '..', 'docs', 'PRIVACY_POLICY.md'), 'utf8');
  const security = fs.readFileSync(path.join(__dirname, '..', 'docs', 'SECURITY.md'), 'utf8');

  assert.match(privacy, /Remote List Trust Boundary/i);
  assert.match(privacy, /Chroma Hotfix list/i);
  assert.match(privacy, /scriptlets are limited to Chroma's shipped scriptlet implementations/i);
  assert.match(security, /Remote List Trust Boundary/i);
  assert.match(security, /Scriptlet rules can only call implementations already shipped/i);
});
