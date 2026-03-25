/**
 * YT Chroma - Main World Interceptor
 * Runs in the page's execution context (MAIN world).
 * Overrides window.open to detect and notify about popup attempts.
 */

(function() {
  'use strict';

  const originalOpen = window.open;
  const originalFocus = window.focus;
  const originalBlur = window.blur;

  let lastOpenTime = 0;

  window.open = function(url, name, specs) {
    // Capture the stack trace to help identify the caller script in content script/background
    let stack = '';
    try {
      throw new Error();
    } catch (e) {
      stack = e.stack || '';
    }

    // Notify the isolated content script about the window.open call
    window.postMessage({
      source: 'yt-chroma-main-world',
      type: 'WINDOW_OPEN_ATTEMPT',
      url: String(url || 'about:blank'),
      name: String(name || ''),
      specs: String(specs || ''),
      stack: stack
    }, '*');

    lastOpenTime = Date.now();
    
    // Proceed with the original open call.
    return originalOpen.apply(this, arguments);
  };

  // Detect suspicious focus/blur patterns right after a window.open
  window.focus = function() {
    if (Date.now() - lastOpenTime < 1000) {
      window.postMessage({
        source: 'yt-chroma-main-world',
        type: 'SUSPICIOUS_FOCUS_ATTEMPT',
        context: 'window.focus() called shortly after window.open()'
      }, '*');
    }
    return originalFocus.apply(this, arguments);
  };

  window.blur = function() {
    if (Date.now() - lastOpenTime < 1000) {
      window.postMessage({
        source: 'yt-chroma-main-world',
        type: 'SUSPICIOUS_BLUR_ATTEMPT',
        context: 'window.blur() called shortly after window.open()'
      }, '*');
    }
    return originalBlur.apply(this, arguments);
  };

  /**
   * PUSH NOTIFICATION BLOCKING
   * We shadow the Notification API and PushManager to prevent websites from
   * requesting permissions or sending push ads.
   */
  const checkPushBlocking = () => document.documentElement.dataset.ytChromaPushActive === 'true';

  if (typeof window.Notification !== 'undefined') {
    const originalRequestPermission = window.Notification.requestPermission;
    
    // Shadow Notification.requestPermission
    window.Notification.requestPermission = function(callback) {
      if (checkPushBlocking()) {
        console.warn('[YT Chroma] Blocked notification permission request.');
        window.postMessage({ source: 'yt-chroma-main-world', type: 'NOTIFICATION_ATTEMPT' }, '*');
        
        const denied = 'denied';
        if (typeof callback === 'function') {
          try { callback(denied); } catch (e) {}
        }
        return Promise.resolve(denied);
      }
      
      // Handle legacy callback if provided
      if (typeof callback === 'function') {
        return originalRequestPermission.call(this, (result) => {
          callback(result);
        });
      }
      
      return originalRequestPermission.apply(this, arguments);
    };

    // Keep permission as 'denied' if active
    if (!Object.getOwnPropertyDescriptor(window.Notification, 'permission')) {
      Object.defineProperty(window.Notification, 'permission', {
        get: function() {
          if (checkPushBlocking()) return 'denied';
          return 'default';
        },
        configurable: true
      });
    }

    // Shadow Notification constructor
    const OriginalNotification = window.Notification;
    const ShadowNotification = function(title, options) {
      if (checkPushBlocking()) {
        console.warn('[YT Chroma] Blocked Notification construction:', title);
        window.postMessage({ source: 'yt-chroma-main-world', type: 'NOTIFICATION_ATTEMPT' }, '*');
        
        // Return a dummy object that mimics a Notification
        this.title = title;
        this.body = options?.body || '';
        this.icon = options?.icon || '';
        this.tag = options?.tag || '';
        this.onclick = null;
        this.onshow = null;
        this.onerror = null;
        this.onclose = null;
        this.close = () => {};
        
        // Trigger onshow after a short delay to mimic native behavior
        setTimeout(() => {
          if (typeof this.onshow === 'function') {
            try { this.onshow(); } catch (e) {}
          }
        }, 50);
        
        return this;
      }
      return new OriginalNotification(title, options);
    };
    // Shadow Notification static methods and properties
    ShadowNotification.requestPermission = window.Notification.requestPermission;
    Object.defineProperty(ShadowNotification, 'permission', {
      get: function() {
        if (checkPushBlocking()) return 'denied';
        return OriginalNotification.permission;
      },
      configurable: true
    });
    ShadowNotification.prototype = OriginalNotification.prototype;
    window.Notification = ShadowNotification;
  }

  // Shadow ServiceWorkerRegistration.prototype.showNotification
  if (typeof ServiceWorkerRegistration !== 'undefined' && ServiceWorkerRegistration.prototype) {
    const originalShowNotification = ServiceWorkerRegistration.prototype.showNotification;
    ServiceWorkerRegistration.prototype.showNotification = function(title, options) {
      if (checkPushBlocking()) {
        console.warn('[YT Chroma] Blocked ServiceWorker showNotification:', title);
        window.postMessage({ source: 'yt-chroma-main-world', type: 'NOTIFICATION_ATTEMPT' }, '*');
        return Promise.resolve();
      }
      return originalShowNotification.apply(this, arguments);
    };
  }

  // Shadow navigator.permissions.query
  if (typeof navigator.permissions !== 'undefined' && typeof navigator.permissions.query === 'function') {
    const originalQuery = navigator.permissions.query;
    navigator.permissions.query = function(parameters) {
      if (parameters && parameters.name === 'notifications' && checkPushBlocking()) {
        return Promise.resolve({
          state: 'denied',
          onchange: null,
          name: 'notifications'
        });
      }
      return originalQuery.apply(this, arguments);
    };
  }

  // Shadow ServiceWorker pushManager
  if (typeof ServiceWorkerRegistration !== 'undefined' && 
      ServiceWorkerRegistration.prototype && 
      Object.prototype.hasOwnProperty.call(ServiceWorkerRegistration.prototype, 'pushManager') &&
      typeof PushManager !== 'undefined' && 
      PushManager.prototype) {
    
    const originalSubscribe = PushManager.prototype.subscribe;
    if (typeof originalSubscribe === 'function') {
      PushManager.prototype.subscribe = function() {
        if (checkPushBlocking()) {
          console.warn('[YT Chroma] Blocked PushManager subscription attempt.');
          return Promise.reject(new DOMException('Registration failed - push service not available', 'AbortError'));
        }
        return originalSubscribe.apply(this, arguments);
      };
    }
  }

  console.log('[YT Chroma] Main world interceptor active.');
})();
