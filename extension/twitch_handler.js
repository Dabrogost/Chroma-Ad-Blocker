/**
 * Chroma Ad-Blocker - Twitch Handler
 *
 * Post-Section-34 strategy (Phase 8): Twitch's PAT is now SHA-1 HMAC signed and
 * every playerType/platform combination returns server_ads:true. The
 * "request-a-clean-token" family of tricks (playerType rewrites, backup-stream
 * rotation) no longer works — keeping them only adds detection surface. So
 * this handler now leans on cosmetic hiding + SSAI segment stripping + DNR.
 *
 *   1. HLS Worker segment stripping (primary mechanical defense):
 *      Wraps the Amazon IVS WASM Worker's fetch; when a variant playlist comes
 *      back with Amazon|/DCM|/stitched-ad signifiers, the ad segments are
 *      dropped and the playlist is rebuilt. DISCONTINUITY markers are
 *      preserved at content-resume boundaries so the player doesn't hang.
 *
 *   2. Cosmetic overlay suppression (primary perceptual defense):
 *      During an SSAI ad break (detected by the Worker), the main thread mutes
 *      the video and paints a black "ad blocked" overlay. A PREFETCH-absence
 *      leading indicator pre-arms the overlay one playlist refresh before
 *      AdBreakStart so there's no audio leak at the transition.
 *      Also hides the CSAI slot mounts (outstream, squeezeback, pause-ad,
 *      lower-third, SDA, etc.) via _CSAI_SLOTS + content.js cosmetic sheet.
 *
 *   3. Random X-Device-Id on PlaybackAccessToken:
 *      X-Device-Id is not part of the HMAC signature; unknown devices skip
 *      Twitch's "commercial break in progress" obligation at token issuance.
 *
 *   4. Network blocking via rules/rules_twitch.json:
 *      Blocks ad endpoints (edge.ads, amazon-adsystem, flashtalking, tungsten,
 *      doubleclick, imrworldwide, nielsen, etc.) and redirects
 *      amazon-adsystem.com/*apstag* to a no-op stub.
 *
 *   5. window.open suppression (nowoif equivalent):
 *      Blocks popup/redirect ads triggered by Amazon's ad SDK.
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

  // Worker tracking for ad-break messaging
  const twitchWorkers  = [];    // wrapped Worker instances
  let _streamInfoCache = {};    // variantUrl → {channelName, resolution, usherParams}
  let _adBreakActive   = false; // true while SSAI ad break is active (overlay shown)
  let _adBreakArmed    = false; // pre-armed via PREFETCH-vanished signal, before AdBreakStart confirms
  let _videoMutedBefore = false; // video.muted state saved before Chroma muted for ad
  let _adBreakStartTs  = 0;     // Date.now() when AdBreakStart was received — for safety timeout
  let _adBreakSafetyTid = 0;    // safety-timeout id: force-clears overlay if no AdBreakEnd arrives
  let _adBreakElapsed  = 0;     // cumulative ad segment seconds (from Worker progress updates)
  let _adBreakTotal    = 0;     // best-estimate total ad break duration (from Worker progress updates)
  const AD_BREAK_SAFETY_MS = 240000; // generous ceiling: long mid-roll pods can exceed 3 min
  let _adBreakPollTid  = 0;     // setTimeout id: fires at _adBreakTotal to begin polling overlay clear
  let _adBreakPollInterval = 0; // setInterval id: polls every 2s to clear overlay after pod duration

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
  // evals the original IVS worker code inline (following vaft's approach).
  // Using eval() instead of importScripts() ensures our hooks are fully
  // installed in the exact same scope before any IVS code executes.

  // Synchronously fetch Worker's JS source via XHR (runs in main thread).
  // Mirrors vaft's getWasmWorkerJs — synchronous because the Worker constructor
  // is synchronous and we need the source string for the blob.
  const _workerJsCache = Object.create(null);
  function getWorkerJs(url) {
    if (_workerJsCache[url]) return _workerJsCache[url];
    try {
      const req = new XMLHttpRequest();
      req.open('GET', url, false); // synchronous
      req.overrideMimeType('text/javascript');
      req.send();
      if (req.status === 200 || req.status === 0) { // status 0 for blob: URLs
        _workerJsCache[url] = req.responseText;
        return req.responseText;
      }
    } catch(_) {}
    return null;
  }

  // Broadcasts a key/value message to all tracked Twitch Workers.
  function postTwitchWorkerMessage(key, value) {
    twitchWorkers.forEach(function(w) {
      try { w.postMessage({ key, value }); } catch(_) {}
    });
  }

  // Self-contained fetch wrapper for injection into the Worker.
  // No closures over MAIN world variables — Worker is a separate execution context.
  // With eval()-based injection, this IIFE sets up our hooks in the worker's
  // global scope before the original IVS code is eval'd after it.
  const WORKER_FETCH_WRAPPER = [
    '(function(){',
    '  console.log("[Chroma Worker] IIFE hooks installing — overriding self.fetch");',
    '  var _origFetch=self.fetch;',
    '  var _streamInfos={};',
    '  var _inAdBreak=false;',
    '  var _sentInitialClear=false;',
    '  var _adElapsed=0;',
    '  var _adTotal=0;',
    '  var _countedAdSegUrls=new Set();',
    '  var _prevHadPrefetch=false;',
    '  var _adSegmentCache=new Map();',
    '  var _BLANK_MP4_B64=\"AAAAKGZ0eXBtcDQyAAAAAWlzb21tcDQyZGFzaGF2YzFpc282aGxzZgAABEltb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAYagAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAABqHRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAURtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAADvbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAACzc3RibAAAAGdzdHNkAAAAAAAAAAEAAABXbXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAAzZXNkcwAAAAADgICAIgABAASAgIAUQBUAAAAAAAAAAAAAAAWAgIACEZAGgICAAQIAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAeV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAoAAAAFoAAAAAAGBbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAA9CQAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABLG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAOxzdGJsAAAAoHN0c2QAAAAAAAAAAQAAAJBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAoABaABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAOmF2Y0MBTUAe/+EAI2dNQB6WUoFAX/LgLUBAQFAAAD6AAA6mDgAAHoQAA9CW7y4KAQAEaOuPIAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAASG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAC4AAAAAAoAAAAAAACB0cmV4AAAAAAAAAAIAAAABAACCNQAAAAACQAAA\";',
    '  var _BLANK_MP4_BLOB=null;',
    '  function _getBlankMp4(){',
    '    if(!_BLANK_MP4_BLOB){',
    '      var bytes=Uint8Array.from(atob(_BLANK_MP4_B64),function(c){return c.charCodeAt(0);});',
    '      _BLANK_MP4_BLOB=new Blob([bytes],{type:\"video/mp4\"});',
    '    }',
    '    return _BLANK_MP4_BLOB;',
    '  }',
    '  var _TwitchAdUrlRewriteRegex=/(X-TV-TWITCH-AD(?:-[A-Z]+)*-URLS?=\")[^\"]*(\")/g;',
    '  function _isPlaylist(url){',
    '    try{',
    '      var u=new URL(url);',
    '      return u.pathname.endsWith(".m3u8")&&(',
    '        u.hostname.endsWith(".ttvnw.net")||',
    '        u.hostname.endsWith(".twitchapps.com")||',
    '        u.hostname.endsWith(".twitch.tv"));',
    '    }catch(e){return false}',
    '  }',
    '  var _adSignifiers=[\"stitched-ad\",\"X-TV-TWITCH-AD\",\"twitch-stitched-ad\",\"twitch-ad-quartile\",\"X-TV-TWITCH-STREAM-SOURCE=\\\"Amazon|\",\"X-TV-TWITCH-STREAM-SOURCE=\\\"DCM|\",\"Amazon|\",\"DCM|\"];',
    '  var _adSegmentTitleRe=/^Amazon\\|\\d+$|^DCM\\|\\d+$/;',
    '  function _hasAdTags(t){for(var i=0;i<_adSignifiers.length;i++)if(t.indexOf(_adSignifiers[i])>=0)return _adSignifiers[i];return null;}',
    '  function _rebuildMinimal(text){',
    '    var lines=text.split(/\\r?\\n/);',
    '    var targetDur=\"5\",mediaSeq=\"0\";',
    '    for(var i=0;i<lines.length;i++){',
    '      var m1=lines[i].match(/^#EXT-X-TARGETDURATION:([0-9]+)/);if(m1)targetDur=m1[1];',
    '      var m2=lines[i].match(/^#EXT-X-MEDIA-SEQUENCE:([0-9]+)/);if(m2)mediaSeq=m2[1];',
    '    }',
    '    var out=[\"#EXTM3U\",\"#EXT-X-TARGETDURATION:\"+targetDur,\"#EXT-X-MEDIA-SEQUENCE:\"+mediaSeq];',
    '    var _pendingDiscontinuity=false;',
    '    var _lastKeptWasAd=false;',
    '    for(var j=0;j<lines.length;j++){',
    '      var lj=lines[j];',
    '      if(lj.indexOf(\"#EXT-X-DISCONTINUITY\")===0){_pendingDiscontinuity=true;continue;}',
    '      if(lj.indexOf(\"#EXTINF:\")===0 && j+1<lines.length){',
    '        var uri=(lines[j+1]||\"\").trim();',
    '        if(uri.length>0 && uri.charAt(0)!==\"#\"){',
    '          var isAdTitle=(lj.indexOf(\",live\")<0);',
    '          if(isAdTitle){',
    '            _lastKeptWasAd=true;',
    '          } else {',
    '            if(_pendingDiscontinuity||_lastKeptWasAd){out.push(\"#EXT-X-DISCONTINUITY\");}',
    '            out.push(lj);out.push(uri);',
    '            _lastKeptWasAd=false;',
    '            _pendingDiscontinuity=false;',
    '          }',
    '        }',
    '      }',
    '    }',
    '    return out.join(\"\\n\");',
    '  }',
    '  function _stripAdSegments(text){',
    '    var now=Date.now();',
    '    _adSegmentCache.forEach(function(ts,u){if(now-ts>60000)_adSegmentCache.delete(u);});',
    '    var lines=text.split(/\\r?\\n/);',
    '    var didStrip=false;',
    '    var numStripped=0;',
    '    for(var i=0;i<lines.length;i++){',
    '      var line=lines[i];',
    '      if(_TwitchAdUrlRewriteRegex.test(line)){',
    '        _TwitchAdUrlRewriteRegex.lastIndex=0;',
    '        lines[i]=line.replace(_TwitchAdUrlRewriteRegex,\"$1https://twitch.tv$2\");',
    '      }',
    '      _TwitchAdUrlRewriteRegex.lastIndex=0;',
    '      if(i<lines.length-1 && line.indexOf(\"#EXTINF\")===0){',
    '        var nextUrl=lines[i+1];',
    '        var isLive=line.indexOf(\",live\")>=0;',
    '        if(!isLive){',
    '          if(nextUrl){_adSegmentCache.set((\"\"+nextUrl).trim(),now);}',
    '          didStrip=true;',
    '          numStripped++;',
    '        }',
    '      }',
    '      else if(line.indexOf(\"#EXT-X-PART:\")===0){',
    '        var pm=line.match(/URI=\"([^\"]+)\"/);',
    '        var partUri=pm?pm[1].trim():\"\";',
    '        if(partUri && _adSegmentCache.has(partUri)){',
    '          _adSegmentCache.set(partUri,now);',
    '          lines[i]=\"\";',
    '          didStrip=true;',
    '        }',
    '      }',
    '    }',
    '    if(!didStrip && _hasAdTags(text)){didStrip=true;}',
    '    if(didStrip){',
    '      return {text:_rebuildMinimal(lines.join(\"\\n\")),didStrip:true,numStripped:numStripped};',
    '    }',
    '    return {text:lines.join(\"\\n\"),didStrip:false,numStripped:0};',
    '  }',
    '  function _processVariant(url,text){',
    '    var _currentHasPrefetch=text.indexOf(\"#EXT-X-TWITCH-PREFETCH:\")>=0;',
    '    if(_prevHadPrefetch && !_currentHasPrefetch && !_inAdBreak){',
    '      console.log(\"[Chroma Worker] PREFETCH vanished — pre-arming ad overlay\");',
    '      postMessage({key:\"AdBreakArm\"});',
    '    }',
    '    _prevHadPrefetch=_currentHasPrefetch;',
    '    var matched=_hasAdTags(text);if(!matched){return Promise.resolve(null);}',
    '    console.log(\"[Chroma Worker] ad signifier detected:\",matched);',
    '    var _stripped=_stripAdSegments(text);',
    '    if(_stripped.didStrip){',
    '      console.log(\"[Chroma Worker] stripped\",_stripped.numStripped,\"ad segments\");',
    '      return Promise.resolve(_stripped.text);',
    '    }',
    '    return Promise.resolve(null);',
    '  }',
    '  var _chromaKeys={"StreamInfoUpdate":1};',
    '  self.addEventListener("message",function(e){',
    '    if(!e||!e.data)return;',
    '    var d=e.data;',
    '    if(d.key&&_chromaKeys[d.key]){e.stopImmediatePropagation();}',
    '    if(d.key==="StreamInfoUpdate"){',
    '      var si=d.value;for(var k in si)_streamInfos[k]=si[k];',
    '    }',
    '  });',
    '  self.fetch=function(){',
    '    var args=Array.prototype.slice.call(arguments);',
    '    var _url=typeof args[0]==="string"?args[0]:(args[0]&&args[0].url||"");',
    '    if(typeof _url==="string" && _adSegmentCache.has(_url.trim())){',
    '      return Promise.resolve(new Response(_getBlankMp4()));',
    '    }',
    '    console.log("[Chroma Worker] fetch intercepted:",_url.slice(0,120));',
    '    if(_url.indexOf("/channel/hls/")>=0&&_url.indexOf("parent_domains")>=0){',
    '      try{var pu=new URL(_url);pu.searchParams.delete("parent_domains");args[0]=_url=pu.href;}catch(e){}',
    '    }',
    '    return _origFetch.apply(this,args).then(function(response){',
    '      if(!_isPlaylist(_url))return response;',
    '      return response.clone().text().then(function(text){',
    '        if(text.indexOf("#EXTM3U")<0)return response;',
    '        console.log("[Chroma Worker] m3u8 playlist detected:",_url.slice(0,80));',
    '        if(_url.indexOf("/channel/hls/")>=0){',
    '          try{',
    '            var ch=_url.match(/\\/hls\\/([^\\.]+)\\.m3u8/);if(ch)ch=ch[1];',
    '            var usp=_url.indexOf("?")>=0?_url.slice(_url.indexOf("?")):"";',
    '            var ml=text.split(\"\\n\");',
    '            for(var i=0;i<ml.length;i++){',
    '              if(ml[i].indexOf(\"EXT-X-STREAM-INF\")>=0){',
    '                var rm=ml[i].match(/RESOLUTION=(\\d+x\\d+)/);',
    '                for(var j=i+1;j<ml.length;j++){',
    '                   var tl=ml[j].trim();',
    '                   if(tl.length===0) continue;',
    '                   if(tl[0]===\"#\") continue;',
    '                   var cacheKey=tl.split(\"?\")[0];',
    '                   var v2=_url.indexOf(\"/api/v2/\")>=0;',
    '                   _streamInfos[cacheKey]={channelName:ch||\"\",resolution:rm?rm[1]:\"\",usherParams:usp,v2Api:v2};',
    '                   console.log(\"[Chroma Worker] cached variant:\",cacheKey.slice(0,60),\"ch:\",ch,\"res:\",rm?rm[1]:\"?\");',
    '                   break;',
    '                }',
    '              }',
    '            }',
    '          }catch(e){}',
    '          return response;',
    '        }',
    '        console.log(\"[Chroma Worker] variant m3u8 — checking for stitched ads\");',
    '        return _processVariant(_url,text).then(function(result){',
    '          var isRealSsai=false;',
    '          var _adLines=text.split(/\\r?\\n/);',
    '          if(_hasAdTags(text)){',
    '            for(var _si=0;_si<_adLines.length;_si++){',
    '              if(_adLines[_si].indexOf(\"#EXTINF\")===0 && _adLines[_si].indexOf(\",live\")<0){isRealSsai=true;break;}',
    '            }',
    '          }',
    '          if(isRealSsai){',
    '            var _dm=text.match(/X-TV-TWITCH-AD-POD-FILLED-DURATION=\\"([0-9.]+)\\"/);',
    '            var _pl=text.match(/X-TV-TWITCH-AD-POD-LENGTH=\\"?([0-9]+)\\\"?/);',
    '            var _rt=text.match(/X-TV-TWITCH-AD-ROLL-TYPE=\\"([A-Z]+)\\"/);',
    '            var _podFilled=_dm?parseFloat(_dm[1]):0;',
    '            var _podLength=_pl?parseInt(_pl[1],10):0;',
    '            var _rollType=_rt?_rt[1]:\"\";',
    '            var _elapsed=0;',
    '            var _maxQ=-1;',
    '            for(var _ai=0;_ai<_adLines.length;_ai++){',
    '              var _al=_adLines[_ai];',
    '              if(_al.indexOf(\"#EXTINF:\")===0 && _al.indexOf(\",live\")<0){',
    '                var _em=_al.match(/^#EXTINF:([0-9.]+)/);',
    '                if(_em){var _segUrl=(_ai+1<_adLines.length)?_adLines[_ai+1].trim():\"\";if(_segUrl&&!_countedAdSegUrls.has(_segUrl)){_countedAdSegUrls.add(_segUrl);_elapsed+=parseFloat(_em[1]);}}',
    '              }',
    '              if(_al.indexOf(\"twitch-ad-quartile\")>=0){',
    '                var _qm=_al.match(/X-TV-TWITCH-AD-QUARTILE=\\"?([0-9]+)\\\"?/);',
    '                if(_qm){var _qv=parseInt(_qm[1],10);if(_qv>_maxQ)_maxQ=_qv;}',
    '              }',
    '            }',
    '            _adElapsed+=_elapsed;',
    '            var bestTotal=_podFilled;',
    '            if(!bestTotal&&_podLength>0)bestTotal=_podLength*30;',
    '            if(!bestTotal)bestTotal=_rollType===\"MIDROLL\"?90:30;',
    '            if(bestTotal>_adTotal)_adTotal=bestTotal;',
    '            if(!_inAdBreak){',
    '              _inAdBreak=true;',
    '              _adElapsed=_elapsed;',
    '              _adTotal=bestTotal;',
    '              postMessage({key:\"AdBreakStart\"});',
    '            }',
    '            postMessage({key:\"AdBreakProgress\",value:{elapsed:_adElapsed,total:_adTotal,quartile:_maxQ>=0?_maxQ:null}});',
    '            _sentInitialClear=true;',
    '          } else {',
    '            if(_inAdBreak){_inAdBreak=false;_adElapsed=0;_adTotal=0;_countedAdSegUrls.clear();postMessage({key:\"AdBreakEnd\"});}',
    '            else if(!_sentInitialClear){_sentInitialClear=true;postMessage({key:\"AdBreakEnd\"});}',
    '          }',
    '          if(result===null)return response;',
    '          return new Response(result,{status:response.status,statusText:response.statusText,headers:response.headers});',
    '        }).catch(function(){return response});',
    '      }).catch(function(){return response});',
    '    });',
    '  };',
    '})();'
  ].join('\n');

  // Prevent Twitch from revoking our injected worker blob URL (mirrors vaft)
  let _injectedBlobUrl = null;
  if (!URL.revokeObjectURL.__chromaMasked) {
    const _origRevokeObjectURL = URL.revokeObjectURL;
    URL.revokeObjectURL = function(url) {
      if (url === _injectedBlobUrl) return;
      return _origRevokeObjectURL.call(this, url);
    };
    URL.revokeObjectURL.__chromaMasked = true;
  }

  window.Worker = function chromaTwitchWorker(url, options) {
    // Resolve URL objects to strings for detection (Twitch/webpack may pass URL objects)
    var urlStr = (url instanceof URL) ? url.href : (typeof url === 'string' ? url : String(url || ''));

    // Always log Worker creation for diagnostics (pre-roll debugging)
    console.log('[Chroma Twitch] Worker constructor:', urlStr.slice(0, 120));

    // Detect Twitch's IVS worker. Three complementary heuristics:
    // 1. Origin check (vaft approach): catches workers loaded from *.twitch.tv CDN
    // 2. WASM worker filename: catches IVS SDK 1.51.0+ unified WASM worker from CDN
    // 3. blob: URL fallback: catches older IVS architecture's inline HLS worker
    // Module workers are skipped — eval/importScripts don't work in module scope.
    var isTwitchWorker = false;
    try { isTwitchWorker = new URL(urlStr).origin.endsWith('.twitch.tv'); } catch(_) {}
    var shouldWrap = !(options && options.type === 'module') && (
      isTwitchWorker ||
      urlStr.includes('amazon-ivs-wasmworker') ||
      urlStr.startsWith('blob:')
    );

    if (shouldWrap) {
      // Strategy 1: Pre-fetch worker JS via synchronous XHR (vaft approach).
      // Inline the source into our wrapper blob so our hooks are installed
      // in the same scope before any IVS code runs.
      var workerJs = null;
      try { workerJs = getWorkerJs(urlStr); } catch(_) {}

      try {
        var blobSrc;
        if (workerJs) {
          // XHR succeeded — inline the IVS code after our wrapper (best approach)
          blobSrc = WORKER_FETCH_WRAPPER + '\n' + workerJs;
          console.log('[Chroma Twitch] Worker wrapped (inline eval), length:', workerJs.length);
        } else {
          // XHR failed (CORS or network) — fall back to importScripts.
          // Our IIFE still runs first, installing self.fetch wrapper before
          // importScripts loads and executes the IVS code.
          blobSrc = WORKER_FETCH_WRAPPER + '\nimportScripts(' + JSON.stringify(urlStr) + ');';
          console.log('[Chroma Twitch] Worker wrapped (importScripts fallback):', urlStr.slice(0, 80));
        }
        var blobUrl = _nativeCreateObjectURL(
          new Blob([blobSrc], { type: 'application/javascript' })
        );
        _injectedBlobUrl = blobUrl;
        var worker = new _OrigWorker(blobUrl, options);
        // Prune any terminated workers before tracking the new one.
        // Also clean up any lingering ad overlay from the previous worker session.
        // Reset variant cache — stale variant URLs from a previous channel/player
        // session are no longer valid and would poison the new Worker's lookups.
        twitchWorkers.length = 0;
        _streamInfoCache = {};
        if (_adBreakSafetyTid) { clearTimeout(_adBreakSafetyTid); _adBreakSafetyTid = 0; }
        if (_adBreakPollTid) { clearTimeout(_adBreakPollTid); _adBreakPollTid = 0; }
        if (_adBreakPollInterval) { clearInterval(_adBreakPollInterval); _adBreakPollInterval = 0; }
        if (_adBreakActive) {
          console.log('[Chroma Twitch] New Worker created while ad break active — resetting overlay');
          _adBreakActive = false;
          _adBreakStartTs = 0;
          try { _hideAdOverlay(); _unmuteAfterAd(); } catch(_) {}
        }
        twitchWorkers.push(worker);

        // Seed Worker with any stream info already captured before it started
        try {
          if (Object.keys(_streamInfoCache).length) {
            worker.postMessage({ key: 'StreamInfoUpdate', value: _streamInfoCache });
          }
        } catch(_) {}

        worker.addEventListener('message', function(e) {
          if (!e.data) return;

          if (e.data.key === 'AdBreakArm') {
            if (!_adBreakActive && !_adBreakArmed) {
              _adBreakArmed = true;
              try { _muteForAd(); _showAdOverlay(); } catch(_) {}
            }
            return;
          }
          if (e.data.key === 'AdBreakStart') {
            console.log('[Chroma Twitch] AdBreakStart received (active:', _adBreakActive, ')');
            _adBreakStartTs = Date.now();
            _adBreakElapsed = 0;
            _adBreakTotal = 0;
            if (_adBreakPollTid) { clearTimeout(_adBreakPollTid); _adBreakPollTid = 0; }
            if (_adBreakSafetyTid) { clearTimeout(_adBreakSafetyTid); }
            _adBreakSafetyTid = setTimeout(function() {
              if (_adBreakActive) {
                console.log('[Chroma Twitch] AdBreak safety timeout — force-clearing overlay after', AD_BREAK_SAFETY_MS, 'ms');
                _adBreakActive = false;
                _adBreakStartTs = 0;
                try { _hideAdOverlay(); _unmuteAfterAd(); } catch(_) {}
              }
              _adBreakSafetyTid = 0;
            }, AD_BREAK_SAFETY_MS);
            if (!_adBreakActive) {
              _adBreakActive = true;
              _adBreakArmed = false;
              try { _muteForAd(); _showAdOverlay(); } catch(_) {}
            }
            return;
          }
          if (e.data.key === 'AdBreakProgress') {
            const p = e.data.value || {};
            _adBreakElapsed = p.elapsed || 0;
            if (p.total && p.total > _adBreakTotal) {
              _adBreakTotal = p.total;
              // Schedule a poll to clear the overlay at the pod's stated end time.
              // This fires even if the worker never sends AdBreakEnd (which is unreliable).
              if (!_adBreakPollTid && _adBreakActive && _adBreakStartTs) {
                const delay = Math.max(0, (_adBreakStartTs + _adBreakTotal * 1000) - Date.now());
                console.log('[Chroma Twitch] AdBreakProgress: pod total', _adBreakTotal, 's — poll starts in', (delay / 1000).toFixed(1), 's');
                _adBreakPollTid = setTimeout(function() {
                  _adBreakPollTid = 0;
                  _adBreakPollInterval = setInterval(function() {
                    if (!_adBreakActive) {
                      clearInterval(_adBreakPollInterval);
                      _adBreakPollInterval = 0;
                      return;
                    }
                    console.log('[Chroma Twitch] Poll: firing synthetic AdBreakEnd to clear overlay');
                    if (_adBreakSafetyTid) { clearTimeout(_adBreakSafetyTid); _adBreakSafetyTid = 0; }
                    _adBreakStartTs = 0;
                    _adBreakArmed = false;
                    _adBreakActive = false;
                    try { _hideAdOverlay(); _unmuteAfterAd(); } catch(_) {}
                  }, 2000);
                }, delay);
              }
            }
            if (_adBreakActive) {
              try { _updateAdProgress(_adBreakElapsed, _adBreakTotal); } catch(_) {}
            }
            return;
          }
          if (e.data.key === 'AdBreakEnd') {
            console.log('[Chroma Twitch] AdBreakEnd received (active:', _adBreakActive, 'duration:', _adBreakStartTs ? (Date.now() - _adBreakStartTs) + 'ms' : 'n/a', ')');
            if (_adBreakSafetyTid) { clearTimeout(_adBreakSafetyTid); _adBreakSafetyTid = 0; }
            if (_adBreakPollTid) { clearTimeout(_adBreakPollTid); _adBreakPollTid = 0; }
            if (_adBreakPollInterval) { clearInterval(_adBreakPollInterval); _adBreakPollInterval = 0; }
            _adBreakStartTs = 0;
            _adBreakArmed = false;
            if (_adBreakActive) {
              _adBreakActive = false;
              try { _hideAdOverlay(); _unmuteAfterAd(); _resetPlayerBuffer(); } catch(_) {}
            }
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

    // ── GQL intercept: randomize X-Device-Id on PlaybackAccessToken ──
    // playerType rewrite was removed in Phase 8 — Twitch's Section-34 instrumentation
    // showed all playerType/platform combinations return server_ads:true, and the PAT
    // is now SHA-1 HMAC signed (tampering adds detection surface without benefit).
    // Random X-Device-Id still unsigned: removes "commercial break in progress"
    // obligation at token-generation time for unknown devices.
    if (url.includes('gql.twitch.tv')) {
      const init = args[1] || {};
      let hdrs = init.headers || {};
      if (typeof Headers !== 'undefined' && hdrs instanceof Headers) {
        const _h = {};
        hdrs.forEach(function(v, k) { _h[k] = v; });
        hdrs = _h;
      }
      if (typeof init.body === 'string' && init.body.includes('PlaybackAccessToken')) {
        const randomDeviceId = Array.from(
          crypto.getRandomValues(new Uint8Array(16))
        ).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
        const patchedHeaders = Object.assign({}, hdrs, { 'X-Device-Id': randomDeviceId });
        if (DEBUG) console.log('[Chroma Twitch] PlaybackAccessToken X-Device-Id randomized:', randomDeviceId);
        args[1] = Object.assign({}, args[1] || init, { headers: patchedHeaders });
      }
      return _nativeFetch.apply(this, args);
    }

    // Only intercept Twitch master playlists — for parent_domains strip and stream info capture.
    if (!isTwitchPlaylist(url) || !url.includes('/channel/hls/')) {
      const p = _nativeFetch.apply(this, args);
      // Attach a silent catch for ad-related URLs blocked by DNR to prevent
      // "unhandled promise rejection" console noise. The original promise `p`
      // is returned unchanged so callers (IVS, Twitch ad SDK) still see the
      // failure — returning a success (e.g. 204) would cause IVS to process
      // the empty response as valid ad metadata and crash the player.
      if (url.includes('edge.ads.') || url.includes('amazon-adsystem') ||
          url.includes('advertising.amazon') || url.includes('adsqtungsten') ||
          url.includes('sq-tungsten')) {
        p.catch(function() {
          if (DEBUG) console.log('[Chroma Twitch] Suppressed blocked ad fetch:', url.slice(0, 120));
        });
      }
      return p;
    }

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

      // Capture variant URL → {channelName, resolution, usherParams} metadata.
      // Forwarded to Workers for diagnostic logging only — backup-stream
      // construction was removed in Phase 8 (see header).
      const channelMatch = new URL(cleanUrl).pathname.match(/([^\/]+)(?=\.\w+$)/);
      const channelName = channelMatch ? channelMatch[0] : '';
      const usherParams = new URL(cleanUrl).search;
      const v2Api = cleanUrl.includes('/api/v2/');
      const newInfos = {};
      const mLines = text.split('\n');
      for (let i = 0; i < mLines.length - 1; i++) {
        if (mLines[i].startsWith('#EXT-X-STREAM-INF') && mLines[i+1].trim().includes('.m3u8')) {
          const resM = mLines[i].match(/RESOLUTION=(\d+x\d+)/);
          newInfos[mLines[i+1].trim()] = {
            channelName,
            resolution: resM ? resM[1] : '',
            usherParams,
            v2Api
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

  // ─── AD BREAK MUTE + OVERLAY (primary SSAI defense) ─────
  // When Worker detects SSAI ad signifiers in the live variant playlist,
  // mute the video and cover it with a black overlay. Reversed automatically
  // when the Worker detects the ad has finished (clean variant m3u8 seen).

  function _muteForAd() {
    const video = document.querySelector('.video-player video');
    if (video) { _videoMutedBefore = video.muted; video.muted = true; }
  }

  function _unmuteAfterAd() {
    const video = document.querySelector('.video-player video');
    if (video && !_videoMutedBefore) video.muted = false;
  }

  // Ported from Purple — on SSAI ad transitions, pause then resume playback
  // to force the IVS player to drop its buffer and pick up the new playlist.
  // Purple does this on both start AND end; the end one is what unsticks
  // audio/video when the ad break ends and the stream should resume clean.
  function _resetPlayerBuffer() {
    const video = document.querySelector('.video-player video');
    if (!video) return;
    try { video.pause(); } catch(_) {}
    setTimeout(function() {
      const v = document.querySelector('.video-player video');
      if (!v) return;
      try { v.play(); } catch(_) {}
      try { v.play(); } catch(_) {}
    }, 1500);
  }

  function _showAdOverlay() {
    if (document.getElementById('chroma-ad-overlay')) return;
    const root = document.querySelector('.video-player__overlay')
               || document.querySelector('[data-a-target="video-ref"]')
               || document.querySelector('.video-player');
    if (!root) return;
    const ov = API.createElement('div');
    ov.id = 'chroma-ad-overlay';
    ov.style.cssText = 'position:absolute;inset:0;background:#000;z-index:1000;display:flex;align-items:center;justify-content:center;pointer-events:none;';
    const lbl = API.createElement('span');
    lbl.style.cssText = 'color:rgba(255,255,255,0.35);font-size:13px;font-family:sans-serif;letter-spacing:0.05em;';
    lbl.textContent = 'Ad blocked';
    ov.appendChild(lbl);
    const bar = API.createElement('div');
    bar.id = 'chroma-ad-bar';
    bar.style.cssText = 'position:absolute;bottom:0;left:0;height:3px;width:0%;background:#9147ff;transition:width 2.2s linear;';
    ov.appendChild(bar);
    root.appendChild(ov);
    if (DEBUG) console.log('[Chroma Twitch] Ad overlay shown');
  }

  function _updateAdProgress(elapsed, total) {
    const bar = document.getElementById('chroma-ad-bar');
    if (!bar) return;
    const pct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
    bar.style.width = pct + '%';
  }

  function _hideAdOverlay() {
    const bar = document.getElementById('chroma-ad-bar');
    if (bar) bar.style.width = '100%';
    setTimeout(function() {
      const ov = document.getElementById('chroma-ad-overlay');
      if (ov) { ov.remove(); if (DEBUG) console.log('[Chroma Twitch] Ad overlay hidden'); }
    }, 300);
  }

  // ─── CSAI AD OVERLAY HIDING (ported from vaft) ─────
  // Twitch's CSAI (Client-Side Ad Insertion) overlays a black container and
  // "taking an ad break" card on top of the stream even when our HLS-level
  // ad blocking keeps the stream playing underneath. Hide these overlays so
  // the clean stream is visible. Runs on an interval to catch dynamically
  // injected overlays.
  let _cachedPlayerRoot = null;
  let _loggedPromoHide = false;
  let _loggedSdaHide = false;
  let _loggedAdBreakCardHide = false;

  function hideTwitchAdOverlays() {
    if (!_cachedPlayerRoot || !_cachedPlayerRoot.isConnected) {
      _cachedPlayerRoot = document.querySelector('.video-player');
    }
    if (!_cachedPlayerRoot) return;

    // 1. Hide "allow ads" and Turbo promo overlays
    const promoLinks = _cachedPlayerRoot.querySelectorAll(
      'a[href*="/how-to-allow-ads-browser"], a[href="https://www.twitch.tv/turbo"]'
    );
    for (let i = 0; i < promoLinks.length; i++) {
      const overlay = promoLinks[i].closest('.player-overlay-background');
      if (overlay && !overlay.dataset.chromaHidden) {
        overlay.dataset.chromaHidden = '';
        overlay.style.setProperty('display', 'none', 'important');
        if (!_loggedPromoHide) {
          _loggedPromoHide = true;
          if (DEBUG) console.log('[Chroma Twitch] Hidden ad/Turbo promo overlay');
        }
      }
    }

    // 2. Hide stream display ad (SDA) wrapper
    const sdaElements = document.querySelectorAll('[data-test-selector="sda-wrapper"]');
    for (let i = 0; i < sdaElements.length; i++) {
      if (!sdaElements[i].dataset.chromaHidden) {
        sdaElements[i].dataset.chromaHidden = '';
        sdaElements[i].style.setProperty('display', 'none', 'important');
        if (!_loggedSdaHide) {
          _loggedSdaHide = true;
          if (DEBUG) console.log('[Chroma Twitch] Hidden stream display ad');
        }
      }
    }

    // 3. Hide "taking an ad break" / "stick around" card
    const textNodes = _cachedPlayerRoot.querySelectorAll('span, p, h1, h2, h3');
    for (let i = 0; i < textNodes.length; i++) {
      const text = (textNodes[i].textContent || '').toLowerCase();
      if (text.length === 0 || text.length > 300) continue;
      if (text.includes('taking an ad break') ||
          text.includes('stick around to support the stream') ||
          text.includes('stick around to support the channel') ||
          text.includes('right after this ad break')) {
        const overlay = textNodes[i].closest('.player-overlay-background') ||
                       textNodes[i].closest('[class*="overlay"]') ||
                       textNodes[i].parentElement;
        if (overlay && !overlay.dataset.chromaAdBreakHidden) {
          overlay.dataset.chromaAdBreakHidden = '';
          overlay.style.setProperty('display', 'none', 'important');
          if (!_loggedAdBreakCardHide) {
            _loggedAdBreakCardHide = true;
            if (DEBUG) console.log('[Chroma Twitch] Hidden ad break card');
          }
          break;
        }
      }
    }
  }

  // Hide CSAI slots (outstream video overlay, squeezeback banner, lower-third).
  // These are stable DOM mounts that exist empty by default and populate when
  // Twitch renders a client-side ad. We only hide while populated and restore
  // when empty so normal layout isn't disturbed. The `outstream-ax-overlay`
  // and `stream-display-ad__wrapper` are the primary CSAI video slots; the
  // `stream-lowerthird` is the in-stream banner slot.
  const _CSAI_SLOTS = [
    '[data-a-target="outstream-ax-overlay"]',
    '[data-a-target="video-ad-label"]',
    '[data-a-target="sda-panel"]',
    '[data-test-selector="ad-banner-default-text"]',
    '.stream-display-ad__wrapper',
    '#stream-lowerthird',
    '.video-ad-display',
    '.video-ad-label',
    '.player-ad-notice',
    '.player-ad-notice__label',
    '.outstream-vertical-video',
    '.outstream-mirror-pbyp-video',
    '.outstream-home-page-video',
    '.squeezeback',
    '.headliner',
    '.pause-ad',
    '.promotions-list',
    '.home-carousel-ad'
  ];
  let _loggedCsaiHide = false;

  function hideCsaiSlots() {
    for (let s = 0; s < _CSAI_SLOTS.length; s++) {
      const sel = _CSAI_SLOTS[s];
      const els = document.querySelectorAll(sel);
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const populated = el.childElementCount > 0 || (el.textContent && el.textContent.trim().length > 0);
        if (el.dataset.chromaCsaiHidden) {
          if (!populated) {
            delete el.dataset.chromaCsaiHidden;
            el.style.removeProperty('display');
          }
          continue;
        }
        if (!populated) continue;
        el.dataset.chromaCsaiHidden = '';
        el.style.setProperty('display', 'none', 'important');
        if (!_loggedCsaiHide) {
          _loggedCsaiHide = true;
          if (DEBUG) console.log('[Chroma Twitch] Hidden CSAI slot:', sel);
        }
      }
    }
  }

  // Run overlay hiding on a tick — catches dynamically injected overlays
  sI(function() {
    if (!CONFIG.enabled || !CONFIG.twitchHLS) return;
    try { hideTwitchAdOverlays(); } catch(_) {}
    try { hideCsaiSlots(); } catch(_) {}
  }, 500);

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
