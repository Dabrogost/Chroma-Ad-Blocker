const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { domainToASCII } = require('url');

const repoRoot = path.join(__dirname, '..');
const extensionRoot = path.join(repoRoot, 'extension');
const rulesDir = path.join(extensionRoot, 'rules');
const manifestPath = path.join(extensionRoot, 'manifest.json');

const SOURCE_NAME = 'OISD';
const SMALL_SOURCE_URL = 'https://small.oisd.nl/';
const BIG_SOURCE_URL = 'https://big.oisd.nl/';
const OUTPUT_PREFIX = 'rules_oisd';
const RULESET_ID_PREFIX = 'oisd_rules';
const RULES_PER_FILE = 30000;
const ID_START = 1;
const MAX_TOTAL_STATIC_RULES = 300000;

// Pre-OISD generated shard IDs. The updater recognizes them only so the first
// OISD refresh can replace the old generated corpus cleanly.
const LEGACY_GENERATED_RULESET_IDS = new Set([
  'yt_original_rules',
  'yt_ad_rules_part1',
  'yt_ad_rules_part2',
  'yt_ad_rules_part3',
  'yt_ad_rules_part4',
  'yt_ad_rules_part5',
  'yt_ad_rules_part6',
  'yt_ad_rules_part7',
  'yt_ad_rules_part8',
  'yt_ad_rules_part9'
]);

const PROTECTED_RULE_FILES = new Set([
  'rules_custom.json',
  'rules_recipes.json'
]);

function hasFlag(name) {
  return process.argv.includes(name);
}

function numberArg(name, fallback) {
  const arg = process.argv.find(item => item.startsWith(`${name}=`));
  if (!arg) return fallback;
  const value = Number(arg.slice(name.length + 1));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function stringArg(name, fallback) {
  const arg = process.argv.find(item => item.startsWith(`${name}=`));
  return arg ? arg.slice(name.length + 1) : fallback;
}

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http:') ? http : https;
    const req = client.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 5) {
          reject(new Error(`Too many redirects fetching ${url}`));
          return;
        }
        resolve(fetchText(new URL(res.headers.location, url).toString(), redirects + 1));
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.setTimeout(60000, () => {
      req.destroy(new Error(`Timed out fetching ${url}`));
    });
    req.on('error', reject);
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeHostname(raw) {
  let value = String(raw || '').trim().toLowerCase();
  if (!value || value === 'localhost') return null;

  value = value.replace(/^\|\|/, '');
  value = value.replace(/\^.*$/, '');
  value = value.replace(/^\*\./, '');
  value = value.replace(/^\.+|\.+$/g, '');

  if (!value || value.includes('/') || value.includes(':') || value.includes('*')) return null;
  if (value.includes('|') || value.includes('$') || value.includes('~')) return null;

  const ascii = domainToASCII(value);
  if (!ascii || ascii.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(ascii)) return null;
  if (ascii.startsWith('.') || ascii.endsWith('.')) return null;
  if (!ascii.includes('.')) return null;
  if (ascii.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
    return null;
  }

  return ascii;
}

function domainFromLine(line) {
  let value = line.trim();
  if (!value || value.startsWith('!') || value.startsWith('#') || value.startsWith('[')) return null;
  if (value.startsWith('@@')) return null;
  if (value.includes('##') || value.includes('#@#') || value.includes('#?#')) return null;

  value = value.replace(/\s+!.*$/, '').replace(/\s+#.*$/, '').trim();

  const hostsMatch = value.match(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1)\s+(.+)$/);
  if (hostsMatch) return normalizeHostname(hostsMatch[1]);

  if (value.startsWith('||')) {
    return normalizeHostname(value.slice(2).split('$')[0]);
  }

  if (/^[a-z0-9*.-]+$/i.test(value)) {
    return normalizeHostname(value);
  }

  return null;
}

function parseOisd(text) {
  const seen = new Set();
  const domains = [];
  let skipped = 0;

  for (const line of text.split(/\r?\n/)) {
    const domain = domainFromLine(line);
    if (!domain) {
      if (line.trim() && !line.trim().startsWith('!') && !line.trim().startsWith('[')) skipped++;
      continue;
    }
    if (!seen.has(domain)) {
      seen.add(domain);
      domains.push(domain);
    }
  }

  return { domains, skipped };
}

function listManifestResources() {
  const manifest = readJson(manifestPath);
  const resources = manifest.declarative_net_request?.rule_resources;
  if (!Array.isArray(resources)) {
    throw new Error('extension/manifest.json is missing declarative_net_request.rule_resources');
  }
  return { manifest, resources };
}

function isGeneratedResource(resource) {
  const id = resource.id || '';
  const fileName = resource.path ? path.basename(resource.path) : '';
  if (PROTECTED_RULE_FILES.has(fileName)) return false;
  if (id.startsWith(`${RULESET_ID_PREFIX}_`)) return true;
  if (LEGACY_GENERATED_RULESET_IDS.has(id)) return true;
  if (fileName === 'rules.json') return true;
  if (/^rules_\d+\.json$/.test(fileName)) return true;
  if (/^rules_oisd_\d+\.json$/.test(fileName)) return true;
  return false;
}

function currentStaticState(resources) {
  const protectedFilters = new Set();
  const reservedIds = new Set();
  let protectedRuleCount = 0;
  const replacedResources = [];

  for (const resource of resources) {
    if (!resource.path) continue;

    const fileName = path.basename(resource.path);
    const isProtected = PROTECTED_RULE_FILES.has(fileName);

    if (!isProtected && isGeneratedResource(resource)) {
      replacedResources.push(resource);
      continue;
    }

    if (!isProtected) {
      throw new Error(`Refusing to guess ownership of static ruleset "${resource.id}" (${resource.path}). Add it to PROTECTED_RULE_FILES or LEGACY_GENERATED_RULESET_IDS.`);
    }

    const rules = readJson(path.join(extensionRoot, resource.path));
    protectedRuleCount += rules.length;
    for (const rule of rules) {
      if (Number.isInteger(rule.id)) reservedIds.add(rule.id);
      const urlFilter = rule.condition?.urlFilter;
      if (!urlFilter) continue;

      protectedFilters.add(urlFilter);
    }
  }

  return {
    protectedFilters,
    protectedRuleCount,
    replacedResources,
    reservedIds
  };
}

function toRules(urlFilters, startId, reservedIds) {
  const rules = [];
  let nextId = startId;

  for (const urlFilter of urlFilters) {
    while (reservedIds.has(nextId)) nextId++;
    rules.push({
      id: nextId,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter }
    });
    nextId++;
  }

  return rules;
}

function chunkRules(rules) {
  const chunks = [];
  for (let i = 0; i < rules.length; i += RULES_PER_FILE) {
    chunks.push(rules.slice(i, i + RULES_PER_FILE));
  }
  return chunks;
}

function outputName(index) {
  return `${OUTPUT_PREFIX}_${index + 1}.json`;
}

function rulesetId(index) {
  return `${RULESET_ID_PREFIX}_${index + 1}`;
}

function collectGeneratedFiles(replacedResources) {
  const files = new Set();

  for (const file of fs.readdirSync(rulesDir)) {
    if (
      file === 'rules.json' ||
      /^rules_\d+\.json$/.test(file) ||
      /^rules_oisd_\d+\.json$/.test(file)
    ) {
      files.add(file);
    }
  }

  for (const resource of replacedResources) {
    if (resource.path && resource.path.startsWith('rules/')) {
      files.add(path.basename(resource.path));
    }
  }

  return files;
}

function removeObsoleteGeneratedFiles(replacedResources, outputFiles) {
  for (const file of collectGeneratedFiles(replacedResources)) {
    if (outputFiles.has(file)) continue;
    const fullPath = path.join(rulesDir, file);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  }
}

function writeManifest(manifest, resources, chunks) {
  const generatedResources = chunks.map((_, index) => ({
    id: rulesetId(index),
    enabled: true,
    path: `rules/${outputName(index)}`
  }));

  const protectedResources = resources.filter(resource => {
    const fileName = resource.path ? path.basename(resource.path) : '';
    return PROTECTED_RULE_FILES.has(fileName);
  });

  manifest.declarative_net_request.rule_resources = [
    ...generatedResources,
    ...protectedResources
  ];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function main() {
  const dryRun = hasFlag('--dry-run');
  const failOverLimit = hasFlag('--fail-over-limit');
  const maxTotalRules = numberArg('--max-total-rules', MAX_TOTAL_STATIC_RULES);
  const startId = numberArg('--start-id', ID_START);
  const sourceUrlOverride = stringArg('--source-url', null);

  const { manifest, resources } = listManifestResources();
  const {
    protectedFilters,
    protectedRuleCount,
    replacedResources,
    reservedIds
  } = currentStaticState(resources);

  const sourceResults = [];
  if (sourceUrlOverride) {
    console.log(`Fetching ${SOURCE_NAME} from override source...`);
    console.log(sourceUrlOverride);
    const text = await fetchText(sourceUrlOverride);
    sourceResults.push({
      label: 'override',
      url: sourceUrlOverride,
      ...parseOisd(text)
    });
  } else {
    for (const source of [
      { label: 'small', url: SMALL_SOURCE_URL },
      { label: 'big', url: BIG_SOURCE_URL }
    ]) {
      console.log(`Fetching ${SOURCE_NAME} ${source.label}...`);
      console.log(source.url);
      const text = await fetchText(source.url);
      sourceResults.push({
        ...source,
        ...parseOisd(text)
      });
    }
  }

  const domains = [];
  const seenDomains = new Set();
  const sourceByDomain = new Map();
  let skipped = 0;
  for (const result of sourceResults) {
    skipped += result.skipped;
    for (const domain of result.domains) {
      if (seenDomains.has(domain)) continue;
      seenDomains.add(domain);
      sourceByDomain.set(domain, result.label);
      domains.push(domain);
    }
  }

  let protectedOverlap = 0;
  const generatedFilters = [];
  const generatedDomains = [];
  const generatedBySource = new Map();

  for (const domain of domains) {
    const urlFilter = `||${domain}^`;
    if (protectedFilters.has(urlFilter)) {
      protectedOverlap++;
      continue;
    }
    generatedFilters.push(urlFilter);
    generatedDomains.push(domain);
    const source = sourceByDomain.get(domain) || 'unknown';
    generatedBySource.set(source, (generatedBySource.get(source) || 0) + 1);
  }

  const availableSlots = maxTotalRules - protectedRuleCount;
  if (availableSlots < 0) {
    throw new Error(`Protected static rules already exceed cap: ${protectedRuleCount}/${maxTotalRules}`);
  }

  if (failOverLimit && generatedFilters.length > availableSlots) {
    throw new Error(`${SOURCE_NAME} needs ${generatedFilters.length} generated slots but only ${availableSlots} are available after protected rules.`);
  }

  const selectedFilters = generatedFilters.slice(0, availableSlots);
  const selectedDomains = generatedDomains.slice(0, availableSlots);
  const omittedForCap = generatedFilters.length - selectedFilters.length;
  const selectedBySource = new Map();
  for (const domain of selectedDomains) {
    const source = sourceByDomain.get(domain) || 'unknown';
    selectedBySource.set(source, (selectedBySource.get(source) || 0) + 1);
  }
  const rules = toRules(selectedFilters, startId, reservedIds);
  const chunks = chunkRules(rules);

  for (const result of sourceResults) {
    console.log(`Parsed ${SOURCE_NAME} ${result.label}: ${result.domains.length} unique domains`);
  }
  console.log(`Parsed combined unique domains: ${domains.length}`);
  console.log(`Skipped unsupported non-domain lines: ${skipped}`);
  console.log(`Already covered by protected custom rules: ${protectedOverlap}`);
  console.log(`Generated ${SOURCE_NAME} rules wanted: ${generatedFilters.length}`);
  console.log(`Generated ${SOURCE_NAME} rules selected: ${rules.length}`);
  console.log(`Omitted by ${maxTotalRules} static-rule cap: ${omittedForCap}`);
  for (const [source, wanted] of [...generatedBySource.entries()].sort()) {
    const selected = selectedBySource.get(source) || 0;
    console.log(`- ${source} tier selected: ${selected}/${wanted}`);
  }
  console.log(`Protected static rules retained: ${protectedRuleCount}`);
  console.log(`Projected static total: ${protectedRuleCount + rules.length}`);
  console.log(`Replacing generated rulesets: ${replacedResources.length}`);
  replacedResources.forEach(resource => console.log(`- ${resource.id}: ${resource.path}`));
  console.log(`Generated files: ${chunks.length}`);
  chunks.forEach((chunk, index) => {
    const first = chunk[0]?.id;
    const last = chunk[chunk.length - 1]?.id;
    console.log(`- ${outputName(index)}: ${chunk.length} rules, IDs ${first}-${last}`);
  });

  if (dryRun) {
    console.log('\nDry run only. No files changed.');
    return;
  }

  const outputFiles = new Set(chunks.map((_, index) => outputName(index)));
  chunks.forEach((chunk, index) => {
    fs.writeFileSync(
      path.join(rulesDir, outputName(index)),
      `${JSON.stringify(chunk, null, 2)}\n`,
      'utf8'
    );
  });
  writeManifest(manifest, resources, chunks);
  removeObsoleteGeneratedFiles(replacedResources, outputFiles);

  console.log(`\n${SOURCE_NAME} static rules updated.`);
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
