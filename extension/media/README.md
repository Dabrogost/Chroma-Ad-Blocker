`noop-1s.mp4` is the approximately one-second silent audio/video resource from
uBlock Origin, licensed under GPL-3.0-or-later:
https://github.com/gorhill/uBlock/blob/master/src/web_accessible_resources/noop-1s.mp4

Spotify rules are adapted from uBlock Origin's filters/filters-2020.txt in
https://github.com/uBlockOrigin/uAssets (retrieved 2026-09-29).

Chrome DNR redirects explicit ad-media patterns to this packaged resource.
Playback responses, file IDs, and JavaScript built-ins are unchanged. The
uBO redirect-rule fallback (redirect only when another filter blocks the
request) has no direct DNR equivalent and is deliberately omitted.
