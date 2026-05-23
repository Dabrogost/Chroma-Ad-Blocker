# Chroma Documentation

This directory is the long-form home for Chroma Ad-Blocker. The root [README](../README.md) is the public front door; these docs preserve the deeper implementation notes, trust model, configuration details, and project rationale.

## Start Here

- [Installation & Configuration](INSTALL.md) - install Chroma, enable User Scripts, troubleshoot common setup issues, review settings, and understand the Health panel.
- [Feature Guide](FEATURES.md) - expanded feature descriptions for the protection layers, local controls, privacy hardening, and user workflows.
- [Architecture Deep Dive](ARCHITECTURE.md) - diagrams, MV3 execution model, service-worker flow, system layers, and request-path boundaries.
- [Media Proxy Router](MEDIA_PROXY_ROUTER.md) - split-tunnel proxy routing, Global Fallback, Smart-Link expansion, protocol support, WebRTC behavior, and provider setup notes.
- [YouTube Protection](YOUTUBE.md) - YouTube payload stripping, Sponsored Shorts cleanup, feed/search cleanup, and acceleration fallback behavior.
- [Filter List Subscriptions](FILTER_LISTS.md) - bundled and remote list behavior, custom subscriptions, MV3 rule allocation, and third-party credits.

## Trust, Privacy, And Security

- [Permissions](PERMISSIONS.md) - each requested extension permission and why it exists.
- [Privacy Policy](PRIVACY_POLICY.md) - local storage, no Chroma telemetry, optional network requests, and third-party service boundaries.
- [Security Policy](SECURITY.md) - disclosure process, remote list trust boundary, isolated-to-MAIN handshake, and security hardening notes.
- [Statistics & Health](STATISTICS.md) - local Protection Intelligence, privacy modes, retention, reset/export behavior, and diagnostics.
- [Terms of Service](ToS.md) - use terms and legal disclaimers.

## Development And Releases

- [Contributing](CONTRIBUTING.md) - contribution ground rules and local PR expectations.
- [Testing](TEST_GUIDE.md) - Node tests, policy tests, and Chrome for Testing / Chromium E2E guidance.
- [Distribution](DISTRIBUTION.md) - packaging the extension ZIP and release checks.

## Project Context

- [Project Philosophy](PROJECT_PHILOSOPHY.md) - why Chroma exists, why it is not on the Chrome Web Store, companion extensions, alternatives, AI disclosure, and legal notes.
