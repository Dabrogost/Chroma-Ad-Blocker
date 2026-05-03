const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const extensionRoot = path.join(__dirname, '..', 'extension');
const manifestPath = path.join(extensionRoot, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const ruleResources = manifest.declarative_net_request.rule_resources;

const ALLOWED_ACTION_TYPES = new Set([
  'block',
  'redirect',
  'allow',
  'upgradeScheme',
  'modifyHeaders',
  'allowAllRequests'
]);

const ALLOWED_RESOURCE_TYPES = new Set([
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other'
]);

function loadRules(resource) {
  const rulesPath = path.join(extensionRoot, resource.path);
  return JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
}

test('Manifest-declared static DNR rulesets', async (t) => {
  await t.test('declares the expected enabled ruleset ids', () => {
    assert.strictEqual(ruleResources.length, 11, 'manifest should declare all 11 static DNR rulesets');
    assert.deepStrictEqual(ruleResources.map(r => r.id), [
      'yt_original_rules',
      'yt_ad_rules_part1',
      'yt_ad_rules_part2',
      'yt_ad_rules_part3',
      'yt_ad_rules_part4',
      'yt_ad_rules_part5',
      'yt_ad_rules_part6',
      'yt_ad_rules_part7',
      'yt_ad_rules_part8',
      'yt_ad_rules_part9',
      'recipe_ad_rules'
    ]);
    assert.ok(ruleResources.every(r => r.enabled === true), 'all static rulesets should be enabled by default');
  });

  await t.test('every declared ruleset file exists and parses as a JSON array', () => {
    for (const resource of ruleResources) {
      const rulesPath = path.join(extensionRoot, resource.path);
      assert.ok(fs.existsSync(rulesPath), `${resource.id} path should exist: ${resource.path}`);
      assert.ok(Array.isArray(loadRules(resource)), `${resource.id} should parse as a JSON array`);
    }
  });

  await t.test('every rule has required MV3 DNR fields and no duplicate ids inside its ruleset', () => {
    for (const resource of ruleResources) {
      const ids = new Set();
      const rules = loadRules(resource);

      rules.forEach((rule, index) => {
        const label = `${resource.id}[${index}]`;
        assert.strictEqual(typeof rule.id, 'number', `${label} must have a numeric id`);
        assert.ok(Number.isInteger(rule.id) && rule.id > 0, `${label} id must be a positive integer`);
        assert.ok(!ids.has(rule.id), `${label} duplicates id ${rule.id}`);
        ids.add(rule.id);

        assert.strictEqual(typeof rule.priority, 'number', `${label} must have numeric priority`);
        assert.ok(rule.action && typeof rule.action === 'object', `${label} must have an action object`);
        assert.ok(ALLOWED_ACTION_TYPES.has(rule.action.type), `${label} has unsupported action type ${rule.action.type}`);
        assert.ok(rule.condition && typeof rule.condition === 'object', `${label} must have a condition object`);
      });
    }
  });

  await t.test('resourceTypes only use Chrome-supported DNR values', () => {
    for (const resource of ruleResources) {
      const rules = loadRules(resource);
      rules.forEach((rule, index) => {
        const label = `${resource.id}[${index}]`;
        for (const key of ['resourceTypes', 'excludedResourceTypes']) {
          const values = rule.condition && rule.condition[key];
          if (values === undefined) continue;
          assert.ok(Array.isArray(values), `${label}.${key} must be an array`);
          for (const value of values) {
            assert.ok(ALLOWED_RESOURCE_TYPES.has(value), `${label}.${key} has unsupported value ${value}`);
          }
        }
      });
    }
  });

  await t.test('regexFilter rules are syntactically valid and stay under Chrome size limits', () => {
    for (const resource of ruleResources) {
      const rules = loadRules(resource);
      rules.forEach((rule, index) => {
        const regexFilter = rule.condition && rule.condition.regexFilter;
        if (regexFilter === undefined) return;
        const label = `${resource.id}[${index}].condition.regexFilter`;
        assert.strictEqual(typeof regexFilter, 'string', `${label} must be a string`);
        assert.ok(Buffer.byteLength(regexFilter, 'utf8') <= 2048, `${label} exceeds Chrome's 2KB regexFilter limit`);
        assert.doesNotThrow(() => new RegExp(regexFilter), `${label} must compile as a regex`);
      });
    }
  });
});
