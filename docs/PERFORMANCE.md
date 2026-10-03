# Performance Guide

Chroma's performance goal is practical low overhead, not zero overhead. The extension keeps request decisions in browser-managed APIs where possible, moves expensive list work to refresh time, and scopes page-side work to the features that are enabled.

## Where The Cost Lives

| Surface | How work is handled | What can make it heavier |
|---|---|---|
| [DNR request matching](#dnr-matching-vs-javascript-request-overhead) | Chromium enforces block, redirect, and allow decisions. | Rule validation, budgets, and optional matched-rule diagnostic events. |
| [Service worker](#service-worker-lifecycle-and-startup-work) | Wakes for extension events and sleeps when idle. | Cold starts, refreshes, and rule synchronization. |
| [Content script](#content-script-cost) | Injects CSS and watches page changes in the isolated world. | Frequent DOM mutations on feeds and live chat pages. |
| [Constructable stylesheets](#constructable-stylesheet-behavior) | Reuses browser stylesheet objects. | Large or broad selector sets and style recalculation. |
| [MAIN-world interception](#main-world-interception-cost) | Adds page-context hooks for enabled features, including optional Quiet Console. | API checks on each call; some optional features apply across ordinary websites. |
| [`userScripts` registration](#userscripts-registration-cost) | The browser stores and injects matching script definitions. | Many rules and broad domain matches. |
| [Proxy PAC routing](#proxy-pac-routing-cost) | Selects direct or proxy transport by host. | Many routes and proxy latency. |
| [Stats and request logs](#stats-batching) | Batches events before storage writes. | High event volume and Debug statistics detail. |

## DNR Matching Vs JavaScript Request Overhead

The main network-blocking path uses Declarative Net Request. Chromium validates, indexes, and applies these rules through its own request pipeline, so Chroma does not receive every request in JavaScript just to decide whether it should block.

That matters for MV3 performance:

- Static rules are validated when the extension is installed or updated.
- Dynamic and subscription rules are rebuilt when settings, whitelists, or subscriptions change.
- Request-time matching is browser-managed.
- Enforcement does not depend on a running service worker.

Chroma also registers Chrome's developer-mode `onRuleMatchedDebug` feedback event when it is available. That event is diagnostics, not enforcement, but a rule match can wake the worker so Chroma can classify it, update local statistics, and append it to the request log. Chrome's DNR behavior and budgets still apply. Unsupported rules are skipped, dynamic subscription rules are allocated by priority, and extremely broad subscription sets can be trimmed before they reach the browser.

## Service-Worker Lifecycle And Startup Work

Chrome pauses Chroma's background worker when it is idle. Browser-managed network rules continue working while it sleeps, and saved settings and rules are restored when needed.

Opening settings, changing protection, or refreshing large lists can take a moment while the worker starts and applies changes. Wait for pending indicators to clear. If a section remains unavailable, check **Health** for an error.

## Content Script Cost

The isolated content script runs on normal web pages because cosmetic filtering, warning suppression, site whitelisting, De-AMP checks, and zapper rules are page-scoped features.

The expected cost is small on ordinary pages:

- Cosmetic hiding is expressed as CSS.
- Invalid selectors are dropped before use.
- Local zapper rules are scoped to matching hostnames.
- Stats events are queued and sent in batches.
- Whitelisted sites skip the relevant local cleanup behavior.

### MutationObserver Behavior

Chroma watches for new page elements so it can remove ad containers and warning overlays added after loading. Large video pages, infinite feeds, and live chat can require more cleanup work than static pages because they continually change the DOM.

Lower-overhead habits:

- Keep cosmetic filtering enabled if you want CSS-based cleanup; CSS is usually cheaper than repeated manual cleanup.
- Disable specific optional cosmetic preferences you do not use, such as Shorts hiding, if you are chasing a page-specific slowdown.
- Use narrow Element Zapper selectors rather than broad selectors that match large parts of a page.

### Constructable Stylesheet Behavior

Chroma reuses `CSSStyleSheet` objects through `document.adoptedStyleSheets` for cosmetic filtering. The browser still has to apply the selectors, so very broad custom rules can slow down large pages. Prefer rules scoped to the site and element you want to hide.

## MAIN-World Interception Cost

MAIN-world code is reserved for cases where isolated content scripts are not enough:

- YouTube payload stripping and optional acceleration fallback.
- Recipe/blog anti-adblock containment.
- Supported subscription scriptlets.
- User-provided scriptlet resources.
- Optional fingerprint randomization.
- Optional Quiet Console request suppression.

These hooks add checks around page APIs such as `fetch`, `XMLHttpRequest`, `JSON.parse`, DOM/style APIs, media state, or fingerprint surfaces. Platform handlers are limited to their supported sites; user scriptlets follow their saved domain rules.

Quiet Console is off by default. When enabled with master protection, it registers across browser-accessible pages and frames, excluding whitelisted domains; its code also skips defined safety-excluded hosts. It wraps `fetch`, `XMLHttpRequest`, `navigator.sendBeacon`, and function stringification so known ad/tracker requests can be suppressed before they produce blocked-request noise. Its per-call checks can therefore affect ordinary websites as well as media sites. Fingerprint randomization is another optional layer with broad page coverage.

For a page-specific comparison, change one optional hook-based feature at a time and reload the page. See [Master Protection Lifecycle](FEATURES.md#master-protection-lifecycle) for the distinction between pausing future activity and undoing changes already made to a document.

## `userScripts` Registration Cost

Chroma registers supported subscription scriptlets and user-added scriptlets with Chrome. Large rule sets can take longer to apply. Only resources referenced by valid user rules are activated.

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

Page-level activity counts are approximate. See [Statistics & Health](STATISTICS.md) for how these counts differ from network events.

The request log and statistics history are separate stores. Whenever Chrome exposes DNR match feedback, the request log keeps up to 500 recent entries with full matched URLs regardless of whether statistics mode is Basic, Aggregated, or Debug. Statistics mode controls the detail retained in `statsV2`; only Debug permits full URLs in its recent-event records. Debug therefore adds detail to statistics, but switching away from Debug does not disable or redact the separate request log.

## Recommended Low-Overhead Settings

For a conservative everyday setup:

| Setting | Recommended value | Why |
|---|---|---|
| Network Blocking | On | Lets DNR handle request blocking in the browser engine. |
| Tracking URL Cleanup | On | Uses DNR redirects instead of page-side URL rewriting. |
| YouTube ad blocking | On if you use YouTube | Avoids visible ad handling when payload cleanup works. |
| YouTube ad acceleration | Off unless needed | Avoids acceleration-specific polling and playback intervention. |
| Cosmetic Filtering | On | CSS hiding is usually the cheapest page cleanup layer. |
| Hide YouTube Shorts | Personal preference | Disable if you do not care about Shorts cleanup. |
| Fingerprint Randomization | Off unless needed | MAIN-world API farbling can affect compatibility and adds per-surface hooks. |
| Quiet console | Off unless needed | Avoids extra page API checks across ordinary websites. |
| Chrome privacy hardening | Personal preference | Browser setting changes are not request-path heavy, but may affect compatibility. |
| Proxy Global Fallback | Off unless needed | Avoids proxy latency for unrelated browser traffic. |
| Stats Privacy Mode | Basic or Aggregated | Avoid Debug mode unless troubleshooting. |
| Custom subscriptions | Keep focused | Fewer remote lists mean less refresh, parsing, storage, and registration work. |
| User scriptlet resources | Narrow domains only | Keeps executable page-code registration and runtime hooks scoped. |

## Troubleshooting Performance

Change one layer at a time, reload the affected page, and check **Health** after each change. Start with optional work such as Debug statistics mode, Global Fallback proxy routing, Fingerprint Randomization, Quiet Console, YouTube ad acceleration, and broad custom subscriptions.

Compare the same page and action before and after each change. A slow proxy can look like extension overhead; a large subscription set can add refresh, parsing, storage, and registration work even when request enforcement itself remains browser-managed. For site exceptions and a broader isolation workflow, see [Everyday Use & Troubleshooting](EVERYDAY_USE.md).

---

Next: [Terms of Service](ToS.md)
