/**
 * Chroma Ad-Blocker — Fingerprint Randomization Scriptlet
 *
 * Self-executing IIFE. Loaded as a static JS file via
 * chrome.scripting.registerContentScripts at document_start in the MAIN world,
 * which gives the same ordering guarantee as a manifest content_script — i.e.
 * the patches install BEFORE any page script runs and snapshots prototypes.
 *
 * Strategy: Brave-style farbling. Per-session × per-eTLD+1 deterministic seed
 * adds sub-perceptual noise to canvas/audio/WebGL reads and clamps a small set
 * of navigator fields. Goal is to randomize the fingerprint hash per site/per
 * session so cross-site correlation breaks — NOT to reduce uniqueness scores
 * on tests like amiunique. Wrappers are Proxy-based so .name/.length/typeof
 * and Function.prototype.toString all match native, defeating standard probes.
 *
 * Vectors: canvas2d, WebGL1+2, AudioBuffer, Navigator (hwConcurrency,
 * deviceMemory, userAgentData high-entropy values).
 *
 * Out of band: when this scriptlet is not registered (toggle off), the page
 * sees a vanilla environment — zero observable hooks.
 */

(function installFingerprintRandomization() {
  'use strict';
  try {
    // ─── Capture natives BEFORE any patching ─────
    const _Object = Object;
    const _Proxy = Proxy;
    const _Reflect = Reflect;
    const _WeakSet = WeakSet;
    const _WeakMap = WeakMap;
    const _defineProperty = Object.defineProperty;
    const _getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    const _fnToString = Function.prototype.toString;
    const _Uint8Array = Uint8Array;
    const _crypto = self.crypto;

    const Canvas = self.HTMLCanvasElement;
    const OffCanvas = self.OffscreenCanvas;
    const Ctx2D = self.CanvasRenderingContext2D;
    const OffCtx2D = self.OffscreenCanvasRenderingContext2D;
    const GL1 = self.WebGLRenderingContext;
    const GL2 = self.WebGL2RenderingContext;
    const AudioBuf = self.AudioBuffer;
    const _Navigator = self.Navigator;

    // ─── Seed derivation: per-session × per-eTLD+1 ─────
    // Approximate eTLD+1 with last two labels (good enough; ccTLDs like
    // .co.uk over-collapse to .co.uk which is fine — same site → same seed).
    let host = '';
    try { host = self.location.hostname || ''; } catch (e) {}
    const labels = host.split('.');
    const site = labels.length >= 2 ? labels.slice(-2).join('.') : host;

    let salt = '0';
    try {
      salt = self.sessionStorage.getItem('__chroma_afp_s');
      if (!salt) {
        const buf = new _Uint8Array(8);
        _crypto.getRandomValues(buf);
        salt = '';
        for (let i = 0; i < buf.length; i++) {
          const h = buf[i].toString(16);
          salt += h.length < 2 ? '0' + h : h;
        }
        self.sessionStorage.setItem('__chroma_afp_s', salt);
      }
    } catch (e) {
      // Sandboxed iframes etc. — fall back to a fresh random seed; consistency
      // within this frame only.
      try {
        const buf = new _Uint8Array(8);
        _crypto.getRandomValues(buf);
        salt = '';
        for (let i = 0; i < buf.length; i++) salt += buf[i].toString(16);
      } catch (e2) {}
    }

    function fnv1a(str) {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      return h >>> 0;
    }
    const seed = fnv1a(site + '|' + salt);

    // ─── Wrapper toolkit: Proxy + native-toString camouflage ─────
    const wrappedSet = new _WeakSet();
    // Map wrappedFn → original target so toString can return target's source.
    const targetMap = new _WeakMap();

    function wrap(target, applyHook) {
      if (typeof target !== 'function') return target;
      const handler = {
        apply(t, thisArg, args) {
          return applyHook(t, thisArg, args);
        }
      };
      const p = new _Proxy(target, handler);
      try { wrappedSet.add(p); } catch (e) {}
      try { targetMap.set(p, target); } catch (e) {}
      return p;
    }

    // Replace Function.prototype.toString with a Proxy whose apply trap
    // returns the *original* native source for our wrappers, and otherwise
    // defers to the real toString. This makes
    //   HTMLCanvasElement.prototype.toDataURL.toString()
    // and
    //   Function.prototype.toString.call(HTMLCanvasElement.prototype.toDataURL)
    // both return "function toDataURL() { [native code] }" exactly as a
    // vanilla browser would.
    const toStringProxy = new _Proxy(_fnToString, {
      apply(target, thisArg, args) {
        try {
          if (thisArg && wrappedSet.has(thisArg)) {
            const orig = targetMap.get(thisArg);
            if (orig) return _fnToString.call(orig);
          }
        } catch (e) {}
        return _fnToString.apply(thisArg, args);
      }
    });
    try {
      _defineProperty(Function.prototype, 'toString', {
        value: toStringProxy,
        writable: true,
        configurable: true
      });
    } catch (e) {}

    function replaceProtoMethod(proto, name, makeWrapper) {
      if (!proto) return;
      let desc;
      try { desc = _getOwnPropertyDescriptor(proto, name); } catch (e) { return; }
      if (!desc || typeof desc.value !== 'function') return;
      const orig = desc.value;
      const wrapped = makeWrapper(orig);
      try {
        _defineProperty(proto, name, {
          value: wrapped,
          writable: desc.writable !== false,
          configurable: desc.configurable !== false,
          enumerable: desc.enumerable === true
        });
      } catch (e) {}
    }

    function replaceProtoGetter(proto, name, makeGetter) {
      if (!proto) return;
      let desc;
      try { desc = _getOwnPropertyDescriptor(proto, name); } catch (e) { return; }
      if (!desc || typeof desc.get !== 'function') return;
      const origGet = desc.get;
      const wrapped = makeGetter(origGet);
      try {
        _defineProperty(proto, name, {
          get: wrapped,
          set: desc.set,
          configurable: desc.configurable !== false,
          enumerable: desc.enumerable === true
        });
      } catch (e) {}
    }

    // ─── Vector 1: Canvas 2D farbling ─────
    try {
      // Deterministic per (seed × pixel index): two reads of the same buffer
      // get the same noise, so a fingerprinter can't average it out within
      // a session.
      function farblePixels(data) {
        if (!data || data.length < 4) return;
        // XOR low bit on a sparse subset of pixels — visually identical,
        // hash-disrupting. Distribution: ~1 pixel in 16.
        const len = data.length >>> 2;
        let s = seed;
        for (let i = 0; i < len; i++) {
          s = (s + 0x9E3779B1) >>> 0;
          s = Math.imul(s ^ (s >>> 16), 0x85EBCA6B) >>> 0;
          if ((s & 15) !== 0) continue;
          const off = i << 2;
          data[off]     ^= (s & 1);
          data[off + 1] ^= ((s >>> 1) & 1);
          data[off + 2] ^= ((s >>> 2) & 1);
        }
      }

      const nativeToDataURL = Canvas && Canvas.prototype.toDataURL;
      const nativeToBlob = Canvas && Canvas.prototype.toBlob;
      const nativeOffToBlob = OffCanvas && OffCanvas.prototype.convertToBlob;
      const nativeGetImageData = Ctx2D && Ctx2D.prototype.getImageData;
      const nativePutImageData = Ctx2D && Ctx2D.prototype.putImageData;
      const nativeOffGetImageData = OffCtx2D && OffCtx2D.prototype.getImageData;
      const nativeOffPutImageData = OffCtx2D && OffCtx2D.prototype.putImageData;

      // Snapshot → farble → run encoder → restore. Avoids cumulative drift
      // and visible mutation if the page reads the canvas back.
      // toBlob/convertToBlob are async but spec says the bitmap is captured
      // synchronously at the call site, so restoring after the sync return
      // is safe — the encoder works against the snapshot it already took.
      function encodeWithFarble(canvas, encode, encodeArgs) {
        const w = canvas.width | 0, h = canvas.height | 0;
        if (w === 0 || h === 0) return _Reflect.apply(encode, canvas, encodeArgs);
        let ctx;
        try { ctx = canvas.getContext('2d'); } catch (e) { ctx = null; }
        if (!ctx) return _Reflect.apply(encode, canvas, encodeArgs);
        const isOff = (OffCtx2D && ctx instanceof OffCtx2D);
        const get = isOff ? nativeOffGetImageData : nativeGetImageData;
        const put = isOff ? nativeOffPutImageData : nativePutImageData;
        if (!get || !put) return _Reflect.apply(encode, canvas, encodeArgs);

        let img;
        try { img = get.call(ctx, 0, 0, w, h); } catch (e) { return _Reflect.apply(encode, canvas, encodeArgs); }

        // Save originals so we can restore.
        const original = new Uint8ClampedArray(img.data);
        farblePixels(img.data);
        try { put.call(ctx, img, 0, 0); } catch (e) {}
        try {
          return _Reflect.apply(encode, canvas, encodeArgs);
        } finally {
          try {
            img.data.set(original);
            put.call(ctx, img, 0, 0);
          } catch (e) {}
        }
      }

      if (nativeToDataURL) {
        replaceProtoMethod(Canvas.prototype, 'toDataURL', function (orig) {
          return wrap(orig, function (t, thisArg, args) {
            return encodeWithFarble(thisArg, t, args);
          });
        });
      }
      if (nativeToBlob) {
        replaceProtoMethod(Canvas.prototype, 'toBlob', function (orig) {
          return wrap(orig, function (t, thisArg, args) {
            return encodeWithFarble(thisArg, t, args);
          });
        });
      }
      if (OffCanvas && nativeOffToBlob) {
        replaceProtoMethod(OffCanvas.prototype, 'convertToBlob', function (orig) {
          return wrap(orig, function (t, thisArg, args) {
            return encodeWithFarble(thisArg, t, args);
          });
        });
      }

      // getImageData: farble the returned buffer in place. Don't mutate the
      // canvas itself — getImageData is read-only by contract.
      function makeGetImageDataWrapper(orig) {
        return wrap(orig, function (t, thisArg, args) {
          const result = _Reflect.apply(t, thisArg, args);
          try { if (result && result.data) farblePixels(result.data); } catch (e) {}
          return result;
        });
      }
      if (nativeGetImageData) {
        replaceProtoMethod(Ctx2D.prototype, 'getImageData', makeGetImageDataWrapper);
      }
      if (OffCtx2D && nativeOffGetImageData) {
        replaceProtoMethod(OffCtx2D.prototype, 'getImageData', makeGetImageDataWrapper);
      }
    } catch (e) {
      try { console.warn('[Chroma FPR] canvas vector failed:', e); } catch (_) {}
    }

    // ─── Vector 2: WebGL ─────
    try {
      // Generic, popular ANGLE values. Goal: collapse all Chroma+AF users
      // into a single anonymity bucket on the Windows bucket. (Linux/Mac
      // users still benefit — collapsing a small extension userbase to a
      // single value is a net entropy reduction.)
      const SPOOFED_VENDOR = 'Google Inc. (Intel)';
      const SPOOFED_RENDERER = 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
      const UNMASKED_VENDOR_WEBGL = 0x9245;
      const UNMASKED_RENDERER_WEBGL = 0x9246;

      function makeGetParameterWrapper(orig) {
        return wrap(orig, function (t, thisArg, args) {
          const pname = args[0];
          if (pname === UNMASKED_VENDOR_WEBGL) return SPOOFED_VENDOR;
          if (pname === UNMASKED_RENDERER_WEBGL) return SPOOFED_RENDERER;
          return _Reflect.apply(t, thisArg, args);
        });
      }
      function makeReadPixelsWrapper(orig) {
        return wrap(orig, function (t, thisArg, args) {
          const r = _Reflect.apply(t, thisArg, args);
          // args: x, y, w, h, format, type, pixels.
          // Only farble byte-typed buffers — XOR'ing Uint16/Float32 elements
          // would corrupt them catastrophically (int coercion).
          const pixels = args[6];
          try {
            if ((pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)
                && pixels.length >= 4) {
              let s = seed ^ 0xA5A5A5A5;
              const sample = Math.max(1, pixels.length >>> 8);
              for (let i = 0; i < sample; i++) {
                s = (s + 0x9E3779B1) >>> 0;
                s = Math.imul(s ^ (s >>> 16), 0x85EBCA6B) >>> 0;
                const idx = s % pixels.length;
                pixels[idx] = pixels[idx] ^ 1;
              }
            }
          } catch (e) {}
          return r;
        });
      }

      if (GL1) {
        replaceProtoMethod(GL1.prototype, 'getParameter', makeGetParameterWrapper);
        replaceProtoMethod(GL1.prototype, 'readPixels', makeReadPixelsWrapper);
      }
      if (GL2) {
        replaceProtoMethod(GL2.prototype, 'getParameter', makeGetParameterWrapper);
        replaceProtoMethod(GL2.prototype, 'readPixels', makeReadPixelsWrapper);
      }
    } catch (e) {
      try { console.warn('[Chroma FPR] webgl vector failed:', e); } catch (_) {}
    }

    // ─── Vector 3: AudioBuffer farbling ─────
    try {
      function farbleAudio(arr) {
        if (!arr || typeof arr.length !== 'number' || arr.length === 0) return;
        // Magnitude 1e-7 — well below auditory threshold and below most
        // float32 quantization noise. Sparse: ~1 sample per 1000.
        let s = seed ^ 0xC0FFEE;
        const sample = Math.max(1, arr.length / 1000) | 0;
        for (let i = 0; i < sample; i++) {
          s = (s + 0x9E3779B1) >>> 0;
          s = Math.imul(s ^ (s >>> 16), 0x85EBCA6B) >>> 0;
          const idx = s % arr.length;
          // Deterministic ±1e-7
          const sign = (s & 1) ? 1 : -1;
          arr[idx] = arr[idx] + sign * 1e-7;
        }
      }

      if (AudioBuf) {
        replaceProtoMethod(AudioBuf.prototype, 'getChannelData', function (orig) {
          return wrap(orig, function (t, thisArg, args) {
            const r = _Reflect.apply(t, thisArg, args);
            try { farbleAudio(r); } catch (e) {}
            return r;
          });
        });
        replaceProtoMethod(AudioBuf.prototype, 'copyFromChannel', function (orig) {
          return wrap(orig, function (t, thisArg, args) {
            const r = _Reflect.apply(t, thisArg, args);
            try { farbleAudio(args[0]); } catch (e) {}
            return r;
          });
        });
      }
    } catch (e) {
      try { console.warn('[Chroma FPR] audio vector failed:', e); } catch (_) {}
    }

    // ─── Vector 4: Navigator clamping ─────
    // Note: navigator.plugins is intentionally NOT touched. Modern Chrome
    // returns the same 5 stub PDF entries to every user, so its entropy is
    // already near-zero; overriding would create a divergence from the
    // browser default and become its own signature.
    try {
      // hardwareConcurrency → 8 (most common bucket per Chrome telemetry).
      // Pass the native getter as the wrap target so `.toString()` on the
      // descriptor's get function returns the original native source.
      replaceProtoGetter(_Navigator.prototype, 'hardwareConcurrency', function (origGet) {
        return wrap(origGet, function () { return 8; });
      });
      // deviceMemory → 8. Only present on some browsers; replaceProtoGetter
      // is a no-op if the descriptor isn't a getter.
      replaceProtoGetter(_Navigator.prototype, 'deviceMemory', function (origGet) {
        return wrap(origGet, function () { return 8; });
      });

      // userAgentData.getHighEntropyValues: drop high-entropy fields.
      const uad = self.navigator && self.navigator.userAgentData;
      if (uad && typeof uad.getHighEntropyValues === 'function') {
        const proto = _Object.getPrototypeOf(uad);
        const desc = _getOwnPropertyDescriptor(proto, 'getHighEntropyValues');
        if (desc && typeof desc.value === 'function') {
          const orig = desc.value;
          const HIGH_ENTROPY = ['model', 'platformVersion', 'architecture', 'bitness', 'fullVersionList', 'wow64', 'formFactor'];
          const wrapped = wrap(orig, function (t, thisArg, args) {
            return _Reflect.apply(t, thisArg, args).then(function (res) {
              if (res && typeof res === 'object') {
                for (let i = 0; i < HIGH_ENTROPY.length; i++) {
                  if (HIGH_ENTROPY[i] in res) delete res[HIGH_ENTROPY[i]];
                }
              }
              return res;
            });
          });
          try {
            _defineProperty(proto, 'getHighEntropyValues', {
              value: wrapped,
              writable: desc.writable !== false,
              configurable: desc.configurable !== false,
              enumerable: desc.enumerable === true
            });
          } catch (e) {}
        }
      }
    } catch (e) {
      try { console.warn('[Chroma FPR] navigator vector failed:', e); } catch (_) {}
    }
  } catch (e) {
    try { console.warn('[Chroma FPR] installer crashed:', e); } catch (_) {}
  }
})();
