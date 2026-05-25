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

The CI-equivalent local command is:

```powershell
npm.cmd run test:ci
```

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

`CHROME_FOR_TESTING_PATH` is checked before `CHROME_PATH`.

The E2E suite checks that:

- The unpacked extension loads.
- The MV3 service worker starts.
- The popup opens.
- The settings page opens.
- Static DNR rulesets are enabled.
- Dynamic DNR rules are installed.
- Real DNR match outcomes block/allow deterministic URLs.
- Service-worker restart preserves core handlers and DNR state.
- Zapper hide-once, persistent rules, delete/disable, and dangerous target guards work in Chrome.
- `chrome.userScripts` availability is reported with a diagnostic.

## Headed Mode

The E2E runner uses headless mode by default. To force headed mode:

```powershell
$env:CHROMA_E2E_HEADLESS='0'
$env:CHROME_FOR_TESTING_PATH='C:\Path\To\chrome.exe'
npm.cmd run test:e2e
```

## Clearing Environment Variables

In the same PowerShell window:

```powershell
Remove-Item Env:\CHROME_FOR_TESTING_PATH -ErrorAction SilentlyContinue
Remove-Item Env:\CHROME_PATH -ErrorAction SilentlyContinue
Remove-Item Env:\CHROMA_E2E_HEADLESS -ErrorAction SilentlyContinue
```

## If E2E Fails With Official Chrome

If the selected browser is:

```text
C:\Program Files\Google\Chrome\Application\chrome.exe
```

the E2E runner will fail fast and ask for Chrome for Testing or Chromium. This is expected for modern official Chrome builds.

Install Chrome for Testing with:

```powershell
npx @puppeteer/browsers install chrome@stable
```

Then set `CHROME_FOR_TESTING_PATH` to the downloaded `chrome.exe`.

---

Next: [Distribution Notes](DISTRIBUTION.md)
