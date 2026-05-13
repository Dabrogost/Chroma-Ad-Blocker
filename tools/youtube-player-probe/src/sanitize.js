'use strict';

const KNOWN_STRIPPER_FIELDS = Object.freeze([
  'adPlacements',
  'adSlots',
  'playerAds',
  'adBreakParams',
  'adBreakHeartbeatParams',
  'adInferredBlockingStatus'
]);

const SHORTS_AD_FIELDS = Object.freeze([
  'adsOverlay',
  'shortsAdsRenderer',
  'sequenceItemInPlayerAdLayoutRenderer'
]);

const AD_TOKENS = Object.freeze([
  'ad',
  'ads',
  'advert',
  'advertise',
  'advertiser',
  'advertising',
  'advertisement',
  'sponsor',
  'sponsored',
  'paid',
  'promoted',
  'instream',
  'preroll',
  'midroll',
  'slot',
  'placement',
  'break'
]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function shouldSampleArray(index, length) {
  return index < 3 || index === length - 1;
}

function normalizePath(path) {
  return path.replace(/\[\d+\]/g, '[]');
}

function isAdLikeKey(key) {
  const tokens = String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/gi, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  return KNOWN_STRIPPER_FIELDS.includes(key) ||
    SHORTS_AD_FIELDS.includes(key) ||
    tokens.some((token) => AD_TOKENS.includes(token));
}

function walkJson(value, options = {}) {
  const maxDepth = options.maxDepth || 12;
  const maxPaths = options.maxPaths || 5000;
  const seen = new WeakSet();
  const pathTypes = new Map();
  const adLikePaths = new Set();
  const knownStripperPathsPresent = new Set();
  let truncated = false;

  function addPath(path, valueAtPath, key = '') {
    if (!path || pathTypes.size >= maxPaths) {
      if (pathTypes.size >= maxPaths) truncated = true;
      return;
    }

    const normalized = normalizePath(path);
    if (!pathTypes.has(normalized)) {
      pathTypes.set(normalized, typeOf(valueAtPath));
    }

    if (isAdLikeKey(key)) {
      adLikePaths.add(normalized);
    }

    if (KNOWN_STRIPPER_FIELDS.includes(key)) {
      knownStripperPathsPresent.add(normalized);
    }
  }

  function visit(node, path, depth, key) {
    addPath(path, node, key);
    if (!node || typeof node !== 'object') return;
    if (depth >= maxDepth) {
      truncated = true;
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (!shouldSampleArray(i, node.length)) {
          truncated = true;
          continue;
        }
        visit(node[i], `${path}[${i}]`, depth + 1, String(i));
      }
      return;
    }

    for (const childKey of Object.keys(node)) {
      const childPath = path ? `${path}.${childKey}` : childKey;
      visit(node[childKey], childPath, depth + 1, childKey);
    }
  }

  visit(value, '', 0, '');

  return {
    pathTypes: options.includePathTypes === false
      ? undefined
      : Object.fromEntries([...pathTypes.entries()].sort(([a], [b]) => a.localeCompare(b))),
    adLikePaths: [...adLikePaths].sort(),
    knownStripperPathsPresent: [...knownStripperPathsPresent].sort(),
    truncated
  };
}

module.exports = {
  KNOWN_STRIPPER_FIELDS,
  SHORTS_AD_FIELDS,
  walkJson,
  normalizePath,
  isAdLikeKey
};
