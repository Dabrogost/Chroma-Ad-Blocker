# Statistics audit — September 30, 2026

Audited checkout: `7a22840`, with the pending 1.9.4 version bump. Evidence: current producers, transport, aggregation, persistence, export and UI; Git history; and the supplied `chroma-stats-2026-10-01.json`. The export timestamp is October 1, 00:52:26 UTC (September 30, 20:52:26 EDT). Private browsing details from the export are not copied into this report.

## Findings and disposition

| Finding | Classification | Minimal action |
| --- | --- | --- |
| YouTube inspections, modified and cleans are identical | Intentional reporting of modified payloads only; misleading inspection name and redundant clean alias | Preserve existing keys/history, document aliases and collection coverage; do not add hot-path inspection messages |
| YouTube field/object counters stop increasing | Deliberate July telemetry restriction; obsolete exported detail counters | Preserve historical values; identify them as no longer collected, not evidence of zero removals |
| Scriptlet startup events disappear before config loads | Confirmed bug, reproduced with a delayed config read | Buffer at most 20 coarse hit/error enums; release through existing gates, quota and batch only after successful config load |
| Settings, partial resets and normalization can overwrite a concurrent event flush | Confirmed storage race, reproduced with a gated write | Put every stats read/modify/write, including normalization, on the existing promise queue |
| A null rule ID becomes numeric zero | Confirmed normalization bug, reproduced | Preserve missing IDs as null; do not create fictitious rule-zero buckets |
| Unknown DNR matches disappear | Expected improvement from rebuilding the action cache on worker wake | No counter change |
| Allow, scriptlet and retention labels imply more than they measure | Misleading terminology | Label allow-rule matches, scriptlet runs, UTC days and daily-history retention; explain the headline and bounded tables |
| Proxy passes + failures = tests | Correct in the export and current outcome producers | Preserve behavior; add counter-invariant regression coverage |

The first three runtime regression cases were run before fixes: startup reporting returned 0 instead of 20; a concurrent settings write lost the new allow event; a null-ID event created a second, fictitious rule bucket. Safe changes are confined to statistics, presentation, documentation and tests. Enforcement and historical totals are preserved.

## Export checks

- Lifetime: inspections = modified = cleans = **288,327**. They are identical on all **83 retained daily records**. The retained date range is July 4–October 1; dates without activity need not have rows.
- Last 30 days: **33,943** for each of those three counters; zero recorded fields, objects and scriptlet hits.
- Last nonzero retained date: fields July 13; ad objects July 9; scriptlet hits July 14 (one); unknown DNR matches July 13.
- Lifetime protection arithmetic: **124,900 network + 2,005 cosmetic + 694 warning + 288,327 YouTube + 3,992 scriptlet + 1,009 zapper = 420,927**.
- Proxy: **1,199 passes + 103 failures = 1,302 tests**. That identity and the protection sum also hold in every exported daily, site, rule, resource-type and range bucket.
- There are 250 sites, 500 rules, 11 resource types and 500 recent events. These are bounded detail tables, not a complete ledger from which lifetime totals can be reconstructed.

## Actual metric meanings

| Counter | Current producer/meaning | Important qualification |
| --- | --- | --- |
| `youtubePayloadInspections` | One per accepted `youtube_payload_modified` event | Compatibility alias for reported modifications; does not count unchanged payload examinations |
| `youtubePayloadsModified` | One per accepted modified event | Approximate count of cleaner invocations that removed fields/objects; not unique HTTP responses or ads |
| `youtubePayloadCleans` | One per the same modified event | Legacy alias of modifications, not a separate event or an already-clean payload |
| `youtubeFieldsPruned` | Historical counts of removed ad-related keys | Cleaner still counts locally, but current transport discards the detail |
| `youtubeAdObjectsRemoved` | Historical counts of removed promoted/ad renderer items | Same transport limitation; preserved for export compatibility |
| `scriptletHits` | Wrapped scriptlet function/resource initialization returned without a synchronous throw | Does not prove an ad was blocked; early returns/no-op initialization also count; later callback actions are not counted |
| `scriptletErrors` | Synchronous error caught by the wrapper | Does not cover registration/download failures, async rejection or later hook errors; zero is not proof of no errors |
| `networkBlocks` | DNR feedback classified as block | Includes redirect and upgradeScheme actions, including tracking URL cleanup and Spotify media redirects |
| `networkAllows` | Explicit `allow`/`allowAllRequests` rule feedback | Not every request that was permitted; not a protection event |
| `unknownDnrMatches` | DNR feedback that cannot be classified as block/allow | Includes unsupported/neutral actions such as modifyHeaders, not only unknown rule IDs |
| `cosmeticHides`, `warningSuppressions`, `zapperHits` | Accepted coarse reports from the respective content paths | Since July, input counts are discarded: a report can summarize multiple elements but adds one. Caps can drop reports |
| `proxyTests` | Recorded completed pass/failure outcomes, including invalid/not-configured attempts | Cached successes do not increment; not the number of clicks or individual fallback HTTP requests |
| `proxyAuthChallenges` | Batched proxy authentication events | Separate activity; not successful authentications or protection |
| `fprActivations` | Background fingerprint-script registration/update activity | Not each page execution; excluded from protectionEvents |

`timeSavedSeconds = floor(protectionEvents * 0.005)`. This is an arbitrary estimate, not measured latency or bytes saved.

## YouTube pipeline and discontinuity

`extension/content/yt_handler.js`: `cleanYoutubePayload` calls `stripAdFields`, nested player-response cleanup, and `stripResponseAds`/`pruneResponseAdItems`. The same helper is used by initial player/data setters, fetch, XHR and a filtered JSON.parse hook. `finishPayloadStats` emits only when `fieldsPruned` or `adObjectsRemoved` is nonzero. Removing an empty ad field still changes the payload and legitimately emits. An unchanged clean payload emits nothing.

Commit `0aeb467` (May 7, 18:19 EDT) suppressed all unmodified inspections for performance. Thus identical inspections/modifications/cleans predate July. Commit `a37b43c` (July 13, 17:42 EDT; 21:42 UTC) replaced rich YouTube event objects with the single `youtube_payload_modified` enum. The local cleaner still removes and counts keys/items; it no longer forwards those counts. This explains the July 14 onset of persistent exported zeros without a loss of cleaning functionality.

Transport: `__CHROMA_STATS_EVENT__` → `protection.js` listener → 750 ms batch → `STATS_EVENT_BATCH` → `diagnosticHandlers.handleStatsEventBatch` → `stats.recordContentStatsEvents`. The background factory sets inspected=1, modified=1, cleans=1 from that enum. It accepts no page-supplied counts, URLs, times, source labels or rule metadata. The background derives the top-level domain from Chrome's sender tab.

Consequently, an exported modification with zero field/object counts is normal under today's schema. Those zeros mean uncollected detail. At the producer, a zero/zero cleanup does not emit. Page DOM events are forgeable, however, so accepted reports are not authenticated proof of a modification.

The collector counts a mutation before fetch reconstruction/XHR property replacement finishes; a later serialization/replacement failure can leave a counted mutation that the page did not receive. Initial setters/JSON.parse operate on the actual object; the entire system measures cleanup operations rather than confirmed user-visible ad suppression. Repeated independent payload copies may each count; a second pass on an already-clean object does not emit. SABR recovery, acceleration, beacon suppression and other platform hooks have no general payload-counter coverage.

Recommendation: keep modifications as the canonical reported metric; deprecate the inspection/clean aliases and field/object details in documentation/export metadata. Do not synthesize counts or reinstate one message per unchanged inspection. Genuine total inspections or exact removals would require a separate, explicitly versioned and bounded telemetry design.

## Scriptlet coverage and the startup bug

`extension/scriptlets/engine.js` uses `buildSubscriptionScriptletCode` for library functions selected by filter-list `##+js(...)` rules, and `buildUserResourceCode` for fetched user resources selected by user rules. `buildManagedUserScripts` registers both through `chrome.userScripts` in MAIN. Default runAt is document_start; resource scripts use allFrames. Remote source loading in `userResources.js` is not itself scriptlet execution.

Both wrappers emit `__CHROMA_SCRIPTLET_STATS__` with only `{type: 'hit'}` after synchronous return, or `{type: 'error'}` on a synchronous exception. User resources, including configured Spotify Ad Skip resources, therefore already use the same instrumentation. They are not intentionally excluded.

Related history: `8f05f91` (May 19) removed scriptlet identity/source/error detail from the page event for privacy, before the July change. `c9fe84b` (June 19) added the user-resource wrapper. Missing recent per-scriptlet/source breakdowns should therefore not be mistaken for a new user-resource schema mismatch.

`extension/content/content.js` installs the listener before starting `init`, but `init` awaits `chrome.storage.local.get`. July's new `isStatsFeatureActive` rejects every report until `statsConfigReady` is true. A scriptlet running at document_start after the listener is installed but before that await resolves is deterministically lost. Existing tests waited for initialization before dispatch, missing this race. This is a strong explanation for the drop from 80 on July 13 to 1 on July 14 and then zero. The export does not record extension install times or individual executions, so it cannot prove that every missing historical event had this cause.

| Execution path | Covered by hit/error wrapper? |
| --- | --- |
| Built-in library function invoked by a subscription scriptlet rule | Yes |
| Filter-list `##+js(...)` entry supported by SCRIPTLET_MAP | Yes |
| User-defined rule selecting a local cached remote resource | Yes |
| Remotely loaded User Scriptlet, including Spotify Ad Skip | Yes, when executed; fetch/registration is separate |
| `chrome.userScripts` registration itself | No execution count; failures go to health diagnostics |
| Fingerprint randomization via `chrome.scripting.registerContentScripts` MAIN | No scriptletHits; background fprActivations only |
| Quiet console, Yahoo/recipe, interceptor and platform MAIN scripts | No generic scriptlet hit/error wrapper |
| Built-in Spotify media redirects | DNR network classification, not scriptletHits |
| Zapper executeScript path | Dedicated zapper counter |

Minimal fix: hold at most 20 enum strings while config is pending, then feed them through the existing gate/rate limiter/batcher. Discard on disabled/whitelisted/failed initialization. This adds no messages per hook invocation, no full URLs and no scriptlet names.

Residual limit: an event emitted before the isolated listener exists cannot be recovered by this buffer. The two APIs do not provide a cross-world execution-order guarantee here. Do not delay blocking scripts to collect statistics. If exact initialization coverage later becomes necessary, design a bounded startup handshake/coalesced report per document; authenticate/gate in the isolated/background layers and retain approximate status for page-originated reports. Avoid telemetry inside per-request, per-property-access or mutation-observer scriptlet hot paths. Keep initialization runs separate from any future metric for actual protection effects.

## DNR classification and allow traffic

`requestLog.initRequestLogListener` listens to `onRuleMatchedDebug`; `recordMatchedRule` calls `dnrState.classifyDnrMatch` and forwards one network event to stats. Static rules are identified by ruleset ID with explicit known allow overrides; other current static rules default to block. Default and subscription dynamic IDs use a coarse action cache. Whitelist IDs map to allow. Both `rulesetId` and legacy `ruleSetId` spellings are accepted. There is no session-rule installation path in this checkout and no session action cache; introducing one would need namespace-aware classification.

July's `a37b43c` added `hydrateDynamicRuleClassifications`, rebuilding the map from Chrome's installed dynamic rules on every worker evaluation, and a bounded early-match buffer in requestLog. Before that, a sleeping worker could wake with an empty cache, producing neutral/default-dynamic matches. The export corroborates this: all **38,067** unknown matches are in default-dynamic rules; the largest are rule 1015 (21,220), 1006 (8,830), 1007 (4,242), and 1009 (2,654). Recent real block/allow feedback continues. Zero unknowns is expected improvement, not evidence that all DNR feedback stopped.

The 258,326 allows (224,533 under www.youtube.com) are explicit rule matches. The dominant retained allow rules are custom-static 30014 (178,239) and 30015 (67,558). Site attribution here is the **request destination**, whereas content events use the **top-level sender tab**. Site rows therefore do not consistently represent the website the user visited. They also combine non-protection activity in their displayed row total.

Chrome documents matched-rule debug feedback as available to unpacked extensions with the feedback permission: [DNR API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#event-onRuleMatchedDebug). A packaged build may enforce rules without feeding these counters. The statistic is matched-rule feedback, not a complete network census. No fallback polling is added.

## Protection formula and duplicate accounting

`stats.buildCounterPatch` increments protectionEvents for network block, cosmetic, warning, scriptlet hit and zapper events. For YouTube, it adds `max(cleans, modified, count)` once when any clean, modified, field or object delta is positive. Current coarse modified events have all relevant counts equal to one. It does **not** sum inspections + modifications + cleans + fields + objects.

Explicitly excluded: allow matches, unknown/neutral DNR feedback, scriptlet errors, proxy tests, proxy authentication and fingerprint registration. The dormant internal `proxy/type:test` branch can increment tests without an outcome, but no production producer calls it. Current production proxy events always increment a test and one outcome together.

The headline is still mixed activity, not unique prevented ads. A scriptlet's successful initialization can be a no-op; cosmetic reports are batches; different layers can act on related content. Zapper save sends a hit after success, and installing the saved selector can also cause a content-script zapper hit on the same element. Per-selector-group WeakSets reduce repeat cosmetic reporting, but do not deduplicate across layers. Fixing that globally would need identities and additional state; recommend retaining an explicitly approximate activity definition instead.

The hero's Proxy number is separate activity and does not add to its headline; the hero omits separate warning/zapper subtotals. Ad Cleanups is cosmeticHides + youtubePayloadCleans. Relabel scriptlet hits as runs and explain the formula, rather than silently removing historical runs from the headline.

## Proxy review

`proxy.runProxyTest` records a final test_pass or test_failure; `fetchProxyIp` fallback requests share that outcome. A successful cached result returns without counting another test, including the cache recheck under the serialization lock. Early invalid config/control failures produce a failure outcome. Retries do not independently increment the test counter.

An exception before the inner fetch try can return failure from the outer catch without recording a test; storage rejection before the outer try can reject without any count. A cleanup failure after a recorded pass can make the caller see failure while the network probe's pass remains counted. These are coverage/meaning limits, not a path that increments tests without an outcome. No proxy control or retry changes are warranted for the reported invariant. If the desired metric becomes every user-requested test attempt, use a separate attempt/outcome contract rather than changing this meaning silently.

`flushProxyAuthStats` batches authentication events (up to the configured flush threshold/timer) into trusted background count deltas. The current export's 960 challenges are excluded from protection counts.

## Persistence, aggregation, privacy and ranges

1. Content pages batch for 750 ms; each content/protection ingress accepts at most 20 events per minute per document. Background accepts at most 100 entries per batch, 60 per tab per minute and 300 globally per minute. Malformed, disabled and whitelisted traffic is ignored. Bursts can be dropped by design; all content metric types share the relevant quotas.
2. `recordStatsEvent` queues trusted normalized events in memory, retaining the newest 1,000. A 500 ms flush reads/normalizes statsV2, applies one patch to lifetime totals and eligible detail buckets, prunes bounded detail and writes the whole object. Scheduled flushes process one batch; explicit snapshots drain recorded events.
3. `applyStatsEvent` writes totals first. Basic mode skips new detail only; it preserves earlier detail. Aggregated/debug also update UTC day, domain, available resource/rule dimensions and recent events. Missing dimensions do not imply missing lifetime events. Current coarse content events have no rule/source metadata; historic scriptlet byRule rows stop gaining detail.
4. `pruneByDay` keeps today plus the preceding retentionDays−1 UTC dates. Site/rule/resource tables are capped by activity, with lastSeen as tie breaker; they are **not age-expired** by retentionDays. Recent events are limited by number, not days. An evicted bucket can later reappear with a fresh partial history. None of these prunes subtract from totals.
5. `getStatsSnapshot` derives today/7/30 from retained UTC byDay buckets; allTime is the lifetime total. Basic-mode periods, timeline resets or retention shorter than the requested range make daily ranges incomplete. UTC explains why the supplied export already has an October 1 row while the user's local date was September 30. Future-dated rows are not explicitly removed; clock jumps are an additional diagnostic limitation.
6. `exportStats` uses that same snapshot. `app.js` consumes totals/ranges, displays the top ten site/rule rows, up to fourteen populated daily rows, and twelve recent events. The timeline is the latest populated dates, not necessarily fourteen consecutive days. Detailed row activity includes allows/unknowns/errors, so it does not equal protections alone.
7. All statistics are local. Aggregated mode removes full URLs and redacts error URLs/email text. New fixes retain enum-only content telemetry and do not change privacy defaults. The separate, existing `requestLog` retains full DNR URLs regardless of stats mode; it is not part of this export or governed by these retention settings.

Confirmed persistence race: flushes and full reset already use `flushChain`, but settings changes, partial reset writes and normalization triggered by empty flushes/snapshots did not. Awaiting the current chain before an unqueued read/modify/write is insufficient: a new flush can intervene and its totals can be overwritten. The fix serializes those operations on the same queue; no per-event writes or separate storage service is introduced.

Remaining delivery limits: fire-and-forget content messages are not retried; navigation can lose a pending page batch; the worker's in-memory queue can be lost on termination; overflow discards old events; a failed storage write loses its spliced batch (an existing regression test explicitly expects recovery of subsequent writes, not replay). These are approximate-delivery limits, not the cause of the selective July field-counter disappearance. [Chrome worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) confirms that in-memory state does not persist across termination. Durable journals/retries would add write overhead and duplicate-handling complexity; recommend them only if lossless analytics becomes a requirement.

## Validation and follow-ups

- Reproduce startup loss before fixing; test hit and error enums during a delayed config read, quota saturation, disabled/whitelisted gates, failed initialization and removal of supplied metadata.
- Gate writes to reproduce and prevent lost increments for settings, each partial reset, and normalization during a concurrent flush; preserve existing full reset and write-failure behavior.
- Test missing/null rule IDs across aggregation and normalization.
- Test modification-only telemetry, repeated cleanup of the same object, no multiplication by removed-field/object counts, exclusion of diagnostic/proxy/allow events, and proxy test outcome equality.
- Preserve export numeric keys and old values; add descriptive collection metadata. Test that metadata does not enter persisted stats or summary-only snapshots.
- Verify cap/retention pruning leaves lifetime totals intact, and UTC range calculations agree with retained days.
- Run the repository Node suite and generated-guide checks. Browser ordering before the listener exists remains an explicitly unverified limit; it is not claimed fixed by unit tests.

Do not backfill past inspections/removals/scriptlet executions: the export lacks the evidence needed to reconstruct them. Do not reset lifetime totals or compare pre-/post-July rates as though collection were unchanged.

### Implemented and checked

- Implemented the bounded startup buffer, serialized stats storage operations and null-ID correction described above.
- Clarified dashboard labels, retention scope, UTC ranges and protection/allow/proxy semantics. Added snapshot-only `collection` descriptions while keeping version 1 numeric keys, historical values, batching and privacy defaults intact.
- Added regressions for the three reproduced bugs, both scriptlet wrapper types, one-event-per-YouTube-cleanup behavior, protection exclusions, proxy outcome equality, cap/retention independence, exported semantics and rendered labels.
- `npm.cmd run test:ci`: **785 tests passed**, no failures or skips; all **300,000 static rules** validated; 1.9.4 ZIP and update manifest verification passed.
- `npm.cmd run docs:build` regenerated the statistics guide and search index; `npm.cmd run docs:check` passed. `git diff --check` passed.
- Browser E2E was not run. Real-browser ordering before listener installation, actual user-script execution in the supplied profile and historical install timing are not proven by these checks. Those limits do not invalidate the deterministic startup/config and storage-race regressions.

Storage remains one bounded whole-object write per nonempty scheduled batch under ordinary flow, with additional writes for settings/reset/normalization. At sustained traffic the 500 ms schedule can rewrite the capped dataset frequently; normalization also scans it on reads. This pre-existing cost merits profiling if observed in practice, not adding richer per-operation analytics. The fixes add no storage to the page execution hot path and no new telemetry transport.
