const fs = require('fs');
const path = require('path');
const https = require('https');

const HAGEZI_PRO_MINI = 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.mini.txt';

const extensionDir = path.join(__dirname, '..', '..', 'extension');
const manifestPath = path.join(extensionDir, 'manifest.json');

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseHagezi(text) {
  const patterns = new Set();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('!') || line.startsWith('[')) continue;
    if (line.startsWith('@@')) continue;
    if (line.includes('##') || line.includes('#@#')) continue;
    if (line.includes('$')) continue;
    if (!line.startsWith('||') || !line.endsWith('^')) continue;
    patterns.add(line);
  }

  return patterns;
}

function loadStaticFilters() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const resources = manifest.declarative_net_request?.rule_resources || [];
  const set = new Set();
  let total = 0;

  for (const resource of resources) {
    const rules = JSON.parse(fs.readFileSync(path.join(extensionDir, resource.path), 'utf8'));
    total += rules.length;
    for (const rule of rules) {
      const urlFilter = rule.condition?.urlFilter;
      if (urlFilter) set.add(urlFilter);
    }
  }

  return { set, total, fileCount: resources.length };
}

async function main() {
  console.log('Fetching Hagezi Pro Mini...');
  const text = await fetchText(HAGEZI_PRO_MINI);
  const hageziPatterns = parseHagezi(text);

  console.log('Loading manifest-declared static rules...\n');
  const { set: staticFilters, total: staticTotal, fileCount } = loadStaticFilters();

  let overlap = 0;
  const uniqueRules = [];

  for (const pattern of hageziPatterns) {
    if (staticFilters.has(pattern)) {
      overlap++;
    } else {
      uniqueRules.push(pattern);
    }
  }

  const unique = uniqueRules.length;
  const overlapPct = ((overlap / hageziPatterns.size) * 100).toFixed(1);
  const uniquePct = ((unique / hageziPatterns.size) * 100).toFixed(1);

  console.log('Hagezi Pro Mini vs Static Ruleset');
  console.log(`Static rule files loaded : ${fileCount} files, ${staticTotal.toLocaleString()} rules`);
  console.log(`Hagezi Pro Mini rules    : ${hageziPatterns.size.toLocaleString()}`);
  console.log(`Already in static rules  : ${overlap.toLocaleString()} (${overlapPct}%)`);
  console.log(`Net new coverage         : ${unique.toLocaleString()} (${uniquePct}%)`);
  console.log(`Dynamic budget needed    : ~${Math.min(unique, 25000).toLocaleString()} slots`);

  if (process.argv.includes('--write-unique')) {
    const outPath = path.join(__dirname, 'hagezi-unique.txt');
    fs.writeFileSync(outPath, `${uniqueRules.join('\n')}\n`, 'utf8');
    console.log(`\nUnique rules written to: tests/tools/hagezi-unique.txt`);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
