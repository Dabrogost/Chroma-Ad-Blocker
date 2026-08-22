/**
 * Proxy router: PAC script generation, domain expansion, auth handling,
 * and the per-proxy test runner.
 *
 * Importing this module installs the storage and webRequest listeners and
 * runs the legacy single-config migration.
 */

'use strict';

import { decryptAuth } from '../core/crypto.js';
import { recordStatsEvent } from './stats.js';
import { clearHealthDiagnostic, recordHealthDiagnostic } from './diagnostics.js';
import { mutateStoredConfig } from './configCoordinator.js';

const DEBUG = false;

let _currentTestSession = null;
let _proxyTestLock = Promise.resolve();
// Serializes PAC writes so back-to-back storage events can't race and let an
// older PAC win at chrome.proxy.settings.set().
let _syncQueue = Promise.resolve();
let _pendingProxyAuthChallenges = 0;
let _proxyAuthStatsTimer = null;
const PROXY_TEST_ENDPOINTS = Object.freeze([
  {
    id: 'cloudflare-trace',
    url: 'https://www.cloudflare.com/cdn-cgi/trace',
    domains: ['www.cloudflare.com', 'cloudflare.com'],
    parse: text => text.match(/^ip=(.+)$/m)?.[1]?.trim()
  },
  {
    id: 'aws-checkip',
    url: 'https://checkip.amazonaws.com/',
    domains: ['checkip.amazonaws.com'],
    parse: text => text.trim()
  },
  {
    id: 'ipify',
    url: 'https://api64.ipify.org?format=json',
    domains: ['api64.ipify.org'],
    parse: text => JSON.parse(text).ip
  },
  {
    id: 'icanhazip',
    url: 'https://icanhazip.com/',
    domains: ['icanhazip.com'],
    parse: text => text.trim()
  }
]);
const PROXY_TEST_DOMAINS = Object.freeze(
  [...new Set(PROXY_TEST_ENDPOINTS.flatMap(endpoint => endpoint.domains))]
);
const PROXY_TEST_CACHE_TTL_MS = 60_000;
const _proxyTestCache = new Map();
let _proxyConfigRevision = 0;
const VALID_PAC_TYPES = new Set(['PROXY', 'HTTPS', 'SOCKS4', 'SOCKS5']);
const PROXY_AUTH_STATS_FLUSH_MS = 10000;
const PROXY_AUTH_STATS_BATCH_CAP = 25;
const PROXY_AUTH_ATTEMPT_TTL_MS = 60_000;
const PROXY_AUTH_ATTEMPT_CAP = 1024;
const CONTROLLABLE_PROXY_LEVELS = new Set([
  'controllable_by_this_extension',
  'controlled_by_this_extension'
]);
const PROXY_CONTROL_DIAGNOSTIC_ID = 'proxyControl';
const EMPTY_ROUTE_MODEL = Object.freeze({
  specificRoutes: Object.freeze([]),
  globalRoute: null,
  routeCount: 0,
  hasRoutes: false,
  globalRequested: false,
  testRequested: false,
  chromeServiceBypassEnabled: true
});
let _routeGeneration = 0;
let _effectiveRouteGeneration = 0;
let _requestedRouteModel = EMPTY_ROUTE_MODEL;
let _effectiveRouteModel = EMPTY_ROUTE_MODEL;
let _desiredPacData = null;
let _controlRecoveryQueued = false;
let _controlRecoveryDirty = false;
let _lastControlDiagnosticKey = null;
const _authAttempts = new Map();
let _proxyRuntimeStatus = {
  available: !!chrome.proxy?.settings,
  levelOfControl: null,
  controlledByThisExtension: false,
  conflict: false,
  requested: { active: false, routeCount: 0, global: false, test: false },
  effective: { active: false, routeCount: 0, global: false },
  mode: null,
  error: null
};
const CHROME_SERVICE_BYPASS_DOMAINS = [
  'optimizationguide-pa.googleapis.com',
  'optimizationguide.googleapis.com',
  'gemini.google.com',
  'bard.google.com',
  'generativelanguage.googleapis.com',
  'accounts.google.com',
  'oauthaccountmanager.googleapis.com',
  'update.googleapis.com',
  'tools.google.com',
  'clients1.google.com',
  'clients2.google.com',
  'clients3.google.com',
  'clients4.google.com',
  'clients5.google.com',
  'clients6.google.com',
  'dl.google.com',
  'dl-ssl.google.com',
  'edgedl.me.gvt1.com',
  'redirector.gvt1.com',
  'redirector.gvt2.com',
  'gvt1.com',
  'gvt2.com',
  'gvt3.com',
  'storage.googleapis.com',
  'commondatastorage.googleapis.com',
  'www.googleapis.com',
  'aratea-pa.googleapis.com',
  'scone-pa.clients6.google.com',
  'gstatic.com',
  'googleusercontent.com'
];
const YOUTUBE_SMART_LINK_DOMAINS = [
  'googlevideo.com',
  'ytimg.com',
  'ggpht.com',
  'youtube-nocookie.com',
  'youtu.be',
  'youtubei.googleapis.com',
  'youtube.googleapis.com'
];
const PROXY_DOMAIN_EXPANSION = {
  'youtube.com':   YOUTUBE_SMART_LINK_DOMAINS,
  'youtu.be':      ['youtube.com', ...YOUTUBE_SMART_LINK_DOMAINS.filter(domain => domain !== 'youtu.be')],
  'twitch.tv':     ['ttvnw.net', 'jtvnw.net', 'twitchcdn.net'],
  'netflix.com':   ['netflix.net', 'nflxvideo.net', 'nflxext.com', 'nflximg.com', 'nflximg.net', 'nflxso.net', 'nflxsearch.net'],
  'amazon.com':    ['amazonvideo.com', 'primevideo.com', 'aiv-cdn.net', 'pv-cdn.net', 'aiv-delivery.net', 'media-amazon.com', 'ssl-images-amazon.com'],
  'primevideo.com':['amazon.com', 'amazonvideo.com', 'aiv-cdn.net', 'pv-cdn.net', 'aiv-delivery.net', 'media-amazon.com', 'ssl-images-amazon.com'],
  'disneyplus.com':['disney-plus.net', 'dssott.com', 'dssedge.com', 'bamgrid.com', 'disney-plus.com'],
  'hulu.com':      ['hulumail.com', 'huluim.com', 'hulu.hbomax.com'],
  'max.com':       ['hbomax.com', 'hbo.com', 'hbonow.com', 'hbogo.com'],
  'spotify.com':   ['scdn.co', 'spotify.net', 'audio-ak-spotify-com.akamaized.net']
};

function expandDomains(domains) {
  const expanded = new Set(domains);

  for (const d of domains) {
    // Exact match
    if (PROXY_DOMAIN_EXPANSION[d]) {
      PROXY_DOMAIN_EXPANSION[d].forEach(ext => expanded.add(ext));
    }

    // Handle 'www.' prefix
    const base = d.replace(/^www\./, '');
    if (PROXY_DOMAIN_EXPANSION[base]) {
      PROXY_DOMAIN_EXPANSION[base].forEach(ext => expanded.add(ext));
    }

    // Special Case: Amazon TLDs (amazon.co.uk, amazon.de, etc.)
    if (base.startsWith('amazon.') && base !== 'amazon.com') {
      PROXY_DOMAIN_EXPANSION['amazon.com'].forEach(ext => expanded.add(ext));
    }
  }
  return Array.from(expanded);
}

function buildPacDomainConditions(domains) {
  return domains
    .map(d => `host === ${JSON.stringify(d)} || dnsDomainIs(host, ${JSON.stringify('.' + d)})`)
    .join(' || ');
}

function shuffleEndpoints(endpoints) {
  const copy = [...endpoints];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function isLikelyIp(value) {
  if (typeof value !== 'string') return false;
  const ip = value.trim();
  if (!ip || ip.length > 64) return false;
  const ipv4Parts = ip.split('.');
  if (ipv4Parts.length === 4 && ipv4Parts.every(part => /^\d{1,3}$/.test(part))) {
    return ipv4Parts.every(part => Number(part) >= 0 && Number(part) <= 255);
  }
  return (
    ip.includes(':') &&
    /^[a-f0-9:]+$/i.test(ip)
  );
}

async function fetchProxyIp(signal) {
  const endpoints = shuffleEndpoints(PROXY_TEST_ENDPOINTS).slice(0, 2);
  let lastError = 'No verification endpoint available';

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint.url, {
        signal,
        cache: 'no-cache'
      });

      if (!res.ok) {
        lastError = `${endpoint.id}: HTTP ${res.status}`;
        continue;
      }

      const text = await res.text();
      const ip = endpoint.parse(text);

      if (!isLikelyIp(ip)) {
        lastError = `${endpoint.id}: invalid IP response`;
        continue;
      }

      return {
        ok: true,
        ip: ip.trim(),
        providerId: endpoint.id
      };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      lastError = `${endpoint.id}: ${err?.message || 'request failed'}`;
    }
  }

  return {
    ok: false,
    error: lastError
  };
}

function normalizeProxyHost(value) {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  return isSafeHost(host) ? host : null;
}

function normalizeProxyPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function normalizeProxyType(value) {
  const type = typeof value === 'string' ? value.toUpperCase() : '';
  return VALID_PAC_TYPES.has(type) ? type : null;
}

function canonicalizeProxyConfig(pc) {
  if (!pc || pc.accepted !== true) return null;
  const id = Number.isSafeInteger(pc.id) ? pc.id : null;
  const type = normalizeProxyType(pc.type);
  const host = normalizeProxyHost(pc.host);
  const port = normalizeProxyPort(pc.port);
  if (id === null || !type || !host || port == null) return null;
  return {
    id,
    accepted: true,
    type,
    host,
    port,
    enabled: pc.enabled !== false,
    domains: Array.isArray(pc.domains) ? pc.domains : [],
    authIv: pc.authIv,
    authCipher: pc.authCipher
  };
}

function getProxyString(pc) {
  const normalized = canonicalizeProxyConfig(pc);
  const type = normalized?.type;
  const host = normalized?.host;
  const port = normalized?.port;

  if (!type || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return "'DIRECT'";
  }

  return JSON.stringify(`${type} ${host}:${port}`);
}

function isSafeHost(host) {
  return typeof host === 'string' &&
    host.length > 0 &&
    host.length <= 253 &&
    /^[a-z0-9.-]+$/i.test(host) &&
    !host.includes('..') &&
    !host.startsWith('.') &&
    !host.endsWith('.');
}

function isSafeProxyConfig(pc) {
  return canonicalizeProxyConfig(pc) !== null;
}

function isProxyEnabled(pc) {
  return pc?.enabled !== false;
}

function hasStoredAuth(pc) {
  return !!(pc && pc.authIv && pc.authCipher);
}

function getProxyTestCacheFingerprint(pc) {
  const normalized = canonicalizeProxyConfig(pc);
  return JSON.stringify({
    id: normalized?.id,
    type: normalized?.type,
    host: normalized?.host,
    port: normalized?.port,
    enabled: normalized?.enabled === true,
    hasAuth: hasStoredAuth(pc),
    revision: _proxyConfigRevision
  });
}

function flushProxyAuthStats() {
  if (_proxyAuthStatsTimer) {
    clearTimeout(_proxyAuthStatsTimer);
    _proxyAuthStatsTimer = null;
  }

  const count = _pendingProxyAuthChallenges;
  _pendingProxyAuthChallenges = 0;
  if (count > 0) {
    recordStatsEvent({ layer: 'proxy', type: 'auth_challenge', count });
  }
}

function recordProxyAuthChallenge() {
  _pendingProxyAuthChallenges++;

  if (_pendingProxyAuthChallenges >= PROXY_AUTH_STATS_BATCH_CAP) {
    flushProxyAuthStats();
    return;
  }

  if (!_proxyAuthStatsTimer) {
    _proxyAuthStatsTimer = setTimeout(flushProxyAuthStats, PROXY_AUTH_STATS_FLUSH_MS);
  }
}

function getEnabledRouteDomains(pc) {
  if (!Array.isArray(pc.domains)) return [];
  return pc.domains
    .filter(d => d && d.enabled !== false && typeof d.host === 'string')
    .map(d => normalizeProxyHost(d.host))
    .filter(Boolean);
}

function routeFingerprint(pc) {
  return JSON.stringify({
    id: pc?.id,
    type: pc?.type,
    host: pc?.host,
    port: pc?.port,
    enabled: pc?.enabled === true
  });
}

function domainMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

function getRequestHostname(requestUrl) {
  try {
    const host = String(new URL(requestUrl).hostname || '').toLowerCase().replace(/\.$/, '');
    return host && host.length <= 253 ? host : null;
  } catch {
    return null;
  }
}

function resolveRouteForRequest(routeModel, requestUrl) {
  if (!routeModel?.hasRoutes) return null;
  const requestHost = getRequestHostname(requestUrl);
  if (!requestHost) return null;
  if (
    routeModel.chromeServiceBypassEnabled &&
    CHROME_SERVICE_BYPASS_DOMAINS.some(domain => domainMatches(requestHost, domain))
  ) {
    return null;
  }
  for (const route of routeModel.specificRoutes) {
    if (route.domains.some(domain => domainMatches(requestHost, domain))) return route.proxy;
  }
  return routeModel.globalRoute?.proxy || null;
}

function findAuthProxyConfig(routeModel, requestUrl, challengerHost, challengerPort) {
  const route = resolveRouteForRequest(routeModel, requestUrl);
  if (!route || (route.type !== 'PROXY' && route.type !== 'HTTPS') || !hasStoredAuth(route)) return null;
  const host = normalizeProxyHost(challengerHost);
  const port = normalizeProxyPort(challengerPort);
  if (!host || port == null || host !== route.host || port !== route.port) return null;
  return route;
}

function isProxyEffectivelyRouted(pc) {
  const normalized = canonicalizeProxyConfig(pc);
  if (!normalized || !_effectiveRouteModel.hasRoutes) return false;
  const fingerprint = routeFingerprint(normalized);
  return _effectiveRouteModel.specificRoutes.some(route => routeFingerprint(route.proxy) === fingerprint) ||
    routeFingerprint(_effectiveRouteModel.globalRoute?.proxy) === fingerprint;
}

function isProxyEffectiveForTestEndpoints(pc) {
  const normalized = canonicalizeProxyConfig(pc);
  if (!normalized || !_effectiveRouteModel.hasRoutes) return false;
  const fingerprint = routeFingerprint(normalized);
  return PROXY_TEST_DOMAINS.every(domain =>
    routeFingerprint(resolveRouteForRequest(_effectiveRouteModel, `https://${domain}/`)) === fingerprint
  );
}

function getProxyRuntimeStatusSnapshot() {
  return {
    available: _proxyRuntimeStatus.available,
    levelOfControl: _proxyRuntimeStatus.levelOfControl,
    controlledByThisExtension: _proxyRuntimeStatus.controlledByThisExtension,
    conflict: _proxyRuntimeStatus.conflict,
    requested: { ..._proxyRuntimeStatus.requested },
    effective: { ..._proxyRuntimeStatus.effective },
    mode: _proxyRuntimeStatus.mode,
    error: _proxyRuntimeStatus.error
  };
}

function isControllableProxyLevel(levelOfControl) {
  return CONTROLLABLE_PROXY_LEVELS.has(levelOfControl);
}

function proxyValueMatchesDesired(value) {
  return !!(
    _requestedRouteModel.hasRoutes &&
    _desiredPacData &&
    value?.mode === 'pac_script' &&
    value?.pacScript?.data === _desiredPacData
  );
}

async function syncProxyControlDiagnostic() {
  const status = _proxyRuntimeStatus;
  const needsDiagnostic = (status.requested.active && !status.effective.active) || !!status.error;
  const diagnosticKey = needsDiagnostic
    ? `${status.available}:${status.levelOfControl || 'unknown'}:${status.error || ''}`
    : 'clear';
  if (_lastControlDiagnosticKey === diagnosticKey) return;
  _lastControlDiagnosticKey = diagnosticKey;
  if (diagnosticKey === 'clear') {
    await clearHealthDiagnostic(PROXY_CONTROL_DIAGNOSTIC_ID);
    return;
  }
  await recordHealthDiagnostic(PROXY_CONTROL_DIAGNOSTIC_ID, {
    area: 'proxy',
    severity: 'warning',
    message: status.error && !status.requested.active
      ? 'Chroma proxy settings were not fully released.'
      : (status.conflict
          ? 'Proxy routing is requested but Chrome proxy settings are controlled elsewhere.'
          : 'Proxy routing is requested but is not effective.'),
    action: status.conflict
      ? 'Release proxy control from the other extension or browser policy.'
      : 'Disable and re-enable the requested proxy route.',
    error: status.error
  });
}

async function applyObservedProxyControl(details, generation = _routeGeneration, error = null) {
  if (generation !== _routeGeneration) return getProxyRuntimeStatusSnapshot();
  const levelOfControl = details?.levelOfControl || null;
  const controlledByThisExtension = levelOfControl === 'controlled_by_this_extension';
  const effective = controlledByThisExtension && proxyValueMatchesDesired(details?.value);
  let statusError = error ? String(error?.message || error) : null;
  if (!statusError && controlledByThisExtension && _requestedRouteModel.hasRoutes && !effective) {
    statusError = 'Chrome proxy settings do not match the requested PAC route';
  }
  if (!statusError && controlledByThisExtension && !_requestedRouteModel.hasRoutes &&
      details?.value?.mode === 'pac_script') {
    statusError = 'Chrome still reports a Chroma-controlled PAC route after release';
  }
  _effectiveRouteModel = effective ? _requestedRouteModel : EMPTY_ROUTE_MODEL;
  _effectiveRouteGeneration = effective ? generation : 0;
  _proxyRuntimeStatus = {
    available: !!chrome.proxy?.settings && !error,
    levelOfControl,
    controlledByThisExtension,
    conflict: _requestedRouteModel.hasRoutes && !!levelOfControl && !isControllableProxyLevel(levelOfControl),
    requested: {
      active: _requestedRouteModel.hasRoutes,
      routeCount: _requestedRouteModel.routeCount,
      global: _requestedRouteModel.globalRequested,
      test: _requestedRouteModel.testRequested
    },
    effective: {
      active: effective,
      routeCount: effective ? _requestedRouteModel.routeCount : 0,
      global: effective && !!_requestedRouteModel.globalRoute
    },
    mode: details?.value?.mode || null,
    error: statusError
  };
  await syncProxyControlDiagnostic();
  return getProxyRuntimeStatusSnapshot();
}

async function inspectProxyControl(generation = _routeGeneration) {
  if (!chrome.proxy?.settings || typeof chrome.proxy.settings.get !== 'function') {
    return applyObservedProxyControl(null, generation, 'Chrome proxy settings inspection is unavailable');
  }
  try {
    const details = await chrome.proxy.settings.get({ incognito: false });
    return applyObservedProxyControl(details, generation);
  } catch (error) {
    return applyObservedProxyControl(null, generation, error);
  }
}

export async function getProxyRoutingStatus({ refresh = false } = {}) {
  if (refresh) await inspectProxyControl();
  return getProxyRuntimeStatusSnapshot();
}

function invalidateProxyRouteAuthority() {
  const generation = ++_routeGeneration;
  _requestedRouteModel = EMPTY_ROUTE_MODEL;
  _effectiveRouteModel = EMPTY_ROUTE_MODEL;
  _effectiveRouteGeneration = 0;
  _desiredPacData = null;
  _proxyRuntimeStatus = {
    ..._proxyRuntimeStatus,
    requested: { active: false, routeCount: 0, global: false, test: false },
    effective: { active: false, routeCount: 0, global: false }
  };
  return generation;
}

export function syncProxyState(proxyConfigs) {
  const generation = invalidateProxyRouteAuthority();
  const operation = _syncQueue.then(() => _syncProxyStateImpl(proxyConfigs, generation));
  const next = operation.catch(async error => {
    if (generation === _routeGeneration) await applyObservedProxyControl(null, generation, error);
    await recordHealthDiagnostic('proxyPacSync', {
      area: 'proxy',
      severity: 'warning',
      message: 'Proxy routing state could not be reconciled.',
      action: 'Open proxy settings and save the desired route again.',
      error: error?.message || error
    });
    return getProxyRuntimeStatusSnapshot();
  });
  _syncQueue = next.then(() => {}, () => {}); // never let a failure stall the queue
  return next;
}

async function _syncProxyStateImpl(proxyConfigs, generation) {
  const sourceConfigs = Array.isArray(proxyConfigs) ? proxyConfigs : [];
  const { config = {} } = await chrome.storage.local.get('config');
  if (generation !== _routeGeneration) return getProxyRuntimeStatusSnapshot();
  const masterEnabled = config?.enabled !== false;
  if (!masterEnabled) _currentTestSession = null;
  let globalEnabled = config?.globalProxyEnabled === true;
  let globalId = config?.globalProxyId;
  const chromeServiceBypassEnabled = config?.chromeServiceProxyBypass !== false;
  const canonicalConfigs = sourceConfigs.map(canonicalizeProxyConfig).filter(Boolean);
  const selectedGlobalProxy = globalEnabled && globalId != null
    ? canonicalConfigs.find(pc => pc.id === globalId) || null
    : null;

  if (globalEnabled && globalId != null && !selectedGlobalProxy) {
    await mutateStoredConfig(latestConfig => {
      if (generation !== _routeGeneration) return null;
      const latestId = latestConfig?.globalProxyId;
      const latestSelectionIsInvalid = latestConfig?.globalProxyEnabled === true &&
        latestId != null &&
        !canonicalConfigs.some(pc => pc.id === latestId);
      return latestSelectionIsInvalid
        ? { ...latestConfig, globalProxyEnabled: false, globalProxyId: null }
        : null;
    });
    if (generation !== _routeGeneration) return getProxyRuntimeStatusSnapshot();
    globalEnabled = false;
    globalId = null;
  }

  let scriptData = "function FindProxyForURL(url, host) { \n";
  scriptData += "  host = String(host || '').toLowerCase().replace(/\\.$/, '');\n";
  let fallbackStr = "'DIRECT'";
  const specificRoutes = [];
  let globalRoute = null;

  if (chromeServiceBypassEnabled) {
    scriptData += `  if (${buildPacDomainConditions(CHROME_SERVICE_BYPASS_DOMAINS)}) return 'DIRECT';\n`;
  }

  const testProxy = masterEnabled && _currentTestSession
    ? canonicalConfigs.find(pc =>
        pc.enabled && pc.id === _currentTestSession.id &&
        routeFingerprint(pc) === _currentTestSession.fingerprint
      ) || null
    : null;
  if (testProxy) {
    scriptData += `  if (${buildPacDomainConditions(PROXY_TEST_DOMAINS)}) return ${getProxyString(testProxy)};\n`;
    specificRoutes.push({ proxy: testProxy, domains: [...PROXY_TEST_DOMAINS], test: true });
  }

  for (const pc of canonicalConfigs) {
    const { id } = pc;

    const proxyStr = getProxyString(pc);
    const routeDomains = masterEnabled && pc.enabled ? expandDomains(getEnabledRouteDomains(pc)) : [];
    const uniqueRouteDomains = [...new Set(routeDomains)];

    // 1. Add Domain-Specific Rules
    if (uniqueRouteDomains.length > 0) {
      scriptData += `  if (${buildPacDomainConditions(uniqueRouteDomains)}) return ${proxyStr};\n`;
      specificRoutes.push({ proxy: pc, domains: uniqueRouteDomains });
    }

    // 2. Identify the Global Fallback
    if (masterEnabled && pc.enabled && selectedGlobalProxy && id === globalId) {
      fallbackStr = proxyStr;
      globalRoute = { proxy: pc };
    }
  }

  scriptData += `  return ${fallbackStr};\n}`;
  const routeKeys = new Set(specificRoutes.map(route => routeFingerprint(route.proxy)));
  if (globalRoute) routeKeys.add(routeFingerprint(globalRoute.proxy));
  const requestedRouteModel = {
    specificRoutes,
    globalRoute,
    routeCount: routeKeys.size,
    hasRoutes: routeKeys.size > 0,
    globalRequested: masterEnabled && globalEnabled,
    testRequested: !!testProxy,
    chromeServiceBypassEnabled
  };

  if (generation !== _routeGeneration) return getProxyRuntimeStatusSnapshot();
  _requestedRouteModel = requestedRouteModel;
  _desiredPacData = requestedRouteModel.hasRoutes ? scriptData : null;
  _proxyRuntimeStatus = {
    ..._proxyRuntimeStatus,
    requested: {
      active: requestedRouteModel.hasRoutes,
      routeCount: requestedRouteModel.routeCount,
      global: requestedRouteModel.globalRequested,
      test: requestedRouteModel.testRequested
    },
    effective: { active: false, routeCount: 0, global: false },
    error: null
  };

  try {
    const before = await inspectProxyControl(generation);
    if (generation !== _routeGeneration) return getProxyRuntimeStatusSnapshot();
    if (!before.available) return before;

    if (requestedRouteModel.hasRoutes && before.effective.active) {
      await clearHealthDiagnostic('proxyPacSync');
      return before;
    }

    // When we have no routing to do, release chrome.proxy.settings so other
    // proxy/VPN extensions can take control. Chrome only lets one extension
    // own this setting at a time, and calling .set() — even with a no-op
    // DIRECT PAC — would bump them to "controlled_by_other_extensions".
    if (!requestedRouteModel.hasRoutes) {
      const alreadyReleased = before.levelOfControl !== 'controlled_by_this_extension' ||
        before.mode !== 'pac_script';
      if (alreadyReleased && before.levelOfControl === 'controllable_by_this_extension') {
        await clearHealthDiagnostic('proxyPacSync');
        return before;
      }
      await chrome.proxy.settings.clear({ scope: 'regular' });
      if (generation !== _routeGeneration) return getProxyRuntimeStatusSnapshot();
      await inspectProxyControl(generation);
      await clearHealthDiagnostic('proxyPacSync');
      if (DEBUG) console.log('[Chroma Ad-Blocker] No active proxies; released proxy settings.');
      return getProxyRuntimeStatusSnapshot();
    }

    if (!isControllableProxyLevel(before.levelOfControl)) {
      // Remove any dormant Chroma preference while another controller wins;
      // otherwise Chrome could reactivate an obsolete PAC when that control
      // is later released.
      await chrome.proxy.settings.clear({ scope: 'regular' });
      if (generation !== _routeGeneration) return getProxyRuntimeStatusSnapshot();
      await inspectProxyControl(generation);
      return getProxyRuntimeStatusSnapshot();
    }

    await chrome.proxy.settings.set({
      value: { mode: 'pac_script', pacScript: { data: scriptData } },
      scope: 'regular'
    });
    if (generation !== _routeGeneration) return getProxyRuntimeStatusSnapshot();
    await inspectProxyControl(generation);
    await clearHealthDiagnostic('proxyPacSync');
    if (DEBUG) console.log('[Chroma Ad-Blocker] Proxy PAC script synced. Total configs:', sourceConfigs.length);
    return getProxyRuntimeStatusSnapshot();
  } catch (err) {
    if (generation === _routeGeneration) await applyObservedProxyControl(null, generation, err);
    await recordHealthDiagnostic('proxyPacSync', {
      area: 'proxy',
      severity: 'warning',
      message: 'Proxy PAC settings could not be applied.',
      action: 'Check proxy settings, or disable and re-enable the selected proxy route.',
      error: err?.message || err
    });
    if (DEBUG) console.error('[Chroma Ad-Blocker] Failed to update proxy settings:', err);
    return getProxyRuntimeStatusSnapshot();
  }
}

/**
 * Encapsulates the sequential lock + PAC-swap + fetch flow for a proxy test.
 */
async function finishProxyTestSession() {
  if (!_currentTestSession) return;
  _currentTestSession = null;
  invalidateProxyRouteAuthority();
  let latestProxyConfigs = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const revision = _proxyConfigRevision;
    const stored = await chrome.storage.local.get('proxyConfigs');
    latestProxyConfigs = Array.isArray(stored.proxyConfigs) ? stored.proxyConfigs : [];
    if (revision === _proxyConfigRevision) break;
  }
  await syncProxyState(latestProxyConfigs);
}

async function canUseProxyTestCache(pc) {
  const status = await inspectProxyControl();
  return status.effective.active && isProxyEffectivelyRouted(pc);
}

export async function runProxyTest(proxyId) {
  const { proxyConfigs: cachedProxyConfigs = [] } = await chrome.storage.local.get('proxyConfigs');
  const cachedPc = proxyId === undefined
    ? null
    : cachedProxyConfigs.find(p => p.id === proxyId && isSafeProxyConfig(p) && isProxyEnabled(p));

  if (!cachedPc) {
    recordStatsEvent({ layer: 'proxy', type: 'test_failure', error: 'Proxy not configured' });
    return { ok: false, error: 'Proxy not configured' };
  }

  const cacheFingerprint = getProxyTestCacheFingerprint(cachedPc);
  const cached = _proxyTestCache.get(cachedPc.id);
  if (
    cached?.ok === true &&
    cached.fingerprint === cacheFingerprint &&
    Date.now() - cached.checkedAt < PROXY_TEST_CACHE_TTL_MS
  ) {
    if (await canUseProxyTestCache(cachedPc)) {
      const { checkedAt, fingerprint, ...cachedResult } = cached;
      return cachedResult;
    }
    _proxyTestCache.delete(cachedPc.id);
  }

  const currentLock = _proxyTestLock;
  const nextLock = (async () => {
    await currentLock;
    try {
      const { proxyConfigs = [] } = await chrome.storage.local.get('proxyConfigs');
      const pc = proxyId === undefined
        ? null
        : proxyConfigs.find(p => p.id === proxyId && isSafeProxyConfig(p) && isProxyEnabled(p));

      if (!pc) {
        recordStatsEvent({ layer: 'proxy', type: 'test_failure', error: 'Proxy not configured' });
        return { ok: false, error: 'Proxy not configured' };
      }

      const lockedCacheFingerprint = getProxyTestCacheFingerprint(pc);
      const lockedCached = _proxyTestCache.get(pc.id);
      if (
        lockedCached?.ok === true &&
        lockedCached.fingerprint === lockedCacheFingerprint &&
        Date.now() - lockedCached.checkedAt < PROXY_TEST_CACHE_TTL_MS
      ) {
        if (await canUseProxyTestCache(pc)) {
          const { checkedAt, fingerprint, ...cachedResult } = lockedCached;
          return cachedResult;
        }
        _proxyTestCache.delete(pc.id);
      }

      const canonicalPc = canonicalizeProxyConfig(pc);
      _currentTestSession = {
        id: canonicalPc.id,
        fingerprint: routeFingerprint(canonicalPc)
      };
      const routeStatus = await syncProxyState(proxyConfigs);
      if (!routeStatus.effective.active || !isProxyEffectiveForTestEndpoints(canonicalPc)) {
        recordStatsEvent({ layer: 'proxy', type: 'test_failure', proxyId: pc.id, error: 'Proxy route is not effective' });
        await finishProxyTestSession();
        return { ok: false, error: 'Proxy route is not effective' };
      }
      await new Promise(r => setTimeout(r, 150)); // Tiny grace period for Chrome to apply PAC settings

      const beforeFetchStatus = await inspectProxyControl();
      if (!beforeFetchStatus.effective.active || !isProxyEffectiveForTestEndpoints(canonicalPc) ||
          _currentTestSession?.fingerprint !== routeFingerprint(canonicalPc)) {
        recordStatsEvent({ layer: 'proxy', type: 'test_failure', proxyId: pc.id, error: 'Proxy route lost control before test' });
        await finishProxyTestSession();
        return { ok: false, error: 'Proxy route lost control before test' };
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      try {
        const result = await fetchProxyIp(controller.signal);
        clearTimeout(timeoutId);
        if (result.ok) {
          const effectiveStatus = await inspectProxyControl();
          if (!effectiveStatus.effective.active || !isProxyEffectiveForTestEndpoints(pc)) {
            recordStatsEvent({ layer: 'proxy', type: 'test_failure', proxyId: pc.id, error: 'Proxy route lost control during test' });
            return { ok: false, error: 'Proxy route lost control during test' };
          }
          const { proxyConfigs: latestProxyConfigs = [] } = await chrome.storage.local.get('proxyConfigs');
          const latestPc = latestProxyConfigs.find(candidate =>
            candidate.id === pc.id && isSafeProxyConfig(candidate) && isProxyEnabled(candidate)
          );
          if (!latestPc || routeFingerprint(canonicalizeProxyConfig(latestPc)) !== _currentTestSession?.fingerprint ||
              !isProxyEffectiveForTestEndpoints(latestPc)) {
            recordStatsEvent({ layer: 'proxy', type: 'test_failure', proxyId: pc.id, error: 'Proxy route changed during test' });
            return { ok: false, error: 'Proxy route changed during test' };
          }
          const { ip, providerId } = result;
          const success = {
            ok: true,
            proxyId: pc.id,
            ip,
            providerId,
            fingerprint: lockedCacheFingerprint,
            checkedAt: Date.now()
          };
          _proxyTestCache.set(pc.id, success);
          recordStatsEvent({ layer: 'proxy', type: 'test_pass', proxyId: pc.id });
          return { ok: true, proxyId: pc.id, ip, providerId };
        }
        recordStatsEvent({ layer: 'proxy', type: 'test_failure', proxyId: pc.id, error: result.error });
        return { ok: false, error: result.error };
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        const error = fetchErr.name === 'AbortError' ? 'Timeout' : fetchErr.message;
        recordStatsEvent({ layer: 'proxy', type: 'test_failure', proxyId: pc.id, error });
        return { ok: false, error };
      } finally {
        await finishProxyTestSession();
      }
    } catch (err) {
      await finishProxyTestSession().catch(() => {});
      return { ok: false, error: err.message };
    }
  })();

  _proxyTestLock = nextLock.then(() => {}, () => {}); // always release even on error
  return nextLock;
}

// Listen for proxy config changes to update PAC script dynamically
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  const proxyConfigsChanged = !!changes.proxyConfigs;
  const oldC = changes.config?.oldValue;
  const newC = changes.config?.newValue;
  const routingConfigChanged = !!changes.config && (
    oldC?.enabled !== newC?.enabled ||
    oldC?.globalProxyEnabled !== newC?.globalProxyEnabled ||
    oldC?.globalProxyId !== newC?.globalProxyId ||
    oldC?.chromeServiceProxyBypass !== newC?.chromeServiceProxyBypass
  );
  if (!proxyConfigsChanged && !routingConfigChanged) return;

  if (proxyConfigsChanged) {
    _proxyConfigRevision++;
    _proxyTestCache.clear();
  }
  const listenerGeneration = invalidateProxyRouteAuthority();
  let desiredProxyConfigs = proxyConfigsChanged
    ? (Array.isArray(changes.proxyConfigs.newValue) ? changes.proxyConfigs.newValue : [])
    : null;

  if (proxyConfigsChanged) {
    const oldConfigs = Array.isArray(changes.proxyConfigs.oldValue) ? changes.proxyConfigs.oldValue : [];
    if (oldConfigs.length > desiredProxyConfigs.length) {
      await mutateStoredConfig(config => {
        if (listenerGeneration !== _routeGeneration || !config?.globalProxyId) return null;
        const stillExists = desiredProxyConfigs.some(pc => pc.id === config.globalProxyId);
        return stillExists
          ? null
          : { ...config, globalProxyEnabled: false, globalProxyId: null };
      });
    }
  }

  if (!desiredProxyConfigs) {
    const stored = await chrome.storage.local.get('proxyConfigs');
    if (listenerGeneration !== _routeGeneration) return;
    desiredProxyConfigs = Array.isArray(stored.proxyConfigs) ? stored.proxyConfigs : [];
  }
  if (listenerGeneration === _routeGeneration) syncProxyState(desiredProxyConfigs);
});

function scheduleProxyControlRecovery() {
  _controlRecoveryDirty = true;
  if (_controlRecoveryQueued) return;
  _controlRecoveryQueued = true;
  Promise.resolve().then(async () => {
    while (_controlRecoveryDirty) {
      _controlRecoveryDirty = false;
      const { proxyConfigs = [] } = await chrome.storage.local.get('proxyConfigs');
      await syncProxyState(Array.isArray(proxyConfigs) ? proxyConfigs : []);
    }
  }).catch(async error => {
    await recordHealthDiagnostic('proxyPacSync', {
      area: 'proxy',
      severity: 'warning',
      message: 'Proxy routing could not recover after Chrome proxy control changed.',
      action: 'Disable and re-enable the requested proxy route.',
      error: error?.message || error
    });
  }).finally(() => {
    _controlRecoveryQueued = false;
    if (_controlRecoveryDirty) scheduleProxyControlRecovery();
  });
}

if (chrome.proxy?.settings?.onChange?.addListener) {
  chrome.proxy.settings.onChange.addListener(details => {
    const generation = _routeGeneration;
    applyObservedProxyControl(details, generation).then(status => {
      const controllable = isControllableProxyLevel(details?.levelOfControl);
      const needsRecovery =
        (_requestedRouteModel.hasRoutes && !status.effective.active) ||
        (!_requestedRouteModel.hasRoutes && !!status.error);
      if (controllable && needsRecovery) {
        scheduleProxyControlRecovery();
      }
    }).catch(() => {});
  });
}

// Initialize proxy state on startup and drop legacy single-config storage.
chrome.storage.local.get(['proxyConfig', 'proxyConfigs']).then(async ({ proxyConfig, proxyConfigs }) => {
  if (proxyConfig && !Array.isArray(proxyConfigs)) {
    await chrome.storage.local.remove('proxyConfig');
  }
  await syncProxyState(Array.isArray(proxyConfigs) ? proxyConfigs : []);
}).catch(async error => {
  await recordHealthDiagnostic('proxyPacSync', {
    area: 'proxy',
    severity: 'warning',
    message: 'Stored proxy routing state could not be recovered.',
    action: 'Open proxy settings and save the desired route again.',
    error: error?.message || error
  });
});

// Proxy Authentication Handler
function reserveProxyAuthAttempt(requestId) {
  if (typeof requestId !== 'string' || !requestId) return false;
  const now = Date.now();
  for (const [id, timestamp] of _authAttempts) {
    if (now - timestamp < PROXY_AUTH_ATTEMPT_TTL_MS) break;
    _authAttempts.delete(id);
  }
  if (_authAttempts.has(requestId)) return false;
  if (_authAttempts.size >= PROXY_AUTH_ATTEMPT_CAP) return false;
  _authAttempts.set(requestId, now);
  return true;
}

chrome.webRequest.onAuthRequired.addListener(
  function(details, callback) {
    if (!details.isProxy) {
      callback({});
      return;
    }

    recordProxyAuthChallenge();

    const requestId = details.requestId;
    if (!reserveProxyAuthAttempt(requestId)) {
      if (DEBUG) console.warn('[Chroma Ad-Blocker] Proxy auth looped. Cancelling request.', details.url);
      callback({ cancel: true });
      return;
    }

    Promise.resolve().then(async () => {
      const status = await inspectProxyControl();
      if (!status.effective.active || _effectiveRouteGeneration === 0) return { cancel: true };
      const effectiveGeneration = _effectiveRouteGeneration;
      const pc = findAuthProxyConfig(
        _effectiveRouteModel,
        details.url,
        details.challenger?.host,
        details.challenger?.port
      );
      if (!pc) return { cancel: true };
      const auth = await decryptAuth(pc.authIv, pc.authCipher);
      if (_effectiveRouteGeneration !== effectiveGeneration) return { cancel: true };
      const username = auth?.username;
      const password = auth?.password;
      if (!username || !password) return { cancel: true };
      return { authCredentials: { username, password } };
    }).then(callback).catch(err => {
      if (DEBUG) console.error('[Chroma Ad-Blocker] Error in proxy auth:', err);
      callback({ cancel: true });
    });
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);
