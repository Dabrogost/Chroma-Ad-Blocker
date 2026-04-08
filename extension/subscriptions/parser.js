/**
 * Chroma Ad-Blocker — Filter List Parser
 * Stateless pure functions. No chrome APIs. Directly unit-testable.
 * Handles ABP/uBlock filter syntax for network, cosmetic, and scriptlet rules.
 * Known limitations (counted, not silently dropped):
 *   - Regex network rules (/pattern/)
 *   - Procedural cosmetic filters (#?#)
 *   - $redirect, $csp, $rewrite, $generichide, $genericblock
 *   - Negated resource types (~$script etc.)
 */

'use strict';

// ─── RESOURCE TYPE MAP ─────
const RESOURCE_TYPE_MAP = {
  'script':             'script',
  'image':              'image',
  'stylesheet':         'stylesheet',
  'xmlhttprequest':     'xmlhttprequest',
  'xhr':                'xmlhttprequest',
  'media':              'media',
  'font':               'font',
  'subdocument':        'sub_frame',
  'frame':              'sub_frame',
  'document':           'main_frame',
  'websocket':          'websocket',
  'ping':               'ping',
  'object':             'object',
  'object-subrequest':  'object',
  'other':              'other'
};

// Options that have no DNR equivalent — rules containing these are dropped cleanly
const SKIP_OPTIONS = new Set([
  'popup', 'redirect', 'redirect-rule', 'csp', 'rewrite',
  'generichide', 'genericblock', 'inline-script', 'inline-font',
  'webrtc', 'mp4', 'empty', 'elemhide'
]);

// ─── LINE CLASSIFIER ─────
/**
 * Classifies a single filter list line into a rule type.
 * @param {string} line
 * @returns {'comment'|'network'|'exception'|'cosmetic'|'cosmetic-exception'|'scriptlet'|'extended-css'}
 */
function classifyLine(line) {
  if (!line || line.startsWith('!') || line.startsWith('[') || line.startsWith('#')) return 'comment';
  if (line.includes('##+js(')) return 'scriptlet';
  if (line.startsWith('@@')) return 'exception';
  if (line.includes('#@#')) return 'cosmetic-exception';
  if (line.includes('#?#')) return 'extended-css'; // Procedural — not supported
  if (line.includes('##')) return 'cosmetic';
  return 'network';
}

// ─── OPTIONS PARSER ─────
/**
 * Parses the options string from a network rule into structured modifiers.
 * @param {string} optionsStr
 * @returns {{ resourceTypes: string[]|null, domainType: string|null, initiatorDomains: string[]|null, excludedInitiatorDomains: string[]|null, isImportant: boolean, hasSkipOption: boolean }}
 */
function parseOptions(optionsStr) {
  const result = {
    resourceTypes: null,
    domainType: null,
    initiatorDomains: null,
    excludedInitiatorDomains: null,
    isImportant: false,
    hasSkipOption: false
  };

  if (!optionsStr) return result;

  for (const opt of optionsStr.split(',')) {
    const trimmed = opt.trim();
    if (!trimmed) continue;

    // Check skip options first (strip negation prefix before checking)
    if (SKIP_OPTIONS.has(trimmed.replace(/^~/, ''))) {
      result.hasSkipOption = true;
      return result; // Early exit — entire rule is dropped
    }

    if (trimmed === 'important') {
      result.isImportant = true;
      continue;
    }

    if (trimmed === 'third-party' || trimmed === '3p') {
      result.domainType = 'thirdParty';
      continue;
    }

    if (trimmed === 'first-party' || trimmed === '1p' ||
        trimmed === '~third-party' || trimmed === '~3p') {
      result.domainType = 'firstParty';
      continue;
    }

    if (trimmed.startsWith('domain=')) {
      const domainList = trimmed.slice(7).split('|');
      const include = [];
      const exclude = [];
      for (const d of domainList) {
        if (d.startsWith('~')) exclude.push(d.slice(1));
        else if (d) include.push(d);
      }
      if (include.length > 0) result.initiatorDomains = include;
      if (exclude.length > 0) result.excludedInitiatorDomains = exclude;
      continue;
    }

    // Negated resource types — no clean DNR equivalent, skipped
    if (trimmed.startsWith('~')) continue;

    const mappedType = RESOURCE_TYPE_MAP[trimmed];
    if (mappedType) {
      if (!result.resourceTypes) result.resourceTypes = [];
      if (!result.resourceTypes.includes(mappedType)) result.resourceTypes.push(mappedType);
    }
  }

  return result;
}

// ─── NETWORK RULE PARSER ─────
/**
 * Parses a network or exception rule line into a partial DNR rule object (no id assigned).
 * @param {string} line
 * @param {boolean} [isException=false]
 * @returns {Object|null}
 */
function parseNetworkRule(line, isException = false) {
  try {
    const stripped = isException ? line.slice(2) : line;

    if (!stripped) return null;

    // Pure wildcards — useless rules
    if (stripped === '*' || stripped === '*$*') return null;

    // Regex rules — Phase 1 skip
    if (stripped.startsWith('/') && stripped.slice(1).lastIndexOf('/') > 0) return null;

    // Split pattern from options on first '$'
    const dollarIdx = stripped.indexOf('$');
    const pattern    = dollarIdx === -1 ? stripped : stripped.slice(0, dollarIdx);
    const optionsStr = dollarIdx === -1 ? ''        : stripped.slice(dollarIdx + 1);

    if (!pattern) return null;

    const opts = parseOptions(optionsStr);
    if (opts.hasSkipOption) return null;

    const condition = { urlFilter: pattern };
    if (opts.resourceTypes)              condition.resourceTypes              = opts.resourceTypes;
    if (opts.domainType)                 condition.domainType                 = opts.domainType;
    if (opts.initiatorDomains)           condition.initiatorDomains           = opts.initiatorDomains;
    if (opts.excludedInitiatorDomains)   condition.excludedInitiatorDomains   = opts.excludedInitiatorDomains;

    // Priority:
    //   1 = standard block
    //   2 = exception (allow)
    //   3 = $important block
    // Whitelist rules remain at 999999 (unchanged in background.js)
    const priority = isException ? 2 : (opts.isImportant ? 3 : 1);

    return {
      priority,
      action: { type: isException ? 'allow' : 'block' },
      condition
    };
  } catch {
    return null;
  }
}

// ─── COSMETIC RULE PARSER ─────
/**
 * Parses a cosmetic rule line.
 * @param {string} line
 * @param {boolean} [isException=false]
 * @returns {{ domains: string[]|null, selector: string, isException: boolean }|null}
 */
function parseCosmeticRule(line, isException = false) {
  try {
    const sep = isException ? '#@#' : '##';
    const idx = line.indexOf(sep);
    if (idx === -1) return null;

    const domainPart = line.slice(0, idx).trim();
    const selector   = line.slice(idx + sep.length).trim();

    if (!selector) return null;

    // Extended/procedural CSS — skip in Phase 1
    if (selector.startsWith(':-abp-') || selector.includes(':xpath(') ||
        selector.includes(':-abp-has(') || selector.includes(':upward(') ||
        selector.includes(':nth-ancestor(')) return null;

    const domains = domainPart
      ? domainPart.split(',').map(d => d.trim()).filter(Boolean)
      : null;

    return {
      domains: (domains && domains.length > 0) ? domains : null,
      selector,
      isException
    };
  } catch {
    return null;
  }
}

// ─── SCRIPTLET RULE PARSER ─────
/**
 * Parses a scriptlet rule line. Stored as opaque data — Phase 2 engine executes.
 * @param {string} line
 * @returns {{ domains: string[]|null, scriptlet: string, args: string[] }|null}
 */
function parseScriptletRule(line) {
  try {
    const markerIdx = line.indexOf('##+js(');
    if (markerIdx === -1) return null;

    const domainPart   = line.slice(0, markerIdx).trim();
    const scriptletPart = line.slice(markerIdx + 6); // after '##+js('
    const closingParen = scriptletPart.lastIndexOf(')');
    if (closingParen === -1) return null;

    const inner = scriptletPart.slice(0, closingParen).trim();
    if (!inner) return null;

    const parts      = inner.split(',').map(s => s.trim());
    const scriptletName = parts[0];
    const args       = parts.slice(1);

    if (!scriptletName) return null;

    const domains = domainPart
      ? domainPart.split(',').map(d => d.trim()).filter(Boolean)
      : null;

    return {
      domains: (domains && domains.length > 0) ? domains : null,
      scriptlet: scriptletName,
      args
    };
  } catch {
    return null;
  }
}

// ─── LIST PARSER ─────
/**
 * Parses a complete filter list text into categorized rule buckets.
 * @param {string} text
 * @returns {{ networkRules: Object[], cosmeticRules: Object[], scriptletRules: Object[], skipped: Object }}
 */
export function parseList(text) {
  const networkRules  = [];
  const cosmeticRules = [];
  const scriptletRules = [];
  const skipped = {
    comment:      0,
    extendedCss:  0,
    skipOption:   0,
    regex:        0,
    malformed:    0
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const type = classifyLine(line);

    switch (type) {
      case 'comment':
        skipped.comment++;
        break;

      case 'extended-css':
        skipped.extendedCss++;
        break;

      case 'network': {
        const rule = parseNetworkRule(line, false);
        if (rule) networkRules.push(rule);
        else skipped.malformed++;
        break;
      }

      case 'exception': {
        const rule = parseNetworkRule(line, true);
        if (rule) networkRules.push(rule);
        else skipped.malformed++;
        break;
      }

      case 'cosmetic': {
        const rule = parseCosmeticRule(line, false);
        if (rule) cosmeticRules.push(rule);
        else skipped.malformed++;
        break;
      }

      case 'cosmetic-exception': {
        const rule = parseCosmeticRule(line, true);
        if (rule) cosmeticRules.push(rule);
        else skipped.malformed++;
        break;
      }

      case 'scriptlet': {
        const rule = parseScriptletRule(line);
        if (rule) scriptletRules.push(rule);
        else skipped.malformed++;
        break;
      }
    }
  }

  return { networkRules, cosmeticRules, scriptletRules, skipped };
}
