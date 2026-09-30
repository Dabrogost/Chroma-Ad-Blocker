# Chroma Documentation

Find setup instructions, feature guides, and project reference material for Chroma Ad-Blocker here. For an overview, see the [README](../README.md).

The **User Documentation** is also available in the [online Chroma Guide](https://dabrogost.github.io/Chroma-Ad-Blocker/) before installation and in Chroma's offline guide afterward. Both are generated from the same Markdown files listed below. Engineering, testing, and release documentation is intended for contributors.

<div align="center">
  <img src="assets/docs-settings-overview.png" alt="Chroma settings dashboard" width="760">
</div>

## User Documentation

- [Installation & Configuration](INSTALL.md) - install Chroma, use guided or manual updates, enable User Scripts, troubleshoot common setup issues, review settings, and understand the Health panel.
- [Feature Guide](FEATURES.md) - protection layers, local controls, privacy hardening, companion extensions, and alternatives.
- [YouTube Protection](YOUTUBE.md) - YouTube payload stripping, Sponsored Shorts cleanup, feed/search cleanup, and acceleration fallback behavior.
- [Spotify Protection](SPOTIFY.md) - independent web-player ad-media redirects, podcast exceptions, and playback troubleshooting.
- [Media Proxy Router](MEDIA_PROXY_ROUTER.md) - split-tunnel proxy routing, Global Fallback, Smart-Link expansion, protocol support, WebRTC behavior, and provider setup notes.
- [Filter List Subscriptions](FILTER_LISTS.md) - bundled and remote list behavior, custom subscriptions, MV3 rule allocation, and third-party credits.
- [Advanced User Scriptlets](ADVANCED_USER_SCRIPTLETS.md) - trusted user-provided scriptlet resources, linked rule status, examples, and troubleshooting.
- [Statistics & Health](STATISTICS.md) - local Protection Intelligence, privacy modes, retention, reset/export behavior, and diagnostics.
- [Permissions](PERMISSIONS.md) - each requested extension permission and why it exists.
- [Privacy Policy](PRIVACY_POLICY.md) - local storage, no Chroma telemetry, optional network requests, and third-party service boundaries.
- [Performance Guide](PERFORMANCE.md) - resource cost, service-worker lifecycle, page-side overhead, proxy routing, stats batching, and lower-overhead settings.
- [Terms of Service](ToS.md) - use terms and legal disclaimers.

## Engineering And Security Review (Repository Only)

- [Architecture Deep Dive](ARCHITECTURE.md) - diagrams, MV3 execution model, service-worker flow, system layers, and request-path boundaries.
- [Security Policy](SECURITY.md) - disclosure process, remote list trust boundary, isolated-to-MAIN handshake, and security hardening notes.
- [Threat Model](THREAT_MODEL.md) - adversaries, trust assumptions, defended cases, and explicit non-goals.

## Development And Releases (Repository Only)

- [Testing](TEST_GUIDE.md) - Node and policy tiers, CI smoke coverage, full Chrome for Testing / Chromium E2E, and browser-selection guidance.
- [Distribution](DISTRIBUTION.md) - local and required-signing package workflows, guided updater asset requirements, and release checks.
- [Contributing](CONTRIBUTING.md) - contribution ground rules and local PR expectations.
