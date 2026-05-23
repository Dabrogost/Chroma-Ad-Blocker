# Installation & Configuration

This guide covers installing Chroma, enabling required browser features, troubleshooting common issues, and understanding the main settings.

## Quick Start

1. Get the latest release from [GitHub Releases](https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/latest), and extract the ZIP file.
2. Open `chrome://extensions` in Chrome.
3. Toggle on **Developer Mode** in the top-right corner.
4. Click **Load unpacked** and select the extracted folder that contains `manifest.json`.
5. Enable User Scripts support:
   - **Chrome 138+**: On the Chroma extension card, click **Details**, then enable **Allow User Scripts**.
   - **Chrome 122-137**: The **Developer Mode** toggle from step 3 enables the `userScripts` API.
6. Chroma is active on all tabs. Pin it from the extensions menu to access the popup.

## Configuration

| Setting | Description | Default |
|---|---|---|
| `enabled` | Global switch for all features. | `true` |
| `networkBlocking` | Enables DNR ruleset blocking. | `true` |
| `trackingUrlCleanup` | Removes known tracking query parameters from top-level navigation URLs. | `true` |
| `deAmpLinks` | Redirects supported AMP viewer pages to publisher URLs. | `false` |
| `stripping` | Enables YouTube Ad Stripping, the primary blocker. | `true` |
| `acceleration` | Enables accelerated ad playback as a fallback. | `false` |
| `accelerationSpeed` | Playback rate multiplier for accelerated ads (`x4`, `x8`, `x12`, or `x16`). | `8` |
| `cosmetic` | Enables hiding ad placeholders through CSS. | `true` |
| `localCosmeticRules` | Stores locally created Element Zapper cosmetic rules. | `[]` |
| `hideShorts` | Removes Shorts component modules. | `false` |
| `hideMerch` | Removes Merchandise panels. | `true` |
| `hideOffers` | Removes Movie/TV offer modules. | `true` |
| `suppressWarnings` | Removes unsolicited overlay dialogs that restrict content access. | `true` |
| `whitelist` | Stores domains where Chroma blocking is disabled. The current-site popup toggle updates this list. | `[]` |
| `globalProxyEnabled` | Enables browser-level fallback routing through the selected proxy when no domain-specific proxy rule matches. | `false` |
| `globalProxyId` | Stores the selected global fallback proxy ID. | `null` |
| `chromeServiceProxyBypass` | Lets Chrome-owned browser services connect directly while Global Proxy Fallback is enabled. | `true` |
| `webRtcLeakProtection` | Controls Chrome's WebRTC IP handling policy: `off`, `auto`, `balanced`, or `strict`. | `auto` |
| `fingerprintRandomization` | Enables optional per-document canvas, audio, WebGL, navigator, and language API farbling with full-hostname domain separation. | `false` |
| `browserPrivacyHardening` | Applies Chrome privacy settings for third-party cookies, Do Not Track, and Privacy Sandbox ad APIs. | `false` |
| `geolocationProtection` | Blocks website access to real physical location through Chrome's native location content setting. | `false` |

## Troubleshooting Quick Reference

| Symptom | Check |
|---|---|
| Scriptlets or fingerprint randomization show unavailable in Health. | On Chrome 138+, open `chrome://extensions`, select Chroma **Details**, and enable **Allow User Scripts**. On Chrome 122-137, confirm **Developer Mode** is enabled. |
| Loaded-extension E2E tests fail with `--load-extension` errors. | Use Chrome for Testing or Chromium for automated extension tests. Modern official Google Chrome builds reject this automation path. |
| Authenticated SOCKS proxy credentials do not work. | Chromium extension proxy APIs do not expose SOCKS username/password auth to extensions. Use provider-side IP allowlisting or an HTTP/HTTPS proxy endpoint. |
| Subscription refresh fails. | Confirm the list URL is HTTPS, reachable, not credential-bearing, under the response-size limit, and returns filter-list text rather than an HTML error page. |
| A site fix requires extension changes. | Chroma checks GitHub releases and notifies you when an update is available. Install the reviewed release package for bundled rule and code updates. |
| Request Log is empty. | DNR debug match logging is only available in compatible debug/unpacked contexts. Blocking can still work normally when the request log is unavailable. |

## Health Panel

The settings page includes a **Health** panel for diagnostics. It shows whether each protection layer is active, disabled, degraded, unavailable, or in an error state.

It covers static DNR rulesets, dynamic rules, tracking URL cleanup, De-AMP redirects, subscriptions, cosmetic filtering, scriptlets, fingerprint randomization, browser privacy hardening, proxy routing, whitelists, and request-log/debug availability.

The panel is diagnostic-only. It reports counts and coarse status information, but does not expose proxy credentials, stored auth data, request URLs, raw filter rules, or request-log contents.

DNR match logging is shown separately because `chrome.declarativeNetRequest.onRuleMatchedDebug` is only available in debug/unpacked-style install contexts. When that logging is unavailable, blocking can still work normally.

For deeper local analytics behavior, see [Statistics & Health](STATISTICS.md).

