/**
 * Default dynamic rules — these supplement the static rule files.
 * Because these are dynamic, they can be updated at runtime without
 * going through the extension store review process. This is to prevent
 * YouTube from blocking the extension.
 */
/**
 * @returns {chrome.declarativeNetRequest.Rule[]}
 */
export function getDefaultDynamicRules() {
  return [
    // Allow YouTube's ad measurement ping endpoints (Exemption)
    {
      id: 1001,
      priority: 4,
      action: { type: 'allow' },
      condition: {
        urlFilter: '/api/stats/ads',
        initiatorDomains: ['youtube.com', 'www.youtube.com'],
        resourceTypes: ['xmlhttprequest', 'image', 'ping'],
      },
    },
    // Allow YouTube conversion-tracking pings (Anti-Detection: YouTube-only)
    // PRIVACY TRADEOFF: Permits Google conversion measurement on youtube.com to
    // prevent detection. Chroma does not receive or store this data.
    {
      id: 1002,
      priority: 4,
      action: { type: 'allow' },
      condition: {
        urlFilter: '/pagead/viewthroughconversion',
        initiatorDomains: ['youtube.com', 'www.youtube.com'],
        resourceTypes: ['image', 'xmlhttprequest', 'ping'],
      },
    },
    // Allow ad companion banners fetched via XHR (Exemption)
    {
      id: 1003,
      priority: 4,
      action: { type: 'allow' },
      condition: {
        urlFilter: '/get_video_info?*adformat',
        initiatorDomains: ['youtube.com', 'www.youtube.com'],
        resourceTypes: ['xmlhttprequest'],
      },
    },
    // Allow DoubleClick measurement pixel — YouTube-only (Anti-Detection)
    // PRIVACY TRADEOFF: Permits standard ad-measurement infrastructure on
    // youtube.com to prevent detection. Restricted to YouTube initiator only.
    {
      id: 1004,
      priority: 4,
      action: { type: 'allow' },
      condition: {
        urlFilter: '||cm.g.doubleclick.net^',
        initiatorDomains: ['youtube.com', 'www.youtube.com'],
        resourceTypes: ['image', 'ping', 'xmlhttprequest'],
      },
    },
    // Allow DoubleClick ad-serving domain — YouTube-only (Anti-Detection)
    // PRIVACY TRADEOFF: Permits ad.doubleclick.net on youtube.com to prevent
    // detection. Restricted to YouTube initiator only.
    {
      id: 1005,
      priority: 4,
      action: { type: 'allow' },
      condition: {
        urlFilter: '||ad.doubleclick.net^',
        initiatorDomains: ['youtube.com', 'www.youtube.com'],
        resourceTypes: ['image', 'ping', 'xmlhttprequest', 'script'],
      },
    },
    // Allow YouTube's "Engagement Panel" ad calls (Exemption)
    {
      id: 1006,
      priority: 4,
      action: { type: 'allow' },
      condition: {
        urlFilter: '/youtubei/v1/log_event',
        initiatorDomains: ['youtube.com', 'www.youtube.com'],
        resourceTypes: ['xmlhttprequest'],
      },
    },
    // Allow YouTube ad progress tracking beacons (Anti-Detection)
    // PRIVACY TRADEOFF: Permits ptracking quartile beacons on youtube.com to
    // prevent detection. Restricted to YouTube initiator only.
    {
      id: 1007,
      priority: 4,
      action: { type: 'allow' },
      condition: {
        urlFilter: '||youtube.com/ptracking',
        initiatorDomains: ['youtube.com', 'www.youtube.com'],
        resourceTypes: ['xmlhttprequest', 'ping', 'image'],
      },
    },
    // Allow YouTube Active View viewability measurement (Anti-Detection)
    // PRIVACY TRADEOFF: Permits activeview measurement on youtube.com to
    // prevent detection. Restricted to YouTube initiator only.
    {
      id: 1008,
      priority: 4,
      action: { type: 'allow' },
      condition: {
        urlFilter: '||youtube.com/pcs/activeview',
        initiatorDomains: ['youtube.com', 'www.youtube.com'],
        resourceTypes: ['xmlhttprequest', 'ping', 'image'],
      },
    },
    // Allow DoubleClick ID sync endpoint — YouTube-only (Anti-Detection)
    // PRIVACY TRADEOFF: Permits the /pagead/id identity sync call on youtube.com
    // to prevent detection. Scoped to path only — display ad serving from this
    // domain remains blocked. Restricted to YouTube initiator only.
    {
      id: 1009,
      priority: 4,
      action: { type: 'allow' },
      condition: {
        urlFilter: 'googleads.g.doubleclick.net/pagead/id',
        initiatorDomains: ['youtube.com', 'www.youtube.com'],
        resourceTypes: ['xmlhttprequest', 'ping'],
      },
    },
    // Allow YouTube nocookie ptracking — Anti-Detection
    // PRIVACY TRADEOFF: Permits ptracking on youtube-nocookie.com embed context.
    {
      id: 1010,
      priority: 4,
      action: { type: 'allow' },
      condition: {
        urlFilter: '||youtube-nocookie.com/ptracking',
        initiatorDomains: ['youtube.com', 'www.youtube.com', 'youtube-nocookie.com'],
        resourceTypes: ['xmlhttprequest', 'ping', 'image'],
      },
    },
    // Allow YouTube ad view measurement (Anti-Detection)
    // PRIVACY TRADEOFF: Permits pagead/adview measurement on youtube.com to
    // prevent detection. Restricted to YouTube initiator only.
    {
      id: 1011,
      priority: 4,
      action: { type: 'allow' },
      condition: {
        urlFilter: '/pagead/adview',
        initiatorDomains: ['youtube.com', 'www.youtube.com'],
        resourceTypes: ['xmlhttprequest', 'ping', 'image'],
      },
    },
    // Allow YouTube ad interaction reporting (Anti-Detection)
    // PRIVACY TRADEOFF: Permits pagead/interaction reporting on youtube.com to
    // prevent detection. Restricted to YouTube initiator only.
    {
      id: 1012,
      priority: 4,
      action: { type: 'allow' },
      condition: {
        urlFilter: '/pagead/interaction',
        initiatorDomains: ['youtube.com', 'www.youtube.com'],
        resourceTypes: ['xmlhttprequest', 'ping', 'image'],
      },
    },
    // Allow DoubleClick instream ad lifecycle script (Anti-Detection)
    {
      id: 1013,
      priority: 4,
      action: { type: 'allow' },
      condition: {
        urlFilter: '||static.doubleclick.net/instream/ad_status.js',
        initiatorDomains: ['youtube.com', 'www.youtube.com'],
        resourceTypes: ['script'],
      },
    },
    // Allow SODAR bot detection script (Anti-Detection)
    // PRIVACY TRADEOFF: Permits Google's ad fraud detection on youtube.com.
    // Blocking this is a strong automated-behavior signal.
    {
      id: 1014,
      priority: 4,
      action: { type: 'allow' },
      condition: {
        urlFilter: 'tpc.googlesyndication.com/sodar/',
        initiatorDomains: ['youtube.com', 'www.youtube.com'],
        resourceTypes: ['script'],
      },
    },
    // Allow YouTube connectivity/measurement ping (Anti-Detection)
    // PRIVACY TRADEOFF: Permits the generate_204 beacon on youtube.com
    // to prevent detection. Restricted to YouTube initiator only.
    {
      id: 1015,
      priority: 4,
      action: { type: 'allow' },
      condition: {
        urlFilter: '||youtube.com/generate_204',
        initiatorDomains: ['youtube.com', 'www.youtube.com'],
        resourceTypes: ['xmlhttprequest', 'ping', 'image', 'other'],
      },
    },
  ];
}
