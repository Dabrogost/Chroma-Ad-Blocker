/**
 * Chroma Ad-Blocker - Settings guided update preparation.
 * This validates release metadata, package shape, folder access, and guided installs.
 */

'use strict';

const ChromaUpdaterUI = (() => {
  const DB_NAME = 'chroma-updater';
  const DB_VERSION = 1;
  const STORE_NAME = 'handles';
  const INSTALL_HANDLE_KEY = 'installDirectory';
  const PROBE_FILE_NAME = '.chroma-write-probe';
  const EXPECTED_EXTENSION_NAME = 'Chroma Ad-Blocker';
  const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/';
  const RELEASE_ZIP_BASENAME = 'chroma-ad-blocker';
  const UPDATE_MANIFEST_ASSET_NAME = 'updates.json';
  const UPDATE_MANIFEST_VERIFICATION = 'signed-updates.json';
  const MAX_ZIP_BYTES = 200 * 1024 * 1024;
  const MAX_ENTRY_COUNT = 30000;
  const MAX_TOTAL_UNCOMPRESSED_BYTES = 350 * 1024 * 1024;
  const MAX_INSTALL_PLAN_FILES = 50000;
  const MAX_INSTALL_PLAN_DEPTH = 20;
  const BACKUP_DIR_PREFIX = '.chroma-update-backup-';
  const MANIFEST_PATH = 'manifest.json';
  const EOCD_SIGNATURE = 0x06054b50;
  const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
  const LOCAL_FILE_SIGNATURE = 0x04034b50;
  const ZIP64_SIZE_SENTINEL = 0xffffffff;
  const ACTION_BUTTON_IDS = [
    'checkLatestReleaseBtn',
    'chooseInstallFolderBtn',
    'inspectPackageBtn',
    'buildInstallPlanBtn',
    'runFolderProbeBtn',
    'installUpdateBtn',
    'reloadChromaBtn'
  ];
  const NEXT_ACTION_STEP_BY_BUTTON_ID = {
    chooseInstallFolderBtn: 'updaterStepFolder',
    inspectPackageBtn: 'updaterStepPackage',
    buildInstallPlanBtn: 'updaterStepPlan',
    runFolderProbeBtn: 'updaterStepWrite',
    installUpdateBtn: 'updaterStepInstall',
    reloadChromaBtn: 'updaterStepInstall'
  };

  let installDirectoryHandle = null;
  let latestPackageInspection = null;
  let latestInstallPlan = null;
  let writeProbePassed = false;
  let installCompleted = false;
  let savedFolderNeedsPermission = false;
  let updaterBusy = false;
  let currentVersionKnown = false;

  const CRC_TABLE = (() => {
    const table = new Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function $(id) {
    return document.getElementById(id);
  }

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  function isFileSystemAccessSupported() {
    return typeof globalThis.showDirectoryPicker === 'function';
  }

  function setStepState(stepId, state) {
    const step = $(stepId);
    if (!step) return;
    const dot = step.querySelector('.updater-step__dot');
    step.classList.remove('updater-step--pending', 'updater-step--ok', 'updater-step--error');
    step.classList.add(`updater-step--${state}`);
    if (dot) {
      dot.classList.remove('updater-step__dot--pending', 'updater-step__dot--ok', 'updater-step__dot--error');
      dot.classList.add(`updater-step__dot--${state}`);
    }
  }

  function setUpdaterCurrentMode(active) {
    $('updaterPanel')?.classList.toggle('updater-panel--current', active);
  }

  function getCurrentVersionText() {
    const version = normalizeVersion(chrome.runtime.getManifest().version);
    return version ? `v${version}` : 'the current version';
  }

  function renderCurrentVersionState(reason) {
    const versionText = getCurrentVersionText();
    setUpdaterCurrentMode(true);
    hideProgress();
    const plan = $('updaterPlanSummary');
    if (plan) plan.hidden = true;
    setReloadActionVisible(false);
    setText('updaterStatusTitle', 'Chroma Is Current');
    setText(
      'updaterStatusDesc',
      installDirectoryHandle && !savedFolderNeedsPermission
        ? `Chroma ${versionText} is current, and this install folder is verified.`
        : `Chroma ${versionText} is current. No update is available.`
    );
    setResult(reason || `No newer release found. Chroma is already on ${versionText}.`, 'ok');
    updateNextActionPrompt();
  }

  function enterCurrentVersionState(resultOrReason) {
    const reason = typeof resultOrReason === 'string' ? resultOrReason : resultOrReason?.reason;
    currentVersionKnown = true;
    latestPackageInspection = {
      ok: true,
      updateAvailable: false,
      reason: reason || ''
    };
    latestInstallPlan = null;
    writeProbePassed = false;
    installCompleted = false;
    renderCurrentVersionState(reason);
  }

  function clearCurrentVersionState() {
    currentVersionKnown = false;
    if (latestPackageInspection?.ok && latestPackageInspection.updateAvailable === false) {
      latestPackageInspection = null;
    }
    setUpdaterCurrentMode(false);
    updateNextActionPrompt();
  }

  function applyPassiveUpdateCheck(result) {
    const validation = validateReleaseMetadata(result, chrome.runtime.getManifest());
    if (validation.ok && result?.updateAvailable === false) {
      enterCurrentVersionState(validation.reason);
    } else if (result?.updateAvailable) {
      clearCurrentVersionState();
    }
  }

  function getNextActionButtonId() {
    if (updaterBusy || !isFileSystemAccessSupported()) return null;
    if (currentVersionKnown) return null;
    if (installCompleted) return 'reloadChromaBtn';
    if (!installDirectoryHandle || savedFolderNeedsPermission) return 'chooseInstallFolderBtn';
    if (latestPackageInspection?.ok && latestPackageInspection.updateAvailable === false) return null;
    if (!hasInstallVerification(latestPackageInspection) || !latestPackageInspection.updateAvailable) {
      return 'inspectPackageBtn';
    }
    if (!latestInstallPlan?.ok) return 'buildInstallPlanBtn';
    if (!writeProbePassed) return 'runFolderProbeBtn';
    if (canInstallUpdate()) return 'installUpdateBtn';
    return null;
  }

  function updateNextActionPrompt() {
    const nextId = getNextActionButtonId();
    const nextStepId = nextId ? NEXT_ACTION_STEP_BY_BUTTON_ID[nextId] : null;
    ACTION_BUTTON_IDS.forEach(id => {
      const button = $(id);
      if (!button) return;
      const active = id === nextId && !button.disabled && !button.hidden;
      button.classList.toggle('updater-action--next', active);
      if (active) {
        button.setAttribute('aria-current', 'step');
      } else {
        button.removeAttribute('aria-current');
      }
    });
    [...new Set(Object.values(NEXT_ACTION_STEP_BY_BUTTON_ID))].forEach(stepId => {
      const step = $(stepId);
      if (step) step.classList.toggle('updater-step--next', stepId === nextStepId);
    });
  }

  function setResult(message, state = 'neutral') {
    const el = $('updaterResult');
    if (!el) return;
    el.textContent = message || '';
    el.classList.remove('updater-result--ok', 'updater-result--error', 'updater-result--neutral');
    el.classList.add(`updater-result--${state}`);
  }

  function setReloadActionVisible(visible) {
    const button = $('reloadChromaBtn');
    if (!button) return;
    button.hidden = !visible;
    button.disabled = !visible;
    updateNextActionPrompt();
  }

  function setChooseFolderButtonText(text) {
    const button = $('chooseInstallFolderBtn');
    if (button) button.textContent = text;
  }

  function setBusy(busy) {
    updaterBusy = busy;
    const supported = isFileSystemAccessSupported();
    const controls = [
      { id: 'checkLatestReleaseBtn', disabled: busy },
      { id: 'inspectPackageBtn', disabled: busy },
      { id: 'buildInstallPlanBtn', disabled: busy || !supported || !installDirectoryHandle || savedFolderNeedsPermission },
      { id: 'chooseInstallFolderBtn', disabled: busy || !supported },
      { id: 'runFolderProbeBtn', disabled: busy || !supported || !installDirectoryHandle || savedFolderNeedsPermission },
      { id: 'installUpdateBtn', disabled: busy || !canInstallUpdate() },
      { id: 'reloadChromaBtn', disabled: busy || !installCompleted }
    ];

    controls.forEach(({ id, disabled }) => {
      const el = $(id);
      if (!el) return;
      el.disabled = disabled;
      el.classList.toggle('control-pending', busy);
    });
    updateNextActionPrompt();
  }

  function canInstallUpdate() {
    return (
      isFileSystemAccessSupported()
      && installDirectoryHandle
      && writeProbePassed
      && hasInstallVerification(latestPackageInspection)
      && latestPackageInspection.updateAvailable
      && latestInstallPlan?.ok
      && !installCompleted
    );
  }

  function setProgress(current, total, text) {
    const progress = $('updaterProgress');
    const fill = $('updaterProgressFill');
    const label = $('updaterProgressText');
    if (!progress || !fill || !label) return;

    const safeTotal = Math.max(1, Number(total) || 1);
    const safeCurrent = Math.max(0, Math.min(safeTotal, Number(current) || 0));
    const pct = Math.round((safeCurrent / safeTotal) * 100);
    progress.hidden = false;
    fill.style.width = `${pct}%`;
    label.textContent = text || `${pct}%`;
  }

  function hideProgress() {
    const progress = $('updaterProgress');
    const fill = $('updaterProgressFill');
    const label = $('updaterProgressText');
    if (progress) progress.hidden = true;
    if (fill) fill.style.width = '0%';
    if (label) label.textContent = 'Waiting';
  }

  function toUint8Array(value) {
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array(value);
    if (typeof value === 'string') return new TextEncoder().encode(value);
    return new Uint8Array(0);
  }

  function concatBytes(chunks) {
    const bytes = chunks.map(toUint8Array);
    const total = bytes.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    bytes.forEach(chunk => {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    });
    return out;
  }

  function crc32(bytes) {
    let crc = 0 ^ -1;
    for (let i = 0; i < bytes.length; i++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
  }

  async function sha256Hex(bytes) {
    if (!globalThis.crypto?.subtle) return null;
    const digest = await crypto.subtle.digest('SHA-256', toUint8Array(bytes));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function hasInstallVerification(packageInspection) {
    const packageInfo = packageInspection?.package;
    const sha256 = String(packageInfo?.sha256 || '').trim().toLowerCase();
    return (
      packageInspection?.ok === true
      && packageInfo?.verifiedBy === UPDATE_MANIFEST_VERIFICATION
      && /^[a-f0-9]{64}$/.test(sha256)
      && Number(packageInfo.downloadBytes) > 0
    );
  }

  async function hasReadPermission(directoryHandle) {
    if (typeof directoryHandle?.queryPermission !== 'function') return true;
    try {
      return (await directoryHandle.queryPermission({ mode: 'read' })) === 'granted';
    } catch {
      return true;
    }
  }

  function openDb() {
    if (!globalThis.indexedDB) return Promise.resolve(null);
    return new Promise(resolve => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }

  async function saveInstallDirectoryHandle(handle) {
    const db = await openDb();
    if (!db) return false;
    return new Promise(resolve => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(handle, INSTALL_HANDLE_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        resolve(false);
      };
    });
  }

  async function loadInstallDirectoryHandle() {
    const db = await openDb();
    if (!db) return null;
    return new Promise(resolve => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(INSTALL_HANDLE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    });
  }

  async function readManifestFromDirectory(directoryHandle) {
    const manifestHandle = await directoryHandle.getFileHandle('manifest.json');
    const manifestFile = await manifestHandle.getFile();
    const manifestText = await manifestFile.text();
    return JSON.parse(manifestText);
  }

  function validateInstallManifest(manifest, currentManifest = {}) {
    if (!manifest || typeof manifest !== 'object') {
      return { ok: false, reason: 'Selected folder does not contain a readable manifest.json.' };
    }
    if (manifest.manifest_version !== 3) {
      return { ok: false, reason: 'Selected manifest is not a Manifest V3 extension.' };
    }
    if (manifest.name !== EXPECTED_EXTENSION_NAME) {
      return { ok: false, reason: 'Selected folder is not Chroma Ad-Blocker.' };
    }
    if (currentManifest.version && manifest.version !== currentManifest.version) {
      return {
        ok: false,
        reason: `Selected Chroma folder is v${manifest.version}; this running copy is v${currentManifest.version}.`
      };
    }
    return { ok: true, reason: `Chroma v${manifest.version || 'unknown'} install folder verified.` };
  }

  async function verifyInstallDirectory(directoryHandle, currentManifest) {
    try {
      const manifest = await readManifestFromDirectory(directoryHandle);
      const result = validateInstallManifest(manifest, currentManifest);
      return { ...result, manifest };
    } catch (error) {
      if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
        return {
          ok: false,
          permissionNeeded: true,
          reason: 'Chroma remembers the selected folder, but Chrome needs folder permission again. Click Reconnect Chroma Folder.'
        };
      }
      return {
        ok: false,
        reason: error?.name === 'NotFoundError'
          ? 'Selected folder does not contain manifest.json.'
          : 'Selected folder could not be read as a Chroma install.'
      };
    }
  }

  function normalizeVersion(version) {
    return String(version || '').trim().replace(/^v/i, '');
  }

  function buildReleaseZipName(version) {
    const normalized = normalizeVersion(version);
    return normalized ? `${RELEASE_ZIP_BASENAME}-v${normalized}.zip` : '';
  }

  function formatBytes(bytes) {
    const size = Number(bytes);
    if (!Number.isFinite(size) || size <= 0) return 'unknown size';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  function validateReleaseMetadata(result, currentManifest = {}) {
    if (!result || typeof result !== 'object') {
      return { ok: false, reason: 'Update check did not return release metadata.' };
    }
    if (result.assetStatus === 'unavailable') {
      return { ok: false, reason: 'Latest release metadata could not be reached.' };
    }
    if (!result.updateAvailable) {
      const currentVersion = normalizeVersion(currentManifest.version);
      return {
        ok: true,
        reason: currentVersion
          ? `No newer release found. This install is already on v${currentVersion}.`
          : 'No newer release found for this install.'
      };
    }

    const latestVersion = normalizeVersion(result.latestVersion || result.release?.version);
    const releaseVersion = normalizeVersion(result.release?.version);
    if (!latestVersion || releaseVersion !== latestVersion) {
      return { ok: false, reason: 'Latest release metadata is missing a matching version.' };
    }

    const expectedName = buildReleaseZipName(latestVersion);
    const asset = result.asset;
    if (result.assetStatus !== 'found' || !asset) {
      return { ok: false, reason: `Latest release is missing ${expectedName}.` };
    }
    if (asset.name !== expectedName) {
      return { ok: false, reason: `Latest release asset is ${asset.name || 'unnamed'}, expected ${expectedName}.` };
    }
    if (
      typeof asset.downloadUrl !== 'string'
      || !asset.downloadUrl.startsWith(RELEASE_DOWNLOAD_PREFIX)
      || !asset.downloadUrl.endsWith(`/${expectedName}`)
    ) {
      return { ok: false, reason: 'Latest release asset does not expose the expected direct GitHub download URL.' };
    }
    if (!Number.isFinite(Number(asset.size)) || Number(asset.size) <= 0) {
      return { ok: false, reason: 'Latest release asset does not report a valid ZIP size.' };
    }

    const updateManifestAsset = result.updateManifestAsset;
    if (result.updateManifestStatus !== 'found' || !updateManifestAsset) {
      return { ok: false, reason: 'Latest release is missing updates.json for guided package verification.' };
    }
    if (updateManifestAsset.name !== UPDATE_MANIFEST_ASSET_NAME) {
      return { ok: false, reason: `Latest release update manifest is ${updateManifestAsset.name || 'unnamed'}, expected updates.json.` };
    }
    if (
      typeof updateManifestAsset.downloadUrl !== 'string'
      || !updateManifestAsset.downloadUrl.startsWith(RELEASE_DOWNLOAD_PREFIX)
      || !updateManifestAsset.downloadUrl.endsWith(`/${UPDATE_MANIFEST_ASSET_NAME}`)
    ) {
      return { ok: false, reason: 'Latest release updates.json does not expose the expected direct GitHub download URL.' };
    }
    if (!Number.isFinite(Number(updateManifestAsset.size)) || Number(updateManifestAsset.size) <= 0) {
      return { ok: false, reason: 'Latest release updates.json does not report a valid size.' };
    }

    return {
      ok: true,
      reason: `Release ZIP and updates.json found: ${expectedName} (${formatBytes(asset.size)}).`
    };
  }

  function normalizeRelativePath(path) {
    if (typeof path !== 'string') return null;
    const normalized = path.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized || normalized.endsWith('/')) return null;
    if (/^[a-z]:/i.test(normalized)) return null;
    const parts = normalized.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) return null;
    return normalized;
  }

  function shouldIgnoreInstallPath(path) {
    return (
      path === PROBE_FILE_NAME
      || path === '.DS_Store'
      || path.endsWith('/.DS_Store')
      || /^Thumbs\.db$/i.test(path)
      || /\/Thumbs\.db$/i.test(path)
      || path === '_metadata'
      || path.startsWith('_metadata/')
      || path.startsWith(BACKUP_DIR_PREFIX)
    );
  }

  function normalizePackageFiles(files) {
    if (!Array.isArray(files)) return [];
    const byPath = new Map();
    for (const file of files) {
      const path = normalizeRelativePath(file?.path || file?.name);
      if (!path) continue;
      byPath.set(path, {
        path,
        size: Number.isFinite(Number(file.size)) ? Number(file.size) : 0
      });
    }
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  function readZipEntries(zipBytes) {
    if (zipBytes.byteLength < 22) throw new Error('Downloaded package is too small to be a ZIP archive.');
    if (zipBytes.byteLength > MAX_ZIP_BYTES) throw new Error('Downloaded ZIP exceeds the updater safety limit.');

    const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
    const minOffset = Math.max(0, view.byteLength - 22 - 0xffff);
    let eocdOffset = -1;
    for (let offset = view.byteLength - 22; offset >= minOffset; offset--) {
      if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
        eocdOffset = offset;
        break;
      }
    }
    if (eocdOffset === -1) throw new Error('Downloaded package is not a valid ZIP archive.');

    const entryCount = view.getUint16(eocdOffset + 10, true);
    const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
    let offset = view.getUint32(eocdOffset + 16, true);
    if (entryCount < 1 || entryCount > MAX_ENTRY_COUNT || offset + centralDirectorySize > zipBytes.byteLength) {
      throw new Error('Downloaded ZIP central directory is invalid.');
    }

    const entries = [];
    const seen = new Set();
    let totalUncompressedBytes = 0;
    for (let index = 0; index < entryCount; index++) {
      if (offset + 46 > zipBytes.byteLength || view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
        throw new Error('Downloaded ZIP central directory entry is malformed.');
      }
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const entryCrc32 = view.getUint32(offset + 16, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const fileNameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localHeaderOffset = view.getUint32(offset + 42, true);
      const nameStart = offset + 46;
      const nameEnd = nameStart + fileNameLength;
      if (nameEnd + extraLength + commentLength > zipBytes.byteLength) {
        throw new Error('Downloaded ZIP entry name is out of bounds.');
      }
      if (compressedSize === ZIP64_SIZE_SENTINEL || uncompressedSize === ZIP64_SIZE_SENTINEL) {
        throw new Error('Downloaded ZIP uses ZIP64 entries, which are not supported by this updater.');
      }

      const path = normalizeRelativePath(new TextDecoder().decode(zipBytes.subarray(nameStart, nameEnd)));
      if (!path) throw new Error('Downloaded ZIP contains an unsafe path.');
      if (seen.has(path)) throw new Error(`Downloaded ZIP contains duplicate entry: ${path}.`);
      if ((flags & 0x1) !== 0) throw new Error('Downloaded ZIP contains encrypted entries.');
      if (method !== 0 && method !== 8) throw new Error(`Downloaded ZIP uses unsupported compression method ${method}.`);
      seen.add(path);
      totalUncompressedBytes += uncompressedSize;
      if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        throw new Error('Downloaded ZIP expands beyond the updater safety limit.');
      }

      entries.push({
        path,
        flags,
        method,
        crc32: entryCrc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset
      });
      offset = nameEnd + extraLength + commentLength;
    }
    return entries;
  }

  function readCompressedEntryBytes(zipBytes, entry) {
    const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
    const offset = entry.localHeaderOffset;
    if (offset + 30 > zipBytes.byteLength || view.getUint32(offset, true) !== LOCAL_FILE_SIGNATURE) {
      throw new Error(`Downloaded ZIP local header is malformed for ${entry.path}.`);
    }
    const fileNameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const dataStart = offset + 30 + fileNameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > zipBytes.byteLength) {
      throw new Error(`Downloaded ZIP data is out of bounds for ${entry.path}.`);
    }
    return zipBytes.subarray(dataStart, dataEnd);
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('This browser cannot extract compressed ZIP entries.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readResponseBytes(response, expectedBytes, onProgress) {
    const expected = Number(expectedBytes) || Number(response.headers?.get?.('content-length')) || 0;
    const contentLength = Number(response.headers?.get?.('content-length'));
    if (expected > MAX_ZIP_BYTES || contentLength > MAX_ZIP_BYTES) {
      throw new Error('Downloaded ZIP exceeds the updater safety limit.');
    }

    if (!response.body || typeof response.body.getReader !== 'function') {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_ZIP_BYTES) {
        throw new Error('Downloaded ZIP exceeds the updater safety limit.');
      }
      onProgress?.(bytes.byteLength, expected || bytes.byteLength);
      return bytes;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = toUint8Array(value);
        chunks.push(chunk);
        loaded += chunk.byteLength;
        if (loaded > MAX_ZIP_BYTES) {
          await reader.cancel?.();
          throw new Error('Downloaded ZIP exceeds the updater safety limit.');
        }
        onProgress?.(loaded, expected || loaded);
      }
    } finally {
      reader.releaseLock?.();
    }

    return concatBytes(chunks);
  }

  async function readEntryBytes(zipBytes, entry) {
    const compressed = readCompressedEntryBytes(zipBytes, entry);
    const bytes = entry.method === 0 ? compressed : await inflateRaw(compressed);
    if (bytes.byteLength !== entry.uncompressedSize || crc32(bytes) !== entry.crc32) {
      throw new Error(`Downloaded ZIP entry failed validation: ${entry.path}.`);
    }
    return bytes;
  }

  async function fetchVerifiedPackageFiles(packageInspection, onDownloadProgress) {
    const asset = packageInspection?.asset;
    const packageInfo = packageInspection?.package;
    if (!asset?.downloadUrl || !asset?.name || !Array.isArray(packageInfo?.files)) {
      throw new Error('Verified package metadata is missing the direct ZIP download.');
    }
    if (!hasInstallVerification(packageInspection)) {
      throw new Error('Verified package metadata is missing signed updates.json verification.');
    }
    if (
      !asset.downloadUrl.startsWith(RELEASE_DOWNLOAD_PREFIX)
      || !asset.downloadUrl.endsWith(`/${asset.name}`)
    ) {
      throw new Error('Verified package URL no longer matches the expected GitHub release asset.');
    }

    const response = await fetch(asset.downloadUrl, {
      headers: { Accept: 'application/zip, application/octet-stream' },
      cache: 'no-cache'
    });
    if (!response.ok) throw new Error('Release ZIP download failed.');

    const zipBytes = await readResponseBytes(response, packageInfo.downloadBytes || asset.size, onDownloadProgress);
    if (Number(packageInfo.downloadBytes) > 0 && zipBytes.byteLength !== Number(packageInfo.downloadBytes)) {
      throw new Error('Downloaded ZIP size changed after package inspection.');
    }
    const hash = await sha256Hex(zipBytes);
    if (!hash) {
      throw new Error('This browser cannot verify the release ZIP SHA-256 before install.');
    }
    if (hash !== String(packageInfo.sha256).trim().toLowerCase()) {
      throw new Error('Downloaded ZIP hash changed after package inspection.');
    }

    const expectedFiles = normalizePackageFiles(packageInfo.files);
    const expectedByPath = new Map(expectedFiles.map(file => [file.path, file]));
    const entries = readZipEntries(zipBytes);
    const entryByPath = new Map(entries.map(entry => [entry.path, entry]));
    const files = new Map();

    for (const expected of expectedFiles) {
      const entry = entryByPath.get(expected.path);
      if (!entry) throw new Error(`Downloaded ZIP is missing ${expected.path}.`);
      if (entry.uncompressedSize !== expected.size) {
        throw new Error(`Downloaded ZIP entry size changed: ${expected.path}.`);
      }
      const bytes = await readEntryBytes(zipBytes, entry);
      files.set(expected.path, bytes);
    }

    for (const entry of entries) {
      if (!expectedByPath.has(entry.path)) {
        throw new Error(`Downloaded ZIP contains unexpected file: ${entry.path}.`);
      }
    }

    return files;
  }

  async function listInstallFiles(directoryHandle, prefix = '', depth = 0, out = []) {
    if (depth > MAX_INSTALL_PLAN_DEPTH) {
      throw new Error('Selected folder is nested too deeply for a safe install plan.');
    }
    if (typeof directoryHandle.entries !== 'function') {
      throw new Error('Selected folder cannot be enumerated by this browser.');
    }

    for await (const [name, handle] of directoryHandle.entries()) {
      const relativePath = normalizeRelativePath(prefix ? `${prefix}/${name}` : name);
      if (!relativePath) {
        throw new Error('Selected folder contains a path the updater cannot safely plan.');
      }

      if (handle.kind === 'directory') {
        if (shouldIgnoreInstallPath(relativePath)) continue;
        await listInstallFiles(handle, relativePath, depth + 1, out);
      } else if (handle.kind === 'file') {
        let size = 0;
        if (typeof handle.getFile === 'function') {
          const file = await handle.getFile();
          size = Number.isFinite(Number(file?.size)) ? Number(file.size) : 0;
        }
        out.push({ path: relativePath, size });
        if (out.length > MAX_INSTALL_PLAN_FILES) {
          throw new Error('Selected folder contains too many files for a safe install plan.');
        }
      }
    }

    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  function buildInstallPlan(packageFiles, installFiles) {
    const normalizedPackageFiles = normalizePackageFiles(packageFiles);
    if (normalizedPackageFiles.length === 0) {
      return { ok: false, reason: 'Package inspection did not return any installable files.' };
    }

    const packageByPath = new Map(normalizedPackageFiles.map(file => [file.path, file]));
    const installByPath = new Map();
    const ignored = [];

    for (const file of installFiles || []) {
      const path = normalizeRelativePath(file?.path || file?.name);
      if (!path) return { ok: false, reason: 'Selected folder contains a file path the updater cannot safely plan.' };
      const normalizedFile = {
        path,
        size: Number.isFinite(Number(file.size)) ? Number(file.size) : 0
      };
      if (shouldIgnoreInstallPath(path)) ignored.push(normalizedFile);
      else installByPath.set(path, normalizedFile);
    }

    const add = [];
    const overwrite = [];
    const remove = [];

    for (const file of normalizedPackageFiles) {
      if (installByPath.has(file.path)) overwrite.push(file);
      else add.push(file);
    }
    for (const file of installByPath.values()) {
      if (!packageByPath.has(file.path)) remove.push(file);
    }

    return {
      ok: true,
      add,
      overwrite,
      remove,
      ignored,
      totalPackageFiles: normalizedPackageFiles.length,
      totalInstallFiles: installByPath.size,
      reason: `Install plan ready: ${add.length} add, ${overwrite.length} overwrite, ${remove.length} remove.`
    };
  }

  function appendPlanGroup(container, label, files) {
    const group = document.createElement('div');
    group.className = 'updater-plan__group';

    const title = document.createElement('div');
    title.className = 'updater-plan__group-title';
    title.textContent = `${label}: ${files.length}`;
    group.appendChild(title);

    const list = document.createElement('div');
    list.className = 'updater-plan__paths';
    const preview = files.slice(0, 4);
    preview.forEach(file => {
      const item = document.createElement('div');
      item.className = 'updater-plan__path';
      item.textContent = file.path;
      list.appendChild(item);
    });
    if (files.length > preview.length) {
      const more = document.createElement('div');
      more.className = 'updater-plan__path updater-plan__path--more';
      more.textContent = `+${files.length - preview.length} more`;
      list.appendChild(more);
    }

    group.appendChild(list);
    container.appendChild(group);
  }

  function renderInstallPlan(plan) {
    const summary = $('updaterPlanSummary');
    const preview = $('updaterPlanPreview');
    if (!summary || !preview) return;

    summary.hidden = false;
    setText('updaterPlanAddCount', String(plan.add.length));
    setText('updaterPlanOverwriteCount', String(plan.overwrite.length));
    setText('updaterPlanRemoveCount', String(plan.remove.length));
    setText('updaterPlanIgnoreCount', String(plan.ignored.length));

    preview.textContent = '';
    appendPlanGroup(preview, 'Add', plan.add);
    appendPlanGroup(preview, 'Overwrite', plan.overwrite);
    appendPlanGroup(preview, 'Remove', plan.remove);
    if (plan.ignored.length > 0) appendPlanGroup(preview, 'Ignore', plan.ignored);
  }

  async function getDirectoryForPath(rootHandle, path, { create = false } = {}) {
    const parts = path.split('/').slice(0, -1);
    let directory = rootHandle;
    for (const part of parts) {
      directory = await directory.getDirectoryHandle(part, { create });
    }
    return directory;
  }

  async function getFileHandleForPath(rootHandle, path, { create = false } = {}) {
    const normalized = normalizeRelativePath(path);
    if (!normalized) throw new Error('Unsafe file path refused.');
    const directory = await getDirectoryForPath(rootHandle, normalized, { create });
    const name = normalized.split('/').pop();
    return directory.getFileHandle(name, { create });
  }

  async function readFileBytes(rootHandle, path) {
    const fileHandle = await getFileHandleForPath(rootHandle, path);
    const file = await fileHandle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async function writeFileBytes(rootHandle, path, bytes) {
    const fileHandle = await getFileHandleForPath(rootHandle, path, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(toUint8Array(bytes));
    await writable.close();
  }

  async function removeFilePath(rootHandle, path) {
    const normalized = normalizeRelativePath(path);
    if (!normalized) throw new Error('Unsafe file path refused.');
    const directory = await getDirectoryForPath(rootHandle, normalized);
    await directory.removeEntry(normalized.split('/').pop());
  }

  async function createBackupDirectory(rootHandle) {
    const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const random = Math.random().toString(36).slice(2, 8);
    const name = `${BACKUP_DIR_PREFIX}${stamp}-${random}`;
    return {
      name,
      handle: await rootHandle.getDirectoryHandle(name, { create: true })
    };
  }

  async function cleanupBackupDirectory(rootHandle, backupName) {
    try {
      await rootHandle.removeEntry(backupName, { recursive: true });
    } catch {}
  }

  async function ensureReadWritePermission(directoryHandle) {
    const options = { mode: 'readwrite' };
    if (typeof directoryHandle.queryPermission === 'function') {
      const current = await directoryHandle.queryPermission(options);
      if (current === 'granted') return true;
    }
    if (typeof directoryHandle.requestPermission === 'function') {
      return (await directoryHandle.requestPermission(options)) === 'granted';
    }
    return true;
  }

  async function runWriteProbe(directoryHandle) {
    const granted = await ensureReadWritePermission(directoryHandle);
    if (!granted) {
      return { ok: false, reason: 'Write permission was not granted for the selected folder.' };
    }

    let created = false;
    try {
      const probeHandle = await directoryHandle.getFileHandle(PROBE_FILE_NAME, { create: true });
      created = true;
      const writable = await probeHandle.createWritable();
      await writable.write(`Chroma updater write probe ${new Date().toISOString()}`);
      await writable.close();
      await directoryHandle.removeEntry(PROBE_FILE_NAME);
      return { ok: true, reason: 'Write probe passed. Chroma can write to this install folder.' };
    } catch (error) {
      if (created) {
        try {
          await directoryHandle.removeEntry(PROBE_FILE_NAME);
        } catch {}
      }
      return { ok: false, reason: 'Write probe failed. Chroma could not create and remove a probe file.' };
    }
  }

  function updateVerifiedFolderState(result) {
    const runBtn = $('runFolderProbeBtn');
    const planBtn = $('buildInstallPlanBtn');
    if (result.ok) {
      savedFolderNeedsPermission = false;
      latestInstallPlan = null;
      writeProbePassed = false;
      installCompleted = false;
      setReloadActionVisible(false);
      setChooseFolderButtonText('Change Chroma Folder');
      setStepState('updaterStepFolder', 'ok');
      setStepState('updaterStepPlan', 'pending');
      setStepState('updaterStepWrite', 'pending');
      if (currentVersionKnown) {
        renderCurrentVersionState();
      } else {
        setText('updaterStatusTitle', 'Install Folder Verified');
        setText('updaterStatusDesc', 'Run the write probe to confirm Chroma can update this folder.');
        setResult(result.reason, 'ok');
      }
      if (planBtn) planBtn.disabled = false;
      if (runBtn) runBtn.disabled = false;
    } else if (result.permissionNeeded) {
      savedFolderNeedsPermission = true;
      latestInstallPlan = null;
      writeProbePassed = false;
      installCompleted = false;
      setReloadActionVisible(false);
      setChooseFolderButtonText('Reconnect Chroma Folder');
      setStepState('updaterStepFolder', 'pending');
      setStepState('updaterStepPlan', 'pending');
      setStepState('updaterStepWrite', 'pending');
      setText('updaterStatusTitle', 'Folder Permission Needed');
      setText('updaterStatusDesc', 'Chrome remembered the folder, but needs your approval before Chroma can read it again.');
      setResult(result.reason, 'neutral');
      if (planBtn) planBtn.disabled = true;
      if (runBtn) runBtn.disabled = true;
    } else {
      clearCurrentVersionState();
      installDirectoryHandle = null;
      savedFolderNeedsPermission = false;
      latestInstallPlan = null;
      writeProbePassed = false;
      installCompleted = false;
      setReloadActionVisible(false);
      setChooseFolderButtonText('Choose Chroma Folder');
      setStepState('updaterStepFolder', 'error');
      setStepState('updaterStepPlan', 'pending');
      setStepState('updaterStepWrite', 'pending');
      setText('updaterStatusTitle', 'Folder Not Verified');
      setText('updaterStatusDesc', 'Choose the unpacked Chroma folder that contains manifest.json.');
      setResult(result.reason, 'error');
      if (planBtn) planBtn.disabled = true;
      if (runBtn) runBtn.disabled = true;
    }
    updateNextActionPrompt();
  }

  async function chooseInstallFolder() {
    if (!isFileSystemAccessSupported()) return;
    setBusy(true);
    try {
      let handle = installDirectoryHandle && savedFolderNeedsPermission ? installDirectoryHandle : null;
      if (handle) {
        const granted = await ensureReadWritePermission(handle);
        if (!granted) {
          updateVerifiedFolderState({
            ok: false,
            permissionNeeded: true,
            reason: 'Folder permission was not granted. Click Reconnect Chroma Folder when you are ready.'
          });
          return;
        }
      } else {
        handle = await showDirectoryPicker({ mode: 'readwrite' });
      }
      const result = await verifyInstallDirectory(handle, chrome.runtime.getManifest());
      if (result.ok) {
        installDirectoryHandle = handle;
        savedFolderNeedsPermission = false;
        setStepState('updaterStepPlan', 'pending');
        await saveInstallDirectoryHandle(handle);
      } else if (result.permissionNeeded) {
        installDirectoryHandle = handle;
        savedFolderNeedsPermission = true;
      }
      updateVerifiedFolderState(result);
    } catch (error) {
      if (error?.name === 'AbortError') {
        setResult('Folder selection canceled.', 'neutral');
      } else {
        setResult('Folder selection failed.', 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  async function inspectLatestRelease() {
    setBusy(true);
    setStepState('updaterStepRelease', 'pending');
    setText('updaterStatusTitle', 'Checking Latest Release');
    setText('updaterStatusDesc', 'Verifying the direct GitHub ZIP asset and updates.json before downloading the package.');
    setResult('Checking GitHub release metadata...', 'neutral');

    try {
      const result = await notifyBackground({ type: MSG.UPDATE_CHECK, options: { force: true } });
      const validation = validateReleaseMetadata(result, chrome.runtime.getManifest());
      if (result?.updateAvailable) {
        clearCurrentVersionState();
      }
      setStepState('updaterStepRelease', validation.ok ? 'ok' : 'error');

      if (validation.ok && result?.updateAvailable) {
        setText('updaterStatusTitle', `Release v${result.latestVersion} Ready`);
        setText('updaterStatusDesc', 'A direct release ZIP and updates.json are available for guided install.');
      } else if (validation.ok) {
        enterCurrentVersionState(validation.reason);
        return validation;
      } else {
        setText('updaterStatusTitle', 'Release Assets Not Verified');
        setText('updaterStatusDesc', 'The updater will not download anything until the expected ZIP asset and updates.json are present.');
      }

      setResult(validation.reason, validation.ok ? 'ok' : 'error');
      return validation;
    } catch (error) {
      setStepState('updaterStepRelease', 'error');
      setText('updaterStatusTitle', 'Release Check Failed');
      setText('updaterStatusDesc', 'GitHub release metadata could not be checked.');
      setResult('Release check failed before any download was attempted.', 'error');
      return { ok: false, reason: 'Release check failed before any download was attempted.' };
    } finally {
      setBusy(false);
    }
  }

  async function inspectLatestPackage() {
    clearCurrentVersionState();
    setBusy(true);
    setStepState('updaterStepPackage', 'pending');
    setText('updaterStatusTitle', 'Inspecting Package ZIP');
    setText('updaterStatusDesc', 'Downloading updates.json and the release ZIP into memory before any install work.');
    setResult('Inspecting the release package without writing files...', 'neutral');

    try {
      const result = await notifyBackground({ type: MSG.UPDATE_PACKAGE_INSPECT, options: { force: true } });
      if (result?.ok && result.updateAvailable) {
        clearCurrentVersionState();
        latestPackageInspection = result;
        latestInstallPlan = null;
        installCompleted = false;
        setReloadActionVisible(false);
        setStepState('updaterStepRelease', 'ok');
        setStepState('updaterStepPackage', 'ok');
        setStepState('updaterStepPlan', 'pending');
        setText('updaterStatusTitle', `Package v${result.package?.version || result.latestVersion} Verified`);
        setText('updaterStatusDesc', 'The ZIP manifest and referenced extension files are ready to install.');
        const fileCount = result.package?.entryCount || 'unknown';
        const byteText = formatBytes(result.package?.downloadBytes);
        setResult(`Package ZIP inspected: ${fileCount} files, ${byteText}.`, 'ok');
        return result;
      }
      if (result?.ok && !result.updateAvailable) {
        enterCurrentVersionState(result.reason || 'No newer release package is available.');
        return result;
      }

      latestPackageInspection = null;
      latestInstallPlan = null;
      installCompleted = false;
      setReloadActionVisible(false);
      setStepState('updaterStepPackage', 'error');
      if (result?.code === 'missing_asset') setStepState('updaterStepRelease', 'error');
      setText('updaterStatusTitle', 'Package ZIP Not Verified');
      setText('updaterStatusDesc', 'The updater will not install anything until the release package passes inspection.');
      setResult(result?.reason || 'Release package inspection failed.', 'error');
      return result || { ok: false, reason: 'Release package inspection failed.' };
    } catch (error) {
      setStepState('updaterStepPackage', 'error');
      setText('updaterStatusTitle', 'Package Check Failed');
      setText('updaterStatusDesc', 'The release package could not be inspected.');
      setResult('Package check failed before any install work was attempted.', 'error');
      return { ok: false, reason: 'Package check failed before any install work was attempted.' };
    } finally {
      setBusy(false);
    }
  }

  async function buildSelectedInstallPlan() {
    if (currentVersionKnown) {
      renderCurrentVersionState();
      return { ok: true, updateAvailable: false, reason: 'No update is available.' };
    }
    if (!installDirectoryHandle) {
      setStepState('updaterStepFolder', 'error');
      setResult('Choose and verify the Chroma folder before building an install plan.', 'error');
      return { ok: false, reason: 'Choose and verify the Chroma folder before building an install plan.' };
    }

    setBusy(true);
    setStepState('updaterStepPlan', 'pending');
    setText('updaterStatusTitle', 'Building Install Plan');
    setText('updaterStatusDesc', 'Comparing the inspected package with the selected folder. No files are being changed.');
    setResult('Building a dry-run install plan...', 'neutral');

    try {
      let packageInspection = latestPackageInspection;
      if (!packageInspection?.ok || !packageInspection.updateAvailable || !Array.isArray(packageInspection.package?.files)) {
        packageInspection = await notifyBackground({ type: MSG.UPDATE_PACKAGE_INSPECT, options: { force: true } });
      }
      if (!packageInspection?.ok || !packageInspection.updateAvailable) {
        if (packageInspection?.ok && packageInspection.updateAvailable === false) {
          enterCurrentVersionState(packageInspection.reason || 'No newer release package is available.');
          return { ok: true, updateAvailable: false, reason: packageInspection.reason || 'No update is available.' };
        }
        latestPackageInspection = null;
        setStepState('updaterStepPackage', 'error');
        setStepState('updaterStepPlan', 'error');
        setText('updaterStatusTitle', 'Install Plan Not Built');
        setText('updaterStatusDesc', 'A verified update package is required before planning folder changes.');
        setResult(packageInspection?.reason || 'Package inspection did not produce an update package.', 'error');
        return { ok: false, reason: packageInspection?.reason || 'Package inspection did not produce an update package.' };
      }

      latestPackageInspection = packageInspection;
      setStepState('updaterStepRelease', 'ok');
      setStepState('updaterStepPackage', 'ok');

      const installFiles = await listInstallFiles(installDirectoryHandle);
      const plan = buildInstallPlan(packageInspection.package?.files, installFiles);
      if (!plan.ok) {
        latestInstallPlan = null;
        setStepState('updaterStepPlan', 'error');
        setText('updaterStatusTitle', 'Install Plan Not Built');
        setText('updaterStatusDesc', 'The selected folder and package could not be compared safely.');
        setResult(plan.reason, 'error');
        return plan;
      }

      latestInstallPlan = plan;
      installCompleted = false;
      setReloadActionVisible(false);
      renderInstallPlan(plan);
      setStepState('updaterStepFolder', 'ok');
      setStepState('updaterStepPlan', 'ok');
      setText('updaterStatusTitle', `Install Plan for v${packageInspection.package?.version || packageInspection.latestVersion}`);
      setText('updaterStatusDesc', 'Review the dry-run plan before installing the verified package.');
      setResult(plan.reason, 'ok');
      return plan;
    } catch (error) {
      setStepState('updaterStepPlan', 'error');
      setText('updaterStatusTitle', 'Install Plan Failed');
      setText('updaterStatusDesc', 'The updater could not safely compare the package with the selected folder.');
      setResult(error?.message || 'Install plan failed before any files were changed.', 'error');
      return { ok: false, reason: error?.message || 'Install plan failed before any files were changed.' };
    } finally {
      setBusy(false);
    }
  }

  async function rollbackInstall(rootHandle, backupHandle, backupPaths, addedPaths, progress) {
    progress?.('Rolling back partial update...');
    for (const path of addedPaths.slice().reverse()) {
      try {
        await removeFilePath(rootHandle, path);
      } catch {}
    }
    for (const path of backupPaths) {
      try {
        const bytes = await readFileBytes(backupHandle, path);
        await writeFileBytes(rootHandle, path, bytes);
      } catch {}
    }
  }

  async function performInstall(plan, packageFiles, progress) {
    const backup = await createBackupDirectory(installDirectoryHandle);
    const backupPaths = [];
    const addedPaths = [];
    const addPathSet = new Set(plan.add.map(file => file.path));
    let actualChangesStarted = false;
    const backupTargets = [...plan.overwrite, ...plan.remove];
    const allPackagePaths = [...packageFiles.keys()].sort();
    const manifestPackagePath = packageFiles.has(MANIFEST_PATH) ? MANIFEST_PATH : null;
    const packagePathsBeforeManifest = allPackagePaths.filter(path => path !== MANIFEST_PATH);
    const total = backupTargets.length + allPackagePaths.length + plan.remove.length;
    let completed = 0;
    const tick = text => {
      completed += 1;
      setProgress(completed, total || 1, text);
      progress?.(text);
    };

    try {
      for (const file of backupTargets) {
        const bytes = await readFileBytes(installDirectoryHandle, file.path);
        await writeFileBytes(backup.handle, file.path, bytes);
        backupPaths.push(file.path);
        tick(`Backed up ${file.path}`);
      }

      for (const path of packagePathsBeforeManifest) {
        actualChangesStarted = true;
        if (addPathSet.has(path)) addedPaths.push(path);
        await writeFileBytes(installDirectoryHandle, path, packageFiles.get(path));
        tick(`Wrote ${path}`);
      }

      for (const file of plan.remove) {
        actualChangesStarted = true;
        await removeFilePath(installDirectoryHandle, file.path);
        tick(`Removed ${file.path}`);
      }

      if (manifestPackagePath) {
        actualChangesStarted = true;
        if (addPathSet.has(manifestPackagePath)) addedPaths.push(manifestPackagePath);
        await writeFileBytes(installDirectoryHandle, manifestPackagePath, packageFiles.get(manifestPackagePath));
        tick(`Wrote ${manifestPackagePath}`);
      }

      await cleanupBackupDirectory(installDirectoryHandle, backup.name);
      return { ok: true };
    } catch (error) {
      if (actualChangesStarted) {
        await rollbackInstall(installDirectoryHandle, backup.handle, backupPaths, addedPaths, progress);
      }
      await cleanupBackupDirectory(installDirectoryHandle, backup.name);
      return {
        ok: false,
        reason: actualChangesStarted
          ? `Install failed and rollback was attempted: ${error?.message || 'Unknown error'}`
          : `Install failed before changing files: ${error?.message || 'Unknown error'}`
      };
    }
  }

  function confirmInstall(plan, packageInspection) {
    const version = packageInspection?.package?.version || packageInspection?.latestVersion || 'unknown';
    return confirm([
      `Install Chroma v${version}?`,
      '',
      `${plan.add.length} files will be added.`,
      `${plan.overwrite.length} files will be overwritten.`,
      `${plan.remove.length} stale files will be removed.`,
      '',
      'A temporary backup will be created first and rollback will be attempted if installation fails.'
    ].join('\n'));
  }

  async function installSelectedUpdate() {
    if (!canInstallUpdate()) {
      setResult('Verify the package, build the install plan, and run the write probe before installing.', 'error');
      return { ok: false, reason: 'Install prerequisites are not complete.' };
    }
    if (!confirmInstall(latestInstallPlan, latestPackageInspection)) {
      setResult('Install canceled. No files were changed.', 'neutral');
      return { ok: false, canceled: true, reason: 'Install canceled.' };
    }

    setBusy(true);
    setStepState('updaterStepInstall', 'pending');
    setText('updaterStatusTitle', 'Installing Update');
    setText('updaterStatusDesc', 'Creating a backup, writing the verified package, and preparing rollback if needed.');
    setResult('Installing verified update package...', 'neutral');
    setProgress(0, 1, 'Starting install...');

    try {
      const granted = await ensureReadWritePermission(installDirectoryHandle);
      if (!granted) {
        throw new Error('Write permission was not granted for the selected folder.');
      }

      const expectedDownloadBytes = Number(latestPackageInspection.package?.downloadBytes || latestPackageInspection.asset?.size) || 1;
      setProgress(0, expectedDownloadBytes, 'Downloading verified package...');
      const packageFiles = await fetchVerifiedPackageFiles(latestPackageInspection, (loaded, total) => {
        setProgress(loaded, total || expectedDownloadBytes, `Downloading ${formatBytes(loaded)} / ${formatBytes(total || expectedDownloadBytes)}`);
      });
      const result = await performInstall(latestInstallPlan, packageFiles, text => setResult(text, 'neutral'));
      if (!result.ok) {
        setStepState('updaterStepInstall', 'error');
        setText('updaterStatusTitle', 'Install Rolled Back');
        setText('updaterStatusDesc', 'The updater attempted to restore the previous files after a failed install.');
        setResult(result.reason, 'error');
        return result;
      }

      installCompleted = true;
      latestInstallPlan = null;
      setReloadActionVisible(true);
      setProgress(1, 1, 'Install complete. Reload Chroma to finish.');
      setStepState('updaterStepInstall', 'ok');
      setText('updaterStatusTitle', 'Reload Needed');
      setText('updaterStatusDesc', 'Click Reload Chroma to load the updated files.');
      setResult('Update installed. Reload Chroma to finish.', 'ok');
      return { ok: true };
    } catch (error) {
      setStepState('updaterStepInstall', 'error');
      setText('updaterStatusTitle', 'Install Failed');
      setText('updaterStatusDesc', 'No further files will be changed until the issue is resolved.');
      setResult(error?.message || 'Install failed before completion.', 'error');
      return { ok: false, reason: error?.message || 'Install failed before completion.' };
    } finally {
      setBusy(false);
    }
  }

  async function runSelectedFolderProbe() {
    if (!installDirectoryHandle) {
      setResult('Choose and verify the Chroma folder first.', 'error');
      return;
    }
    setBusy(true);
    try {
      const result = await runWriteProbe(installDirectoryHandle);
      writeProbePassed = result.ok;
      setStepState('updaterStepWrite', result.ok ? 'ok' : 'error');
      if (result.ok) {
        setText('updaterStatusTitle', 'Updater Ready');
        setText('updaterStatusDesc', latestInstallPlan?.ok
          ? 'The folder and install plan are ready for a confirmed update.'
          : 'Build the install plan before installing the update.');
      }
      setResult(result.reason, result.ok ? 'ok' : 'error');
    } finally {
      setBusy(false);
    }
  }

  function reloadChroma() {
    setResult('Reloading Chroma...', 'neutral');
    if (typeof chrome.runtime?.reload === 'function') {
      chrome.runtime.reload();
      return { ok: true, method: 'runtime.reload' };
    }
    chrome.tabs?.create?.({ url: 'chrome://extensions/' });
    return { ok: true, method: 'chrome://extensions' };
  }

  function scrollToUpdatesHash() {
    if (!['#updates', '#updatesSection'].includes(globalThis.location?.hash)) return;
    const section = $('updatesSection') || $('updaterPanel');
    section?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }

  function shouldAutoInspectFromHash() {
    return ['#updates', '#updatesSection'].includes(globalThis.location?.hash);
  }

  async function restoreSavedInstallFolder() {
    const handle = await loadInstallDirectoryHandle();
    if (!handle) return;
    installDirectoryHandle = handle;
    if (!(await hasReadPermission(handle))) {
      updateVerifiedFolderState({
        ok: false,
        permissionNeeded: true,
        reason: 'Chroma remembers the selected folder, but Chrome needs folder permission again. Click Reconnect Chroma Folder.'
      });
      return;
    }
    const result = await verifyInstallDirectory(handle, chrome.runtime.getManifest());
    if (result.ok) {
      savedFolderNeedsPermission = false;
    } else if (result.permissionNeeded) {
      savedFolderNeedsPermission = true;
    }
    updateVerifiedFolderState(result);
  }

  function initUpdaterPanel() {
    if (!$('updaterPanel')) return;

    const chooseBtn = $('chooseInstallFolderBtn');
    const probeBtn = $('runFolderProbeBtn');
    const releaseBtn = $('checkLatestReleaseBtn');
    const packageBtn = $('inspectPackageBtn');
    const planBtn = $('buildInstallPlanBtn');
    const installBtn = $('installUpdateBtn');
    const reloadBtn = $('reloadChromaBtn');

    releaseBtn?.addEventListener('click', inspectLatestRelease);
    packageBtn?.addEventListener('click', inspectLatestPackage);
    planBtn?.addEventListener('click', buildSelectedInstallPlan);
    installBtn?.addEventListener('click', installSelectedUpdate);
    reloadBtn?.addEventListener('click', reloadChroma);

    if (!isFileSystemAccessSupported()) {
      setStepState('updaterStepSupport', 'error');
      setText('updaterStatusTitle', 'Folder Access Unavailable');
      setText('updaterStatusDesc', 'This browser does not expose the File System Access directory picker here.');
      setResult('Use a recent Chromium browser to test guided unpacked-extension updates.', 'error');
      setBusy(false);
      scrollToUpdatesHash();
      return;
    }

    setStepState('updaterStepSupport', 'ok');
    setResult('Choose the current Chroma install folder to prepare guided updates.', 'neutral');
    setBusy(false);

    chooseBtn?.addEventListener('click', chooseInstallFolder);
    probeBtn?.addEventListener('click', runSelectedFolderProbe);
    const updateEventTarget = typeof globalThis.addEventListener === 'function' ? globalThis : globalThis.window;
    updateEventTarget?.addEventListener?.('chroma:update-check-result', event => {
      applyPassiveUpdateCheck(event?.detail);
    });
    if (Object.prototype.hasOwnProperty.call(globalThis, 'ChromaLatestUpdateCheck')) {
      applyPassiveUpdateCheck(globalThis.ChromaLatestUpdateCheck);
    }

    scrollToUpdatesHash();
    restoreSavedInstallFolder()
      .catch(() => {})
      .finally(() => {
        if (shouldAutoInspectFromHash() && !currentVersionKnown) inspectLatestPackage();
      });
  }

  return {
    initUpdaterPanel,
    _test: {
      ensureReadWritePermission,
      readManifestFromDirectory,
      runWriteProbe,
      buildInstallPlan,
      buildSelectedInstallPlan,
      installSelectedUpdate,
      reloadChroma,
      listInstallFiles,
      inspectLatestPackage,
      validateReleaseMetadata,
      validateInstallManifest,
      verifyInstallDirectory
    }
  };
})();

globalThis.ChromaUpdaterUI = ChromaUpdaterUI;
