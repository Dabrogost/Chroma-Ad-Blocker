/**
 * Chroma Ad-Blocker — Default Subscription Definitions
 * These are the subscriptions shipped with the extension.
 */

export const DEFAULT_SUBSCRIPTIONS = [
  {
    id: 'hagezi-pro-mini',
    name: 'Hagezi Pro Mini',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.mini.txt',
    enabled: true,
    intervalHours: 24,
    lastUpdated: 0,
    version: null,
    lastError: null,
    ruleCount: { network: 0, cosmetic: 0, scriptlet: 0 },
    compatibility: { translatedRegexFilter: 0, unsupportedUrlFilter: 0 }
  },
  {
    id: 'chroma-lib',
    name: 'Chroma Scriptlet Library',
    url: chrome.runtime.getURL('subscriptions/chroma-lib.txt'),
    enabled: true,
    intervalHours: 9999,
    lastUpdated: 0,
    version: null,
    lastError: null,
    ruleCount: { network: 0, cosmetic: 0, scriptlet: 0 },
    compatibility: { translatedRegexFilter: 0, unsupportedUrlFilter: 0 }
  },
  {
    id: 'easylist',
    name: 'EasyList',
    url: 'https://easylist.to/easylist/easylist.txt',
    enabled: true,
    cosmeticOnly: true,
    intervalHours: 24,
    lastUpdated: 0,
    version: null,
    lastError: null,
    ruleCount: { network: 0, cosmetic: 0, scriptlet: 0 },
    compatibility: { translatedRegexFilter: 0, unsupportedUrlFilter: 0 }
  },
  {
    id: 'fanboy-annoyance',
    name: 'Fanboy Annoyance',
    url: 'https://secure.fanboy.co.nz/fanboy-annoyance.txt',
    enabled: true,
    cosmeticOnly: true,
    intervalHours: 24,
    lastUpdated: 0,
    version: null,
    lastError: null,
    ruleCount: { network: 0, cosmetic: 0, scriptlet: 0 },
    compatibility: { translatedRegexFilter: 0, unsupportedUrlFilter: 0 }
  }
];
