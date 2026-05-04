const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const repoRoot = path.join(__dirname, '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'test.yml');

test('CI workflow runs release package verification', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  assert.match(workflow, /run:\s+npm run package:extension\b/);
});
