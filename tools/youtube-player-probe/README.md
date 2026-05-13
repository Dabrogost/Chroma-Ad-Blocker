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

Run a probe-only stripper simulation without loading the extension:

```powershell
npm.cmd run probe -- --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --headed --probe-strip-mode delete --output reports\probe-strip-delete.json --no-path-types
```

Available simulation modes:

- `delete`: delete Chroma's regular player ad fields.
- `empty`: replace regular player ad fields with empty arrays or objects.
- `keep-heartbeat`: delete regular player ad fields except `adBreakHeartbeatParams`.
- `empty-keep-heartbeat`: empty regular player ad fields except `adBreakHeartbeatParams`.

Do not combine `--probe-strip-mode` with `--extension`; the simulator is for testing stripping strategies before changing the extension.

Run a probe-only visible-ad accelerator without stripping:

```powershell
npm.cmd run probe -- --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --headed --probe-accelerate-ads --output reports\probe-accelerate.json --no-path-types
```

This mutes and speeds visible ad playback in the page so YouTube's own ad state machine can complete. It is useful for comparing against the stripped-player dead zone.

Experiment with a content re-resolve during the stripped-player dead zone:

```powershell
npm.cmd run probe -- --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --headed --extension --try-content-reresolve --output reports\reresolve.json --no-path-types
```

This waits for the narrow state where Chroma has removed visible ad state but the player is stuck in `buffering-mode unstarted-mode` with a media URL present and `readyState === 0`. The default method is `cue-play`, which calls YouTube's player API to cue the current video ID and then play it. Other probe-only methods:

```powershell
npm.cmd run probe -- --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --headed --extension --try-content-reresolve --reresolve-method load
npm.cmd run probe -- --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --headed --extension --try-content-reresolve --reresolve-method play-video
npm.cmd run probe -- --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --headed --extension --try-content-reresolve --reresolve-method video-play
```

Run through a proxy:

```powershell
npm.cmd run probe -- --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --proxy "http://127.0.0.1:8080"
```

Use a persistent profile:

```powershell
npm.cmd run probe -- --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --profile ".profiles\local-youtube"
```

Load the unpacked Chroma extension while probing:

```powershell
npm.cmd run probe -- --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --headed --extension
```

Extension mode uses Chrome for Testing or Chromium, forces a headed browser so you can watch the player, and creates a persistent `.profiles\chroma-extension` profile by default. To use a different profile:

```powershell
npm.cmd run probe -- --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --headed --extension --profile ".profiles\chroma-extension-debug"
```

Official branded Google Chrome may refuse automated unpacked extension loading. That is expected; use Chrome for Testing or Chromium for this mode.

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
