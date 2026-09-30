# Contributing to Chroma Ad-Blocker

Thanks for your interest. Here's what you need to know.

## Ways to Contribute

- **Bug reports** - Open an issue. Include your Chrome version, extension version, and steps to reproduce.
- **Rule updates** - If an ad domain, selector, or scriptlet has changed, useful PRs usually target `extension/rules/rules_custom.json`, `extension/rules/rules_recipes.json`, `extension/subscriptions/chroma-lib.txt`, `extension/content/content.js`, or `extension/content/recipes.js`.
- **Platform handlers** - New or updated site-specific handlers, including stripping or ad-acceleration fallbacks, are highly valued but require rigorous testing to ensure compatibility and stability across target platforms.
- **Code changes** - Open an issue first to discuss before writing anything significant. This avoids wasted effort.

Do not hand-edit `extension/rules/rules_oisd_*.json`. Those shards and their manifest entries are generated from OISD Small and Big, with adult and shock-site domains from OISD NSFW used only to fill otherwise-unused static capacity. Refresh them with `npm.cmd run rules:update:oisd`; that command also regenerates the compact static dedupe index used by subscription refreshes. After editing a protected static source such as `rules_custom.json` or `rules_recipes.json` directly, run `npm.cmd run rules:index`. Rule validation and packaging reject a missing or stale index. Confirm the projected static total is 300,000, review the complete generated diff, and run the rules and policy tests.

## Ground Rules

- This project is licensed under **GPL-3.0-or-later**. By contributing, you agree your changes fall under the same terms.
- Keep PRs focused. One fix or feature per PR.
- Don't break the security model. The isolated-world configuration authority, authenticated `MessageChannel` handoff, per-session nonce/challenge, config validation, fail-closed initialization, and isolated/MAIN-world ownership boundaries exist for a reason. The frozen MAIN-world snapshot protects integrity but is page-readable; do not treat it as a confidentiality boundary.
- AI-assisted contributions are fine, but you are responsible for reviewing and understanding what you submit.

## Local Setup

Use a current Node.js LTS release, matching CI's `lts/*` policy. Install the exact locked development dependencies from the repo root:

```powershell
npm.cmd ci
```

On non-Windows systems, use the equivalent `npm ci` command.

## Before Opening a PR

1. Test the extension locally via `chrome://extensions/` -> **Load unpacked**, selecting the repository's `extension/` directory.
2. Run `npm.cmd test` on Windows (`npm test` elsewhere). For faster local iteration, use `npm.cmd run test:quick`.
3. Run `npm.cmd run test:ci` for the Node, policy, ruleset, guide-freshness, and package-verification stage. This does not include loaded-extension browser E2E.
4. Configure Chrome for Testing or Chromium and run `npm.cmd run test:e2e:smoke`; release work should also run the full `npm.cmd run test:e2e` tier. See [Testing](TEST_GUIDE.md).
5. If you changed canonical user documentation, run `npm.cmd run docs:build`, review the generated guide changes, and then run `npm.cmd run docs:check`.
6. Verify your change doesn't break the popup, proxy routing, subscriptions, ad acceleration, YouTube stripping, cosmetic filtering, or network blocking.
7. When testing scriptlets in Chrome 138+, open the extension's **Details** page and enable **Allow User Scripts**. On Chrome 122-137, Developer Mode enables the `userScripts` API.
8. If you're changing `extension/background/`, `extension/content/interceptor.js`, `extension/content/protection.js`, `extension/core/`, or `extension/scriptlets/`, pay extra attention to the security notes in those files.

## Guide Publishing

Edit user documentation in `docs/*.md`; do not maintain a separate website copy. `scripts/guide-manifest.js` selects the user-facing pages, and `scripts/build-guide.js` renders both destinations with the same templates, styles, search controller, and screenshots:

- `npm.cmd run docs:build` regenerates the checked-in offline guide in `extension/guide/`.
- `npm.cmd run docs:build:web` generates the public site in `dist/guide-site/`, which is ignored by Git. Serve that directory with a local HTTP server to preview navigation and search.
- `npm.cmd test -- guide` checks both outputs, including web links under the GitHub Pages project path and search without extension APIs.

The web version replaces settings buttons with a download link and describes web hosting accurately; the article content still comes from the same Markdown. Only the declared guide pages and their assets are published, not the extension or contributor documentation.

The **Publish guide** workflow validates pull requests and deploys guide changes on `master` to [GitHub Pages](https://dabrogost.github.io/Chroma-Ad-Blocker/). It can also be run manually from `master`. In repository **Settings → Pages → Build and deployment**, the source must be **GitHub Actions**. The `github-pages` environment must allow deployments from `master`. No `gh-pages` branch or committed website output is needed. See [GitHub's custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Reporting Security Issues

Do **not** open a public issue for security vulnerabilities. Email the developer directly at dabrogost@gmail.com.

---

Next: [Documentation Index](README.md)
