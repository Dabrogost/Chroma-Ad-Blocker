# Distribution

Use the package script to build the distributable extension zip from the repo root:

```powershell
npm.cmd run package:extension
```

The script writes:

```text
dist/chroma-ad-blocker-v<manifest-version>.zip
```

The version comes from `extension/manifest.json`. That zip is the file to distribute.

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
- [ ] Fresh unpacked install from the generated package contents.
- [ ] Extension reload/update test from the previous release to the candidate build.
- [ ] YouTube normal video test.
- [ ] YouTube Shorts test.
- [ ] Prime Video test.
- [ ] Proxy route on/off test.
- [ ] Global proxy fallback test.
- [ ] Whitelist test.
- [ ] Fingerprint randomization toggle test.
- [ ] Health panel review.
- [ ] Settings export/import smoke test.

The E2E command needs Chrome for Testing or Chromium configured in the current shell. On non-Windows systems, use the equivalent `npm` commands.

## Loading The Zip Manually

Chrome's **Load unpacked** flow needs an extracted folder, not the zip itself. To inspect a release package manually:

1. Extract the generated zip from `dist/`.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Choose **Load unpacked**.
5. Select the extracted folder that contains `manifest.json`.

---

Next: [Contributing](CONTRIBUTING.md)
