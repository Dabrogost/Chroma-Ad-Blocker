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
  let _adBreakActive   = false; // true while SSAI ad break is active (overlay shown)
  let _videoMutedBefore = false; // video.muted state saved before Chroma muted for ad

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
    '  var _pending=new Map();',
    '  var _streamInfos={};',
    '  var _auth=null,_integrity=null,_clientVersion=null,_clientSession=null,_deviceId=null;',
    '  var _prefetchedTokens={};',
    '  var _backupCache={};',
    '  var _inAdBreak=false;',
    '  var _clientId=\"kimne78kx3ncx6brgo4mv6wki5h1ko\";',
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
    '  var _AdSegmentURLPatterns=[\"/adsquared/\",\"/_404/\",\"/processing\"];',
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
    '  function _getAccessToken(ch,pt,plat){',
    '    var p=plat||"web";',
    '    return _gqlRequest({operationName:\"PlaybackAccessToken\",variables:{isLive:true,login:ch,isVod:false,vodID:\"\",playerType:pt,platform:p},extensions:{persistedQuery:{version:1,sha256Hash:\"ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9\"}}});',
    '  }',
    '  function _getStreamUrl(masterText,targetRes){',
    '    var lines=masterText.split(\"\\n\"),best=null,bestDiff=Infinity;',
    '    var tw=0,th=0;if(targetRes){var p=targetRes.split(\"x\");tw=+p[0]||0;th=+p[1]||0;}',
    '    for(var i=0;i<lines.length;i++){',
    '      if(lines[i].indexOf(\"EXT-X-STREAM-INF\")>=0){',
    '        var m=lines[i].match(/RESOLUTION=(\\d+x\\d+)/);',
    '        for(var j=i+1;j<lines.length;j++){',
    '          var tl=lines[j].trim();',
    '          if(tl.length===0 || tl[0]===\"#\") continue;',
    '          if(m){var rp=m[1].split(\"x\"),rw=+rp[0],rh=+rp[1],diff=Math.abs(rw*rh-tw*th);',
    '            if(diff<bestDiff){best=tl;bestDiff=diff;}',
    '          }',
    '          break;',
    '        }',
    '      }',
    '    }',
    '    return best;',
    '  }',
    '  var _adSignifiers=[\"stitched-ad\",\"X-TV-TWITCH-AD\",\"EXT-X-CUE-OUT\",\"twitch-stitched-ad\",\"twitch-trigger\",\"twitch-maf-ad\",\"twitch-ad-quartile\",\"SCTE35-OUT\"];',
    '  function _hasAdTags(t){for(var i=0;i<_adSignifiers.length;i++)if(t.indexOf(_adSignifiers[i])>=0)return _adSignifiers[i];return null;}',
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
    '        var matchesPattern=false;',
    '        for(var pi=0;pi<_AdSegmentURLPatterns.length;pi++){',
    '          if(nextUrl && nextUrl.indexOf(_AdSegmentURLPatterns[pi])>=0){matchesPattern=true;break;}',
    '        }',
    '        if(!isLive || matchesPattern){',
    '          if(nextUrl){_adSegmentCache.set((\"\"+nextUrl).trim(),now);}',
    '          lines[i]=\"\";',
    '          lines[i+1]=\"\";',
    '          didStrip=true;',
    '          numStripped++;',
    '          i++;',
    '        }',
    '      }',
    '    }',
    '    if(didStrip){',
    '      for(var j=0;j<lines.length;j++){',
    '        if(lines[j].indexOf(\"#EXT-X-TWITCH-PREFETCH:\")===0 || lines[j].indexOf(\"#EXT-X-PRELOAD-HINT:\")===0){',
    '          lines[j]=\"\";',
    '        }',
    '      }',
    '    }',
    '    return {text:lines.join(\"\\n\"),didStrip:didStrip,numStripped:numStripped};',
    '  }',
    '  function _processVariant(url,text){',
    '    var matched=_hasAdTags(text);if(!matched){return Promise.resolve(null);}',
    '    console.log(\"[Chroma Worker] ad signifier detected:\",matched);',
    '    var _mainLines=text.split(/\\r?\\n/);',
    '    var _hasNonLive=false;',
    '    for(var _i=0;_i<_mainLines.length;_i++){',
    '      if(_mainLines[_i].indexOf(\"#EXTINF\")===0 && _mainLines[_i].indexOf(\",live\")<0){_hasNonLive=true;break;}',
    '    }',
    '    if(!_hasNonLive){',
    '      var _csai=_stripAdSegments(text);',
    '      console.log(\"[Chroma Worker] CSAI fast path (all segments live)\");',
    '      return Promise.resolve(_csai.text);',
    '    }',
    '    var ubase=url.split(\"?\")[0];',
    '    var info=_streamInfos[ubase];',
    '    if(!info){',
    '      for(var k in _streamInfos){if(ubase.indexOf(k)>=0){info=_streamInfos[k];break;}}',
    '    }',
    '    if(!info){',
    '      console.log(\"[Chroma Worker] failed streamInfo lookup for:\",ubase.slice(0,80));',
    '      return Promise.resolve(null);',
    '    }',
    '    console.log(\"[Chroma Worker] processing variant for:\",info.channelName,info.resolution);',
    '    var pft=_prefetchedTokens[info.channelName];',
    '    if(pft){',
    '      delete _prefetchedTokens[info.channelName];',
    '      var pmu=new URL(\"https://usher.ttvnw.net/api/\"+(info.v2Api?\"v2/\":\"\")+\"channel/hls/\"+info.channelName+\".m3u8\"+info.usherParams);',
    '      pmu.searchParams.delete("parent_domains");',
    '      pmu.searchParams.set("sig",pft.signature);',
    '      pmu.searchParams.set("token",pft.token);',
    '      return _origFetch(pmu.href).then(function(pmr){',
    '        if(!pmr||pmr.status!==200)return _processVariantFallback(url,text,info);',
    '        return pmr.text().then(function(pmt){',
    '          var pvu=_getStreamUrl(pmt,info.resolution);',
    '          if(!pvu)return _processVariantFallback(url,text,info);',
    '          return _origFetch(pvu).then(function(pvr){',
    '            if(!pvr||pvr.status!==200)return _processVariantFallback(url,text,info);',
    '            return pvr.text().then(function(pvt){',
    '              if(_hasAdTags(pvt))return _processVariantFallback(url,text,info);',
    '              console.log("[Chroma Worker] backup stream clean (prefetch)");',
    '              return pvt;',
    '            });',
    '          });',
    '        });',
    '      }).catch(function(){return _processVariantFallback(url,text,info);});',
    '    }',
    '    return _processVariantFallback(url,text,info);',
    '  }',
    '  function _processVariantFallback(url,text,info){',
    '    var types=[',
    '      {t:\"embed\",p:\"web\"},',
    '      {t:\"site\",p:\"web\"},',
    '      {t:\"popout\",p:\"web\"},',
    '      {t:\"mobile_web\",p:\"web\"}',
    '    ];',
    '    function tryNext(i){',
    '      if(i>=types.length){',
    '        var _fb=_stripAdSegments(text);',
    '        if(_fb.didStrip){',
    '          console.log(\"[Chroma Worker] all backups failed — stripped\",_fb.numStripped,\"ad segments\");',
    '          return Promise.resolve(_fb.text);',
    '        }',
    '        console.log(\"[Chroma Worker] all backups failed, nothing to strip\");',
    '        return Promise.resolve(null);',
    '      }',
    '      var typeObj=types[i];',
    '      var cacheKey=info.channelName+\"_\"+typeObj.t+\"_\"+typeObj.p;',
    '      var cached=_backupCache[cacheKey];',
    '      if(cached && cached.bad && (Date.now() - cached.time < 15000)){',
    '        return tryNext(i+1);',
    '      }',
    '      console.log(\"[Chroma Worker] trying backup type:\",typeObj.t, \"plat:\", typeObj.p);',
    '      return _getAccessToken(info.channelName,typeObj.t,typeObj.p).then(function(r){',
    '        if(!r||r.status!==200){',
    '          _backupCache[cacheKey]={time:Date.now(),bad:true};',
    '          return tryNext(i+1);',
    '        }',
    '        var d;try{d=JSON.parse(r.body);}catch(e){return tryNext(i+1);}',
    '        var tok=d&&d.data&&d.data.streamPlaybackAccessToken;',
    '        if(!tok){',
    '          _backupCache[cacheKey]={time:Date.now(),bad:true};',
    '          return tryNext(i+1);',
    '        }',
    '        var mu=new URL(\"https://usher.ttvnw.net/api/\"+(info.v2Api?\"v2/\":\"\")+\"channel/hls/\"+info.channelName+\".m3u8\"+info.usherParams);',
    '        mu.searchParams.delete(\"parent_domains\");',
    '        mu.searchParams.set(\"sig\",tok.signature);',
    '        mu.searchParams.set(\"token\",tok.value);',
    '        return _origFetch(mu.href).then(function(pmr){',
    '          if(!pmr||pmr.status!==200){',
    '            _backupCache[cacheKey]={time:Date.now(),bad:true};',
    '            return tryNext(i+1);',
    '          }',
    '          return pmr.text().then(function(pmt){',
    '            var pvu=_getStreamUrl(pmt,info.resolution);',
    '            if(!pvu){',
    '              _backupCache[cacheKey]={time:Date.now(),bad:true};',
    '              return tryNext(i+1);',
    '            }',
    '            return _origFetch(pvu).then(function(pvr){',
    '              if(!pvr||pvr.status!==200){',
    '                _backupCache[cacheKey]={time:Date.now(),bad:true};',
    '                return tryNext(i+1);',
    '              }',
    '              return pvr.text().then(function(pvt){',
    '                var bad=_hasAdTags(pvt);',
    '                if(bad){',
    '                  console.log(\"[Chroma Worker] backup type\",typeObj.t,\"plat\",typeObj.p,\"still had ads:\",bad);',
    '                  _backupCache[cacheKey]={time:Date.now(),bad:true};',
    '                  return tryNext(i+1);',
    '                }',
    '                console.log(\"[Chroma Worker] clean backup found! (type:\",typeObj.t,\")\");',
    '                delete _backupCache[cacheKey];',
    '                return pvt;',
    '              });',
    '            });',
    '          });',
    '        }).catch(function(){',
    '          _backupCache[cacheKey]={time:Date.now(),bad:true};',
    '          return tryNext(i+1);',
    '        });',
    '      }).catch(function(){',
    '        _backupCache[cacheKey]={time:Date.now(),bad:true};',
    '        return tryNext(i+1);',
    '      });',
    '    }',
    '    return tryNext(0).catch(function(){return null;});',
    '  }',
    '  var _chromaKeys={"FetchResponse":1,"UpdateAuthorizationHeader":1,"UpdateClientIntegrityHeader":1,"UpdateClientVersion":1,"UpdateClientSession":1,"UpdateDeviceId":1,"StreamInfoUpdate":1,"PrefetchedToken":1};',
    '  self.addEventListener("message",function(e){',
    '    if(!e||!e.data)return;',
    '    var d=e.data;',
    '    if(d.key&&_chromaKeys[d.key]){e.stopImmediatePropagation();}',
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
    '    else if(d.key==="PrefetchedToken"){',
    '      var pt=d.value;if(pt&&pt.channel)_prefetchedTokens[pt.channel]=pt;',
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
    '          if(_hasAdTags(text)){',
    '            var _sl=text.split(/\\r?\\n/);',
    '            for(var _si=0;_si<_sl.length;_si++){',
    '              if(_sl[_si].indexOf(\"#EXTINF\")===0 && _sl[_si].indexOf(\",live\")<0){isRealSsai=true;break;}',
    '            }',
    '          }',
    '          if(isRealSsai){',
    '            if(!_inAdBreak){_inAdBreak=true;postMessage({key:\"AdBreakStart\"});}',
    '          } else {',
    '            if(_inAdBreak){_inAdBreak=false;postMessage({key:\"AdBreakEnd\"});}',
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
        if (_adBreakActive) {
          _adBreakActive = false;
          try { _hideAdOverlay(); _unmuteAfterAd(); } catch(_) {}
        }
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

        // ── Proactive token prefetch ──
        // Race against Twitch's cached access token by immediately requesting
        // a fresh token with playerType:'popout'. If Twitch reuses a stale
        // cached token with playerType:'site', SSAI ads will be stitched in.
        // By fetching our own clean token and storing it, Phase 2's Worker
        // can use it immediately when it detects 'stitched' content, reducing
        // the backup stream latency from ~2s to near-zero.
        (async function prefetchCleanToken(w) {
          try {
            // Extract channel name from the current URL path
            const pathMatch = window.location.pathname.match(/^\/([a-zA-Z0-9_]{3,25})$/);
            if (!pathMatch) return;
            const channel = pathMatch[1].toLowerCase();

            // Skip non-channel pages
            const reserved = ['directory', 'videos', 'settings', 'subscriptions',
                              'inventory', 'drops', 'wallet', 'turbo', 'prime',
                              'jobs', 'p', 'search', 'downloads', 'broadcast'];
            if (reserved.includes(channel)) return;

            // Wait briefly for auth headers to be captured from early GQL calls
            if (!_capturedAuth) {
              await new Promise(r => setTimeout(r, 500));
            }
            if (!_capturedAuth) return; // Still no auth — can't make authenticated GQL

            const hdrs = { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko' };
            if (_capturedAuth)      hdrs['Authorization']      = _capturedAuth;
            if (_capturedIntegrity) hdrs['Client-Integrity']   = _capturedIntegrity;
            if (_capturedVersion)   hdrs['Client-Version']     = _capturedVersion;
            if (_capturedSession)   hdrs['Client-Session-Id']  = _capturedSession;
            if (_capturedDeviceId)  hdrs['X-Device-Id']        = _capturedDeviceId;

            const resp = await _nativeFetch('https://gql.twitch.tv/gql', {
              method: 'POST',
              headers: hdrs,
              body: JSON.stringify({
                operationName: 'PlaybackAccessToken',
                variables: {
                  isLive: true, login: channel, isVod: false,
                  vodID: '', playerType: 'popout', platform: 'web'
                },
                extensions: {
                  persistedQuery: {
                    version: 1,
                    sha256Hash: 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9'
                  }
                }
              })
            });

            if (!resp.ok) return;
            const data = await resp.json();
            const tok = data?.data?.streamPlaybackAccessToken;
            if (!tok) return;

            // Send the pre-fetched clean token to the Worker so Phase 2
            // can use it immediately without the GQL round-trip delay
            w.postMessage({
              key: 'PrefetchedToken',
              value: { channel, signature: tok.signature, token: tok.value }
            });

            if (DEBUG) console.log('[Chroma Twitch] Prefetched clean token for:', channel);
          } catch(_) {}
        })(worker);

        // Proxy authenticated GQL fetch requests from Worker (Workers can't send credentialed requests)
        worker.addEventListener('message', async function(e) {
          if (!e.data) return;

          // SSAI ad break signals from Worker
          if (e.data.key === 'AdBreakStart') {
            if (!_adBreakActive) {
              _adBreakActive = true;
              try { _muteForAd(); _showAdOverlay(); } catch(_) {}
            }
            return;
          }
          if (e.data.key === 'AdBreakEnd') {
            if (_adBreakActive) {
              _adBreakActive = false;
              try { _hideAdOverlay(); _unmuteAfterAd(); } catch(_) {}
            }
            return;
          }

          if (e.data.key !== 'FetchRequest') return;
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
      let hdrs = init.headers || {};
      // Normalize Headers instances to plain objects — bracket access on a
      // Headers object returns undefined and would silently skip auth capture.
      if (typeof Headers !== 'undefined' && hdrs instanceof Headers) {
        const _h = {};
        hdrs.forEach(function(v, k) { _h[k] = v; });
        hdrs = _h;
      }
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

      // Capture variant URL → {channelName, resolution, usherParams} so Workers
      // can construct backup stream URLs when they detect SSAI ads.
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

  // ─── AD BREAK MUTE + OVERLAY (SSAI fallback) ─────
  // When all backup stream attempts fail and SSAI ads play in the stream,
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

  function _showAdOverlay() {
    if (document.getElementById('chroma-ad-overlay')) return;
    const root = document.querySelector('.video-player');
    if (!root) return;
    const ov = API.createElement('div');
    ov.id = 'chroma-ad-overlay';
    ov.style.cssText = 'position:absolute;inset:0;background:#000;z-index:1000;display:flex;align-items:center;justify-content:center;pointer-events:none;';
    const lbl = API.createElement('span');
    lbl.style.cssText = 'color:rgba(255,255,255,0.35);font-size:13px;font-family:sans-serif;letter-spacing:0.05em;';
    lbl.textContent = 'Ad blocked';
    ov.appendChild(lbl);
    root.appendChild(ov);
    if (DEBUG) console.log('[Chroma Twitch] Ad overlay shown');
  }

  function _hideAdOverlay() {
    const ov = document.getElementById('chroma-ad-overlay');
    if (ov) { ov.remove(); if (DEBUG) console.log('[Chroma Twitch] Ad overlay hidden'); }
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

  // Run overlay hiding on a tick — catches dynamically injected overlays
  sI(function() {
    if (!CONFIG.enabled || !CONFIG.twitchHLS) return;
    try { hideTwitchAdOverlays(); } catch(_) {}
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
