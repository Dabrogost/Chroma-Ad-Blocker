# Spotify Protection

Chroma redirects known Spotify web-player ad media to a brief silent clip bundled with the extension. The browser applies these rules to media requests from `open.spotify.com`. This feature supports the web player in Chrome and compatible Chromium browsers, including Edge; it does not affect Spotify's desktop or mobile apps.

## Enable Or Disable Spotify Ad Blocking

Open **Settings -> Protection -> Spotify** and use **Spotify ad blocking**. It is enabled on fresh installs. If an older configuration has no saved Spotify preference, the toggle stays off until you enable it.

The toggle works independently of **YouTube ad blocking** and **Network blocking**. Master protection must be on, and Spotify must not be whitelisted. Use the current-site protection toggle in the popup to whitelist Spotify. Disabling Spotify ad blocking removes its dedicated rules while leaving other requested protections in place.

## Implementation And Limits

Chroma's Spotify rules are adapted from [uBlock Origin's Spotify media rules](https://github.com/uBlockOrigin/uAssets/blob/master/filters/filters-2020.txt). Known ad-media requests are redirected to a bundled silent clip, with exceptions for supported podcast delivery paths. This feature does not require **Allow User Scripts**.

Spotify protection applies to media requests and leaves playback data untouched.

Ads from unsupported delivery paths can still play. Chroma's rules cover specific media patterns and do not provide every filtering behavior available in uBlock Origin.

## Troubleshooting Playback

If songs skip repeatedly, pause unexpectedly, or show **Can't play this right now**, turn off **Spotify ad blocking** and reopen Spotify. If playback returns, leave that toggle off and report the browser version, Chroma package used, and whether the failure followed an ad break or manual skip. Do not include account tokens or unredacted playback responses.

If ads play, check master protection, the Spotify toggle, and the site whitelist. Avoid running multiple ad blockers together.

---

Next: [Media Proxy Router](MEDIA_PROXY_ROUTER.md)
