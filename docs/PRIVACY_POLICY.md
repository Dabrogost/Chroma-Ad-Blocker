---
layout: default
title: Privacy Policy
layout-class: layout-prose
description: Chroma Ad-Blocker privacy policy - your data stays on your device.
---

# Privacy Policy for Chroma Ad-Blocker

**Effective Date:** April 26, 2026

## Overview
Chroma Ad-Blocker ("we," "our," or "the Extension") is committed to protecting your privacy. This Privacy Policy explains how we handle information in connection with your use of the Extension. **Core extension settings, logs, and cached rules are stored on your device; optional features may contact the external list, update, proxy-test, or proxy services described below.**

## 1. Information Collection and Use
Chroma Ad-Blocker **does not collect, store, or transmit personal information to Chroma-controlled servers**. Chroma does not operate any telemetry, analytics, or tracking backend. Core extension operations are performed locally on your device.

### Local Data Storage
The Extension uses your browser's local storage (`chrome.storage.local`) to save:
- **User Settings**: Your preferred toggles for network blocking, YouTube stripping, ad acceleration, cosmetic filtering, fingerprint randomization, proxy routing, and related options.
- **Whitelists**: Domains you choose to exempt from Chroma protection or fingerprint randomization.
- **Filter List Data**: Subscription metadata and cached parsed rules from enabled filter lists.
- **Proxy Settings**: Proxy server configuration. HTTP/HTTPS proxy credentials, if provided, are locally obfuscated/encrypted with a bundled extension key before storage and used only for proxy authentication.
- **Local Statistics and Request Log**: Local blocked-request counts and a bounded request log used for the popup display. The log can include blocked request URLs, request types, timestamps, and matched rule IDs. This data is stored locally and can be reset from the extension UI.

### No Tracking and Cookies
We do not use cookies, tracking pixels, or web beacons. There is no Chroma server-side tracking of your browsing habits or your use of the Extension.

## 2. Permissions and Rationale
The Extension requires specific permissions to function effectively. Below is a breakdown of why these permissions are used:

- **`declarativeNetRequest`**: Enables static, dynamic, subscription, and whitelist rules for network-level blocking.
- **`declarativeNetRequestFeedback`**: Allows local matched-rule feedback for blocked-request statistics and the local request log.
- **`storage` and `unlimitedStorage`**: Save settings, whitelists, proxy configuration, subscription metadata, cached rules, statistics, and request-log data locally.
- **`tabs`**: Reads the active tab URL for whitelist controls and opens extension pages or links from the popup/settings UI.
- **`alarms`**: Schedules recurring subscription refresh checks in the MV3 service worker.
- **`userScripts`**: Registers subscription scriptlets in the page context using Chrome's native userScripts API. In Chrome 138 and newer, this API also requires the user to enable Chrome's per-extension **Allow User Scripts** toggle.
- **`scripting`**: Supports supplemental extension-controlled script registration, including fingerprint-randomization logic when enabled.
- **`proxy`**: Applies browser-level PAC scripts for split-tunnel and global fallback proxy routing.
- **`webRequest` and `webRequestAuthProvider`**: Responds to proxy authentication challenges when an HTTP/HTTPS proxy requires credentials.
- **Host Permissions (`<all_urls>` and listed site patterns)**: Allow content scripts, cosmetic filtering, DNR rule matching, subscription scriptlets, and supported platform handlers to operate on visited pages.

## 3. Data Sharing
We do not sell, share, or transmit your browsing data to Chroma-controlled servers. There are no analytics, tracking, or telemetry scripts included in the Extension.

Some features make network requests as part of their normal function:
- **Filter List Updates**: Enabled subscriptions are fetched from their configured list URLs, such as GitHub-hosted Chroma/Hagezi lists or EasyList/Fanboy endpoints.
- **Update Checks**: The extension can check GitHub's releases API to determine whether a newer Chroma version is available.
- **Proxy Testing**: When you test a proxy, Chroma requests a public IP-check endpoint through the selected proxy to verify connectivity.
- **Configured Proxy Routing**: If you enable a proxy route or global fallback, matching browser traffic is routed through the proxy server you configured.

These requests are not telemetry to Chroma, but the remote services or proxy providers involved may receive normal network metadata such as your IP address, user agent, and request time.

## 4. Selective Network Permissions
To maintain compatibility with certain websites, Chroma's ruleset permits a limited set of standard network requests to reach their intended destinations. These are called Allow Rules and apply only on specific domains where full blocking would impair page functionality.

Chroma does not intercept, read, modify, or store any data from these requests. They originate from the site's own scripts and are sent directly to that site's servers.

If you require stricter network filtering, you can disable the extension on any site using the **Whitelist this site** toggle in the popup.

## 5. Third-Party Websites
The Extension interacts with websites you visit to provide ad blocking, cosmetic filtering, scriptlet protections, platform-specific ad stripping, ad acceleration fallback, and optional proxy routing. These changes happen locally in your browser. Chroma is not designed to collect account credentials, private messages, or account data from those websites, and it does not transmit that kind of data to Chroma-controlled servers.

## 6. Changes to This Policy
We may update this Privacy Policy from time to time. Changes will be reflected in the Effective Date at the top of this document. Continued use of the Extension following any update constitutes acceptance of the revised Policy.

## 7. Contact
If you have any questions about this Privacy Policy, please contact the developer at dabrogost@gmail.com.
