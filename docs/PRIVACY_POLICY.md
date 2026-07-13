---
layout: default
title: Privacy Policy
layout-class: layout-prose
description: Chroma Ad-Blocker privacy policy - your data stays on your device.
---

# Privacy Policy for Chroma Ad-Blocker

**Effective Date:** July 13, 2026

## Overview
Chroma Ad-Blocker ("we," "our," or "the Extension") is committed to protecting your privacy. This Privacy Policy explains how we handle information in connection with your use of the Extension. **Core extension settings, logs, and cached rules are stored on your device; optional features may contact the external list, update, proxy-test, or proxy services described below.**

## 1. Information Collection and Use
Chroma Ad-Blocker **does not collect, upload, or sell personal information**. Chroma does not operate any telemetry, analytics, or tracking backend. Core extension operations are performed locally on your device.

### Local Data Storage
The Extension uses your browser's local storage (`chrome.storage.local`) to save:
- **User Settings**: Your preferred toggles for network blocking, YouTube stripping, ad acceleration, cosmetic filtering, Quiet Console behavior, fingerprint randomization, proxy routing, and related options.
- **Whitelists**: Domains you choose to exempt from Chroma protection or fingerprint randomization.
- **Filter List Data**: Subscription metadata and cached parsed rules from configured filter lists. Caches may remain stored while a list, Network Blocking, or master protection is disabled so requested state can be restored without another download.
- **User Scriptlet Resources**: If you add advanced user scriptlet resources, Chroma stores the resource URLs, parsed resource metadata, cached resource code, and your matching user scriptlet rules locally.
- **Proxy Settings**: Proxy server configuration. HTTP/HTTPS proxy credentials, if provided, are stored locally in an obfuscated form with a bundled extension key. Chroma releases them only for a bounded genuine proxy-authentication challenge matching the exact host, port, type, and currently effective Chroma route. Disabled, stale, unrouted, master-paused, or externally controlled records receive no credentials. This is not strong encryption; protect your browser profile and operating-system account accordingly.
- **Local Statistics and Request Log**: Local protection-event totals and a bounded DNR match log used by the popup and settings. The log can include matched request URLs, block/allow/unknown actions, request types, timestamps, and matched rule IDs. MAIN-world page diagnostics are accepted only as coarse, rate-limited event types with caller metadata discarded; those page-layer totals are approximate because page-visible event signals cannot prove that an action occurred. This data is stored locally and can be reset from the extension UI.
- **Health Diagnostics**: Coarse local status entries for material background failures, such as DNR sync, UserScripts registration, or proxy PAC write failures. These entries are sanitized and are not designed to store request URLs, proxy hosts, credentials, or raw filter rules.
- **Guided Updater Folder Handle**: If you choose an unpacked Chroma install folder for guided updates, Chroma stores that browser-provided File System Access directory handle locally in IndexedDB. The handle is used only to reconnect to the selected install folder, and Chrome may ask you to approve access again after a restart or permission reset.

### No Tracking and Cookies
We do not use cookies, tracking pixels, or web beacons. There is no Chroma server-side tracking of your browsing habits or your use of the Extension.

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
We do not sell, share, or upload your browsing data. There are no analytics, tracking, or telemetry scripts included in the Extension.

Some features make network requests as part of their normal function:
- **Filter List Updates**: Enabled remote subscriptions are fetched from their configured list URLs. Defaults include Hagezi Pro Mini, EasyList, and Fanboy Annoyance. The bundled Chroma Scriptlet Library is read from the extension package rather than fetched from the network.
- **User Scriptlet Resource Updates**: Advanced user scriptlet resources are fetched from the HTTPS URLs you add in settings.
- **Update Checks**: The extension can check GitHub's releases API to determine whether a newer Chroma version is available. Normal popup and settings loads reuse a local update-check cache for up to 6 hours unless you click **Check Latest Release**. If you use guided updates, Chroma can also download signed `updates.json` and the exact GitHub release ZIP into memory to verify and inspect them before installation. These guided-update downloads are not written through Chrome's Downloads system, and users do not manually download `updates.json`.
- **Proxy Testing**: When you test a proxy, Chroma requests a public IP-check endpoint through the selected proxy to verify connectivity.
- **Configured Proxy Routing**: If master protection and a proxy route or global fallback are enabled, matching browser traffic is routed through the proxy server only when Chroma effectively controls Chrome's proxy setting. Another extension or browser policy can prevent the requested route from becoming effective.

These requests are not telemetry to Chroma, but the remote services or proxy providers involved may receive normal network metadata such as your IP address, user agent, and request time.

### Remote List Trust Boundary
Remote filter lists can change extension behavior after installation. Depending on the rule type and Chroma support, a refreshed list can affect network blocking or allow rules, cosmetic hiding, and supported scriptlet registration. Chroma applies guardrails: remote lists are fetched over HTTPS, parsed locally, capped by size and rule budgets, deduplicated where appropriate, and scriptlets are limited to Chroma's shipped scriptlet implementations. Chroma does not ship a maintainer-controlled hotfix subscription; project fixes are delivered through GitHub release packages.

### Remote Source Address Boundary

Remote list and Advanced User Scriptlet URLs must use HTTPS on the default port without URL credentials. Chroma rejects literal localhost and private/special-use IPv4 or IPv6 addresses and rejects a final response URL that literally names one before accepting its metadata or body.

Chromium performs DNS resolution and automatic redirect transport. Chroma cannot inspect or pin the peer IP used by `fetch()`, so a public-looking hostname can resolve or rebind to a private address, and an automatically followed redirect may be contacted before its final URL is rejected. These are user-selected or configured source requests, not Chroma telemetry; add only remote sources you trust.

## 4. Selective Network Permissions
To maintain compatibility with certain websites, Chroma's ruleset permits a limited set of standard network requests to reach their intended destinations. These are called Allow Rules and apply only on specific domains where full blocking would impair page functionality.

Chroma does not intercept, read, modify, or store any data from these requests. They originate from the site's own scripts and are sent directly to that site's servers.

If you require stricter network filtering, you can disable the extension on any site using the **Whitelist this site** toggle in the popup.

## 5. Third-Party Websites
The Extension interacts with websites you visit to provide ad blocking, cosmetic filtering, scriptlet protections, platform-specific ad stripping, ad acceleration fallback, and optional proxy routing. These changes happen locally in your browser. Chroma is not designed to collect account credentials, private messages, or account data from those websites, and it does not upload that kind of data.

## 6. Changes to This Policy
We may update this Privacy Policy from time to time. Changes will be reflected in the Effective Date at the top of this document. Continued use of the Extension following any update constitutes acceptance of the revised Policy.

## 7. Contact
If you have any questions about this Privacy Policy, please contact the developer at dabrogost@gmail.com.

---

Next: [Security Policy](SECURITY.md)
