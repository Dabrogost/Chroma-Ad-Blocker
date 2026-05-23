# Statistics & Health

Chroma's statistics and diagnostics are local-only. They are designed to explain what the protection stack is doing without turning local browser activity into telemetry.

## Protection Intelligence

The settings page includes **Protection Intelligence**, a local analytics dashboard backed by the versioned `statsV2` storage record. It upgrades the old single counter into a broader view of Chroma's protection layers without changing blocking behavior or sending telemetry anywhere.

The popup headline shows **Protection Events**, with a compact breakdown for Network, Cleanup, Scriptlets, and Proxy. This number is intentionally broader than "ads blocked": DNR matches can represent network blocks, allow rules, whitelist bypasses, subscription rules, or debug-only matches, so Chroma classifies events before counting them.

## Event Tracker

The **Events** section in settings shows recent local activity from the protection stack. It can include:

- Network block, allow, and unknown-match classifications.
- Cosmetic cleanup and warning-suppression events.
- Scriptlet hits and sanitized scriptlet errors.
- Local zapper actions.
- Payload cleanup or inspection details, including modified payload counts, fields pruned, and ad objects removed.
- Proxy test and proxy authentication activity.

Payload cleanup remains visible in the Event Tracker for transparency, but it is folded into the broader **Ad Cleanups** stat instead of being promoted as a platform-specific headline badge.

## Privacy Modes

Statistics are stored only in `chrome.storage.local`.

- **Basic**: Records totals only going forward. Existing aggregated history is preserved locally unless the user explicitly resets stats.
- **Aggregated**: Records totals plus domains, rule sources, resource types, timelines, and recent event summaries.
- **Debug**: May include recent full request URLs where they are available.

Switching privacy modes changes future collection behavior and URL visibility. It does not erase saved aggregate intelligence unless a reset action is used.

Aggregated mode is the default. Chroma stores domains by default, not full URLs. Full request URLs are only kept when Debug mode is enabled, and the bounded debug request log remains separate from `statsV2`.

## Retention, Reset, And Export

The stats dashboard enforces hard caps on recent events, sites, rule entries, resource types, and daily history. Settings controls let you reset all stats, reset site stats only, reset the debug request log, or export a local JSON snapshot.

Resetting stats does not erase configuration, subscriptions, proxy settings, whitelists, local zapper rules, or filter lists.

The **Time Saved (est.)** card is deliberately conservative. It uses a small sub-second estimate per protection event and floors the displayed value, so ordinary page-load activity does not inflate into unrealistic minutes.

## Health Panel

The settings page includes a **Health** panel for diagnostics. It shows whether each protection layer is active, disabled, degraded, unavailable, or in an error state, including:

- Static DNR rulesets.
- Dynamic rules.
- Tracking URL cleanup.
- De-AMP redirects.
- Subscriptions.
- Cosmetic filtering.
- Scriptlets.
- Fingerprint randomization.
- Browser privacy hardening.
- Proxy routing.
- Whitelists.
- Request-log/debug availability.

The panel is diagnostic-only. It reports counts and coarse status information, but does not expose proxy credentials, stored auth data, request URLs, raw filter rules, or request-log contents.

DNR match logging is shown separately because `chrome.declarativeNetRequest.onRuleMatchedDebug` is only available in debug/unpacked-style install contexts. When that logging is unavailable, blocking can still work normally.

