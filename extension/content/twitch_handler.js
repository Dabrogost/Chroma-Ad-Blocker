/**
 * Chroma Ad-Blocker — Smart Twitch Proxy Handler
 *
 * Dynamically registered on *://*.twitch.tv/* (MAIN world, document_start)
 * only while an enabled Twitch proxy route is effective. Strips Authorization
 * strictly from PlaybackAccessToken GraphQL POSTs to gql.twitch.tv/gql across
 * fetch and Web Workers while preserving client/integrity headers and other ops.
 */
(function () {
  'use strict';

  const STATE_EVENT = '__CHROMA_TWITCH_PROXY_STATE__';
  const MAX_BLOB_ENTRIES = 32;
  const MAX_BLOB_BYTES = 20 * 1024 * 1024;
  const host = String(window.location && window.location.hostname || '').toLowerCase().replace(/\.$/, '');
  if (host !== 'twitch.tv' && !host.endsWith('.twitch.tv')) return;

  // Re-activate an existing instance cleanly rather than double-hooking.
  const probe = new CustomEvent(STATE_EVENT, { detail: { active: true }, cancelable: true });
  window.dispatchEvent(probe);
  if (probe.defaultPrevented) return;

  let active = true;
  const channelName = 'chroma_tw_' + (
    typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function'
      ? Array.from(crypto.getRandomValues(new Uint32Array(2)), n => n.toString(16)).join('')
      : Math.random().toString(36).slice(2)
  );
  let broadcastChannel = null;
  try {
    if (typeof BroadcastChannel === 'function') broadcastChannel = new BroadcastChannel(channelName);
  } catch (_) {}

  // Self-contained installer serialized into Web Workers via Function.prototype.toString.
  function installFetchHook(scope, options) {
    var nativeFetch = typeof scope.fetch === 'function' ? scope.fetch : null;
    if (!nativeFetch) return;
    var NativeRequest = typeof scope.Request === 'function' ? scope.Request : null;
    var NativeHeaders = typeof scope.Headers === 'function' ? scope.Headers : null;
    var NativeResponse = typeof scope.Response === 'function' ? scope.Response : null;
    var NativeURL = typeof scope.URL === 'function' ? scope.URL : URL;
    var workerActive = !options || options.initialActive !== false;
    var isActive = options && typeof options.isActive === 'function' ? options.isActive : function () { return workerActive; };

    if (options && options.channelName && typeof scope.BroadcastChannel === 'function') {
      try {
        var ch = new scope.BroadcastChannel(options.channelName);
        ch.onmessage = function (ev) {
          if (ev && ev.data && ev.data.type === 'state' && typeof ev.data.active === 'boolean') workerActive = ev.data.active;
        };
      } catch (_) {}
    }

    function isTwitchGqlUrl(urlValue) {
      if (typeof urlValue !== 'string' || !urlValue) return false;
      try {
        var parsed = new NativeURL(urlValue, (scope.location && scope.location.href) || 'https://www.twitch.tv/');
        return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
          String(parsed.hostname || '').toLowerCase().replace(/\.$/, '') === 'gql.twitch.tv' &&
          (parsed.pathname === '/gql' || parsed.pathname === '/gql/');
      } catch (_) {
        return false;
      }
    }

    function isPlaybackOp(op) {
      if (!op || typeof op !== 'object' || Array.isArray(op)) return false;
      if (typeof op.operationName === 'string' && op.operationName.indexOf('PlaybackAccessToken') !== -1) {
        return true;
      }
      return typeof op.query === 'string' && (
        op.query.indexOf('streamPlaybackAccessToken') !== -1 ||
        op.query.indexOf('videoPlaybackAccessToken') !== -1 ||
        op.query.indexOf('PlaybackAccessToken') !== -1
      );
    }

    function cloneHeaders(input, init, isReq, stripAuth) {
      var source = (init && init.headers !== undefined) ? init.headers : (isReq ? input.headers : undefined);
      if (NativeHeaders) {
        var headers = new NativeHeaders(source);
        if (stripAuth) headers.delete('authorization');
        return headers;
      }
      var copy = {};
      if (source && typeof source === 'object') {
        for (var keys = Object.keys(source), i = 0; i < keys.length; i++) {
          if (!(stripAuth && keys[i].toLowerCase() === 'authorization')) copy[keys[i]] = source[keys[i]];
        }
      }
      return copy;
    }

    function dispatchVariant(input, init, isReq, stripAuth, bodyOverride, fallbackBody) {
      var nextInit = init ? Object.assign({}, init) : {};
      nextInit.headers = cloneHeaders(input, init, isReq, stripAuth);
      if (bodyOverride !== undefined) nextInit.body = bodyOverride;
      else if (isReq && fallbackBody !== null) nextInit.body = fallbackBody;
      return (isReq && NativeRequest)
        ? nativeFetch.call(scope, new NativeRequest(input, nextInit))
        : nativeFetch.call(scope, input, nextInit);
    }

    scope.fetch = function fetch(input, init) {
      var origArgs = arguments;
      if (!isActive()) return nativeFetch.apply(this, origArgs);

      var isReq = !!(NativeRequest && input instanceof NativeRequest);
      var urlStr = isReq ? input.url : (input instanceof NativeURL ? input.href : String(input || ''));
      var method = String((init && init.method) || (isReq ? input.method : 'GET')).toUpperCase();
      if (method !== 'POST' || !isTwitchGqlUrl(urlStr)) return nativeFetch.apply(this, origArgs);

      var bodyPromise;
      if (init && 'body' in init) {
        bodyPromise = Promise.resolve(typeof init.body === 'string' ? init.body : null);
      } else if (isReq && typeof input.clone === 'function') {
        try { bodyPromise = input.clone().text().catch(function () { return null; }); } catch (_) { return nativeFetch.apply(this, origArgs); }
      } else {
        return nativeFetch.apply(this, origArgs);
      }

      return bodyPromise.then(function (bodyText) {
        if (!isActive() || typeof bodyText !== 'string' || !bodyText) return nativeFetch.apply(scope, origArgs);
        if (bodyText.indexOf('PlaybackAccessToken') === -1 &&
            bodyText.indexOf('streamPlaybackAccessToken') === -1 &&
            bodyText.indexOf('videoPlaybackAccessToken') === -1) {
          return nativeFetch.apply(scope, origArgs);
        }

        var parsed;
        try { parsed = JSON.parse(bodyText); } catch (_) { return nativeFetch.apply(scope, origArgs); }

        if (!Array.isArray(parsed)) {
          return isPlaybackOp(parsed)
            ? dispatchVariant(input, init, isReq, true, undefined, bodyText)
            : nativeFetch.apply(scope, origArgs);
        }

        var playbackIndices = [], otherIndices = [];
        for (var i = 0; i < parsed.length; i++) {
          (isPlaybackOp(parsed[i]) ? playbackIndices : otherIndices).push(i);
        }
        if (playbackIndices.length === 0) return nativeFetch.apply(scope, origArgs);
        if (otherIndices.length === 0) return dispatchVariant(input, init, isReq, true, undefined, bodyText);

        var playbackOps = playbackIndices.map(function (idx) { return parsed[idx]; });
        var otherOps = otherIndices.map(function (idx) { return parsed[idx]; });
        return Promise.all([
          dispatchVariant(input, init, isReq, true, JSON.stringify(playbackOps), bodyText),
          dispatchVariant(input, init, isReq, false, JSON.stringify(otherOps), bodyText)
        ]).then(function (responses) {
          var playRes = responses[0], otherRes = responses[1];
          if (!playRes || !playRes.ok || !NativeResponse) return playRes;
          if (!otherRes || !otherRes.ok) return otherRes;
          return Promise.all([playRes.clone().json(), otherRes.clone().json()]).then(function (parts) {
            if (!Array.isArray(parts[0]) || !Array.isArray(parts[1]) ||
                parts[0].length !== playbackIndices.length || parts[1].length !== otherIndices.length) {
              return playRes;
            }
            var merged = new Array(parsed.length);
            for (var p = 0; p < playbackIndices.length; p++) merged[playbackIndices[p]] = parts[0][p];
            for (var o = 0; o < otherIndices.length; o++) merged[otherIndices[o]] = parts[1][o];
            return new NativeResponse(JSON.stringify(merged), {
              status: playRes.status || 200,
              statusText: playRes.statusText || 'OK',
              headers: { 'content-type': 'application/json' }
            });
          }, function () { return playRes; });
        });
      });
    };
  }

  installFetchHook(window, { isActive: () => active });

  window.addEventListener(STATE_EVENT, (event) => {
    const nextActive = event && event.detail && event.detail.active;
    if (typeof nextActive !== 'boolean') return;
    active = nextActive;
    event.preventDefault();
    if (broadcastChannel) {
      try { broadcastChannel.postMessage({ type: 'state', active: nextActive }); } catch (_) {}
    }
  });

  // Wrap Worker construction so player Web Workers inherit the fetch hook.
  const NativeWorker = typeof window.Worker === 'function' ? window.Worker : null;
  if (!NativeWorker) return;

  const blobMap = new Map();
  const nativeCreateObjectURL = URL.createObjectURL;
  const nativeRevokeObjectURL = URL.revokeObjectURL;

  function isTrackableJsBlob(obj) {
    if (typeof Blob !== 'function' || !(obj instanceof Blob) || obj.size > MAX_BLOB_BYTES) return false;
    const type = String(obj.type || '').toLowerCase().split(';')[0].trim();
    return type === '' || type === 'text/javascript' || type === 'application/javascript' || type === 'application/x-javascript';
  }

  if (typeof nativeCreateObjectURL === 'function') {
    URL.createObjectURL = function createObjectURL(obj) {
      const url = nativeCreateObjectURL.call(URL, obj);
      if (isTrackableJsBlob(obj)) {
        if (blobMap.size >= MAX_BLOB_ENTRIES) blobMap.delete(blobMap.keys().next().value);
        blobMap.set(url, obj);
      }
      return url;
    };
  }
  if (typeof nativeRevokeObjectURL === 'function') {
    URL.revokeObjectURL = function revokeObjectURL(url) {
      blobMap.delete(String(url));
      return nativeRevokeObjectURL.call(URL, url);
    };
  }

  function WrappedWorker(scriptURL, options) {
    if (!active) return new NativeWorker(scriptURL, options);
    const urlStr = scriptURL instanceof URL ? scriptURL.href : String(scriptURL || '');
    const bootstrap = '(' + installFetchHook.toString() + ')(self,{channelName:' +
      JSON.stringify(channelName) + ',initialActive:' + (active ? 'true' : 'false') + '});\n';
    try {
      let wrappedBlob = null;
      if (blobMap.has(urlStr)) {
        wrappedBlob = new Blob([bootstrap, blobMap.get(urlStr)], { type: 'application/javascript' });
      } else {
        const resolved = new URL(urlStr, (window.location && window.location.href) || ('https://' + host + '/'));
        if (resolved.origin === window.location.origin && (resolved.protocol === 'https:' || resolved.protocol === 'http:')) {
          const loader = options && options.type === 'module'
            ? 'import ' + JSON.stringify(resolved.href) + ';\n'
            : 'importScripts(' + JSON.stringify(resolved.href) + ');\n';
          wrappedBlob = new Blob([bootstrap, loader], { type: 'application/javascript' });
        }
      }
      if (wrappedBlob) return new NativeWorker(nativeCreateObjectURL.call(URL, wrappedBlob), options);
    } catch (_) {}
    return new NativeWorker(scriptURL, options);
  }

  WrappedWorker.prototype = NativeWorker.prototype;
  try { Object.setPrototypeOf(WrappedWorker, NativeWorker); } catch (_) {}
  window.Worker = WrappedWorker;
})();
