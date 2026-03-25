# YT Chroma — Agent Context / Handoff Document

## Overview
YT Chroma is a personal YouTube-specific ad blocker built for **Manifest V3 (MV3)**. It is designed to run unpacked in Developer Mode and bypasses YouTube's strict server-side anti-adblock systems.

## Architecture: Three-Layer Strategy

1. **Layer 1 — Ad Acceleration (`content.js`)**
   - **Mechanism:** The primary, most detection-resistant method.
   - Watches for the `.ad-showing` CSS class.
   - Mutes the player (`video.muted = true`) and fast-forwards ads at 16x speed (`video.playbackRate = 16`). A 30s ad takes ~2s.
   - Clicks `.ytp-skip-ad-button` if available.
   - **Why:** Blocking network requests triggers YouTube's anti-adblock detection. Accelerating the video fulfills YouTube's impression requirement invisibly to the user.

2. **Layer 2 — DNR Network Blocking (`rules.json` & `background.js`)**
   - **Static Rules:** 16 rules targeting known ad domains like `doubleclick.net`, `imasdk.googleapis.com`, and `ads.youtube.com`. Explicitly allows `/api/` and `/youtubei/` to prevent breaking the site.
   - **Dynamic Rules:** 6 rules loaded at runtime via `background.js` to block tracking/volatile endpoints. Persisted in `chrome.storage.local` to survive service worker restarts.

3. **Layer 3 — Cosmetic Filtering & Warning Suppression (`content.js`)**
   - Injects CSS to hide ad-specific elements (e.g., `#masthead-ad`, `.ytp-ad-overlay-container`).
   - Implements a `MutationObserver` to remove dynamically injected ad slots.
   - Specifically targets and actively deletes `ytd-enforcement-message-view-model` to suppress YouTube's strict anti-adblock modal warning, and removes the `overflow` lock on the document body.

## Project Structure
- `manifest.json`: Configuration for MV3.
- `rules.json`: Static DNR ruleset.
- `content.js`: Main DOM-manipulating script (Acceleration & Cosmetic Layer).
- `background.js`: Ephemeral service worker (Dynamic Rules & State).
- `popup.html` / `popup.js`: Extension UI providing visual stats and feature toggles.
- `icons/`: Extension icon assets (LANCZOS resized).

## Technical Implementation Details
- Strictly follows Manifest V3 constraints, storing state in `chrome.storage.local` due to the ephemeral service worker.
- Uses `chrome.declarativeNetRequest` instead of `webRequest` blocking, operating well within system limits (16 static / 6 dynamic).
- Communication heavily relies on `chrome.runtime.onMessage` and `chrome.tabs`.

## Known Limitations / Vulnerabilities
- Requires periodic manual updates if YouTube alters the `ytd-enforcement-message-view-model` or `.ad-showing` classes.
- Cannot automatically refresh dynamic rules without a remote companion server.
- The `userScripts` API is a viable future improvement avenue for executing more sophisticated anti-adblock countermeasures.
