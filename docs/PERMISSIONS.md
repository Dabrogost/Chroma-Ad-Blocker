# Permissions

Chroma requests the following permissions. Each is tied to current, documented behavior, although this table does not claim that every future implementation would require the same permission set.

| Permission | Reason |
|---|---|
| `declarativeNetRequest` | Enables and manages the static and dynamic DNR rulesets that perform network-level ad and tracker blocking at the browser engine level. |
| `declarativeNetRequestFeedback` | Allows the service worker to read which DNR rules fired when Chrome exposes DNR feedback events to the unpacked extension. Chroma uses this for the local request log and network event classification; DNR matches are not blindly treated as blocked ads. |
| `storage` | Base API required to persist user configuration and subscription metadata across sessions. |
| `unlimitedStorage` | Chrome's default `chrome.storage.local` cap is 10 MB, which is insufficient for Chroma's runtime needs. Storage holds cached subscription rule sets, user configuration, statistics, health diagnostics, and a separate DNR request log. When Chrome exposes matched-rule feedback, that log can retain the newest 500 full matched URLs—including allow matches—in every statistics mode until browser-profile startup or a manual reset. Chroma does not transmit this local storage to a Chroma telemetry service. |
| `tabs` | Chroma currently uses tab queries and URL visibility for current-site whitelist controls and state rebroadcasts, and uses the Tabs API to open extension pages and reload a tab after whitelist changes. Chrome does not require the `tabs` permission for every Tabs API method, and Chroma already has broad web host access, so this permission remains appropriate to reevaluate for minimization rather than describe as universally required. |
| `alarms` | Powers periodic subscription refresh checks. Chrome MV3 service workers are ephemeral and cannot use `setInterval`; `chrome.alarms` is the reliable timer mechanism available. |
| `userScripts` | The primary API for the scriptlet engine. Allows bundled subscription scriptlets and explicit user-added scriptlet resources to execute in the page's MAIN world context with native lifecycle management. User-added resources are executable code and can read, modify, or transmit page-accessible data; add only code you trust. Chrome 138+ also requires users to enable **Allow User Scripts** on Chroma's extension details page. |
| `scripting` | Used for extension-controlled script work, including Element Zapper injection and optional Fingerprint Randomization content-script registration. |
| `proxy` | Enables the split-tunnel proxy router, Chrome ownership inspection, and PAC script generation for domain-specific routing while master protection is active. |
| `privacy` | Allows Chroma to apply optional WebRTC leak protection and Chrome Privacy Hardening while master protection is active, and to release Chroma-owned settings when inactive. |
| `contentSettings` | Allows Chroma to apply optional Geolocation Protection while master protection is active and clear Chroma's location rule when inactive. |
| `webRequest` | Observes genuine proxy authentication challenges so Chroma can compare them with the currently effective route. |
| `webRequestAuthProvider` | Provides credentials only to an exact active HTTP/HTTPS proxy route through the `onAuthRequired` listener. |
| Host permission: `<all_urls>` | Allows the always-on isolated content script, cosmetic filtering, DNR rules, subscription scriptlets, optional proxy/site controls, and configured remote list/resource fetches to operate across required origins. This broad scope is why Chroma keeps sensitive settings, stats, proxy credentials, and health diagnostics local and validates privileged messages at the extension boundary. |

Chroma does not request Chrome's `downloads` permission for guided updates. The updater uses the standard File System Access folder picker from the settings page after the user clicks **Choose Chroma Folder**, and it fetches verified release assets into memory rather than sending files through Chrome's Downloads shelf.

## Local Storage Access Boundary

Local storage is not the same as service-worker-only storage. Under Chrome's default `chrome.storage.local` access level, Chroma's extension pages, service worker, and isolated-world Chroma content scripts can access the storage area; Chroma does not currently narrow that access with `chrome.storage.local.setAccessLevel()`.

Ordinary host-page JavaScript and ordinary unrelated extensions cannot call Chroma's extension-specific storage API merely because an isolated content script is present. However, a vulnerability or unintended code path in a privileged Chroma content script could expose more stored state than that script normally needs, including request-log URLs or proxy records. A compromised browser profile, browser binary, operating system, or exceptional debugger-enabled environment capable of inspecting Chroma is outside this local-storage protection boundary.

## Why Broad Host Access Exists

Ad blocking, cosmetic filtering, subscription scriptlets, site whitelisting, and proxy routing all need to evaluate pages the user visits. Chroma uses broad host access so the protection stack can work across websites without needing per-site permission prompts for every domain.

The tradeoff is trust. Chroma addresses that by keeping sensitive state local, documenting permissions, validating privileged messages, and keeping release packages source-auditable.

Related docs:

- [Privacy Policy](PRIVACY_POLICY.md)

---

Next: [Statistics & Health](STATISTICS.md)
