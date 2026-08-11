# Filter List Subscriptions

Chroma ships with a mix of bundled and remote filter sources. Requested-enabled remote lists are fetched directly by your browser on their configured schedule, parsed locally, and cached in `chrome.storage.local`. Applying those cached rules is a separate lifecycle decision: master protection and each relevant feature gate determine whether the network, cosmetic, or scriptlet runtime is active.

## Bundled And Default Sources

| List | Source | Default refresh | What it can affect |
|---|---|---:|---|
| **Chroma Scriptlet Library** | Bundled inside the extension package | Local bundled file | Chroma-maintained scriptlet compatibility rules. Updates only when the extension package changes. |
| **Hagezi Pro Mini** | Hagezi remote list | 24 hours | Network DNR subscription rules after parsing, static deduplication, and dynamic-rule allocation. |
| **EasyList** | EasyList remote list | 24 hours | Cosmetic rules and supported scriptlets only; not allocated to network DNR. |
| **Fanboy Annoyance** | Fanboy remote list | 24 hours | Cosmetic annoyance rules and supported scriptlets only; not allocated to network DNR. |

Chroma does not use a hidden remote hotfix list. Project fixes arrive through visible Chroma updates, and every additional remote list is one you explicitly choose to add.

> [!NOTE]
> To maximize performance and respect Manifest V3 rule limits, **EasyList** and **Fanboy Annoyance** are not allocated to network-level DNR blocking. Their cosmetic rules, and any supported scriptlets parsed from enabled lists, feed the cosmetic and scriptlet layers instead. Network-level blocking is handled by the high-efficiency static ruleset and Hagezi Pro Mini.

Chrome [guarantees at least 30,000 static DNR rules per extension](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#rule-limits), while additional static capacity comes from a browser-wide pool shared by installed extensions. Chroma's multi-part OISD packaging does not bypass that platform quota, so other rule-heavy extensions can reduce the extra static capacity available beyond Chrome's guaranteed minimum.

## Custom Filter List Subscriptions

Chroma supports user-added filter list subscriptions. You can host your own list in a GitHub repository, GitHub Gist, or any HTTPS endpoint that serves raw filter-list text, then paste the raw `https://` URL into Chroma's subscription manager.

Custom subscriptions can include supported Adblock/uBO-style network rules, cosmetic rules, cosmetic exceptions, and scriptlet rules. During refresh, Chroma parses the list into network, cosmetic, and scriptlet buckets, drops unsupported or malformed rules, deduplicates network rules already covered by the bundled static ruleset, and only keeps scriptlets that map to Chroma's shipped scriptlet library.

Network rules are compiled to Chrome Declarative Net Request rules on a best-effort basis. Simple wildcard host patterns such as `||cdn.*.example/path` may be translated to DNR regular expressions, while URL filters that cannot be represented safely are skipped so the rest of the custom list can still load.

After each refresh, Chroma records how many network filters were translated for DNR compatibility and how many unsupported URL-filter patterns were skipped. Settings only shows those compatibility details when a list actually needs them.

### Parser Trust Boundary

Network options are accepted only when Chroma can preserve their meaning in DNR. Supported constraints include recognized resource types, `$important`, first/third-party forms and their supported negations, and validated `$domain=` inclusions and exclusions.

Constraint-bearing options that Chroma cannot represent safely, including `$method`, `$match-case`, `$header`, and similar modifiers, cause the complete block or exception rule to be dropped. Chroma never removes an unsupported constraint and then installs a broader rule. Malformed lines are counted and dropped individually so one bad line does not reject valid siblings.

Cosmetic and scriptlet domain inclusions and exclusions are stored separately. An exclusion-only rule such as `~example.com##.ad` is treated as global except on the excluded domain rather than being discarded or applied only to that domain.

## Advanced User Scriptlet Resources

Chroma also has a separate advanced settings area for user-provided scriptlet resources. This is not a filter-list subscription feature: resources are executable code selected by the user, and they run only after the user adds both a trusted resource URL and matching `domain##+js(resource-name)` rules.

For setup steps, safe examples, linked-resource badges, troubleshooting, and the trust boundary, see [Advanced User Scriptlets](ADVANCED_USER_SCRIPTLETS.md).

## Why Custom Lists Still Work In MV3

Manifest V3 does not allow extensions to intercept and decide every request in JavaScript the way MV2 blockers often did. Chroma's subscription design works around that by doing the expensive work at refresh time instead of request time.

It fetches and parses the list locally, converts supported network rules into DNR dynamic rules, and lets Chrome's browser engine enforce those rules without waking the extension for every request.

Rules that do not belong in DNR are handled by the layers that fit them:

- Cosmetic selectors go to the cosmetic filtering layer.
- Supported scriptlets go to the `userScripts` engine.
- Unsupported syntax is dropped instead of being guessed at.

This is why custom lists can still be useful in MV3 while staying inside Chrome's rule budgets and execution model.

## Rule Allocation

Network rules are allocated by Chroma's internal priority score before being applied to DNR:

- Exception/allow rules are preserved first.
- `$important` block rules receive a higher score.
- Domain/resource-type-specific rules are favored next.
- Earlier list position acts as a final tiebreaker.

This lets custom lists express urgency while still respecting Manifest V3 dynamic-rule budgets.

New custom lists default to a 24-hour refresh interval unless you choose another interval in Settings.

## Protection Lifecycle And Cached Restoration

Subscription request state, cached parse results, and active browser state are deliberately separate:

- Turning master protection off removes subscription DNR application, subscription cosmetics, and Chroma-managed subscription and advanced `userScripts`. Per-list caches, requested enabled states, and advanced resource data remain stored.
- Turning only **Network Blocking** off removes network DNR application, including dynamic whitelist allow rules, without disabling master-enabled cosmetic or scriptlet layers.
- Manual or scheduled refresh while a layer is off may still fetch, parse, and update that list's cache, but it cannot reactivate inactive DNR or `userScripts`.
- Re-enabling protection restores runtime rules from cached data without requiring another network fetch. Startup, worker recovery, and an HTTP `304 Not Modified` also reconcile the active runtime from cache when necessary.
- Whitelist destination rules for top-level navigation and initiator rules for subresources are installed only while network protection is active.

A refresh that started earlier cannot override a newer master-protection or **Network Blocking** choice.

## Remote URL Network Boundary

Custom remote URLs must use HTTPS on the default port and cannot contain credentials. Chroma rejects URLs that literally name localhost or private/special-use IPv4 or IPv6 addresses, and it revalidates the final response URL before accepting response metadata or body content.

DNS resolution and redirect transport are performed by Chromium. Chroma cannot inspect or pin the connection's peer IP, so a public-looking hostname could resolve or rebind to a private address, and Chromium may contact an automatically followed redirect before Chroma rejects its final URL. Add only remote sources you trust.

## Example Custom List

```adblock
! Higher-priority network block. `$important` receives a stronger Chroma allocation score.
||example-ad-server.com^$script,third-party,important

! Cosmetic rule: hide sponsored cards on one site.
example.com##.sponsored-card

! Cosmetic exception: preserve a subset if the broad cosmetic rule is too aggressive.
example.com#@#.sponsored-card.keep-visible

! Scriptlet rule: run a supported Chroma/uBO-style scriptlet on a site.
example.com##+js(set-constant, adsEnabled, false)
```

## Remote List Trust Boundary

Remote list content is not treated as arbitrary code. Lists are fetched over HTTPS, parsed locally, bounded by response-size and rule-budget limits, deduplicated against bundled static rules where applicable, and unsupported syntax is dropped. Scriptlet rules can only call implementations already shipped in Chroma's bundled scriptlet library.

Advanced user scriptlet resources are the explicit exception to this model. They are not installed by Chroma, not bundled with Chroma, and not activated through filter-list subscriptions. They run only after the user adds a resource URL and matching user scriptlet rules in settings.

Because enabled remote lists can still change blocking, allow rules, cosmetic behavior, or supported scriptlet behavior after installation, users who need a stricter trust model should review and disable subscriptions they do not want to trust from Chroma settings. Additional custom subscriptions are always user-selected.

## Third-Party Credits

Chroma uses or derives logic and patterns from the following open-source projects and filter-list sources:

- **Brave Browser**: The YouTube ad-stripping logic, including payload metadata pruning patterns, is derived from Brave's ad-blocking scriptlets under the [MPL 2.0](https://mozilla.org/MPL/2.0/).
- **HaGeZi Pro Mini** by [HaGeZi](https://gitlab.com/hagezi/mirror): [GNU General Public License version 3](https://gitlab.com/hagezi/mirror/-/blob/main/LICENSE).
- **OISD Small, Big, and NSFW** by [OISD](https://oisd.nl): [GNU General Public License version 3](https://github.com/sjhgvr/oisd/blob/main/LICENSE). Small and Big are selected first. When they do not fill the packaged static budget, Chroma selects adult and shock-site domains from across OISD NSFW until the complete corpus reaches 300,000 rules.
- **EasyList** by the [EasyList authors](https://github.com/easylist/easylist): the EasyList repository is [dual-licensed under GPLv3-or-later or CC BY-SA 3.0-or-later](https://easylist.to/pages/licence.html), unless otherwise noted.
- **Fanboy's Annoyance List** by the [EasyList/Fanboy maintainers](https://easylist.to/): the configured list declares the [Creative Commons Attribution 3.0 license](https://creativecommons.org/licenses/by/3.0/) in its source header.

---

Next: [Permissions](PERMISSIONS.md)
