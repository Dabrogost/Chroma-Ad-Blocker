const test = require('node:test');
const assert = require('node:assert');
const {
  REQUIRED_RELEASE_FILES,
  FORBIDDEN_RELEASE_PATH_PATTERNS,
  verifyReleaseEntries
} = require('../scripts/package-extension');

const validReleaseEntries = [
  'manifest.json',
  'README.md',
  'LICENSE.md',
  'docs/PRIVACY_POLICY.md',
  'background/background.js',
  'rules/rules.json'
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
