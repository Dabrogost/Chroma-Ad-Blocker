---
layout: default
title: Terms of Service
layout-class: layout-prose
description: Chroma Ad-Blocker license, warranty, and service notice for Chroma-authored and third-party material.
---

# Terms of Service for Chroma Ad-Blocker

**Effective Date:** July 27, 2026

## 1. Status Of This Notice
Receiving or running GPL-covered portions of Chroma Ad-Blocker ("the Extension") does not require acceptance of the GNU GPL. Permission to copy, modify, or distribute material is governed by its applicable license; the GPL explains when exercising those permissions indicates acceptance for GPL-covered material.

This document summarizes licensing, service, privacy, and third-party risk information. It does not add restrictions to the rights granted by an applicable license.

## 2. License and Use
Except where a file or credited component states otherwise, Chroma-authored code and documentation are offered under the **GNU General Public License, version 3 or, at your option, any later version (`GPL-3.0-or-later`)**. Bundled or derived third-party material retains its applicable license; [Filter List Subscriptions](FILTER_LISTS.md#third-party-credits) identifies the principal filter-list and derived-code sources. The shipped `LICENSE.md` contains the GPL version 3 text. Applicable license grants and source notices control if this summary differs from them.

- For GPL-covered material, you may make private modifications without publishing your changes.
- If you convey or distribute original or modified GPL-covered material, the GPL's applicable notice, licensing, installation-information, and Corresponding Source requirements apply.
- Source-sharing obligations do not arise merely because you made a private modification; they arise when covered work is conveyed in the circumstances described by the GPL.
- Third-party material remains governed by its source notice and applicable license.

## 3. Description of Service
Chroma Ad-Blocker provides tools to manage your browsing experience, including:
- **Network Blocking**: Preventing requests to known advertising, tracking, and nuisance domains through Manifest V3 Declarative Net Request rules.
- **Filter List Subscriptions**: Fetching and applying supported external or user-added filter lists within browser rule limits.
- **YouTube Ad Stripping**: Locally pruning ad metadata from supported YouTube API payloads before the player consumes them.
- **Scriptlet and Cosmetic Filtering**: Applying local scriptlets and hiding ad-related or intrusive elements on website interfaces.
- **Proxy Routing**: Optionally routing user-selected browser traffic through user-configured proxy servers.
- **Ad Acceleration Fallback**: Speeding up supported video advertisements when acceleration is enabled.
- **Overlay Removal**: Removing unsolicited overlay dialogs that restrict content access based on browser configuration.

## 4. Third-Party Services
The Extension is designed to interact with third-party services. The following facts and risks apply:
- The Extension is NOT affiliated with, endorsed by, or sponsored by any Third-Party Service or any other platform.
- Third-Party Services may update their platforms at any time, which may cause the Extension to stop functioning.
- Use of the Extension may conflict with a third-party service's terms and may result in account restrictions, access loss, or other enforcement by that service.
- A proxy provider selected by the user can impose its own terms and may log or alter routed traffic as described in Chroma's security and privacy documentation.

## 5. Disclaimer of Warranties
CONSISTENT WITH SECTION 15 OF THE GPL AND TO THE EXTENT PERMITTED BY APPLICABLE LAW, THE EXTENSION IS PROVIDED "AS IS," WITHOUT WARRANTY, INCLUDING IMPLIED WARRANTIES OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. THE APPLICABLE LICENSE AND SOURCE NOTICE CONTROL THE WARRANTY TERMS FOR EACH COVERED COMPONENT.

## 6. Limitation of Liability
CONSISTENT WITH SECTION 16 OF THE GPL AND TO THE EXTENT PERMITTED BY APPLICABLE LAW, COPYRIGHT HOLDERS AND OTHER PARTIES WHO MODIFY OR CONVEY THE EXTENSION ARE NOT LIABLE FOR DAMAGES ARISING FROM USE OF OR INABILITY TO USE THE EXTENSION. THE APPLICABLE LICENSE AND SOURCE NOTICE CONTROL.

## 7. Privacy
The [Privacy Policy](PRIVACY_POLICY.md) describes Chroma's data handling. Chroma does not operate telemetry or analytics servers, but it processes and stores some browsing-related data locally. Normal or user-selected features can contact remote list, update-check, proxy-test, proxy-routing, or Advanced User Scriptlet endpoints, and user-provided executable scriptlets can transmit page-accessible data.

## 8. Changes to Terms
Revisions may be included in future Chroma releases, and the Effective Date will be updated when this document changes. A repository edit does not retroactively alter the license or notice bundled with an already installed copy, does not by itself establish assent, and does not reduce rights already granted under an applicable open-source license.

## 9. Contact
For questions regarding these Terms, please contact the developer at dabrogost@gmail.com.

---

Back to [Project Philosophy](PROJECT_PHILOSOPHY.md)
