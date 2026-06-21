# Performance Guide

Chroma's performance goal is practical low overhead, not zero overhead. The extension keeps request decisions in browser-managed APIs where possible, moves expensive list work to refresh time, and scopes page-side work to the features that are enabled.

## Where The Cost Lives

| Surface | Low-overhead path | What can make it heavier |
|---|---|---|
| DNR request matching | Chromium matches DNR rules in the browser engine without waking Chroma JavaScript for each request. | Very large rule sets still have install/update validation cost and MV3 rule-budget limits. |
| Service worker | Sleeps when idle and wakes for extension events, alarms, UI messages, DNR sync, subscription work, and proxy changes. | Cold starts, subscription refreshes, dynamic rule rebuilds, and scriptlet registration can take visible time in settings or diagnostics. |
| Content script | Runs in the isolated world and primarily injects CSS, watches DOM additions, and removes known leftovers. | High-churn pages can produce many DOM mutations, especially video feeds, infinite scroll pages, and live chat layouts. |
| Constructable stylesheets | Reuses `CSSStyleSheet` objects and updates `document.adoptedStyleSheets` instead of repeatedly appending style nodes. | Large selector sets still cost browser style recalculation when enabled or changed. |
| MAIN-world interception | Runs only where platform handlers, scriptlets, media handlers, or optional fingerprint randomization require page-context hooks. | Hooking `fetch`, `XMLHttpRequest`, `JSON.parse`, media APIs, or fingerprint surfaces adds per-call checks on matched pages. |
| `userScripts` registration | Browser stores registered script definitions and injects them on matching pages. | Many subscription or user scriptlet rules increase registration time and match pattern count. |
| Proxy PAC routing | PAC chooses direct vs proxy transport by host, keeping DNR policy separate from routing. | Large domain lists and Global Fallback add routing checks and may add proxy latency. |
| Stats and request logs | Content/background events are batched before storage writes. | Debug request logging can store more URL detail and write more often on pages with many DNR matches. |

## DNR Matching Vs JavaScript Request Overhead

The main network-blocking path uses Declarative Net Request. Chromium validates, indexes, and applies these rules through its own request pipeline, so Chroma does not receive every request in JavaScript just to decide whether it should block.

That matters for MV3 performance:

- Static rules are validated when the extension is installed or updated.
- Dynamic and subscription rules are rebuilt when settings, whitelists, or subscriptions change.
- Request-time matching is browser-managed.
- The service worker is not kept alive just because pages are making network requests.

Chrome's DNR behavior and budgets still apply. Unsupported rules are skipped, dynamic subscription rules are allocated by priority, and extremely broad subscription sets can be trimmed before they reach the browser.

## Service-Worker Lifecycle And Startup Work

Manifest V3 service workers are ephemeral. Chroma stores persistent state in `chrome.storage.local` and treats the worker as a coordinator rather than a long-running process.

On install, update, startup, or wake, the worker may:

- Sync static and dynamic DNR state.
- Rebuild whitelist allow rules.
- Ensure subscription refresh alarms exist.
- Refresh stale subscriptions.
- Register or recover `userScripts`.
- Sync browser privacy, geolocation, WebRTC, and proxy-related browser settings.
- Re-broadcast configuration to open tabs where possible.

That startup work happens during lifecycle and settings events instead of the request path. If the worker was asleep, opening the popup or changing settings may pay the wake cost before showing fresh state.

## Content Script Cost

The isolated content script runs on normal web pages because cosmetic filtering, warning suppression, site whitelisting, De-AMP checks, and zapper rules are page-scoped features.

The expected cost is small on ordinary pages:

- Cosmetic hiding is expressed as CSS.
- Invalid selectors are dropped before use.
- Local zapper rules are scoped to matching hostnames.
- Stats events are queued and sent in batches.
- Whitelisted sites skip the relevant local cleanup behavior.

The cost rises on pages that constantly add or replace DOM nodes. Large video pages, infinite feeds, and live chat surfaces are the main cases to watch.

## MutationObserver Behavior

Chroma uses `MutationObserver` for DOM cleanup that cannot be handled by static CSS alone. The observer tracks added element nodes, collects them into a pending set, and processes the batch on the next animation frame.

This keeps repeated mutations from triggering immediate repeated scans, but it does not make DOM cleanup free. On high-churn pages, every batch still has to inspect relevant added nodes for warning overlays and leftover ad containers.

Lower-overhead habits:

- Keep cosmetic filtering enabled if you want CSS-based cleanup; CSS is usually cheaper than repeated manual cleanup.
- Disable specific optional cosmetic preferences you do not use, such as Shorts hiding, if you are chasing a page-specific slowdown.
- Use narrow Element Zapper selectors rather than broad selectors that match large parts of a page.

## Constructable Stylesheet Behavior

Chroma uses constructable stylesheets where supported. It keeps Chroma-owned sheets in a map, replaces the sheet only when the CSS content changes, and updates `document.adoptedStyleSheets` without clobbering sheets from the page or other extensions.

This avoids repeated `<style>` node churn. The browser still has to apply CSS selectors, so very broad selector lists can still affect style calculation on large documents.

## MAIN-World Interception Cost

MAIN-world code is reserved for cases where isolated content scripts are not enough:

- YouTube payload stripping.
- Prime Video acceleration fallback.
- Recipe/blog anti-adblock containment.
- Supported subscription scriptlets.
- User-provided scriptlet resources.
- Optional fingerprint randomization.

These hooks add checks around page APIs such as `fetch`, `XMLHttpRequest`, `JSON.parse`, DOM/style APIs, media state, or fingerprint surfaces. On ordinary pages where those handlers are not registered, the cost is avoided. On supported media platforms, the cost is the tradeoff for intercepting data before the page consumes it.

## `userScripts` Registration Cost

Chroma registers supported subscription scriptlets and explicit user scriptlets through Chrome's `userScripts` API. Registration is synchronized from stored rules, chunked so one bad entry does not reject the whole batch, and retried per script when a chunk fails.

Performance implications:

- More scriptlet rules mean more match patterns for Chrome to manage.
- Broad rules such as global matches are more expensive than narrow domain rules.
- Chrome 138+ requires **Allow User Scripts**. If unavailable, Chroma reports the layer as unavailable instead of repeatedly trying to run page code.
- Whitelisted domains are translated into scriptlet exclusions so scriptlets do not run on sites the user has disabled.

## Proxy PAC Routing Cost

Proxy routing uses Chrome's PAC mechanism. For each browser request, the PAC script decides whether the host should connect directly, use a domain-specific proxy, or use the selected Global Fallback proxy.

This is usually lightweight for short domain lists. It can become more noticeable when:

- Many proxy domains are configured.
- Smart-Link expansion adds related CDN domains for large media platforms.
- Global Fallback sends most browser traffic through a proxy.
- The proxy itself adds latency, buffers media poorly, or fails intermittently.

PAC routing affects transport, not blocking policy. DNR still decides what should be blocked or allowed; PAC decides how allowed traffic is routed.

## Stats Batching

Chroma batches stats and request-log writes to avoid writing to storage for every event:

- Content script events are queued and flushed after a short delay or when the queue reaches a cap.
- Proxy authentication challenge stats are batched before being recorded.
- DNR request-log feedback is buffered before writing to `chrome.storage.local`.
- Background stats are queued, flushed, and pruned under retention caps.

Debug request logging can still add overhead on very noisy pages because it records recent full URLs when available. Use Debug mode only when you need that detail.

## Recommended Low-Overhead Settings

For a conservative everyday setup:

| Setting | Recommended value | Why |
|---|---|---|
| Network Blocking | On | Lets DNR handle request blocking in the browser engine. |
| Tracking URL Cleanup | On | Uses DNR redirects instead of page-side URL rewriting. |
| YouTube Stripping | On if you use YouTube | Avoids visible ad handling when payload cleanup works. |
| Dynamic Ad Acceleration | Off unless needed | Keeps media polling and playback intervention out of the normal path. |
| Cosmetic Filtering | On | CSS hiding is usually the cheapest page cleanup layer. |
| Hide Shorts | Personal preference | Disable if you do not care about Shorts cleanup. |
| Fingerprint Randomization | Off unless needed | MAIN-world API farbling can affect compatibility and adds per-surface hooks. |
| Browser Privacy Hardening | Personal preference | Browser setting changes are not request-path heavy, but may affect compatibility. |
| Proxy Global Fallback | Off unless needed | Avoids proxy latency for unrelated browser traffic. |
| Stats Privacy Mode | Basic or Aggregated | Avoid Debug mode unless troubleshooting. |
| Custom subscriptions | Keep focused | Fewer remote lists mean less refresh, parsing, storage, and registration work. |
| User scriptlet resources | Narrow domains only | Keeps executable page-code registration and runtime hooks scoped. |

## Known Heavier Surfaces

Some surfaces are naturally heavier because the page or feature changes constantly:

- **YouTube**: Large feed DOMs, Shorts, payload interception, player state, and frequent platform changes.
- **Prime Video**: Media handling and acceleration fallback require page-context observation when enabled.
- **Twitch**: Live chat and streaming pages can produce heavy DOM churn; server-side ad insertion limits what client-side handling can do.
- **Large subscription sets**: More parsing work, storage use, DNR allocation, cosmetic selector volume, and scriptlet registration.
- **Global proxy routing**: Adds proxy path latency to broad browser traffic and can make slow proxy providers look like extension overhead.

When troubleshooting performance, change one layer at a time and check the Health panel after each change. Start with optional heavier layers such as Debug statistics mode, Global Fallback proxy routing, Fingerprint Randomization, Dynamic Ad Acceleration, and broad custom subscriptions.

---

Next: [Testing Guide](TEST_GUIDE.md)
