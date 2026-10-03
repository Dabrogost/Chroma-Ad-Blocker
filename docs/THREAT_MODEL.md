# Threat Model

This document describes Chroma's practical security boundaries. Chroma cannot make hostile pages, hostile platforms, remote lists, proxies, or user-provided code safe by itself. The goal is to show which risks Chroma reduces, which risks remain, and what the extension assumes about the browser environment.

Use the matrix below for capabilities and residual risk. Detailed control mechanics belong in the [Security Policy](SECURITY.md), data contents and retention in the [Privacy Policy](PRIVACY_POLICY.md), and execution flow in [Architecture](ARCHITECTURE.md).

## Assets And Boundaries

| Asset or boundary | Why it matters | Primary controls |
|---|---|---|
| Extension storage | Holds settings, proxy records, cached rules/code, and browsing-related diagnostics. | Local storage with bounded logs and sanitized diagnostics; Chroma content scripts share access. See [storage boundary](SECURITY.md#local-storage-access-boundary). |
| Extension pages | Popup and settings pages can message the service worker and change privileged state. | Extension origin isolation, DOM-safe rendering, validated background messages. |
| Isolated-world content scripts | Handle cosmetic filtering and extension-to-page coordination. | Chrome isolates them from ordinary page scripts; background messages have sender policies. |
| MAIN-world handlers | Needed for page API interception, platform-specific handlers, scriptlets, and optional fingerprint randomization. On supported bridge domains, the page can read the frozen `__CHROMA_INTERNAL__.config` snapshot and revision. | Pristine API caching, closure-scoped authority, nonce-based port handshake, immutable—but observable—bridge values, and narrow registration. |
| DNR rules | Browser-enforced request policy for static, dynamic, subscription, cleanup, and whitelist rules. | Browser validation, static rulesets, dynamic ID ranges, budget allocation. |
| Remote subscriptions | Can change blocking, cosmetic behavior, and bundled scriptlet activation after install. | [URL validation](SECURITY.md#remote-url-network-boundary), bounded parsing, supported syntax, and rule budgets. |
| Guided release updates | Can replace local unpacked extension files after the user grants folder access. | [Signature and package validation](SECURITY.md#guided-update-trust-boundary), explicit folder access, planning, backup, rollback attempt, and manifest-last writes. |
| User scriptlet resources | User-selected executable MAIN-world code. | Separate opt-in [resource registration path](SECURITY.md#advanced-user-scriptlet-resources) with user-selected domain rules. |
| Proxy routing | Routes selected browser traffic through user-configured proxy servers. | PAC policy, master-state gating, ownership inspection, and exact active-route credential matching. See [proxy routing](MEDIA_PROXY_ROUTER.md). |

## Adversaries

| Adversary | Capabilities | Chroma's intended response | Residual risk |
|---|---|---|---|
| Page-script adversary | Runs JavaScript on a page, mutates the DOM, monkey-patches page APIs, watches visible side effects, and tries to detect or interfere with content changes. | Uses isolated-world content scripts where possible. MAIN-world code caches pristine APIs early, starts fail-closed, keeps configuration authority closure-scoped, and uses a short-lived nonce/challenge handshake to select a per-document port that remains open for updates. Public config events carry no authoritative values. | A page can observe DOM changes and, on supported bridge domains, directly read the immutable `__CHROMA_INTERNAL__.config` snapshot and revision. It can change its own behavior, race extension hooks, and detect Chroma through multiple surfaces. Immutability prevents ordinary modification, not observation. |
| Page-forged diagnostic signal | Dispatches page-visible events intended to resemble YouTube or scriptlet activity. | Accepts only strict coarse enums, derives metadata from Chrome sender context, applies master/feature/whitelist gates, and bounds ingress and writes per document, tab, and globally. | A page can inflate valid coarse page-event totals within fixed quotas. Those totals are approximate; enforcement and privileged state are unaffected. |
| Hostile media platform | Changes internal APIs, ad delivery, payload shape, UI rendering, or account-side policy. May use server-side ad insertion or terms enforcement. | Uses platform-specific cleanup, DNR rules, cosmetics, scriptlets, and optional proxy routing as separate layers so one layer can degrade without disabling all protection. | Platforms can break client-side handling, move ads server-side, block accounts, or make some behavior impossible to fix locally. Chroma does not guarantee access to any service or compliance with platform terms. |
| Malicious remote or custom filter list | Publishes rules that overblock, allow unwanted requests, hide important UI, or trigger supported bundled scriptlets. Custom lists are explicitly user-selected. | Applies the same bounded syntax, URL, size, and lifecycle constraints to default and custom subscriptions. Only bundled scriptlet implementations are available to list rules. | A malicious list can break sites or make privacy-relevant allow/block choices within supported syntax. A public-looking source hostname can resolve or rebind to a private address, and Chromium can contact an automatic redirect before final-URL rejection. |
| Malicious user scriptlet resource | Supplies executable JavaScript selected by the user and activated by matching user rules. | Requires the separate resource/rule registration path and runs through Chrome's `userScripts` API. | Code can read, alter, or transmit page-accessible DOM, cookies, storage, and account/session data. Chroma does not audit or sandbox its intent. Resource fetches share the DNS/redirect limitations of subscriptions. |
| Compromised proxy | Observes or alters traffic routed through it, fails intermittently, or logs destinations and timing. | Chroma routes only user-configured effective proxy targets, keeps unmatched traffic direct unless Global Fallback is selected, releases routing on master off, and releases credentials only to an exact active route. | A proxy provider can see normal proxy metadata and plaintext HTTP content, and can disrupt or modify non-TLS traffic. HTTPS protects content only according to the browser's normal TLS trust model. Chroma cannot make an untrusted proxy trustworthy. |
| External Chrome-setting controller | Another extension or browser policy owns proxy, WebRTC, or browser privacy settings and prevents Chroma's requested writes. | Inspects `levelOfControl`, keeps requested and effective state separate, reports degraded Health, avoids claiming routing/credential ownership, and reconciles automatically when control is released. | Chroma cannot override a higher-priority controller. Requested protection remains ineffective until Chrome returns control. |
| Conflicting geolocation policy | Browser/site policy or another extension affects the location content setting. | Applies Chroma's requested rule and samples effective status during Health checks and reconciliation. | This API does not expose controller ownership. A single sampled URL cannot establish every site's effective policy; recovery requires a refresh or another reconciliation trigger. |
| Extension-page XSS | Injects script into popup or settings pages and abuses privileged extension-page messaging. | Relies on Chrome extension-origin isolation, DOM-safe UI rendering, sanitized diagnostics, and validated background message paths. | Any real XSS in an extension page would be high impact. Treat extension UI rendering bugs as security issues and report them privately. |
| Compromised Chroma content script | Exploits or introduces unintended behavior in an isolated-world Chroma content script running on a permitted page. | Chrome keeps the isolated world separate from ordinary page JavaScript, and privileged background messages are validated. | Under Chrome's default storage policy, Chroma content scripts can access the extension's `chrome.storage.local` area. A content-script compromise could therefore expose request-log URLs, proxy records, cached executable resources, or other keys beyond that script's normal needs. |
| MV3 service-worker restart or failure | Browser stops the service worker, wakes it later without `onStartup`, or interrupts long-running background work. | Persistent state lives in `chrome.storage.local` or browser-managed DNR, `userScripts`, and proxy APIs. Wake/startup paths resync DNR, privacy settings, scriptlets, proxy-related state, alarms, and tab config where possible. Health diagnostics report important failures. | Some runtime work can be delayed until the worker wakes. A failed refresh, registration, or PAC write can leave a layer stale or degraded until retry, reload, or user action. |
| Compromised GitHub release asset | Replaces the release ZIP or `updates.json` without the Chroma update private key. | Guided updates require signed `updates.json`; that manifest binds the exact ZIP name, byte size, and SHA-256 before install planning or writes. Missing or invalid signatures stop guided installation. | Every manual install or manual update depends on independent release provenance because the manual procedure does not perform Chroma signature verification. A stolen update private key or malicious signed release is trusted by existing guided-updater clients. Replacing a compromised trust anchor requires an independently authenticated release path. |

## Protection Scope

Chroma reduces supported advertising, tracking, and page clutter through browser-enforced rules, cosmetics, bundled scriptlets, and platform handlers. [Architecture](ARCHITECTURE.md) explains those layers and their failure modes. The controls above protect extension state and limit untrusted input; they do not establish that a remote list, proxy, or executable resource has benign intent.

## What Chroma Does Not Defend Against

Chroma is not a general sandbox, antivirus, VPN, password manager, or anonymity system. In particular, it does not defend against:

- A compromised operating system, browser binary, browser profile, or exceptional debugger-enabled environment capable of inspecting Chroma.
- Browser bugs that break extension isolation, DNR enforcement, storage isolation, or `userScripts` behavior.
- All fingerprinting or tracking. Optional fingerprint randomization can reduce some surfaces, but it is not a complete anonymity guarantee.
- Account-level tracking or server-side decisions made after you sign in to a website.
- Server-side ad insertion that never exposes a clean client-side blocking point.
- Platform policy enforcement, account restrictions, or terms-of-service consequences.
- TLS-breaking local root certificates or network paths outside the browser's normal security model.
- Physical access to the machine or direct access to the browser profile.

The matrix also identifies the risks from malicious sources, compromised content scripts, unauthenticated manual installs, and a compromised signing key. Those risks remain even when Chroma's own validation works as designed.

## Trust Assumptions

Chroma's security model assumes:

- Chromium correctly enforces extension origin isolation, isolated-world content scripts, DNR rules, `userScripts`, storage boundaries, and extension permissions.
- The installed Chroma package matches the source you intended to install.
- Chroma's bundled guided-updater public key matches the maintainer's private update-signing key; private-key access, signing hosts, and backups remain protected.
- Signing-key rotation and compromise recovery follow the [independent-trust requirements](SECURITY.md#guided-update-trust-boundary).
- The local operating system account and browser profile are not compromised.
- Users trust enabled list maintainers to influence filtering and trust Advanced User Scriptlet resources as executable page code, or disable those sources.
- Remote source hostnames are trusted to resolve to appropriate network destinations; Chroma validates literal URL hosts but cannot authenticate DNS answers.
- Proxy providers are trusted for any browser traffic routed through them.
- Users keep Chrome or their Chromium-based browser updated enough for MV3 APIs, DNR, and `userScripts` behavior to work as expected.

## Reporting Security Issues

If you find a vulnerability in an extension page, service-worker message path, rule parser, scriptlet boundary, proxy credential handling, or page-to-MAIN handshake, follow the private disclosure process in [Security Policy](SECURITY.md).

---

Next: [Testing Guide](TEST_GUIDE.md)
