# Filter List Subscriptions

Chroma ships with a mix of bundled and remote filter sources. Enabled remote lists are fetched directly by your browser on their configured schedule, parsed locally, cached in `chrome.storage.local`, and then applied through the network, cosmetic, or scriptlet layer that matches each supported rule.

## Bundled And Default Sources

| List | Source | Default refresh | What it can affect |
|---|---|---:|---|
| **Chroma Scriptlet Library** | Bundled inside the extension package | Local bundled file | Chroma-maintained scriptlet compatibility rules. Updates only when the extension package changes. |
| **Hagezi Pro Mini** | Hagezi remote list | 24 hours | Network DNR subscription rules after parsing, static deduplication, and dynamic-rule allocation. |
| **EasyList** | EasyList remote list | 24 hours | Cosmetic rules and supported scriptlets only; not allocated to network DNR. |
| **Fanboy Annoyance** | Fanboy remote list | 24 hours | Cosmetic annoyance rules and supported scriptlets only; not allocated to network DNR. |

Chroma does not ship a maintainer-controlled hotfix subscription. Project fixes are delivered through GitHub release packages, and the popup can notify you when a newer release is available. If you want to trust an additional remote list, add it explicitly as a custom subscription.

> [!NOTE]
> To maximize performance and respect Manifest V3 rule limits, **EasyList** and **Fanboy Annoyance** are not allocated to network-level DNR blocking. Their cosmetic rules, and any supported scriptlets parsed from enabled lists, feed the cosmetic and scriptlet layers instead. Network-level blocking is handled by the high-efficiency static ruleset and Hagezi Pro Mini.

## Custom Filter List Subscriptions

Chroma supports user-added filter list subscriptions. You can host your own list in a GitHub repository, GitHub Gist, or any HTTPS endpoint that serves raw filter-list text, then paste the raw `https://` URL into Chroma's subscription manager.

Custom subscriptions can include supported Adblock/uBO-style network rules, cosmetic rules, cosmetic exceptions, and scriptlet rules. During refresh, Chroma parses the list into network, cosmetic, and scriptlet buckets, drops unsupported or malformed rules, deduplicates network rules already covered by the bundled static ruleset, and only keeps scriptlets that map to Chroma's shipped scriptlet library.

Network rules are compiled to Chrome Declarative Net Request rules on a best-effort basis. Simple wildcard host patterns such as `||cdn.*.example/path` may be translated to DNR regular expressions, while URL filters that cannot be represented safely are skipped so the rest of the custom list can still load.

After each refresh, Chroma records how many network filters were translated for DNR compatibility and how many unsupported network filters were skipped. Settings only shows those compatibility details when a list actually needs them.

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

Custom subscription URLs must use `https://`, must not include credentials, must use the default HTTPS port, and cannot point to local/private network hosts. New custom lists default to a 24-hour refresh interval unless a different valid interval is supplied by the UI or message API.

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

For the security-policy version of this boundary, see [Security Policy](SECURITY.md#remote-list-trust-boundary).

## Third-Party Credits

Chroma utilizes logic and patterns derived from the following open-source projects:

- **Brave Browser**: The YouTube ad-stripping logic, including payload metadata pruning patterns, is derived from Brave's ad-blocking scriptlets under the [MPL 2.0](https://mozilla.org/MPL/2.0/).
- **Hagezi Pro Mini** by [hagezi](https://github.com/hagezi/dns-blocklists): [MIT License](https://github.com/hagezi/dns-blocklists/blob/main/LICENSE).
- **OISD Big** by [oisd](https://oisd.nl): [License](https://github.com/sjhgvr/oisd/blob/main/LICENSE).

---

Next: [Permissions](PERMISSIONS.md)
