const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const extensionRoot = path.join(repoRoot, 'extension');
const manifestPath = path.join(extensionRoot, 'manifest.json');

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

const errors = [];
const warnings = [];
const counts = [];

function addError(message) {
  errors.push(message);
}

function addWarning(message) {
  warnings.push(message);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    addError(`${label} is not valid JSON: ${err.message}`);
    return null;
  }
}

function validateAction(rule, label) {
  if (!rule.action || typeof rule.action !== 'object' || Array.isArray(rule.action)) {
    addError(`${label} missing action object`);
    return;
  }
  if (!ALLOWED_ACTION_TYPES.has(rule.action.type)) {
    addError(`${label} has unsupported action.type "${rule.action.type}"`);
  }
}

function validateCondition(rule, label) {
  if (!rule.condition || typeof rule.condition !== 'object' || Array.isArray(rule.condition)) {
    addError(`${label} missing condition object`);
    return;
  }

  for (const key of ['resourceTypes', 'excludedResourceTypes']) {
    const values = rule.condition[key];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.length === 0) {
      addError(`${label}.condition.${key} must be a non-empty array when present`);
      continue;
    }
    for (const value of values) {
      if (!ALLOWED_RESOURCE_TYPES.has(value)) {
        addError(`${label}.condition.${key} has unsupported value "${value}"`);
      }
    }
  }

  if (rule.condition.regexFilter !== undefined) {
    if (typeof rule.condition.regexFilter !== 'string') {
      addError(`${label}.condition.regexFilter must be a string`);
    } else {
      if (Buffer.byteLength(rule.condition.regexFilter, 'utf8') > 2048) {
        addError(`${label}.condition.regexFilter exceeds Chrome's 2KB regexFilter limit`);
      }
      try {
        new RegExp(rule.condition.regexFilter);
      } catch (err) {
        addError(`${label}.condition.regexFilter does not compile: ${err.message}`);
      }
    }
  }
}

function validateRule(rule, label, ids) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    addError(`${label} must be an object`);
    return;
  }

  if (!Number.isInteger(rule.id) || rule.id <= 0) {
    addError(`${label} must have a positive integer id`);
  } else if (ids.has(rule.id)) {
    addError(`${label} duplicates rule id ${rule.id} inside this ruleset`);
  } else {
    ids.add(rule.id);
  }

  if (typeof rule.priority !== 'number' || !Number.isFinite(rule.priority) || rule.priority < 1) {
    addError(`${label} must have numeric priority >= 1`);
  }

  validateAction(rule, label);
  validateCondition(rule, label);
}

function main() {
  if (!fs.existsSync(manifestPath)) {
    addError(`Missing manifest: ${path.relative(repoRoot, manifestPath)}`);
  }

  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath, 'extension/manifest.json') : null;
  const resources = manifest?.declarative_net_request?.rule_resources;
  if (!Array.isArray(resources) || resources.length === 0) {
    addError('manifest declarative_net_request.rule_resources must be a non-empty array');
  }

  const rulesetIds = new Set();
  for (const [index, resource] of (resources || []).entries()) {
    const resourceLabel = `rule_resources[${index}]`;
    if (!resource || typeof resource !== 'object') {
      addError(`${resourceLabel} must be an object`);
      continue;
    }
    if (typeof resource.id !== 'string' || !resource.id) {
      addError(`${resourceLabel} must have a non-empty string id`);
    } else if (rulesetIds.has(resource.id)) {
      addError(`${resourceLabel} duplicates ruleset id "${resource.id}"`);
    } else {
      rulesetIds.add(resource.id);
    }
    if (typeof resource.path !== 'string' || !resource.path) {
      addError(`${resourceLabel} must have a non-empty path`);
      continue;
    }

    const rulesPath = path.join(extensionRoot, resource.path);
    if (!fs.existsSync(rulesPath)) {
      addError(`${resource.id || resourceLabel} missing file: ${resource.path}`);
      continue;
    }

    const rules = readJson(rulesPath, resource.path);
    if (!Array.isArray(rules) || rules.length === 0) {
      addError(`${resource.path} must be a non-empty JSON array`);
      continue;
    }

    const ids = new Set();
    rules.forEach((rule, ruleIndex) => {
      validateRule(rule, `${resource.id || resource.path}[${ruleIndex}]`, ids);
    });
    counts.push({ id: resource.id, path: resource.path, count: rules.length });
  }

  const totalRules = counts.reduce((sum, item) => sum + item.count, 0);
  if (totalRules > 300000) {
    addWarning(`Total static rule count ${totalRules} exceeds Chrome's global static-rule guidance of 300,000`);
  }

  console.log('DNR ruleset validation summary');
  console.log(`Rulesets: ${counts.length}`);
  console.log(`Total rules: ${totalRules}`);
  for (const item of counts) {
    console.log(`- ${item.id}: ${item.count} rules (${item.path})`);
  }
  if (warnings.length > 0) {
    console.log('\nWarnings:');
    warnings.forEach(message => console.log(`- ${message}`));
  }
  if (errors.length > 0) {
    console.error('\nErrors:');
    errors.forEach(message => console.error(`- ${message}`));
    process.exitCode = 1;
    return;
  }
  console.log('\nValidation passed.');
}

main();
