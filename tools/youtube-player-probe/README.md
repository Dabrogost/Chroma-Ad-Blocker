# YouTube Player Probe

Optional live diagnostic tooling for Chroma's YouTube stripper maintenance.

This tool opens real YouTube pages in Playwright and records a sanitized report about player API responses, ad-like JSON paths, DOM ad signals, and startup timing. It is intentionally separate from the extension runtime and the normal test suite.

## Boundaries

- Not part of `npm.cmd test`.
- Not intended for CI.
- Does not modify extension code.
- Does not save full YouTube payloads.
- Results are expected to vary by region, account, proxy, YouTube experiment bucket, and network conditions.

Generated reports and browser profiles are gitignored in this folder.

## Install

From this directory:

```powershell
npm.cmd install
```

Set Chrome for Testing with your local browser path:

```powershell
$env:CHROME_FOR_TESTING_PATH='C:\Path\To\chrome-for-testing\chrome.exe'
```

You can also pass a browser path directly:

```powershell
npm.cmd run probe -- --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --browser "C:\Path\To\chrome.exe"
```

## Probe

Run the sample URL set:

```powershell
npm.cmd run probe -- --urls urls.sample.json
```

Run one URL:

```powershell
npm.cmd run probe -- --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

Run headed:

```powershell
npm.cmd run probe -- --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --headed
```

By default, the probe uses the sequence that best matches regular player ad behavior: navigate, start playback, reload, then collect the report from the refreshed player state. Disable that when you want first-navigation behavior:

```powershell
npm.cmd run probe -- --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --no-preplay-reload
```

The collection phase also clicks the player so it can measure startup timing. Disable playback clicks when you only want page structure:

```powershell
npm.cmd run probe -- --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --no-click-play
```

For smaller reports that keep ad paths and timings but omit full path/type maps:

```powershell
npm.cmd run probe -- --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --no-path-types
```

Run through a proxy:

```powershell
npm.cmd run probe -- --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --proxy "http://127.0.0.1:8080"
```

Use a persistent profile:

```powershell
npm.cmd run probe -- --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --profile ".profiles\local-youtube"
```

## Diff Reports

```powershell
npm.cmd run diff -- --base reports\baseline.json --next reports\latest.json
```

The diff focuses on:

- new or missing high-value ad paths
- new or missing ad-like JSON paths
- new or missing known Chroma stripper paths
- new or missing DOM ad signals
- new or missing visible loading signals
- average `navigationToFirstPlayingMs`
- average `navigationToFirstContentPlayingMs`

## Report Contents

Reports include:

- run metadata
- compact run and page summaries
- warmup and collection snapshots when `--preplay-reload` is active
- requested page URLs
- observed YouTube endpoint summaries
- sanitized JSON path/type maps
- ad-like path lists
- known stripper field paths
- DOM ad/loading/error signal timeline
- player class state changes
- video lifecycle events
- startup timing summary
- playback attempt details

The report does not include raw response bodies. Keep any manually captured raw payloads outside git.
