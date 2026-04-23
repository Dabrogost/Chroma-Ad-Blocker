# Chroma Ad-Blocker

**Chroma Ad-Blocker** is an advanced, high-performance browser extension built for Manifest V3 (MV3). It employs a sophisticated multi-layered strategy to maintain functionality across a wide range of websites while maintaining a minimal resource footprint. Chroma is free, source-available, and privacy-focused. For optimal performance, it is recommended to disable other ad-blocking extensions while using Chroma.

<div align="center">
  <img src="assets/popup.gif" alt="Chroma Ad-Blocker Popup Preview" width="360">
</div>

## Key Features

- **YouTube Ad Stripping**: Chroma's primary defense against YouTube ads. It intercepts and cleans ad-related metadata from JSON payloads before they reach the player, providing a seamless, high-performance viewing experience without the need for acceleration.
- **Split-Tunnel Proxy Router**: Allows routing specific domains through a custom HTTP, HTTPS, or SOCKS5 proxy server directly in the browser while leaving all other traffic direct. Includes on-the-fly AES-256-GCM encryption for proxy credentials and connectivity verification.
- **Multi-Part DNR Network Blocking**: Utilizes an 11-part static Declarative Net Request (DNR) ruleset supplemented by runtime dynamic rules, blocking trackers, invasive analytics, and traditional banner ads at the browser engine level.
- **Live Filter List Subscriptions**: Subscribes to external filter lists (Hagezi Pro Mini, Chroma Hotfix) that refresh automatically every 24 hours. Subscription rules are deduplicated against the static ruleset before allocation to maximize coverage within the dynamic rule budget.
- **Scriptlet Injection Engine**: A high-performance surgical layer powered by the `userScripts` API. It translates uBlock Origin/AdGuard syntax into native JavaScript and injects matched scriptlets at specific navigation milestones (`document_start`, `document_idle`, `document_end`) to neutralize anti-adblock scripts, prune dynamic JSON payloads, and intercept API calls.
- **Cosmetic Filtering Layer**: Removes ad slots, placeholders, and unwanted UI elements (Shorts, Merch, Offers) via high-speed CSS injection and DOM mutation monitoring. Optimized for YouTube and Twitch (where server-side ad insertion prevents network blocking).
- **Safety Exclusion Protocol**: Automatically excludes critical infrastructure, including financial institutions, authentication providers, and government domains (.gov) to ensure zero disruption to essential workflows.
- **Security-Hardened Architecture**: Features closure-scoped session state, validated config update pipelines, pristine API caching, and a dead man's switch to prevent host-page interference and script hijacking.
- **Recipe & Blog Optimization**: Provides specialized protection for high-clutter recipe and lifestyle sites. It prevents ad scripts from breaking site layouts, preserves recipe card content, and suppresses aggressive anti-adblock overlays and scroll-locks.
- **Dynamic Ad Acceleration**: Automatically identifies and accelerates video ads at a configurable speed (×4–×16, default ×8) on YouTube and Amazon Prime Video (Twitch uses server-side ad insertion and does not support ad acceleration), serving as a robust fallback when stripping is disabled.
- **Platform Compatibility**: Fully compatible with **Windows**, **macOS**, and **Linux** versions of **Google Chrome 120+** (and other Chromium-based browsers with engine version 120+). This version is required to support the 11-part static ruleset.

---

## Architecture Overview

Chroma utilizes a multi-layered execution model designed to survive the ephemeral lifecycle of Manifest V3 service workers while maintaining maximum performance and security.

**Diagram 1 — Page Execution Flow**

How Chroma operates inside the browser tab on every page load.

```mermaid
graph TD
    classDef main     fill:#fce4ec,color:#880e4f,stroke:#880e4f,stroke-width:2px
    classDef isolated fill:#e8f5e9,color:#1b5e20,stroke:#1b5e20,stroke-width:2px
    classDef dom      fill:#fff9c4,color:#f57f17,stroke:#f57f17,stroke-width:2px
    classDef actor    fill:#eceff1,color:#263238,stroke:#263238,stroke-width:2px

    INTERNET["The Internet"]:::actor

    subgraph MW["Main World (Page Context)"]
        INTERCEPT["interceptor.js"]:::main
        YT_H["yt_handler.js"]:::main
        PRM_H["prm_handler.js"]:::main
        RECIPES["recipes.js"]:::main
        SCRIPTS["Matched Scriptlets"]:::main
    end

    subgraph IW["Isolated World (Extension Context)"]
        PROT["protection.js"]:::isolated
        CONT["content.js"]:::isolated
    end

    PAGE["Page / Media Players"]:::dom
    USER["User"]:::actor

    INTERNET --> MW
    INTERNET --> IW

    PROT <-->|"Handshake & Config"| INTERCEPT
    INTERCEPT -->|"API Bridge"| YT_H
    INTERCEPT -->|"API Bridge"| PRM_H

    YT_H -->|"Stripped / Accelerated"| PAGE
    PRM_H -->|"Accelerated"| PAGE
    RECIPES -->|"Layout Protection"| PAGE
    CONT -->|"CSS / DOM Cleanup"| PAGE
    SCRIPTS -->|"Surgical Patching"| PAGE

    PAGE --> USER

    style MW fill:none,stroke:#880e4f,stroke-width:1px,stroke-dasharray:4
    style IW fill:none,stroke:#1b5e20,stroke-width:1px,stroke-dasharray:4
```

---

**Diagram 2 — Background & Network Flow**

How Chroma manages rules, storage, and network-level blocking from the service worker.

```mermaid
graph TD
    classDef sw      fill:#e1f5fe,color:#01579b,stroke:#01579b,stroke-width:2px
    classDef storage fill:#fff3e0,color:#e65100,stroke:#e65100,stroke-width:2px
    classDef dnr     fill:#ede7f6,color:#311b92,stroke:#311b92,stroke-width:2px
    classDef actor   fill:#eceff1,color:#263238,stroke:#263238,stroke-width:2px

    INTERNET["The Internet"]:::actor

    subgraph SW["Service Worker"]
        BG["background.js"]:::sw
        SUBS["subscriptions/"]:::sw
        SCRPT["scriptlets/engine.js"]:::sw
    end

    POPUP["popup.js"]:::sw
    STORAGE[("chrome.storage")]:::storage
    DNR["DNR Rulesets"]:::dnr
    USER["User"]:::actor

    INTERNET -->|"Requests"| DNR
    BG <--> STORAGE
    BG <-->|"Manage Rules"| DNR
    SUBS -->|"Deduplicated Rules"| DNR
    SUBS <-->|"Fetch & Cache"| STORAGE
    SCRPT -->|"Register userScripts"| USER
    POPUP <-->|"Config & Stats"| STORAGE

    DNR -->|"Filtered Traffic"| USER

    style SW fill:none,stroke:#01579b,stroke-width:1px,stroke-dasharray:4
```

---

## System Layers

### Layer 1: Network-Level Blocking (rules/, background.js, subscriptions/)
The primary engine of Chroma, powered by the Declarative Net Request (DNR) API. Chroma partitions its blocking logic into an 11-part system (10 primary sets + 1 specialized recipe layer) covering over 290,000 domain-level block rules. 

#### Why 290,000+ Rules Do Not Impact Performance
Users often wonder how a database of nearly 300,000 rules can operate without slowing down the browser. Chroma achieves this through three key architectural advantages:
- **Engine-Level Matching**: Unlike legacy ad-blockers that use the `webRequest` API (which requires waking up a JavaScript process for every single network request), DNR rules are handed off to the browser's core C++ networking engine. Matching happens at the system level before the request even leaves the browser.
- **Binary Pre-Optimization**: Upon installation and update, Chromium compiles these JSON rulesets into a highly optimized binary format (similar to a Bloom filter). This allows the browser to perform "O(1)" or near-instant lookups regardless of whether there are 10 rules or 300,000.
- **Zero JS Overhead**: Because the matching logic lives outside of the extension's execution context, there is no main-thread contention. Your CPU remains free for page rendering while the networking stack silently drops ad-related packets.
- **Deduplication Budgeting**: Subscription rules from Hagezi Pro Mini are automatically deduplicated against the static ruleset on each refresh. This ensures that the dynamic rule budget is reserved only for unique, high-priority threats.


### Layer 2: YouTube Ad Stripping (yt_handler.js)
A specialized surgical layer designed specifically for YouTube. It intercepts raw JSON responses from the YouTube API and surgically removes ad metadata (e.g., `adPlacements`, `playerAds`) before the player reads them. This results in a seamless, ad-free experience without pauses or the need for playback acceleration. Session state is fully private to the handler closure — host-page scripts cannot observe or tamper with internal state.

### Layer 3: Scriptlet Injection (scriptlets/engine.js)
The advanced surgical layer of the extension, migrated to the high-performance `chrome.userScripts` API. This engine parses complex scriptlet rules from filter list subscriptions, including uBlock Origin and AdGuard aliases. Key capabilities include:
- **JSON Pruning**: Uses strict dot-notation path pruning (`json-prune`) to intercept and clean dynamic data payloads in `JSON.parse` calls.
- **Regex Translation**: Features a built-in pre-processor that translates uBO network-style patterns (e.g., `||example.com^`) into optimized JavaScript RegExp strings for runtime matching.
- **Flexible Execution Timing**: Supports explicit timing flags (`document_start`, `document_idle`, `document_end`), ensuring scriptlets execute at the optimal lifecycle moment (defaulting to `document_start` for critical API tampering).
- **Broad Compatibility**: Supports a wide range of scriptlets including `abort-on-property-read`, `set-constant`, `prevent-fetch`, and `no-eval-if`.

### Layer 4: Cosmetic & Warning Suppression (content.js)
Utilizes a high-performance MutationObserver and CSS injection via Constructable Stylesheets. This layer hides ad slots, removes unsolicited overlay dialogs that restrict content access based on browser configuration, and cleans up the UI by removing non-video components like Shorts, Merchandise, and Movie/TV offers.

### Layer 5: Universal Protection (protection.js, interceptor.js)
A proactive security layer that maintains extension integrity across execution contexts. `interceptor.js` runs in the Main World to shadow sensitive browser APIs and expose the secure `__CHROMA_INTERNAL__` bridge. `protection.js` reads stored configuration at page load, dispatches the `__EXT_INIT__` document event to signal the MAIN world handlers, and relays live config updates from the background to the MAIN world handlers via CustomEvent.

### Layer 6: Recipe & Blog Protection (recipes.js)
A specialized defense-in-depth layer optimized for high-clutter recipe and lifestyle blogs (e.g., CafeMedia/Raptive and Dotdash Meredith sites). It implements a multi-pronged strategy to ensure a clean reading experience:
- **Style Protection**: Prevents aggressive anti-adblock scripts from stripping `<style>` and `<link>` elements, ensuring the site's layout remains intact.
- **Recipe Content Preservation**: Uses semantic and container-based exclusion to ensure that ingredients and instructions are never accidentally hidden by cosmetic filters.
- **Anti-Adblock Containment**: Neutres known anti-adblock recovery payloads in script handlers and redirects, and suppresses intrusive alert/confirm dialogs.
- **Scroll Lock Recovery**: Dynamically detects and reverses scroll-locks (e.g., `overflow: hidden`) and body-hiding tactics used by ad-block walls.
- **Site-Specific Rules**: Includes custom cosmetic overrides for major platforms like AllRecipes, Food Network, NYT Cooking, and Serious Eats.

### Layer 7: Dynamic Ad Acceleration (prm_handler.js, yt_handler.js)
A robust fallback and specialized layer for Amazon Prime Video and YouTube (when stripping is disabled). **Shipped in an OFF state by default**, it detects active ads and accelerates them at a configurable speed (×4–×16, default ×8) while synchronizing with a custom overlay to deliver a seamless transition.

---

## Privacy & Transparency

Chroma processes everything locally — no data is ever sent to Chroma's servers because there are none. However, to maintain compatibility with certain websites, Chroma includes a small set of **Allow Rules** that permit specific, standard ad-measurement requests to reach their intended destinations. These rules are scoped exclusively to the supported streaming platform as the initiator domain.

Chroma does not intercept or store any data from these requests. For a full explanation of this tradeoff, see the [Privacy Policy](docs/PRIVACY_POLICY.md).

---

## Why Not the Chrome Web Store?

Ad-blocking in the modern web is a high-stakes "cat-and-mouse" game where trust is the most valuable currency. Chroma is deliberately **not** hosted on the Chrome Web Store, and it never will be. This is a strategic decision rooted in transparency and technical freedom:

### 1. Conflict of Interest
Google is an advertising company first. As the gatekeeper of the Chrome Web Store, they have an inherent conflict of interest regarding tools that neutralize their primary revenue stream. By remaining independent, Chroma is not subject to arbitrary policy changes, forced feature deprecations, or the risk of sudden removal that "authorized" blockers frequently face.

### 2. Full Auditability (Zero Obfuscation)
Web Store extensions often arrive as "black boxes" with bundled or obfuscated code. Chroma is distributed as raw, human-readable source code. By loading it as an unpacked extension, you (and the community) can audit every single line of JavaScript. There are no hidden analytics, no telemetry backdoors, and no "Acceptable Ads" programs that allow paid bypasses.

### 3. Unrestricted API Power
Chroma utilizes advanced, performance-heavy APIs—such as the `userScripts` engine and high-volume `declarativeNetRequest` rule-sets—that are often restricted, capped, or heavily throttled for Web Store submissions. Bypassing the store allows us to use the browser's full hardware-acceleration capabilities without corporate handcuffs.

### 4. Zero-Day Hotfixes
When YouTube or other platforms update their ad-delivery algorithms, we can push a hotfix to GitHub in minutes. Web Store reviews can take days or even weeks. In the world of ad-blocking, a three-day delay is an eternity. Staying off the store ensures that you are always running the most potent version of the engine.

> [!IMPORTANT]
> Sideloading an extension requires a higher level of trust. We encourage you to review the [Permissions](#permissions) and [Security Hardening](#security-hardening) sections to understand exactly how Chroma protects your session.

---

## Media Proxy Router (Split-Tunneling)

Chroma includes a built-in split-tunnel proxy router that allows you to route traffic for specific domains through a proxy server while keeping the rest of your browser traffic on your direct, local connection. This operates entirely within the browser via dynamic Proxy Auto-Configuration (PAC) scripts, meaning it does not require a system-level VPN installation.

### Supported Protocols
Chroma supports `HTTP`, `HTTPS`, and `SOCKS5` proxies. You can force a specific protocol by adding a prefix to the proxy host (e.g., `https://` or `socks5://`). In the popup UI, entering a `.com` host without a protocol will automatically default to `https://`. Otherwise, it defaults to standard `HTTP` (PROXY).

### Security
Your proxy credentials (username and password) are encrypted locally using AES-256-GCM via the native Web Crypto API before being stored to disk. They are decrypted dynamically in-memory only when the proxy server challenges the browser for authentication, providing excellent obfuscation against disk-level inspection.

### Connection Verification
The Chroma popup includes a live **Connection Verification** system. When a proxy is active, the extension periodically verifies connectivity to the proxy server and displays a status indicator (Connected/Offline) along with your current proxied IP address. 

### Example: Setting up NordVPN
Many commercial VPN providers (like NordVPN, ExpressVPN, and PIA) operate browser-compatible proxy servers. Here is how to route specific domains through a NordVPN server (e.g., Albania #80):

1. **Host:** Enter `https://al80.nordvpn.com` *(Note the `https://` prefix, as NordVPN requires encrypted HTTPS proxies)*
2. **Port:** Enter `89` *(NordVPN's official HTTPS proxy port)*
3. **Username & Password:** You **cannot** use your standard NordAccount email/password. You must use your auto-generated **Service Credentials**, which can be found in your NordAccount dashboard under *Services > NordVPN > Manual Setup*.
4. **Domains:** Add the domains you want to route (e.g., `youtube.com`) to the active list.
5. Click **Accept Settings**.

### Smart-Link Auto-Expansion
To prevent "infinite spin" and geo-blocking issues caused by IP mismatches between a site's UI and its video delivery network, Chroma includes a **Smart-Link** system. When you add a major streaming service to your proxy list, Chroma automatically identifies and proxies its associated media delivery networks (CDNs).

For example, adding `youtube.com` automatically proxies `googlevideo.com`, `ytimg.com`, and `youtube-nocookie.com`, ensuring that the video stream itself originates from the same proxy IP as your main session. Supported services include:
- **YouTube** (`googlevideo.com`, `ytimg.com`, `ggpht.com`, `youtube-nocookie.com`, `nhacmp3abc.com`)
- **Netflix** (`netflix.net`, `nflxvideo.net`, `nflxext.com`, `nflximg.com`, `nflximg.net`, `nflxso.net`, `nflxsearch.net`)
- **Amazon Prime Video** (`amazonvideo.com`, `primevideo.com`, `aiv-cdn.net`, `pv-cdn.net`, `aiv-delivery.net`, `media-amazon.com`, `ssl-images-amazon.com`, + all global TLDs like `.de`, `.co.jp`)
- **Twitch** (`ttvnw.net`, `jtvnw.net`, `twitchcdn.net`)
- **Disney+** (`disney-plus.net`, `dssott.com`, `dssedge.com`, `bamgrid.com`, `disney-plus.com`)
- **Hulu** (`hulumail.com`, `huluim.com`, `hulu.hbomax.com`)
- **Max (HBO)** (`hbomax.com`, `hbo.com`, `hbonow.com`, `hbogo.com`)
- **Spotify** (`scdn.co`, `spotify.net`, `audio-ak-spotify-com.akamaized.net`)

---

## YouTube Ad Stripping (The "Stripper")

Chroma features a high-performance **YouTube Ad Stripper** that provides a superior alternative to traditional ad blocking and acceleration. 

### How it Works
Instead of reacting to ads after they appear, the Stripper operates at the data layer. It intercepts communication between your browser and YouTube's internal API (`/youtubei/v1/player`, `/next`, etc.) and surgically removes ad-related metadata before the YouTube player can process it.

- **Upstream Neutralization**: By deleting fields like `adPlacements`, `adSlots`, and `playerAds` from the raw JSON responses, the Stripper makes the YouTube player believe the video is entirely ad-free.
- **Seamless Viewing Experience**: Because the ads are "stripped" before they ever load, there is no "Ad starting in 5 seconds" countdown, no black screens, and no need for the acceleration engine to kick in.
- **Payload Interception**: It utilizes deep hooks into `window.fetch`, `XMLHttpRequest`, and `JSON.parse` to ensure that even batched or worker-side requests are cleaned of ad data.
- **Feed & Search Optimization**: Beyond the video player, it strips promoted "Sparkles" ads, suggested products, and sponsored results from your home feed and search results.

> [!TIP]
> While "Ad Acceleration" is still available as a fallback, the **Stripper** is the recommended method for a seamless, "native" YouTube experience. The stripper will always have a slight delay (inherent to how the YouTube player processes ad-free data), but will never show mid-roll ads. Because a proxy payload contains no ad-data from the start, it remains the only true zero-delay solution. 

---

## Permissions

Chroma requests the following permissions. Each is required for a specific, documented purpose.

| Permission | Reason |
|---|---|
| `declarativeNetRequest` | Enables and manages the static and dynamic DNR rulesets that perform network-level ad and tracker blocking at the browser engine level. |
| `declarativeNetRequestFeedback` | Allows the service worker to read which rules fired, used to collect per-session blocking statistics displayed in the popup. |
| `storage` | Base API required to persist user configuration and subscription metadata across sessions. |
| `unlimitedStorage` | Chrome's default `chrome.storage.local` cap is 10 MB — insufficient for Chroma's runtime needs. Storage holds cached subscription rule sets (Hagezi Pro Mini alone can approach this limit), the static deduplication index, blocking statistics, and user configuration. No storage is used to collect or transmit user data. |
| `tabs` | Required to read the active tab's URL for whitelist matching in the popup and to reload the tab when the whitelist is toggled. |
| `alarms` | Powers the 24-hour subscription refresh cycle. Chrome MV3 service workers are ephemeral and cannot use `setInterval` — `chrome.alarms` is the only reliable timer mechanism available. |
| `userScripts` | The primary API for the scriptlet engine. Allows registered scriptlets to execute in the page's MAIN world context with optimal performance and native lifecycle management. |
| `scripting` | Used for supplemental on-demand script injection and legacy compatibility. |
| `proxy` | Enables the split-tunnel proxy router and PAC script generation for domain-specific routing. |
| `webRequest` | Used to intercept authentication challenges from proxy servers. |
| `webRequestAuthProvider` | Required to provide credentials to proxy servers via the `onAuthRequired` listener. |

---

## Security Hardening

Chroma implements several advanced security measures to ensure extension integrity and prevent bypass by third-party scripts:

- **Closure-Scoped Session State**: All session tracking variables in the acceleration handlers are private to the IIFE closure. Host-page scripts cannot read or modify acceleration state, session flags, or ad counters.
- **Config Update Validation**: All incoming configuration updates — whether from the popup or a `__CHROMA_CONFIG_UPDATE__` CustomEvent — are validated against a strict key allowlist with type and range checks. Invalid values are silently rejected before reaching the internal config object.
- **Immutable API Bridge**: Exposes internal utilities via a locked `__CHROMA_INTERNAL__` object. This bridge is protected using `Object.defineProperty` with `writable: false` and `configurable: false`, preventing host pages from hijacking extension logic.
- **Pristine API Caching**: `interceptor.js` captures and freezes native browser APIs (such as `querySelector`, `setTimeout`, and `Function.prototype.toString`) immediately at `document_start`. This ensures that even if a site attempts prototype pollution, the extension operates using trusted, original functions.
- **Dead Man's Switch**: If core native APIs fail integrity checks at startup, the interceptor severs its secure port and falls back to safe defaults rather than operating in a potentially compromised environment.
- **Sentinel Hardening**: Internal activation state is managed via a private `WeakMap` within the handler closure. This prevents host-page scripts from observing or tampering with the extension's lifecycle markers once initialization is complete.
- **Secure Config Handshake**: A secure, capture-phase handshake establishes a private communication pipeline (`MessageChannel`) between the Main World and the protected background. This allows for the delivery of verified configuration and selector sets via a randomized, per-session port transfer nonce, ensuring that sensitive data remains inaccessible to page scripts.
- **Origin Authentication**: The Background Service Worker strictly validates the origin and sender context of all incoming messages, rejecting sensitive data or configuration requests from outside the extension's verified context.

---

## Quick Start

1. Get the latest release from [GitHub](https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/latest), and extract the ZIP file.
2. Open `chrome://extensions` in Chrome.
3. Toggle on **Developer Mode** in the top-right corner.
4. Click **Load unpacked** and select the `extension/` folder inside the extracted directory.
5. Done — Chroma is active on all tabs. Pin it from the extensions menu to access the popup.

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `enabled` | Global switch for all features. | `true` |
| `networkBlocking` | Enables DNR ruleset blocking. | `true` |
| `stripping` | Enables YouTube Ad Stripping (the primary blocker). | `true` |
| `acceleration` | Enables accelerated ad playback (as a fallback). | `false` |
| `accelerationSpeed` | Playback rate multiplier for accelerated ads (×4, ×8, ×12, or ×16). | `8` |
| `cosmetic` | Enables hiding ad placeholders via CSS. | `true` |
| `hideShorts` | Removes Shorts component modules. | `false` |
| `hideMerch` | Removes Merchandise panels. | `true` |
| `hideOffers` | Removes Movie/TV offer modules. | `true` |
| `suppressWarnings` | Removes unsolicited overlay dialogs that restrict content access. | `true` |
| `whitelist` | Toggles blocking for the current domain. | `false` |

---

## AI Usage & Quality Assurance Disclosure

Portions of this codebase, including initial logic structures and documentation, were developed with the assistance of agentic AI coding assistants. To ensure project integrity, every AI-assisted component has been manually audited, refactored, and verified to meet strict security and performance standards. This collaborative approach combines the efficiency of advanced tooling with focused oversight and robust test coverage.

---

## Third-Party Credits

Chroma utilizes logic and patterns derived from the following open-source projects:

- **Brave Browser** — The YouTube ad-stripping logic (payload metadata pruning) is derived from Brave's ad-blocking scriptlets ([MPL 2.0](https://mozilla.org/MPL/2.0/)).
- **Hagezi Pro Mini** by [hagezi](https://github.com/hagezi/dns-blocklists) — [MIT License](https://github.com/hagezi/dns-blocklists/blob/main/LICENSE)
- **Peter Lowe's List** by [Peter Lowe](https://pgl.yoyo.org/adservers/) — [Terms of Use](https://pgl.yoyo.org/adservers/policy.php)

## Filter List Subscriptions

Chroma subscribes to the following lists to ensure real-time protection:

- **Chroma Hotfix** — Maintainer-controlled list for platform-specific overrides.
- **Hagezi Pro Mini** — High-performance DNS and ad-blocking rules.
- **EasyList** — The primary filter for cosmetic ad-blocking and element hiding.
- **Fanboy Annoyance** — Blocks social widgets, popups, and other non-ad annoyances.

> [!NOTE]
> To maximize performance and respect Manifest V3 rule limits, **EasyList** and **Fanboy Annoyance** are utilized exclusively for the **Cosmetic Filtering Layer**. Network-level blocking is handled by the high-efficiency static ruleset and Hagezi Pro Mini.

---

## Recommended Extensions

Chroma is not affiliated with the following extensions, but I use them daily in tandem with Chroma for the ultimate browsing experience:

- **[Privacy Badger](https://chromewebstore.google.com/detail/privacy-badger/pkehgijcmpdhfbdbbnkijodmdjhbjlgp)** — A privacy-focused extension that blocks invisible trackers.
- **[SponsorBlock](https://chromewebstore.google.com/detail/sponsorblock-for-youtube-s/mnjggcdmjocbbbhaepdhchncahnbgone)** — Skip sponsor segments and other interruptions on YouTube.

---

## Legal Disclaimers

**Trademark Disclaimer:** YouTube is a trademark of Google LLC. Amazon Prime Video is a trademark of Amazon.com, Inc. Chroma Ad-Blocker is an independent project and is NOT affiliated with, endorsed by, or sponsored by Google LLC, YouTube, Amazon.com, Inc., or any other third-party platform.

**Usage Warning:** Using ad-blockers or ad-acceleration tools may violate the Terms of Service of various platforms. By using Chroma, you acknowledge and assume all risks associated with potential account restrictions or enforcement actions.

---

## Security Policy

For information on how to report security vulnerabilities, please see our [Security Policy](docs/SECURITY.md).

---

## Support the Project

Chroma is a solo project dedicated to restoring the web to its fast, private, and uninterrupted roots. It is 100% free for everyone, forever. If this tool has made your daily browsing a little more colorful, consider supporting this mission.

<div align="center">
  <a href="https://buymeacoffee.com/dabrogost">
    <img src="https://img.shields.io/badge/Buy_Me_a_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee">
  </a>
</div>

<p align="right">
  <sub>Copyright 2026 Dabrogost</sub>
</p>
