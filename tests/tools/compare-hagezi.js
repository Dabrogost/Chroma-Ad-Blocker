const fs   = require('fs');
const path = require('path');
const https = require('https');

const HAGEZI_PRO_MINI = 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.mini.txt';

const RULES_DIR = path.join(__dirname, '..', '..', 'extension', 'rules');
const RULE_FILES = fs.readdirSync(RULES_DIR).filter(f => f.endsWith('.json'));

// ─── FETCH ─────
function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ─── PARSE HAGEZI ─────
// Extracts ||domain^ patterns from ABP-format list.
// Skips comments, exceptions (@@), cosmetic rules (##), and options ($).
function parseHagezi(text) {
  const patterns = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('!') || line.startsWith('[')) continue;
    if (line.startsWith('@@')) continue;
    if (line.includes('##') || line.includes('#@#')) continue;
    if (line.includes('$')) continue; // skip rules with options for this comparison
    patterns.add(line);
  }
  return patterns;
}

// ─── LOAD STATIC FILTERS ─────
function loadStaticFilters() {
  const set = new Set();
  let total = 0;
  for (const file of RULE_FILES) {
    const rules = JSON.parse(fs.readFileSync(path.join(RULES_DIR, file), 'utf8'));
    total += rules.length;
    for (const rule of rules) {
      if (rule.condition && rule.condition.urlFilter) {
        set.add(rule.condition.urlFilter);
      }
    }
  }
  return { set, total };
}

// ─── MAIN ─────
(async () => {
  console.log('Fetching Hagezi Pro Mini...');
  const text = await fetch(HAGEZI_PRO_MINI);
  const hageziPatterns = parseHagezi(text);

  console.log('Loading static rules...\n');
  const { set: staticFilters, total: staticTotal } = loadStaticFilters();

  let overlap = 0;
  let unique  = 0;
  const uniqueRules = [];

  for (const pattern of hageziPatterns) {
    if (staticFilters.has(pattern)) {
      overlap++;
    } else {
      unique++;
      uniqueRules.push(pattern);
    }
  }

  const overlapPct = ((overlap / hageziPatterns.size) * 100).toFixed(1);
  const uniquePct  = ((unique  / hageziPatterns.size) * 100).toFixed(1);

  console.log('─── Hagezi Pro Mini vs Static Ruleset ───────────────────');
  console.log(`Static rule files loaded : ${RULE_FILES.length} files, ${staticTotal.toLocaleString()} rules`);
  console.log(`Hagezi Pro Mini rules    : ${hageziPatterns.size.toLocaleString()}`);
  console.log(`Already in static rules  : ${overlap.toLocaleString()} (${overlapPct}%)`);
  console.log(`Net new coverage         : ${unique.toLocaleString()} (${uniquePct}%)`);
  console.log(`Dynamic budget needed    : ~${Math.min(unique, 25000).toLocaleString()} slots`);
  console.log('─────────────────────────────────────────────────────────');

  // Optionally write unique rules to a file for inspection
  const outPath = path.join(__dirname, 'hagezi-unique.txt');
  fs.writeFileSync(outPath, uniqueRules.join('\n'), 'utf8');
  console.log(`\nUnique rules written to: tests/tools/hagezi-unique.txt`);
})();
