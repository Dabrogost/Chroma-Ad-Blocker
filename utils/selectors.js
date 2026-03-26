/**
 * Shared cosmetic selectors for Chroma Ad-Blocker.
 */

if (typeof window.HIDE_SELECTORS === 'undefined') {
  window.HIDE_SELECTORS = [
    '.ytd-display-ad-renderer',
    'ytd-display-ad-renderer',
    '#masthead-ad',
    'ytd-banner-promo-renderer',
    '#banner-ad',
    '#player-ads',
    '.ytd-promoted-sparkles-web-renderer',
    'ytd-promoted-sparkles-web-renderer',
    '.ytd-promoted-video-renderer',
    'ytd-promoted-video-renderer',
    'ytd-search-pyv-renderer',
    'ytd-ad-slot-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-rich-item-renderer:has(ytd-ad-slot-renderer)',
    'ytd-rich-item-renderer:has(.ytd-ad-slot-renderer)',
    'ytd-rich-section-renderer:has(ytd-ad-slot-renderer)',
    'ytd-rich-section-renderer:has(.ytd-ad-slot-renderer)',
    'ytd-rich-item-renderer:has(#ad-badge)',
    'ytd-rich-section-renderer:has(#ad-badge)',
    'ytd-statement-banner-renderer',
    'ytd-video-masthead-ad-v3-renderer',
    'ytd-reel-shelf-renderer[is-ad]',
    '.ytd-mealbar-promo-renderer',
    'ytd-mealbar-promo-renderer',
    '.ytp-suggested-action',
    '.adbox.banner_ads.adsbox',
    '.textads',
    '.ad_unit',
    '.ad-server',
    '.ad-wrapper',
    '#ad-test',
    '.ad-test',
    '.advertisement',
    'img[src*="/ad/gif.gif"]',
    'img[src*="/ad/static.png"]',
    'img[src*="advmaker"]',
    'div[class*="advmaker"]',
    'a[href*="advmaker"]',
    '.advmaker',
    '#advmaker',
    '.ad-slot',
    '.ad-container',
    '.ads-by-google',
    '[id^="ad-"]',
    '[class^="ad-"]',
  ];
}

if (typeof window.WARNING_SELECTORS === 'undefined') {
  window.WARNING_SELECTORS = [
    'tp-yt-iron-overlay-backdrop',
    'ytd-enforcement-message-view-model',
    '.ytd-enforcement-message-view-model',
    '#header-ad-container',
    '.yt-playability-error-supported-renderers',
  ];
}

if (typeof window.WARNING_SELECTOR_COMBINED === 'undefined') {
  window.WARNING_SELECTOR_COMBINED = window.WARNING_SELECTORS.join(',');
}
