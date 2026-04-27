# Contributing to Chroma Ad-Blocker

Thanks for your interest. Here's what you need to know.

## Ways to Contribute

- **Bug reports** — Open an issue. Include your Chrome version, extension version, and steps to reproduce.
- **Rule updates** — If an ad domain or selector has changed, PRs targeting the `rules/` folder or `background.js` (for initial selector logic) are the most useful contributions.
- **New Accelerator** — New site-specific video ad-accelerators are highly valued but require rigorous testing to ensure compatibility and stability across target platforms.
- **Code changes** — Open an issue first to discuss before writing anything significant. This avoids wasted effort.

## Ground Rules

- This project is licensed under the **GNU General Public License v3 (GPLv3)**. By contributing, you agree your changes fall under the same terms.
- Keep PRs focused. One fix or feature per PR.
- Don't break the security model. The `MessageChannel` handshake, session tokens, and origin checks exist for a reason — changes that weaken these will not be accepted.
- AI-assisted contributions are fine, but you are responsible for reviewing and understanding what you submit.

## Before Opening a PR

1. Test the extension locally via `chrome://extensions/` → **Load unpacked**.
2. Verify your change doesn't break the popup, ad acceleration, or network blocking.
3. If you're changing `background.js` or `interceptor.js`, pay extra attention to the security notes in those files.

## Reporting Security Issues

Do **not** open a public issue for security vulnerabilities. Email the developer directly at dabrogost@gmail.com.
