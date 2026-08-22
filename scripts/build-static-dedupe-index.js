const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_MANIFEST_PATH = path.join(REPO_ROOT, 'extension', 'manifest.json');
const DEFAULT_OUTPUT_PATH = path.join(REPO_ROOT, 'extension', 'rules', 'static_dedupe_index.json');
const DOMAIN_BLOCK_FILTER_RE = /^\|\|([A-Za-z0-9.-]+)\^$/;

function sortedArray(value) {
  return Array.isArray(value) ? value.slice().sort() : [];
}

/**
 * Keep this representation in lockstep with subscriptions/manager.js.
 * Rule IDs and condition fields omitted here intentionally do not affect the
 * subscription-versus-static deduplication policy.
 */
function networkRuleDedupeShape(rule) {
  const condition = rule?.condition || {};
  return {
    actionType: rule?.action?.type || '',
    urlFilter: condition.urlFilter || '',
    regexFilter: condition.regexFilter || '',
    resourceTypes: sortedArray(condition.resourceTypes),
    domainType: condition.domainType || '',
    initiatorDomains: sortedArray(condition.initiatorDomains),
    excludedInitiatorDomains: sortedArray(condition.excludedInitiatorDomains),
    priority: Number(rule?.priority) || 0
  };
}

function networkRuleDedupeKey(rule) {
  return JSON.stringify(networkRuleDedupeShape(rule));
}

function isIndexedStaticRule(rule) {
  return Boolean(
    rule?.condition &&
    (rule.condition.urlFilter || rule.condition.regexFilter)
  );
}

/**
 * Returns the compact domain representation when the rule's dedupe key is the
 * canonical priority-1 domain block shape. All fields considered here are the
 * fields represented by networkRuleDedupeKey(); other DNR fields are ignored
 * for exact parity with the existing runtime policy.
 */
function canonicalDomainBlockDomain(rule) {
  if (!isIndexedStaticRule(rule)) return null;

  const shape = networkRuleDedupeShape(rule);
  const match = typeof shape.urlFilter === 'string'
    ? DOMAIN_BLOCK_FILTER_RE.exec(shape.urlFilter)
    : null;
  if (
    shape.actionType !== 'block' ||
    shape.priority !== 1 ||
    !match ||
    shape.regexFilter !== '' ||
    shape.resourceTypes.length !== 0 ||
    shape.domainType !== '' ||
    shape.initiatorDomains.length !== 0 ||
    shape.excludedInitiatorDomains.length !== 0
  ) {
    return null;
  }

  return match[1];
}

function classifyStaticRule(rule) {
  if (!isIndexedStaticRule(rule)) return null;

  const domain = canonicalDomainBlockDomain(rule);
  if (domain !== null) {
    return { type: 'domainBlockDomain', value: domain };
  }

  return { type: 'otherRuleKey', value: networkRuleDedupeKey(rule) };
}

function sourceDigestPayload(index) {
  return {
    schemaVersion: index.schemaVersion,
    sourceResourceCount: index.metadata.sourceResourceCount,
    sourceRuleCount: index.metadata.sourceRuleCount,
    indexedRuleCount: index.metadata.indexedRuleCount,
    uniqueKeyCount: index.metadata.uniqueKeyCount,
    domainBlockDomainCount: index.metadata.domainBlockDomainCount,
    otherRuleKeyCount: index.metadata.otherRuleKeyCount,
    domainBlockDomains: index.domainBlockDomains,
    otherRuleKeys: index.otherRuleKeys
  };
}

function computeSourceDigest(index) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(sourceDigestPayload(index)))
    .digest('hex');
}

function buildStaticDedupeIndexFromRules(rules, options = {}) {
  if (!Array.isArray(rules)) {
    throw new TypeError('rules must be an array');
  }
  const sourceResourceCount = options.sourceResourceCount ?? 1;
  if (!Number.isInteger(sourceResourceCount) || sourceResourceCount < 0) {
    throw new TypeError('sourceResourceCount must be a non-negative integer');
  }

  const domainBlockDomains = new Set();
  const otherRuleKeys = new Set();
  let indexedRuleCount = 0;

  for (const rule of rules) {
    const classified = classifyStaticRule(rule);
    if (!classified) continue;

    indexedRuleCount++;
    if (classified.type === 'domainBlockDomain') {
      domainBlockDomains.add(classified.value);
    } else {
      otherRuleKeys.add(classified.value);
    }
  }

  const sortedDomains = Array.from(domainBlockDomains).sort();
  const sortedOtherKeys = Array.from(otherRuleKeys).sort();
  const index = {
    schemaVersion: SCHEMA_VERSION,
    metadata: {
      sourceDigest: '',
      sourceResourceCount,
      sourceRuleCount: rules.length,
      indexedRuleCount,
      uniqueKeyCount: sortedDomains.length + sortedOtherKeys.length,
      domainBlockDomainCount: sortedDomains.length,
      otherRuleKeyCount: sortedOtherKeys.length
    },
    domainBlockDomains: sortedDomains,
    otherRuleKeys: sortedOtherKeys
  };

  index.metadata.sourceDigest = computeSourceDigest(index);
  return index;
}

function buildStaticDedupeIndexFromResources(resources) {
  if (!Array.isArray(resources)) {
    throw new TypeError('resources must be an array');
  }

  const rules = [];
  for (const resource of resources) {
    const resourceRules = Array.isArray(resource) ? resource : resource?.rules;
    if (!Array.isArray(resourceRules)) {
      throw new TypeError('each resource must be a rule array or have a rules array');
    }
    rules.push(...resourceRules);
  }

  return buildStaticDedupeIndexFromRules(rules, {
    sourceResourceCount: resources.length
  });
}

function readManifestRuleResources(manifestPath = DEFAULT_MANIFEST_PATH) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const resourceEntries = manifest?.declarative_net_request?.rule_resources;
  if (!Array.isArray(resourceEntries)) {
    throw new Error(`No declarativeNetRequest rule resources in ${manifestPath}`);
  }

  const extensionRoot = path.dirname(manifestPath);
  return resourceEntries.map(resource => {
    if (!resource || typeof resource.path !== 'string' || !resource.path) {
      throw new Error(`Invalid declarativeNetRequest rule resource in ${manifestPath}`);
    }

    const resourcePath = path.resolve(extensionRoot, resource.path);
    const rules = JSON.parse(fs.readFileSync(resourcePath, 'utf8'));
    if (!Array.isArray(rules)) {
      throw new Error(`Static rule resource must contain an array: ${resource.path}`);
    }

    return {
      id: resource.id,
      path: resource.path,
      rules
    };
  });
}

function generateStaticDedupeIndex(options = {}) {
  const manifestPath = options.manifestPath || DEFAULT_MANIFEST_PATH;
  return buildStaticDedupeIndexFromResources(readManifestRuleResources(manifestPath));
}

function serializeStaticDedupeIndex(index) {
  const lines = [
    '{',
    `  "schemaVersion": ${JSON.stringify(index.schemaVersion)},`,
    `  "metadata": ${JSON.stringify(index.metadata)},`,
    '  "domainBlockDomains": ['
  ];

  index.domainBlockDomains.forEach((domain, position) => {
    const comma = position + 1 < index.domainBlockDomains.length ? ',' : '';
    lines.push(`${JSON.stringify(domain)}${comma}`);
  });
  lines.push('  ],', '  "otherRuleKeys": [');
  index.otherRuleKeys.forEach((key, position) => {
    const comma = position + 1 < index.otherRuleKeys.length ? ',' : '';
    lines.push(`${JSON.stringify(key)}${comma}`);
  });
  lines.push('  ]', '}', '');
  return lines.join('\n');
}

function writeStaticDedupeIndex(options = {}) {
  const outputPath = options.outputPath || DEFAULT_OUTPUT_PATH;
  const index = options.index || generateStaticDedupeIndex(options);
  const serialized = serializeStaticDedupeIndex(index);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, serialized, 'utf8');
  return { index, outputPath, serialized };
}

function checkStaticDedupeIndexFreshness(options = {}) {
  const outputPath = options.outputPath || DEFAULT_OUTPUT_PATH;
  const expectedIndex = options.index || generateStaticDedupeIndex(options);
  const expected = serializeStaticDedupeIndex(expectedIndex);
  let actual = null;

  try {
    actual = fs.readFileSync(outputPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return {
    fresh: actual === expected,
    expectedIndex,
    expected,
    actual,
    outputPath
  };
}

function isStaticDedupeIndexFresh(options = {}) {
  return checkStaticDedupeIndexFreshness(options).fresh;
}

function printSummary(index, outputPath) {
  console.log(`Static dedupe index written to ${path.relative(REPO_ROOT, outputPath)}`);
  console.log(`Source rules: ${index.metadata.sourceRuleCount} across ${index.metadata.sourceResourceCount} resources`);
  console.log(`Indexed rules: ${index.metadata.indexedRuleCount}`);
  console.log(`Unique keys: ${index.metadata.uniqueKeyCount}`);
  console.log(`Compact domains: ${index.metadata.domainBlockDomainCount}`);
  console.log(`Other rule keys: ${index.metadata.otherRuleKeyCount}`);
  console.log(`Source digest: ${index.metadata.sourceDigest}`);
}

if (require.main === module) {
  const result = writeStaticDedupeIndex();
  printSummary(result.index, result.outputPath);
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_MANIFEST_PATH,
  DEFAULT_OUTPUT_PATH,
  sortedArray,
  networkRuleDedupeShape,
  networkRuleDedupeKey,
  isIndexedStaticRule,
  canonicalDomainBlockDomain,
  classifyStaticRule,
  computeSourceDigest,
  buildStaticDedupeIndexFromRules,
  buildStaticDedupeIndexFromResources,
  readManifestRuleResources,
  generateStaticDedupeIndex,
  serializeStaticDedupeIndex,
  writeStaticDedupeIndex,
  checkStaticDedupeIndexFreshness,
  isStaticDedupeIndexFresh
};
