'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { KNOWN_STRIPPER_FIELDS, walkJson } = require('./sanitize');

const YOUTUBE_ENDPOINTS = Object.freeze([
  { name: 'player', kind: 'json', marker: '/youtubei/v1/player' },
  { name: 'next', kind: 'json', marker: '/youtubei/v1/next' },
  { name: 'browse', kind: 'json', marker: '/youtubei/v1/browse' },
  { name: 'search', kind: 'json', marker: '/youtubei/v1/search' },
  { name: 'reel', kind: 'json', marker: '/youtubei/v1/reel' }
]);

const PROBE_STRIP_MODES = Object.freeze([
  'off',
  'delete',
  'empty',
  'keep-heartbeat',
  'empty-keep-heartbeat'
]);

const PROBE_STRIPPER_SCRIPT = String.raw`
(() => {
  const mode = __PROBE_STRIP_MODE__;
  if (!mode || mode === 'off') return;

  const AD_ARRAY_FIELDS = new Set(['adPlacements', 'adSlots', 'playerAds']);
  const AD_OBJECT_FIELDS = new Set(['adBreakParams', 'adBreakHeartbeatParams', 'adInferredBlockingStatus']);
  const YT_API_PATHS = [
    '/youtubei/v1/player',
    '/youtubei/v1/next',
    '/youtubei/v1/browse',
    '/youtubei/v1/search',
    '/youtubei/v1/reel'
  ];
  const stats = {
    mode,
    payloadsInspected: 0,
    payloadsModified: 0,
    fieldsDeleted: 0,
    fieldsEmptied: 0,
    sources: {}
  };

  function sourceStats(source) {
    stats.sources[source] ||= {
      payloadsInspected: 0,
      payloadsModified: 0,
      fieldsDeleted: 0,
      fieldsEmptied: 0
    };
    return stats.sources[source];
  }

  function record(source, changed, deleted, emptied) {
    const bucket = sourceStats(source);
    stats.payloadsInspected++;
    bucket.payloadsInspected++;
    if (!changed) return;
    stats.payloadsModified++;
    bucket.payloadsModified++;
    stats.fieldsDeleted += deleted;
    stats.fieldsEmptied += emptied;
    bucket.fieldsDeleted += deleted;
    bucket.fieldsEmptied += emptied;
  }

  function cloneEmptyValue(field, existing) {
    if (AD_ARRAY_FIELDS.has(field)) return [];
    if (AD_OBJECT_FIELDS.has(field)) return {};
    return Array.isArray(existing) ? [] : {};
  }

  function shouldKeepField(field) {
    return (mode === 'keep-heartbeat' || mode === 'empty-keep-heartbeat') &&
      field === 'adBreakHeartbeatParams';
  }

  function shouldEmptyFields() {
    return mode === 'empty' || mode === 'empty-keep-heartbeat';
  }

  function stripAdFields(obj) {
    if (!obj || typeof obj !== 'object') return { changed: false, deleted: 0, emptied: 0 };
    let changed = false;
    let deleted = 0;
    let emptied = 0;
    for (const field of [...AD_ARRAY_FIELDS, ...AD_OBJECT_FIELDS]) {
      if (!(field in obj) || shouldKeepField(field)) continue;
      if (shouldEmptyFields()) {
        obj[field] = cloneEmptyValue(field, obj[field]);
        emptied++;
      } else {
        delete obj[field];
        deleted++;
      }
      changed = true;
    }
    return { changed, deleted, emptied };
  }

  function cleanPayload(data, source) {
    let changed = false;
    let deleted = 0;
    let emptied = 0;
    if (data && typeof data === 'object') {
      const direct = stripAdFields(data);
      changed ||= direct.changed;
      deleted += direct.deleted;
      emptied += direct.emptied;
      if (data.playerResponse && typeof data.playerResponse === 'object') {
        const nested = stripAdFields(data.playerResponse);
        changed ||= nested.changed;
        deleted += nested.deleted;
        emptied += nested.emptied;
      }
    }
    record(source, changed, deleted, emptied);
    return changed;
  }

  function isYouTubeApiUrl(url) {
    return YT_API_PATHS.some((path) => String(url || '').includes(path));
  }

  window.__YT_PROBE_STRIPPER__ = stats;

  let initialPlayerResponse;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get() { return initialPlayerResponse; },
      set(value) {
        cleanPayload(value, 'initial_player_response');
        initialPlayerResponse = value;
      }
    });
  } catch (_) {}

  let initialData;
  try {
    Object.defineProperty(window, 'ytInitialData', {
      configurable: true,
      get() { return initialData; },
      set(value) {
        cleanPayload(value, 'initial_data');
        initialData = value;
      }
    });
  } catch (_) {}

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = async function(...args) {
      const response = await nativeFetch.apply(this, args);
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      if (!isYouTubeApiUrl(url)) return response;
      try {
        const clone = response.clone();
        const json = await clone.json();
        const changed = cleanPayload(json, 'fetch');
        if (!changed) return response;
        return new Response(JSON.stringify(json), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      } catch (_) {
        return response;
      }
    };
  }

  const nativeParse = JSON.parse;
  JSON.parse = function(text, reviver) {
    const result = nativeParse.call(this, text, reviver);
    try { cleanPayload(result, 'json_parse'); } catch (_) {}
    return result;
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__ytProbeStripperUrl = String(url || '');
    return nativeOpen.apply(this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    const url = this.__ytProbeStripperUrl || '';
    if (isYouTubeApiUrl(url)) {
      this.addEventListener('readystatechange', function() {
        if (this.readyState !== 4) return;
        try {
          const responseType = this.responseType;
          if (responseType && responseType !== '' && responseType !== 'text' && responseType !== 'json') return;
          const text = responseType === 'json' ? JSON.stringify(this.response) : this.responseText;
          const json = nativeParse(text);
          const changed = cleanPayload(json, 'xhr');
          if (!changed) return;
          const stripped = JSON.stringify(json);
          Object.defineProperty(this, 'responseText', { value: stripped, writable: false });
          Object.defineProperty(this, 'response', {
            value: responseType === 'json' ? json : stripped,
            writable: false
          });
        } catch (_) {}
      });
    }
    return nativeSend.apply(this, args);
  };
})();
`;

const PROBE_ACCELERATE_ADS_SCRIPT = String.raw`
(() => {
  const speed = __PROBE_ACCELERATE_SPEED__;
  const stats = {
    speed,
    activations: 0,
    skipClicks: 0,
    lastActivationMs: null,
    lastAdSignals: []
  };
  const adSelectors = [
    '.html5-video-player.ad-showing',
    '.html5-video-player.ad-interrupting',
    '.ad-showing',
    '.ad-interrupting',
    '.ytp-ad-module'
  ];

  function isVisible(el) {
    try {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch (_) {
      return false;
    }
  }

  function visibleAdSignals() {
    return adSelectors.filter((selector) => {
      try {
        return [...document.querySelectorAll(selector)].some(isVisible);
      } catch (_) {
        return false;
      }
    });
  }

  function tick() {
    const signals = visibleAdSignals();
    const video = document.querySelector('video');
    if (!video || signals.length === 0) return;
    video.muted = true;
    video.playbackRate = speed;
    if (video.paused && typeof video.play === 'function') {
      video.play().catch(() => {});
    }
    stats.activations++;
    stats.lastActivationMs = Math.round(performance.now());
    stats.lastAdSignals = signals;

    const skipButton = [
      '.ytp-skip-ad-button',
      '.ytp-ad-skip-button',
      '.ytp-ad-skip-button-modern',
      '.ytp-ad-skip-button-container button'
    ].map((selector) => {
      try { return [...document.querySelectorAll(selector)].find(isVisible); }
      catch (_) { return null; }
    }).find(Boolean);
    if (skipButton) {
      try {
        skipButton.click();
        stats.skipClicks++;
      } catch (_) {}
    }
  }

  window.__YT_PROBE_ACCELERATOR__ = stats;
  setInterval(tick, 100);
})();
`;

const DOM_PROBE_SCRIPT = String.raw`
(() => {
  const start = performance.now();
  const events = [];
  const adSelectors = [
    '.html5-video-player.ad-showing',
    '.html5-video-player.ad-interrupting',
    '.ad-showing',
    '.ad-interrupting',
    '.ytp-ad-simple-ad-badge',
    '.ytp-ad-duration-remaining',
    '.ytp-ad-preview-text',
    '.ytp-ad-player-overlay',
    '.ytp-ad-skip-button-container',
    '.ytp-skip-ad-button',
    '.ytp-ad-visit-advertiser-button',
    '.ytp-ad-player-overlay-instream-info',
    '.ytp-ad-text',
    '.ytp-ad-module'
  ];
  const loadingSelectors = [
    '.ytp-spinner',
    '.ytp-spinner-container',
    '.ytp-loading-spinner',
    '.html5-video-player.ytp-waiting',
    '.html5-video-player.ytp-autonav-endscreen-upnext-paused'
  ];
  const errorSelectors = [
    '.ytp-error',
    '.ytp-playability-error-supported-renderers',
    '#error-screen'
  ];
  const selectors = [...adSelectors, ...loadingSelectors, ...errorSelectors];
  let lastSignal = '';
  let lastPlayerClass = '';
  let lastVideoState = '';

  function now() {
    return Math.round(performance.now() - start);
  }

  function push(type, detail = {}) {
    events.push({ t: now(), type, detail });
    if (events.length > 1500) events.shift();
  }

  function isVisible(el) {
    try {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch (_) {
      return false;
    }
  }

  function presentSignals() {
    return selectors.filter((selector) => {
      try { return !!document.querySelector(selector); }
      catch (_) { return false; }
    });
  }

  function visibleSignals(list = selectors) {
    return list.filter((selector) => {
      try {
        return [...document.querySelectorAll(selector)].some(isVisible);
      } catch (_) {
        return false;
      }
    });
  }

  function playerClasses() {
    const player = document.querySelector('.html5-video-player, #movie_player');
    return player ? String(player.className || '') : '';
  }

  function rounded(value, places = 3) {
    return Number.isFinite(value) ? Number(value.toFixed(places)) : null;
  }

  function mediaUrlSummary(rawUrl) {
    if (!rawUrl) return { present: false };
    try {
      const url = new URL(rawUrl);
      return {
        present: true,
        origin: url.origin,
        path: url.pathname,
        queryKeys: [...url.searchParams.keys()].sort()
      };
    } catch (_) {
      return { present: true, parseError: true };
    }
  }

  function rangeSummary(ranges, currentTime) {
    try {
      const items = [];
      for (let i = 0; i < ranges.length; i++) {
        const start = rounded(ranges.start(i));
        const end = rounded(ranges.end(i));
        items.push({ start, end });
      }
      const active = items.find((item) => {
        return Number.isFinite(item.start) && Number.isFinite(item.end) &&
          currentTime >= item.start && currentTime <= item.end;
      });
      return {
        count: items.length,
        activeAhead: active ? rounded(active.end - currentTime) : null,
        first: items[0] || null,
        last: items[items.length - 1] || null
      };
    } catch (_) {
      return { count: 0, activeAhead: null, first: null, last: null };
    }
  }

  function videoSnapshot(video) {
    const currentTime = rounded(video.currentTime);
    return {
      currentSrc: mediaUrlSummary(video.currentSrc || video.src || ''),
      networkState: video.networkState,
      readyState: video.readyState,
      currentTime,
      duration: rounded(video.duration),
      paused: video.paused,
      ended: video.ended,
      muted: video.muted,
      playbackRate: video.playbackRate,
      buffered: rangeSummary(video.buffered, video.currentTime),
      seekable: rangeSummary(video.seekable, video.currentTime),
      decodedFrames: Number.isFinite(video.webkitDecodedFrameCount) ? video.webkitDecodedFrameCount : null,
      droppedFrames: Number.isFinite(video.webkitDroppedFrameCount) ? video.webkitDroppedFrameCount : null,
      visibleAdSignals: visibleSignals(adSelectors),
      visibleLoadingSignals: visibleSignals(loadingSelectors),
      playerClasses: playerClasses()
    };
  }

  function sampleVideoState() {
    const video = document.querySelector('video');
    if (!video) return;
    const snapshot = videoSnapshot(video);
    const key = JSON.stringify({
      currentSrc: snapshot.currentSrc.present,
      currentSrcOrigin: snapshot.currentSrc.origin,
      networkState: snapshot.networkState,
      readyState: snapshot.readyState,
      currentTime: snapshot.currentTime,
      paused: snapshot.paused,
      ended: snapshot.ended,
      bufferedAhead: snapshot.buffered.activeAhead,
      visibleAdSignals: snapshot.visibleAdSignals,
      visibleLoadingSignals: snapshot.visibleLoadingSignals,
      playerClasses: snapshot.playerClasses
    });
    if (key !== lastVideoState) {
      lastVideoState = key;
      push('video-state', snapshot);
    }
  }

  function sampleSignals() {
    const snapshot = {
      present: presentSignals(),
      visible: visibleSignals(),
      visibleAd: visibleSignals(adSelectors),
      visibleLoading: visibleSignals(loadingSelectors),
      visibleErrors: visibleSignals(errorSelectors),
      playerClasses: playerClasses()
    };
    const key = JSON.stringify(snapshot);
    if (key !== lastSignal) {
      lastSignal = key;
      push('dom-signals', snapshot);
    }
    if (snapshot.playerClasses !== lastPlayerClass) {
      lastPlayerClass = snapshot.playerClasses;
      push('player-classes', { className: snapshot.playerClasses });
    }
  }

  function attachVideo(video) {
    if (!video || video.__ytProbeAttached) return;
    Object.defineProperty(video, '__ytProbeAttached', { value: true });
    for (const eventName of ['loadstart', 'loadeddata', 'canplay', 'waiting', 'playing', 'pause', 'ended']) {
      video.addEventListener(eventName, () => {
        push('video-' + eventName, {
          currentTime: Number.isFinite(video.currentTime) ? Number(video.currentTime.toFixed(3)) : null,
          duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : null,
          currentSrc: mediaUrlSummary(video.currentSrc || video.src || ''),
          networkState: video.networkState,
          readyState: video.readyState,
          buffered: rangeSummary(video.buffered, video.currentTime),
          playbackRate: video.playbackRate,
          muted: video.muted,
          paused: video.paused,
          adSignals: presentSignals(),
          visibleAdSignals: visibleSignals(adSelectors),
          visibleLoadingSignals: visibleSignals(loadingSelectors),
          playerClasses: playerClasses()
        });
      }, true);
    }
    push('video-attached', {
      className: video.className || '',
      readyState: video.readyState,
      currentSrc: mediaUrlSummary(video.currentSrc || video.src || ''),
      networkState: video.networkState,
      paused: video.paused,
      currentTime: Number.isFinite(video.currentTime) ? Number(video.currentTime.toFixed(3)) : null,
      duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : null
    });
    if (video.readyState >= 3 && !video.paused) {
      push('video-playing-snapshot', {
        currentTime: Number.isFinite(video.currentTime) ? Number(video.currentTime.toFixed(3)) : null,
        duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : null,
        currentSrc: mediaUrlSummary(video.currentSrc || video.src || ''),
        networkState: video.networkState,
        readyState: video.readyState,
        buffered: rangeSummary(video.buffered, video.currentTime),
        playbackRate: video.playbackRate,
        muted: video.muted,
        paused: video.paused,
        adSignals: presentSignals(),
        visibleAdSignals: visibleSignals(adSelectors),
        visibleLoadingSignals: visibleSignals(loadingSelectors),
        playerClasses: playerClasses()
      });
    }
  }

  function scanVideos() {
    document.querySelectorAll('video').forEach(attachVideo);
  }

  function install() {
    scanVideos();
    sampleSignals();
    sampleVideoState();
    try {
      const observer = new MutationObserver(() => {
        scanVideos();
        sampleSignals();
      });
      observer.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    } catch (_) {}
    setInterval(scanVideos, 500);
    setInterval(sampleSignals, 250);
    setInterval(sampleVideoState, 100);
  }

  window.__YT_PLAYER_PROBE__ = {
    events,
    startedAt: Date.now(),
    mark: push
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
`;

function endpointForUrl(url) {
  const mediaEndpoint = mediaEndpointForUrl(url);
  if (mediaEndpoint) return mediaEndpoint;
  return YOUTUBE_ENDPOINTS.find((endpoint) => url.includes(endpoint.marker)) || null;
}

function mediaEndpointForUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    const pathValue = url.pathname.toLowerCase();
    if (
      (host.endsWith('.googlevideo.com') || host === 'googlevideo.com') &&
      (pathValue.includes('/videoplayback') || pathValue.includes('/initplayback'))
    ) {
      return { name: 'media', kind: 'media' };
    }
    if (host.endsWith('youtube.com') && pathValue.includes('/api/manifest')) {
      return { name: 'media-manifest', kind: 'media' };
    }
  } catch (_) {}
  return null;
}

function makeReportName(prefix = 'youtube-probe') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix}-${stamp}.json`;
}

function loadUrls(options) {
  const urls = [];
  if (options.url) urls.push(options.url);

  if (options.urlsFile) {
    const absolute = path.resolve(options.cwd, options.urlsFile);
    const data = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    if (Array.isArray(data)) urls.push(...data);
    if (Array.isArray(data.urls)) urls.push(...data.urls);
  }

  return [...new Set(urls)].filter(Boolean);
}

function summarizeDomEvents(events) {
  const firstPlaying = events.find((event) => event.type === 'video-playing' || event.type === 'video-playing-snapshot');
  const firstContentPlaying = events.find((event) => {
    if (!(event.type === 'video-playing' || event.type === 'video-playing-snapshot')) return false;
    const detail = event.detail || {};
    const visibleAd = detail.visibleAdSignals || [];
    return visibleAd.length === 0;
  });
  const firstAdPlaying = events.find((event) => {
    if (!(event.type === 'video-playing' || event.type === 'video-playing-snapshot')) return false;
    const detail = event.detail || {};
    return (detail.visibleAdSignals || []).length > 0;
  });
  const firstWaiting = events.find((event) => event.type === 'video-waiting');
  const adSignalEvents = events.filter((event) => event.type === 'dom-signals' && (event.detail.present || []).length > 0);
  const visibleAdSignalEvents = events.filter((event) => event.type === 'dom-signals' && (event.detail.visibleAd || []).length > 0);
  const visibleLoadingEvents = events.filter((event) => event.type === 'dom-signals' && (event.detail.visibleLoading || []).length > 0);
  const visibleErrorEvents = events.filter((event) => event.type === 'dom-signals' && (event.detail.visibleErrors || []).length > 0);
  const waitingEvents = events.filter((event) => event.type === 'video-waiting');
  const videoStateEvents = events.filter((event) => event.type === 'video-state');
  const firstCurrentSrc = videoStateEvents.find((event) => event.detail?.currentSrc?.present);
  const firstReadyState = videoStateEvents.find((event) => (event.detail?.readyState || 0) > 0);
  const firstPlayableState = videoStateEvents.find((event) => (event.detail?.readyState || 0) >= 3);
  const firstBufferedAhead = videoStateEvents.find((event) => {
    return Number.isFinite(event.detail?.buffered?.activeAhead) && event.detail.buffered.activeAhead > 0;
  });
  const firstProgress = firstProgressEvent(videoStateEvents);
  const lastVideoState = videoStateEvents.length ? videoStateEvents[videoStateEvents.length - 1].detail : null;
  const allSignals = new Set();
  const visibleAdSignals = new Set();
  const visibleLoadingSignals = new Set();
  const visibleErrorSignals = new Set();
  const playerClassStates = new Set();

  for (const event of adSignalEvents) {
    for (const selector of event.detail.present || []) allSignals.add(selector);
    for (const selector of event.detail.visibleAd || []) visibleAdSignals.add(selector);
    for (const selector of event.detail.visibleLoading || []) visibleLoadingSignals.add(selector);
    for (const selector of event.detail.visibleErrors || []) visibleErrorSignals.add(selector);
  }

  for (const event of events) {
    if (event.type === 'player-classes' && event.detail?.className) {
      playerClassStates.add(event.detail.className);
    }
  }

  return {
    navigationToFirstPlayingMs: firstPlaying ? firstPlaying.t : null,
    navigationToFirstContentPlayingMs: firstContentPlaying ? firstContentPlaying.t : null,
    navigationToFirstAdPlayingMs: firstAdPlaying ? firstAdPlaying.t : null,
    navigationToFirstWaitingMs: firstWaiting ? firstWaiting.t : null,
    navigationToFirstCurrentSrcMs: firstCurrentSrc ? firstCurrentSrc.t : null,
    navigationToFirstReadyStateMs: firstReadyState ? firstReadyState.t : null,
    navigationToFirstPlayableStateMs: firstPlayableState ? firstPlayableState.t : null,
    navigationToFirstBufferedAheadMs: firstBufferedAhead ? firstBufferedAhead.t : null,
    navigationToFirstVideoProgressMs: firstProgress ? firstProgress.t : null,
    waitingEvents: waitingEvents.length,
    videoStateEvents: videoStateEvents.length,
    adSignalEvents: adSignalEvents.length,
    visibleAdSignalEvents: visibleAdSignalEvents.length,
    visibleLoadingEvents: visibleLoadingEvents.length,
    visibleErrorEvents: visibleErrorEvents.length,
    visibleAdSignals: [...visibleAdSignals].sort(),
    visibleLoadingSignals: [...visibleLoadingSignals].sort(),
    visibleErrorSignals: [...visibleErrorSignals].sort(),
    playerClassStates: [...playerClassStates].sort(),
    finalVideoState: lastVideoState,
    domSignals: [...allSignals].sort()
  };
}

function firstProgressEvent(videoStateEvents) {
  let previous = null;
  for (const event of videoStateEvents) {
    const current = event.detail?.currentTime;
    if (Number.isFinite(previous) && Number.isFinite(current) && current > previous + 0.05) {
      return event;
    }
    if (Number.isFinite(current)) previous = current;
  }
  return null;
}

async function createBrowserContext(playwright, options) {
  const extensionArgs = options.extensionDir ? [
    `--disable-extensions-except=${options.extensionDir}`,
    `--load-extension=${options.extensionDir}`
  ] : [];
  const launchOptions = {
    headless: options.headless,
    executablePath: options.executablePath || undefined,
    proxy: options.proxy ? { server: options.proxy } : undefined,
    args: extensionArgs
  };

  if (options.profileDir || options.extensionDir) {
    const profileDir = options.profileDir || path.resolve(options.cwd, '.profiles', 'chroma-extension');
    fs.mkdirSync(profileDir, { recursive: true });
    return {
      browser: null,
      context: await playwright.chromium.launchPersistentContext(profileDir, launchOptions)
    };
  }

  const browser = await playwright.chromium.launch(launchOptions);
  return {
    browser,
    context: await browser.newContext()
  };
}

async function probePage(context, targetUrl, options) {
  const page = await context.newPage();
  if (options.probeStripMode && options.probeStripMode !== 'off') {
    await page.addInitScript(PROBE_STRIPPER_SCRIPT.replace(
      '__PROBE_STRIP_MODE__',
      JSON.stringify(options.probeStripMode)
    ));
  }
  if (options.probeAccelerateAds) {
    await page.addInitScript(PROBE_ACCELERATE_ADS_SCRIPT.replace(
      '__PROBE_ACCELERATE_SPEED__',
      JSON.stringify(options.probeAccelerateSpeed)
    ));
  }
  await page.addInitScript(DOM_PROBE_SCRIPT);

  let capturePhase = options.preplayReload ? 'warmup' : 'collection';
  let navigationStart = Date.now();
  let requestStartTimes = new WeakMap();
  let phaseRequests = new WeakSet();
  let phaseNetwork = [];

  page.on('request', (request) => {
    if (endpointForUrl(request.url())) {
      phaseRequests.add(request);
      requestStartTimes.set(request, Date.now());
    }
  });

  page.on('requestfailed', (request) => {
    if (!phaseRequests.has(request)) return;
    const endpoint = endpointForUrl(request.url());
    if (!endpoint) return;
    const requestStartedAt = requestStartTimes.get(request) || navigationStart;
    const failedAt = Date.now();
    phaseNetwork.push({
      endpoint: endpoint.name,
      kind: endpoint.kind,
      url: safeUrlSummary(request.url()),
      method: request.method(),
      resourceType: request.resourceType(),
      failed: true,
      failureText: request.failure()?.errorText || null,
      requestToFailureMs: failedAt - requestStartedAt,
      navigationToFailureMs: failedAt - navigationStart,
      adLikePaths: [],
      knownStripperPathsPresent: [],
      truncated: false
    });
  });

  page.on('response', async (response) => {
    const request = response.request();
    if (!phaseRequests.has(request)) return;
    const url = response.url();
    const endpoint = endpointForUrl(url);
    if (!endpoint) return;

    const requestStartedAt = requestStartTimes.get(request) || navigationStart;
    const receivedAt = Date.now();
    const summary = {
      endpoint: endpoint.name,
      kind: endpoint.kind,
      url: safeUrlSummary(url),
      method: request.method(),
      resourceType: request.resourceType(),
      status: response.status(),
      requestToResponseMs: receivedAt - requestStartedAt,
      navigationToResponseMs: receivedAt - navigationStart,
      adLikePaths: [],
      knownStripperPathsPresent: [],
      pathTypes: {},
      truncated: false,
      parseError: null
    };

    if (endpoint.kind === 'media') {
      summary.media = summarizeMediaResponse(response);
      phaseNetwork.push(summary);
      return;
    }

    try {
      const json = await response.json();
      const sanitized = walkJson(json, {
        maxDepth: options.maxDepth,
        maxPaths: options.maxPaths,
        includePathTypes: options.includePathTypes
      });
      Object.assign(summary, sanitized);
      if (endpoint.name === 'player') {
        summary.payloadHints = summarizePayloadHints('ytInitialPlayerResponse', json);
      }
    } catch (err) {
      summary.parseError = err && err.message ? err.message : String(err);
    }

    phaseNetwork.push(summary);
  });

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  let navigationError = null;
  let reloadError = null;
  let warmupPlaybackAttempt = null;
  let warmupSnapshot = null;
  try {
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: options.navigationTimeoutMs
    });
  } catch (err) {
    navigationError = err && err.message ? err.message : String(err);
  }

  if (options.preplayReload) {
    warmupPlaybackAttempt = await triggerPlayback(page, options);
    await page.waitForTimeout(options.preReloadSettleMs);
    warmupSnapshot = await capturePageSnapshot(page, {
      phase: 'warmup',
      network: phaseNetwork,
      options
    });

    phaseNetwork = [];
    requestStartTimes = new WeakMap();
    phaseRequests = new WeakSet();
    navigationStart = Date.now();
    capturePhase = 'collection';

    try {
      await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: options.navigationTimeoutMs
      });
    } catch (err) {
      reloadError = err && err.message ? err.message : String(err);
    }
  }

  const playbackAttempt = options.clickPlay
    ? await triggerPlayback(page, options)
    : { attempted: false, ok: false, method: null, error: null };

  const contentReresolveAttempt = options.tryContentReresolve
    ? await attemptContentReresolve(page, options)
    : null;

  await page.waitForTimeout(options.settleMs);

  const collectionSnapshot = await capturePageSnapshot(page, {
    phase: capturePhase,
    network: phaseNetwork,
    options
  });

  await page.close();

  const pageResult = {
    url: targetUrl,
    navigationError,
    reloadError,
    collectionFlow: options.preplayReload ? 'preplay-reload' : 'initial-navigation',
    warmupPlaybackAttempt,
    warmupSnapshot,
    timing: collectionSnapshot.timing,
    playbackAttempt,
    contentReresolveAttempt,
    network: collectionSnapshot.network,
    initialPayloads: collectionSnapshot.initialPayloads,
    probeStripperStats: collectionSnapshot.probeStripperStats,
    probeAcceleratorStats: collectionSnapshot.probeAcceleratorStats,
    domEvents: collectionSnapshot.domEvents,
    snapshots: [
      ...(warmupSnapshot ? [warmupSnapshot] : []),
      collectionSnapshot
    ],
    pageErrors
  };

  pageResult.summary = buildPageSummary(pageResult);
  return pageResult;
}

async function capturePageSnapshot(page, { phase, network, options }) {
  const domEvents = await page.evaluate(() => {
    return window.__YT_PLAYER_PROBE__ ? window.__YT_PLAYER_PROBE__.events : [];
  }).catch(() => []);

  const initialPayloads = await collectInitialPayloads(page, options);
  const probeStripperStats = await collectProbeStripperStats(page);
  const probeAcceleratorStats = await collectProbeAcceleratorStats(page);
  const timing = summarizeDomEvents(domEvents);

  return {
    phase,
    timing,
    network,
    initialPayloads,
    probeStripperStats,
    probeAcceleratorStats,
    domEvents
  };
}

async function collectProbeStripperStats(page) {
  return page.evaluate(() => {
    if (!window.__YT_PROBE_STRIPPER__) return null;
    return JSON.parse(JSON.stringify(window.__YT_PROBE_STRIPPER__));
  }).catch(() => null);
}

async function collectProbeAcceleratorStats(page) {
  return page.evaluate(() => {
    if (!window.__YT_PROBE_ACCELERATOR__) return null;
    return JSON.parse(JSON.stringify(window.__YT_PROBE_ACCELERATOR__));
  }).catch(() => null);
}

async function triggerPlayback(page, options) {
  const result = {
    attempted: true,
    ok: false,
    method: null,
    methodsTried: [],
    error: null,
    before: null,
    after: null,
    progressed: false
  };

  try {
    const video = page.locator('video').first();
    await video.waitFor({ state: 'attached', timeout: options.playTimeoutMs });

    result.before = await readVideoState(page);

    const methods = [
      ['large-play-button', () => clickIfVisible(page, '.ytp-large-play-button')],
      ['video-center-click', () => clickLocatorCenter(page, video)],
      ['player-center-click', () => clickLocatorCenter(page, page.locator('#movie_player, .html5-video-player').first())],
      ['keyboard-k', async () => { await page.keyboard.press('k'); return true; }],
      ['keyboard-space', async () => { await page.keyboard.press('Space'); return true; }]
    ];

    for (const [method, action] of methods) {
      result.methodsTried.push(method);
      const acted = await action().catch(() => false);
      if (!acted) continue;

      await page.waitForTimeout(700);
      const state = await readVideoState(page);
      if (state && state.paused === false) {
        result.method = method;
        break;
      }
    }

    await page.waitForTimeout(800);
    result.after = await readVideoState(page);
    result.progressed = !!(
      result.before &&
      result.after &&
      Number.isFinite(result.before.currentTime) &&
      Number.isFinite(result.after.currentTime) &&
      result.after.currentTime > result.before.currentTime
    );
    result.ok = !!result.after && (result.after.paused === false || result.progressed);
    if (!result.method && result.ok) result.method = 'state-progress-detected';

    await markProbeEvent(page, 'playback-attempt', {
      method: result.method,
      methodsTried: result.methodsTried,
      ok: result.ok,
      progressed: result.progressed,
      before: result.before,
      after: result.after
    });
  } catch (err) {
    result.error = err && err.message ? err.message : String(err);
    await markProbeEvent(page, 'playback-attempt-error', {
      error: result.error
    }).catch(() => {});
  }

  return result;
}

async function attemptContentReresolve(page, options) {
  const result = {
    enabled: true,
    attempted: false,
    method: options.contentReresolveMethod,
    reason: null,
    before: null,
    after: null,
    actionResult: null,
    error: null
  };

  const startedAt = Date.now();
  const timeoutMs = options.contentReresolveTimeoutMs;

  while (Date.now() - startedAt <= timeoutMs) {
    const state = await readReresolveState(page);
    if (!state) {
      result.reason = 'no-video-state';
      await page.waitForTimeout(250);
      continue;
    }

    if (isReresolveDeadZone(state, options)) {
      result.attempted = true;
      result.before = state;
      await markProbeEvent(page, 'content-reresolve-before', {
        method: result.method,
        state
      });

      try {
        result.actionResult = await runContentReresolveAction(page, result.method);
      } catch (err) {
        result.error = err && err.message ? err.message : String(err);
      }

      await page.waitForTimeout(1500);
      result.after = await readReresolveState(page);
      result.reason = result.error ? 'action-error' : 'attempted';
      await markProbeEvent(page, 'content-reresolve-after', {
        method: result.method,
        actionResult: result.actionResult,
        error: result.error,
        before: result.before,
        after: result.after
      });
      return result;
    }

    result.reason = state.elapsedMs < options.contentReresolveAfterMs
      ? 'waiting-for-reresolve-window'
      : 'dead-zone-condition-not-met';
    await page.waitForTimeout(250);
  }

  return result;
}

function isReresolveDeadZone(state, options) {
  if (state.elapsedMs < options.contentReresolveAfterMs) return false;
  if (!state.videoPresent || !state.currentSrc?.present) return false;
  if (state.readyState !== 0) return false;
  if (Number.isFinite(state.currentTime) && state.currentTime > 0.05) return false;
  if ((state.visibleAdSignals || []).length > 0) return false;
  const classes = state.playerClasses || '';
  return classes.includes('buffering-mode') && classes.includes('unstarted-mode');
}

async function readReresolveState(page) {
  return page.evaluate(() => {
    const video = document.querySelector('video');
    const player = document.querySelector('#movie_player, .html5-video-player');
    const adSelectors = [
      '.html5-video-player.ad-showing',
      '.html5-video-player.ad-interrupting',
      '.ad-showing',
      '.ad-interrupting',
      '.ytp-ad-module'
    ];
    const loadingSelectors = [
      '.ytp-spinner',
      '.ytp-spinner-container',
      '.ytp-loading-spinner',
      '.html5-video-player.ytp-waiting'
    ];

    function isVisible(el) {
      try {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      } catch (_) {
        return false;
      }
    }

    function visibleSignals(selectors) {
      return selectors.filter((selector) => {
        try {
          return [...document.querySelectorAll(selector)].some(isVisible);
        } catch (_) {
          return false;
        }
      });
    }

    function mediaUrlSummary(rawUrl) {
      if (!rawUrl) return { present: false };
      try {
        const url = new URL(rawUrl);
        return {
          present: true,
          origin: url.origin,
          path: url.pathname,
          queryKeys: [...url.searchParams.keys()].sort()
        };
      } catch (_) {
        return { present: true, parseError: true };
      }
    }

    function videoIdFromPage() {
      try {
        const fromPlayer = player && typeof player.getVideoData === 'function'
          ? player.getVideoData()?.video_id
          : null;
        if (fromPlayer) return fromPlayer;
      } catch (_) {}
      try {
        const url = new URL(location.href);
        const fromQuery = url.searchParams.get('v');
        if (fromQuery) return fromQuery;
        if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/').filter(Boolean)[1] || null;
      } catch (_) {}
      return null;
    }

    return {
      elapsedMs: Math.round(performance.now()),
      videoPresent: !!video,
      playerPresent: !!player,
      videoId: videoIdFromPage(),
      currentSrc: mediaUrlSummary(video?.currentSrc || video?.src || ''),
      networkState: video ? video.networkState : null,
      readyState: video ? video.readyState : null,
      currentTime: video && Number.isFinite(video.currentTime) ? Number(video.currentTime.toFixed(3)) : null,
      duration: video && Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : null,
      paused: video ? video.paused : null,
      ended: video ? video.ended : null,
      visibleAdSignals: visibleSignals(adSelectors),
      visibleLoadingSignals: visibleSignals(loadingSelectors),
      playerClasses: player ? String(player.className || '') : '',
      api: {
        cueVideoById: !!player && typeof player.cueVideoById === 'function',
        loadVideoById: !!player && typeof player.loadVideoById === 'function',
        playVideo: !!player && typeof player.playVideo === 'function',
        getVideoData: !!player && typeof player.getVideoData === 'function'
      }
    };
  }).catch(() => null);
}

async function runContentReresolveAction(page, method) {
  return page.evaluate(async (methodName) => {
    const video = document.querySelector('video');
    const player = document.querySelector('#movie_player, .html5-video-player');
    const videoId = (() => {
      try {
        const fromPlayer = player && typeof player.getVideoData === 'function'
          ? player.getVideoData()?.video_id
          : null;
        if (fromPlayer) return fromPlayer;
      } catch (_) {}
      try {
        const url = new URL(location.href);
        const fromQuery = url.searchParams.get('v');
        if (fromQuery) return fromQuery;
        if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/').filter(Boolean)[1] || null;
      } catch (_) {}
      return null;
    })();
    const startSeconds = video && Number.isFinite(video.currentTime)
      ? Math.max(0, Math.floor(video.currentTime))
      : 0;
    const result = {
      method: methodName,
      videoId,
      startSeconds,
      used: null,
      ok: false,
      error: null
    };

    try {
      if (methodName === 'video-play') {
        if (!video || typeof video.play !== 'function') throw new Error('video.play unavailable');
        await video.play();
        result.used = 'video.play';
        result.ok = true;
        return result;
      }

      if (!player) throw new Error('movie_player unavailable');

      if (methodName === 'play-video') {
        if (typeof player.playVideo !== 'function') throw new Error('playVideo unavailable');
        player.playVideo();
        result.used = 'player.playVideo';
        result.ok = true;
        return result;
      }

      if (!videoId) throw new Error('video id unavailable');

      if (methodName === 'load') {
        if (typeof player.loadVideoById !== 'function') throw new Error('loadVideoById unavailable');
        player.loadVideoById(videoId, startSeconds);
        result.used = 'player.loadVideoById';
        result.ok = true;
        return result;
      }

      if (typeof player.cueVideoById !== 'function') throw new Error('cueVideoById unavailable');
      player.cueVideoById(videoId, startSeconds);
      if (typeof player.playVideo === 'function') player.playVideo();
      result.used = 'player.cueVideoById+playVideo';
      result.ok = true;
      return result;
    } catch (err) {
      result.error = err && err.message ? err.message : String(err);
      return result;
    }
  }, method);
}

async function clickIfVisible(page, selector) {
  const locator = page.locator(selector).first();
  const count = await locator.count();
  if (!count) return false;
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) return false;
  await locator.click({ timeout: 1000 });
  return true;
}

async function clickLocatorCenter(page, locator) {
  const box = await locator.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) return false;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return true;
}

async function readVideoState(page) {
  return page.evaluate(() => {
    const video = document.querySelector('video');
    if (!video) return null;
    const player = document.querySelector('.html5-video-player, #movie_player');
    function rounded(value) {
      return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
    }
    function mediaUrlSummary(rawUrl) {
      if (!rawUrl) return { present: false };
      try {
        const url = new URL(rawUrl);
        return {
          present: true,
          origin: url.origin,
          path: url.pathname,
          queryKeys: [...url.searchParams.keys()].sort()
        };
      } catch (_) {
        return { present: true, parseError: true };
      }
    }
    function rangeSummary(ranges, currentTime) {
      try {
        const items = [];
        for (let i = 0; i < ranges.length; i++) {
          items.push({
            start: rounded(ranges.start(i)),
            end: rounded(ranges.end(i))
          });
        }
        const active = items.find((item) => {
          return Number.isFinite(item.start) && Number.isFinite(item.end) &&
            currentTime >= item.start && currentTime <= item.end;
        });
        return {
          count: items.length,
          activeAhead: active ? rounded(active.end - currentTime) : null,
          first: items[0] || null,
          last: items[items.length - 1] || null
        };
      } catch (_) {
        return { count: 0, activeAhead: null, first: null, last: null };
      }
    }
    return {
      paused: video.paused,
      ended: video.ended,
      currentSrc: mediaUrlSummary(video.currentSrc || video.src || ''),
      networkState: video.networkState,
      readyState: video.readyState,
      currentTime: rounded(video.currentTime),
      duration: rounded(video.duration),
      buffered: rangeSummary(video.buffered, video.currentTime),
      seekable: rangeSummary(video.seekable, video.currentTime),
      muted: video.muted,
      playbackRate: video.playbackRate,
      playerClasses: player ? String(player.className || '') : ''
    };
  }).catch(() => null);
}

async function markProbeEvent(page, type, detail) {
  await page.evaluate(({ type, detail }) => {
    if (window.__YT_PLAYER_PROBE__ && typeof window.__YT_PLAYER_PROBE__.mark === 'function') {
      window.__YT_PLAYER_PROBE__.mark(type, detail);
    }
  }, { type, detail });
}

async function collectInitialPayloads(page, options) {
  const values = await page.evaluate(() => {
    const out = {};
    if (window.ytInitialPlayerResponse && typeof window.ytInitialPlayerResponse === 'object') {
      out.ytInitialPlayerResponse = window.ytInitialPlayerResponse;
    }
    if (window.ytInitialData && typeof window.ytInitialData === 'object') {
      out.ytInitialData = window.ytInitialData;
    }
    return out;
  }).catch(() => ({}));

  return Object.fromEntries(Object.entries(values).map(([name, value]) => {
    const sanitized = walkJson(value, {
      maxDepth: options.maxDepth,
      maxPaths: options.maxPaths,
      includePathTypes: options.includePathTypes
    });
    sanitized.payloadHints = summarizePayloadHints(name, value);
    return [name, sanitized];
  }));
}

function summarizePayloadHints(name, value) {
  if (name !== 'ytInitialPlayerResponse' || !value || typeof value !== 'object') {
    return null;
  }
  const streamingData = value.streamingData || {};
  const playabilityStatus = value.playabilityStatus || {};
  const hints = {
    hasStreamingData: !!value.streamingData,
    formats: Array.isArray(streamingData.formats) ? streamingData.formats.length : 0,
    adaptiveFormats: Array.isArray(streamingData.adaptiveFormats) ? streamingData.adaptiveFormats.length : 0,
    hasDashManifestUrl: typeof streamingData.dashManifestUrl === 'string',
    hasHlsManifestUrl: typeof streamingData.hlsManifestUrl === 'string',
    playabilityStatus: typeof playabilityStatus.status === 'string' ? playabilityStatus.status : null,
    playabilityReason: typeof playabilityStatus.reason === 'string' ? playabilityStatus.reason : null,
    hasVideoDetails: !!value.videoDetails,
    isLiveContent: value.videoDetails?.isLiveContent === true,
    hasAdPlacements: Array.isArray(value.adPlacements) && value.adPlacements.length > 0,
    hasAdSlots: Array.isArray(value.adSlots) && value.adSlots.length > 0,
    hasPlayerAds: Array.isArray(value.playerAds) && value.playerAds.length > 0,
    hasAdBreakHeartbeatParams: !!value.adBreakHeartbeatParams
  };
  hints.hasPlayableStreams = hints.formats > 0 || hints.adaptiveFormats > 0 ||
    hints.hasDashManifestUrl || hints.hasHlsManifestUrl;
  return hints;
}

function buildPageSummary(page) {
  const allAdLikePaths = new Set();
  const highValueAdPaths = new Set();
  const knownStripperPathsPresent = new Set();
  const knownFieldsPresent = new Map(KNOWN_STRIPPER_FIELDS.map((field) => [field, new Set()]));
  const sourceCounts = [];
  const mediaEntries = (page.network || []).filter((entry) => entry.kind === 'media');
  const mediaResponses = mediaEntries.filter((entry) => !entry.failed && Number.isFinite(entry.navigationToResponseMs));
  const mediaFailures = mediaEntries.filter((entry) => entry.failed && Number.isFinite(entry.navigationToFailureMs));

  for (const source of getSanitizedSources(page)) {
    sourceCounts.push({
      source: source.name,
      adLikePathCount: source.adLikePaths.length,
      knownStripperPathCount: source.knownStripperPathsPresent.length,
      truncated: !!source.truncated
    });

    for (const adPath of source.adLikePaths) {
      const labeled = `${source.name}:${adPath}`;
      allAdLikePaths.add(labeled);
      if (isHighValueAdPath(adPath)) highValueAdPaths.add(labeled);
    }

    for (const knownPath of source.knownStripperPathsPresent) {
      const labeled = `${source.name}:${knownPath}`;
      knownStripperPathsPresent.add(labeled);
      const field = extractKnownField(knownPath);
      if (field) knownFieldsPresent.get(field).add(source.name);
    }
  }

  return {
    playbackStarted: !!page.playbackAttempt?.ok,
    firstPlayingMs: page.timing.navigationToFirstPlayingMs,
    firstContentPlayingMs: page.timing.navigationToFirstContentPlayingMs,
    firstAdPlayingMs: page.timing.navigationToFirstAdPlayingMs,
    firstCurrentSrcMs: page.timing.navigationToFirstCurrentSrcMs,
    firstReadyStateMs: page.timing.navigationToFirstReadyStateMs,
    firstPlayableStateMs: page.timing.navigationToFirstPlayableStateMs,
    firstBufferedAheadMs: page.timing.navigationToFirstBufferedAheadMs,
    firstVideoProgressMs: page.timing.navigationToFirstVideoProgressMs,
    firstMediaRequestMs: firstFinite(mediaEntries.map((entry) => {
      if (Number.isFinite(entry.navigationToResponseMs) && Number.isFinite(entry.requestToResponseMs)) {
        return entry.navigationToResponseMs - entry.requestToResponseMs;
      }
      if (Number.isFinite(entry.navigationToFailureMs) && Number.isFinite(entry.requestToFailureMs)) {
        return entry.navigationToFailureMs - entry.requestToFailureMs;
      }
      return null;
    })),
    firstMediaResponseMs: firstFinite(mediaResponses.map((entry) => entry.navigationToResponseMs)),
    firstMediaFailureMs: firstFinite(mediaFailures.map((entry) => entry.navigationToFailureMs)),
    mediaRequestCount: mediaEntries.length,
    mediaResponseCount: mediaResponses.length,
    mediaFailureCount: mediaFailures.length,
    mediaStatusCounts: countBy(mediaResponses, (entry) => String(entry.status)),
    mediaContentTypes: [...new Set(mediaResponses.map((entry) => entry.media?.contentType).filter(Boolean))].sort(),
    finalVideoState: page.timing.finalVideoState,
    waitingEvents: page.timing.waitingEvents,
    videoStateEvents: page.timing.videoStateEvents,
    visibleLoadingEvents: page.timing.visibleLoadingEvents,
    visibleAdSignalEvents: page.timing.visibleAdSignalEvents,
    visibleAdSignals: page.timing.visibleAdSignals,
    visibleLoadingSignals: page.timing.visibleLoadingSignals,
    sourceCounts,
    knownFieldsPresent: Object.fromEntries([...knownFieldsPresent.entries()].map(([field, sources]) => {
      return [field, [...sources].sort()];
    })),
    knownStripperPathsPresent: [...knownStripperPathsPresent].sort(),
    highValueAdPaths: [...highValueAdPaths].sort(),
    adLikePathCount: allAdLikePaths.size
  };
}

function getSanitizedSources(page) {
  const sources = [];
  for (const entry of page.network || []) {
    sources.push({
      name: `network:${entry.endpoint}`,
      adLikePaths: entry.adLikePaths || [],
      knownStripperPathsPresent: entry.knownStripperPathsPresent || [],
      truncated: entry.truncated
    });
  }
  for (const [name, entry] of Object.entries(page.initialPayloads || {})) {
    sources.push({
      name: `initial:${name}`,
      adLikePaths: entry.adLikePaths || [],
      knownStripperPathsPresent: entry.knownStripperPathsPresent || [],
      truncated: entry.truncated
    });
  }
  return sources;
}

function extractKnownField(pathValue) {
  return KNOWN_STRIPPER_FIELDS.find((field) => {
    return pathValue === field || pathValue.startsWith(`${field}.`) || pathValue.startsWith(`${field}[]`);
  }) || null;
}

function isHighValueAdPath(pathValue) {
  if (/tooltipData\.tooltipViewModel\.placement/i.test(pathValue)) return false;
  return KNOWN_STRIPPER_FIELDS.some((field) => pathValue === field || pathValue.startsWith(`${field}.`) || pathValue.startsWith(`${field}[]`)) ||
    /(adBreak|adSlot|adPlacement|playerAds|inPlayerAdLayoutRenderer|playerBytesAdLayoutRenderer|clientForecastingAdRenderer|adBreakServiceRenderer|daiConfig|showInstream|skipAdViewModel|adDurationRemaining|adBadge|serializedAdServingDataEntry)/i.test(pathValue);
}

function firstFinite(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  return Math.min(...nums);
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function safeUrlSummary(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return {
      origin: url.origin,
      path: url.pathname,
      queryKeys: [...url.searchParams.keys()].sort()
    };
  } catch (_) {
    return { raw: rawUrl };
  }
}

function summarizeMediaResponse(response) {
  const headers = response.headers();
  return {
    contentType: headers['content-type'] || null,
    contentLength: safeIntegerHeader(headers['content-length']),
    contentRange: headers['content-range'] || null,
    acceptRanges: headers['accept-ranges'] || null
  };
}

function safeIntegerHeader(value) {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function runProbe(options) {
  options.probeStripMode ||= 'off';
  options.probeAccelerateSpeed ||= 16;
  const urls = loadUrls(options);
  if (urls.length === 0) {
    throw new Error('Provide --url or --urls <file>.');
  }

  const playwright = requirePlaywright();
  const executablePath = options.executablePath || process.env.CHROME_FOR_TESTING_PATH || process.env.CHROME_PATH || null;
  if (!executablePath) {
    throw new Error('Set CHROME_FOR_TESTING_PATH, CHROME_PATH, or pass --browser <path>. This tool uses playwright-core and does not download browser builds.');
  }
  if (!PROBE_STRIP_MODES.includes(options.probeStripMode)) {
    throw new Error(`Unknown --probe-strip-mode: ${options.probeStripMode}. Use one of: ${PROBE_STRIP_MODES.join(', ')}.`);
  }
  if (options.extensionDir) {
    validateExtensionDir(options.extensionDir);
  }
  if (options.extensionDir && options.probeStripMode !== 'off') {
    throw new Error('--probe-strip-mode is a probe-only simulator. Run it without --extension to avoid stacking it on Chroma.');
  }
  const headless = options.extensionDir ? false : options.headless;
  const { browser, context } = await createBrowserContext(playwright, {
    cwd: options.cwd,
    headless,
    executablePath,
    proxy: options.proxy,
    profileDir: options.profileDir,
    extensionDir: options.extensionDir
  });

  const report = {
    run: {
      timestamp: new Date().toISOString(),
      tool: 'youtube-player-probe',
      version: '0.1.0',
      browser: executablePath ? path.basename(executablePath) : 'playwright-default-chromium',
      executablePath: executablePath ? '[redacted]' : null,
      proxy: options.proxy ? redactProxy(options.proxy) : false,
      headless,
      extensionLoaded: options.extensionDir ? path.basename(options.extensionDir) : false,
      extensionProfile: options.extensionDir ? (options.profileDir ? 'custom' : 'default') : false,
      clickPlay: options.clickPlay,
      preplayReload: options.preplayReload,
      probeStripMode: options.probeStripMode,
      probeAccelerateAds: options.probeAccelerateAds,
      probeAccelerateSpeed: options.probeAccelerateSpeed,
      tryContentReresolve: options.tryContentReresolve,
      contentReresolveMethod: options.contentReresolveMethod,
      contentReresolveAfterMs: options.contentReresolveAfterMs,
      contentReresolveTimeoutMs: options.contentReresolveTimeoutMs,
      preReloadSettleMs: options.preReloadSettleMs,
      includePathTypes: options.includePathTypes,
      settleMs: options.settleMs,
      note: 'Sanitized structural report. Full YouTube payloads are not stored.'
    },
    pages: []
  };

  try {
    for (const url of urls) {
      report.pages.push(await probePage(context, url, options));
    }
  } finally {
    await context.close();
    if (browser) await browser.close();
  }

  report.summary = buildRunSummary(report.pages);

  const outputPath = path.resolve(options.cwd, options.output || path.join('reports', makeReportName()));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');

  return {
    report,
    outputPath,
    outputUrl: pathToFileURL(outputPath).href
  };
}

function buildRunSummary(pages) {
  const knownFieldsPresent = new Map(KNOWN_STRIPPER_FIELDS.map((field) => [field, new Set()]));
  let highValueAdPathCount = 0;
  let pagesWithVisibleAds = 0;
  let pagesWithWarmupVisibleAds = 0;
  let pagesWithCollectionVisibleAds = 0;
  let pagesWithVisibleLoading = 0;
  let pagesWithPlaybackStarted = 0;

  for (const page of pages) {
    if (page.playbackAttempt?.ok) pagesWithPlaybackStarted++;
    if ((page.timing?.visibleAdSignalEvents || 0) > 0) pagesWithVisibleAds++;
    if ((page.warmupSnapshot?.timing?.visibleAdSignalEvents || 0) > 0) pagesWithWarmupVisibleAds++;
    if ((page.timing?.visibleAdSignalEvents || 0) > 0) pagesWithCollectionVisibleAds++;
    if ((page.timing?.visibleLoadingEvents || 0) > 0) pagesWithVisibleLoading++;
    highValueAdPathCount += page.summary?.highValueAdPaths?.length || 0;

    for (const [field, sources] of Object.entries(page.summary?.knownFieldsPresent || {})) {
      const bucket = knownFieldsPresent.get(field);
      if (!bucket) continue;
      for (const source of sources) bucket.add(source);
    }
  }

  return {
    pageCount: pages.length,
    pagesWithPlaybackStarted,
    pagesWithVisibleAds,
    pagesWithWarmupVisibleAds,
    pagesWithCollectionVisibleAds,
    pagesWithVisibleLoading,
    highValueAdPathCount,
    knownFieldsPresent: Object.fromEntries([...knownFieldsPresent.entries()].map(([field, sources]) => {
      return [field, [...sources].sort()];
    }))
  };
}

function requirePlaywright() {
  try {
    return require('playwright-core');
  } catch (err) {
    throw new Error('Missing dependency: run npm.cmd install inside tools\\youtube-player-probe first.');
  }
}

function validateExtensionDir(extensionDir) {
  if (!fs.existsSync(extensionDir)) {
    throw new Error(`Extension directory not found: ${extensionDir}`);
  }
  const manifestPath = path.join(extensionDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Extension manifest not found: ${manifestPath}`);
  }
}

function redactProxy(proxy) {
  try {
    const url = new URL(proxy);
    if (url.username || url.password) {
      url.username = 'redacted';
      url.password = 'redacted';
    }
    return url.toString();
  } catch (_) {
    return '[set]';
  }
}

module.exports = {
  runProbe,
  endpointForUrl,
  summarizeDomEvents
};
