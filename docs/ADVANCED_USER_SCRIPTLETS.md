# Advanced User Scriptlets

Advanced User Scriptlets let you run small, trusted, site-specific JavaScript patches through Chrome's `userScripts` API. This is for personal fixes and experiments that Chroma should not bundle for every user.

Use this feature when a normal filter list, cosmetic rule, or Element Zapper rule is not enough.

## When To Use This

Good use cases:

- Fix one site that blocks copy, paste, selection, or right-click.
- Remove a scroll lock after a modal or interstitial closes.
- Patch a niche video player behavior on a site you personally use.
- Test a scriptlet locally before proposing it for Chroma's bundled scriptlet library.
- Run a trusted third-party scriptlet resource, such as a specialized video-site fix, only on the domain you choose.

Avoid this feature for:

- Random code copied from comments, forums, or untrusted gists.
- Banking, medical, identity, work-admin, password-manager, or other high-risk pages.
- Broad rules such as `*##+js(...)` unless you fully understand the code.
- Problems that can be solved with Element Zapper or a cosmetic rule.

## Trust Model

User scriptlet resources are executable code. Chroma does not bundle them, audit them, or activate them automatically from remote filter lists.

They run only when all of these are true:

1. Chroma's master protection switch is enabled.
2. You add a trusted HTTPS resource URL in settings.
3. Chroma successfully parses one or more JavaScript resources from that file.
4. You save a matching `domain##+js(resource-name)` rule.
5. Chrome's **Allow User Scripts** setting is enabled for Chroma.

Turning master protection off unregisters advanced user scriptlets while keeping
their cached resources and rules available for restoration when protection is
enabled again.

Resource URLs must use `https://` on the default port and cannot contain a username or password. Chroma rejects literal localhost and private/special-use IP addresses, but Chromium performs DNS resolution and Chroma cannot guarantee that a public-looking hostname will not resolve or rebind to a private address. Add only sources you trust; see [Remote URL Network Boundary](SECURITY.md#remote-url-network-boundary).

## Setup Flow

1. Open Chroma settings.
2. Go to **User Scriptlets**.
3. Click **Add URL**.
4. Paste a raw HTTPS resource URL.
5. Confirm that Chroma shows parsed resources under **Available Resources**.
6. Add rules in the **Rules** box.
7. Click **Save Rules**.
8. Reload affected tabs so newly registered scriptlets run with the intended page timing.

## Resource File Format

Resource files use uBlock Origin-style resource entries:

```text
resource-name.js text/javascript (() => {
  // trusted user-provided code
})();
```

The `.js` suffix is normalized. If the resource is named `resource-name.js`, you call it as `resource-name` in a rule:

```adblock
example.com##+js(resource-name)
```

Multiple resources can live in the same file:

```text
restore-selection.js text/javascript (() => {
  const stop = event => event.stopImmediatePropagation();
  document.addEventListener('copy', stop, true);
  document.addEventListener('cut', stop, true);
  document.addEventListener('contextmenu', stop, true);
  const style = document.createElement('style');
  style.textContent = '* { user-select: text !important; -webkit-user-select: text !important; }';
  document.documentElement.appendChild(style);
})();

unlock-scroll.js text/javascript (() => {
  const unlock = () => {
    for (const node of [document.documentElement, document.body]) {
      if (!node) continue;
      node.style.overflow = '';
      node.style.position = '';
      node.style.touchAction = '';
    }
  };
  unlock();
  new MutationObserver(unlock).observe(document.documentElement, {
    attributes: true,
    subtree: true,
    attributeFilter: ['style', 'class']
  });
})();
```

Then activate them only where needed:

```adblock
example.com##+js(restore-selection)
news.example##+js(unlock-scroll)
```

## Resource Count And Operational Bounds

Chroma does not impose a total number-of-resources limit on an accepted resource file. Chrome registration is sent in groups of 100 so a rejected batch can be retried one script at a time; 100 is a registration batch size, not a resource ceiling.

The advanced lane retains these operational safeguards:

- 2 MiB maximum response per resource URL.
- 512 KiB maximum code size for one parsed resource.
- 20 configured resource URLs.
- 256 KiB total user-rule text.
- 1,000 parsed user rules.
- 8,192 characters per rule line.

Malformed, duplicate, unsupported-MIME, empty, or overlong resource entries are skipped while valid siblings remain available. Chrome registration failures are likewise isolated within their 100-script batch so one malformed registration does not discard later batches.

## Reading The Status Badges

The **Available Resources** chips show whether saved rules are actually connected:

- **Linked** means at least one saved rule references that parsed resource.
- **Unused** means the resource was parsed, but no saved rule calls it.
- **Missing** means a saved rule references a resource name that is not currently available.

For example:

```adblock
example.com##+js(restore-selection)
```

If `restore-selection.js` is available, the chip shows **Linked**. If the resource URL was removed, failed to parse, or renamed the resource, Chroma shows **Missing**.

## Real Examples

### Restore Selection On One Site

Resource:

```text
restore-selection.js text/javascript (() => {
  const stop = event => event.stopImmediatePropagation();
  document.addEventListener('copy', stop, true);
  document.addEventListener('contextmenu', stop, true);
  const style = document.createElement('style');
  style.textContent = '* { user-select: text !important; -webkit-user-select: text !important; }';
  document.documentElement.appendChild(style);
})();
```

Rule:

```adblock
example.com##+js(restore-selection)
```

### Remove A Persistent Scroll Lock

Resource:

```text
unlock-scroll.js text/javascript (() => {
  const unlock = () => {
    document.documentElement.style.overflow = '';
    if (document.body) document.body.style.overflow = '';
  };
  unlock();
  new MutationObserver(unlock).observe(document.documentElement, {
    attributes: true,
    subtree: true,
    attributeFilter: ['style']
  });
})();
```

Rule:

```adblock
example.com##+js(unlock-scroll)
```

If a patch needs the page body to exist first, use an explicit later timing flag:

```adblock
example.com##+js(unlock-scroll, runAt=end)
```

### Run A Trusted Video-Site Patch

If a project you personally trust publishes a uBO-style resource file, add its raw HTTPS URL, verify the parsed resource name, then save the narrowest matching rule possible:

```adblock
twitch.tv##+js(twitch-videoad)
```

## Troubleshooting

| Symptom | What it usually means | Fix |
|---|---|---|
| Resource shows **Unused** | The resource parsed, but no saved rule references it. | Add or edit a `domain##+js(resource-name)` rule. |
| Rule status shows **Missing** | A saved rule references a resource that is not available. | Check the resource name, refresh the URL, or remove the stale rule. |
| Resource URL will not add | The URL fails Chroma's literal URL checks. | Use a raw `https://` URL with no credentials, no custom port, and no literal localhost/private/special-use address. DNS-resolved addresses remain part of the trusted-source boundary. |
| Nothing changes on the page | The tab loaded before the scriptlet was registered, or the domain rule does not match. | Reload the tab and check the rule domain. |
| Scriptlet errors do not appear in DevTools | Quiet Console is enabled. | Turn off **Quiet Console** in settings while debugging, then reload the affected tab. |
| A site stays broken after removal | The old script already ran in that page document. | Remove the rule/resource, then reload the affected tab. |
| Health says UserScripts unavailable | Chrome has not enabled Chroma's `userScripts` access. | Open the extension details page and enable **Allow User Scripts**. |

## Backup Behavior

Settings export stores resource URLs and saved rules, but not cached executable code. Import validates the complete versioned backup and all user-scriptlet rule text before changing storage. If runtime reconciliation fails after commit, Chroma attempts to restore the previous storage and runtime state and reports an incomplete rollback instead of hiding it.

After importing settings on another browser profile, refresh the resource URLs, confirm the resources parse, and reload affected tabs before expecting the rules to run. See [Settings Backup And Import](INSTALL.md#settings-backup-and-import) for the complete transaction boundary.

## Safer Rule Habits

- Prefer exact domains such as `example.com##+js(...)`.
- Avoid broad or global domains.
- Keep resource files small and readable.
- Remove unused resources.
- Review any third-party resource contents before adding them.
- Prefer code you can inspect and understand.
- Reload tabs after adding, refreshing, or removing user scriptlets.

---

Next: [Filter List Subscriptions](FILTER_LISTS.md)
