# YouTube Protection

Chroma's YouTube protection is designed around upstream payload cleanup rather than reacting to visible ads after the player has already started processing them.

## YouTube Ad Stripping

The YouTube Ad Stripper intercepts communication between your browser and YouTube's internal APIs, including `/youtubei/v1/player`, `/next`, and related endpoints. It surgically removes ad-related metadata before the YouTube player can process it.

Instead of waiting for an ad to appear and then speeding it up or hiding it, the stripper tries to make the player receive a cleaned payload from the beginning.

## How It Works

- **Upstream Neutralization**: Deletes fields such as `adPlacements`, `adSlots`, and `playerAds` from raw JSON responses before the player reads them.
- **Seamless Viewing Experience**: Because ads are stripped before they load, there is no ad countdown, black-screen wait, or need for the acceleration engine in the ideal path.
- **Payload Interception**: Uses hooks into `window.fetch`, `XMLHttpRequest`, and `JSON.parse` so batched or delayed requests can still be cleaned.
- **Feed & Search Optimization**: Strips promoted Sparkles ads, suggested products, and sponsored results from home feed and search payloads.
- **Sponsored Shorts Blocking**: Prunes sponsored Shorts payloads such as `adsOverlay`, `shortsAdsRenderer`, `sequenceItemInPlayerAdLayoutRenderer`, and `reelWatchEndpoint.adClientParams.isAd` before the Shorts player renders the sponsored overlay.

The stripper can still have a slight delay while YouTube processes cleaned data, and behavior can change when YouTube changes its delivery pipeline. Proxy-side ad-free payloads can reduce delay in supported setups because the payload starts without ad data.

## Relationship To Acceleration

Ad Acceleration remains available as a fallback, but stripping is the recommended method for a seamless YouTube experience.

Dynamic Ad Acceleration ships off by default. When enabled, it detects active ads and accelerates them at a configurable speed:

- `x4`
- `x8`, the default
- `x12`
- `x16`

Acceleration is most useful when stripping is disabled, temporarily degraded by a platform change, or not appropriate for a particular playback situation.

## Privacy Boundary

Session state is private to the handler closure. Host-page scripts cannot read or modify acceleration state, session flags, ad counters, or stripping internals.

Payload cleanup details may appear in the local Event Tracker for transparency, but they are kept local and folded into broader cleanup statistics instead of being promoted as platform-specific telemetry.

## Twitch And Server-Side Ad Insertion

Twitch uses server-side ad insertion, which prevents Chroma from applying the same kind of client-side ad acceleration path used for YouTube and Amazon Prime Video. Chroma can still apply cosmetic and scriptlet-related cleanup where supported, but it does not claim Twitch ad acceleration.

