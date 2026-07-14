# Distribution

Use the package script to build the distributable extension zip from the repo root:

```powershell
npm.cmd run package:extension
```

The script writes:

```text
dist/chroma-ad-blocker-v<manifest-version>.zip
dist/updates.json
```

The version comes from `extension/manifest.json`. Upload both files to the GitHub release. The guided updater looks for `chroma-ad-blocker-vX.Y.Z.zip` and signed `updates.json` on the latest release, fetches them internally from their direct GitHub asset URLs, and falls back to the GitHub release page when either asset is missing. Users do not manually download `updates.json`.

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

## What Gets Packaged

The zip contains the contents of `extension/` at the archive root, so `manifest.json` is directly inside the zip.

It also includes:

- `README.md`
- `LICENSE.md`
- the public Markdown docs listed by `RELEASE_DOC_FILES` in `scripts/package-extension.js`

It excludes development and generated files, including:

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
- [ ] `npm.cmd run test:e2e`
- [ ] `npm.cmd run package:extension`
- [ ] GitHub release contains the exact generated asset name, for example `chroma-ad-blocker-v1.5.3.zip`.
- [ ] GitHub release contains the signed generated `updates.json` from the same package run.
- [ ] `updates.json` signature key ID matches `chroma-update-signing-2026-06`.
- [ ] Fresh unpacked install from the generated package contents.
- [ ] Guided updater test from the previous release to the candidate build, including folder selection, package inspection, dry-run plan, write probe, install, and **Reload Chroma**.
- [ ] Current-version updater test after reload: **Settings -> Updates** should show **Chroma Is Current** without presenting an in-progress install flow.
- [ ] Manual fallback update test by extracting the release ZIP over the existing unpacked folder.
- [ ] YouTube normal video test.
- [ ] YouTube Shorts test.
- [ ] Prime Video test.
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
- ZIP paths are relative, unique, non-encrypted, non-ZIP64, and do not include repo-only or temporary paths such as `tests/`, `node_modules/`, `.git/`, or `.github/`.
- The user grants a folder handle for the current unpacked install folder and the write probe passes.

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
