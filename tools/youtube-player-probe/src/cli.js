'use strict';

const path = require('node:path');
const { parseArgs, boolArg, intArg } = require('./args');
const { runProbe } = require('./probe');
const { runDiff } = require('./diff');

function printHelp() {
  console.log(`YouTube Player Probe

Usage:
  npm.cmd run probe -- --url <youtube-url>
  npm.cmd run probe -- --urls urls.sample.json
  npm.cmd run diff -- --base reports/baseline.json --next reports/latest.json

Probe options:
  --url <url>                 Probe one URL.
  --urls <file>               Probe URLs from a JSON file with { "urls": [] }.
  --output <file>             Write report path. Defaults to reports/youtube-probe-*.json.
  --headed                    Run headed instead of headless.
  --proxy <server>            Playwright proxy server, e.g. http://127.0.0.1:8080.
  --profile <dir>             Persistent browser profile directory.
  --browser <path>            Browser executable. Defaults to CHROME_FOR_TESTING_PATH, then CHROME_PATH.
  --click-play                Try to start playback after navigation. Default: on.
  --no-click-play             Do not click the player before observing.
  --preplay-reload            Navigate, play, reload, then collect. Default: on.
  --no-preplay-reload         Collect from the first navigation instead.
  --pre-reload-settle-ms <ms> Time to wait after warmup playback before reload. Default: 1500.
  --settle-ms <ms>            Time to observe after DOMContentLoaded. Default: 8000.
  --play-timeout-ms <ms>      Timeout for locating the player before clicking. Default: 5000.
  --navigation-timeout-ms <ms> Navigation timeout. Default: 30000.
  --max-depth <n>             JSON path walk depth. Default: 12.
  --max-paths <n>             JSON path cap per response. Default: 5000.
  --no-path-types             Omit full path/type maps for smaller reports.
`);
}

async function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  const cwd = process.cwd();

  if (!command || command === 'help' || args.help) {
    printHelp();
    return;
  }

  if (command === 'probe') {
    const result = await runProbe({
      cwd,
      url: args.url,
      urlsFile: args.urls,
      output: args.output,
      headless: !boolArg(args.headed, false),
      proxy: args.proxy,
      profileDir: args.profile ? path.resolve(cwd, args.profile) : null,
      executablePath: args.browser || null,
      clickPlay: args['no-click-play'] ? false : boolArg(args['click-play'], true),
      preplayReload: args['no-preplay-reload'] ? false : boolArg(args['preplay-reload'], true),
      preReloadSettleMs: intArg(args['pre-reload-settle-ms'], 1500),
      settleMs: intArg(args['settle-ms'], 8000),
      playTimeoutMs: intArg(args['play-timeout-ms'], 5000),
      navigationTimeoutMs: intArg(args['navigation-timeout-ms'], 30000),
      maxDepth: intArg(args['max-depth'], 12),
      maxPaths: intArg(args['max-paths'], 5000),
      includePathTypes: args['no-path-types'] ? false : true
    });

    console.log(`Report written: ${result.outputPath}`);
    for (const page of result.report.pages) {
      const endpoints = page.network.map((entry) => entry.endpoint).join(', ') || 'none';
      const firstPlaying = page.timing.navigationToFirstPlayingMs ?? 'n/a';
      const firstContent = page.timing.navigationToFirstContentPlayingMs ?? 'n/a';
      const adSignals = page.timing.domSignals.join(', ') || 'none';
      const knownFields = Object.entries(page.summary?.knownFieldsPresent || {})
        .filter(([, sources]) => sources.length > 0)
        .map(([field]) => field)
        .join(', ') || 'none';
      console.log(`- ${page.url}`);
      console.log(`  endpoints: ${endpoints}`);
      console.log(`  first playing: ${firstPlaying}ms`);
      console.log(`  first content playing: ${firstContent}ms`);
      console.log(`  known stripper fields: ${knownFields}`);
      console.log(`  DOM ad signals: ${adSignals}`);
    }
    return;
  }

  if (command === 'diff') {
    if (!args.base || !args.next) {
      throw new Error('Diff requires --base <file> and --next <file>.');
    }
    console.log(runDiff(args.base, args.next));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
