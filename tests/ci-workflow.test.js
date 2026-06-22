const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const repoRoot = path.join(__dirname, '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'test.yml');
const packagePath = path.join(repoRoot, 'package.json');

test('CI workflow runs release package verification', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

  assert.match(workflow, /run:\s+npm run test:ci\b/);
  assert.match(pkg.scripts['test:ci'], /node scripts\/package-extension\.js\b/);
});

test('CI workflow uses a deterministic Chrome for Testing binary for E2E', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  assert.match(workflow, /uses:\s+browser-actions\/setup-chrome@v2\b/);
  assert.match(workflow, /chrome-version:\s+stable\b/);
  assert.match(workflow, /CHROME_FOR_TESTING_PATH=\$browser/);
  assert.doesNotMatch(workflow, /command -v chromium-browser/);
});
