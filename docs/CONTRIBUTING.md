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

## Reporting Security Issues

Do **not** open a public issue for security vulnerabilities. Email the developer directly at dabrogost@gmail.com.

---

Next: [Documentation Index](README.md)
