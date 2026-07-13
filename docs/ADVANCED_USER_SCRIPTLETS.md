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

Resource URLs must be public `https://` URLs using the default HTTPS port, with no username or password in the URL. Localhost and private-network hosts are rejected.

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
| Resource URL will not add | The URL is not a permitted public HTTPS URL. | Use a raw `https://` URL with no credentials, no custom port, and no local/private host. |
| Nothing changes on the page | The tab loaded before the scriptlet was registered, or the domain rule does not match. | Reload the tab and check the rule domain. |
| Scriptlet errors do not appear in DevTools | Quiet Console is enabled. | Turn off **Quiet Console** in settings while debugging, then reload the affected tab. |
| A site stays broken after removal | The old script already ran in that page document. | Remove the rule/resource, then reload the affected tab. |
| Health says UserScripts unavailable | Chrome has not enabled Chroma's `userScripts` access. | Open the extension details page and enable **Allow User Scripts**. |

## Backup Behavior

Settings export stores resource URLs and saved rules, but not cached executable code. After importing settings on another browser profile, refresh the resource URLs, confirm the resources parse, and reload affected tabs before expecting the rules to run.

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
