# Project Philosophy

Chroma is a practical extension, but it is also a response to a specific browser-platform reality: Chrome ad blocking now lives inside Manifest V3.

## Why I Made This

Most Chrome ad blockers break often because the ground underneath them changed. Manifest V3 is not a temporary detour; for Chrome and most Chromium-based browsers, it is the platform reality now.

Chromium has other browser vendors, but Google still drives the upstream platform that Chrome and most Chromium-based browsers inherit. Edge, Vivaldi, and others can patch or work around parts of that stack, but they do not make MV2-style Chrome extension blocking the durable default for Chrome users.

Chroma exists because I wanted a blocker designed for that reality instead of fighting yesterday's API forever. It leans into MV3-native tools like Declarative Net Request, `userScripts`, local rule subscriptions, targeted scriptlets, and platform-specific handlers.

The goal is not to be the biggest blocker or the loudest blocker. The goal is to be more robust when sites change, transparent about what it does, and auditable through release packages.

Chroma is my answer to a simple problem: if Chrome ad blocking is going to live inside MV3, then the blocker should be built like it knows that.

## Recommended Companion Extensions

Chroma already includes network blocking, cosmetic filtering, scriptlets, proxy routing, and platform-specific handling, so I do not recommend stacking it with another ad blocker by default. Layering multiple content blockers can cause overlapping rules, false positives, and broken pages.

Extensions that do something different from ad blocking can still pair well with Chroma. A favorite example is:

- **[SponsorBlock](https://chromewebstore.google.com/detail/sponsorblock-for-youtube-s/mnjggcdmjocbbbhaepdhchncahnbgone)**: Skips sponsor segments and other interruptions on YouTube.

## Recommended Alternatives

Chroma is built for users who want a transparent, source-auditable, Chrome/Chromium-focused MV3 extension with integrated proxy routing, YouTube ad stripping, custom subscriptions, and no store-mediated update delay. If that fits your workflow, Chroma is the right tool.

If you prefer a store-installed extension, a Firefox-first setup, or a dedicated proxy manager, these are the alternatives I trust most:

- **Chrome / Chromium:** [uBlock Origin Lite](https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh?hl=en) + [FoxyProxy](https://chromewebstore.google.com/detail/foxyproxy/gcknhkkoolaabfmlnjonogaaifnjlfnp?hl=en). Recommended for users who want the Chrome Web Store path. uBlock Origin Lite comes from the uBlock Origin project and is a more reputable choice than most generic store ad blockers. FoxyProxy adds focused proxy management without bundling unrelated ad-blocking behavior.
- **Firefox:** [uBlock Origin](https://addons.mozilla.org/firefox/addon/ublock-origin/) + [FoxyProxy](https://getfoxyproxy.org/). Recommended for users who want the strongest traditional content-blocking setup. Full uBlock Origin has more browser API power on Firefox than MV3 Chrome blockers, and FoxyProxy is a mature, dedicated proxy-routing tool.

## Why Not The Chrome Web Store?

Ad blocking on the modern web changes quickly, and trust is the most valuable currency. Chroma is deliberately not hosted on the Chrome Web Store. This is a strategic decision rooted in transparency and technical freedom.

### Conflict Of Interest

Google is an advertising company first. As the gatekeeper of the Chrome Web Store, it has an inherent conflict of interest regarding tools that neutralize its primary revenue stream.

By remaining independent, Chroma is not subject to arbitrary policy changes, forced feature deprecations, or the risk of sudden removal that authorized blockers can face.

### Full Auditability

Web Store extensions often arrive as bundled packages that are harder for ordinary users to inspect. Chroma is distributed as raw, human-readable source code. By loading it as an unpacked extension, users and contributors can audit the JavaScript that is actually running.

There are no hidden analytics, telemetry backdoors, or Acceptable Ads-style paid bypass programs.

### Unrestricted API Power

Chroma uses advanced MV3 APIs such as the `userScripts` engine and high-volume `declarativeNetRequest` rulesets. Staying release-package based keeps those capabilities transparent and source-auditable without waiting on store review cycles.

### Fast GitHub Releases

When YouTube or other platforms update their ad-delivery algorithms, Chroma can ship a reviewed GitHub release package quickly. Web Store reviews can take days or weeks. In ad blocking, that delay matters.

Staying off the store helps keep the engine responsive to platform changes while keeping maintainer changes tied to inspectable releases.

> [!IMPORTANT]
> Sideloading an extension requires a higher level of trust. Review [Permissions](PERMISSIONS.md), [Privacy Policy](PRIVACY_POLICY.md), and [Security Policy](SECURITY.md) before installing.

## AI Usage & Quality Assurance Disclosure

Portions of this codebase, including initial logic structures and documentation, were developed with the assistance of agentic AI coding assistants. To ensure project integrity, every AI-assisted component has been manually audited, refactored, and verified to meet strict security and performance standards.

This collaborative approach combines the efficiency of advanced tooling with focused oversight and robust test coverage.

## Legal Disclaimers

**Trademark Disclaimer:** YouTube, Google, and Chrome are trademarks of Google LLC. Amazon and Amazon Prime Video are trademarks of Amazon.com, Inc. Twitch is a trademark of Twitch Interactive, Inc. Netflix is a trademark of Netflix, Inc. Spotify is a trademark of Spotify AB. Disney+ is a trademark of Disney Enterprises, Inc. Hulu is a trademark of Hulu, LLC. Max and HBO are trademarks of Home Box Office, Inc. NordVPN is a trademark of Nord Security. ExpressVPN and Private Internet Access are trademarks of their respective owners. Brave is a trademark of Brave Software, Inc. All other trademarks, service marks, and company names mentioned are the property of their respective owners. Chroma Ad-Blocker is an independent project and is not affiliated with, endorsed by, or sponsored by any of these entities or their respective platforms.

**Usage Warning:** Using ad blockers, ad stripping, ad acceleration, or proxy routing tools may violate the Terms of Service of various platforms. By using Chroma, you acknowledge and assume all risks associated with potential account restrictions or enforcement actions.

---

Back to [Chroma Documentation](README.md)
