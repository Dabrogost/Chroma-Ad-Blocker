/**
 * GitHub release update check with local cache.
 */

'use strict';

const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000; // 6-hour cache window to avoid GitHub API rate limits
const RELEASES_URL = 'https://api.github.com/repos/Dabrogost/Chroma-Ad-Blocker/releases/latest';
const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/';
const ASSET_BASENAME = 'chroma-ad-blocker';
const UPDATE_MANIFEST_ASSET_NAME = 'updates.json';

function normalizeVersion(version) {
  return String(version || '').trim().replace(/^v/i, '');
}

function buildReleaseZipName(version) {
  const normalized = normalizeVersion(version);
  return normalized ? `${ASSET_BASENAME}-v${normalized}.zip` : '';
}

const RELEASE_DOWNLOAD_PREFIX_PATH = '/Dabrogost/Chroma-Ad-Blocker/releases/download/';

function isReleaseDownloadUrl(downloadUrl, assetName) {
  if (typeof downloadUrl !== 'string' || typeof assetName !== 'string' || !assetName) return false;
  if (assetName.includes('/') || assetName.includes('\\') || assetName === '.' || assetName === '..') return false;
  if (!downloadUrl.startsWith(RELEASE_DOWNLOAD_PREFIX)) return false;
  if (downloadUrl.includes('?') || downloadUrl.includes('#') || downloadUrl.includes('\\') || /\s/.test(downloadUrl)) {
    return false;
  }

  const remainder = downloadUrl.slice(RELEASE_DOWNLOAD_PREFIX.length);
  const segments = remainder.split('/');
  if (segments.length !== 2) return false;
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return false;
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      return false;
    }
  }
  if (segments[1] !== assetName) return false;

  if (typeof URL === 'function') {
    try {
      const url = new URL(downloadUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) {
        return false;
      }
      if (url.search || url.hash || url.pathname !== `${RELEASE_DOWNLOAD_PREFIX_PATH}${remainder}`) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function parseVersionParts(version) {
  const normalized = normalizeVersion(version);
  if (!normalized) return null;
  const [coreWithPre] = normalized.split('+');
  const dashIdx = coreWithPre.indexOf('-');
  const core = dashIdx === -1 ? coreWithPre : coreWithPre.slice(0, dashIdx);
  const prerelease = dashIdx === -1 ? '' : coreWithPre.slice(dashIdx + 1);
  if (!/^\d+(?:\.\d+){0,3}$/.test(core)) return null;
  const parts = core.split('.').map(Number);
  while (parts.length < 4) parts.push(0);
  return { parts, prerelease };
}

function isNewerVersion(local, remote) {
  const l = parseVersionParts(local);
  const r = parseVersionParts(remote);
  if (!l || !r) return false;
  for (let i = 0; i < 4; i++) {
    if (r.parts[i] !== l.parts[i]) return r.parts[i] > l.parts[i];
  }
  if (l.prerelease && !r.prerelease) return true;
  return false;
}

function normalizeAsset(asset) {
  if (!asset || typeof asset !== 'object') return null;
  return {
    name: asset.name,
    downloadUrl: asset.browser_download_url,
    size: Number.isFinite(Number(asset.size)) ? Number(asset.size) : 0,
    contentType: typeof asset.content_type === 'string' ? asset.content_type : '',
    updatedAt: typeof asset.updated_at === 'string' ? asset.updated_at : null
  };
}

export function selectReleaseAsset(release, version) {
  const expectedName = buildReleaseZipName(version);
  if (!expectedName || !Array.isArray(release?.assets)) return null;

  const asset = release.assets.find(candidate => (
    candidate?.name === expectedName
      && isReleaseDownloadUrl(candidate.browser_download_url, expectedName)
  ));

  return normalizeAsset(asset);
}

export function selectUpdateManifestAsset(release) {
  if (!Array.isArray(release?.assets)) return null;
  const asset = release.assets.find(candidate => (
    candidate?.name === UPDATE_MANIFEST_ASSET_NAME
      && isReleaseDownloadUrl(candidate.browser_download_url, UPDATE_MANIFEST_ASSET_NAME)
  ));
  return normalizeAsset(asset);
}

export function normalizeReleaseMetadata(release, version) {
  return {
    version: normalizeVersion(version),
    tagName: typeof release?.tag_name === 'string' ? release.tag_name : `v${normalizeVersion(version)}`,
    name: typeof release?.name === 'string' ? release.name : '',
    htmlUrl: typeof release?.html_url === 'string' ? release.html_url : '',
    publishedAt: typeof release?.published_at === 'string' ? release.published_at : null,
    prerelease: release?.prerelease === true,
    draft: release?.draft === true
  };
}

function buildUpdateResult(
  localVersion,
  latestVersion,
  release,
  asset,
  assetStatus = 'none',
  updateManifestAsset = null,
  updateManifestStatus = 'none'
) {
  const updateAvailable = !!latestVersion && isNewerVersion(localVersion, latestVersion);
  if (!updateAvailable) {
    return {
      updateAvailable: false,
      latestVersion: null,
      release: null,
      asset: null,
      assetStatus: 'none',
      updateManifestAsset: null,
      updateManifestStatus: 'none'
    };
  }

  return {
    updateAvailable: true,
    latestVersion,
    release: release || null,
    asset: asset || null,
    assetStatus: asset ? 'found' : assetStatus,
    updateManifestAsset: updateManifestAsset || null,
    updateManifestStatus: updateManifestAsset ? 'found' : updateManifestStatus
  };
}

function buildUnavailableResult(assetStatus = 'unavailable') {
  return {
    updateAvailable: false,
    latestVersion: null,
    release: null,
    asset: null,
    assetStatus,
    updateManifestAsset: null,
    updateManifestStatus: 'none'
  };
}

export async function checkForUpdate(options = {}) {
  try {
    const { updateCheckCache: cache } = await chrome.storage.local.get('updateCheckCache');
    const now = Date.now();
    const local = chrome.runtime.getManifest().version;

    if (!options.force && cache && (now - cache.checkedAt) < UPDATE_CHECK_TTL_MS) {
      return buildUpdateResult(
        local,
        cache.latestVersion,
        cache.release || null,
        cache.asset || null,
        cache.assetStatus || (cache.asset ? 'found' : 'missing'),
        cache.updateManifestAsset || null,
        cache.updateManifestStatus || (cache.updateManifestAsset ? 'found' : 'missing')
      );
    }

    const res = await fetch(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-cache'
    });

    if (!res.ok) return buildUnavailableResult();

    const data = await res.json();
    const latestVersion = normalizeVersion(data.tag_name);
    if (!latestVersion) return buildUnavailableResult('missing-version');

    const release = normalizeReleaseMetadata(data, latestVersion);
    const asset = selectReleaseAsset(data, latestVersion);
    const assetStatus = asset ? 'found' : 'missing';
    const updateManifestAsset = selectUpdateManifestAsset(data);
    const updateManifestStatus = updateManifestAsset ? 'found' : 'missing';

    await chrome.storage.local.set({
      updateCheckCache: {
        latestVersion,
        checkedAt: now,
        release,
        asset,
        assetStatus,
        updateManifestAsset,
        updateManifestStatus
      }
    });

    return buildUpdateResult(
      local,
      latestVersion,
      release,
      asset,
      assetStatus,
      updateManifestAsset,
      updateManifestStatus
    );
  } catch {
    return buildUnavailableResult();
  }
}
