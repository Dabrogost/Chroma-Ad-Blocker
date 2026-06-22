# Chroma Ad-Blocker

**Chroma Ad-Blocker** is a free, open-source Manifest V3 browser extension built for local, auditable ad blocking on Chrome and Chromium-based browsers. It combines browser-engine DNR blocking, YouTube payload stripping, scriptlets, cosmetic filtering, media-aware proxy routing, local statistics, and optional privacy hardening with no Chroma telemetry or browsing-data collection.

For best results, disable other ad-blocking extensions while using Chroma. Layering multiple blockers can cause overlapping rules, false positives, and broken pages.

## Documentation

- [Documentation Hub](docs/README.md)
- [Installation & Configuration](docs/INSTALL.md)
- [Feature Guide](docs/FEATURES.md)
- [Architecture Deep Dive](docs/ARCHITECTURE.md)
- [Performance Guide](docs/PERFORMANCE.md)
- [Media Proxy Router](docs/MEDIA_PROXY_ROUTER.md)
- [YouTube Protection](docs/YOUTUBE.md)
- [Filter List Subscriptions](docs/FILTER_LISTS.md)
- [Advanced User Scriptlets](docs/ADVANCED_USER_SCRIPTLETS.md)
- [Permissions](docs/PERMISSIONS.md)
- [Statistics & Health](docs/STATISTICS.md)
- [Privacy Policy](docs/PRIVACY_POLICY.md)
- [Security Policy](docs/SECURITY.md)
- [Threat Model](docs/THREAT_MODEL.md)
- [Testing Guide](docs/TEST_GUIDE.md)
- [Distribution Notes](docs/DISTRIBUTION.md)
- [Contributing](docs/CONTRIBUTING.md)
- [Terms of Service](docs/ToS.md)
- [Project Philosophy](docs/PROJECT_PHILOSOPHY.md)

## Key Features

- **[YouTube Ad Stripping](docs/YOUTUBE.md)**: Removes ad-related metadata from YouTube JSON payloads before the player reads them, including sponsored Shorts overlay payloads.
- **[Split-Tunnel Proxy Router](docs/MEDIA_PROXY_ROUTER.md)**: Routes selected media domains through HTTP, HTTPS, SOCKS4, or SOCKS5 proxies while keeping unrelated browser traffic direct. Includes Global Fallback, Smart-Link media/CDN expansion, connection verification, WebRTC leak protection, and local-only proxy credential handling.
- **[Source-Generated DNR Network Blocking](docs/ARCHITECTURE.md#layer-1-network-level-blocking-extensionrules-extensionbackgrounddnrstatejs-extensionsubscriptions)**: Uses generated OISD Big static rules, a protected custom static layer, recipe-specific rules, and runtime dynamic rules to block trackers, invasive analytics, and traditional banner ads at the browser engine level.
- **[Live Filter List Subscriptions](docs/FILTER_LISTS.md)**: Supports Hagezi Pro Mini, EasyList, Fanboy Annoyance, the bundled Chroma Scriptlet Library, and user-added custom lists with local parsing and rule-budget allocation.
- **[Scriptlet Injection Engine](docs/ARCHITECTURE.md#layer-2-scriptlet-injection-scriptletsenginejs)**: Translates supported uBlock Origin and AdGuard-style scriptlets into native JavaScript, and lets advanced users add [trusted uBO-style scriptlet resources](docs/ADVANCED_USER_SCRIPTLETS.md) through Chrome's `userScripts` API.
- **[Quiet Console](docs/FEATURES.md#quiet-console)**: Optional DevTools noise reduction for handled scriptlet/fingerprint warnings and known ad/tracker request paths.
- **[Cosmetic Filtering & Element Zapper](docs/FEATURES.md#element-zapper)**: Removes ad slots, placeholders, unwanted UI, warnings, and user-selected page elements through CSS injection, DOM monitoring, and local cosmetic rules.
- **[Privacy Hardening & Fingerprint Randomization](docs/FEATURES.md#privacy-hardening-fingerprint-randomization)**: Optional controls for third-party cookies, Privacy Sandbox ad APIs, geolocation access, WebRTC routing behavior, and per-document fingerprint farbling.
- **[Local Event Tracker](docs/STATISTICS.md)**: A local-only Protection Intelligence dashboard for network, cleanup, scriptlet, proxy, and payload-cleanup events.
- **[Security-Hardened Architecture](docs/SECURITY.md)**: Uses closure-scoped state, validated config updates, origin checks, pristine API caching, and an isolated-to-MAIN `MessageChannel` handshake.

## Quick Start

1. Get the latest release from [GitHub Releases](https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/latest), and extract the ZIP file.
2. Open `chrome://extensions` in Chrome.
3. Toggle on **Developer Mode** in the top-right corner.
4. Click **Load unpacked** and select the extracted folder that contains `manifest.json`.
5. Enable User Scripts support:
   - **Chrome 138+**: On the Chroma extension card, click **Details**, then enable **Allow User Scripts**.
   - **Chrome 122-137**: The **Developer Mode** toggle from step 3 enables the `userScripts` API.
6. Done. Chroma is active on all tabs. Pin it from the extensions menu to access the popup.

When a newer GitHub release is available, Chroma can guide unpacked-extension updates from **Settings -> Updates** if the release includes the exact direct ZIP asset and signed `updates.json`. Chroma fetches those release assets internally, so users do not manually download `updates.json` and the extension does not need Chrome's download permission or download dialog. It verifies the update signature and package hash, builds a dry-run install plan, probes folder write access, backs up changed files, writes `manifest.json` last, and then shows a **Reload Chroma** action to load the updated files.

For the expanded install and update flow, troubleshooting table, configuration reference, and Health panel notes, see [Installation & Configuration](docs/INSTALL.md).

## Architecture At A Glance

Chroma is built around a layered MV3 model. Browser-engine DNR rules handle request blocking without waking extension JavaScript for every request. Content scripts handle cosmetic cleanup in the isolated world. MAIN-world handlers are used only where needed for platform-specific interception, scriptlets, optional fingerprint randomization, and media handling.

```mermaid
graph TD
    classDef ext fill:#e8f5e9,color:#1b5e20,stroke:#1b5e20,stroke-width:2px
    classDef main fill:#fce4ec,color:#880e4f,stroke:#880e4f,stroke-width:2px
    classDef page fill:#fff9c4,color:#f57f17,stroke:#f57f17,stroke-width:2px
    classDef actor fill:#eceff1,color:#263238,stroke:#263238,stroke-width:2px

    LOAD["Page load"]:::actor
    PAGE["Page DOM / Media Player"]:::page
    USER["User"]:::actor

    LOAD --> CONTENT["content.js<br/>all URLs, isolated world"]:::ext
    CONTENT -->|"cosmetic CSS + DOM cleanup"| PAGE

    LOAD --> MEDIA{"YouTube or Amazon/Prime?"}:::actor
    MEDIA -->|"yes"| BRIDGE["protection.js + interceptor.js<br/>secure config bridge"]:::main
    BRIDGE --> HANDLERS["yt_handler.js / prm_handler.js<br/>strip YouTube JSON or accelerate ads"]:::main
    HANDLERS --> PAGE

    LOAD --> SCRIPTLETS["Registered scriptlets / optional FPR<br/>MAIN world, matched by rule"]:::main
    SCRIPTLETS --> PAGE

    ZAP["Element zapper<br/>injected only from popup"]:::ext -->|"saved local cosmetic rule"| CONTENT

    PAGE --> USER
```

The full technical model, including service-worker flow, rule ownership, system layers, and security boundaries, lives in [Architecture Deep Dive](docs/ARCHITECTURE.md).

## Privacy & Transparency

Chroma processes core extension state locally. It does not operate telemetry, analytics, or tracking servers. Settings, whitelists, cached subscription rules, proxy settings, local statistics, request logs, and diagnostics remain in `chrome.storage.local`.

Some optional or normal features make external requests: remote filter-list updates, GitHub release checks, proxy connectivity tests, and user-configured proxy routes. These are documented in the [Privacy Policy](docs/PRIVACY_POLICY.md).

Chroma also includes limited allow rules for compatibility on specific supported sites. It does not intercept, store, or transmit data from those allowed requests.

For another account-level privacy improvement, open [Google My Ad Center](https://myadcenter.google.com) and turn **Personalized Ads** to **OFF**.

## Trust Model

Chroma is distributed through GitHub releases instead of the Chrome Web Store. That means installation requires a higher level of user trust, but it also keeps the release package source-auditable, enables a guided updater for exact release ZIP assets, and avoids store-mediated update delays for platform-specific fixes.

Review these before installing:

- [Permissions](docs/PERMISSIONS.md)
- [Privacy Policy](docs/PRIVACY_POLICY.md)
- [Security Policy](docs/SECURITY.md)
- [Threat Model](docs/THREAT_MODEL.md)
- [Project Philosophy](docs/PROJECT_PHILOSOPHY.md#why-not-the-chrome-web-store)

## Companion Extensions & Alternatives

Chroma already includes network blocking, cosmetic filtering, scriptlets, proxy routing, and platform-specific handling, so another ad blocker is not recommended by default. Extensions that do something different can still pair well with it, such as [SponsorBlock](https://chromewebstore.google.com/detail/sponsorblock-for-youtube-s/mnjggcdmjocbbbhaepdhchncahnbgone) for skipping sponsor segments on YouTube.

If you prefer a store-installed extension, a Firefox-first setup, or a dedicated proxy manager, see [Recommended Alternatives](docs/PROJECT_PHILOSOPHY.md#recommended-alternatives).

## Support The Project

Chroma is a solo project dedicated to restoring the web to its fast, private, and uninterrupted roots. It is 100% free for everyone, forever. If this tool has made your daily browsing a little more colorful, consider supporting the mission.

<div align="center">
  <a href="https://buymeacoffee.com/dabrogost">
    <img src="https://img.shields.io/badge/Buy_Me_A_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee">
  </a>
</div>

## Credits, License, And Disclaimers

Chroma uses logic and patterns derived from Brave Browser's YouTube ad-stripping scriptlets, Hagezi Pro Mini, and OISD Big. See [Filter List Subscriptions](docs/FILTER_LISTS.md#third-party-credits) for details.

Portions of this codebase, including initial logic structures and documentation, were developed with assistance from agentic AI coding assistants. Every AI-assisted component has been manually audited, refactored, and verified against the project's security and performance expectations.

YouTube, Google, Chrome, Amazon, Amazon Prime Video, Twitch, Netflix, Spotify, Disney+, Hulu, Max, HBO, NordVPN, ExpressVPN, PIA, Brave, and other names are trademarks of their respective owners. Chroma Ad-Blocker is an independent project and is not affiliated with, endorsed by, or sponsored by those entities.

Using ad blockers, ad stripping, proxy routing, or ad-acceleration tools may violate the terms of service of various platforms. By using Chroma, you acknowledge and assume those risks.

<p align="right">
  <sub>Copyright 2026 Dabrogost - GPL-3.0-or-later</sub>
</p>
