/**
 * Chroma Ad-Blocker — YouTube Handler
 * 
 * Portions of the YouTube ad-stripping and SABR startup recovery logic
 * are derived from Brave Browser's ad-blocking scriptlets and are subject to 
 * the Mozilla Public License, v. 2.0. You can obtain a copy of the MPL 2.0 
 * at https://mozilla.org/MPL/2.0/.
 */

(function() {
  'use strict';

  const DEBUG = false;

  function isYouTubeHost(hostname) {
    const normalized = String(hostname || '').toLowerCase().replace(/\.$/, '');
    return normalized === 'youtube.com' ||
      normalized.endsWith('.youtube.com') ||
      normalized === 'youtube-nocookie.com' ||
      normalized.endsWith('.youtube-nocookie.com');
  }

  if (!isYouTubeHost(window.location && window.location.hostname)) {
    return;
  }

  // ─── CONFIG ─────
  // Use Object.create(null) to protect against Prototype Pollution
  const CONFIG = Object.create(null);
  Object.assign(CONFIG, {
    enabled: false, // Fail closed until the private bridge authenticates config
    stripping: false,
    acceleration: false,
    accelerationSpeed: 8, // Default playback rate supported for ad acceleration
    checkIntervalMs: 300,  // Interval between ad state checks (ms)
  });

  // Whitelist of allowed config keys for secure updates.
  // Mirror of prm_handler.js — the enabled / acceleration / accelerationSpeed /
  // checkIntervalMs validators are intentionally identical across both handlers;
  // keep structurally aligned when changing shared keys.
  const VALID_CONFIG_KEYS = ['enabled', 'stripping', 'acceleration', 'accelerationSpeed', 'checkIntervalMs'];

  const CONFIG_VALIDATORS = Object.freeze({
    enabled:           (v) => typeof v === 'boolean',
    stripping:         (v) => typeof v === 'boolean',
    acceleration:      (v) => typeof v === 'boolean',
    accelerationSpeed: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 16,
    checkIntervalMs:   (v) => typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 5000
  });

  function applyConfig(source) {
    for (const key of VALID_CONFIG_KEYS) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        const val = source[key];
        if (CONFIG_VALIDATORS[key](val)) CONFIG[key] = val;
      }
    }
  }

  // Returns true when the user explicitly enables YouTube ad acceleration.
  // Stripping and acceleration can run together: stripping handles API payloads,
  // while acceleration remains a fallback for ads that still reach playback.
  function shouldAccelerate() {
    return CONFIG.acceleration;
  }

  // ─── AD FIELD STRIPPING (PRIMARY BLOCKER) ─────
  // Deletes ad payload fields from YouTube API responses before the player reads them.
  // Native APIs are captured here — before the beacon suppression IIFE below patches XHR —
  // so the wrap order is: beacon suppression → our wrapper → native (correct chain).
  // This is the entire page-to-isolated telemetry contract. Keep these two
  // constants aligned with protection.js; no payload metadata crosses worlds.
  const MAIN_STATS_EVENT = '__CHROMA_STATS_EVENT__';
  const YOUTUBE_PAYLOAD_MODIFIED = 'youtube_payload_modified';

  function emitStatsEvent(eventType) {
    if (eventType !== YOUTUBE_PAYLOAD_MODIFIED) return;
    try {
      document.dispatchEvent(new CustomEvent(MAIN_STATS_EVENT, { detail: eventType }));
    } catch (_) {}
  }

  function createPayloadStats() {
    return {
      fieldsPruned: 0,
      adObjectsRemoved: 0
    };
  }

  function finishPayloadStats(stats) {
    if (!stats) return;
    // Keep YouTube playback hot paths quiet: unmodified player/next/browse
    // payload inspections can be frequent, especially while streaming through
    // an authenticated proxy, and they do not represent useful protection work.
    if (stats.fieldsPruned === 0 && stats.adObjectsRemoved === 0) return;
    emitStatsEvent(YOUTUBE_PAYLOAD_MODIFIED);
  }

  function cleanYoutubePayload(data) {
    const stats = createPayloadStats();
    let modified = false;
    if (stripAdFields(data, stats)) modified = true;
    if (data?.playerResponse && stripAdFields(data.playerResponse, stats)) modified = true;
    if (stripResponseAds(data, stats)) modified = true;
    finishPayloadStats(stats);
    return modified;
  }

  const AD_FIELDS = [
    'adPlacements',
    'adSlots',
    'playerAds',
    'adBreakParams',
    'adBreakHeartbeatParams',
    'adInferredBlockingStatus',
  ];

  function stripAdFields(obj, stats = null) {
    if (!obj || typeof obj !== 'object') return false;
    let stripped = false;
    for (const field of AD_FIELDS) {
      if (field in obj) {
        delete obj[field];
        if (stats) stats.fieldsPruned++;
        stripped = true;
      }
    }
    return stripped;
  }

  const SHORTS_AD_RENDERER_FIELDS = [
    'adsOverlay',
    'shortsAdsRenderer',
    'sequenceItemInPlayerAdLayoutRenderer',
  ];

  const JSON_PARSE_AD_SIGNAL_NEEDLES = [
    ...AD_FIELDS,
    ...SHORTS_AD_RENDERER_FIELDS,
    'promotedSparklesTextSearchRenderer',
    'searchPyvRenderer',
    'adSlotRenderer',
    'adClientParams',
  ];

  function mightContainYoutubeAdPayloadSignal(text) {
    if (typeof text !== 'string') return true;
    for (let i = 0; i < JSON_PARSE_AD_SIGNAL_NEEDLES.length; i++) {
      if (text.includes(JSON_PARSE_AD_SIGNAL_NEEDLES[i])) return true;
    }
    return false;
  }

  function hasOwn(value, key) {
    return !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
  }

  function getResponseRenderer(item) {
    const content = item?.richItemRenderer?.content;
    return (
      content?.reelVideoRenderer ||
      content?.reelItemRenderer ||
      content ||
      item?.reelVideoRenderer ||
      item?.reelItemRenderer ||
      item
    );
  }

  function hasShortsAdSignal(item) {
    const renderer = getResponseRenderer(item);
    if (!renderer || typeof renderer !== 'object') return false;

    return !!(
      hasOwn(renderer, 'adsOverlay') ||
      hasOwn(renderer, 'shortsAdsRenderer') ||
      hasOwn(renderer, 'sequenceItemInPlayerAdLayoutRenderer') ||
      renderer?.fulfillmentContent?.fulfilledLayout?.sequenceItemInPlayerAdLayoutRenderer ||
      renderer?.command?.reelWatchEndpoint?.adClientParams?.isAd === true ||
      renderer?.reelWatchEndpoint?.adClientParams?.isAd === true
    );
  }

  function stripShortsAdFields(value, stats = null) {
    if (!value || typeof value !== 'object') return false;
    let stripped = false;

    for (const field of SHORTS_AD_RENDERER_FIELDS) {
      if (hasOwn(value, field)) {
        delete value[field];
        if (stats) stats.fieldsPruned++;
        stripped = true;
      }
    }

    const fulfilledLayout = value?.fulfillmentContent?.fulfilledLayout;
    if (hasOwn(fulfilledLayout, 'sequenceItemInPlayerAdLayoutRenderer')) {
      delete fulfilledLayout.sequenceItemInPlayerAdLayoutRenderer;
      if (stats) stats.adObjectsRemoved++;
      stripped = true;
    }

    return stripped;
  }

  function isResponseAdItem(item) {
    return !!(
      item?.promotedSparklesTextSearchRenderer ||
      item?.searchPyvRenderer ||
      item?.adSlotRenderer ||
      item?.richItemRenderer?.content?.adSlotRenderer ||
      hasShortsAdSignal(item)
    );
  }

  function pruneResponseAdItems(value, seen = new WeakSet(), stats = null) {
    if (!value || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);

    let stripped = false;

    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) {
        const item = value[i];
        if (isResponseAdItem(item)) {
          value.splice(i, 1);
          if (stats) stats.adObjectsRemoved++;
          stripped = true;
        } else if (pruneResponseAdItems(item, seen, stats)) {
          stripped = true;
        }
      }
      return stripped;
    }

    if (stripShortsAdFields(value, stats)) stripped = true;

    for (const key of Object.keys(value)) {
      if (pruneResponseAdItems(value[key], seen, stats)) stripped = true;
    }

    return stripped;
  }

  function stripResponseAds(data, stats = null) {
    if (!data) return false;
    let stripped = false;
    try {
      const contents =
        data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
          ?.sectionListRenderer?.contents ||
        data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer
          ?.content?.richGridRenderer?.contents;
      if (Array.isArray(contents)) {
        for (let i = contents.length - 1; i >= 0; i--) {
          const item = contents[i];
          if (isResponseAdItem(item)) {
            contents.splice(i, 1);
            if (stats) stats.adObjectsRemoved++;
            stripped = true;
          }
        }
      }
      if (pruneResponseAdItems(data, new WeakSet(), stats)) stripped = true;
    } catch (_) {}
    return stripped;
  }

  // Hook ytInitialPlayerResponse — strips ad fields from the initial player payload
  // before YouTube's own scripts read the value.
  let _ytInitialPlayerResponse;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get() { return _ytInitialPlayerResponse; },
      set(value) {
        if (CONFIG.enabled && CONFIG.stripping && value && typeof value === 'object') {
          cleanYoutubePayload(value);
        }
        _ytInitialPlayerResponse = value;
      }
    });
  } catch (_) {}

  // Hook ytInitialData — strips ad fields and promoted feed items from page-level data.
  let _ytInitialData;
  try {
    Object.defineProperty(window, 'ytInitialData', {
      configurable: true,
      get() { return _ytInitialData; },
      set(value) {
        if (CONFIG.enabled && CONFIG.stripping && value && typeof value === 'object') {
          cleanYoutubePayload(value);
        }
        _ytInitialData = value;
      }
    });
  } catch (_) {}

  // Capture native fetch/XHR/JSON.parse before anything else in this file modifies them.
  const _nativeToString = Function.prototype.toString;
  const _nativeFetch = window.fetch;
  const _nativeXHROpen = XMLHttpRequest.prototype.open;
  const _nativeXHRSend = XMLHttpRequest.prototype.send;
  const _nativeJSONParse = JSON.parse;

  // Brave's fresh-session/backoff approach, adapted to Chroma's config and
  // navigation lifecycle: https://github.com/brave/adblock-resources/pull/334
  // Decode UMP framing and NextRequestPolicy field 4 explicitly; never scan
  // arbitrary media/cookie bytes for 0x20. Wire definitions are documented at
  // https://github.com/LuanRT/googlevideo/tree/main/protos/video_streaming
  const SABR_CONTROL_LIMIT = 1000;
  let sabrNavigation = 0;
  let sabrRecovery = null;

  function requestUrl(resource) {
    return typeof resource === 'string' ? resource : resource?.url || resource?.href || '';
  }

  function readUmpInteger(bytes, cursor) {
    if (cursor.pos >= bytes.length) throw new Error('Truncated UMP integer');
    const first = bytes[cursor.pos++];
    const extra = first < 128 ? 0 : first < 192 ? 1 : first < 224 ? 2 : first < 240 ? 3 : 4;
    if (cursor.pos + extra > bytes.length) throw new Error('Truncated UMP integer');
    let value = extra === 4 ? 0 : first & (127 >> extra);
    let factor = extra === 4 ? 1 : 2 ** (7 - extra);
    for (let i = 0; i < extra; i++, factor *= 256) value += bytes[cursor.pos++] * factor;
    return value;
  }

  function readProtoInteger(bytes, cursor, end) {
    let value = 0;
    for (let i = 0; i < 8 && cursor.pos < end; i++) {
      const byte = bytes[cursor.pos++];
      value += (byte & 127) * 2 ** (7 * i);
      if (!Number.isSafeInteger(value)) break;
      if (!(byte & 128)) return value;
    }
    throw new Error('Invalid protobuf integer');
  }

  function patchSabrBackoff(bytes) {
    if (!bytes.length || bytes.length >= SABR_CONTROL_LIMIT) return null;
    const cursor = { pos: 0 };
    const fields = [];
    try {
      while (cursor.pos < bytes.length) {
        const type = readUmpInteger(bytes, cursor);
        const length = readUmpInteger(bytes, cursor);
        const end = cursor.pos + length;
        if (end > bytes.length || type === 20 || type === 21 || type === 22) return null;
        if (type === 35) { // NEXT_REQUEST_POLICY; its payload is protobuf.
          while (cursor.pos < end) {
            const tag = readProtoInteger(bytes, cursor, end);
            const field = Math.floor(tag / 8);
            const wire = tag % 8;
            if (!field) return null;
            if (wire === 0) {
              const start = cursor.pos;
              const value = readProtoInteger(bytes, cursor, end);
              if (field === 4 && value > 500 && value < 100000) fields.push([start, cursor.pos]);
            } else if (wire === 1) cursor.pos += 8;
            else if (wire === 2) {
              const size = readProtoInteger(bytes, cursor, end);
              cursor.pos += size;
            } else if (wire === 5) cursor.pos += 4;
            else return null;
            if (cursor.pos > end) return null;
          }
        }
        cursor.pos = end;
      }
    } catch (_) { return null; }
    if (!fields.length) return null;
    const patched = bytes.slice();
    // Preserve encoded widths (and consequently every enclosing UMP length).
    for (const [start, end] of fields) {
      let remaining = 100;
      for (let pos = start; pos < end; pos++) {
        patched[pos] = (remaining & 127) | (pos < end - 1 ? 128 : 0);
        remaining = Math.floor(remaining / 128);
      }
    }
    return patched;
  }

  function getSabrStartup(expected = null) {
    try {
      if (!(CONFIG.enabled && CONFIG.stripping)) return null;
      const page = new URL(window.location.href);
      if (!['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(page.hostname) || page.pathname !== '/watch') return null;
      const videoId = page.searchParams.get('v');
      const player = document.querySelector('#movie_player');
      const video = player?.querySelector('video');
      const response = player?.getPlayerResponse?.();
      if (!videoId || response?.videoDetails?.videoId !== videoId || response.playabilityStatus?.status !== 'OK') return null;
      if (response.videoDetails.isLive || response.videoDetails.isLiveContent || response.videoDetails.isPostLiveDvr) return null;
      const logo = document.querySelector('a#logo[title]');
      if (/premium/i.test(logo?.getAttribute('title') || '') ||
          _ytInitialData?.topbar?.desktopTopbarRenderer?.logo?.topbarLogoRenderer?.iconImage?.iconType === 'YOUTUBE_PREMIUM_LOGO') return null;
      if (expected && (sabrRecovery !== expected || expected.navigation !== sabrNavigation || expected.videoId !== videoId || expected.player !== player)) return null;
      if (!sabrRecovery || sabrRecovery.videoId !== videoId || sabrRecovery.player !== player) {
        sabrRecovery = { navigation: sabrNavigation, videoId, player, retried: false, patches: 0, played: false, requestUntil: 0, playlistRestores: 0 };
      }
      const state = sabrRecovery;
      if (!video || state.played) return null;
      const requestedStart = response.playerConfig?.playbackStartConfig?.startSeconds;
      const startSeconds = Number.isFinite(requestedStart) && requestedStart >= 0 ? requestedStart : 0;
      // A pre-start seek can expose currentTime=startSeconds at HAVE_NOTHING.
      if ((video.currentTime > 1 && Math.abs(video.currentTime - startSeconds) > 1) ||
          video.readyState >= 2 || video.buffered?.length > 0) {
        state.played = true;
        return null;
      }
      // The first SABR request can start while cued (5), before buffering (3).
      // Rejecting it here loses the response carrying the initial ad backoff.
      if (video.readyState !== 0 || ![-1, 3, 5].includes(player.getPlayerState?.()) ||
          player.classList?.contains('ad-showing') || player.classList?.contains('ad-interrupting')) return null;
      return state;
    } catch (_) { return null; }
  }

  function restoreSabrPlaylist(state) {
    try {
      const page = new URL(window.location.href);
      if (sabrRecovery !== state || state.navigation !== sabrNavigation || !state.playlist || state.playlistRestores >= 2 ||
          !(CONFIG.enabled && CONFIG.stripping) || Date.now() > state.requestUntil ||
          page.searchParams.get('v') !== state.videoId || page.searchParams.get('list') !== state.playlist.id) return;
      if (state.player.getPlaylistId?.() === state.playlist.id) return;
      state.playlistRestores++;
      state.playlist.manager.setPlaylistData(state.playlist.data);
      state.playlist.manager.setPlayerPlaybackControlData({ playlistPanelRenderer: state.playlist.data });
    } catch (_) {}
  }

  function retrySabrSession(state) {
    if (state.retried || !getSabrStartup(state)) return;
    const player = state.player;
    if (typeof player.cancelPlayback !== 'function' || typeof player.loadVideoById !== 'function') return;
    try {
      const page = new URL(window.location.href);
      const list = page.searchParams.get('list');
      if (list) {
        const manager = document.querySelector('yt-playlist-manager');
        const data = manager?.getPlaylistData?.();
        // A retry must not silently turn a radio/playlist session into a single video.
        if (!data || typeof manager.setPlaylistData !== 'function' || typeof manager.setPlayerPlaybackControlData !== 'function') return;
        state.playlist = { id: list, manager, data: _nativeJSONParse(JSON.stringify(data)) };
      }
      const start = player.getPlayerResponse?.()?.playerConfig?.playbackStartConfig?.startSeconds;
      state.startSeconds = Number.isFinite(start) && start >= 0 ? start : 0;
      state.retried = true;
      // Let the shortened backoff succeed first. Cancel only if still stalled,
      // then reload immediately; never temporarily replace the player's methods.
      window.setTimeout(() => {
        if (!getSabrStartup(state)) return;
        try {
          const data = player.getVideoData?.();
          if (data) data.isInlinePlaybackNoAd = true;
          state.requestUntil = Date.now() + 5000;
          player.cancelPlayback();
          player.loadVideoById(state.videoId, state.startSeconds);
          restoreSabrPlaylist(state);
        } catch (_) { state.requestUntil = 0; }
      }, 1000);
    } catch (_) {}
  }

  function sabrPlayerRequestState(url) {
    const state = sabrRecovery;
    if (!state || !state.requestUntil || Date.now() > state.requestUntil ||
        !(CONFIG.enabled && CONFIG.stripping)) return null;
    try {
      const target = new URL(url, window.location.href);
      if (!isYouTubeHost(target.hostname) || target.pathname !== '/youtubei/v1/player' ||
          new URL(window.location.href).searchParams.get('v') !== state.videoId) return null;
      return state;
    } catch (_) { return null; }
  }

  function prepareSabrPlayerBody(url, body) {
    const state = sabrPlayerRequestState(url);
    if (!state || typeof body !== 'string' || body.length > 1000000) return body;
    try {
      const data = _nativeJSONParse(body);
      if (data.videoId !== state.videoId || !data.playbackContext?.contentPlaybackContext) return body;
      data.playbackContext.contentPlaybackContext.isInlinePlaybackNoAd = true;
      // Experimental WEB player context from uAssets. The inline hint alone
      // can still receive another ad backoff on the fresh session.
      // https://github.com/uBlockOrigin/uAssets/blob/master/filters/experimental.txt
      if (data.context?.client?.clientName === 'WEB') data.params = 'eAFgAQ';
      return JSON.stringify(data);
    } catch (_) { return body; }
  }

  async function prepareSabrFetchBody(url, body, headers, ownedStream = false) {
    const state = sabrPlayerRequestState(url);
    if (!state || (!ownedStream && typeof body?.getReader === 'function')) return body;
    let reader, timer, expired = false;
    try {
      if (new Headers(headers).get('content-encoding')?.toLowerCase() !== 'gzip') {
        return prepareSabrPlayerBody(url, body);
      }
      if (typeof DecompressionStream !== 'function' || typeof CompressionStream !== 'function') return body;
      // Current WEB player requests are gzip-compressed before fetch. Bound
      // both encoded and decoded bodies, retaining the caller's original on failure.
      const read = async stream => {
        if (expired) throw new Error('Expired player request');
        reader = stream.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (expired) throw new Error('Expired player request');
          if (done) break;
          size += value.length;
          if (size > 1000000) throw new Error('Oversized player request');
          chunks.push(value);
        }
        reader.releaseLock();
        reader = null;
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return bytes;
      };
      const prepare = async () => {
        const compressed = await read(new Response(body).body);
        const decoded = await read(new Response(compressed).body.pipeThrough(new DecompressionStream('gzip')));
        const text = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
        const prepared = prepareSabrPlayerBody(url, text);
        if (prepared === text) return body;
        const encoded = await read(new Response(prepared).body.pipeThrough(new CompressionStream('gzip')));
        return sabrPlayerRequestState(url) === state ? encoded : body;
      };
      return await Promise.race([
        prepare(),
        new Promise(resolve => { timer = window.setTimeout(() => { expired = true; resolve(body); }, 200); })
      ]);
    } catch (_) { return body; }
    finally {
      expired = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (reader) reader.cancel().catch(() => {});
    }
  }

  function sabrRequestState(url) {
    try {
      const target = new URL(url);
      if (target.protocol !== 'https:' || !target.hostname.endsWith('.googlevideo.com') ||
          target.pathname !== '/videoplayback' || target.searchParams.get('sabr') !== '1') return null;
      const state = getSabrStartup();
      return state && state.patches < 2 ? state : null;
    } catch (_) { return null; }
  }

  async function recoverSabrResponse(response, state) {
    if (!response.ok || !response.body || !getSabrStartup(state) || state.patches >= 2) return response;
    let reader;
    let timeout;
    try {
      // Inspect a clone with both a size and time bound. The original response
      // remains usable on unknown framing, normal media, cancellation, or errors.
      reader = response.clone().body.getReader();
      const chunks = [];
      let total = 0;
      const read = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            const bytes = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
            return bytes;
          }
          total += value.length;
          if (total >= SABR_CONTROL_LIMIT) return null;
          chunks.push(value);
        }
      };
      const bytes = await Promise.race([
        read(),
        new Promise(resolve => { timeout = window.setTimeout(() => resolve(null), 100); })
      ]);
      if (!bytes || !getSabrStartup(state) || state.patches >= 2) return response;
      const patched = patchSabrBackoff(bytes);
      if (!patched) return response;
      const result = new Response(patched, { status: response.status, statusText: response.statusText, headers: response.headers });
      for (const key of ['url', 'type', 'redirected']) {
        Object.defineProperty(result, key, { value: response[key], configurable: true });
      }
      state.patches++;
      retrySabrSession(state);
      // No consumer will read the original branch after returning patched bytes.
      response.body.cancel().catch(() => {});
      return result;
    } catch (_) { return response; }
    finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
      if (reader) reader.cancel().catch(() => {});
    }
  }

  const YT_API_PATHS = [
    '/youtubei/v1/player',
    '/youtubei/v1/next',
    '/youtubei/v1/browse',
    '/youtubei/v1/search',
    '/youtubei/v1/reel',
  ];

  // Fetch wrapper — intercepts YouTube API responses and strips ad fields before returning.
  window.fetch = async function(...args) {
    const url = requestUrl(args[0]);
    if (args[1]?.body) {
      const headers = args[1].headers ?? args[0]?.headers;
      const body = await prepareSabrFetchBody(url, args[1].body, headers);
      if (body !== args[1].body) args[1] = { ...args[1], body };
    } else if (CONFIG.enabled && CONFIG.stripping && sabrRecovery?.requestUntil >= Date.now() &&
        url.includes('/youtubei/v1/player') && typeof Request === 'function' && args[0] instanceof Request) {
      try {
        const headers = new Headers(args[1]?.headers ?? args[0].headers);
        const body = headers.get('content-encoding')?.toLowerCase() === 'gzip'
          ? args[0].clone().body : await args[0].clone().text();
        const prepared = await prepareSabrFetchBody(url, body, headers, true);
        if (prepared !== body) args[0] = new Request(args[0], { body: prepared });
      } catch (_) {} // A consumed/uncloneable request follows native fetch semantics.
    }
    const sabrState = sabrRequestState(url);
    const response = await _nativeFetch.apply(this, args);
    if (!(CONFIG.enabled && CONFIG.stripping)) return response;

    if (sabrState) return recoverSabrResponse(response, sabrState);
    if (YT_API_PATHS.some(p => url.includes(p))) {
      try {
        const clone = response.clone();
        const json = await clone.json();
        const modified = cleanYoutubePayload(json);
        if (modified) {
          return new Response(JSON.stringify(json), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
      } catch (_) {}
    }
    return response;
  };
  // Save reference before YouTube's scripts re-wrap window.fetch, so the
  // toString spoof can map our wrapper even after it's no longer the outermost fetch.
  const _ourFetch = window.fetch;

  // XHR wrapper — saves the request URL so the send wrapper can check it.
  // The beacon suppression IIFE (below) captures this as its _origOpen, giving the
  // correct chain: beacon suppression → this wrapper → native open.
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._chromaYTUrl = String(url);
    return _nativeXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    const url = this._chromaYTUrl || '';
    if (args.length) args[0] = prepareSabrPlayerBody(url, args[0]);
    if (CONFIG.enabled && CONFIG.stripping && YT_API_PATHS.some(p => url.includes(p))) {
      this.addEventListener('readystatechange', function() {
        if (this.readyState !== 4) return;
        try {
          const rt = this.responseType;
          if (rt && rt !== '' && rt !== 'text' && rt !== 'json') return;
          const text = rt === 'json' ? JSON.stringify(this.response) : this.responseText;
          const json = _nativeJSONParse(text);
          const modified = cleanYoutubePayload(json);
          if (modified) {
            const stripped = JSON.stringify(json);
            Object.defineProperty(this, 'responseText', { value: stripped, writable: false });
            Object.defineProperty(this, 'response', {
              value: rt === 'json' ? json : stripped,
              writable: false
            });
          }
        } catch (_) {}
      });
    }
    return _nativeXHRSend.apply(this, args);
  };

  // JSON.parse catch-all — strips ad fields from every parsed object regardless of
  // how the bytes arrived (worker-side processing, batched RPC, etc.).
  JSON.parse = function(text, reviver) {
    const result = _nativeJSONParse.call(this, text, reviver);
    if (!(CONFIG.enabled && CONFIG.stripping)) return result;
    if (!mightContainYoutubeAdPayloadSignal(text)) return result;
    try {
      if (result && typeof result === 'object') {
        cleanYoutubePayload(result);
      }
    } catch (_) {}
    return result;
  };

  // Integrity Layer: resolve the secure bridge lazily so a late handshake still
  // upgrades future DOM/timer work to the pristine API cache.
  const FALLBACK_API = {
    querySelector: (s) => document.querySelector(s),
    querySelectorAll: (s) => document.querySelectorAll(s),
    getElementsByClassName: (s) => document.getElementsByClassName(s),
    createElement: (t) => document.createElement(t),
    setInterval: (fn, delay) => window.setInterval(fn, delay),
    clearInterval: (id) => window.clearInterval(id),
    requestAnimationFrame: typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : requestAnimationFrame,
    addDocEventListener: (evt, cb, opts) => document.addEventListener(evt, cb, opts),
    createCssStyleSheet: () => new CSSStyleSheet(),
    getAdoptedStyleSheets: () => document.adoptedStyleSheets,
    setAdoptedStyleSheets: (sheets) => { document.adoptedStyleSheets = sheets; }
  };

  const getBridgeApi = () => window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.api;
  const getBridgeConfig = () => window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.config;
  const getBridgeRevision = () => window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.revision;
  let lastBridgeRevision = -1;
  function rememberBridgeRevision() {
    const revision = getBridgeRevision();
    if (Number.isSafeInteger(revision) && revision >= 0) lastBridgeRevision = revision;
  }
  const API = new Proxy(FALLBACK_API, {
    get(target, key) {
      const bridgeApi = getBridgeApi();
      return (bridgeApi && bridgeApi[key]) || target[key];
    }
  });

  const safeQuery = (s) => API.querySelector(s);
  const safeGetElementsByClassName = (s) => API.getElementsByClassName(s);
  const safeCreate = (t) => API.createElement(t);
  const safeSetInterval = (f, t) => {
    const api = getBridgeApi() || FALLBACK_API;
    return { api, id: api.setInterval(f, t) };
  };
  const safeClearInterval = (timer) => {
    if (!timer) return;
    const api = timer.api || getBridgeApi() || FALLBACK_API;
    api.clearInterval(Object.prototype.hasOwnProperty.call(timer, 'id') ? timer.id : timer);
  };
  const safeRequestAnimationFrame = (f) => API.requestAnimationFrame(f);
  const safeCreateStyleSheet = () => API.createCssStyleSheet();
  const safeGetAdoptedStyleSheets = () => API.getAdoptedStyleSheets();
  const safeSetAdoptedStyleSheets = (sheets) => API.setAdoptedStyleSheets(sheets);

  // ─── STATE ─────
  let targetAdVideo = null;
  let adOverlayHost = null;
  let adOverlayRoot = null;
  let skipListenerAdded = false;

  let chromaAdSessionActive = false;
  let chromaAdSkipped = false;
  let lastAdDetectTime = 0;
  let cachedCurrentAd = 1;
  let cachedTotalAds = 1;
  let lastVideoDuration = 0;
  let _chromaFastWatcher = false;

  // Anti-Tamper: In-memory video state (invisible to page scripts, unlike dataset attributes)
  const videoState = new WeakMap();
  function getVideoState(video) {
    let s = videoState.get(video);
    if (!s) {
      s = {
        listenersAdded: false,
        chromaMuted: false,
        savedVolume: null,
        savedPlaybackRate: null,
        appliedPlaybackRate: null
      };
      videoState.set(video, s);
    }
    return s;
  }

  function applyAcceleratedPlaybackRate(video, state) {
    if (state.appliedPlaybackRate == null) state.savedPlaybackRate = video.playbackRate;
    if (video.playbackRate !== CONFIG.accelerationSpeed) {
      video.playbackRate = CONFIG.accelerationSpeed;
    }
    state.appliedPlaybackRate = CONFIG.accelerationSpeed;
  }

  function restorePlaybackRate(video, state) {
    if (state.appliedPlaybackRate != null && video.playbackRate === state.appliedPlaybackRate) {
      video.playbackRate = state.savedPlaybackRate ?? 1;
    }
    state.savedPlaybackRate = null;
    state.appliedPlaybackRate = null;
  }

  // Anti-Detection: Session stylesheet toggle (replaces observable body class mutations)
  let sessionSheet = null;

  function ensureSessionSheet() {
    if (sessionSheet) return;
    sessionSheet = safeCreateStyleSheet();
    sessionSheet.replaceSync(`
      .ytp-ad-player-overlay,
      .ytp-ad-player-overlay-instream-info {
        z-index: 2147483647 !important;
        pointer-events: none !important;
      }
      .ytp-ad-skip-button-container,
      .ytp-ad-skip-button-slot,
      .ytp-skip-ad-button,
      .videoAdUiSkipButton,
      [id^="skip-button:"] {
        z-index: 2147483647 !important;
        border: 1.5px solid #FE0034 !important;
        border-radius: 24px !important;
        box-shadow: 0 0 15px rgba(254, 0, 52, 0.4),
                    inset 0 0 6px rgba(254, 0, 52, 0.2) !important;
        transition: border-color 0.15s linear, box-shadow 0.15s linear !important;
        overflow: hidden !important;
      }
      .html5-video-player.ytp-autohide .ytp-chrome-bottom,
      .html5-video-player .ytp-chrome-bottom {
        opacity: 1 !important;
        visibility: visible !important;
      }
      .ytp-play-progress,
      .ytp-load-progress,
      .ytp-ad-progress-list,
      .ytp-hover-progress {
        opacity: 0 !important;
        visibility: hidden !important;
      }
    `);
  }

  function activateSessionSheet() {
    ensureSessionSheet();
    const sheets = safeGetAdoptedStyleSheets();
    if (!sheets.includes(sessionSheet)) {
      safeSetAdoptedStyleSheets([...sheets, sessionSheet]);
    }
  }

  function deactivateSessionSheet() {
    if (!sessionSheet) return;
    const sheets = safeGetAdoptedStyleSheets();
    if (sheets.includes(sessionSheet)) {
      safeSetAdoptedStyleSheets(sheets.filter(s => s !== sessionSheet));
    }
  }

  // ─── ACTIVEVIEW / PTRACKING BEACON SUPPRESSION ─────
  // Suppresses activeview and ptracking beacons when no ad session is active,
  // preventing post-session observer floods. Beacons fire normally during
  // active ad playback.
  (function() {
    const _origOpen = XMLHttpRequest.prototype.open;

    XMLHttpRequest.prototype.open = function(method, url) {
      if (typeof url === 'string' &&
          !chromaAdSessionActive &&
          (url.includes('/pcs/activeview') || url.includes('/ptracking'))) {
        this._chromaSuppressed = true;
        return;
      }
      return _origOpen.apply(this, arguments);
    };

    const _origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function() {
      if (this._chromaSuppressed) return;
      return _origSend.apply(this, arguments);
    };
  })();

  // ─── TOSTRING SPOOFING ─────
  // Placed after beacon suppression so the Map captures the final XHR wrappers,
  // not the intermediate stripping wrappers that beacon suppression overlays.
  // fetch is omitted — YouTube's own scripts re-wrap window.fetch after document_start,
  // so we can't make their outer wrapper appear native (nor do we need to).
  (function() {
    const _targets = new Map([
      [_ourFetch,                       'function fetch() { [native code] }'],
      [XMLHttpRequest.prototype.open,   'function open() { [native code] }'],
      [XMLHttpRequest.prototype.send,   'function send() { [native code] }'],
      [JSON.parse,                      'function parse() { [native code] }'],
    ]);

    const _spoof = function toString() {
      if (_targets.has(this)) return _targets.get(this);
      return _nativeToString.call(this);
    };

    // Recursive protection: make the spoof's own toString return a native string.
    Object.defineProperty(_spoof, 'toString', {
      value: function() { return _nativeToString.call(_nativeToString); },
      writable: false,
      configurable: false,
    });

    Function.prototype.toString = _spoof;
  })();

  // ─── AD ACCELERATION ─────
  function initAdOverlay() {
    if (adOverlayHost) return;
    
    adOverlayHost = safeCreate('div');
    // SECURITY: Session Isolation (evade detector scripts)
    adOverlayHost.id = 'chroma-host-' + Math.random().toString(36).substring(2, 9); // Random 7-char suffix to evade detector scripts

    // SECURITY: Shadow DOM Lockdown (prevent host-page tampering)
    adOverlayRoot = adOverlayHost.attachShadow({ mode: 'closed' });
    
    const style = safeCreate('style');
    style.textContent = `
      :host {
        display: block !important;
        position: absolute !important;
        top: 0 !important; left: 0 !important; 
        width: 100% !important; height: 100% !important;
        z-index: 2147483640 !important; /* Below browser default z-index ceiling */
        pointer-events: none !important;
        contain: strict !important;
        margin: 0 !important; padding: 0 !important;
        box-sizing: border-box !important;
        
        /* UX: Visibility delay allows the 0.2s fade-out to complete before interaction handling is removed. */
        visibility: hidden !important;
        transition: visibility 0s 0.2s;
      }
      :host(.active) {
        visibility: visible !important;
        transition: none;
      }
      .chroma-screen {
        position: absolute !important;
        top: 0 !important; left: 0 !important;
        width: 100% !important; height: 100% !important;
        background: rgba(15, 15, 18, 0.8) !important;
        backdrop-filter: blur(12px) !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        color: white !important;
        font-family: 'YouTube Noto', Roboto, Arial, sans-serif !important;
        opacity: 0 !important;
        transition: opacity 0.2s ease !important;
        box-sizing: border-box !important;
        pointer-events: none !important;
      }
      :host(.active) .chroma-screen {
        opacity: 1 !important;
        pointer-events: all !important;
      }
      .chroma-spinner {
        width: 48px; height: 48px;
        border: 4px solid rgba(255,255,255,0.1) !important;
        border-top-color: #FE0034 !important;
        border-radius: 50% !important;
        animation: chroma-spin 1s linear infinite !important;
        margin-bottom: 20px !important;
      }
      @keyframes chroma-spin { 100% { transform: rotate(360deg); } }
      .chroma-checkmark {
        width: 48px; height: 48px;
        border: 4px solid #FE0034;
        border-radius: 50%;
        margin-bottom: 20px;
        position: relative;
      }
      .chroma-checkmark::after {
        content: '';
        position: absolute;
        top: 6px; left: 16px;
        width: 10px; height: 20px;
        border: solid #FE0034;
        border-width: 0 4px 4px 0;
        transform: rotate(45deg);
      }
      .chroma-title {
        font-size: 24px; font-weight: 600; margin-bottom: 8px;
        text-shadow: 0 2px 12px rgba(0,0,0,0.8);
      }
      .chroma-subtitle {
        font-size: 15px; color: #eee;
        text-shadow: 0 1px 4px rgba(0,0,0,0.5);
        margin-top: 8px !important;
        text-align: center !important;
        max-width: 80% !important;
      }
      .chroma-progress-container {
        position: absolute;
        bottom: 0;
        left: 0;
        width: 100%;
        height: 2px;
        background: rgba(255, 255, 255, 0.1);
        overflow: hidden;
      }
      .chroma-progress-bar {
        height: 100%;
        width: 0%;
        background: #FE0034;
        transition: width 0.2s linear, background 0.15s linear;
        box-shadow: 0 0 12px rgba(254, 0, 52, 0.4);
      }
    `;
    
    const screen = safeCreate('div');
    screen.className = 'chroma-screen';

    const spinner = safeCreate('div');
    spinner.className = 'chroma-spinner';
    
    const title = safeCreate('div');
    title.className = 'chroma-title';
    title.textContent = 'Chroma Active';
    
    const subtitle = safeCreate('div');
    subtitle.className = 'chroma-subtitle';
    subtitle.textContent = 'Accelerating Ad...';

    const progressContainer = safeCreate('div');
    progressContainer.className = 'chroma-progress-container';
    
    const progressBar = safeCreate('div');
    progressBar.className = 'chroma-progress-bar';
    progressContainer.appendChild(progressBar);
    
    screen.appendChild(spinner);
    screen.appendChild(title);
    screen.appendChild(subtitle);
    screen.appendChild(progressContainer);

    adOverlayRoot.appendChild(style);
    adOverlayRoot.appendChild(screen);

    const playerContainer = safeQuery('.html5-video-player') || safeQuery('#movie_player');
    if (playerContainer && !playerContainer.contains(adOverlayHost)) {
      playerContainer.appendChild(adOverlayHost);
    }
  }

  function updateAdOverlay(video, effectiveAdShowing, rawAdShowing, adUIElement = null) {
    if (!CONFIG.acceleration || !effectiveAdShowing) {
      if (adOverlayHost && adOverlayHost.classList.contains('active')) {
        adOverlayHost.classList.remove('active');
        
        cachedCurrentAd = 1;
        cachedTotalAds = 1;
        lastVideoDuration = 0;
      }
      return;
    }
    
    if (!adOverlayHost) {
      initAdOverlay();
    }

    const playerContainer = video.closest('.html5-video-player') || video.parentElement;
    if (playerContainer && !playerContainer.contains(adOverlayHost)) {
      playerContainer.appendChild(adOverlayHost);
    }
    
    if (!adOverlayHost.classList.contains('active')) {
      adOverlayHost.classList.add('active');
    }
    

    if (rawAdShowing) {
      if (video && video.duration > 0) {
        if (lastVideoDuration > 0 && Math.abs(video.duration - lastVideoDuration) > 1) {
          if (cachedCurrentAd < cachedTotalAds) {
            cachedCurrentAd++;
          }
        }
        lastVideoDuration = video.duration;
      }

      const adTextSource = adUIElement || playerContainer;
      if (adTextSource) {
        const playerText = adTextSource.textContent || '';
        // Pod Detection: Extracts 'current' and 'total' ad counts from localized UI strings (e.g., 'Ad 1 of 2') to track progress through multi-ad sequences.
        const parsedTextMatch = playerText.match(/(?:[^\d]|^)([0-9]+)\s*(?:of|de|sur|out of|von|di)\s*([0-9]+)(?:[^\d]|$)/i);
        if (parsedTextMatch) {
          const parsedCurrent = parseInt(parsedTextMatch[1], 10);
          const parsedTotal = parseInt(parsedTextMatch[2], 10);
          if (parsedTotal > 1 && parsedCurrent <= parsedTotal) {
            cachedCurrentAd = Math.max(cachedCurrentAd, parsedCurrent);
            cachedTotalAds = Math.max(cachedTotalAds, parsedTotal);
          }
        }
      }
    }

    // Heuristic completion check: Terminal state reached if the final ad in a sequence finishes or a manual skip is detected.
    const isOnFinalAd = (cachedCurrentAd || 1) >= (cachedTotalAds || 1);
    const isAdMediaFinished = video && video.duration > 0 && video.currentTime >= video.duration - 0.5; // 0.5s threshold accounts for imprecise ad media boundaries
    const isAdsDone = (isOnFinalAd && (!rawAdShowing || isAdMediaFinished)) || chromaAdSkipped;
    
    const spinner = adOverlayRoot.querySelector('.chroma-spinner, .chroma-checkmark');
    const titleEl = adOverlayRoot.querySelector('.chroma-title');
    const subtitleEl = adOverlayRoot.querySelector('.chroma-subtitle');
    const progressBar = adOverlayRoot.querySelector('.chroma-progress-bar');

    if (isAdsDone) {
      if (spinner && spinner.className !== 'chroma-checkmark') spinner.className = 'chroma-checkmark';
      if (titleEl) titleEl.textContent = 'Ads Cleared';
      if (subtitleEl) subtitleEl.textContent = 'Loading Video...';
      
      if (progressBar) progressBar.style.width = '100%';
    } else {
      if (spinner && spinner.className !== 'chroma-spinner') spinner.className = 'chroma-spinner';
      if (titleEl) titleEl.textContent = 'Chroma Active';
      
      if (subtitleEl) {
        if (cachedTotalAds > 1) {
          subtitleEl.textContent = `Accelerating Ad (${cachedCurrentAd} of ${cachedTotalAds})...`;
        } else {
          subtitleEl.textContent = 'Accelerating Ad...';
        }
      }

      if (video && video.duration > 0 && rawAdShowing) {
        let videoPercent = (video.currentTime / video.duration) * 100;
        if (videoPercent > 100) videoPercent = 100;
        
        let totalPercent = videoPercent;
        if (cachedTotalAds > 1 && cachedCurrentAd <= cachedTotalAds) {
          const segmentSize = 100 / cachedTotalAds;
          const basePercent = (cachedCurrentAd - 1) * segmentSize;
          totalPercent = basePercent + (videoPercent / cachedTotalAds);
        }
        
        if (progressBar) progressBar.style.width = `${totalPercent}%`;
      }
    }
  }

  const enforceMuteHandler = () => {
    if (chromaAdSessionActive && targetAdVideo) {
      // Prevents the 'sticky mute' bug where content starts but the session hasn't cleared yet.
      const isAdDetected = safeQuery('.ad-showing, .ad-interrupting') || 
                          safeQuery('.ytp-ad-simple-ad-badge, .ytp-ad-duration-remaining, .ytp-ad-preview-text');
      
      if (!isAdDetected) {
        // If we are here, it means the event fired but we don't see an ad anymore.
        // We should trigger a state check to potentially end the session early.
        return;
      }

      if (!targetAdVideo.muted) {
        targetAdVideo.muted = true;
      }
      if (targetAdVideo.volume > 0) {
        targetAdVideo.volume = 0;
      }
    }
  };

  function cleanupVideoState() {
    if (!targetAdVideo) return;

    try {
      targetAdVideo.removeEventListener('volumechange', enforceMuteHandler);
      targetAdVideo.removeEventListener('play', enforceMuteHandler);

      const state = videoState.get(targetAdVideo);
      if (state) {
        restorePlaybackRate(targetAdVideo, state);
        if (state.chromaMuted && targetAdVideo.muted) targetAdVideo.muted = false;
        if (state.savedVolume != null && targetAdVideo.volume === 0) {
          targetAdVideo.volume = state.savedVolume;
        }
        state.listenersAdded = false;
        state.chromaMuted = false;
        state.savedVolume = null;
      }

      targetAdVideo = null;
    } catch (err) {
      if (DEBUG) console.warn('[Chroma Ad-Blocker] Error during video cleanup:', err);
    }
  }

  function handleAdAcceleration() {
    if (!CONFIG.enabled || !CONFIG.acceleration) return;

    let currentAdVideo = safeQuery('.video-ads video, .ytp-ad-module video');
    let hasAdUI = safeQuery(
      '.ytp-ad-simple-ad-badge, .ytp-ad-duration-remaining, .ytp-ad-text, .ytp-ad-preview-text, .ytp-ad-visit-advertiser-button'
    );

    if (!currentAdVideo) {
      const adPlayer = safeQuery('.html5-video-player.ad-showing, .html5-video-player.ad-interrupting');
      if (adPlayer) {
        currentAdVideo = adPlayer.querySelector('video');
      }
    }

    let rawAdShowing = !!currentAdVideo;

    if (!rawAdShowing && hasAdUI) {
      currentAdVideo = safeQuery('#movie_player video, .html5-main-video');
      rawAdShowing = !!currentAdVideo;
    }

    const video = currentAdVideo || targetAdVideo || safeQuery('#movie_player video, .html5-main-video');
    if (!video) return;

    if (rawAdShowing && currentAdVideo) {
      targetAdVideo = currentAdVideo;
    }

    
    if (rawAdShowing) {
      if (!chromaAdSessionActive) {
        if (DEBUG) console.log('[Chroma Ad-Blocker] Ad Session Detected');
        chromaAdSkipped = false;
        // Switches to rAF-synced watcher during active ads for frame-aligned acceleration and overlay updates.
        startFastAdWatcher(); 
      }
      chromaAdSessionActive = true;
      lastAdDetectTime = Date.now();
    }

    if (!rawAdShowing) {
      const now = Date.now();
      const timeSinceAd = lastAdDetectTime ? now - lastAdDetectTime : 0;
      const mainVideo = safeQuery('.html5-main-video');
      const isMainVideoReady = mainVideo && mainVideo.readyState >= 3;

      // Session release logic:
      if (isMainVideoReady || timeSinceAd > 5000) { // Normal release: main video ready; watchdog: force-release after 5000ms if video never becomes ready
        chromaAdSessionActive = false;
        targetAdVideo = null;
      }
    }
    
    if (chromaAdSessionActive) {
      activateSessionSheet();
    } else {
      deactivateSessionSheet();
    }
    
    updateAdOverlay(video, chromaAdSessionActive, rawAdShowing, hasAdUI);

    if (!getVideoState(video).listenersAdded) {
      getVideoState(video).listenersAdded = true;
      video.addEventListener('volumechange', enforceMuteHandler);
      video.addEventListener('play', enforceMuteHandler);
    }

    if (chromaAdSessionActive) {
      if (!video.muted) {
        video.muted = true;
      }
      if (video.volume > 0) {
        if (!getVideoState(video).savedVolume) {
          getVideoState(video).savedVolume = video.volume;
        }
        video.volume = 0;
      }
      
      const state = getVideoState(video);
      if (rawAdShowing) applyAcceleratedPlaybackRate(video, state);
      state.chromaMuted = true;
    } else {
      if (video.muted && getVideoState(video).chromaMuted) {
        video.muted = false;
      }
      const savedVol = getVideoState(video).savedVolume;
      if (savedVol != null) {
        if (savedVol > 0) {
          video.volume = savedVol;
        }
        getVideoState(video).savedVolume = null;
      }
      const state = getVideoState(video);
      restorePlaybackRate(video, state);
      state.chromaMuted = false;
    }
  }

  let pollingInterval = null;

  function stopPolling() {
    if (!pollingInterval) return;
    safeClearInterval(pollingInterval);
    pollingInterval = null;
  }

  function startPolling() {
    if (!(CONFIG.enabled && shouldAccelerate())) {
      stopPolling();
      return;
    }
    stopPolling();
    pollingInterval = safeSetInterval(handleAdAcceleration, CONFIG.checkIntervalMs);
  }

  // ─── NAVIGATION & EVENT HANDLERS ─────
  function onYTNavigate() {
    cleanupVideoState();
    chromaAdSessionActive = false;
    chromaAdSkipped = false;
    lastAdDetectTime = 0;
    cachedCurrentAd = 1;
    cachedTotalAds = 1;

    startPolling();
  }

  API.addDocEventListener('yt-navigate-finish', onYTNavigate);
  API.addDocEventListener('yt-page-data-updated', onYTNavigate);
  API.addDocEventListener('yt-navigate-start', () => {
    sabrNavigation++;
    sabrRecovery = null;
  });
  API.addDocEventListener('playing', event => {
    if (sabrRecovery && event.target === sabrRecovery.player.querySelector('video')) sabrRecovery.played = true;
  }, true);
  API.addDocEventListener('yt-page-data-updated', () => {
    if (sabrRecovery) restoreSabrPlaylist(sabrRecovery);
  });

  API.addDocEventListener('__CHROMA_CONFIG_UPDATE__', () => {
    const revision = getBridgeRevision();
    if (!Number.isSafeInteger(revision) || revision <= lastBridgeRevision) return;
    const bridgeConfig = getBridgeConfig();
    if (!bridgeConfig) return;
    applyConfig(bridgeConfig);
    lastBridgeRevision = revision;

    if (DEBUG) console.log('[Chroma] YouTube handler updated config:', CONFIG);

    if (CONFIG.enabled && shouldAccelerate()) {
      injectChromaCSS();
      startPolling();
      initSkipButtonListener();
    } else {
      stopPolling();
      if (adOverlayHost) adOverlayHost.classList.remove('active');
      chromaAdSessionActive = false;
      _chromaFastWatcher = false;
      deactivateSessionSheet();
      cleanupVideoState();
    }
  });

  function initSkipButtonListener() {
    if (skipListenerAdded) return;
    skipListenerAdded = true;

    API.addDocEventListener('click', (e) => {
      if (!chromaAdSessionActive) return;
      if (!e || !e.target || typeof e.target.closest !== 'function') return;

      try {
        const skipButton = e.target.closest([
          '.ytp-ad-skip-button-container',
          '.ytp-ad-skip-button-slot',
          '.ytp-skip-ad-button',
          '.videoAdUiSkipButton',
          '[id^="skip-button:"]'
        ].join(','));

        if (skipButton) {
          chromaAdSkipped = true;
          if (targetAdVideo) {
            const rawAdShowing = safeGetElementsByClassName('ad-showing').length > 0;
            updateAdOverlay(targetAdVideo, true, rawAdShowing);
          }
        }
      } catch (err) {
        if (DEBUG) console.warn('[Chroma Ad-Blocker] Error in skip button listener:', err);
      }
    }, true);
  }

  function startFastAdWatcher() {
    if (_chromaFastWatcher) return;
    _chromaFastWatcher = true;

    function check() {
      if (!chromaAdSessionActive) {
        _chromaFastWatcher = false;
        return;
      }
      handleAdAcceleration();
      safeRequestAnimationFrame(check);
    }
    safeRequestAnimationFrame(check);
  }

  // Convenience alias — ensures the session stylesheet object exists for later activation.
  function injectChromaCSS() {
    ensureSessionSheet();
  }

  function init() {
    // 1. Initial check (might be ready if script is deferred or loaded slowly)
    const hasInitialConfig = !!getBridgeConfig();
    if (hasInitialConfig) {
      // SECURITY: Handshake Configuration Validation
      applyConfig(getBridgeConfig());
      rememberBridgeRevision();
    }

    // If config is already available, start immediately. Otherwise, poll for handshake.
    if (CONFIG.enabled && shouldAccelerate()) {
      injectChromaCSS();
      startPolling();
      initSkipButtonListener();
    } else if (!hasInitialConfig) {
      // Safety Fallback: Poll for isolated-world sentinel before activating.
      let _pollCount = 0;
      const _pollId = safeSetInterval(() => {
        const config = getBridgeConfig();
        _pollCount++;

        if (config) {
          safeClearInterval(_pollId);
          applyConfig(config);
          rememberBridgeRevision();
          if (CONFIG.enabled && shouldAccelerate()) {
            injectChromaCSS();
            startPolling();
            initSkipButtonListener();
          }
        } else if (_pollCount >= 40) {
          safeClearInterval(_pollId);
        }
      }, 50); // Polling frequency (50ms) for initialization check
    }
  }

  init();

  // ─── TESTING EXPORTS ─────
  if (typeof globalThis !== 'undefined' && globalThis.__CHROMA_INTERNAL_TEST_STRICT__ === true) {
    globalThis.CONFIG = CONFIG;
    globalThis.stripAdFields = stripAdFields;
    globalThis.stripResponseAds = stripResponseAds;
    globalThis.mightContainYoutubeAdPayloadSignal = mightContainYoutubeAdPayloadSignal;
    globalThis.patchSabrBackoff = patchSabrBackoff;
    globalThis.shouldAccelerate = shouldAccelerate;
    globalThis.initAdOverlay = initAdOverlay;
    globalThis.handleAdAcceleration = handleAdAcceleration;
    
    // Test hook: exposes internal state to the Node vm test harness.
    globalThis.__CHROMA_STATE_BRIDGE__ = {
      get chromaAdSessionActive() { return chromaAdSessionActive; },
      set chromaAdSessionActive(v) { chromaAdSessionActive = v; },
      get chromaAdSkipped() { return chromaAdSkipped; },
      set chromaAdSkipped(v) { chromaAdSkipped = v; },
      get lastAdDetectTime() { return lastAdDetectTime; },
      set lastAdDetectTime(v) { lastAdDetectTime = v; }
    };
  }
})();
