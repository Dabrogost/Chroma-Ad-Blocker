# Statistics & Health

Chroma's statistics and diagnostics are local-only. They are designed to explain what the protection stack is doing without turning local browser activity into telemetry.

## Protection Intelligence

The settings page includes **Protection Intelligence**, a local analytics dashboard that provides a broader view of Chroma's protection layers without changing blocking behavior or sending telemetry anywhere.

The popup headline shows **Protection Events**, with a compact breakdown for Network, Cleanup, Scriptlets, and Proxy. This number is intentionally broader than "ads blocked": DNR matches can represent network blocks, allow rules, whitelist bypasses, subscription rules, or feedback-only matches, so Chroma classifies events before counting them.

<div align="center">
  <img src="assets/docs-settings-protection-intelligence.png" alt="Chroma Protection Intelligence dashboard" width="760">
</div>

## Event Tracker

The **Events** section in settings shows recent local activity from the protection stack. It can include:

- Network block, allow, and unknown-match classifications.
- Cosmetic cleanup and warning-suppression events.
- Scriptlet hits and sanitized scriptlet errors.
- Local zapper actions.
- Coarse payload-modified events from supported platform handling.
- Proxy test and proxy authentication activity.

Payload cleanup remains visible in the Event Tracker for transparency, but it is folded into the broader **Ad Cleanups** stat instead of being promoted as a platform-specific headline badge.

### Approximate Page-Level Counts

Some YouTube and scriptlet activity is reported from the page itself, so those page-level totals are approximate diagnostics rather than an audit log. Chroma accepts only coarse event types and does not trust page-supplied URLs, domains, timestamps, or counts. These signals cannot change settings or control protection.

## Privacy Modes

Protection Intelligence statistics are stored only in `chrome.storage.local`. These modes govern the `statsV2` statistics dataset:

- **Basic**: Records totals only going forward. Existing aggregated history is preserved locally unless the user explicitly resets stats.
- **Aggregated**: Records totals plus domains, rule sources, resource types, timelines, and recent event summaries.
- **Debug**: May include recent full request URLs in `statsV2` where they are available.

Switching privacy modes changes future `statsV2` collection and URL visibility. It does not erase saved aggregate intelligence unless a reset action is used.

Aggregated mode is the default. Within `statsV2`, Chroma stores domains by default and retains full request URLs only in Debug mode.

### Separate DNR Request Log

The Request Log is a separate dataset and is not controlled by the Basic, Aggregated, or Debug statistics mode. Whenever Chrome exposes DNR matched-rule feedback to the unpacked extension, Chroma records the newest 500 reported matches in `chrome.storage.local`. Entries can contain full request URLs, timestamps, request types, matched rule IDs, block, allow, or neutral/match actions, and rule sources such as whitelist or unknown.

Chroma clears this request log when the browser profile starts and Chrome fires `runtime.onStartup`. You can also reset it independently in settings. Changing statistics mode, resetting site statistics, or resetting all `statsV2` statistics does not clear it. When Chrome does not expose matched-rule feedback, the Request Log remains unavailable even though browser-enforced blocking can continue normally.

## Retention, Reset, And Export

The stats dashboard enforces hard caps on recent events, sites, rule entries, resource types, and daily history. Settings controls let you reset all `statsV2` statistics, reset site statistics only, reset the separate DNR request log, or export a local JSON statistics snapshot.

Resetting `statsV2` statistics does not erase the separate request log, configuration, subscriptions, proxy settings, whitelists, local zapper rules, or filter lists.

The **Time Saved (est.)** card is deliberately conservative. It uses a small sub-second estimate per protection event and floors the displayed value, so ordinary page-load activity does not inflate into unrealistic minutes.

## Health Panel

The settings page includes a **Health** panel for diagnostics. It shows whether each protection layer is active, disabled, degraded, unavailable, or in an error state, including:

<div align="center">
  <img src="assets/docs-settings-health-panel.png" alt="Chroma health diagnostics panel" width="760">
</div>

- Static DNR rulesets.
- Dynamic rules.
- Tracking URL cleanup.
- De-AMP redirects.
- Subscriptions.
- Cosmetic filtering.
- Scriptlets.
- Fingerprint randomization.
- Browser privacy hardening.
- Geolocation protection.
- WebRTC protection.
- Proxy routing.
- Whitelists.
- DNR request-log feedback availability.

The panel is diagnostic-only. It reports counts and coarse status information, but does not expose proxy credentials, stored auth data, request URLs, raw filter rules, or request-log contents.

For proxy, WebRTC, browser privacy, and geolocation, Health separates stored/requested intent, whether Chroma controls the relevant Chrome setting, and the observed effective state. Master-off requests appear paused rather than mismatched; another controller appears degraded or **Controlled elsewhere**.

Request Log availability depends on Chrome exposing matched-rule feedback to the unpacked extension. When that feedback is unavailable, blocking can still work normally.

---

Next: [Privacy Policy](PRIVACY_POLICY.md)
