/**
 * Chroma Ad-Blocker - Twitch Handler
 *
 * Three-layer ad suppression strategy:
 *
 *   1. GQL playerType substitution (vaft ForceAccessTokenPlayerType):
 *      Intercepts Twitch's own PlaybackAccessToken GQL request and rewrites
 *      playerType → 'popout'. Twitch issues a stream token that never has SSAI
 *      ads stitched in. Primary defense — ads never enter the pipeline.
 *
 *   2. Backup stream (vaft backup stream):
 *      If the IVS Worker detects 'stitched' in a variant playlist (Phase 1
 *      bypassed), it requests a fresh access token via the main-thread GQL proxy
 *      and fetches a clean variant from an alternate player type. Tries
 *      ['embed', 'site', 'popout', 'mobile_web'] in order. Silent safety net.
 *
 * Additional:
 *   - window.open suppression (nowoif equivalent): blocks popup/redirect ads
 *     triggered by Amazon's ad SDK (amazon-adsystem pattern).
 *   - Network blocking via rules/rules_twitch.json: blocks Twitch ad endpoints
 *     and redirects amazon-adsystem.com/aax2/apstag.js to a no-op stub.
 */

(function() {
  'use strict';

  const DEBUG = false;

  // ─── CONFIG ─────
  const CONFIG = Object.create(null);
  Object.assign(CONFIG, {
    enabled: false,    // Default to disabled until handshake (KILL SWITCH)
    twitchHLS: true,   // Master toggle for Twitch ad suppression
  });

  const VALID_CONFIG_KEYS = ['enabled', 'twitchHLS'];

  const CONFIG_VALIDATORS = Object.freeze({
    enabled:   (v) => typeof v === 'boolean',
    twitchHLS: (v) => typeof v === 'boolean',
  });

  function applyConfig(source) {
    for (const key of VALID_CONFIG_KEYS) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        const val = source[key];
        if (CONFIG_VALIDATORS[key](val)) CONFIG[key] = val;
      }
    }
  }

  // ─── PRISTINE API BRIDGE ─────
  // Utilize pre-cached native APIs from the secure bridge to bypass host-page
  // prototype pollution. Falls back to direct bindings if handshake hasn't fired yet.
  const API = (window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.api) ?
              window.__CHROMA_INTERNAL__.api :
              {
                querySelector:       document.querySelector.bind(document),
                createElement:       document.createElement.bind(document),
                addEventListener:    window.addEventListener.bind(window),
                setInterval:         window.setInterval.bind(window),
                clearInterval:       window.clearInterval.bind(window),
                addDocEventListener: document.addEventListener.bind(document)
              };

  const sI = (f, t) => API.setInterval(f, t);
  const cI = (i)    => API.clearInterval(i);

  // ─── PRISTINE NATIVE CACHE ─────
  // Captured before any Twitch scripts load — used by wrappers and spoof map.
  const _nativeToString = Function.prototype.toString;  // unbound — must use .call(fn)
  const _nativeOpen     = window.open.bind(window);
  const _nativeFetch    = window.fetch;
  const _OrigWorker              = window.Worker;
  const _nativeCreateObjectURL   = URL.createObjectURL.bind(URL);
  const _nativeRevokeObjectURL   = URL.revokeObjectURL.bind(URL);

  // Captured from Twitch's own GQL requests — used to make authenticated backup
  // GQL calls and as signal that the page is fully initialised.
  let _capturedAuth       = null;
  let _capturedIntegrity  = null;
  let _capturedVersion    = null;
  let _capturedSession    = null;
  let _capturedDeviceId   = null;

  // Worker tracking for backup stream messaging
  const twitchWorkers  = [];    // wrapped Worker instances
  let _streamInfoCache = {};    // variantUrl → {channelName, resolution, usherParams}

  // ─── TWITCH PLAYLIST DETECTION ─────

  function isTwitchPlaylist(url) {
    try {
      const u = new URL(url);
      return u.pathname.endsWith('.m3u8') && (
        u.hostname.endsWith('.ttvnw.net') ||
        u.hostname.endsWith('.twitchapps.com') ||
        u.hostname.endsWith('.twitch.tv')
      );
    } catch { return false; }
  }

  // ─── WORKER INTERCEPTION — IVS PLAYER HLS PROXY ─────
  // The Amazon IVS player runs in a WebWorker that has its own fetch context.
  // MAIN world fetch wrappers cannot intercept Worker fetch calls (browser
  // security boundary). Solution: override the Worker constructor to create a
  // blob Worker that wraps self.fetch with our M3U8 ad-stripping logic, then
  // loads the original IVS worker code via importScripts().

  // Broadcasts a key/value message to all tracked Twitch Workers.
  function postTwitchWorkerMessage(key, value) {
    twitchWorkers.forEach(function(w) {
      try { w.postMessage({ key, value }); } catch(_) {}
    });
  }

  // Self-contained fetch wrapper for injection into the Worker.
  // No closures over MAIN world variables — Worker is a separate execution context.
  // The __CHROMA_ORIG_URL__ placeholder is replaced with the actual URL at runtime.
  const WORKER_FETCH_WRAPPER = [
    '(function(){',
    '  try{',
    '    var _u=new URL("__CHROMA_ORIG_URL__");',
    '    Object.defineProperty(self,"location",{value:Object.freeze({',
    '      href:_u.href,origin:_u.origin,protocol:_u.protocol,',
    '      host:_u.host,hostname:_u.hostname,port:_u.port,',
    '      pathname:_u.pathname,search:_u.search,hash:_u.hash,',
    '      toString:function(){return _u.href}',
    '    })});',
    '  }catch(_){}',
    '  var _origFetch=self.fetch;',
    '  var _pending=new Map();',
    '  var _streamInfos={};',
    '  var _auth=null,_integrity=null,_clientVersion=null,_clientSession=null,_deviceId=null;',
    '  var _clientId="kimne78kx3ncx6brgo4mv6wki5h1ko";',
    '  function _isPlaylist(url){',
    '    try{',
    '      var u=new URL(url);',
    '      return u.pathname.endsWith(".m3u8")&&(',
    '        u.hostname.endsWith(".ttvnw.net")||',
    '        u.hostname.endsWith(".twitchapps.com")||',
    '        u.hostname.endsWith(".twitch.tv"));',
    '    }catch(e){return false}',
    '  }',
    '  function _gqlRequest(body){',
    '    return new Promise(function(resolve,reject){',
    '      var id=Math.random().toString(36).slice(2);',
    '      var tid=setTimeout(function(){',
    '        if(_pending.has(id)){_pending.delete(id);reject(new Error("FetchRequest timed out"));}',
    '      },15000);',
    '      _pending.set(id,{resolve:resolve,reject:reject,tid:tid});',
    '      if(!_deviceId){',
    '        var chars="abcdefghijklmnopqrstuvwxyz0123456789";',
    '        _deviceId="";for(var di=0;di<32;di++)_deviceId+=chars[Math.floor(Math.random()*chars.length)];',
    '      }',
    '      var hdrs={"Client-ID":_clientId,"X-Device-Id":_deviceId};',
    '      if(_auth)hdrs["Authorization"]=_auth;',
    '      if(_integrity)hdrs["Client-Integrity"]=_integrity;',
    '      if(_clientVersion)hdrs["Client-Version"]=_clientVersion;',
    '      if(_clientSession)hdrs["Client-Session-Id"]=_clientSession;',
    '      postMessage({key:"FetchRequest",value:{id:id,url:"https://gql.twitch.tv/gql",options:{method:"POST",body:JSON.stringify(body),headers:hdrs}}});',
    '    });',
    '  }',
    '  function _getAccessToken(ch,pt){',
    '    return _gqlRequest({operationName:"PlaybackAccessToken",variables:{isLive:true,login:ch,isVod:false,vodID:"",playerType:pt,platform:"web"},extensions:{persistedQuery:{version:1,sha256Hash:"ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9"}}});',
    '  }',
    '  function _getStreamUrl(masterText,targetRes){',
    '    var lines=masterText.split("\\n"),best=null,bestDiff=Infinity;',
    '    var tw=0,th=0;if(targetRes){var p=targetRes.split("x");tw=+p[0]||0;th=+p[1]||0;}',
    '    for(var i=0;i<lines.length-1;i++){',
    '      if(lines[i].indexOf("EXT-X-STREAM-INF")>=0&&lines[i+1].indexOf(".m3u8")>=0){',
    '        var m=lines[i].match(/RESOLUTION=(\\d+x\\d+)/);',
    '        if(m){var rp=m[1].split("x"),rw=+rp[0],rh=+rp[1],diff=Math.abs(rw*rh-tw*th);',
    '          if(diff<bestDiff){best=lines[i+1].trim();bestDiff=diff;}}',
    '      }',
    '    }',
    '    return best;',
    '  }',
    '  function _processVariant(url,text){',
    '    if(text.indexOf("stitched")<0)return Promise.resolve(null);',
    '    var info=_streamInfos[url];',
    '    if(!info)return Promise.resolve(null);',
    '    var types=["embed","site","popout","mobile_web"];',
    '    function tryNext(i){',
    '      if(i>=types.length)return Promise.resolve(null);',
    '      return _getAccessToken(info.channelName,types[i]).then(function(r){',
    '        if(!r||r.status!==200)return tryNext(i+1);',
    '        var d;try{d=JSON.parse(r.body);}catch(e){return tryNext(i+1);}',
    '        var tok=d&&d.data&&d.data.streamPlaybackAccessToken;',
    '        if(!tok)return tryNext(i+1);',
    '        var mu=new URL("https://usher.ttvnw.net/api/channel/hls/"+info.channelName+".m3u8"+info.usherParams);',
    '        mu.searchParams.delete("parent_domains");',
    '        mu.searchParams.set("sig",tok.signature);',
    '        mu.searchParams.set("token",tok.value);',
    '        return _origFetch(mu.href).then(function(mr){',
    '          if(!mr||mr.status!==200)return tryNext(i+1);',
    '          return mr.text().then(function(mt){',
    '            var vu=_getStreamUrl(mt,info.resolution);',
    '            if(!vu)return tryNext(i+1);',
    '            return _origFetch(vu).then(function(vr){',
    '              if(!vr||vr.status!==200)return tryNext(i+1);',
    '              return vr.text().then(function(vt){',
    '                if(vt.indexOf("stitched")>=0)return tryNext(i+1);',
    '                console.log("[Chroma Worker] backup stream clean ("+types[i]+")");',
    '                return vt;',
    '              });',
    '            });',
    '          });',
    '        });',
    '      }).catch(function(){return tryNext(i+1);});',
    '    }',
    '    return tryNext(0).catch(function(){return null;});',
    '  }',
    '  self.addEventListener("message",function(e){',
    '    if(!e||!e.data)return;',
    '    var d=e.data;',
    '    if(d.key==="FetchResponse"){',
    '      var p=_pending.get(d.value&&d.value.id);',
    '      if(p){_pending.delete(d.value.id);clearTimeout(p.tid);',
    '        if(d.value.error)p.reject(new Error(d.value.error));else p.resolve(d.value);}',
    '    }else if(d.key==="UpdateAuthorizationHeader")_auth=d.value;',
    '    else if(d.key==="UpdateClientIntegrityHeader")_integrity=d.value;',
    '    else if(d.key==="UpdateClientVersion")_clientVersion=d.value;',
    '    else if(d.key==="UpdateClientSession")_clientSession=d.value;',
    '    else if(d.key==="UpdateDeviceId")_deviceId=d.value;',
    '    else if(d.key==="StreamInfoUpdate"){',
    '      var si=d.value;for(var k in si)_streamInfos[k]=si[k];',
    '    }',
    '  });',
    '  self.fetch=function(){',
    '    var args=Array.prototype.slice.call(arguments);',
    '    var _url=typeof args[0]==="string"?args[0]:(args[0]&&args[0].url||"");',
    '    if(_url.indexOf("/channel/hls/")>=0&&_url.indexOf("parent_domains")>=0){',
    '      try{var pu=new URL(_url);pu.searchParams.delete("parent_domains");args[0]=_url=pu.href;}catch(e){}',
    '    }',
    '    return _origFetch.apply(this,args).then(function(response){',
    '      if(!_isPlaylist(_url))return response;',
    '      return response.clone().text().then(function(text){',
    '        if(text.indexOf("#EXTM3U")<0)return response;',
    '        if(_url.indexOf("/channel/hls/")>=0){',
    '          try{',
    '            var ch=_url.match(/\\/hls\\/([^\\.]+)\\.m3u8/);if(ch)ch=ch[1];',
    '            var usp=_url.indexOf("?")>=0?_url.slice(_url.indexOf("?")):"";',
    '            var ml=text.split("\\n");',
    '            for(var i=0;i<ml.length-1;i++){',
    '              if(ml[i].indexOf("EXT-X-STREAM-INF")>=0&&ml[i+1].indexOf(".m3u8")>=0){',
    '                var rm=ml[i].match(/RESOLUTION=(\\d+x\\d+)/);',
    '                _streamInfos[ml[i+1].trim()]={channelName:ch||"",resolution:rm?rm[1]:"",usherParams:usp};',
    '              }',
    '            }',
    '          }catch(e){}',
    '          return response;',
    '        }',
    '        return _processVariant(_url,text).then(function(result){',
    '          if(result===null)return response;',
    '          return new Response(result,{status:response.status,statusText:response.statusText,headers:response.headers});',
    '        }).catch(function(){return response});',
    '      }).catch(function(){return response});',
    '    });',
    '  };',
    '})();'
  ].join('\n');

  window.Worker = function chromaTwitchWorker(url, options) {
    // Resolve URL objects to strings for detection (Twitch/webpack may pass URL objects)
    var urlStr = (url instanceof URL) ? url.href : (typeof url === 'string' ? url : String(url || ''));

    if (DEBUG) console.log('[Chroma Twitch] Worker constructor called with URL:', urlStr.slice(0, 200), 'type:', typeof url);

    // Wrap the IVS worker for HLS ad stripping. Twitch webpack creates the IVS
    // worker as a blob: URL (the original script is bundled inline), so we match
    // both direct script URLs and blob: URLs. The fetch wrapper inside only
    // intercepts .m3u8 playlist responses — all other requests pass through
    // unchanged, making this safe for non-IVS blob workers too.
    // Module workers don't support importScripts — fall through for those.
    var shouldWrap = !(options && options.type === 'module') && (
      urlStr.includes('amazon-ivs-wasmworker') ||
      urlStr.startsWith('blob:')
    );

    if (shouldWrap) {
      try {
        var safeUrl = urlStr.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        var wrapperSrc = WORKER_FETCH_WRAPPER.replace('__CHROMA_ORIG_URL__', safeUrl);
        var blobUrl = _nativeCreateObjectURL(
          new Blob(
            [wrapperSrc + '\nimportScripts(' + JSON.stringify(urlStr) + ');'],
            { type: 'application/javascript' }
          )
        );
        var worker = new _OrigWorker(blobUrl, options);
        setTimeout(function() { _nativeRevokeObjectURL(blobUrl); }, 5000);
        // Prune any terminated workers before tracking the new one
        twitchWorkers.length = 0;
        twitchWorkers.push(worker);

        // Seed Worker with any auth + stream info already captured before this Worker started
        try {
          if (_capturedAuth)       worker.postMessage({ key: 'UpdateAuthorizationHeader',   value: _capturedAuth });
          if (_capturedIntegrity)  worker.postMessage({ key: 'UpdateClientIntegrityHeader', value: _capturedIntegrity });
          if (_capturedVersion)    worker.postMessage({ key: 'UpdateClientVersion',         value: _capturedVersion });
          if (_capturedSession)    worker.postMessage({ key: 'UpdateClientSession',         value: _capturedSession });
          if (_capturedDeviceId)   worker.postMessage({ key: 'UpdateDeviceId',              value: _capturedDeviceId });
          if (Object.keys(_streamInfoCache).length) {
            worker.postMessage({ key: 'StreamInfoUpdate', value: _streamInfoCache });
          }
        } catch(_) {}

        // Proxy authenticated GQL fetch requests from Worker (Workers can't send credentialed requests)
        worker.addEventListener('message', async function(e) {
          if (!e.data || e.data.key !== 'FetchRequest') return;
          const req = e.data.value;
          try {
            const resp = await _nativeFetch(req.url, req.options);
            const body = await resp.text();
            worker.postMessage({
              key: 'FetchResponse',
              value: {
                id: req.id,
                status: resp.status,
                statusText: resp.statusText,
                headers: Object.fromEntries(resp.headers.entries()),
                body
              }
            });
          } catch(err) {
            worker.postMessage({ key: 'FetchResponse', value: { id: req.id, error: err.message } });
          }
        });

        if (DEBUG) console.log('[Chroma Twitch] Worker wrapped for HLS ad stripping:', urlStr.slice(0, 80));
        return worker;
      } catch (e) {
        if (DEBUG) console.warn('[Chroma Twitch] Worker wrap failed, falling through:', e);
      }
    }
    return new _OrigWorker(url, options);
  };

  // ─── FETCH INTERCEPT — HLS PLAYLIST REWRITING (DEFENSE-IN-DEPTH) ─────
  // Intercepts main-thread m3u8 playlist requests. The primary interception is
  // inside the Worker (above), but this catches any playlist fetches that go
  // through the main thread's fetch API.
  window.fetch = async function chromaTwitchFetch(...args) {
    // Check URL before awaiting — avoids CONFIG race during the handshake window.
    // Script only loads on *.twitch.tv, so no external kill switch needed here.
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');

    // ── GQL intercept: capture auth headers + replace playerType ──
    // vaft's ForceAccessTokenPlayerType approach: rewrite 'site' → 'popout' in the
    // PlaybackAccessToken GQL request. The Twitch CDN issues different stream tokens
    // per player type; 'popout' historically receives a stream without SSAI ads stitched.
    if (url.includes('gql.twitch.tv')) {
      const init = args[1] || {};
      const hdrs = init.headers || {};
      // Capture credentials for potential Phase-2 backup stream GQL calls.
      // Twitch constructs headers with capitalized names; HTTP/2 normalizes to lowercase.
      // Check both forms to be safe.
      if (hdrs['Authorization']     || hdrs['authorization'])      _capturedAuth      = hdrs['Authorization']     || hdrs['authorization'];
      if (hdrs['Client-Integrity']  || hdrs['client-integrity'])   _capturedIntegrity = hdrs['Client-Integrity']  || hdrs['client-integrity'];
      if (hdrs['Client-Version']    || hdrs['client-version'])     _capturedVersion   = hdrs['Client-Version']    || hdrs['client-version'];
      if (hdrs['Client-Session-Id'] || hdrs['client-session-id'])  _capturedSession   = hdrs['Client-Session-Id'] || hdrs['client-session-id'];
      if (hdrs['X-Device-Id']       || hdrs['x-device-id'])        _capturedDeviceId  = hdrs['X-Device-Id']       || hdrs['x-device-id'];

      // Forward captured auth to active Workers so they can make backup-stream GQL calls
      if (_capturedAuth)       postTwitchWorkerMessage('UpdateAuthorizationHeader',   _capturedAuth);
      if (_capturedIntegrity)  postTwitchWorkerMessage('UpdateClientIntegrityHeader', _capturedIntegrity);
      if (_capturedVersion)    postTwitchWorkerMessage('UpdateClientVersion',         _capturedVersion);
      if (_capturedSession)    postTwitchWorkerMessage('UpdateClientSession',         _capturedSession);
      if (_capturedDeviceId)   postTwitchWorkerMessage('UpdateDeviceId',              _capturedDeviceId);

      // Replace playerType only in PlaybackAccessToken operations
      if (typeof init.body === 'string' && init.body.includes('PlaybackAccessToken')) {
        try {
          const body = JSON.parse(init.body);
          // Body may be a single operation object or an array of operations
          const ops = Array.isArray(body) ? body : [body];
          let replaced = false;
          for (const op of ops) {
            if (op?.variables?.playerType && op.variables.playerType !== 'popout') {
              if (DEBUG) console.log('[Chroma Twitch] GQL playerType:', op.variables.playerType, '→ popout');
              op.variables.playerType = 'popout';
              replaced = true;
            }
          }
          if (replaced) {
            args[1] = { ...init, body: JSON.stringify(Array.isArray(body) ? ops : ops[0]) };
          }
        } catch (_) {}
      }
      return _nativeFetch.apply(this, args);
    }

    // Only intercept Twitch master playlists — for parent_domains strip and stream info capture.
    if (!isTwitchPlaylist(url) || !url.includes('/channel/hls/')) return _nativeFetch.apply(this, args);

    // Strip parent_domains — Twitch uses it to detect embed context and can serve a
    // different (ad-heavier) stream category when it's present. Use a mutable local so
    // the cleaned URL is used for the fetch and for usherParams forwarded to Workers.
    let cleanUrl = url;
    if (url.includes('parent_domains')) {
      try {
        const pu = new URL(url);
        pu.searchParams.delete('parent_domains');
        cleanUrl = pu.href;
        args[0] = cleanUrl;
      } catch(_) {}
    }

    const response = await _nativeFetch.apply(this, args);
    try {
      const text = await response.clone().text();
      if (!text.includes('#EXT-X-STREAM-INF')) return response;

      // Capture variant URL → {channelName, resolution, usherParams} so Workers
      // can construct backup stream URLs when they detect SSAI ads.
      const channelMatch = new URL(cleanUrl).pathname.match(/([^\/]+)(?=\.\w+$)/);
      const channelName = channelMatch ? channelMatch[0] : '';
      const usherParams = new URL(cleanUrl).search;
      const newInfos = {};
      const mLines = text.split('\n');
      for (let i = 0; i < mLines.length - 1; i++) {
        if (mLines[i].startsWith('#EXT-X-STREAM-INF') && mLines[i+1].trim().includes('.m3u8')) {
          const resM = mLines[i].match(/RESOLUTION=(\d+x\d+)/);
          newInfos[mLines[i+1].trim()] = {
            channelName,
            resolution: resM ? resM[1] : '',
            usherParams
          };
        }
      }
      if (Object.keys(newInfos).length) {
        Object.assign(_streamInfoCache, newInfos);
        postTwitchWorkerMessage('StreamInfoUpdate', newInfos);
      }
    } catch(_) {}
    return response;
  };
  const _ourFetch = window.fetch;

  // ─── WINDOW.OPEN OVERRIDE — nowoif equivalent ─────
  // Mirrors: twitch.tv##+js(nowoif, amazon-adsystem)
  // Suppresses any window.open() call whose URL contains "amazon-adsystem",
  // preventing popup/redirect ads triggered by Amazon's ad SDK on Twitch.
  window.open = function chromaTwitchOpen(url, ...args) {
    if (CONFIG.enabled && CONFIG.twitchHLS) {
      if (url && typeof url === 'string' && url.includes('amazon-adsystem')) {
        if (DEBUG) console.log('[Chroma Twitch] Suppressed window.open:', url);
        return null;
      }
    }
    return _nativeOpen(url, ...args);
  };

  // ─── TOSTRING SPOOFING ─────
  // Prevents Twitch scripts from detecting the wrapper via fn.toString() checks.
  (function() {
    const _targets = new Map([
      [window.open,                     'function open() { [native code] }'],
      [_ourFetch,                       'function fetch() { [native code] }'],
      [window.Worker,                   'function Worker() { [native code] }'],
    ]);

    const _spoof = function toString() {
      if (_targets.has(this)) return _targets.get(this);
      return _nativeToString.call(this);
    };

    // Recursive protection: make the spoof's own toString return a native string,
    // so Function.prototype.toString.toString() doesn't expose wrapper source.
    Object.defineProperty(_spoof, 'toString', {
      value: function() { return _nativeToString.call(_nativeToString); },
      writable: false,
      configurable: false,
    });

    Function.prototype.toString = _spoof;
  })();

  // ─── EXT_INIT LISTENER ─────
  let _chromaExtInitActive = true;
  let _extInitFired = false;

  API.addDocEventListener('__EXT_INIT__', (e) => {
    _extInitFired = true;
    if (e && e.detail && e.detail.active === false) _chromaExtInitActive = false;
  }, true);

  // ─── CONFIG UPDATE LISTENER ─────
  // Receives live config changes relayed from protection.js via custom event.
  API.addDocEventListener('__CHROMA_CONFIG_UPDATE__', (e) => {
    if (e.detail) {
      applyConfig(e.detail);
      if (DEBUG) console.log('[Chroma Twitch] Config updated:', CONFIG);
    }
  });

  // ─── STARTUP ─────
  // Apply config from handshake if already available, otherwise poll briefly.
  function init() {
    if (window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.config) {
      applyConfig(window.__CHROMA_INTERNAL__.config);
    }

    if (!CONFIG.enabled) {
      // Poll until the isolated world handshake completes and sets __CHROMA_INTERNAL__
      let _pollCount = 0;
      const _pollId = sI(() => {
        const initDone = !!window.__CHROMA_INTERNAL__ || _extInitFired;
        _pollCount++;

        if (initDone) {
          cI(_pollId);
          if (window.__CHROMA_INTERNAL__ && window.__CHROMA_INTERNAL__.config) {
            applyConfig(window.__CHROMA_INTERNAL__.config);
          }
          if (!_chromaExtInitActive) return;
          // If still not enabled after handshake, activate with defaults
          if (!CONFIG.enabled && _extInitFired && _chromaExtInitActive) {
            CONFIG.enabled = true;
          }
        } else if (_pollCount >= 40) {
          cI(_pollId);
        }
      }, 50);
    }
  }

  init();

})();
