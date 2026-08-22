# Threat Model

This document describes Chroma's practical security boundaries. Chroma cannot make hostile pages, hostile platforms, remote lists, proxies, or user-provided code safe by itself. The goal is to show which risks Chroma reduces, which risks remain, and what the extension assumes about the browser environment.

## Assets And Boundaries

| Asset or boundary | Why it matters | Primary controls |
|---|---|---|
| Extension storage | Holds settings, whitelists, cached rules and code, proxy settings, local stats, full-URL request-log entries, and health diagnostics. | `chrome.storage.local`, bounded records, sanitized diagnostics, and no Chroma telemetry backend. Chrome's default access level also exposes this storage area to Chroma content-script contexts; Chroma does not currently restrict it with `setAccessLevel()`. |
| Extension pages | Popup and settings pages can message the service worker and change privileged state. | Extension origin isolation, DOM-safe rendering, validated background messages. |
| Isolated-world content scripts | Handle cosmetic filtering and extension-to-page coordination without giving ordinary page scripts direct access to Chrome extension APIs. A Chroma content script can access the broader `chrome.storage.local` area under Chrome's default policy. | Chrome isolated world, strict message routing, validated data flows, and local configuration reads. |
| MAIN-world handlers | Needed for page API interception, platform-specific handlers, scriptlets, and optional fingerprint randomization. On supported bridge domains, the page can read the frozen `__CHROMA_INTERNAL__.config` snapshot and revision. | Pristine API caching, closure-scoped authority, nonce-based port handshake, immutable—but observable—bridge values, and narrow registration. |
| DNR rules | Browser-enforced request policy for static, dynamic, subscription, cleanup, and whitelist rules. | Browser validation, static rulesets, dynamic ID ranges, budget allocation. |
| Remote subscriptions | Can change blocking, cosmetic behavior, and supported scriptlet activation after install. | HTTPS-only/default-port URLs, literal private-address rejection, final-URL revalidation, response-size limits, local parsing, unsupported-syntax drops, budget allocation. |
| Guided release updates | Can replace local unpacked extension files when the user grants folder access. Manual installation is a separate path without built-in Chroma signature verification. | Explicit File System Access folder picker, direct GitHub release asset names, signed `updates.json`, SHA-256 package verification, safe ZIP path checks, dry-run planning, backup, rollback attempt, and manifest-last writes. |
| User scriptlet resources | User-selected executable code that can run in the page MAIN world and can transmit page-accessible data. | Explicit user opt-in, HTTPS-only/default-port URLs, literal private-address rejection, separate resource lane, Chrome `userScripts` API, and user-selected domain rules. |
| Proxy routing | Routes selected browser traffic through user-configured proxy servers. | PAC generation, master-state gating, Chrome ownership inspection, requested/effective separation, exact active-route credential matching, bounded authentication attempts, and automatic control recovery. |

## Adversaries

| Adversary | Capabilities | Chroma's intended response | Residual risk |
|---|---|---|---|
| Page-script adversary | Runs JavaScript on a page, mutates the DOM, monkey-patches page APIs, watches visible side effects, and tries to detect or interfere with content changes. | Uses isolated-world content scripts where possible. MAIN-world code caches pristine APIs early, starts fail-closed, keeps configuration authority closure-scoped, and uses a short-lived nonce/challenge handshake to select a per-document port that remains open for updates. Public config events carry no authoritative values. | A page can observe DOM changes and, on supported bridge domains, directly read the immutable `__CHROMA_INTERNAL__.config` snapshot and revision. It can change its own behavior, race extension hooks, and detect Chroma through multiple surfaces. Immutability prevents ordinary modification, not observation. |
| Page-forged diagnostic signal | Dispatches page-visible events intended to resemble YouTube or scriptlet activity. | Accepts only strict coarse enums, derives metadata from Chrome sender context, applies master/feature/whitelist gates, and bounds ingress and writes per document, tab, and globally. | A page can inflate valid coarse page-event totals within fixed quotas. Those totals are approximate; enforcement and privileged state are unaffected. |
| Hostile media platform | Changes internal APIs, ad delivery, payload shape, UI rendering, or account-side policy. May use server-side ad insertion or terms enforcement. | Uses platform-specific cleanup, DNR rules, cosmetics, scriptlets, and optional proxy routing as separate layers so one layer can degrade without disabling all protection. | Platforms can break client-side handling, move ads server-side, block accounts, or make some behavior impossible to fix locally. Chroma does not guarantee access to any service or compliance with platform terms. |
| Malicious remote filter list | Publishes rules that overblock, allow unwanted requests, hide important UI, or trigger supported bundled scriptlets on chosen domains. | Treats list syntax as bounded configuration: HTTPS fetch, local parsing, size limits, DNR budgets, deduplication where applicable, unsupported-syntax drops, and shipped-only subscription scriptlets. | Enabled remote lists still affect browsing behavior. A malicious or compromised list can cause site breakage, privacy-relevant allow/block choices, or cosmetic hiding within the syntax Chroma supports. |
| Malicious custom subscription | Has the same rule-level influence as a remote filter list, but is selected by the user and may be less reviewed than default lists. | Applies the same syntax, URL, size, and lifecycle constraints as other subscriptions after explicit user addition. | The user is trusting that list to influence network and page behavior. Chroma cannot verify its intent or guarantee that a public-looking source hostname will not resolve or rebind to a private address. Chromium may contact an automatic redirect before Chroma can reject its final literal URL. |
| Malicious user scriptlet resource | Provides executable JavaScript selected by the user and activated by matching user scriptlet rules. Can read and modify page DOM, page-visible JavaScript state, cookies, storage, and account/session information available to ordinary page code. | Keeps this feature separate from normal subscriptions. Requires the user to add the resource URL and matching rules. Runs through Chrome's `userScripts` API rather than extension-controlled `eval` or remote extension code. | This is a full trust boundary. User-provided scriptlets are not audited or intent-sandboxed by Chroma and can initiate network requests or exfiltrate accessible page data. They may affect page privacy, account sessions, or site integrity. Their hostnames share the same unresolved-DNS/rebinding limitation as subscriptions. |
| Compromised proxy | Observes or alters traffic routed through it, fails intermittently, or logs destinations and timing. | Chroma routes only user-configured effective proxy targets, keeps unmatched traffic direct unless Global Fallback is selected, releases routing on master off, and releases credentials only to an exact active route. | A proxy provider can see normal proxy metadata and plaintext HTTP content, and can disrupt or modify non-TLS traffic. HTTPS protects content only according to the browser's normal TLS trust model. Chroma cannot make an untrusted proxy trustworthy. |
| External Chrome-setting controller | Another extension or browser policy owns proxy, WebRTC, or browser privacy settings and prevents Chroma's requested writes. | Inspects `levelOfControl`, keeps requested and effective state separate, reports degraded Health, avoids claiming routing/credential ownership, and reconciles automatically when control is released. | Chroma cannot override a higher-priority controller. Requested protection remains ineffective until Chrome returns control. |
| Extension-page XSS | Injects script into popup or settings pages and abuses privileged extension-page messaging. | Relies on Chrome extension-origin isolation, DOM-safe UI rendering, sanitized diagnostics, and validated background message paths. | Any real XSS in an extension page would be high impact. Treat extension UI rendering bugs as security issues and report them privately. |
| Compromised Chroma content script | Exploits or introduces unintended behavior in an isolated-world Chroma content script running on a permitted page. | Chrome keeps the isolated world separate from ordinary page JavaScript, and privileged background messages are validated. | Under Chrome's default storage policy, Chroma content scripts can access the extension's `chrome.storage.local` area. A content-script compromise could therefore expose request-log URLs, proxy records, cached executable resources, or other keys beyond that script's normal needs. |
| MV3 service-worker restart or failure | Browser stops the service worker, wakes it later without `onStartup`, or interrupts long-running background work. | Persistent state lives in `chrome.storage.local` or browser-managed DNR, `userScripts`, and proxy APIs. Wake/startup paths resync DNR, privacy settings, scriptlets, proxy-related state, alarms, and tab config where possible. Health diagnostics report important failures. | Some runtime work can be delayed until the worker wakes. A failed refresh, registration, or PAC write can leave a layer stale or degraded until retry, reload, or user action. |
| Compromised GitHub release asset | Replaces the release ZIP or `updates.json` without the Chroma update private key. | Guided updates require signed `updates.json`; that manifest binds the exact ZIP name, byte size, and SHA-256 before install planning or writes. Missing or invalid signatures stop guided installation. | Every manual install or manual update depends on independent release provenance because the manual procedure does not perform Chroma signature verification. A stolen update private key or malicious signed release is trusted by existing guided-updater clients. Replacing a compromised trust anchor requires an independently authenticated release path. |

## What Chroma Defends Against

Chroma is designed to reduce common web tracking, advertising, and clutter at several layers:

- Browser-engine DNR blocking for supported static, dynamic, subscription, cleanup, and whitelist rules.
- Local cosmetic cleanup for ad containers, placeholders, warning overlays, and user-created zapper rules.
- Supported scriptlet behavior from Chroma's bundled scriptlet library, registered through Chrome's `userScripts` API.
- Platform-specific YouTube handling where client-side interception still works. The dormant Prime Video accelerator is not registered in the manifest.
- Chroma-owned telemetry collection, because Chroma does not operate telemetry or analytics servers.
- Page tampering with Chroma's own MAIN-world session state, to the extent possible with early API capture, closure state, and nonce-based setup.
- Unbounded subscription rule registration by allocating and trimming dynamic DNR rules instead of blindly registering every parsed rule.
- Accidental mixing of blocking and routing policy by separating DNR request decisions from PAC transport selection.

## What Chroma Does Not Defend Against

Chroma is not a general sandbox, antivirus, VPN, password manager, or anonymity system. In particular, it does not defend against:

- A compromised operating system, browser binary, browser profile, or exceptional debugger-enabled environment capable of inspecting Chroma.
- A malicious Chroma release package, a malicious signed release, or a release downloaded from an untrusted source.
- Browser bugs that break extension isolation, DNR enforcement, storage isolation, or `userScripts` behavior.
- All fingerprinting or tracking. Optional fingerprint randomization can reduce some surfaces, but it is not a complete anonymity guarantee.
- Account-level tracking or server-side decisions made after you sign in to a website.
- Server-side ad insertion that never exposes a clean client-side blocking point.
- Platform policy enforcement, account restrictions, or terms-of-service consequences.
- Malicious custom subscriptions or user scriptlet resources selected by the user.
- Data access or transmission intentionally performed by executable Advanced User Scriptlet code selected by the user.
- A public hostname resolving or rebinding to a private address after Chroma's literal URL validation; Chromium does not expose or pin the peer IP for the current fetch path.
- A malicious proxy provider, TLS-breaking local root certificate, or network path outside the browser's normal security model.
- A compromised Chroma content script reading other keys from the broadly available `chrome.storage.local` area.
- A manually installed package that was not authenticated through an independent trusted channel.
- Immediate in-band recovery after compromise of the active update-signing private key.
- Physical access to the machine or direct access to the browser profile.

## Trust Assumptions

Chroma's security model assumes:

- Chromium correctly enforces extension origin isolation, isolated-world content scripts, DNR rules, `userScripts`, storage boundaries, and extension permissions.
- The installed Chroma package matches the source you intended to install.
- Chroma's bundled guided-updater public key matches the maintainer's private update-signing key; private-key access, signing hosts, and backups remain protected.
- Planned signing-key rotation is delivered in a reviewed release before manifests switch key IDs. Recovery from a suspected active-key compromise uses an independent trusted distribution and verification channel rather than trusting that key to authorize its own replacement.
- The local operating system account and browser profile are not compromised.
- Default remote filter-list maintainers are trusted to influence blocking behavior within Chroma's supported rule types, or the user disables lists they do not want to trust.
- Custom subscriptions are trusted by the user who adds them.
- Advanced user scriptlet resources are trusted as executable page code by the user who adds them.
- Remote source hostnames are trusted to resolve to appropriate network destinations; Chroma validates literal URL hosts but cannot authenticate DNS answers.
- Proxy providers are trusted for any browser traffic routed through them.
- Users keep Chrome or their Chromium-based browser updated enough for MV3 APIs, DNR, and `userScripts` behavior to work as expected.

## Reporting Security Issues

If you find a vulnerability in an extension page, service-worker message path, rule parser, scriptlet boundary, proxy credential handling, or page-to-MAIN handshake, follow the private disclosure process in [Security Policy](SECURITY.md).

---

Next: [Testing Guide](TEST_GUIDE.md)
