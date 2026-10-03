# Everyday Use & Troubleshooting

Use this page for common tasks after [installing Chroma](INSTALL.md). The [Feature Guide](FEATURES.md) explains how the protection layers work, and the [configuration reference](INSTALL.md#configuration) maps each control to its location and default.

## Open The Popup, Settings, And Guide

1. Visit the website you want to manage.
2. Click Chroma's icon in the browser toolbar. If it is hidden, open the browser's extensions menu and select Chroma; pin it there for easier access.
3. To open Settings, click the gear marked **Open Settings** beside **Protection Events** in the popup. Clicking the Protection Events card also opens Settings.
4. Use the Settings navigation links to jump to a section. **Guide** opens the bundled offline manual; section-specific Guide links open the relevant topic.

The header switch controls protection across the browser. **This Site** controls apply to the website open in the active tab. Chrome-internal pages and other browser-restricted pages cannot run Chroma's page tools; open a normal website to use those controls.

## Pause Or Restore Protection For One Site

Use a site exception when a particular website needs to run without Chroma's filtering.

1. Open that website and then the Chroma popup.
2. Under **This Site**, turn **Whitelist this site** on. An enabled whitelist switch means filtering is paused for the site.
3. Chroma saves the exception and automatically reloads the active tab. Save unfinished form input first.
4. To restore filtering, return to the site, reopen the popup, and turn **Whitelist this site** off. Chroma reloads the tab again.

The popup groups ordinary subdomains under the site's base domain. For example, an exception created on `news.example.com` applies to `example.com` and its subdomains, not just that page. Chroma recognizes a compact set of public suffixes, including `co.uk` and shared hosting suffixes such as `github.io`; this grouping is not a complete public-suffix database. Reload other already-open tabs for the same site after changing an exception so their page scripts reflect it too.

A site exception pauses Chroma's network filtering for the site and its initiated requests, page cleanup, platform handling, and registered scriptlets, including fingerprint randomization. It does not disable configured proxy routes or browser-wide privacy settings. For those controls, use **Settings -> Proxy** or **Settings -> Protection -> Privacy**. You can also [pause all protection](#pause-all-protection).

## Disable Fingerprint Randomization For One Site

Fingerprint randomization can affect sign-in, bot checks, or captchas. An FPR-only exception preserves the site's other requested protections.

1. Visit the affected site and open Chroma's popup.
2. Turn **Disable FPR on this site** on. This control appears only when master protection and **Settings -> Protection -> Privacy -> Fingerprint randomization** are enabled.
3. Chroma reloads the active tab. Retry the sign-in or check.
4. Turn the same control off to restore fingerprint randomization; the tab reloads again.

This exception uses the same base-domain grouping as **Whitelist this site**. It is stored separately, so removing a full site exception does not remove an FPR-only exception. Existing pages need a reload to replace fingerprint hooks that already ran.

## Hide An Element With The Zapper

The Zapper hides page elements such as a sticky banner, empty ad box, or newsletter panel. It does not stop the element's underlying network requests.

1. On a normal `http://` or `https://` page, open the popup and click **Zap Element**.
2. Move the pointer to highlight the unwanted element, then click it. Press `Esc` at any point to cancel.
3. Choose **Hide once** to hide only that element in the current page, or **Save for this site** to create a reusable rule.
4. For a saved rule, review the generated CSS selector and any multiple-match warning, then click **Save**. Choose **Cancel** if the match looks too broad.

**Hide once** is temporary: reload the page to restore the element. A saved rule is associated with the current hostname and also matches its subdomains. It is reapplied on visits while master protection and **Cosmetic filtering** are on and the site is not whitelisted. A website redesign can make a saved selector stop matching or hide different content.

To undo a saved rule, open **Settings -> Zapper**, expand **Saved selectors**, find the domain and selector, and turn its switch off or click **Delete Rule**. Reload the affected page afterward to remove any one-time inline hiding applied during selection. Deleted rules can be recreated with the Zapper; paused rules can be turned back on.

If the Zapper cannot start, check the extension's site access in the browser's extension details and try a normal website. Browser-restricted pages cannot be edited this way. Chroma rejects unsafe or invalid selectors and selectors matching too many elements; select a smaller container instead.

## Pause All Protection

Turn the header switch off in the popup or Settings to pause Chroma across the browser. This removes active DNR and whitelist rules, unregisters Chroma-managed scriptlets for future documents, stops reversible page protection, and releases Chroma's proxy and browser privacy controls. Saved settings, lists, routes, exceptions, and custom resources remain available for restoration. Lists can still refresh while protection is paused.

Reload affected tabs after pausing or resuming. Arbitrary scriptlets, fingerprint hooks, and other code that already ran in a page cannot always be undone in place. Turning master protection back on restores the requested features; another extension or browser policy may still control browser-wide settings. Use [Health](STATISTICS.md#health-panel) to inspect the result.

Pausing protection is different from removing Chroma. See [Uninstalling and local data](INSTALL.md#uninstalling-and-local-data) before deleting an installation.

## If A Site Stops Working

Work through the relevant steps and retry the page after each change. Restore settings that did not cause the problem so unrelated protection stays enabled.

1. **Check the basics.** Reload the page after an extension update, and avoid running multiple ad blockers together. Check **Settings -> Health** for unavailable or degraded features. Scriptlet access and update failures are covered in [installation troubleshooting](INSTALL.md#troubleshooting-quick-reference).
2. **If content disappeared after zapping it**, pause or delete that selector under **Settings -> Zapper -> Saved selectors**, then reload.
3. **If sign-in or a captcha fails with fingerprint randomization enabled**, try [Disable FPR on this site](#disable-fingerprint-randomization-for-one-site).
4. **If the problem began after adding a list or custom resource**, disable that filter list or remove the relevant saved user-scriptlet rule, then reload. Use the [filter-list controls](FILTER_LISTS.md#manage-filter-lists) or [User Scriptlets guide](ADVANCED_USER_SCRIPTLETS.md).
5. **Try a full site exception** using [Whitelist this site](#pause-or-restore-protection-for-one-site). If the page now works, leave the exception only where needed while you investigate the responsible feature or list. Turn it off if it does not help.
6. **For connection or browser-permission problems**, inspect proxy routes and optional privacy settings separately. Whitelisting does not bypass a proxy or release browser-wide privacy controls. See [proxy troubleshooting](MEDIA_PROXY_ROUTER.md), or temporarily pause master protection and reload to compare behavior.

For ads or playback trouble on supported services, follow the [YouTube](YOUTUBE.md) or [Spotify](SPOTIFY.md) guide. A zero event count alone does not prove that blocking failed: network statistics depend on browser feedback, and page-layer counts are approximate. [Statistics & Health](STATISTICS.md) explains the distinction.

If you report a reproducible problem, include the browser and Chroma versions, the affected site, steps to reproduce, relevant settings, and Health status. Remove private URLs, account details, and proxy credentials from anything you share; statistics and request-log data can contain browsing information. See the [Privacy Policy](PRIVACY_POLICY.md) for what is stored.

---

Next: [Feature Guide](FEATURES.md)
