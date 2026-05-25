/**
 * GitHub release update check with local cache.
 */

'use strict';

const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000; // 6-hour cache window to avoid GitHub API rate limits
const RELEASES_URL = 'https://api.github.com/repos/Dabrogost/Chroma-Ad-Blocker/releases/latest';

function isNewerVersion(local, remote) {
  const parse = v => v.replace(/^v/, '').split('.').map(Number);
  const [lMaj, lMin, lPat] = parse(local);
  const [rMaj, rMin, rPat] = parse(remote);
  if (rMaj !== lMaj) return rMaj > lMaj;
  if (rMin !== lMin) return rMin > lMin;
  return rPat > lPat;
}

export async function checkForUpdate() {
  try {
    const { updateCheckCache: cache } = await chrome.storage.local.get('updateCheckCache');
    const now = Date.now();
    const local = chrome.runtime.getManifest().version;

    if (cache && (now - cache.checkedAt) < UPDATE_CHECK_TTL_MS) {
      return (cache.latestVersion && isNewerVersion(local, cache.latestVersion))
        ? { updateAvailable: true, latestVersion: cache.latestVersion }
        : { updateAvailable: false, latestVersion: null };
    }

    const res = await fetch(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-cache'
    });

    if (!res.ok) return { updateAvailable: false, latestVersion: null };

    const data = await res.json();
    const latestVersion = (data.tag_name || '').replace(/^v/, '');
    if (!latestVersion) return { updateAvailable: false, latestVersion: null };

    await chrome.storage.local.set({ updateCheckCache: { latestVersion, checkedAt: now } });

    return isNewerVersion(local, latestVersion)
      ? { updateAvailable: true, latestVersion }
      : { updateAvailable: false, latestVersion: null };
  } catch {
    return { updateAvailable: false, latestVersion: null };
  }
}
