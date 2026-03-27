---
layout: default
title: Privacy Policy
layout-class: layout-prose
description: Chroma Ad-Blocker privacy policy — your data never leaves your device.
---

# Privacy Policy for Chroma Ad-Blocker

**Effective Date:** March 26, 2026

## Overview
Chroma Ad-Blocker ("we," "our," or "the Extension") is committed to protecting your privacy. This Privacy Policy explains how we handle information in connection with your use of the Extension. **Our core principle is that your data stays on your device.**

## 1. Information Collection and Use
Chroma Ad-Blocker **does not collect, store, or transmit any personal information** to external servers. All operations are performed locally on your device.

### Local Data Storage
The Extension uses your browser's local storage (`chrome.storage.local`) to save:
- **User Settings**: Your preferred toggles for ad-acceleration, network blocking, and cosmetic filtering.
- **Aggregated Statistics**: Local counts of blocked ads and prevented tracking attempts. These stats are for your personal view only and are never shared.

## 2. Permissions and Rationale
The Extension requires specific permissions to function effectively. Below is a breakdown of why these permissions are used:

- **`storage`**: To save your extension settings and block statistics locally.
- **`tabs`**: To manage and apply protection scripts across your open browser tabs.
- **Host Permissions (`<all_urls>`)**: This broad permission is used **strictly** to inject "Protection Scripts" (`protection.js` and `interceptor.js`). These scripts are necessary to:
  - Block malicious pop-unders and unwanted windows.
  - Intercept and suppress intrusive push notification requests on any website you visit.
- **`declarativeNetRequest` & `declarativeNetRequestFeedback`**: These permissions allow the extension to block ad-related network requests (like tracking pings and banner ads) and aggregate those events into the local statistics displayed in the extension popup.

## 3. Data Sharing
We do not share any data with third parties. There are no analytics, tracking, or telemetry scripts included in the Extension that communicate with external servers.

## 4. Third-Party Websites
The Extension interacts with websites you visit to provide ad-blocking services. This interaction is limited to modifying the site's code locally to hide ads or accelerate video playback. We do not have access to your accounts or private data on those websites.

## 5. Changes to This Policy
We may update this Privacy Policy from time to time. Any changes will be reflected in the "Effective Date" at the top of this document.

## 6. Contact
If you have any questions about this Privacy Policy, please contact the developer via email @ dabrogost@gmail.com.
