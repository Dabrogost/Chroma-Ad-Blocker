/**
 * Spotify media redirects adapted from uBlock Origin (GPL-3.0-or-later):
 * https://github.com/uBlockOrigin/uAssets/blob/master/filters/filters-2020.txt
 * Only browser-classified media requests are redirected; player JSON is untouched.
 */
export function getSpotifyRules(config, whitelist = []) {
  if (config?.enabled !== true || config?.spotifyAdBlocking !== true) return [];
  if (whitelist.some(domain => typeof domain === 'string' &&
    (domain === 'open.spotify.com' || 'open.spotify.com'.endsWith('.' + domain)))) return [];

  const condition = { initiatorDomains: ['open.spotify.com'], resourceTypes: ['media'] };
  const redirects = [
    '||akamaized.net/audio/', '||scdn.co/audio/', '||scdn.co/mp3-ad/',
    '||scdn.co/mp3/', '||spotifycdn.com/audio/', '||amillionads.com^',
    '||2mdn.net^', '||adxcel.com^', '||adstudio-assets.scdn.co^',
    '||spotify.com/ad-logic/'
  ].map((urlFilter, index) => ({
    id: 3000 + index,
    priority: 10,
    action: { type: 'redirect', redirect: { extensionPath: '/media/noop-1s.mp4' } },
    condition: { ...condition, urlFilter }
  }));
  const exceptions = ['||podscribe.com/rss/', '||mgln.ai/e/', '/traffic.megaphone.fm/*.mp3^']
    .map((urlFilter, index) => ({
      id: 3010 + index,
      priority: 11,
      action: { type: 'allow' },
      condition: { ...condition, urlFilter }
    }));
  // uBO's urlskip extracts the direct Megaphone MP3 from a tracking URL.
  // Exclude direct URLs to prevent a redirect-to-self loop.
  const podcastRedirect = {
    id: 3013,
    priority: 12,
    action: { type: 'redirect', redirect: { regexSubstitution: 'https://\\1' } },
    condition: {
      ...condition,
      excludedRequestDomains: ['traffic.megaphone.fm'],
      regexFilter: '^https?://[^/]+/.*(traffic\\.megaphone\\.fm/\\w+\\.mp3)'
    }
  };
  // DNR has no "redirect only if otherwise blocked" action. Do not translate
  // uBO's *$media,3p,redirect-rule fallback into a blanket media redirect.
  return [...redirects, ...exceptions, podcastRedirect];
}
