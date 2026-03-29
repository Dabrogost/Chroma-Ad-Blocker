/**
 * Default dynamic rules — these supplement the static rules.json.
 * Because these are dynamic, they can be updated at runtime without
 * going through the extension store review process. This is to prevent
 * YouTube from blocking the extension.
 */
export function getDefaultDynamicRules() {
  return [
    // Allow YouTube's ad measurement ping endpoints (Exemption)
    {
      id: 1001,
      priority: 1,
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
      priority: 1,
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
      priority: 1,
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
      priority: 1,
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
      priority: 1,
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
      priority: 1,
      action: { type: 'allow' },
      condition: {
        urlFilter: '/youtubei/v1/log_event',
        initiatorDomains: ['youtube.com', 'www.youtube.com'],
        resourceTypes: ['xmlhttprequest'],
      },
    },
  ];
}
