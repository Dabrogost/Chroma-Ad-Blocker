/**
 * Chroma Ad-Blocker — Default Subscription Definitions
 * These are the subscriptions shipped with the extension.
 * The hotfix list is maintainer-controlled for rapid response between releases.
 */

export const DEFAULT_SUBSCRIPTIONS = [
  {
    id: 'easyprivacy',
    name: 'EasyPrivacy',
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    enabled: true,
    intervalHours: 24,
    lastUpdated: 0,
    version: null,
    lastError: null,
    ruleCount: { network: 0, cosmetic: 0, scriptlet: 0 }
  },
  {
    id: 'chroma-hotfix',
    name: 'Chroma Hotfix Rules',
    url: 'https://raw.githubusercontent.com/Dabrogost/Chroma-Ad-Blocker/master/subscriptions/hotfix.txt',
    enabled: true,
    intervalHours: 6,
    lastUpdated: 0,
    version: null,
    lastError: null,
    ruleCount: { network: 0, cosmetic: 0, scriptlet: 0 }
  }
];
