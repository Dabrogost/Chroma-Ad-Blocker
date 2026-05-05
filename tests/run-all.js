const fs = require('fs');
const path = require('path');

const testDir = __dirname;

const TIERS = {
  quick: [
    'background.test.js',
    'content.test.js',
    'interceptor.test.js',
    'message-types.test.js',
    'popup.test.js',
    'prm_handler.test.js',
    'proxy.test.js',
    'scriptlets.test.js',
    'settings.test.js',
    'subscriptions.manager.test.js',
    'yt_handler.test.js',
    'zapper.test.js'
  ],
  security: [
    'dnr-id-ranges.test.js',
    'interceptor.test.js',
    'message-types.test.js',
    'proxy.test.js',
    'scriptlets.test.js',
    'security_hardening.test.js',
    'settings.test.js',
    'zapper.test.js'
  ],
  policy: [
    'ci-workflow.test.js',
    'dnr-rulesets.test.js',
    'package-extension.test.js',
    'rules_recipes.test.js',
    'subscriptions.budget.test.js'
  ]
};

const allFiles = fs.readdirSync(testDir)
  .filter(file => file.endsWith('.test.js'))
  .sort();

function usage() {
  return [
    'Usage: node tests/run-all.js [--tier=all|quick|security|policy] [file-or-substring...]',
    '',
    'Tiers:',
    '  all       Run every Node test file (default).',
    '  quick     Fast feature tests; skips static policy/ruleset scans.',
    '  security  Security and hardening boundaries.',
    '  policy    Manifest, packaging, ruleset, and budget policy checks.',
    '',
    'Filters may be full filenames or substrings, e.g. `popup` or `proxy.test.js`.'
  ].join('\n');
}

function parseArgs(argv) {
  let tier = 'all';
  const filters = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg.startsWith('--tier=')) {
      tier = arg.slice('--tier='.length);
      continue;
    }
    filters.push(arg);
  }
  if (tier !== 'all' && !TIERS[tier]) {
    console.error(`Unknown test tier: ${tier}\n`);
    console.error(usage());
    process.exit(1);
  }
  return { tier, filters };
}

function selectFiles({ tier, filters }) {
  const tierFiles = tier === 'all' ? allFiles : TIERS[tier].slice().sort();
  const selected = filters.length === 0
    ? tierFiles
    : tierFiles.filter(file => filters.some(filter => file === filter || file.includes(filter)));

  const missing = selected.filter(file => !allFiles.includes(file));
  if (missing.length > 0) {
    console.error(`Tier ${tier} references missing test files: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (selected.length === 0) {
    console.error(`No test files matched ${filters.join(', ') || `tier ${tier}`}.`);
    process.exit(1);
  }
  return selected;
}

const files = selectFiles(parseArgs(process.argv.slice(2)));

for (const file of files) {
  require(path.join(testDir, file));
}
