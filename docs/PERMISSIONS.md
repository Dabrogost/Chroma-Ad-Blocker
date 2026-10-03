# Permissions

This is the permission inventory declared in Chroma's extension manifest. The [Privacy Policy](PRIVACY_POLICY.md) explains the data these features store and the external services they can contact.

| Permission | Reason |
|---|---|
| `declarativeNetRequest` | Enables and manages the static and dynamic DNR rulesets that perform network-level ad and tracker blocking at the browser engine level. |
| `declarativeNetRequestFeedback` | Allows the service worker to read which DNR rules fired when Chrome exposes DNR feedback events to the unpacked extension. Chroma uses this for the local request log and network event classification; DNR matches are not blindly treated as blocked ads. |
| `storage` | Base API required to persist user configuration and subscription metadata across sessions. |
| `unlimitedStorage` | Allows cached subscription rules, executable user resources, and other local data to exceed the default `chrome.storage.local` quota. See [local data storage](PRIVACY_POLICY.md#local-data-storage) for contents and retention. |
| `tabs` | Gives Chroma access to tab information for current-site controls and communicating settings changes to open tabs. |
| `alarms` | Schedules subscription refresh checks that can wake the extension's service worker. |
| `userScripts` | The primary API for the scriptlet engine. Allows bundled subscription scriptlets and explicit user-added scriptlet resources to execute in the page's MAIN world context with native lifecycle management. User-added resources are executable code and can read, modify, or transmit page-accessible data; add only code you trust. Chrome 138+ also requires users to enable **Allow User Scripts** on Chroma's extension details page. |
| `scripting` | Used for extension-controlled script work, including Element Zapper injection and optional Fingerprint Randomization content-script registration. |
| `proxy` | Enables the split-tunnel proxy router, Chrome ownership inspection, and PAC script generation for domain-specific routing while master protection is active. |
| `privacy` | Allows Chroma to apply optional WebRTC leak protection and Chrome Privacy Hardening while master protection is active, and to release Chroma-owned settings when inactive. |
| `contentSettings` | Allows Chroma to apply optional Geolocation Protection while master protection is active and clear Chroma's location rule when inactive. |
| `webRequest` | Observes genuine proxy authentication challenges so Chroma can compare them with the currently effective route. |
| `webRequestAuthProvider` | Provides credentials only to an exact active HTTP/HTTPS proxy route through the `onAuthRequired` listener. |
| Host permission: `<all_urls>` | Provides origin access for filtering, content scripts, site controls, and configured remote list/resource fetches across websites. Individual content-script declarations further limit which scripts run on particular sites. |

Chroma does not request Chrome's `downloads` permission for guided updates. The updater uses the standard File System Access folder picker from the settings page after the user clicks **Choose Chroma Folder**, and it fetches verified release assets into memory rather than sending files through Chrome's Downloads shelf.

## Local Storage Access Boundary

Chroma's isolated content scripts can access its local storage alongside the service worker and extension pages. Ordinary page scripts do not receive that access. See the [Privacy Policy's storage boundary](PRIVACY_POLICY.md#who-can-access-local-data) for the implications of a compromised content script or browser profile.

## Why Broad Host Access Exists

Ad blocking, cosmetic filtering, subscription scriptlets, site whitelisting, and proxy routing all need to evaluate pages the user visits. Chroma uses broad host access so the protection stack can work across websites without needing per-site permission prompts for every domain.

The tradeoff is trust. Chroma addresses that by keeping sensitive state local, documenting permissions, validating privileged messages, and keeping release packages source-auditable.

---

Next: [Privacy Policy](PRIVACY_POLICY.md)
