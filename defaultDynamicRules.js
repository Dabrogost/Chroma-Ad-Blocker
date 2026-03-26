/**
 * Default dynamic rules — these supplement the static rules.json.
 * Because these are dynamic, they can be updated at runtime without
 * going through the extension store review process.
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
    {
      id: 1002,
      priority: 1,
      action: { type: 'allow' },
      condition: {
        urlFilter: '/pagead/viewthroughconversion',
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
    // Allow DoubleClick pixel tracking (Exemption)
    {
      id: 1004,
      priority: 1,
      action: { type: 'allow' },
      condition: {
        urlFilter: '||cm.g.doubleclick.net^',
        resourceTypes: ['image', 'ping', 'xmlhttprequest'],
      },
    },
    {
      id: 1005,
      priority: 1,
      action: { type: 'allow' },
      condition: {
        urlFilter: '||ad.doubleclick.net^',
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
