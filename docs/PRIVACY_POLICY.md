---
layout: default
title: Privacy Policy
layout-class: layout-prose
description: Chroma Ad-Blocker privacy policy - local data handling, external requests, and user-controlled trust boundaries.
---

# Privacy Policy for Chroma Ad-Blocker

**Effective Date:** July 27, 2026

## Overview
Chroma Ad-Blocker ("we," "our," or "the Extension") is committed to protecting your privacy. This Privacy Policy explains how information is processed in connection with your use of the Extension. **Chroma does not operate a telemetry, analytics, or tracking backend. Core settings, logs, statistics, and cached rules are stored on your device; normal and optional features may contact the external list, update, proxy-test, proxy, or user-selected scriptlet services described below.**

## 1. Information Collection and Use
Chroma does not sell personal information or send browsing activity to a Chroma-operated analytics service. Core extension operations happen locally, but local processing and storage can include browsing-related data such as domains, matched request URLs, timestamps, and rule metadata as described below.

### Local Data Storage
The Extension uses your browser's local storage (`chrome.storage.local`) to save:
- **User Settings**: Your preferred toggles for network blocking, YouTube stripping, ad acceleration, cosmetic filtering, Quiet Console behavior, fingerprint randomization, proxy routing, and related options.
- **Whitelists**: Domains you choose to exempt from Chroma protection or fingerprint randomization.
- **Filter List Data**: Subscription metadata and cached parsed rules from configured filter lists. Caches may remain stored while a list, Network Blocking, or master protection is disabled so requested state can be restored without another download.
- **User Scriptlet Resources**: If you add advanced user scriptlet resources, Chroma stores the resource URLs, parsed resource metadata, cached resource code, and your matching user scriptlet rules locally.
- **Proxy Settings**: Proxy server configuration. HTTP/HTTPS proxy credentials, if provided, are stored locally in an obfuscated form with a bundled extension key. Chroma releases them only for a bounded genuine proxy-authentication challenge matching the exact host, port, type, and currently effective Chroma route. Disabled, stale, unrouted, master-paused, or externally controlled records receive no credentials. This is not strong encryption; protect your browser profile and operating-system account accordingly.
- **Local Statistics and Request Log**: `statsV2` holds local protection intelligence according to the selected Basic, Aggregated, or Debug statistics mode. Separately, whenever Chrome exposes DNR matched-rule feedback to the unpacked extension, Chroma keeps a request log of the newest 500 reported matches in every statistics mode. That separate log can include full matched request URLs, request types, timestamps, rule IDs, block, allow, or neutral/match actions, and rule sources such as whitelist or unknown. It is cleared when the browser profile starts and Chrome fires `runtime.onStartup`, and it can be reset independently from settings. Resetting statistics does not automatically reset this request log. MAIN-world page diagnostics are accepted only as coarse, rate-limited event types with caller metadata discarded; those page-layer totals are approximate because page-visible event signals cannot prove that an action occurred.
- **Health Diagnostics**: Coarse local status entries for material background failures, such as DNR sync, UserScripts registration, or proxy PAC write failures. These entries are sanitized and are not designed to store request URLs, proxy hosts, credentials, or raw filter rules.
- **Guided Updater Folder Handle**: If you choose an unpacked Chroma install folder for guided updates, Chroma stores that browser-provided File System Access directory handle locally in IndexedDB. The handle is used only to reconnect to the selected install folder, and Chrome may ask you to approve access again after a restart or permission reset.

### Chroma Tracking and Site Storage
Chroma does not use cookies, tracking pixels, or web beacons to track its users, and there is no Chroma server-side tracking of browsing habits or Extension use. Some bundled filtering scriptlets can read, set, or remove site cookies or site storage as part of their documented page-side behavior. Advanced User Scriptlet code you choose to add can also access page-visible cookies and storage within the browser's normal security boundaries.

## 2. Permissions and Rationale
The Extension requires specific permissions to function effectively. Below is a breakdown of why these permissions are used:

- **`declarativeNetRequest`**: Enables static, dynamic, subscription, and whitelist rules for network-level blocking.
- **`declarativeNetRequestFeedback`**: Allows local matched-rule feedback for block, allow, and neutral/unknown classification in statistics and the bounded request log.
- **`storage` and `unlimitedStorage`**: Save settings, whitelists, proxy configuration, subscription metadata, cached rules, statistics, and request-log data locally.
- **`tabs`**: Reads the active tab URL for whitelist controls, opens extension pages or links from the popup/settings UI, and reloads tabs after site-level whitelist changes.
- **`alarms`**: Schedules recurring subscription refresh checks in the MV3 service worker.
- **`userScripts`**: Registers bundled subscription scriptlets and explicit user-added scriptlet resources in the page context using Chrome's native userScripts API. In Chrome 138 and newer, this API also requires the user to enable Chrome's per-extension **Allow User Scripts** toggle.
- **`scripting`**: Supports extension-controlled script work, including Element Zapper injection and fingerprint-randomization logic when enabled.
- **`proxy`**: Applies browser-level PAC scripts for split-tunnel and global fallback proxy routing.
- **`privacy`**: Applies optional WebRTC leak protection and Chrome Privacy Hardening settings while master protection and the corresponding feature are enabled. Master off releases Chroma-owned settings without erasing requested values.
- **`contentSettings`**: Applies optional Geolocation Protection while master protection and that feature are enabled. Master off clears Chroma's location rule without erasing the request.
- **`webRequest` and `webRequestAuthProvider`**: Observes genuine proxy authentication challenges and provides credentials only for the exact currently effective HTTP/HTTPS proxy route.
- **Host Permissions (`<all_urls>` and listed site patterns)**: Allow content scripts, cosmetic filtering, DNR rule matching, subscription scriptlets, supported platform handlers, site-level controls, and user-selected remote list/resource fetches to operate across their required origins. This is broad by design and is why sensitive state remains local.

## 3. Data Sharing
Chroma does not sell browsing data or upload it to a Chroma-operated analytics service. There are no Chroma analytics, tracking, or telemetry scripts in the Extension. Network requests initiated by normal features, configured proxies, or executable user-provided scriptlets remain subject to the external-service boundaries below.

Some features make network requests as part of their normal function:
- **Filter List Updates**: Enabled remote subscriptions are fetched from their configured list URLs. Defaults include Hagezi Pro Mini, EasyList, and Fanboy Annoyance. The bundled Chroma Scriptlet Library is read from the extension package rather than fetched from the network.
- **User Scriptlet Resource Updates**: Advanced user scriptlet resources are fetched from the HTTPS URLs you add in settings.
- **Update Checks**: The extension can check GitHub's releases API to determine whether a newer Chroma version is available. Normal popup and settings loads reuse a local update-check cache for up to 6 hours unless you click **Check Latest Release**. If you use guided updates, Chroma can also download signed `updates.json` and the exact GitHub release ZIP into memory to verify and inspect them before installation. These guided-update downloads are not written through Chrome's Downloads system, and users do not manually download `updates.json`.
- **Proxy Testing**: When you test a proxy, Chroma shuffles its configured public IP-check services—Cloudflare Trace, AWS CheckIP, ipify, and icanhazip—and requests one through the selected proxy. If that attempt fails, it may try one additional service. Those services receive the normal metadata associated with the test request.
- **Configured Proxy Routing**: If master protection and a proxy route or global fallback are enabled, matching browser traffic is routed through the proxy server only when Chroma effectively controls Chrome's proxy setting. Another extension or browser policy can prevent the requested route from becoming effective.

These requests are not telemetry to Chroma, but the remote services or proxy providers involved may receive normal network metadata such as your IP address, user agent, and request time.

### Remote List Trust Boundary
Remote filter lists can change extension behavior after installation. Depending on the rule type and Chroma support, a refreshed list can affect network blocking or allow rules, cosmetic hiding, and supported scriptlet registration. Chroma applies guardrails: remote lists are fetched over HTTPS, parsed locally, capped by size and rule budgets, deduplicated where appropriate, and scriptlets are limited to Chroma's shipped scriptlet implementations. Chroma does not ship a maintainer-controlled hotfix subscription; project fixes are delivered through GitHub release packages.

### Advanced User Scriptlet Trust Boundary

Advanced User Scriptlet resources are different from normal filter-list scriptlets: they contain executable JavaScript selected by the user and run in the page's MAIN world on sites matched by user-created rules. That code can read and modify page-visible DOM, JavaScript state, cookies, storage, and account/session information available to ordinary page JavaScript. It can also initiate network activity or transmit accessible data, subject to the browser and page's normal security controls.

Chroma fetches and registers this code but does not audit or sandbox its intent. Any collection or transmission performed by a user-provided resource is outside Chroma's no-telemetry promise. Add only resources whose code and operator you trust, and use the narrowest practical domain rules.

### Remote Source Address Boundary

Remote list and Advanced User Scriptlet URLs must use HTTPS on the default port without URL credentials. Chroma rejects literal localhost and private/special-use IPv4 or IPv6 addresses and rejects a final response URL that literally names one before accepting its metadata or body.

Chromium performs DNS resolution and automatic redirect transport. Chroma cannot inspect or pin the peer IP used by `fetch()`, so a public-looking hostname can resolve or rebind to a private address, and an automatically followed redirect may be contacted before its final URL is rejected. These are user-selected or configured source requests, not Chroma telemetry; add only remote sources you trust.

## 4. Allow Rules
Allow rules tell Chrome not to block a matching request through Chroma's lower-priority DNR rules. They can come from Chroma's bundled compatibility rules, enabled remote or custom subscriptions, and site whitelists. Their scope therefore depends on the enabled rule sources and user configuration; they are not limited to one fixed compatibility list.

An allow rule does not give Chroma the response body. However, when Chrome exposes matched-rule feedback, the separate local request log can store the allowed request's full URL and associated rule metadata just as it does for blocked or unknown matches. If proxy routing applies, an allowed request may also travel through the configured proxy rather than directly.

Use **Whitelist this site** only when you want to disable Chroma protection for that site to resolve breakage; whitelisting makes filtering less strict. For stricter filtering, review or disable subscriptions that introduce unwanted allow rules. Chroma does not currently provide a per-rule toggle for individual bundled compatibility allow rules.

## 5. Third-Party Websites
The Extension interacts with websites you visit to provide ad blocking, cosmetic filtering, scriptlet protections, platform-specific ad stripping, ad acceleration fallback, and optional proxy routing. Chroma's shipped protection logic is not designed to collect account credentials, private messages, or account data from those websites or upload that information. This assurance does not extend to executable Advanced User Scriptlet resources that you add; those resources have the page-level capabilities described above.

## 6. Changes to This Policy
We may update this Privacy Policy as Chroma's behavior changes. The copy included in each release describes that release, and its Effective Date appears at the top of this document. Repository edits do not silently replace the policy bundled with an already installed copy.

## 7. Contact
If you have any questions about this Privacy Policy, please contact the developer at dabrogost@gmail.com.

---

Next: [Performance Guide](PERFORMANCE.md)
