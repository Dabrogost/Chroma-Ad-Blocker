const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function extractMessageMap(source, objectPattern, label) {
  const objectMatch = source.match(objectPattern);
  assert.ok(objectMatch, `Could not find ${label} message map`);

  const entries = {};
  const entryPattern = /^\s*([A-Z0-9_]+)\s*:\s*'([^']+)'\s*,?/gm;
  let entryMatch;

  while ((entryMatch = entryPattern.exec(objectMatch[1])) !== null) {
    entries[entryMatch[1]] = entryMatch[2];
  }

  assert.ok(Object.keys(entries).length > 0, `${label} message map has no entries`);
  return entries;
}

function assertIdentityValues(entries, label) {
  for (const [key, value] of Object.entries(entries)) {
    assert.strictEqual(value, key, `${label}.${key} should equal its key`);
  }
}

test('messageTypes.js and messaging.js define the same MSG keys', () => {
  const moduleMessages = extractMessageMap(
    readProjectFile('extension/core/messageTypes.js'),
    /export\s+const\s+MSG\s*=\s*\{([\s\S]*?)\n\};/,
    'messageTypes.js'
  );

  const windowMessages = extractMessageMap(
    readProjectFile('extension/core/messaging.js'),
    /window\.MSG\s*=\s*\{([\s\S]*?)\n\s*\};/,
    'messaging.js'
  );

  assertIdentityValues(moduleMessages, 'messageTypes.js');
  assertIdentityValues(windowMessages, 'messaging.js');

  assert.deepStrictEqual(
    Object.keys(windowMessages).sort(),
    Object.keys(moduleMessages).sort(),
    'window.MSG and exported MSG should define the same keys'
  );
});

test('stats message types are routed as sensitive background messages', () => {
  const handlers = readProjectFile('extension/background/handlers.js');
  for (const type of ['STATS_GET', 'STATS_EVENT_BATCH', 'STATS_RESET', 'STATS_EXPORT', 'STATS_SETTINGS_SET']) {
    assert.match(handlers, new RegExp(`markSensitive\\(MSG\\.${type}\\)`), `${type} should be marked sensitive`);
    assert.match(handlers, new RegExp(`registerHandler\\(MSG\\.${type}`), `${type} should have a handler`);
  }
});
