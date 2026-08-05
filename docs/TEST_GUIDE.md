# Testing

This project has three practical test layers:

- Fast Node tests for parser, background, popup, subscription, DNR, proxy, scriptlet, and content-script logic.
- Policy checks for static rulesets, package contents, CI workflow coverage, and subscription budget behavior.
- Optional Chrome-loaded extension E2E smoke/full tests for real MV3 extension behavior.

## Unit And Integration Tests

Run from the repo root:

```powershell
npm.cmd test
```

`npm.cmd` is recommended on Windows because PowerShell may resolve `npm` to `npm.ps1`, which can be affected by execution policy or per-user npm shim issues.

Expected result:

```text
all tests passing
```

Useful smaller tiers:

```powershell
npm.cmd run test:quick
npm.cmd run test:security
npm.cmd run test:policy
```

`test:quick` skips the heavier static policy/ruleset scans for fast local iteration. `test:security` focuses on hardening boundaries. `test:policy` runs manifest, packaging, ruleset, and budget checks.

To run a single Node test file or substring:

```powershell
node tests/run-all.js popup
node tests/run-all.js --tier=security proxy
```

The Node, policy, ruleset, and package-check stage used by CI is:

```powershell
npm.cmd run test:ci
```

That command is not the whole CI job. Push and pull-request CI also installs dependencies with `npm ci`, selects Chrome for Testing, and runs `npm.cmd run test:e2e:smoke`. A manually dispatched workflow additionally runs the full browser E2E tier.

## Loaded Extension E2E

Modern official Google Chrome builds reject loading unpacked extensions through the `--load-extension` automation flag. Use Chrome for Testing or Chromium for E2E.

Set a browser binary path before running E2E:

```powershell
$env:CHROME_FOR_TESTING_PATH='C:\Path\To\chrome.exe'
npm.cmd run test:e2e
```

For the loaded-extension smoke tier only:

```powershell
$env:CHROME_FOR_TESTING_PATH='C:\Path\To\chrome.exe'
npm.cmd run test:e2e:smoke
```

The smoke tier runs `load-extension.e2e.js`: extension startup, popup/settings/offline-guide rendering, Health output, ruleset presence, and a deterministic YouTube MAIN-world fixture. The full tier also asks Chrome to evaluate deterministic DNR block/allow cases through `testMatchOutcome()`, exercises Element Zapper behavior, and checks extension-reload recovery.

Browser paths are checked in this order:

1. `CHROME_FOR_TESTING_PATH`
2. `CHROME_BIN`
3. `CHROME_PATH`
4. Known platform-specific installation paths

The full E2E suite checks that:

- The unpacked extension loads.
- The MV3 service worker starts.
- The popup opens.
- The settings page opens.
- The offline guide opens and its search works.
- Static DNR rulesets are enabled.
- Dynamic DNR rules are installed.
- Chrome's `testMatchOutcome()` reports the expected DNR block/allow results for deterministic hypothetical requests; this test does not issue those requests over the network.
- A full `chrome.runtime.reload()` preserves core message handling and DNR state after Chrome recreates the extension.
- Zapper hide-once, persistent rules, delete/disable, and dangerous target guards work in Chrome.
- The `chrome.userScripts` API's presence can be sampled before and after reload. This is an availability observation, not proof that every registered scriptlet executes correctly.

The reload test is deliberately stronger and broader than a worker restart, but it is not a deterministic simulation of ordinary MV3 service-worker eviction. Chrome does not expose a reliable extension-JavaScript command for suspending only its own worker.

## Headed Mode

The E2E runner uses headless mode by default. To use a native headed browser:

```powershell
$env:CHROMA_E2E_HEADLESS='0'
$env:CHROME_FOR_TESTING_PATH='C:\Path\To\chrome.exe'
npm.cmd run test:e2e
```

Headed mode currently adds `--window-position=-32000,-32000`, so the native window is intentionally placed off-screen. It is useful for testing non-headless behavior, not for watching the run interactively.

## Clearing Environment Variables

In the same PowerShell window:

```powershell
Remove-Item Env:\CHROME_FOR_TESTING_PATH -ErrorAction SilentlyContinue
Remove-Item Env:\CHROME_BIN -ErrorAction SilentlyContinue
Remove-Item Env:\CHROME_PATH -ErrorAction SilentlyContinue
Remove-Item Env:\CHROMA_E2E_HEADLESS -ErrorAction SilentlyContinue
```

## If E2E Fails With Official Chrome

If the selected browser is:

```text
C:\Program Files\Google\Chrome\Application\chrome.exe
```

the E2E runner will fail fast and ask for Chrome for Testing or Chromium. Modern official branded Chrome refusing automated `--load-extension` is a browser limitation, not an extension failure.

That browser limitation is not Windows-specific. The runner's explicit branded-Chrome guard currently recognizes the standard Windows Google Chrome path; an official Chrome binary at a custom path or on another operating system may instead launch and fail later because the extension was not loaded. Use Chrome for Testing or Chromium on every platform.

Install Chrome for Testing with:

```powershell
npx @puppeteer/browsers install chrome@stable
```

Then set `CHROME_FOR_TESTING_PATH` to the downloaded executable (`chrome.exe` on Windows).

---

Next: [Distribution Notes](DISTRIBUTION.md)
