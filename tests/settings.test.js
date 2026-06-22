const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { JSDOM } = require('jsdom');

const domUtilsJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'dom-utils.js'), 'utf8');
const domainUtilsJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'domain-utils.js'), 'utf8');
const componentsJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'components.js'), 'utf8');
const healthUiJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'health-ui.js'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'app.js'), 'utf8');
const updaterUiJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'updater-ui.js'), 'utf8');
const proxyUiJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'proxy-ui.js'), 'utf8');
const uiCss = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ui', 'ui.css'), 'utf8');

async function settleDomAsyncWork(turns = 20) {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

async function settleDomTimerWork(turns = 5) {
  for (let i = 0; i < turns; i++) {
    await settleDomAsyncWork(20);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function countMessages(messages, type) {
  return messages.filter(message => message.type === type).length;
}

function assertNextUpdaterAction(doc, expectedId) {
  const buttonIds = [
    'checkLatestReleaseBtn',
    'chooseInstallFolderBtn',
    'inspectPackageBtn',
    'buildInstallPlanBtn',
    'runFolderProbeBtn',
    'installUpdateBtn',
    'reloadChromaBtn'
  ];
  const stepByButtonId = {
    chooseInstallFolderBtn: 'updaterStepFolder',
    inspectPackageBtn: 'updaterStepPackage',
    buildInstallPlanBtn: 'updaterStepPlan',
    runFolderProbeBtn: 'updaterStepWrite',
    installUpdateBtn: 'updaterStepInstall',
    reloadChromaBtn: 'updaterStepInstall'
  };
  const expectedStepId = expectedId ? stepByButtonId[expectedId] : null;

  buttonIds.forEach(buttonId => {
    const button = doc.querySelector(`#${buttonId}`);
    if (!button) return;
    const isExpected = buttonId === expectedId;
    assert.strictEqual(button.classList.contains('updater-action--next'), isExpected, `${buttonId} next-action state`);
    assert.strictEqual(button.getAttribute('aria-current'), isExpected ? 'step' : null, `${buttonId} aria-current`);
  });

  [...new Set(Object.values(stepByButtonId))].forEach(stepId => {
    const step = doc.querySelector(`#${stepId}`);
    if (!step) return;
    assert.strictEqual(step.classList.contains('updater-step--next'), stepId === expectedStepId, `${stepId} next-step state`);
  });
}
const CRC_TABLE = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0 ^ -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content || '');
    const method = entry.method ?? 8;
    const compressed = method === 0 ? data : zlib.deflateRawSync(data);
    const entryCrc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(entryCrc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(entryCrc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function exactArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function tamperFirstCentralDirectorySizes(buffer, { compressedSize, uncompressedSize }) {
  const out = Buffer.from(buffer);
  const centralOffset = out.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  if (centralOffset === -1) throw new Error('central directory not found');
  if (compressedSize !== undefined) out.writeUInt32LE(compressedSize, centralOffset + 20);
  if (uncompressedSize !== undefined) out.writeUInt32LE(uncompressedSize, centralOffset + 24);
  return out;
}

function createStreamingZipResponse(buffer, { chunkSize = 1024, onRead = () => {} } = {}) {
  let offset = 0;
  return {
    ok: true,
    headers: { get: name => (String(name).toLowerCase() === 'content-length' ? String(buffer.byteLength) : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (offset >= buffer.byteLength) return { done: true };
          const end = Math.min(buffer.byteLength, offset + chunkSize);
          const value = new Uint8Array(buffer.subarray(offset, end));
          offset = end;
          onRead(value.byteLength);
          return { done: false, value };
        },
        releaseLock: () => {}
      })
    },
    arrayBuffer: async () => {
      throw new Error('streaming response should not use arrayBuffer fallback');
    }
  };
}

function createSavedHandleIndexedDb(savedHandle) {
  let storedHandle = savedHandle;
  return {
    open: () => {
      const openRequest = {};
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => {},
        transaction: (_storeName, mode) => {
          const tx = {
            objectStore: () => ({
              get: () => {
                const getRequest = {};
                setTimeout(() => {
                  getRequest.result = storedHandle;
                  getRequest.onsuccess?.();
                  tx.oncomplete?.();
                }, 0);
                return getRequest;
              },
              put: value => {
                storedHandle = value;
                if (mode === 'readwrite') {
                  setTimeout(() => tx.oncomplete?.(), 0);
                }
              }
            }),
            oncomplete: null,
            onerror: null
          };
          return tx;
        },
        close: () => {}
      };

      setTimeout(() => {
        openRequest.result = db;
        openRequest.onsuccess?.();
      }, 0);
      return openRequest;
    }
  };
}

async function sha256Hex(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? exactArrayBuffer(buffer) : buffer;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function createSettingsHarness({
  url = 'chrome-extension://test/ui/settings.html',
  responses = {},
  pending = {},
  fetch = async () => ({ ok: false }),
  confirm = () => true
} = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="appShell"></div></body>', {
    url,
    runScripts: 'outside-only'
  });
  const messages = [];
  const tabsCreated = [];
  const reloadCalls = [];
  const storageChangeListeners = [];
  const storageState = {};
  const defaultStats = {
    settings: { mode: 'aggregated', retentionDays: 90 },
    totals: { protectionEvents: 42, networkBlocks: 7, cosmeticHides: 2, youtubePayloadCleans: 1, scriptletHits: 3 },
    ranges: {
      today: { protectionEvents: 1 },
      last7Days: { protectionEvents: 7 },
      last30Days: { protectionEvents: 30 },
      allTime: { protectionEvents: 42 }
    },
    bySite: { example: { domain: 'example.com', protectionEvents: 4, lastSeen: Date.now() } },
    byRule: { r1: { ruleId: 1, networkBlocks: 4, ruleSource: 'test' } },
    byDay: { today: { day: '2026-05-12', protectionEvents: 4 } },
    recentEvents: [{ layer: 'network', type: 'block', domain: 'example.com', count: 2 }],
    timeSavedSeconds: 12
  };
  const defaultHealth = {
    overall: { status: 'healthy', issues: [] },
    manifest: { version: '1.0.1', minimumChromeVersion: '120' },
    master: { enabled: true, networkBlocking: true, trackingUrlCleanup: true },
    dnr: { enabledStaticRulesets: ['a'], expectedStaticRulesets: ['a'], staticRulesetsOk: true, appliedNetworkRuleCount: 12, whitelistRuleCount: 0, trackingUrlCleanupRuleCount: 1, trackingUrlCleanupActive: true },
    subscriptions: { enabled: 1, total: 1, appliedNetwork: 12, cosmetic: 4, scriptlet: 2, withErrors: 0 },
    scriptlets: { apiAvailable: true, registeredUserScriptCount: 2, storedRuleCount: 2 },
    fpr: { enabled: true, active: true, protectedSurfaces: ['Canvas', 'WebGL', 'Audio', 'Navigator', 'Language APIs'] },
    cosmetic: { subscriptionCosmeticRuleCount: 4, enabledLocalZapperRuleCount: 0, localZapperRuleCount: 0 },
    proxy: { configuredCount: 0, acceptedCount: 0, routedDomainCount: 0, globalProxyEnabled: false, globalProxyConfigured: false },
    webrtc: { available: true, mode: 'auto', protected: true },
    requestLog: { available: true, entryCount: 0, maxEntries: 200, note: '' }
  };

  const sandbox = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    console,
    confirm,
    setTimeout,
    clearTimeout,
    Blob: globalThis.Blob || dom.window.Blob,
    Response: globalThis.Response,
    DecompressionStream: globalThis.DecompressionStream,
    TextDecoder,
    TextEncoder,
    DataView,
    Uint8Array,
    ArrayBuffer,
    crypto: globalThis.crypto,
    fetch,
    URL: dom.window.URL,
    MSG: {
      CONFIG_GET: 'CONFIG_GET',
      CONFIG_SET: 'CONFIG_SET',
      UPDATE_CHECK: 'UPDATE_CHECK',
      UPDATE_PACKAGE_INSPECT: 'UPDATE_PACKAGE_INSPECT',
      STATS_GET: 'STATS_GET',
      STATS_RESET: 'STATS_RESET',
      STATS_EXPORT: 'STATS_EXPORT',
      STATS_SETTINGS_SET: 'STATS_SETTINGS_SET',
      HEALTH_GET: 'HEALTH_GET',
      PROXY_CONFIG_GET: 'PROXY_CONFIG_GET',
      PROXY_CONFIG_SET: 'PROXY_CONFIG_SET',
      PROXY_TEST: 'PROXY_TEST',
      SUBSCRIPTION_GET: 'SUBSCRIPTION_GET',
      SUBSCRIPTION_SET: 'SUBSCRIPTION_SET',
      SUBSCRIPTION_REFRESH: 'SUBSCRIPTION_REFRESH',
      SUBSCRIPTION_REMOVE: 'SUBSCRIPTION_REMOVE',
      SUBSCRIPTION_ADD: 'SUBSCRIPTION_ADD',
      USER_SCRIPTLETS_GET: 'USER_SCRIPTLETS_GET',
      USER_SCRIPTLET_SOURCE_ADD: 'USER_SCRIPTLET_SOURCE_ADD',
      USER_SCRIPTLET_SOURCE_REFRESH: 'USER_SCRIPTLET_SOURCE_REFRESH',
      USER_SCRIPTLET_SOURCE_REMOVE: 'USER_SCRIPTLET_SOURCE_REMOVE',
      USER_SCRIPTLET_RULES_SET: 'USER_SCRIPTLET_RULES_SET',
      ZAPPER_RULES_GET: 'ZAPPER_RULES_GET',
      ZAPPER_RULE_SET: 'ZAPPER_RULE_SET',
      ZAPPER_RULE_REMOVE: 'ZAPPER_RULE_REMOVE',
      ZAPPER_START: 'ZAPPER_START',
      WHITELIST_GET: 'WHITELIST_GET',
      WHITELIST_ADD: 'WHITELIST_ADD',
      WHITELIST_REMOVE: 'WHITELIST_REMOVE',
      FPR_WHITELIST_GET: 'FPR_WHITELIST_GET',
      FPR_WHITELIST_ADD: 'FPR_WHITELIST_ADD',
      FPR_WHITELIST_REMOVE: 'FPR_WHITELIST_REMOVE',
      LOG_GET: 'LOG_GET'
    },
    chrome: {
      runtime: {
        getManifest: () => ({ name: 'Chroma Ad-Blocker', version: '1.0.1' }),
        getURL: path => `chrome-extension://test/${path}`,
        openOptionsPage: () => {},
        reload: () => reloadCalls.push(Date.now())
      },
      storage: {
        local: {
          get: async keys => {
            if (typeof keys === 'string') return { [keys]: storageState[keys] };
            if (Array.isArray(keys)) {
              const result = {};
              keys.forEach(key => { result[key] = storageState[key]; });
              return result;
            }
            return storageState;
          },
          set: async value => Object.assign(storageState, value)
        },
        onChanged: {
          addListener: listener => {
            storageChangeListeners.push(listener);
          }
        }
      },
      tabs: {
        query: async () => [{ id: 7, url: 'https://www.example.com/watch' }],
        create: async info => {
          tabsCreated.push(info);
          return { id: tabsCreated.length, ...info };
        },
        reload: () => {}
      }
    },
    notifyBackground: msg => {
      messages.push(msg);
      if (pending[msg.type]) return pending[msg.type].promise;
      if (Object.prototype.hasOwnProperty.call(responses, msg.type)) {
        const value = responses[msg.type];
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
      }
      if (msg.type === 'CONFIG_GET') return Promise.resolve({ enabled: true, acceleration: false, cosmetic: true });
      if (msg.type === 'UPDATE_CHECK') return Promise.resolve(null);
      if (msg.type === 'UPDATE_PACKAGE_INSPECT') return Promise.resolve({ ok: true, updateAvailable: false });
      if (msg.type === 'STATS_GET') return Promise.resolve(defaultStats);
      if (msg.type === 'HEALTH_GET') return Promise.resolve(defaultHealth);
      if (msg.type === 'SUBSCRIPTION_GET') return Promise.resolve([]);
      if (msg.type === 'USER_SCRIPTLETS_GET') return Promise.resolve({
        sources: [],
        ruleText: '',
        parsedRuleCount: 0,
        availableResourceNames: []
      });
      if (msg.type === 'PROXY_CONFIG_GET') return Promise.resolve([]);
      if (msg.type === 'ZAPPER_RULES_GET') return Promise.resolve({ rules: [] });
      if (msg.type === 'WHITELIST_GET') return Promise.resolve({ whitelist: [] });
      if (msg.type === 'FPR_WHITELIST_GET') return Promise.resolve({ fprWhitelist: [] });
      if (msg.type === 'LOG_GET') return Promise.resolve([]);
      return Promise.resolve({ ok: true });
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext([domUtilsJs, domainUtilsJs, componentsJs, healthUiJs, appJs, updaterUiJs, proxyUiJs].join('\n'), sandbox);
  async function emitStorageChange(changes, area = 'local') {
    storageChangeListeners.forEach(listener => listener(changes, area));
    await settleDomAsyncWork();
  }
  return {
    dom,
    sandbox,
    messages,
    tabsCreated,
    reloadCalls,
    pending,
    emitStorageChange,
    getStorageChangeListenerCount: () => storageChangeListeners.length
  };
}

function createMockInstallDirectory(manifest, { files = [], failWritesFor = [] } = {}) {
  const writes = [];
  const removals = [];
  const failWriteSet = new Set(failWritesFor);

  function normalizeBytes(value = '') {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (Buffer.isBuffer(value)) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return new TextEncoder().encode(String(value));
  }

  function bytesToText(bytes) {
    return new TextDecoder().decode(bytes);
  }

  function createFileHandle(pathName, content = '') {
    let bytes = normalizeBytes(content);
    return {
      kind: 'file',
      _path: pathName,
      _getBytes: () => new Uint8Array(bytes),
      _setBytes: next => {
        bytes = normalizeBytes(next);
      },
      getFile: async () => ({
        size: bytes.byteLength,
        text: async () => bytesToText(bytes),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      }),
      createWritable: async () => {
        const chunks = [];
        return {
          write: async value => chunks.push(normalizeBytes(value)),
          close: async () => {
            if (failWriteSet.has(pathName)) throw new Error(`write failed: ${pathName}`);
            const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
            const out = new Uint8Array(total);
            let offset = 0;
            chunks.forEach(chunk => {
              out.set(chunk, offset);
              offset += chunk.byteLength;
            });
            bytes = out;
            writes.push({ path: pathName, bytes: new Uint8Array(bytes) });
          }
        };
      }
    };
  }

  function createDirectoryHandle(prefix = '') {
    const children = new Map();
    return {
      kind: 'directory',
      _prefix: prefix,
      _children: children,
      entries: async function* () {
        for (const entry of children.entries()) yield entry;
      },
      getFileHandle: async function(name, options = {}) {
        const child = children.get(name);
        if (child?.kind === 'file') return child;
        if (!child && options.create) {
          const pathName = prefix ? `${prefix}/${name}` : name;
          const file = createFileHandle(pathName, '');
          children.set(name, file);
          return file;
        }
        const error = new Error(`${name} not found`);
        error.name = 'NotFoundError';
        throw error;
      },
      getDirectoryHandle: async function(name, options = {}) {
        const child = children.get(name);
        if (child?.kind === 'directory') return child;
        if (!child && options.create) {
          const pathName = prefix ? `${prefix}/${name}` : name;
          const directory = createDirectoryHandle(pathName);
          children.set(name, directory);
          return directory;
        }
        const error = new Error(`${name} not found`);
        error.name = 'NotFoundError';
        throw error;
      },
      removeEntry: async function(name) {
        if (!children.has(name)) {
          const error = new Error(`${name} not found`);
          error.name = 'NotFoundError';
          throw error;
        }
        children.delete(name);
        removals.push(prefix ? `${prefix}/${name}` : name);
      }
    };
  }

  const root = createDirectoryHandle();

  function addFile(pathName, content = '') {
    const parts = pathName.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node._children.has(part)) {
        const prefix = node._prefix ? `${node._prefix}/${part}` : part;
        node._children.set(part, createDirectoryHandle(prefix));
      }
      node = node._children.get(part);
    }
    node._children.set(parts[parts.length - 1], createFileHandle(pathName, content));
  }

  addFile('manifest.json', JSON.stringify(manifest));
  files.forEach(file => addFile(file.path, file.content ?? 'x'.repeat(file.size || 0)));

  function getNode(pathName) {
    const parts = pathName.split('/').filter(Boolean);
    let node = root;
    for (const part of parts) {
      node = node?._children?.get(part);
      if (!node) return null;
    }
    return node;
  }

  const directory = {
    ...root,
    queryPermission: async () => 'prompt',
    requestPermission: async () => 'granted',
    _readText: pathName => {
      const node = getNode(pathName);
      return node?.kind === 'file' ? bytesToText(node._getBytes()) : null;
    },
    _readBytes: pathName => {
      const node = getNode(pathName);
      return node?.kind === 'file' ? node._getBytes() : null;
    },
    _exists: pathName => !!getNode(pathName),
    _writes: writes,
    _removals: removals
  };
  return directory;
}

test('settings page proxy and zapper management safety', async (t) => {
  await t.test('updater panel reports unsupported folder access', async () => {
    const harness = createSettingsHarness();

    await harness.sandbox.ChromaApp.initSharedUI();
    harness.sandbox.ChromaUpdaterUI.initUpdaterPanel();
    await settleDomAsyncWork();

    const doc = harness.dom.window.document;
    assert.ok(doc.querySelector('#updaterPanel'));
    assert.strictEqual(doc.querySelector('#checkLatestReleaseBtn').disabled, false);
    assert.strictEqual(doc.querySelector('#inspectPackageBtn').disabled, false);
    assert.strictEqual(doc.querySelector('#buildInstallPlanBtn').disabled, true);
    assert.strictEqual(doc.querySelector('#chooseInstallFolderBtn').disabled, true);
    assert.strictEqual(doc.querySelector('#runFolderProbeBtn').disabled, true);
    assert.strictEqual(doc.querySelector('#installUpdateBtn').disabled, true);
    assert.ok(doc.querySelector('#updaterStepSupport').classList.contains('updater-step--error'));
    assert.match(doc.querySelector('#updaterStatusTitle').textContent, /Folder Access Unavailable/);
    assert.match(doc.querySelector('#updaterResult').textContent, /recent Chromium browser/i);
  });

  await t.test('updater verifies direct latest release ZIP metadata', async () => {
    const harness = createSettingsHarness({
      responses: {
        UPDATE_CHECK: {
          updateAvailable: true,
          latestVersion: '1.0.2',
          release: { version: '1.0.2', tagName: 'v1.0.2' },
          asset: {
            name: 'chroma-ad-blocker-v1.0.2.zip',
            downloadUrl: 'https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/v1.0.2/chroma-ad-blocker-v1.0.2.zip',
            size: 153600,
            contentType: 'application/zip',
            updatedAt: '2026-06-20T00:00:00Z'
          },
          assetStatus: 'found',
          updateManifestAsset: {
            name: 'updates.json',
            downloadUrl: 'https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/v1.0.2/updates.json',
            size: 160,
            contentType: 'application/json',
            updatedAt: '2026-06-20T00:00:00Z'
          },
          updateManifestStatus: 'found'
        }
      }
    });

    await harness.sandbox.ChromaApp.initSharedUI();
    harness.sandbox.ChromaUpdaterUI.initUpdaterPanel();
    await settleDomAsyncWork();

    const doc = harness.dom.window.document;
    doc.querySelector('#checkLatestReleaseBtn').click();
    await settleDomAsyncWork(60);

    const forcedChecks = harness.messages.filter(message => (
      message.type === 'UPDATE_CHECK' && message.options?.force === true
    ));
    assert.strictEqual(forcedChecks.length, 1);
    assert.ok(doc.querySelector('#updaterStepRelease').classList.contains('updater-step--ok'));
    assert.match(doc.querySelector('#updaterStatusTitle').textContent, /Release v1\.0\.2 Ready/);
    assert.match(doc.querySelector('#updaterResult').textContent, /Release ZIP and updates\.json found: chroma-ad-blocker-v1\.0\.2\.zip/);
  });

  await t.test('updater shows a settled current-version state when no update is available', async () => {
    const harness = createSettingsHarness({
      responses: {
        UPDATE_CHECK: { updateAvailable: false }
      }
    });
    const directory = createMockInstallDirectory({
      manifest_version: 3,
      name: 'Chroma Ad-Blocker',
      version: '1.0.1'
    });
    harness.sandbox.showDirectoryPicker = async () => directory;

    await harness.sandbox.ChromaApp.initSharedUI();
    harness.sandbox.ChromaUpdaterUI.initUpdaterPanel();
    await settleDomAsyncWork(80);

    const doc = harness.dom.window.document;
    assert.ok(doc.querySelector('#updaterPanel').classList.contains('updater-panel--current'));
    assertNextUpdaterAction(doc, null);
    assert.match(doc.querySelector('#updaterStatusTitle').textContent, /Chroma Is Current/);
    assert.match(doc.querySelector('#updaterStatusDesc').textContent, /No update is available/);
    assert.strictEqual(doc.querySelector('#updaterResult').textContent, 'No newer release found. This install is already on v1.0.1');

    doc.querySelector('#chooseInstallFolderBtn').click();
    await settleDomAsyncWork(60);

    assert.ok(doc.querySelector('#updaterPanel').classList.contains('updater-panel--current'));
    assertNextUpdaterAction(doc, null);
    assert.ok(doc.querySelector('#updaterStepFolder').classList.contains('updater-step--ok'));
    assert.match(doc.querySelector('#updaterStatusTitle').textContent, /Chroma Is Current/);
    assert.match(doc.querySelector('#updaterStatusDesc').textContent, /install folder is verified/i);
    assert.strictEqual(doc.querySelector('#updaterResult').textContent, 'No newer release found. Chroma is already on v1.0.1');

    harness.dom.window.dispatchEvent(new harness.dom.window.CustomEvent('chroma:update-check-result', {
      detail: { updateAvailable: true, latestVersion: '1.0.2' }
    }));
    await settleDomAsyncWork(20);

    assert.strictEqual(doc.querySelector('#updaterPanel').classList.contains('updater-panel--current'), false);
    assertNextUpdaterAction(doc, 'inspectPackageBtn');
  });

  await t.test('updater keeps current-version layout while a forced update check is pending', async () => {
    const harness = createSettingsHarness({
      responses: {
        UPDATE_CHECK: { updateAvailable: false }
      }
    });
    harness.sandbox.showDirectoryPicker = async () => createMockInstallDirectory({
      manifest_version: 3,
      name: 'Chroma Ad-Blocker',
      version: '1.0.1'
    });
    await harness.sandbox.ChromaApp.initSharedUI();
    harness.sandbox.ChromaUpdaterUI.initUpdaterPanel();
    await settleDomAsyncWork(80);

    const doc = harness.dom.window.document;
    assert.ok(doc.querySelector('#updaterPanel').classList.contains('updater-panel--current'));

    const forcedCheck = deferred();
    harness.sandbox.notifyBackground = msg => {
      harness.messages.push(msg);
      if (msg.type === 'UPDATE_CHECK' && msg.options?.force === true) return forcedCheck.promise;
      return Promise.resolve(null);
    };

    doc.querySelector('#checkLatestReleaseBtn').click();
    await settleDomAsyncWork(20);

    assert.ok(doc.querySelector('#updaterPanel').classList.contains('updater-panel--current'));
    assertNextUpdaterAction(doc, null);
    assert.match(doc.querySelector('#updaterStatusTitle').textContent, /Checking Latest Release/);

    forcedCheck.resolve({ updateAvailable: false });
    await settleDomAsyncWork(60);

    assert.ok(doc.querySelector('#updaterPanel').classList.contains('updater-panel--current'));
    assertNextUpdaterAction(doc, null);
    assert.match(doc.querySelector('#updaterStatusTitle').textContent, /Chroma Is Current/);
  });

  await t.test('updater current-version hash entry does not auto-inspect the package', async () => {
    const harness = createSettingsHarness({
      url: 'chrome-extension://test/ui/settings.html#updatesSection',
      responses: {
        UPDATE_CHECK: { updateAvailable: false }
      }
    });
    harness.sandbox.showDirectoryPicker = async () => createMockInstallDirectory({
      manifest_version: 3,
      name: 'Chroma Ad-Blocker',
      version: '1.0.1'
    });

    await harness.sandbox.ChromaApp.initSharedUI();
    harness.sandbox.ChromaUpdaterUI.initUpdaterPanel();
    await settleDomAsyncWork(120);

    const packageChecks = harness.messages.filter(message => message.type === 'UPDATE_PACKAGE_INSPECT');
    const doc = harness.dom.window.document;
    assert.strictEqual(packageChecks.length, 0);
    assert.ok(doc.querySelector('#updaterPanel').classList.contains('updater-panel--current'));
    assertNextUpdaterAction(doc, null);
  });

  await t.test('updater rejects latest release metadata without expected ZIP asset', async () => {
    const harness = createSettingsHarness({
      responses: {
        UPDATE_CHECK: {
          updateAvailable: true,
          latestVersion: '1.0.2',
          release: { version: '1.0.2', tagName: 'v1.0.2' },
          asset: null,
          assetStatus: 'missing'
        }
      }
    });

    await harness.sandbox.ChromaApp.initSharedUI();
    harness.sandbox.ChromaUpdaterUI.initUpdaterPanel();
    await settleDomAsyncWork();

    const doc = harness.dom.window.document;
    doc.querySelector('#checkLatestReleaseBtn').click();
    await settleDomAsyncWork(60);

    assert.ok(doc.querySelector('#updaterStepRelease').classList.contains('updater-step--error'));
    assert.match(doc.querySelector('#updaterStatusTitle').textContent, /Release Assets Not Verified/);
    assert.match(doc.querySelector('#updaterResult').textContent, /missing chroma-ad-blocker-v1\.0\.2\.zip/i);
  });

  await t.test('updater inspects latest package ZIP without writing files', async () => {
    const harness = createSettingsHarness({
      responses: {
        UPDATE_PACKAGE_INSPECT: {
          ok: true,
          updateAvailable: true,
          latestVersion: '1.0.2',
          asset: { name: 'chroma-ad-blocker-v1.0.2.zip' },
          package: {
            version: '1.0.2',
            entryCount: 42,
            requiredEntryCount: 20,
            totalUncompressedBytes: 204800,
            downloadBytes: 65536,
            sha256: 'abc123'
          },
          reason: 'Release ZIP inspected.'
        }
      }
    });

    await harness.sandbox.ChromaApp.initSharedUI();
    harness.sandbox.ChromaUpdaterUI.initUpdaterPanel();
    await settleDomAsyncWork();

    const doc = harness.dom.window.document;
    doc.querySelector('#inspectPackageBtn').click();
    await settleDomAsyncWork(60);

    const packageChecks = harness.messages.filter(message => (
      message.type === 'UPDATE_PACKAGE_INSPECT' && message.options?.force === true
    ));
    assert.strictEqual(packageChecks.length, 1);
    assert.ok(doc.querySelector('#updaterStepRelease').classList.contains('updater-step--ok'));
    assert.ok(doc.querySelector('#updaterStepPackage').classList.contains('updater-step--ok'));
    assert.match(doc.querySelector('#updaterStatusTitle').textContent, /Package v1\.0\.2 Verified/);
    assert.match(doc.querySelector('#updaterResult').textContent, /42 files, 64\.0 KB/);
  });

  await t.test('updater hash handoff automatically inspects the package ZIP', async () => {
    const harness = createSettingsHarness({
      url: 'chrome-extension://test/ui/settings.html#updatesSection',
      responses: {
        UPDATE_PACKAGE_INSPECT: {
          ok: true,
          updateAvailable: true,
          latestVersion: '1.0.2',
          asset: { name: 'chroma-ad-blocker-v1.0.2.zip' },
          package: {
            version: '1.0.2',
            entryCount: 12,
            downloadBytes: 8192,
            files: [{ path: 'manifest.json', size: 120 }]
          },
          reason: 'Release ZIP inspected.'
        }
      }
    });
    harness.sandbox.showDirectoryPicker = async () => createMockInstallDirectory({
      manifest_version: 3,
      name: 'Chroma Ad-Blocker',
      version: '1.0.1'
    });

    await harness.sandbox.ChromaApp.initSharedUI();
    harness.sandbox.ChromaUpdaterUI.initUpdaterPanel();
    await settleDomAsyncWork(120);

    const packageChecks = harness.messages.filter(message => (
      message.type === 'UPDATE_PACKAGE_INSPECT' && message.options?.force === true
    ));
    const doc = harness.dom.window.document;
    assert.strictEqual(packageChecks.length, 1);
    assert.ok(doc.querySelector('#updaterStepPackage').classList.contains('updater-step--ok'));
    assert.match(doc.querySelector('#updaterStatusTitle').textContent, /Package v1\.0\.2 Verified/);
    assert.match(doc.querySelector('#updaterResult').textContent, /12 files, 8\.0 KB/);
  });

  await t.test('updater reports package ZIP inspection failures', async () => {
    const harness = createSettingsHarness({
      responses: {
        UPDATE_PACKAGE_INSPECT: {
          ok: false,
          updateAvailable: true,
          latestVersion: '1.0.2',
          code: 'missing_manifest_files',
          reason: 'Release ZIP is missing manifest-referenced file: background/background.js.'
        }
      }
    });

    await harness.sandbox.ChromaApp.initSharedUI();
    harness.sandbox.ChromaUpdaterUI.initUpdaterPanel();
    await settleDomAsyncWork();

    const doc = harness.dom.window.document;
    doc.querySelector('#inspectPackageBtn').click();
    await settleDomAsyncWork(60);

    assert.ok(doc.querySelector('#updaterStepPackage').classList.contains('updater-step--error'));
    assert.match(doc.querySelector('#updaterStatusTitle').textContent, /Package ZIP Not Verified/);
    assert.match(doc.querySelector('#updaterResult').textContent, /missing manifest-referenced file/i);
  });

  await t.test('updater builds a dry-run install plan from package and folder files', async () => {
    const harness = createSettingsHarness({
      responses: {
        UPDATE_PACKAGE_INSPECT: {
          ok: true,
          updateAvailable: true,
          latestVersion: '1.0.2',
          package: {
            version: '1.0.2',
            entryCount: 4,
            downloadBytes: 4096,
            files: [
              { path: 'manifest.json', size: 120 },
              { path: 'background/background.js', size: 30 },
              { path: 'ui/popup.html', size: 20 },
              { path: 'docs/README.md', size: 10 }
            ]
          }
        }
      }
    });
    const directory = createMockInstallDirectory(
      { manifest_version: 3, name: 'Chroma Ad-Blocker', version: '1.0.1' },
      {
        files: [
          { path: 'background/background.js', size: 25 },
          { path: 'ui/old.html', size: 5 },
          { path: 'icons/icon16.png', size: 3 },
          { path: '.DS_Store', size: 2 }
        ]
      }
    );
    harness.sandbox.showDirectoryPicker = async () => directory;

    await harness.sandbox.ChromaApp.initSharedUI();
    harness.sandbox.ChromaUpdaterUI.initUpdaterPanel();
    await settleDomAsyncWork();

    const doc = harness.dom.window.document;
    assert.strictEqual(doc.querySelector('#buildInstallPlanBtn').disabled, true);

    doc.querySelector('#chooseInstallFolderBtn').click();
    await settleDomAsyncWork(60);
    assert.strictEqual(doc.querySelector('#buildInstallPlanBtn').disabled, false);

    doc.querySelector('#buildInstallPlanBtn').click();
    await settleDomAsyncWork(80);

    assert.ok(doc.querySelector('#updaterStepPlan').classList.contains('updater-step--ok'));
    assert.match(doc.querySelector('#updaterStatusTitle').textContent, /Install Plan for v1\.0\.2/);
    assert.strictEqual(doc.querySelector('#updaterPlanSummary').hidden, false);
    assert.strictEqual(doc.querySelector('#updaterPlanAddCount').textContent, '2');
    assert.strictEqual(doc.querySelector('#updaterPlanOverwriteCount').textContent, '2');
    assert.strictEqual(doc.querySelector('#updaterPlanRemoveCount').textContent, '2');
    assert.strictEqual(doc.querySelector('#updaterPlanIgnoreCount').textContent, '1');
    assert.match(doc.querySelector('#updaterPlanPreview').textContent, /docs\/README\.md/);
    assert.match(doc.querySelector('#updaterPlanPreview').textContent, /ui\/old\.html/);
    assert.match(doc.querySelector('#updaterResult').textContent, /2 add, 2 overwrite, 2 remove/);
    assert.deepStrictEqual(directory._writes, []);
    assert.deepStrictEqual(directory._removals, []);
  });

  await t.test('updater ignores generated metadata and leftover backup folders during planning', async () => {
    const harness = createSettingsHarness();
    const directory = createMockInstallDirectory(
      { manifest_version: 3, name: 'Chroma Ad-Blocker', version: '1.0.1' },
      {
        files: [
          { path: 'background/background.js', content: 'old background' },
          { path: '_metadata/generated_indexed_rulesets/rules.json', content: '{}' },
          { path: '.chroma-update-backup-20260620010101-old/manifest.json', content: '{"version":"1.0.0"}' }
        ]
      }
    );

    await harness.sandbox.ChromaApp.initSharedUI();
    harness.sandbox.ChromaUpdaterUI.initUpdaterPanel();
    await settleDomAsyncWork();

    const files = await harness.sandbox.ChromaUpdaterUI._test.listInstallFiles(directory);
    assert.deepStrictEqual(Array.from(files).map(file => file.path), [
      'background/background.js',
      'manifest.json'
    ]);
  });

  await t.test('updater cancellation prevents confirmed install writes', async () => {
    const zipEntries = [
      { name: 'manifest.json', content: '{"version":"1.0.2"}' },
      { name: 'background/background.js', content: 'new background' }
    ];
    const zip = makeZip(zipEntries);
    const packageFiles = zipEntries.map(entry => ({
      path: entry.name,
      size: Buffer.byteLength(entry.content)
    }));
    const hash = await sha256Hex(zip);
    const harness = createSettingsHarness({
      confirm: () => false,
      fetch: async () => {
        throw new Error('fetch should not run after cancel');
      },
      responses: {
        UPDATE_PACKAGE_INSPECT: {
          ok: true,
          updateAvailable: true,
          latestVersion: '1.0.2',
          asset: {
            name: 'chroma-ad-blocker-v1.0.2.zip',
            downloadUrl: 'https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/v1.0.2/chroma-ad-blocker-v1.0.2.zip'
          },
          package: {
            version: '1.0.2',
            entryCount: packageFiles.length,
            downloadBytes: zip.byteLength,
            sha256: hash,
            verifiedBy: 'signed-updates.json',
            files: packageFiles
          }
        }
      }
    });
    const directory = createMockInstallDirectory(
      { manifest_version: 3, name: 'Chroma Ad-Blocker', version: '1.0.1' },
      { files: [{ path: 'background/background.js', content: 'old background' }] }
    );
    harness.sandbox.showDirectoryPicker = async () => directory;

    await harness.sandbox.ChromaApp.initSharedUI();
    harness.sandbox.ChromaUpdaterUI.initUpdaterPanel();
    await settleDomAsyncWork();

    const doc = harness.dom.window.document;
    doc.querySelector('#chooseInstallFolderBtn').click();
    await settleDomAsyncWork(60);
    doc.querySelector('#buildInstallPlanBtn').click();
    await settleDomAsyncWork(80);
    doc.querySelector('#runFolderProbeBtn').click();
    await settleDomAsyncWork(60);

    assert.strictEqual(doc.querySelector('#installUpdateBtn').disabled, false);
    const writesBefore = directory._writes.length;
    doc.querySelector('#installUpdateBtn').click();
    await settleDomAsyncWork(80);

    assert.strictEqual(directory._readText('background/background.js'), 'old background');
    assert.strictEqual(directory._writes.length, writesBefore);
    assert.match(doc.querySelector('#updaterResult').textContent, /Install canceled/);
  });

  await t.test('updater installs verified package with backup cleanup and refresh prompt', async () => {
    const zipEntries = [
      { name: 'manifest.json', content: JSON.stringify({ manifest_version: 3, name: 'Chroma Ad-Blocker', version: '1.0.2' }), method: 0 },
      { name: 'background/background.js', content: 'new background', method: 0 },
      { name: 'ui/popup.html', content: '<!doctype html>new', method: 0 }
    ];
    const zip = makeZip(zipEntries);
    const packageFiles = zipEntries.map(entry => ({
      path: entry.name,
      size: Buffer.byteLength(entry.content)
    }));
    const hash = await sha256Hex(zip);
    let streamedBytes = 0;
    const harness = createSettingsHarness({
      fetch: async () => createStreamingZipResponse(zip, {
        chunkSize: Math.max(1, Math.floor(zip.byteLength / 3)),
        onRead: bytes => { streamedBytes += bytes; }
      }),
      responses: {
        UPDATE_PACKAGE_INSPECT: {
          ok: true,
          updateAvailable: true,
          latestVersion: '1.0.2',
          asset: {
            name: 'chroma-ad-blocker-v1.0.2.zip',
            downloadUrl: 'https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/v1.0.2/chroma-ad-blocker-v1.0.2.zip'
          },
          package: {
            version: '1.0.2',
            entryCount: packageFiles.length,
            downloadBytes: zip.byteLength,
            sha256: hash,
            verifiedBy: 'signed-updates.json',
            files: packageFiles
          }
        }
      }
    });
    const directory = createMockInstallDirectory(
      { manifest_version: 3, name: 'Chroma Ad-Blocker', version: '1.0.1' },
      {
        files: [
          { path: 'background/background.js', content: 'old background' },
          { path: 'stale/old.js', content: 'stale' }
        ]
      }
    );
    harness.sandbox.showDirectoryPicker = async () => directory;

    await harness.sandbox.ChromaApp.initSharedUI();
    harness.sandbox.ChromaUpdaterUI.initUpdaterPanel();
    await settleDomAsyncWork();

    const doc = harness.dom.window.document;
    assertNextUpdaterAction(doc, 'chooseInstallFolderBtn');
    doc.querySelector('#chooseInstallFolderBtn').click();
    await settleDomAsyncWork(60);
    assertNextUpdaterAction(doc, 'inspectPackageBtn');
    doc.querySelector('#inspectPackageBtn').click();
    await settleDomAsyncWork(80);
    assertNextUpdaterAction(doc, 'buildInstallPlanBtn');
    doc.querySelector('#buildInstallPlanBtn').click();
    await settleDomAsyncWork(80);
    assertNextUpdaterAction(doc, 'runFolderProbeBtn');
    doc.querySelector('#runFolderProbeBtn').click();
    await settleDomAsyncWork(60);
    assertNextUpdaterAction(doc, 'installUpdateBtn');
    doc.querySelector('#installUpdateBtn').click();
    await settleDomTimerWork(8);
    assertNextUpdaterAction(doc, 'reloadChromaBtn');

    assert.ok(doc.querySelector('#updaterStepInstall').classList.contains('updater-step--ok'));
    assert.strictEqual(streamedBytes, zip.byteLength);
    assert.strictEqual(directory._readText('background/background.js'), 'new background');
    assert.strictEqual(directory._readText('ui/popup.html'), '<!doctype html>new');
    assert.strictEqual(directory._readText('manifest.json'), zipEntries[0].content);
    assert.strictEqual(directory._exists('stale/old.js'), false);
    const packageWriteOrder = directory._writes
      .map(write => write.path)
      .filter(pathName => ['background/background.js', 'ui/popup.html', 'manifest.json'].includes(pathName));
    assert.deepStrictEqual(packageWriteOrder, ['background/background.js', 'ui/popup.html', 'manifest.json']);
    assert.ok(
      directory._removals.indexOf('stale/old.js') < directory._writes.map(write => write.path).lastIndexOf('manifest.json'),
      'manifest.json should be written after stale files are removed'
    );
    assert.strictEqual([...directory._children.keys()].some(name => name.startsWith('.chroma-update-backup-')), false);
    assert.deepStrictEqual(harness.tabsCreated, []);
    assert.deepStrictEqual(harness.reloadCalls, []);
    assert.strictEqual(doc.querySelector('#reloadChromaBtn').hidden, false);
    assert.strictEqual(doc.querySelector('#reloadChromaBtn').disabled, false);
    assert.strictEqual(doc.querySelector('.updater-result-row #reloadChromaBtn'), doc.querySelector('#reloadChromaBtn'));
    assert.match(doc.querySelector('#updaterStatusTitle').textContent, /Reload Needed/);
    assert.match(doc.querySelector('#updaterResult').textContent, /Update installed/);

    doc.querySelector('#reloadChromaBtn').click();
    assert.strictEqual(harness.reloadCalls.length, 1);
    assert.match(doc.querySelector('#updaterResult').textContent, /Reloading Chroma/);
  });

  await t.test('updater stops before writing when final ZIP hash changes', async () => {
    const zipEntries = [
      { name: 'manifest.json', content: JSON.stringify({ manifest_version: 3, name: 'Chroma Ad-Blocker', version: '1.0.2' }), method: 0 },
      { name: 'background/background.js', content: 'new background', method: 0 }
    ];
    const zip = makeZip(zipEntries);
    const packageFiles = zipEntries.map(entry => ({
      path: entry.name,
      size: Buffer.byteLength(entry.content)
    }));
    const harness = createSettingsHarness({
      fetch: async url => ({
        ok: true,
        arrayBuffer: async () => exactArrayBuffer(zip),
        headers: { get: () => String(zip.byteLength) },
        url
      }),
      responses: {
        UPDATE_PACKAGE_INSPECT: {
          ok: true,
          updateAvailable: true,
          latestVersion: '1.0.2',
          asset: {
            name: 'chroma-ad-blocker-v1.0.2.zip',
            downloadUrl: 'https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/v1.0.2/chroma-ad-blocker-v1.0.2.zip'
          },
          package: {
            version: '1.0.2',
            entryCount: packageFiles.length,
            downloadBytes: zip.byteLength,
            sha256: '0'.repeat(64),
            verifiedBy: 'signed-updates.json',
            files: packageFiles
          }
        }
      }
    });
    const directory = createMockInstallDirectory(
      { manifest_version: 3, name: 'Chroma Ad-Blocker', version: '1.0.1' },
      { files: [{ path: 'background/background.js', content: 'old background' }] }
    );
    harness.sandbox.showDirectoryPicker = async () => directory;

    await harness.sandbox.ChromaApp.initSharedUI();
    harness.sandbox.ChromaUpdaterUI.initUpdaterPanel();
    await settleDomAsyncWork();

    const doc = harness.dom.window.document;
    doc.querySelector('#chooseInstallFolderBtn').click();
    await settleDomAsyncWork(60);
    doc.querySelector('#buildInstallPlanBtn').click();
    await settleDomAsyncWork(80);
    doc.querySelector('#runFolderProbeBtn').click();
    await settleDomAsyncWork(60);
    const writesBeforeInstall = directory._writes.length;

    doc.querySelector('#installUpdateBtn').click();
    await settleDomTimerWork(8);

    assert.ok(doc.querySelector('#updaterStepInstall').classList.contains('updater-step--error'));
    assert.strictEqual(directory._readText('background/background.js'), 'old background');
    assert.strictEqual(directory._writes.length, writesBeforeInstall);
    assert.strictEqual([...directory._children.keys()].some(name => name.startsWith('.chroma-update-backup-')), false);
    assert.match(doc.querySelector('#updaterResult').textContent, /hash changed after package inspection/i);
  });

  await t.test('updater stops before reading an oversized final ZIP download', async () => {
    const zipEntries = [
      { name: 'manifest.json', content: JSON.stringify({ manifest_version: 3, name: 'Chroma Ad-Blocker', version: '1.0.2' }), method: 0 },
      { name: 'background/background.js', content: 'new background', method: 0 }
    ];
    const zip = makeZip(zipEntries);
    const packageFiles = zipEntries.map(entry => ({
      path: entry.name,
      size: Buffer.byteLength(entry.content)
    }));
    const hash = await sha256Hex(zip);
    const maxZipBytes = 200 * 1024 * 1024;
    let arrayBufferCalled = false;
    const harness = createSettingsHarness({
      fetch: async url => ({
        ok: true,
        arrayBuffer: async () => {
          arrayBufferCalled = true;
          return exactArrayBuffer(zip);
        },
        headers: { get: () => String(maxZipBytes + 1) },
        url
      }),
      responses: {
        UPDATE_PACKAGE_INSPECT: {
          ok: true,
          updateAvailable: true,
          latestVersion: '1.0.2',
          asset: {
            name: 'chroma-ad-blocker-v1.0.2.zip',
            downloadUrl: 'https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/v1.0.2/chroma-ad-blocker-v1.0.2.zip'
          },
          package: {
            version: '1.0.2',
            entryCount: packageFiles.length,
            downloadBytes: maxZipBytes + 1,
            sha256: hash,
            verifiedBy: 'signed-updates.json',
            files: packageFiles
          }
        }
      }
    });
    const directory = createMockInstallDirectory(
      { manifest_version: 3, name: 'Chroma Ad-Blocker', version: '1.0.1' },
      { files: [{ path: 'background/background.js', content: 'old background' }] }
    );
    harness.sandbox.showDirectoryPicker = async () => directory;

    await harness.sandbox.ChromaApp.initSharedUI();
    harness.sandbox.ChromaUpdaterUI.initUpdaterPanel();
    await settleDomAsyncWork();

    const doc = harness.dom.window.document;
    doc.querySelector('#chooseInstallFolderBtn').click();
    await settleDomAsyncWork(60);
    doc.querySelector('#buildInstallPlanBtn').click();
    await settleDomAsyncWork(80);
    doc.querySelector('#runFolderProbeBtn').click();
    await settleDomAsyncWork(60);
    const writesBeforeInstall = directory._writes.length;

    doc.querySelector('#installUpdateBtn').click();
    await settleDomTimerWork(8);

    assert.strictEqual(arrayBufferCalled, false);
    assert.ok(doc.querySelector('#updaterStepInstall').classList.contains('updater-step--error'));
    assert.strictEqual(directory._readText('background/background.js'), 'old background');
    assert.strictEqual(directory._writes.length, writesBeforeInstall);
    assert.strictEqual([...directory._children.keys()].some(name => name.startsWith('.chroma-update-backup-')), false);
    assert.match(doc.querySelector('#updaterResult').textContent, /exceeds the updater safety limit/i);
  });

  await t.test('updater rejects ZIP64 metadata in the final package before writing', async () => {
    const zipEntries = [
      { name: 'manifest.json', content: JSON.stringify({ manifest_version: 3, name: 'Chroma Ad-Blocker', version: '1.0.2' }), method: 0 },
      { name: 'background/background.js', content: 'new background', method: 0 }
    ];
    const zip = tamperFirstCentralDirectorySizes(makeZip(zipEntries), {
      compressedSize: 0xffffffff,
      uncompressedSize: 0xffffffff
    });
    const packageFiles = zipEntries.map(entry => ({
      path: entry.name,
      size: Buffer.byteLength(entry.content)
    }));
    const hash = await sha256Hex(zip);
    const harness = createSettingsHarness({
      fetch: async url => ({
        ok: true,
        arrayBuffer: async () => exactArrayBuffer(zip),
        headers: { get: () => String(zip.byteLength) },
        url
      }),
      responses: {
        UPDATE_PACKAGE_INSPECT: {
          ok: true,
          updateAvailable: true,
          latestVersion: '1.0.2',
          asset: {
            name: 'chroma-ad-blocker-v1.0.2.zip',
            downloadUrl: 'https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/v1.0.2/chroma-ad-blocker-v1.0.2.zip'
          },
          package: {
            version: '1.0.2',
            entryCount: packageFiles.length,
            downloadBytes: zip.byteLength,
            sha256: hash,
            verifiedBy: 'signed-updates.json',
            files: packageFiles
          }
        }
      }
    });
    const directory = createMockInstallDirectory(
      { manifest_version: 3, name: 'Chroma Ad-Blocker', version: '1.0.1' },
      { files: [{ path: 'background/background.js', content: 'old background' }] }
    );
    harness.sandbox.showDirectoryPicker = async () => directory;

    await harness.sandbox.ChromaApp.initSharedUI();
    harness.sandbox.ChromaUpdaterUI.initUpdaterPanel();
    await settleDomAsyncWork();

    const doc = harness.dom.window.document;
    doc.querySelector('#chooseInstallFolderBtn').click();
    await settleDomAsyncWork(60);
    doc.querySelector('#buildInstallPlanBtn').click();
    await settleDomAsyncWork(80);
    doc.querySelector('#runFolderProbeBtn').click();
    await settleDomAsyncWork(60);
    const writesBeforeInstall = directory._writes.length;

    doc.querySelector('#installUpdateBtn').click();
    await settleDomTimerWork(8);

    assert.ok(doc.querySelector('#updaterStepInstall').classList.contains('updater-step--error'));
    assert.strictEqual(directory._readText('background/background.js'), 'old background');
    assert.strictEqual(directory._writes.length, writesBeforeInstall);
    assert.strictEqual([...directory._children.keys()].some(name => name.startsWith('.chroma-update-backup-')), false);
    assert.match(doc.querySelector('#updaterResult').textContent, /ZIP64/i);
  });

  await t.test('updater rolls back overwritten and added files after a failed write', async () => {
    const zipEntries = [
      { name: 'manifest.json', content: JSON.stringify({ manifest_version: 3, name: 'Chroma Ad-Blocker', version: '1.0.2' }), method: 0 },
      { name: 'background/background.js', content: 'new background', method: 0 },
      { name: 'ui/popup.html', content: '<!doctype html>new', method: 0 }
    ];
    const zip = makeZip(zipEntries);
    const packageFiles = zipEntries.map(entry => ({
      path: entry.name,
      size: Buffer.byteLength(entry.content)
    }));
    const hash = await sha256Hex(zip);
    const harness = createSettingsHarness({
      fetch: async url => ({
        ok: true,
        arrayBuffer: async () => exactArrayBuffer(zip),
        headers: { get: () => String(zip.byteLength) },
        url
      }),
      responses: {
        UPDATE_PACKAGE_INSPECT: {
          ok: true,
          updateAvailable: true,
          latestVersion: '1.0.2',
          asset: {
            name: 'chroma-ad-blocker-v1.0.2.zip',
            downloadUrl: 'https://github.com/Dabrogost/Chroma-Ad-Blocker/releases/download/v1.0.2/chroma-ad-blocker-v1.0.2.zip'
          },
          package: {
            version: '1.0.2',
            entryCount: packageFiles.length,
            downloadBytes: zip.byteLength,
            sha256: hash,
            verifiedBy: 'signed-updates.json',
            files: packageFiles
          }
        }
      }
    });
    const directory = createMockInstallDirectory(
      { manifest_version: 3, name: 'Chroma Ad-Blocker', version: '1.0.1' },
      {
        failWritesFor: ['ui/popup.html'],
        files: [
          { path: 'background/background.js', content: 'old background' },
          { path: 'stale/old.js', content: 'stale' }
        ]
      }
    );
    harness.sandbox.showDirectoryPicker = async () => directory;

    await harness.sandbox.ChromaApp.initSharedUI();
    harness.sandbox.ChromaUpdaterUI.initUpdaterPanel();
    await settleDomAsyncWork();

    const doc = harness.dom.window.document;
    doc.querySelector('#chooseInstallFolderBtn').click();
    await settleDomAsyncWork(60);
    doc.querySelector('#buildInstallPlanBtn').click();
    await settleDomAsyncWork(80);
    doc.querySelector('#runFolderProbeBtn').click();
    await settleDomAsyncWork(60);
    doc.querySelector('#installUpdateBtn').click();
    await settleDomTimerWork(8);

    assert.ok(doc.querySelector('#updaterStepInstall').classList.contains('updater-step--error'));
    assert.strictEqual(directory._readText('background/background.js'), 'old background');
    assert.strictEqual(directory._readText('manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Chroma Ad-Blocker', version: '1.0.1' }));
    assert.strictEqual(directory._exists('ui/popup.html'), false);
    assert.strictEqual(directory._readText('stale/old.js'), 'stale');
    assert.strictEqual([...directory._children.keys()].some(name => name.startsWith('.chroma-update-backup-')), false);
    assert.deepStrictEqual(harness.tabsCreated, []);
    assert.match(doc.querySelector('#updaterStatusTitle').textContent, /Install Rolled Back/);
    assert.match(doc.querySelector('#updaterResult').textContent, /rollback was attempted/i);
  });

  await t.test('updater validates Chroma folder and runs write probe', async () => {
    const harness = createSettingsHarness();
    const directory = createMockInstallDirectory({
      manifest_version: 3,
      name: 'Chroma Ad-Blocker',
      version: '1.0.1'
    });
    harness.sandbox.showDirectoryPicker = async () => directory;

    await harness.sandbox.ChromaApp.initSharedUI();
    harness.sandbox.ChromaUpdaterUI.initUpdaterPanel();
    await settleDomAsyncWork();

    const doc = harness.dom.window.document;
    doc.querySelector('#chooseInstallFolderBtn').click();
    await settleDomAsyncWork(60);

    assert.ok(doc.querySelector('#updaterStepFolder').classList.contains('updater-step--ok'));
    assert.strictEqual(doc.querySelector('#runFolderProbeBtn').disabled, false);
    assert.match(doc.querySelector('#updaterResult').textContent, /install folder verified/i);

    doc.querySelector('#runFolderProbeBtn').click();
    await settleDomAsyncWork(60);

    assert.ok(doc.querySelector('#updaterStepWrite').classList.contains('updater-step--ok'));
    assert.strictEqual(directory._writes.length, 1);
    assert.deepStrictEqual(directory._removals, ['.chroma-write-probe']);
    assert.match(doc.querySelector('#updaterStatusTitle').textContent, /Updater Ready/);
  });

  await t.test('updater reconnects a remembered folder when Chrome needs permission again', async () => {
    const harness = createSettingsHarness();
    const directory = createMockInstallDirectory({
      manifest_version: 3,
      name: 'Chroma Ad-Blocker',
      version: '1.0.1'
    });
    harness.sandbox.indexedDB = createSavedHandleIndexedDb(directory);
    harness.sandbox.showDirectoryPicker = async () => {
      throw new Error('reconnect should reuse the saved folder handle');
    };

    await harness.sandbox.ChromaApp.initSharedUI();
    harness.sandbox.ChromaUpdaterUI.initUpdaterPanel();
    await settleDomTimerWork(6);

    const doc = harness.dom.window.document;
    assert.strictEqual(doc.querySelector('#chooseInstallFolderBtn').textContent, 'Reconnect Chroma Folder');
    assertNextUpdaterAction(doc, 'chooseInstallFolderBtn');
    assert.strictEqual(doc.querySelector('#buildInstallPlanBtn').disabled, true);
    assert.ok(doc.querySelector('#updaterStepFolder').classList.contains('updater-step--pending'));
    assert.match(doc.querySelector('#updaterStatusTitle').textContent, /Folder Permission Needed/);
    assert.match(doc.querySelector('#updaterResult').textContent, /Chrome needs folder permission again/);

    doc.querySelector('#chooseInstallFolderBtn').click();
    await settleDomTimerWork(8);

    assert.strictEqual(doc.querySelector('#chooseInstallFolderBtn').textContent, 'Change Chroma Folder');
    assertNextUpdaterAction(doc, 'inspectPackageBtn');
    assert.strictEqual(doc.querySelector('#buildInstallPlanBtn').disabled, false);
    assert.strictEqual(doc.querySelector('#runFolderProbeBtn').disabled, false);
    assert.ok(doc.querySelector('#updaterStepFolder').classList.contains('updater-step--ok'));
    assert.match(doc.querySelector('#updaterResult').textContent, /install folder verified/i);
  });

  await t.test('updater reports folder permission separately from invalid folders', async () => {
    const harness = createSettingsHarness();
    const result = await harness.sandbox.ChromaUpdaterUI._test.verifyInstallDirectory(
      {
        getFileHandle: async () => {
          const error = new Error('permission denied');
          error.name = 'NotAllowedError';
          throw error;
        }
      },
      { name: 'Chroma Ad-Blocker', version: '1.0.1' }
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.permissionNeeded, true);
    assert.match(result.reason, /Reconnect Chroma Folder/);
  });

  await t.test('updater rejects a different Chroma install version', () => {
    const harness = createSettingsHarness();
    const result = harness.sandbox.ChromaUpdaterUI._test.validateInstallManifest(
      { manifest_version: 3, name: 'Chroma Ad-Blocker', version: '2.0.0' },
      { name: 'Chroma Ad-Blocker', version: '1.0.1' }
    );

    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /running copy is v1\.0\.1/);
  });

  await t.test('updater reload action falls back to chrome extensions page', async () => {
    const harness = createSettingsHarness();
    delete harness.sandbox.chrome.runtime.reload;

    await harness.sandbox.ChromaApp.initSharedUI();
    harness.sandbox.ChromaUpdaterUI.initUpdaterPanel();
    await settleDomAsyncWork();

    const result = harness.sandbox.ChromaUpdaterUI._test.reloadChroma();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.method, 'chrome://extensions');
    assert.deepStrictEqual(harness.reloadCalls, []);
    assert.strictEqual(harness.tabsCreated.length, 1);
    assert.strictEqual(harness.tabsCreated[0].url, 'chrome://extensions/');
  });

  await t.test('proxy credential UI never hydrates password fields from stored config', () => {
    assert.match(proxyUiJs, /appendInput\(inputGroup, 'password', 'chroma-input proxy-pass', '', pc\.hasCredentials \? 'Password saved' : 'Password'\)/);
    assert.doesNotMatch(proxyUiJs, /value="\$\{[^}]*password/i);
    assert.match(proxyUiJs, /delete pc\.username;/);
    assert.match(proxyUiJs, /delete pc\.password;/);
    assert.match(proxyUiJs, /delete pc\.authIv;/);
    assert.match(proxyUiJs, /delete pc\.authCipher;/);
  });

  await t.test('proxy config values render as DOM text and input values, never HTML', async () => {
    const maliciousName = '"><img src=x onerror=alert(1)>';
    const maliciousHost = 'proxy.example"><svg onload=alert(2)>';
    const maliciousPort = '8080"><iframe src=javascript:alert(3)>';
    const maliciousDomain = 'video.example"><img src=x onerror=alert(4)>';
    const harness = createSettingsHarness({
      responses: {
        PROXY_CONFIG_GET: [{
          id: 1,
          name: maliciousName,
          host: maliciousHost,
          port: maliciousPort,
          type: 'PROXY',
          accepted: true,
          enabled: true,
          domains: [{ host: maliciousDomain, enabled: true }],
          hasCredentials: true
        }]
      }
    });

    await harness.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    const container = harness.dom.window.document.querySelector('#proxyRouterContainer');
    const card = container.querySelector('.proxy-card');
    assert.strictEqual(container.querySelectorAll('img, svg, iframe').length, 0);
    assert.strictEqual(card.querySelector('.proxy-name').value, maliciousName);
    assert.strictEqual(card.querySelector('.proxy-host').value, maliciousHost);
    assert.strictEqual(card.querySelector('.proxy-port').value, maliciousPort);
    assert.strictEqual(card.querySelector('.proxy-title').textContent, `Active: ${maliciousName}`);
    assert.strictEqual(card.querySelector('.proxy-endpoint').textContent, `${maliciousHost}:${maliciousPort}`);
    assert.strictEqual(card.querySelector('.proxy-domain-name').textContent, maliciousDomain);
  });

  await t.test('user scriptlet resource values render as DOM text and textarea values, never HTML', async () => {
    const maliciousName = '"><img src=x onerror=alert(1)>';
    const maliciousUrl = 'https://cdn.example.com/resources.js?x="><iframe src=javascript:alert(2)>';
    const maliciousError = 'Failed at https://evil.example/<img src=x onerror=alert(3)>';
    const maliciousRuleText = 'example.com##+js(custom-scriptlet, "><img src=x onerror=alert(4)>)';
    const harness = createSettingsHarness({
      responses: {
        USER_SCRIPTLETS_GET: {
          sources: [{
            id: 'usr_test',
            name: maliciousName,
            url: maliciousUrl,
            lastUpdated: 0,
            lastError: maliciousError,
            resourceCount: 1,
            resourceNames: ['custom-scriptlet.js"><img src=x onerror=alert(5)>']
          }],
          ruleText: maliciousRuleText,
          parsedRuleCount: 1,
          availableResourceNames: ['custom-scriptlet.js']
        }
      }
    });

    await harness.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    const list = harness.dom.window.document.querySelector('#userScriptletSourceList');
    assert.strictEqual(list.querySelectorAll('img, iframe').length, 0);
    assert.strictEqual(list.querySelector('.name').textContent, maliciousName);
    assert.strictEqual(list.querySelector('.user-scriptlet-source-url').textContent, maliciousUrl);
    assert.strictEqual(list.querySelector('.subscription-error').textContent, `Error: ${maliciousError}`);
    assert.strictEqual(harness.dom.window.document.querySelector('#userScriptletAvailableResourceList .user-scriptlet-chip__name').textContent, 'custom-scriptlet.js');
    assert.strictEqual(harness.dom.window.document.querySelector('#userScriptletAvailableResourceList .user-scriptlet-chip__status').textContent, 'Linked');
    assert.strictEqual(harness.dom.window.document.querySelector('#userScriptletRulesText').value, maliciousRuleText);
    assert.strictEqual(harness.dom.window.document.querySelector('#userScriptletRulesText').readOnly, false);
    assert.strictEqual(harness.dom.window.document.querySelector('#saveUserScriptletRulesBtn').disabled, false);
  });

  await t.test('user scriptlet resources show linked and missing rule state', async () => {
    const harness = createSettingsHarness({
      responses: {
        USER_SCRIPTLETS_GET: {
          sources: [{
            id: 'usr_vaft',
            name: 'VAFT',
            url: 'https://cdn.example.com/vaft.js',
            lastUpdated: Date.now(),
            lastError: null,
            resourceCount: 2,
            resourceNames: ['twitch-videoad.js', 'unused-helper.js']
          }],
          ruleText: [
            'twitch.tv##+js(twitch-videoad)',
            'example.com##+js(missing-helper)'
          ].join('\n'),
          parsedRuleCount: 2,
          availableResourceNames: ['twitch-videoad.js', 'unused-helper.js']
        }
      }
    });

    await harness.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    const doc = harness.dom.window.document;
    const chips = Array.from(doc.querySelectorAll('#userScriptletAvailableResourceList .user-scriptlet-chip'));

    assert.ok(chips[0].classList.contains('user-scriptlet-chip--linked'));
    assert.strictEqual(chips[0].querySelector('.user-scriptlet-chip__name').textContent, 'twitch-videoad.js');
    assert.strictEqual(chips[0].querySelector('.user-scriptlet-chip__status').textContent, 'Linked');
    assert.strictEqual(chips[1].querySelector('.user-scriptlet-chip__name').textContent, 'unused-helper.js');
    assert.strictEqual(chips[1].querySelector('.user-scriptlet-chip__status').textContent, 'Unused');
    assert.ok(chips[2].classList.contains('user-scriptlet-chip--missing'));
    assert.strictEqual(chips[2].querySelector('.user-scriptlet-chip__name').textContent, 'missing-helper');
    assert.strictEqual(chips[2].querySelector('.user-scriptlet-chip__status').textContent, 'Missing');
    assert.strictEqual(doc.querySelector('#userScriptletRulesStatus').textContent, '2 saved rule(s) \u00b7 1 linked resource(s) \u00b7 1 missing resource(s).');
    assert.ok(doc.querySelector('#userScriptletRulesStatus').classList.contains('form-error'));
  });

  await t.test('user scriptlet source add failures restore controls', async () => {
    const harness = createSettingsHarness({
      responses: {
        USER_SCRIPTLET_SOURCE_ADD: new Error('background unavailable')
      }
    });

    await harness.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    const doc = harness.dom.window.document;
    const originalError = console.error;
    console.error = () => {};
    try {
      doc.querySelector('#addUserScriptletSourceBtn').click();
      doc.querySelector('#newUserScriptletSourceUrl').value = 'https://cdn.example.com/resources.js';
      doc.querySelector('#newUserScriptletSourceAddBtn').click();
      await settleDomAsyncWork();
    } finally {
      console.error = originalError;
    }

    assert.strictEqual(doc.querySelector('#newUserScriptletSourceAddBtn').disabled, false);
    assert.strictEqual(doc.querySelector('#newUserScriptletSourceAddBtn').textContent, 'Add');
    assert.strictEqual(doc.querySelector('#newUserScriptletSourceError').textContent, 'Add failed.');
  });

  await t.test('preserve, replace, and clear credential actions are encoded intentionally', () => {
    assert.match(proxyUiJs, /credentialAction: action/);
    assert.match(proxyUiJs, /if \(out\.credentialAction === 'replace'\)/);
    assert.match(proxyUiJs, /out\.username = credential\.username \|\| '';/);
    assert.match(proxyUiJs, /out\.password = credential\.password \|\| '';/);
    assert.match(proxyUiJs, /action: pendingCredentialAction === 'clear' \? 'clear' : 'preserve'/);
    assert.match(proxyUiJs, /Enter both username and password, or leave both blank to keep saved credentials\./);
  });

  await t.test('adding another proxy preserves unsaved proxy card drafts', () => {
    const addHandler = proxyUiJs.match(/addBtn\.onclick = async \(\) => \{[\s\S]*?scrollIntoView/);
    assert.ok(addHandler, 'expected settings add-proxy handler');
    assert.match(addHandler[0], /container\.insertBefore\(renderProxyCard\(newPc, proxyConfigs\.length - 1\), container\.querySelector\('\.proxy-chrome-service-bypass-control'\)\)/);
    assert.doesNotMatch(addHandler[0], /renderAll\(\)/);
  });

  await t.test('proxy destructive actions use compact button styling', () => {
    assert.match(proxyUiJs, /proxy-del-server-btn inline-danger-btn compact-action-btn/);
    assert.match(proxyUiJs, /d-del-btn inline-danger-btn compact-action-btn/);
    assert.match(proxyUiJs, /proxy-clear-settings-btn inline-danger-btn compact-action-btn/);
    assert.match(appJs, /zapper-rule-delete inline-danger-btn compact-action-btn/);
    assert.match(uiCss, /\.inline-danger-btn\.compact-action-btn\s*\{/);
    assert.match(uiCss, /\.inline-danger-btn\.compact-action-btn\s*\{[\s\S]*border: 1px solid var\(--border-glass\)/);
    assert.match(uiCss, /\.inline-danger-btn\.compact-action-btn\s*\{[\s\S]*background: rgba\(108, 92, 231, 0\.12\)/);
  });

  await t.test('proxy router cards separate enabled toggle from GLOBAL selection', async () => {
    const dom = new JSDOM('<!doctype html><div id="proxyRouterContainer"></div><button id="addProxyServerBtn"></button>', {
      url: 'chrome-extension://test/ui/settings.html#proxy',
      runScripts: 'outside-only'
    });
    let proxyConfigs = [
      {
        id: 1,
        name: 'VPN',
        host: 'vpn.example.com',
        port: 8080,
        type: 'PROXY',
        accepted: true,
        enabled: true,
        domains: [],
        hasCredentials: false
      },
      {
        id: 2,
        name: 'BZ1',
        host: 'bz1.example.com',
        port: 8080,
        type: 'PROXY',
        accepted: true,
        enabled: true,
        domains: [
          { host: 'youtube.com', enabled: true },
          { host: 'twitch.tv', enabled: true }
        ],
        hasCredentials: false
      }
    ];
    const config = { globalProxyEnabled: true, globalProxyId: 1 };
    const messages = [];
    const sandbox = {
      window: dom.window,
      document: dom.window.document,
      console,
      confirm: () => true,
      setTimeout,
      clearTimeout,
      MSG: {
        CONFIG_GET: 'CONFIG_GET',
        CONFIG_SET: 'CONFIG_SET',
        PROXY_CONFIG_GET: 'PROXY_CONFIG_GET',
        PROXY_CONFIG_SET: 'PROXY_CONFIG_SET',
        PROXY_TEST: 'PROXY_TEST'
      },
      ChromaApp: {
        $: id => dom.window.document.getElementById(id),
        escapeHTML: value => String(value ?? '').replace(/[&<>"']/g, ch => ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;'
        }[ch])),
        isSettingsPage: () => true,
        openProxySettings: () => {}
      },
      chrome: {
        storage: {
          local: {
            get: async key => {
              if (key === 'config') return { config };
              return {};
            }
          }
        }
      },
      notifyBackground: async msg => {
        messages.push(msg);
        if (msg.type === 'CONFIG_GET') return config;
        if (msg.type === 'PROXY_CONFIG_GET') return proxyConfigs;
        if (msg.type === 'PROXY_TEST') return { ok: true, ip: msg.proxyId === 1 ? '198.51.100.1' : '198.51.100.2' };
        if (msg.type === 'PROXY_CONFIG_SET') {
          proxyConfigs = msg.proxyConfigs;
          return { ok: true };
        }
        if (msg.type === 'CONFIG_SET') {
          Object.assign(config, msg.config);
          return { ok: true };
        }
        return {};
      }
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext([domUtilsJs, proxyUiJs].join('\n'), sandbox);

    await sandbox.ChromaProxyUI.loadProxyRouterUI();
    await settleDomAsyncWork();

    const chromeBypassToggle = dom.window.document.querySelector('.proxy-chrome-service-bypass-toggle');
    const chromeBypassWarning = dom.window.document.querySelector('.proxy-chrome-service-bypass-warning');
    assert.ok(chromeBypassToggle, 'expected Chrome service bypass toggle');
    assert.strictEqual(chromeBypassToggle.checked, true);
    assert.match(
      dom.window.document.querySelector('.proxy-chrome-service-bypass-control .desc').textContent,
      /browser-managed features/
    );
    assert.strictEqual(chromeBypassWarning.classList.contains('is-hidden'), true);

    chromeBypassToggle.checked = false;
    chromeBypassToggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(config.chromeServiceProxyBypass, false);
    assert.strictEqual(chromeBypassWarning.classList.contains('is-hidden'), false);
    assert.ok(messages.some(msg =>
      msg.type === 'CONFIG_SET' &&
      msg.config.chromeServiceProxyBypass === false
    ));

    chromeBypassToggle.checked = true;
    chromeBypassToggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(config.chromeServiceProxyBypass, true);
    assert.strictEqual(chromeBypassWarning.classList.contains('is-hidden'), true);

    const cards = [...dom.window.document.querySelectorAll('.proxy-card')];
    assert.strictEqual(cards.length, 2);
    const proxyChildren = [...dom.window.document.querySelectorAll('#proxyRouterContainer > *')];
    assert.ok(
      proxyChildren.indexOf(cards[1]) <
        proxyChildren.indexOf(dom.window.document.querySelector('.proxy-chrome-service-bypass-control')),
      'proxy cards should render before global compatibility controls'
    );
    assert.strictEqual(cards[1].querySelector('.proxy-enabled-toggle').checked, true);
    assert.match(cards[1].querySelector('.proxy-status-text').textContent, /ROUTING 2 DOMAINS/);
    assert.strictEqual(cards[0].querySelector('.proxy-global-btn').classList.contains('is-active'), true);
    assert.strictEqual(cards[1].querySelector('.proxy-global-btn').classList.contains('is-active'), false);
    assert.strictEqual(cards[0].querySelector('.proxy-domain-tools').classList.contains('is-hidden'), true);
    assert.strictEqual(cards[1].querySelector('.proxy-domain-tools').classList.contains('is-hidden'), false);

    cards[1].querySelector('.proxy-global-btn').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    assert.strictEqual(cards[0].querySelector('.proxy-global-btn').classList.contains('is-active'), false);
    assert.strictEqual(cards[1].querySelector('.proxy-global-btn').classList.contains('is-active'), true);
    assert.strictEqual(cards[0].querySelector('.proxy-domain-tools').classList.contains('is-hidden'), false);
    assert.strictEqual(cards[1].querySelector('.proxy-domain-tools').classList.contains('is-hidden'), true);
    await settleDomAsyncWork();

    assert.strictEqual(config.globalProxyEnabled, true);
    assert.strictEqual(config.globalProxyId, 2);
    assert.strictEqual(proxyConfigs.find(pc => pc.id === 2).enabled, true);
    assert.strictEqual(cards[0].querySelector('.proxy-global-btn').classList.contains('is-active'), false);
    assert.strictEqual(cards[1].querySelector('.proxy-global-btn').classList.contains('is-active'), true);
    assert.strictEqual(cards[0].querySelector('.proxy-domain-tools').classList.contains('is-hidden'), false);
    assert.strictEqual(cards[1].querySelector('.proxy-domain-tools').classList.contains('is-hidden'), true);
    assert.ok(messages.some(msg =>
      msg.type === 'PROXY_CONFIG_SET' &&
      msg.proxyConfigs.some(pc => pc.id === 2 && pc.enabled === true)
    ));

    const bz1EnabledToggle = cards[1].querySelector('.proxy-enabled-toggle');
    bz1EnabledToggle.checked = false;
    bz1EnabledToggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(config.globalProxyEnabled, true);
    assert.strictEqual(config.globalProxyId, 2);
    assert.strictEqual(proxyConfigs.find(pc => pc.id === 2).enabled, false);
    assert.strictEqual(cards[1].querySelector('.proxy-global-btn').classList.contains('is-active'), true);
    assert.strictEqual(cards[1].querySelector('.proxy-domain-tools').classList.contains('is-hidden'), true);
    assert.match(cards[1].querySelector('.proxy-status-text').textContent, /DISABLED/);

    bz1EnabledToggle.checked = true;
    bz1EnabledToggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(config.globalProxyEnabled, true);
    assert.strictEqual(config.globalProxyId, 2);
    assert.strictEqual(proxyConfigs.find(pc => pc.id === 2).enabled, true);
    assert.strictEqual(cards[1].querySelector('.proxy-global-btn').classList.contains('is-active'), true);
    assert.strictEqual(cards[1].querySelector('.proxy-domain-tools').classList.contains('is-hidden'), true);

    cards[1].querySelector('.proxy-global-btn').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    assert.strictEqual(cards[1].querySelector('.proxy-global-btn').classList.contains('is-active'), false);
    assert.strictEqual(cards[1].querySelector('.proxy-domain-tools').classList.contains('is-hidden'), false);
    await settleDomAsyncWork();

    assert.strictEqual(config.globalProxyEnabled, false);
    assert.strictEqual(config.globalProxyId, null);
    assert.strictEqual(cards[1].querySelector('.proxy-global-btn').classList.contains('is-active'), false);
    assert.strictEqual(cards[1].querySelector('.proxy-domain-tools').classList.contains('is-hidden'), false);

    chromeBypassToggle.checked = false;
    chromeBypassToggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(config.chromeServiceProxyBypass, false);
    assert.strictEqual(chromeBypassWarning.classList.contains('is-hidden'), true);

    cards[1].querySelector('.proxy-global-btn').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(config.globalProxyEnabled, true);
    assert.strictEqual(config.globalProxyId, 2);
    assert.strictEqual(chromeBypassWarning.classList.contains('is-hidden'), false);
  });

  await t.test('proxy domain names override generic toggle heading size', () => {
    assert.match(uiCss, /\.toggle-info \.name \{ font-size: 16px/);
    assert.match(uiCss, /\.toggle-info \.proxy-domain-name\s*\{[\s\S]*font-size: 13px/);
  });

  await t.test('toggle descriptions wrap instead of clipping', () => {
    assert.match(uiCss, /\.toggle-info \.desc\s*\{[\s\S]*white-space: normal/);
    assert.match(uiCss, /\.toggle-info \.desc\s*\{[\s\S]*overflow-wrap: anywhere/);
    assert.doesNotMatch(uiCss, /\.toggle-info \.desc \{[^\n]*white-space: nowrap/);
  });

  await t.test('active proxy global button has a distinct highlighted style', () => {
    assert.match(proxyUiJs, /appendProxyButton\(line, 'reset-btn proxy-global-btn compact-action-btn', 'GLOBAL', 'Use as Global Fallback'\)/);
    assert.match(proxyUiJs, /proxy-enabled-toggle/);
    assert.match(uiCss, /\.proxy-global-btn\.is-active\s*\{/);
    assert.match(uiCss, /\.proxy-global-btn\.is-active\s*\{[\s\S]*box-shadow:/);
    assert.doesNotMatch(proxyUiJs, /proxy-global-toggle/);
  });

  await t.test('Chrome service bypass control is visible and wraps its description', () => {
    assert.match(proxyUiJs, /Bypass Chrome Browser Services/);
    assert.match(proxyUiJs, /chromeServiceProxyBypass: toggle\.checked/);
    assert.match(proxyUiJs, /config\.chromeServiceProxyBypass !== false/);
    assert.match(uiCss, /\.proxy-chrome-service-bypass-control \.desc\s*\{[\s\S]*white-space: normal/);
  });

  await t.test('zapper rules render selector text safely and expose disable/delete actions', () => {
    assert.match(appJs, /appendElement\(info, 'div', 'zapper-rule-selector', rule\.selector\)/);
    assert.match(appJs, /selector\.title = rule\.selector/);
    assert.match(appJs, /type: MSG\.ZAPPER_RULE_SET/);
    assert.match(appJs, /type: MSG\.ZAPPER_RULE_REMOVE/);
    assert.doesNotMatch(appJs, /escapeHTML\(rule\.selector\)/);
    assert.doesNotMatch(appJs, /zapper-rule-selector[\s\S]{0,200}innerHTML/);
  });

  await t.test('settings page supports direct proxy hash entry points', () => {
    assert.match(componentsJs, /id="proxySection"/);
    assert.match(appJs, /PROXY_SETTINGS_PATH = 'ui\/settings\.html#proxySection'/);
    assert.match(appJs, /\['#proxy', '#proxySection'\]\.includes\(globalThis\.location\?\.hash\)/);
    assert.match(appJs, /scrollIntoView\(\{ behavior, block: 'start' \}\)/);
  });

  await t.test('settings statistics panel is local-only and uses stats messages', () => {
    assert.match(componentsJs, /Protection Intelligence/);
    assert.match(componentsJs, /All statistics are stored locally/);
    assert.match(componentsJs, /statBreakdownProxy/);
    assert.doesNotMatch(componentsJs, /statBreakdownYoutube/);
    assert.match(componentsJs, /id="statisticsPanel"/);
    assert.match(componentsJs, /id="resetAllStats"/);
    assert.match(componentsJs, /id="resetSiteStats"/);
    assert.match(componentsJs, /id="resetRequestLogOnly"/);
    assert.match(componentsJs, /id="exportStatsJson"/);
    assert.match(appJs, /type: MSG\.STATS_GET/);
    assert.match(appJs, /type: MSG\.STATS_RESET, scope: 'sites'/);
    assert.match(appJs, /type: MSG\.STATS_RESET, scope: 'debugLog'/);
    assert.match(appJs, /type: MSG\.STATS_EXPORT/);
    assert.match(appJs, /type: MSG\.STATS_SETTINGS_SET/);
    assert.match(appJs, /Ad Cleanups/);
    assert.match(appJs, /Proxy Activity/);
    assert.match(appJs, /Time Saved \(est\.\)/);
    assert.match(appJs, /Allow Rule/);
    assert.match(appJs, /Allows \$\{formatCompactCount\(allows\)\}/);
    assert.doesNotMatch(appJs, /YouTube Payload Cleans/);
  });

  await t.test('settings shell renders section skeletons synchronously', () => {
    const dom = new JSDOM('<!doctype html><body><div id="appShell"></div></body>', {
      url: 'chrome-extension://test/ui/settings.html',
      runScripts: 'outside-only'
    });
    const sandbox = { document: dom.window.document, globalThis: null };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(componentsJs, sandbox);

    sandbox.ChromaComponents.renderPageShell({ settingsMode: true });

    assert.ok(dom.window.document.querySelector('#healthPanelBody .skeleton-card'));
    assert.ok(dom.window.document.querySelector('#statisticsTopCards .skeleton-card'));
    assert.ok(dom.window.document.querySelector('#statsSitesList .skeleton-row'));
    assert.ok(dom.window.document.querySelector('#subscriptionList .skeleton-row'));
    assert.ok(dom.window.document.querySelector('#userScriptletSourceList .skeleton-row'));
    assert.ok(dom.window.document.querySelector('#userScriptletAvailableResourceList .skeleton-line'));
    assert.strictEqual(dom.window.document.querySelector('#userScriptletRulesText').readOnly, true);
    assert.strictEqual(dom.window.document.querySelector('#saveUserScriptletRulesBtn').disabled, true);
    assert.strictEqual(dom.window.document.querySelector('#userScriptletRulesStatus').textContent, 'Loading rules...');
    assert.strictEqual(dom.window.document.querySelector('#addUserScriptletSourceBtn').textContent.trim(), 'Add URL');
    assert.ok(dom.window.document.querySelector('#proxyRouterContainer .skeleton-row'));
    assert.ok(dom.window.document.querySelector('#localZapperRules .skeleton-row'));
    assert.strictEqual(dom.window.document.querySelector('#statsModeSelect').disabled, true);
    assert.ok(dom.window.document.querySelector('#exportConfigJson'));
    assert.ok(dom.window.document.querySelector('#importConfigFile'));
  });

  await t.test('popup shell does not render settings-only skeleton sections', () => {
    const dom = new JSDOM('<!doctype html><body><div id="appShell"></div></body>', {
      url: 'chrome-extension://test/ui/popup.html',
      runScripts: 'outside-only'
    });
    const sandbox = { document: dom.window.document, globalThis: null };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(componentsJs, sandbox);

    sandbox.ChromaComponents.renderPageShell({ settingsMode: false });

    assert.strictEqual(dom.window.document.querySelector('#healthPanelBody'), null);
    assert.strictEqual(dom.window.document.querySelector('#statisticsTopCards'), null);
    assert.strictEqual(dom.window.document.querySelector('#localZapperRules'), null);
    assert.strictEqual(dom.window.document.querySelector('#subscriptionList'), null);
    assert.strictEqual(dom.window.document.querySelector('#userScriptletSourceList'), null);
    assert.strictEqual(dom.window.document.querySelector('#proxyRouterContainer'), null);
    assert.strictEqual(dom.window.document.querySelector('#requestLogPanel'), null);
    assert.strictEqual(dom.window.document.querySelector('#resetStats'), null);
    assert.strictEqual(dom.window.document.querySelector('#toggleNetwork'), null);
    assert.ok(dom.window.document.querySelector('#zapElementBtn'));
    assert.ok(dom.window.document.querySelector('#toggleWhitelist'));
    assert.strictEqual(dom.window.document.querySelector('#exportConfigJson'), null);
    assert.strictEqual(dom.window.document.querySelector('#importConfigFile'), null);
  });

  await t.test('health skeleton is replaced on success and on unavailable response', async () => {
    const success = createSettingsHarness();
    await success.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    assert.strictEqual(success.dom.window.document.querySelector('#healthPanelBody .skeleton-card'), null);
    assert.match(success.dom.window.document.querySelector('#healthOverallLabel').textContent, /Healthy/);
    assert.ok(success.dom.window.document.querySelector('#healthPanelBody .health-section'));
    assert.match(success.dom.window.document.querySelector('#healthPanelBody').textContent, /De-AMP links\s*Disabled/);
    assert.match(success.dom.window.document.querySelector('#healthPanelBody').textContent, /Fingerprint Randomization\s*Active/);
    assert.match(success.dom.window.document.querySelector('#healthPanelBody').textContent, /Language APIs/);

    const failure = createSettingsHarness({ responses: { HEALTH_GET: null } });
    await failure.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    assert.strictEqual(failure.dom.window.document.querySelector('#healthPanelBody .skeleton-card'), null);
    assert.match(failure.dom.window.document.querySelector('#healthOverallLabel').textContent, /Unavailable/);
    assert.match(failure.dom.window.document.querySelector('#healthPanelBody').textContent, /Could not load health diagnostics/);
  });

  await t.test('health panel loads once on settings init and refresh button reloads it', async () => {
    const harness = createSettingsHarness();

    await harness.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    assert.strictEqual(countMessages(harness.messages, 'HEALTH_GET'), 1);

    const refreshButton = harness.dom.window.document.querySelector('#refreshHealthBtn');
    assert.ok(refreshButton);
    refreshButton.click();
    await settleDomAsyncWork();

    assert.strictEqual(countMessages(harness.messages, 'HEALTH_GET'), 2);
  });

  await t.test('storage stats changes refresh stats without invoking health diagnostics', async () => {
    const harness = createSettingsHarness();

    await harness.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    assert.strictEqual(harness.getStorageChangeListenerCount(), 1);
    const healthBefore = countMessages(harness.messages, 'HEALTH_GET');
    const statsBefore = countMessages(harness.messages, 'STATS_GET');

    await harness.emitStorageChange({ statsV2: { oldValue: {}, newValue: {} } }, 'local');

    assert.strictEqual(countMessages(harness.messages, 'STATS_GET'), statsBefore + 1);
    assert.strictEqual(countMessages(harness.messages, 'HEALTH_GET'), healthBefore);
  });

  await t.test('storage settings changes do not invoke health diagnostics', async () => {
    const harness = createSettingsHarness();

    await harness.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    const healthBefore = countMessages(harness.messages, 'HEALTH_GET');
    const changes = {
      config: { oldValue: {}, newValue: {} },
      subscriptions: { oldValue: [], newValue: [] },
      appliedNetworkRuleCount: { oldValue: 0, newValue: 1 },
      localCosmeticRules: { oldValue: [], newValue: [] },
      subscriptionCosmeticRules: { oldValue: [], newValue: [] },
      subscriptionScriptletRules: { oldValue: [], newValue: [] },
      proxyConfigs: { oldValue: [], newValue: [] },
      whitelist: { oldValue: [], newValue: [] },
      fprWhitelist: { oldValue: [], newValue: [] }
    };

    for (const [key, change] of Object.entries(changes)) {
      await harness.emitStorageChange({ [key]: change }, 'local');
      assert.strictEqual(countMessages(harness.messages, 'HEALTH_GET'), healthBefore, key);
    }
  });

  await t.test('health panel surfaces Allow User Scripts diagnostic', async () => {
    const harness = createSettingsHarness({
      responses: {
        HEALTH_GET: {
          overall: {
            status: 'degraded',
            issues: [{
              severity: 'warning',
              area: 'scriptlets',
              message: 'Scriptlet protection unavailable. Enable Allow User Scripts for this extension in Chrome extension details; 1 subscription scriptlet rule cannot be registered until then.',
              action: 'Open Chrome extension details and enable Allow User Scripts.'
            }]
          },
          manifest: { version: '1.0.1', minimumChromeVersion: '120' },
          master: { enabled: true, networkBlocking: true },
          dnr: { enabledStaticRulesets: ['a'], expectedStaticRulesets: ['a'], staticRulesetsOk: true, appliedNetworkRuleCount: 12, whitelistRuleCount: 0 },
          subscriptions: { enabled: 1, total: 1, appliedNetwork: 12, cosmetic: 4, scriptlet: 1, withErrors: 0 },
          scriptlets: {
            apiAvailable: false,
            registeredUserScriptCount: null,
            storedRuleCount: 1,
            registrationStatus: 'unavailable',
            error: null
          },
          cosmetic: { subscriptionCosmeticRuleCount: 4, enabledLocalZapperRuleCount: 0, localZapperRuleCount: 0 },
          proxy: { configuredCount: 0, acceptedCount: 0, routedDomainCount: 0, globalProxyEnabled: false, globalProxyConfigured: false },
          webrtc: { available: true, mode: 'auto', protected: true },
          requestLog: { available: true, entryCount: 0, maxEntries: 200, note: '' }
        }
      }
    });

    await harness.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    const bodyText = harness.dom.window.document.querySelector('#healthPanelBody').textContent;

    assert.match(bodyText, /UserScripts API\s*Unavailable/i);
    assert.match(bodyText, /Registered scripts\s*Unavailable/i);
    assert.match(bodyText, /Enable Allow User Scripts/i);
    assert.match(bodyText, /Chrome extension details/i);
  });

  await t.test('health panel reports Tracking URL Cleanup when its DNR rule is missing', async () => {
    const harness = createSettingsHarness({
      responses: {
        HEALTH_GET: {
          overall: {
            status: 'degraded',
            issues: [{
              severity: 'warning',
              area: 'trackingUrlCleanup',
              message: 'Tracking URL Cleanup is enabled but its DNR redirect rule is not registered.',
              action: 'Reload the extension, or turn Tracking URL Cleanup off and on.'
            }]
          },
          manifest: { version: '1.0.1', minimumChromeVersion: '120' },
          master: { enabled: true, networkBlocking: true, trackingUrlCleanup: true },
          dnr: {
            enabledStaticRulesets: ['a'],
            expectedStaticRulesets: ['a'],
            staticRulesetsOk: true,
            appliedNetworkRuleCount: 12,
            whitelistRuleCount: 0,
            trackingUrlCleanupRuleCount: 0,
            trackingUrlCleanupActive: false
          },
          subscriptions: { enabled: 1, total: 1, appliedNetwork: 12, cosmetic: 4, scriptlet: 0, withErrors: 0 },
          scriptlets: { apiAvailable: true, registeredUserScriptCount: 0, storedRuleCount: 0 },
          cosmetic: { subscriptionCosmeticRuleCount: 4, enabledLocalZapperRuleCount: 0, localZapperRuleCount: 0 },
          proxy: { configuredCount: 0, acceptedCount: 0, routedDomainCount: 0, globalProxyEnabled: false, globalProxyConfigured: false },
          webrtc: { available: true, mode: 'auto', protected: true },
          requestLog: { available: true, entryCount: 0, maxEntries: 200, note: '' }
        }
      }
    });

    await harness.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    const bodyText = harness.dom.window.document.querySelector('#healthPanelBody').textContent;
    assert.match(bodyText, /Tracking URL cleanup\s*Not registered/i);
    assert.match(bodyText, /DNR redirect rule is not registered/i);
  });

  await t.test('stats skeleton is replaced on success and on unavailable response', async () => {
    const success = createSettingsHarness();
    await success.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    assert.ok(success.messages.some(message => message.type === 'STATS_GET' && !message.options?.summaryOnly));
    assert.strictEqual(success.dom.window.document.querySelector('#statisticsTopCards .skeleton-card'), null);
    assert.match(success.dom.window.document.querySelector('#statisticsTopCards').textContent, /Total Protection Events/);
    assert.strictEqual(success.dom.window.document.querySelector('#statsModeSelect').disabled, false);

    const failure = createSettingsHarness({ responses: { STATS_GET: null } });
    await failure.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    assert.strictEqual(failure.dom.window.document.querySelector('#statisticsTopCards .skeleton-card'), null);
    assert.match(failure.dom.window.document.querySelector('#statsSitesList').textContent, /No stats available/);
    assert.strictEqual(failure.dom.window.document.querySelector('#statsModeSelect').disabled, true);
  });

  await t.test('config-backed toggles stay pending until CONFIG_GET resolves', async () => {
    const pendingConfig = deferred();
    const harness = createSettingsHarness({ pending: { CONFIG_GET: pendingConfig } });

    const initPromise = harness.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork(2);

    assert.strictEqual(harness.dom.window.document.querySelector('#toggleEnabled').disabled, true);
    assert.ok(harness.dom.window.document.querySelector('#toggleNetwork').classList.contains('control-pending'));

    pendingConfig.resolve({ enabled: true, networkBlocking: false, acceleration: true, accelerationSpeed: 12 });
    await initPromise;

    assert.strictEqual(harness.dom.window.document.querySelector('#toggleEnabled').disabled, false);
    assert.strictEqual(harness.dom.window.document.querySelector('#toggleNetwork').checked, false);
    assert.strictEqual(harness.dom.window.document.querySelector('#toggleAcceleration').checked, true);
    assert.strictEqual(harness.dom.window.document.querySelector('#toggleQuietConsole').checked, false);
    assert.ok(harness.dom.window.document.querySelector('.speed-btn[data-speed="12"]').classList.contains('active'));
  });

  await t.test('quiet console toggle persists to config', async () => {
    const harness = createSettingsHarness({
      responses: {
        CONFIG_GET: {
          enabled: true,
          networkBlocking: true,
          quietConsole: false
        }
      }
    });

    await harness.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    const toggle = harness.dom.window.document.querySelector('#toggleQuietConsole');
    assert.ok(toggle);
    assert.strictEqual(toggle.checked, false);

    toggle.checked = true;
    toggle.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
    await settleDomAsyncWork();

    assert.ok(harness.messages.some(message =>
      message.type === 'CONFIG_SET' &&
      message.config?.quietConsole === true
    ));
  });

  await t.test('quiet console toggle is independent from master protection', async () => {
    const harness = createSettingsHarness({
      responses: {
        CONFIG_GET: {
          enabled: false,
          networkBlocking: true,
          quietConsole: true
        }
      }
    });

    await harness.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    const master = harness.dom.window.document.querySelector('#toggleEnabled');
    const quiet = harness.dom.window.document.querySelector('#toggleQuietConsole');
    assert.strictEqual(master.checked, false);
    assert.strictEqual(quiet.checked, true);

    harness.messages.length = 0;
    quiet.checked = false;
    quiet.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
    await settleDomAsyncWork();

    assert.ok(harness.messages.some(message =>
      message.type === 'CONFIG_SET' &&
      message.config?.quietConsole === false &&
      !Object.prototype.hasOwnProperty.call(message.config, 'enabled')
    ));
    assert.strictEqual(master.checked, false);
  });

  await t.test('settings config null keeps controls disabled and shows an error', async () => {
    const harness = createSettingsHarness({ responses: { CONFIG_GET: null } });

    await harness.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    assert.strictEqual(harness.dom.window.document.querySelector('#toggleEnabled').disabled, true);
    assert.strictEqual(harness.dom.window.document.querySelector('#toggleNetwork').disabled, true);
    assert.match(harness.dom.window.document.querySelector('.hydration-error--inline').textContent, /Settings are unavailable/);
    [
      'healthPanelBody',
      'statisticsTopCards',
      'statsRangeSummary',
      'statsSitesList',
      'statsRulesList',
      'statsTimelineList',
      'statsEventsList',
      'subscriptionList',
      'proxyRouterContainer',
      'localZapperRules'
    ].forEach(id => {
      const section = harness.dom.window.document.getElementById(id);
      assert.ok(section, `${id} should exist`);
      assert.strictEqual(section.querySelector('.skeleton-row, .skeleton-card, .skeleton-grid'), null, `${id} should not keep skeletons`);
      assert.match(section.textContent, /Unavailable until the extension background responds/);
    });
    assert.strictEqual(harness.messages.some(message => message.type === 'STATS_GET'), false);
  });

  await t.test('mutating toggles roll back when background writes fail', async () => {
    const harness = createSettingsHarness({
      responses: {
        CONFIG_GET: {
          enabled: true,
          networkBlocking: true,
          acceleration: false,
          cosmetic: true,
          fingerprintRandomization: true
        },
        CONFIG_SET: { ok: false, error: 'write failed' },
        WHITELIST_ADD: { ok: false, error: 'write failed' },
        FPR_WHITELIST_ADD: { ok: false, error: 'write failed' }
      }
    });
    const reloads = [];
    harness.sandbox.chrome.tabs.reload = id => reloads.push(id);

    await harness.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    const acceleration = harness.dom.window.document.querySelector('#toggleAcceleration');
    acceleration.checked = true;
    acceleration.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(acceleration.checked, false);

    const master = harness.dom.window.document.querySelector('#toggleEnabled');
    master.checked = false;
    master.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(master.checked, true);
    assert.strictEqual(harness.dom.window.document.querySelector('#toggleNetwork').checked, true);

    const whitelist = harness.dom.window.document.querySelector('#toggleWhitelist');
    whitelist.checked = true;
    whitelist.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(whitelist.checked, false);

    const fprWhitelist = harness.dom.window.document.querySelector('#toggleFprWhitelist');
    fprWhitelist.checked = true;
    fprWhitelist.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(fprWhitelist.checked, false);
    assert.deepStrictEqual(reloads, []);
  });

  await t.test('subscription controls roll back or stay visible when writes fail', async () => {
    const harness = createSettingsHarness({
      responses: {
        SUBSCRIPTION_GET: [{
          id: 'custom_test',
          name: 'Custom Test',
          url: 'https://lists.example/test.txt',
          enabled: true,
          isCustom: true,
          lastUpdated: 0,
          ruleCount: { network: 10, cosmetic: 0, scriptlet: 0 },
          compatibility: { translatedRegexFilter: 6, unsupportedUrlFilter: 1 }
        }],
        SUBSCRIPTION_SET: { ok: false, error: 'write failed' },
        SUBSCRIPTION_REMOVE: { ok: false, error: 'remove failed' }
      }
    });

    await harness.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    const descTexts = Array.from(harness.dom.window.document.querySelectorAll('#subscriptionList .desc'))
      .map(node => node.textContent);
    assert.ok(descTexts.includes('Network compatibility: 6 translated \u00b7 1 skipped'));

    const toggle = harness.dom.window.document.querySelector('.sub-toggle');
    toggle.checked = false;
    toggle.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(toggle.checked, true);
    assert.strictEqual(toggle.disabled, false);

    const deleteBtn = harness.dom.window.document.querySelector('.sub-delete-btn');
    deleteBtn.dispatchEvent(new harness.dom.window.Event('click', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(deleteBtn.disabled, false);
    assert.match(deleteBtn.title, /failed/i);
    assert.ok(harness.dom.window.document.querySelector('.sub-toggle'));
  });

  await t.test('local zapper controls roll back or stay visible when writes fail', async () => {
    const harness = createSettingsHarness({
      responses: {
        ZAPPER_RULES_GET: {
          rules: [{
            id: 'zapper_abc',
            domain: 'example.com',
            selector: '.ad-slot',
            enabled: true,
            createdAt: Date.now()
          }]
        },
        ZAPPER_RULE_SET: { ok: false, error: 'write failed' },
        ZAPPER_RULE_REMOVE: { ok: false, error: 'delete failed' }
      }
    });

    await harness.sandbox.ChromaApp.initSharedUI();
    await settleDomAsyncWork();

    const toggle = harness.dom.window.document.querySelector('.zapper-rule-toggle');
    toggle.checked = false;
    toggle.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(toggle.checked, true);
    assert.strictEqual(toggle.disabled, false);

    const deleteBtn = harness.dom.window.document.querySelector('.zapper-rule-delete');
    deleteBtn.dispatchEvent(new harness.dom.window.Event('click', { bubbles: true }));
    await settleDomAsyncWork();

    assert.strictEqual(deleteBtn.disabled, false);
    assert.match(deleteBtn.title, /failed/i);
    assert.ok(harness.dom.window.document.querySelector('.zapper-rule-toggle'));
  });

  await t.test('initSharedUI does not await slow settings section hydration', async () => {
    const slow = {
      STATS_GET: deferred(),
      HEALTH_GET: deferred(),
      SUBSCRIPTION_GET: deferred(),
      USER_SCRIPTLETS_GET: deferred(),
      PROXY_CONFIG_GET: deferred(),
      ZAPPER_RULES_GET: deferred()
    };
    const harness = createSettingsHarness({ pending: slow });

    await harness.sandbox.ChromaApp.initSharedUI();

    assert.ok(harness.messages.some(message => message.type === 'STATS_GET'));
    assert.ok(harness.messages.some(message => message.type === 'HEALTH_GET'));
    assert.ok(harness.messages.some(message => message.type === 'SUBSCRIPTION_GET'));
    assert.ok(harness.messages.some(message => message.type === 'USER_SCRIPTLETS_GET'));
    assert.ok(harness.messages.some(message => message.type === 'PROXY_CONFIG_GET'));
    assert.ok(harness.messages.some(message => message.type === 'ZAPPER_RULES_GET'));
    assert.ok(harness.dom.window.document.querySelector('#statisticsTopCards .skeleton-card'));
    assert.strictEqual(harness.dom.window.document.querySelector('#userScriptletRulesText').readOnly, true);
    assert.strictEqual(harness.dom.window.document.querySelector('#saveUserScriptletRulesBtn').disabled, true);
    assert.strictEqual(harness.dom.window.document.querySelector('#userScriptletRulesStatus').textContent, 'Loading rules...');

    slow.STATS_GET.resolve(null);
    slow.HEALTH_GET.resolve(null);
    slow.SUBSCRIPTION_GET.resolve([]);
    slow.USER_SCRIPTLETS_GET.resolve({
      sources: [],
      ruleText: '',
      parsedRuleCount: 0,
      availableResourceNames: []
    });
    slow.PROXY_CONFIG_GET.resolve([]);
    slow.ZAPPER_RULES_GET.resolve({ rules: [] });
  });

  await t.test('settings proxy hash scrolls proxy header after synchronous shell render', async () => {
    const harness = createSettingsHarness({ url: 'chrome-extension://test/ui/settings.html#proxySection' });
    await harness.sandbox.ChromaApp.initSharedUI();
    const section = harness.dom.window.document.querySelector('#proxySection');
    let scrollOptions = null;
    section.scrollIntoView = options => {
      scrollOptions = options;
    };

    harness.sandbox.ChromaApp.scrollToProxyHash();
    await settleDomAsyncWork();

    assert.strictEqual(scrollOptions?.behavior, 'smooth');
    assert.strictEqual(scrollOptions?.block, 'start');
  });

  await t.test('settings proxy hash ignores requestAnimationFrame timestamps', async () => {
    const harness = createSettingsHarness({ url: 'chrome-extension://test/ui/settings.html#proxySection' });
    await harness.sandbox.ChromaApp.initSharedUI();
    const section = harness.dom.window.document.querySelector('#proxySection');
    let scrollOptions = null;
    section.scrollIntoView = options => {
      scrollOptions = options;
    };
    harness.sandbox.requestAnimationFrame = callback => {
      callback(83.1);
    };

    harness.sandbox.ChromaApp.scrollToProxyHash();

    assert.strictEqual(scrollOptions?.behavior, 'smooth');
    assert.strictEqual(scrollOptions?.block, 'start');
  });

  await t.test('settings proxy hash still supports legacy proxy hash', async () => {
    const harness = createSettingsHarness({ url: 'chrome-extension://test/ui/settings.html#proxy' });
    await harness.sandbox.ChromaApp.initSharedUI();
    const section = harness.dom.window.document.querySelector('#proxySection');
    let scrolled = false;
    section.scrollIntoView = () => {
      scrolled = true;
    };

    harness.sandbox.ChromaApp.scrollToProxyHash();
    await settleDomAsyncWork();

    assert.strictEqual(scrolled, true);
  });

  await t.test('settings proxy hash scrolls proxy header again after proxy hydration', async () => {
    const slow = { PROXY_CONFIG_GET: deferred() };
    const harness = createSettingsHarness({
      url: 'chrome-extension://test/ui/settings.html#proxySection',
      pending: slow
    });
    await harness.sandbox.ChromaApp.initSharedUI();
    const section = harness.dom.window.document.querySelector('#proxySection');
    const scrollBlocks = [];
    section.scrollIntoView = options => {
      scrollBlocks.push(options?.block);
    };
    slow.PROXY_CONFIG_GET.resolve([]);
    await settleDomAsyncWork();

    assert.ok(scrollBlocks.includes('start'));
  });

  await t.test('settings proxy hash keeps realigning proxy header after delayed layout growth', async () => {
    const harness = createSettingsHarness({ url: 'chrome-extension://test/ui/settings.html#proxySection' });
    await harness.sandbox.ChromaApp.initSharedUI();
    const section = harness.dom.window.document.querySelector('#proxySection');
    const scrollCalls = [];
    section.scrollIntoView = options => {
      scrollCalls.push(options);
    };

    harness.sandbox.ChromaApp.scrollToProxyHash();
    await new Promise(resolve => setTimeout(resolve, 180));

    assert.strictEqual(scrollCalls.at(-1)?.behavior, 'auto');
    assert.strictEqual(scrollCalls.at(-1)?.block, 'start');
  });

  await t.test('skeleton CSS includes reduced-motion handling', () => {
    assert.match(uiCss, /\.skeleton-line/);
    assert.match(uiCss, /@keyframes skeleton-shimmer/);
    assert.match(uiCss, /prefers-reduced-motion: reduce/);
    assert.match(uiCss, /\.hydration-fade-in/);
    assert.match(
      uiCss,
      /\.protection-list\.hydration-fade-in\s*{[\s\S]*?animation:\s*border-cycle 16s linear infinite,\s*hydration-fade-in 0\.18s ease-out;[\s\S]*?}/
    );
  });
});
