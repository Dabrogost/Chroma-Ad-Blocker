# YouTube Protection

Chroma's YouTube protection cleans ad data before the player processes it. Optional acceleration handles ads that still reach playback.

## Enable Or Disable YouTube Protection

1. Open **Settings -> Protection -> YouTube**.
2. Use **YouTube ad blocking** to control payload stripping. It is on by default.
3. Leave **YouTube ad acceleration** off for the default setup, or turn it on as a fallback and choose an **Acceleration speed**.
4. Reload YouTube after changing the setup, especially when comparing playback behavior.

Master protection must be on, and YouTube must not be whitelisted. The current-site switch in the popup controls the site exception. See [Everyday Use & Troubleshooting](EVERYDAY_USE.md) for site controls and [Master Protection Lifecycle](FEATURES.md#master-protection-lifecycle) for pause and restoration behavior.

**Hide YouTube Shorts**, **Hide YouTube merchandise**, and **Hide YouTube movie and TV offers** control page cleanup separately. Hiding Shorts shelves is different from removing sponsored Shorts data.

## YouTube Ad Stripping

The **YouTube ad blocking** control enables the YouTube Ad Stripper. It intercepts communication between your browser and YouTube's internal APIs, including `/youtubei/v1/player`, `/next`, and related endpoints, and removes ad-related metadata before the YouTube player can process it.

## How It Works

- **Upstream Neutralization**: Deletes fields such as `adPlacements`, `adSlots`, and `playerAds` from raw JSON responses before the player reads them.
- **Playback Cleanup**: Removing ad metadata can prevent ads from reaching playback. Startup delays can still occur; see Startup Recovery below.
- **Payload Interception**: Uses hooks into `window.fetch`, `XMLHttpRequest`, and `JSON.parse` so batched or delayed requests can still be cleaned.
- **Feed & Search Optimization**: Strips promoted Sparkles ads, suggested products, and sponsored results from home feed and search payloads.
- **Sponsored Shorts Blocking**: Prunes sponsored Shorts payloads such as `adsOverlay`, `shortsAdsRenderer`, `sequenceItemInPlayerAdLayoutRenderer`, and `reelWatchEndpoint.adClientParams.isAd` before the Shorts player renders the sponsored overlay.

## Startup Recovery

YouTube can tell its player to wait even after ad metadata has been removed, leaving a black screen or startup spinner. With **YouTube ad blocking** enabled, Chroma detects these startup waits and can retry the current video once to request content playback sooner. This recovery supplements ad stripping and runs automatically.

Recovery preserves the requested start position and restores available radio or playlist context. If playlist context cannot be captured, Chroma skips the reload. Recovery is limited to videos that have not started playing; it skips YouTube Music, Shorts, embedded players, live content, detected Premium sessions, and visible ads. Turning off **YouTube ad blocking** or master protection also disables recovery.

The recovery combines approaches from [Brave](https://github.com/brave/adblock-resources/pull/334) and [uAssets](https://github.com/uBlockOrigin/uAssets/blob/master/filters/experimental.txt). It can reduce startup delays, but playback may still take longer because of server waits, network conditions, or changes to YouTube.

## Relationship To Acceleration

**YouTube ad acceleration** ships off by default. It can run alongside stripping, muting and speeding up detected ads that reach the player. Choose one of these speeds:

- `x4`
- `x8`, the default
- `x12`
- `x16`

Acceleration is most useful when stripping is disabled, temporarily degraded by a platform change, or not appropriate for a particular playback situation.

The toggle also changes Chroma's default dynamic network rules when **Network blocking** is enabled. Acceleration allows selected YouTube ad-serving, measurement, conversion, and detection-related requests to reduce ad-blocker detection. With acceleration off, those rules become blocks; the YouTube `generate_204` connectivity exception remains allowed for playback compatibility. Other protection layers can still affect individual requests. This is a privacy and compatibility tradeoff as well as a playback-speed choice; see [Allow Rules](PRIVACY_POLICY.md#4-allow-rules).

## Troubleshooting Playback

| Symptom | What to try |
|---|---|
| Ads still play | Check master protection, the site exception, and **YouTube ad blocking**. Reload the tab. If stripping is temporarily ineffective, try **YouTube ad acceleration** with the tradeoff above in mind. |
| Black screen or startup spinner | Allow the automatic startup recovery to finish. If playback stays stuck, reload once, then change one layer at a time: compare with acceleration off, with any proxy route paused, and with other ad blockers disabled. |
| Missing Shorts shelves or product panels | Check the separate **Hide YouTube Shorts**, **Hide YouTube merchandise**, and **Hide YouTube movie and TV offers** controls. |
| Playback breaks after a change | Restore the previous setting and reload. Check **Health**, then use the site-exception workflow in [Everyday Use & Troubleshooting](EVERYDAY_USE.md) to narrow down the cause. |

When reporting a persistent problem, include the browser and Chroma versions, whether it affects regular videos, Shorts, live content, or embeds, and which protection and proxy settings were active. Do not include account tokens or unredacted playback responses.

## Privacy Boundary

YouTube protection processes playback data locally. Cleanup activity can appear in the local Event Tracker; these page-level counts are approximate. See [Statistics & Health](STATISTICS.md) for details. Websites can observe changes to their player or page and may detect ad blocking.

## Twitch And Server-Side Ad Insertion

Twitch uses server-side ad insertion, which prevents Chroma from applying the same client-side ad acceleration path used for YouTube. Chroma can still apply cosmetic and scriptlet-related cleanup where supported. Ad acceleration is not available for Twitch or Amazon Prime Video.

---

Next: [Spotify Protection](SPOTIFY.md)
