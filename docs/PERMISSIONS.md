# Permissions

Chroma requests the following permissions. Each is required for a specific, documented purpose.

| Permission | Reason |
|---|---|
| `declarativeNetRequest` | Enables and manages the static and dynamic DNR rulesets that perform network-level ad and tracker blocking at the browser engine level. |
| `declarativeNetRequestFeedback` | Allows the service worker to read which DNR rules fired when Chrome exposes DNR feedback events to the unpacked extension. Chroma uses this for the local request log and network event classification; DNR matches are not blindly treated as blocked ads. |
| `storage` | Base API required to persist user configuration and subscription metadata across sessions. |
| `unlimitedStorage` | Chrome's default `chrome.storage.local` cap is 10 MB, which is insufficient for Chroma's runtime needs. Storage holds cached subscription rule sets, blocking statistics, user configuration, and local diagnostics/debug data when enabled. Static rule deduplication is computed by the service worker at runtime rather than stored as user data. No storage is used to collect or transmit user data. |
| `tabs` | Required to read the active tab's URL for whitelist matching in the popup, open extension pages from UI controls, and reload the tab when the whitelist is toggled. |
| `alarms` | Powers periodic subscription refresh checks. Chrome MV3 service workers are ephemeral and cannot use `setInterval`; `chrome.alarms` is the reliable timer mechanism available. |
| `userScripts` | The primary API for the scriptlet engine. Allows bundled subscription scriptlets and explicit user-added scriptlet resources to execute in the page's MAIN world context with native lifecycle management. Chrome 138+ also requires users to enable **Allow User Scripts** on Chroma's extension details page. |
| `scripting` | Used for extension-controlled script work, including Element Zapper injection and optional Fingerprint Randomization content-script registration. |
| `proxy` | Enables the split-tunnel proxy router and PAC script generation for domain-specific routing. |
| `privacy` | Allows Chroma to apply optional browser-level privacy controls, including WebRTC leak protection and Chrome Privacy Hardening. |
| `contentSettings` | Allows Chroma to provide an optional Geolocation Protection toggle that blocks website location access through Chrome's native site setting. |
| `webRequest` | Used to intercept authentication challenges from proxy servers. |
| `webRequestAuthProvider` | Required to provide credentials to proxy servers through the `onAuthRequired` listener. |
| Host permission: `<all_urls>` | Allows the always-on isolated content script, cosmetic filtering, DNR rules, subscription scriptlets, and optional proxy/site controls to operate across visited websites. This broad scope is why Chroma keeps sensitive settings, stats, proxy credentials, and health diagnostics local and validates privileged messages at the extension boundary. |

Chroma does not request Chrome's `downloads` permission for guided updates. The updater uses the standard File System Access folder picker from the settings page after the user clicks **Choose Chroma Folder**, and it fetches verified release assets into memory rather than sending files through Chrome's Downloads shelf.

## Why Broad Host Access Exists

Ad blocking, cosmetic filtering, subscription scriptlets, site whitelisting, and proxy routing all need to evaluate pages the user visits. Chroma uses broad host access so the protection stack can work across websites without needing per-site permission prompts for every domain.

The tradeoff is trust. Chroma addresses that by keeping sensitive state local, documenting permissions, validating privileged messages, and keeping release packages source-auditable.

Related docs:

- [Privacy Policy](PRIVACY_POLICY.md)
- [Security Policy](SECURITY.md)
- [Architecture Deep Dive](ARCHITECTURE.md)

---

Next: [Statistics & Health](STATISTICS.md)
