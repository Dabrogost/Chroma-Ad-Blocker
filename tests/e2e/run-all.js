const path = require('node:path');
const test = require('node:test');
const { cleanupSharedExtensionBrowser } = require('./helpers/extension-fixture');

const FILES = {
  smoke: ['load-extension.e2e.js'],
  dnr: ['dnr-match.e2e.js'],
  sw: ['service-worker-restart.e2e.js'],
  zapper: ['zapper.e2e.js'],
  full: [
    'load-extension.e2e.js',
    'dnr-match.e2e.js',
    'zapper.e2e.js',
    'service-worker-restart.e2e.js'
  ]
};

function usage() {
  return [
    'Usage: node tests/e2e/run-all.js [--tier=smoke|dnr|sw|zapper|full]',
    '',
    'The full tier reuses a single temporary Chrome/Chromium profile to avoid',
    'reloading the extension once per E2E file. Individual file scripts still',
    'run in isolated browser profiles.'
  ].join('\n');
}

let tier = 'full';
for (const arg of process.argv.slice(2)) {
  if (arg === '--help' || arg === '-h') {
    console.log(usage());
    process.exit(0);
  }
  if (arg.startsWith('--tier=')) {
    tier = arg.slice('--tier='.length);
  }
}

if (!FILES[tier]) {
  console.error(`Unknown E2E tier: ${tier}\n`);
  console.error(usage());
  process.exit(1);
}

if (tier === 'full') {
  process.env.CHROMA_E2E_REUSE_BROWSER = '1';
  test.after(async () => {
    await cleanupSharedExtensionBrowser();
  });
}

for (const file of FILES[tier]) {
  require(path.join(__dirname, file));
}
