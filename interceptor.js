/**
 * Chroma Ad-Blocker - Generic Interceptor
 * Runs in the page's execution context (MAIN world) for all sites.
 * Overrides window.open and Notification APIs to detect and notify about popup attempts.
 */

(function() {
  'use strict';

  const originalOpen = window.open;
  const originalFocus = window.focus;
  const originalBlur = window.blur;

  let lastOpenTime = 0;

  // Use generic dataset attribute names
  const checkPopUnderBlocking = () => document.documentElement.dataset.chromaPopActive === 'true';

  window.open = function(url, name, specs) {
    if (checkPopUnderBlocking()) {
      // Capture the stack trace to help identify the caller script in content script/background
      let stack = '';
      try {
        throw new Error();
      } catch (e) {
        stack = e.stack || '';
      }

      // Notify the isolated content script about the window.open call
      window.postMessage({
        source: 'chroma-interceptor',
        type: 'WINDOW_OPEN_ATTEMPT',
        url: String(url || 'about:blank'),
        name: String(name || ''),
        specs: String(specs || ''),
        stack: stack
      }, '*');

      lastOpenTime = Date.now();
    }
    
    // Proceed with the original open call.
    return originalOpen.apply(this, arguments);
  };

  // Detect suspicious focus/blur patterns right after a window.open
  window.focus = function() {
    if (checkPopUnderBlocking() && Date.now() - lastOpenTime < 1000) {
      window.postMessage({
        source: 'chroma-interceptor',
        type: 'SUSPICIOUS_FOCUS_ATTEMPT',
        context: 'window.focus() called shortly after window.open()'
      }, '*');
    }
    return originalFocus.apply(this, arguments);
  };

  window.blur = function() {
    if (checkPopUnderBlocking() && Date.now() - lastOpenTime < 1000) {
      window.postMessage({
        source: 'chroma-interceptor',
        type: 'SUSPICIOUS_BLUR_ATTEMPT',
        context: 'window.blur() called shortly after window.open()'
      }, '*');
    }
    return originalBlur.apply(this, arguments);
  };

  /**
   * PUSH NOTIFICATION BLOCKING
   */
  const checkPushBlocking = () => document.documentElement.dataset.chromaPushActive === 'true';

  if (typeof window.Notification !== 'undefined') {
    const originalRequestPermission = window.Notification.requestPermission;
    
    window.Notification.requestPermission = function(callback) {
      if (checkPushBlocking()) {
        console.warn('[Chroma Ad-Blocker] Blocked notification permission request.');
        window.postMessage({ source: 'chroma-interceptor', type: 'NOTIFICATION_ATTEMPT' }, '*');
        
        const denied = 'denied';
        if (typeof callback === 'function') {
          try { callback(denied); } catch (e) {}
        }
        return Promise.resolve(denied);
      }
      
      if (typeof callback === 'function') {
        return originalRequestPermission.call(this, (result) => {
          callback(result);
        });
      }
      
      return originalRequestPermission.apply(this, arguments);
    };

    if (!Object.getOwnPropertyDescriptor(window.Notification, 'permission')) {
      Object.defineProperty(window.Notification, 'permission', {
        get: function() {
          if (checkPushBlocking()) return 'denied';
          return 'default';
        },
        configurable: true
      });
    }

    const OriginalNotification = window.Notification;
    const ShadowNotification = function(title, options) {
      if (checkPushBlocking()) {
        console.warn('[Chroma Ad-Blocker] Blocked Notification construction:', title);
        window.postMessage({ source: 'chroma-interceptor', type: 'NOTIFICATION_ATTEMPT' }, '*');
        
        this.title = title;
        this.body = options?.body || '';
        this.icon = options?.icon || '';
        this.tag = options?.tag || '';
        this.onclick = null;
        this.onshow = null;
        this.onerror = null;
        this.onclose = null;
        this.close = () => {};
        
        setTimeout(() => {
          if (typeof this.onshow === 'function') {
            try { this.onshow(); } catch (e) {}
          }
        }, 50);
        
        return this;
      }
      return new OriginalNotification(title, options);
    };

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

  // ServiceWorker and Navigation API shadowing...
  if (typeof ServiceWorkerRegistration !== 'undefined' && ServiceWorkerRegistration.prototype) {
    const originalShowNotification = ServiceWorkerRegistration.prototype.showNotification;
    ServiceWorkerRegistration.prototype.showNotification = function(title, options) {
      if (checkPushBlocking()) {
        console.warn('[Chroma Ad-Blocker] Blocked ServiceWorker showNotification:', title);
        window.postMessage({ source: 'chroma-interceptor', type: 'NOTIFICATION_ATTEMPT' }, '*');
        return Promise.resolve();
      }
      return originalShowNotification.apply(this, arguments);
    };
  }

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

  if (typeof ServiceWorkerRegistration !== 'undefined' && 
      ServiceWorkerRegistration.prototype && 
      Object.prototype.hasOwnProperty.call(ServiceWorkerRegistration.prototype, 'pushManager') &&
      typeof PushManager !== 'undefined' && 
      PushManager.prototype) {
    
    const originalSubscribe = PushManager.prototype.subscribe;
    if (typeof originalSubscribe === 'function') {
      PushManager.prototype.subscribe = function() {
        if (checkPushBlocking()) {
          console.warn('[Chroma Ad-Blocker] Blocked PushManager subscription attempt.');
          return Promise.reject(new DOMException('Registration failed - push service not available', 'AbortError'));
        }
        return originalSubscribe.apply(this, arguments);
      };
    }
  }

  console.log('[Chroma Ad-Blocker] Global interceptor active.');
})();
