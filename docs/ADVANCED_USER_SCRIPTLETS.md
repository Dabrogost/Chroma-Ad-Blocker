# Advanced User Scriptlets

Advanced User Scriptlets let you run small, trusted, site-specific JavaScript patches through Chrome's `userScripts` API. This is for personal fixes and experiments that Chroma should not bundle for every user.

Use this feature when a normal filter list, cosmetic rule, or Element Zapper rule is not enough.

## When To Use This

Good use cases:

- Fix one site that blocks copy, paste, selection, or right-click.
- Remove a scroll lock after a modal or interstitial closes.
- Patch a niche video player behavior on a site you personally use.
- Run a trusted third-party scriptlet resource, such as a specialized video-site fix, only on the domain you choose.

Avoid this feature for:

- Random code copied from comments, forums, or untrusted gists.
- Banking, medical, identity, work-admin, password-manager, or other high-risk pages.
- Rules that cover every site except a few exclusions.
- Problems that can be solved with Element Zapper or a cosmetic rule.

## Trust Model

User scriptlet resources are executable code. Chroma does not bundle them, audit them, or activate them automatically from remote filter lists.

They run only when all of these are true:

1. Chroma's master protection switch is enabled.
2. You add a trusted HTTPS resource URL in settings.
3. Chroma successfully parses one or more JavaScript resources from that file.
4. You save a matching `domain##+js(resource-name)` rule.
5. Chrome has enabled `userScripts` access for Chroma:
   - **Chrome 138+**: Enable **Allow User Scripts** on Chroma's extension details page.
   - **Chrome 122-137**: Keep **Developer Mode** enabled on `chrome://extensions`.

User-provided resources are arbitrary page-context code. On matching pages and frames, they can read or modify data available to page scripts and can make network requests. Chroma's own no-telemetry promises do not apply to third-party or personal code you choose to add.

Master protection and the site whitelist control whether rules can run. See [Master Protection Lifecycle](FEATURES.md#master-protection-lifecycle) for pause, restoration, and when to reload existing tabs.

Resource URLs must use `https://` on the default port and cannot contain a username or password. Chroma rejects literal localhost and private/special-use IP addresses, but Chromium performs DNS resolution and Chroma cannot guarantee that a public-looking hostname will not resolve or rebind to a private address. Add only sources you trust.

## Setup Flow

1. Open Chroma settings.
2. Select **Scriptlets** in the settings navigation.
3. Click **Add resource URL**.
4. Paste a raw HTTPS resource URL and click **Add**.
5. Confirm that Chroma shows parsed resources under **Available Resources**.
6. Expand **Rules editor** and add rules in the **Rules** box.
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

Multiple resources can live in the same file. This example provides two independent patches: restoring text selection and clearing inline scroll locks. Each needs a matching rule before it runs.

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
      for (const property of ['overflow', 'position', 'touchAction']) {
        if (node.style[property]) node.style[property] = '';
      }
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

Then activate them only where needed. These DOM-editing examples use `runAt=end` so the document is available:

```adblock
example.com##+js(restore-selection, runAt=end)
news.example##+js(unlock-scroll, runAt=end)
```

The scroll example handles inline styles. A lock imposed by a stylesheet, or a site that requires the modal to remain open, needs a site-specific patch. Reload the tab after removing a rule to undo code already running in that document.

## Rule Syntax Reference

Write one rule per line. Lines beginning with `!` are comments. Resource names are case-insensitive, and a trailing `.js` is optional.

| Purpose | Example | Effect |
|---|---|---|
| One site | `example.com##+js(resource-name)` | Runs on `example.com` and its subdomains. |
| Multiple sites | `example.com,example.net##+js(resource-name)` | Runs on either domain and their subdomains. |
| Exclude a subdomain | `example.com,~account.example.com##+js(resource-name)` | Runs on the included domain except the excluded domain and its subdomains. |
| Pass arguments | `example.com##+js(resource-name, first, "second, with comma")` | Passes two string arguments to the resource. Quotes keep a comma inside one argument. |
| Choose timing | `example.com##+js(resource-name, runAt=end)` | Runs at `document_end`; put the timing flag last. |

Use hostnames without a protocol, path, port, or wildcard. A domain-only rule includes subdomains automatically. Rules containing only excluded domains apply broadly to matching browser URLs outside those exclusions; prefer explicit included domains. User resources can also run in frames whose own URLs match the rule. Whitelisted domains are excluded from registration.

Timing options are `runAt=start` (the default, `document_start`), `runAt=end` (`document_end`), and `runAt=idle` (`document_idle`). The equivalent `run-at=document_start`, `run-at=document_end`, and `run-at=document_idle` forms are also accepted. Early hooks may be needed to intercept page code; DOM edits may need later timing. Registration timing is best effort, so a resource may still need to wait for a particular page element.

### Read Arguments In A Resource

Resources receive a `scriptletArgs` array of strings; `chromaScriptletArgs` is an alias. For example:

```text
set-label.js text/javascript (() => {
  const [selector, label] = scriptletArgs;
  const node = document.querySelector(selector);
  if (node) node.textContent = label;
})();
```

```adblock
example.com##+js(set-label, #status, "Ready, locally", runAt=end)
```

For compatible resource templates, `{{args}}` is replaced with the JSON argument array, and `{{1}}`, `{{2}}`, and so on are replaced with escaped string contents. Place numbered substitutions inside quoted JavaScript strings, such as `const label = '{{1}}';`; they are not raw JavaScript expressions. Prefer the argument array when writing your own resources.

## Resource Count And Operational Bounds

Resource files and saved rules have these limits:

- 2 MiB maximum response per resource URL.
- 512 KiB maximum code size for one parsed resource.
- 20 configured resource URLs.
- 256 KiB total user-rule text.
- 1,000 parsed user rules.
- 8,192 characters per rule line.

Chroma skips malformed, duplicate, empty, oversized, or unsupported resource entries. Other valid resources remain available. Check **Available resources** and **Health** if a resource is missing or cannot run.

## Reading The Status Badges

The **Available Resources** chips show whether saved rules are actually connected:

- **Linked** means at least one saved rule references that parsed resource.
- **Unused** means the resource was parsed, but no saved rule calls it.
- **Missing** means a saved rule references a resource name that is not currently available.

For example:

```adblock
example.com##+js(restore-selection)
```

If `restore-selection.js` is available, the chip shows **Linked**. A name typo, an imported rule whose code has not been refreshed, or a successful refresh that removes or renames that resource can produce **Missing**. **Linked** confirms a name match, not successful execution on a page; check **Health** and reload the matching tab when testing.

## Refresh And Removal

- **Refresh** downloads the source again and replaces its cached resources after a successful parse. A failed refresh records an error and keeps the last successfully cached resources, so existing rules can continue to run that older code.
- **Remove a rule** and click **Save Rules** to stop future injection while retaining the source and its cached resources.
- **Remove a resource URL** deletes its cached resources and automatically removes saved rules that reference those resources. Copy any rules you want to reuse before deleting the source.

Reload affected tabs after refreshing or removing code. Unregistering a scriptlet cannot reverse arbitrary code that already ran in an existing document.

## Experimental Alternatives

These optional Spotify and Twitch scriptlets can be added through **Settings -> Scriptlets**. They are experimental, and website changes may affect playback or ad blocking. Keep Chroma's master protection and User Scripts access enabled, as described in [Trust Model](#trust-model).

### Spotify Ad Skip

[Spotify Ad Skip](https://github.com/Dabrogost/Spotify-Scripts) is an alternative to Chroma's built-in Spotify ad-media redirects. It attempts to skip ad states and continue music playback in the Spotify web player.

1. Open **Settings -> Protection -> Spotify** and turn **Spotify ad blocking** off. Leave master protection on.
2. Open **Settings -> Scriptlets**, click **Add resource URL**, paste the resource URL below, and click **Add**.
3. Expand **Rules editor**, add the matching rule below, and click **Save Rules**.
4. Reload Spotify.

Resource URL:

```text
https://raw.githubusercontent.com/Dabrogost/Spotify-Scripts/refs/heads/main/spotify-ad-skip.txt
```

Rule:

```adblock
open.spotify.com##+js(spotify-ad-skip)
```

This applies to playback in the Spotify browser tab, not the desktop or mobile apps or another Spotify Connect device. To stop using it, remove the rule and reload Spotify. Turn **Spotify ad blocking** back on if you want to return to Chroma's built-in protection.

### Twitch VAFT

[VAFT from TwitchAdSolutions](https://github.com/ryanbr/TwitchAdSolutions) attempts to obtain an ad-free Twitch stream. Playback may pause while it looks for one. Use the uBlock resource version linked below.

1. Open **Settings -> Scriptlets**, click **Add resource URL**, paste the resource URL below, and click **Add**.
2. Expand **Rules editor**, add the matching rule below, and click **Save Rules**.
3. Reload Twitch. Avoid running another Twitch-specific ad blocker alongside VAFT.

Resource URL:

```text
https://raw.githubusercontent.com/ryanbr/TwitchAdSolutions/master/vaft/vaft-ublock-origin.js
```

Rule:

```adblock
twitch.tv##+js(twitch-videoad)
```

To stop using VAFT, remove the rule and reload Twitch. You can also remove its resource URL from **User scriptlets**.

## Troubleshooting

| Symptom | What it usually means | Fix |
|---|---|---|
| Resource shows **Unused** | The resource parsed, but no saved rule references it. | Add or edit a `domain##+js(resource-name)` rule. |
| Rule status shows **Missing** | A saved rule references a resource that is not available. | Check the resource name, refresh the URL, or remove the stale rule. |
| Refresh fails but the scriptlet still runs | The last successful resource remains cached. | Fix the source or remove its rule, save, and reload the tab to stop using the cached code. |
| Resource URL will not add | The URL fails Chroma's literal URL checks. | Use a raw `https://` URL with no credentials, no custom port, and no literal localhost/private/special-use address. DNS-resolved addresses remain part of the trusted-source boundary. |
| Nothing changes on the page | The tab loaded before the scriptlet was registered, or the domain rule does not match. | Reload the tab and check the rule domain. |
| Scriptlet errors do not appear in DevTools | Quiet Console is enabled. | Turn off **Quiet Console** in settings while debugging, then reload the affected tab. |
| A site stays broken after removal | The old script already ran in that page document. | Remove the rule/resource, then reload the affected tab. |
| Health says UserScripts unavailable | Chrome has not enabled Chroma's `userScripts` access. | On Chrome 138+, open Chroma's extension details page and enable **Allow User Scripts**. On Chrome 122-137, enable **Developer Mode** on `chrome://extensions`. |

## Backup Behavior

Settings backups contain resource URLs and saved rules, but not downloaded resource code.

After importing settings, refresh the resource URLs, confirm the resources appear, and reload affected tabs. See [Settings Backup And Import](INSTALL.md#settings-backup-and-import) for backup contents and error handling.

## Safer Rule Habits

- Prefer exact domains such as `example.com##+js(...)`.
- Avoid broad or global domains.
- Keep resource files small and readable.
- Remove unused resources.
- Review any third-party resource contents before adding them.
- Prefer code you can inspect and understand.
- Reload tabs after adding, refreshing, or removing user scriptlets.

---

Next: [Statistics & Health](STATISTICS.md)
