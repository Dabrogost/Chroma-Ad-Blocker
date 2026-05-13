'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { KNOWN_STRIPPER_FIELDS, walkJson } = require('./sanitize');

const YOUTUBE_ENDPOINTS = Object.freeze([
  { name: 'player', marker: '/youtubei/v1/player' },
  { name: 'next', marker: '/youtubei/v1/next' },
  { name: 'browse', marker: '/youtubei/v1/browse' },
  { name: 'search', marker: '/youtubei/v1/search' },
  { name: 'reel', marker: '/youtubei/v1/reel' }
]);

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
          readyState: video.readyState,
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
      paused: video.paused,
      currentTime: Number.isFinite(video.currentTime) ? Number(video.currentTime.toFixed(3)) : null,
      duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : null
    });
    if (video.readyState >= 3 && !video.paused) {
      push('video-playing-snapshot', {
        currentTime: Number.isFinite(video.currentTime) ? Number(video.currentTime.toFixed(3)) : null,
        duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : null,
        readyState: video.readyState,
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
    try {
      const observer = new MutationObserver(() => {
        scanVideos();
        sampleSignals();
      });
      observer.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    } catch (_) {}
    setInterval(scanVideos, 500);
    setInterval(sampleSignals, 250);
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
  return YOUTUBE_ENDPOINTS.find((endpoint) => url.includes(endpoint.marker)) || null;
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
    waitingEvents: waitingEvents.length,
    adSignalEvents: adSignalEvents.length,
    visibleAdSignalEvents: visibleAdSignalEvents.length,
    visibleLoadingEvents: visibleLoadingEvents.length,
    visibleErrorEvents: visibleErrorEvents.length,
    visibleAdSignals: [...visibleAdSignals].sort(),
    visibleLoadingSignals: [...visibleLoadingSignals].sort(),
    visibleErrorSignals: [...visibleErrorSignals].sort(),
    playerClassStates: [...playerClassStates].sort(),
    domSignals: [...allSignals].sort()
  };
}

async function createBrowserContext(playwright, options) {
  const launchOptions = {
    headless: options.headless,
    executablePath: options.executablePath || undefined,
    proxy: options.proxy ? { server: options.proxy } : undefined
  };

  if (options.profileDir) {
    fs.mkdirSync(options.profileDir, { recursive: true });
    return {
      browser: null,
      context: await playwright.chromium.launchPersistentContext(options.profileDir, launchOptions)
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
      url: safeUrlSummary(url),
      status: response.status(),
      requestToResponseMs: receivedAt - requestStartedAt,
      navigationToResponseMs: receivedAt - navigationStart,
      adLikePaths: [],
      knownStripperPathsPresent: [],
      pathTypes: {},
      truncated: false,
      parseError: null
    };

    try {
      const json = await response.json();
      const sanitized = walkJson(json, {
        maxDepth: options.maxDepth,
        maxPaths: options.maxPaths,
        includePathTypes: options.includePathTypes
      });
      Object.assign(summary, sanitized);
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
    network: collectionSnapshot.network,
    initialPayloads: collectionSnapshot.initialPayloads,
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
  const timing = summarizeDomEvents(domEvents);

  return {
    phase,
    timing,
    network,
    initialPayloads,
    domEvents
  };
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
    return {
      paused: video.paused,
      readyState: video.readyState,
      currentTime: Number.isFinite(video.currentTime) ? Number(video.currentTime.toFixed(3)) : null,
      duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : null,
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
    return [name, sanitized];
  }));
}

function buildPageSummary(page) {
  const allAdLikePaths = new Set();
  const highValueAdPaths = new Set();
  const knownStripperPathsPresent = new Set();
  const knownFieldsPresent = new Map(KNOWN_STRIPPER_FIELDS.map((field) => [field, new Set()]));
  const sourceCounts = [];

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
    waitingEvents: page.timing.waitingEvents,
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

async function runProbe(options) {
  const urls = loadUrls(options);
  if (urls.length === 0) {
    throw new Error('Provide --url or --urls <file>.');
  }

  const playwright = requirePlaywright();
  const executablePath = options.executablePath || process.env.CHROME_FOR_TESTING_PATH || process.env.CHROME_PATH || null;
  if (!executablePath) {
    throw new Error('Set CHROME_FOR_TESTING_PATH, CHROME_PATH, or pass --browser <path>. This tool uses playwright-core and does not download browser builds.');
  }
  const { browser, context } = await createBrowserContext(playwright, {
    headless: options.headless,
    executablePath,
    proxy: options.proxy,
    profileDir: options.profileDir
  });

  const report = {
    run: {
      timestamp: new Date().toISOString(),
      tool: 'youtube-player-probe',
      version: '0.1.0',
      browser: executablePath ? path.basename(executablePath) : 'playwright-default-chromium',
      executablePath: executablePath ? '[redacted]' : null,
      proxy: options.proxy ? redactProxy(options.proxy) : false,
      headless: options.headless,
      clickPlay: options.clickPlay,
      preplayReload: options.preplayReload,
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
