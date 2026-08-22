# Distribution

Use the package script to build a local distributable extension zip from the repo root:

```powershell
npm.cmd run package:extension
```

The script writes:

```text
dist/chroma-ad-blocker-v<manifest-version>.zip
dist/updates.json
```

The version comes from `extension/manifest.json`. The guided updater looks for `chroma-ad-blocker-vX.Y.Z.zip` and signed `updates.json` on the latest release, fetches them internally from their direct GitHub asset URLs, and falls back to the GitHub release page when either asset is missing. Users do not manually download `updates.json`.

## Release Version Format

Release versions must use exactly three numeric components: `X.Y.Z`.

- Set `extension/manifest.json` to `X.Y.Z`.
- Use the GitHub tag `vX.Y.Z`.
- Upload the generated `chroma-ad-blocker-vX.Y.Z.zip`.
- Keep `package.json` and public version references synchronized for project consistency.

Do not publish two-component or four-component release versions even though Chrome's manifest format and the current package parser accept additional dotted forms. Chroma's guided-update comparison currently evaluates the first three components, so the release policy is deliberately stricter.

## Update Signing Key

Guided updates require `updates.json` to be signed with Chroma's ECDSA P-256 update key. The public key is bundled in `extension/background/updateTrust.js`; the private key must stay outside git.

Default local private-key path:

```text
secrets/chroma-update-signing-private-key.jwk
```

The package script also accepts:

- `CHROMA_UPDATE_SIGNING_PRIVATE_KEY_FILE`: path to a private JWK file.
- `CHROMA_UPDATE_SIGNING_PRIVATE_KEY_JWK`: inline private JWK JSON.
- `CHROMA_REQUIRE_SIGNED_UPDATES=1`: fail packaging instead of writing an unsigned `updates.json`.

Before signing, the package script validates that the private key matches the bundled public key. If no signing key is available, the script still writes `dist/updates.json` for local package smoke tests, but it logs that the manifest is unsigned. The guided updater rejects unsigned release manifests.

For a release build, require signing:

```powershell
$env:CHROMA_REQUIRE_SIGNED_UPDATES='1'
npm.cmd run package:extension
if ($LASTEXITCODE -ne 0) { return }
```

Only a successful required-signing run produces a release candidate. The current script constructs, verifies, and writes the ZIP before it loads and validates the private signing key. If signing then fails, a new ZIP can remain in `dist/` while `updates.json` is missing or belongs to an earlier run. Treat any nonzero exit as a failed build and upload neither artifact; correct the key problem, rerun successfully, and verify that the ZIP and signed manifest are the pair from that successful run.

## Guide Generation

Selected Markdown files under `docs/` are the canonical source for Chroma's bundled user manual. `scripts/guide-manifest.js` explicitly selects user-facing documents, categories, tasks, settings links, and screenshot assets; repository-only and machine-specific notes are never discovered through a directory glob.

Regenerate the static in-extension guide after changing a canonical document, guide metadata, or screenshot:

```powershell
npm.cmd run docs:build
```

This command generates:

- `extension/guide/index.html`
- the article pages under `extension/guide/pages/`
- `extension/guide/search-index.json`
- local screenshot copies under `extension/docs/assets/`

The shared `extension/guide/guide.css` and `extension/guide/guide.js` files are maintained source files rather than generated outputs. Do not hand-edit the generated HTML, search index, or screenshot copies.

To verify that checked-in guide artifacts exactly match their canonical inputs without writing files, run:

```powershell
npm.cmd run docs:check
```

`npm.cmd run package:extension` runs the guide build before packaging. Calling `node scripts/package-extension.js` directly is intentionally stricter and refuses to package stale or missing guide output.

`docs:check` compares generated text as raw bytes. The repository's `.gitattributes` pins generated guide text to LF so clean checkouts remain byte-stable across platforms. An existing Windows clone that checked those files out as CRLF before that policy was added can still produce a one-time line-ending-only failure until Git renormalizes the checkout; rebuilding solely to alternate line endings creates noisy generated-file changes.

## What Gets Packaged

The zip contains the contents of `extension/` at the archive root, so `manifest.json` is directly inside the zip.

It also includes:

- `README.md`
- `LICENSE.md`
- the user-facing Markdown docs selected by `USER_DOC_FILES` in `scripts/guide-manifest.js`
- the offline guide home, static article pages, shared CSS and JavaScript, and local search index under `guide/`
- the five generated screenshot copies under `docs/assets/`, so images resolve in both the raw packaged Markdown and the in-extension guide

It excludes repository-only documentation, development files, and unrelated build output, including:

- `docs/README.md`
- `docs/ARCHITECTURE.md`
- `docs/SECURITY.md`
- `docs/THREAT_MODEL.md`
- `docs/TEST_GUIDE.md`
- `docs/DISTRIBUTION.md`
- `docs/CONTRIBUTING.md`
- `extension/_metadata/`
- `tests/`
- `node_modules/`
- `.git/`
- `.github/`
- previous `dist/` output

## Release QA Checklist

Before sharing a build, complete this checklist from a clean working tree or reviewed release branch:

- [ ] `npm.cmd test`
- [ ] `npm.cmd run test:rules`
- [ ] `npm.cmd run docs:check`
- [ ] `npm.cmd run test:e2e`
- [ ] Set `CHROMA_REQUIRE_SIGNED_UPDATES=1`, then run `npm.cmd run package:extension` and require a zero exit code.
- [ ] GitHub release tag and manifest use exactly `vX.Y.Z` / `X.Y.Z`.
- [ ] GitHub release contains the exact generated asset name `chroma-ad-blocker-vX.Y.Z.zip`.
- [ ] GitHub release contains the signed generated `updates.json` from the same successful package run.
- [ ] The ZIP size and SHA-256 exactly match the values in that `updates.json`.
- [ ] `updates.json` signature key ID matches `chroma-update-signing-2026-06`.
- [ ] Fresh unpacked install from the generated package contents.
- [ ] Guided updater test from the previous release to the candidate build, including folder selection, package inspection, dry-run plan, write probe, install, and **Reload Chroma**.
- [ ] Current-version updater test after reload: **Settings -> Updates** should show **Chroma Is Current** without presenting an in-progress install flow.
- [ ] Manual fallback update test by extracting the release ZIP over the existing unpacked folder.
- [ ] YouTube normal video test.
- [ ] YouTube Shorts test.
- [ ] Confirm the dormant Prime Video accelerator is not injected.
- [ ] Proxy route on/off test.
- [ ] Global proxy fallback test.
- [ ] Master off/on releases and restores proxy routes without erasing saved route intent.
- [ ] Master off/on releases and restores requested WebRTC, browser-privacy, and geolocation controls.
- [ ] Health distinguishes paused requests, effective Chrome state, and **Controlled elsewhere**; releasing an external controller triggers automatic recovery.
- [ ] Whitelist test.
- [ ] Master off/on removes and restores cached subscription DNR and Chroma-managed `userScripts` without a network refresh.
- [ ] Fingerprint randomization toggle test.
- [ ] Health panel review.
- [ ] Settings export/import smoke test, including malformed-backup rejection and rollback reporting.

The E2E command needs Chrome for Testing or Chromium configured in the current shell. On non-Windows systems, use the equivalent `npm` commands.

## Guided Updater Requirements

The in-extension updater only installs a release package when all of these are true:

- The latest GitHub release is newer than the installed version.
- The release has a direct asset named `chroma-ad-blocker-vX.Y.Z.zip`.
- The release has a direct `updates.json` asset with schema `chroma-update-manifest-v1`.
- `updates.json` is signed by Chroma's bundled update public key.
- `updates.json` names the ZIP asset and provides its exact byte size and SHA-256.
- The package version is newer than the running Chroma version; same-version or older packages are rejected.
- The ZIP has `manifest.json` at the archive root.
- The manifest name is `Chroma Ad-Blocker`, uses Manifest V3, and matches the release version.
- Manifest-referenced extension files are present.
- ZIP paths are relative, unique, non-encrypted, and non-ZIP64. The updater rejects specifically enumerated unwanted path classes including `tests/`, `node_modules/`, `.git/`, `.github/`, `logs/`, and common temporary-file names.
- The user grants a folder handle, its manifest passes Chroma's name/version/MV3 plausibility checks, and the write probe passes. Chrome does not expose the running extension's loaded filesystem path, so a same-version copy can pass these checks; the user remains responsible for selecting the folder originally loaded into Chrome.

The updater's path checks are not a universal allow-list for every repository-only filename. Release-package exclusion is primarily enforced by the package builder's explicit input selection and by signing the resulting file inventory; the updater independently rejects the unsafe and unwanted path classes listed above.

On install, Chroma writes into the existing unpacked folder, creates a temporary `.chroma-update-backup-*` directory, removes it after success or after a rollback attempt, and ignores any leftover backup directories during future install planning. `manifest.json` is written last. After success, the updater shows **Reload Chroma**; if direct reload is unavailable, Chroma opens `chrome://extensions` as a fallback.

## Loading The Zip Manually

Chrome's **Load unpacked** flow needs an extracted folder, not the zip itself. To inspect a release package manually:

1. Extract the generated zip from `dist/`.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Choose **Load unpacked**.
5. Select the extracted folder that contains `manifest.json`.

---

Next: [Contributing](CONTRIBUTING.md)
