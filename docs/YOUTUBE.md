# YouTube Protection

Chroma's YouTube protection is designed around upstream payload cleanup rather than reacting to visible ads after the player has already started processing them.

## YouTube Ad Stripping

The YouTube Ad Stripper intercepts communication between your browser and YouTube's internal APIs, including `/youtubei/v1/player`, `/next`, and related endpoints. It surgically removes ad-related metadata before the YouTube player can process it.

Instead of waiting for an ad to appear and then speeding it up or hiding it, the stripper tries to make the player receive a cleaned payload from the beginning.

## How It Works

- **Upstream Neutralization**: Deletes fields such as `adPlacements`, `adSlots`, and `playerAds` from raw JSON responses before the player reads them.
- **Playback Cleanup**: Removing ad metadata can prevent ads from reaching playback. Startup delays can still occur; see Startup Recovery below.
- **Payload Interception**: Uses hooks into `window.fetch`, `XMLHttpRequest`, and `JSON.parse` so batched or delayed requests can still be cleaned.
- **Feed & Search Optimization**: Strips promoted Sparkles ads, suggested products, and sponsored results from home feed and search payloads.
- **Sponsored Shorts Blocking**: Prunes sponsored Shorts payloads such as `adsOverlay`, `shortsAdsRenderer`, `sequenceItemInPlayerAdLayoutRenderer`, and `reelWatchEndpoint.adClientParams.isAd` before the Shorts player renders the sponsored overlay.

## Startup Recovery

YouTube can tell its player to wait even after ad metadata has been removed, leaving a black screen or startup spinner. With YouTube Ad Stripping enabled, Chroma detects these startup waits and can retry the current video once to request content playback sooner. This recovery supplements the existing ad stripping and runs automatically.

Recovery preserves the requested start position and restores available radio or playlist context. If playlist context cannot be captured, Chroma skips the reload. Recovery is limited to videos that have not started playing; it skips YouTube Music, Shorts, embedded players, live content, detected Premium sessions, and visible ads. Turning off YouTube Ad Stripping or master protection also disables recovery.

The recovery combines approaches from [Brave](https://github.com/brave/adblock-resources/pull/334) and [uAssets](https://github.com/uBlockOrigin/uAssets/blob/master/filters/experimental.txt). It can reduce startup delays, but playback may still take longer because of server waits, network conditions, or changes to YouTube.

## Relationship To Acceleration

Ad Acceleration remains available as a fallback, but stripping is the recommended method for a seamless YouTube experience.

Dynamic Ad Acceleration ships off by default. When enabled, it detects active ads and accelerates them at a configurable speed:

- `x4`
- `x8`, the default
- `x12`
- `x16`

Acceleration is most useful when stripping is disabled, temporarily degraded by a platform change, or not appropriate for a particular playback situation.

## Privacy Boundary

YouTube protection processes playback data locally. Cleanup activity can appear in the local Event Tracker; these page-level counts are approximate. See [Statistics & Health](STATISTICS.md) for details. Websites can observe changes to their player or page and may detect ad blocking.

## Twitch And Server-Side Ad Insertion

Twitch uses server-side ad insertion, which prevents Chroma from applying the same client-side ad acceleration path used for YouTube. Chroma can still apply cosmetic and scriptlet-related cleanup where supported. Ad acceleration is not available for Twitch or Amazon Prime Video.

---

Next: [Spotify Protection](SPOTIFY.md)
