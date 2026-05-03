# Distribution

Use the package script to build the distributable extension zip from the repo root:

```powershell
npm.cmd run package:extension
```

The script writes:

```text
dist/chroma-ad-blocker-v0.9.9.zip
```

The version comes from `extension/manifest.json`. That zip is the file to distribute.

## What Gets Packaged

The zip contains the contents of `extension/` at the archive root, so `manifest.json` is directly inside the zip.

It also includes:

- `README.md`
- `LICENSE.md`
- `docs/PRIVACY_POLICY.md`

It excludes development and generated files, including:

- `extension/_metadata/`
- `tests/`
- `node_modules/`
- `.git/`
- `.github/`
- previous `dist/` output

## Recommended Release Check

Before sharing a build, run:

```powershell
npm.cmd test
npm.cmd run test:rules
npm.cmd run package:extension
```

For the full browser-level check, also run:

```powershell
npm.cmd run test:e2e
```

The E2E command needs Chrome for Testing or Chromium configured in the current shell.

## Loading The Zip Manually

Chrome's "Load unpacked" flow needs an extracted folder, not the zip itself. To inspect a release package manually:

1. Extract the generated zip from `dist/`.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Choose "Load unpacked".
5. Select the extracted folder that contains `manifest.json`.
