# Threat Model

This document describes Chroma's practical security boundaries. Chroma cannot make hostile pages, hostile platforms, remote lists, proxies, or user-provided code safe by itself. The goal is to show which risks Chroma reduces, which risks remain, and what the extension assumes about the browser environment.

## Assets And Boundaries

| Asset or boundary | Why it matters | Primary controls |
|---|---|---|
| Extension storage | Holds settings, whitelists, cached rules, proxy settings, local stats, request logs, and health diagnostics. | `chrome.storage.local`, sanitized diagnostics, local-only design. |
| Extension pages | Popup and settings pages can message the service worker and change privileged state. | Extension origin isolation, DOM-safe rendering, validated background messages. |
| Isolated-world content scripts | Handle cosmetic filtering and extension-to-page coordination without exposing extension state directly to page scripts. | Chrome isolated world, strict message routing, local configuration reads. |
| MAIN-world handlers | Needed for page API interception, platform-specific handlers, scriptlets, and optional fingerprint randomization. | Pristine API caching, closure-scoped state, nonce-based handshake, narrow registration. |
| DNR rules | Browser-enforced request policy for static, dynamic, subscription, cleanup, and whitelist rules. | Browser validation, static rulesets, dynamic ID ranges, budget allocation. |
| Remote subscriptions | Can change blocking, cosmetic behavior, and supported scriptlet activation after install. | HTTPS-only fetches, response-size limits, local parsing, unsupported-syntax drops, budget allocation. |
| User scriptlet resources | User-selected executable code that can run in the page MAIN world. | Explicit user opt-in, HTTPS-only URLs, separate resource lane, Chrome `userScripts` API, narrow rules. |
| Proxy routing | Routes selected browser traffic through user-configured proxy servers. | PAC generation, local credential handling, connection testing, user-controlled routes. |

## Adversaries

| Adversary | Capabilities | Chroma's intended response | Residual risk |
|---|---|---|---|
| Page-script adversary | Runs JavaScript on a page, mutates the DOM, monkey-patches page APIs, watches visible side effects, and tries to detect or interfere with content changes. | Uses isolated-world content scripts where possible. MAIN-world code caches pristine APIs early, keeps session state closure-scoped, and uses a short-lived nonce-based `MessageChannel` handshake. | A page can still observe DOM changes, infer that blocking occurred, change its own application behavior, or race extension hooks. Chroma does not promise stealth against every detection strategy. |
| Hostile media platform | Changes internal APIs, ad delivery, payload shape, UI rendering, or account-side policy. May use server-side ad insertion or terms enforcement. | Uses platform-specific cleanup, DNR rules, cosmetics, scriptlets, and optional proxy routing as separate layers so one layer can degrade without disabling all protection. | Platforms can break client-side handling, move ads server-side, block accounts, or make some behavior impossible to fix locally. Chroma does not guarantee access to any service or compliance with platform terms. |
| Malicious remote filter list | Publishes rules that overblock, allow unwanted requests, hide important UI, or trigger supported bundled scriptlets on chosen domains. | Treats list syntax as bounded configuration: HTTPS fetch, local parsing, size limits, DNR budgets, deduplication where applicable, unsupported-syntax drops, and shipped-only subscription scriptlets. | Enabled remote lists still affect browsing behavior. A malicious or compromised list can cause site breakage, privacy-relevant allow/block choices, or cosmetic hiding within the syntax Chroma supports. |
| Malicious custom subscription | Has the same rule-level influence as a remote filter list, but is selected by the user and may be less reviewed than default lists. | Applies the same constraints as other subscriptions after explicit user addition. | The user is trusting that list to influence network and page behavior. Chroma cannot verify the intent of a custom list. |
| Malicious user scriptlet resource | Provides executable JavaScript selected by the user and activated by matching user scriptlet rules. Can read and modify page DOM and page-visible JavaScript state on matched pages. | Keeps this feature separate from normal subscriptions. Requires the user to add the resource URL and matching rules. Runs through Chrome's `userScripts` API rather than extension-controlled `eval` or remote extension code. | This is a full trust boundary. User-provided scriptlets are not audited by Chroma and should be treated as code you chose to run on matched sites. They may affect page privacy, account sessions, or site integrity. |
| Compromised proxy | Observes or alters traffic routed through it, fails intermittently, or logs destinations and timing. | Chroma routes only user-configured proxy targets, can keep unmatched traffic direct, supports Global Fallback only when selected, and keeps proxy credentials local. | A proxy provider can see normal proxy metadata and plaintext HTTP content, and can disrupt or modify non-TLS traffic. HTTPS protects content only according to the browser's normal TLS trust model. Chroma cannot make an untrusted proxy trustworthy. |
| Extension-page XSS | Injects script into popup or settings pages and abuses privileged extension-page messaging. | Relies on Chrome extension-origin isolation, DOM-safe UI rendering, sanitized diagnostics, and validated background message paths. | Any real XSS in an extension page would be high impact. Treat extension UI rendering bugs as security issues and report them privately. |
| MV3 service-worker restart or failure | Browser stops the service worker, wakes it later without `onStartup`, or interrupts long-running background work. | Persistent state lives in `chrome.storage.local` or browser-managed DNR, `userScripts`, and proxy APIs. Wake/startup paths resync DNR, privacy settings, scriptlets, proxy-related state, alarms, and tab config where possible. Health diagnostics report important failures. | Some runtime work can be delayed until the worker wakes. A failed refresh, registration, or PAC write can leave a layer stale or degraded until retry, reload, or user action. |

## What Chroma Defends Against

Chroma is designed to reduce common web tracking, advertising, and clutter at several layers:

- Browser-engine DNR blocking for supported static, dynamic, subscription, cleanup, and whitelist rules.
- Local cosmetic cleanup for ad containers, placeholders, warning overlays, and user-created zapper rules.
- Supported scriptlet behavior from Chroma's bundled scriptlet library, registered through Chrome's `userScripts` API.
- Platform-specific YouTube and Prime Video handling where client-side interception still works.
- Chroma-owned telemetry collection, because Chroma does not operate telemetry or analytics servers.
- Page tampering with Chroma's own MAIN-world session state, to the extent possible with early API capture, closure state, and nonce-based setup.
- Unbounded subscription rule registration by allocating and trimming dynamic DNR rules instead of blindly registering every parsed rule.
- Accidental mixing of blocking and routing policy by separating DNR request decisions from PAC transport selection.

## What Chroma Does Not Defend Against

Chroma is not a general sandbox, antivirus, VPN, password manager, or anonymity system. In particular, it does not defend against:

- A compromised operating system, browser binary, browser profile, or another privileged extension.
- A malicious Chroma release package or a release downloaded from an untrusted source.
- Browser bugs that break extension isolation, DNR enforcement, storage isolation, or `userScripts` behavior.
- All fingerprinting or tracking. Optional fingerprint randomization can reduce some surfaces, but it is not a complete anonymity guarantee.
- Account-level tracking or server-side decisions made after you sign in to a website.
- Server-side ad insertion that never exposes a clean client-side blocking point.
- Platform policy enforcement, account restrictions, or terms-of-service consequences.
- Malicious custom subscriptions or user scriptlet resources selected by the user.
- A malicious proxy provider, TLS-breaking local root certificate, or network path outside the browser's normal security model.
- Physical access to the machine or direct access to the browser profile.

## Trust Assumptions

Chroma's security model assumes:

- Chromium correctly enforces extension origin isolation, isolated-world content scripts, DNR rules, `userScripts`, storage boundaries, and extension permissions.
- The installed Chroma package matches the source you intended to install.
- The local operating system account and browser profile are not compromised.
- Default remote filter-list maintainers are trusted to influence blocking behavior within Chroma's supported rule types, or the user disables lists they do not want to trust.
- Custom subscriptions are trusted by the user who adds them.
- Advanced user scriptlet resources are trusted as executable page code by the user who adds them.
- Proxy providers are trusted for any browser traffic routed through them.
- Users keep Chrome or their Chromium-based browser updated enough for MV3 APIs, DNR, and `userScripts` behavior to work as expected.

## Reporting Security Issues

If you find a vulnerability in an extension page, service-worker message path, rule parser, scriptlet boundary, proxy credential handling, or page-to-MAIN handshake, follow the private disclosure process in [Security Policy](SECURITY.md).

---

Next: [Performance Guide](PERFORMANCE.md)
