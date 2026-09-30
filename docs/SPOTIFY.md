# Spotify Protection

Chroma redirects known Spotify web-player ad media to a brief silent clip bundled with the extension. The browser applies these rules to media requests from `open.spotify.com`. This feature supports the web player in Chrome and compatible Chromium browsers, including Edge; it does not affect Spotify's desktop or mobile apps.

## Enable Or Disable Spotify Ad Blocking

Open **Settings -> Protection -> Spotify** and use **Spotify ad blocking**. It is enabled on fresh installs. If an older configuration has no saved Spotify preference, the toggle stays off until you enable it.

The toggle works independently of **YouTube ad blocking** and **Network blocking**. Master protection must be on, and Spotify must not be whitelisted. Use the current-site protection toggle in the popup to whitelist Spotify. Disabling Spotify ad blocking removes its dedicated rules while leaving other requested protections in place.

## Implementation And Limits

The implementation follows full [uBlock Origin's Spotify media rules](https://github.com/uBlockOrigin/uAssets/blob/master/filters/filters-2020.txt), adapted to Chrome's Manifest V3 declarativeNetRequest API:

- Ten explicit ad-media patterns redirect to uBO's approximately one-second silent MP4, stored locally in Chroma.
- Three podcast exceptions and a direct Megaphone media redirect preserve supported podcast delivery paths.
- All 14 rules are dynamic. They do not change the OISD static shards or require the Chroma Scriptlet Library or Allow User Scripts permission.

The dedicated Spotify feature does not wrap `fetch`, alter `RegExp.prototype.test`, or rewrite playback responses, media URLs inside JSON, or file IDs. It does not change queues, state transitions, tokens, devices, or Spotify Connect, hook WebSockets, or request future playback states.

Chrome DNR has no direct equivalent of uBO's fallback that redirects media only when another filter would block it. Chroma omits that fallback rather than redirecting all third-party media. Ads from unsupported delivery paths can still play; this is an adaptation of uBO's network approach, not full filter-engine parity.

## Updating From The Earlier Spotify Handler

Earlier 1.9.3 packages used a Lite-derived playback-response handler. The current package removes that handler and its page hooks. After updating, reload Chroma and close and reopen Spotify to clear earlier code from an existing tab.

The version number alone does not distinguish these 1.9.3 packages. When replacing an earlier package with the corrected package of the same version, follow the [manual update instructions](INSTALL.md#manual-update-fallback); the guided updater may consider an equal version current.

## Troubleshooting Playback

If songs skip repeatedly, pause unexpectedly, or show **Can't play this right now**, turn off **Spotify ad blocking** and reopen Spotify. If playback returns, leave that toggle off and report the browser version, Chroma package used, and whether the failure followed an ad break or manual skip. Do not include account tokens or unredacted playback responses.

If ads play, check master protection, the Spotify toggle, and the site whitelist. Avoid running multiple ad blockers together. Test several ad breaks, manual skips, and pause/resume cycles before concluding that sustained playback is stable.

Chrome browser tests cover the redirect and silent clip. An initial live Edge ad break also succeeded; sustained live Spotify playback still needs compatibility testing.

---

Next: [Filter List Subscriptions](FILTER_LISTS.md)
