# Contributing to Chroma Ad-Blocker

Thanks for your interest. Here's what you need to know.

## Ways to Contribute

- **Bug reports** - Open an issue. Include your Chrome version, extension version, and steps to reproduce.
- **Rule updates** - If an ad domain, selector, or scriptlet has changed, useful PRs usually target `extension/rules/`, `subscriptions/hotfix.txt`, `extension/subscriptions/chroma-lib.txt`, `extension/content/content.js`, or `extension/content/recipes.js`.
- **Platform handlers** - New or updated site-specific handlers, including stripping or ad-acceleration fallbacks, are highly valued but require rigorous testing to ensure compatibility and stability across target platforms.
- **Code changes** - Open an issue first to discuss before writing anything significant. This avoids wasted effort.

## Ground Rules

- This project is licensed under the **GNU General Public License v3 (GPLv3)**. By contributing, you agree your changes fall under the same terms.
- Keep PRs focused. One fix or feature per PR.
- Don't break the security model. The `MessageChannel` handshake, per-session nonces, origin checks, config validation, and MAIN-world safety boundaries exist for a reason - changes that weaken these will not be accepted.
- AI-assisted contributions are fine, but you are responsible for reviewing and understanding what you submit.

## Before Opening a PR

1. Test the extension locally via `chrome://extensions/` -> **Load unpacked**.
2. Run `npm test` (or `npm.cmd test` on Windows PowerShell if script execution policy blocks `npm.ps1`).
3. Verify your change doesn't break the popup, proxy routing, subscriptions, ad acceleration, YouTube stripping, cosmetic filtering, or network blocking.
4. When testing scriptlets in Chrome 138+, open the extension's **Details** page and enable **Allow User Scripts**. On Chrome 122-137, Developer Mode enables the `userScripts` API.
5. If you're changing `extension/background/`, `extension/content/interceptor.js`, `extension/content/protection.js`, `extension/core/`, or `extension/scriptlets/`, pay extra attention to the security notes in those files.

## Reporting Security Issues

Do **not** open a public issue for security vulnerabilities. Email the developer directly at dabrogost@gmail.com.
