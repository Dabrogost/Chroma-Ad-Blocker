/**
 * Chroma Ad-Blocker — Filter List Parser
 * Stateless pure functions. No chrome APIs. Directly unit-testable.
 * Handles ABP/uBlock filter syntax for network, cosmetic, and scriptlet rules.
 * Known limitations (counted, not silently dropped):
 *   - Regex network rules (/pattern/)
 *   - Procedural cosmetic filters (#?#)
 *   - Any network modifier not explicitly represented by DNR output below
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

// Network options are a trust boundary. Only options whose semantics are
// represented below may survive parsing; ignoring an unknown option could turn a
// constrained block or exception into a much broader DNR rule.
const SUPPORTED_NETWORK_OPTIONS = new Set([
  ...Object.keys(RESOURCE_TYPE_MAP),
  'important',
  'third-party', '3p',
  'first-party', '1p',
  '~third-party', '~3p',
  '~first-party', '~1p',
  'domain'
]);

const DEFAULT_PARSE_BUDGET = Object.freeze({
  maxLines: 250000,
  maxLineLength: 32768,
  maxNetworkRules: 200000,
  maxCosmeticRules: 200000,
  maxScriptletRules: 50000
});
const MAX_DNR_FILTER_BYTES = 2048;

function parseBudget(overrides = {}) {
  return { ...DEFAULT_PARSE_BUDGET, ...overrides };
}

function assertWithinBudget(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeFilterDomain(raw) {
  if (typeof raw !== 'string') return null;
  const domain = raw.trim().toLowerCase();
  if (
    domain.length === 0 ||
    domain.length > 253 ||
    !domain.includes('.') ||
    domain.startsWith('.') ||
    domain.endsWith('.') ||
    !/^[a-z0-9.-]+$/.test(domain)
  ) {
    return null;
  }

  const labels = domain.split('.');
  if (labels.some(label => (
    label.length === 0 ||
    label.length > 63 ||
    label.startsWith('-') ||
    label.endsWith('-')
  ))) {
    return null;
  }

  // Numeric dotted hosts must be valid IPv4 rather than merely passing the DNS
  // label grammar (for example, 999.1.1.1).
  if (/^[0-9.]+$/.test(domain)) {
    if (labels.length !== 4 || labels.some(label => !/^\d{1,3}$/.test(label) || Number(label) > 255)) {
      return null;
    }
  }

  return domain;
}

function parseDomainList(domainPart, separator) {
  const include = [];
  const exclude = [];
  const seenInclude = new Set();
  const seenExclude = new Set();

  for (const rawEntry of domainPart.split(separator)) {
    const entry = rawEntry.trim();
    if (!entry) return null;

    const negated = entry.startsWith('~');
    const domain = normalizeFilterDomain(negated ? entry.slice(1) : entry);
    if (!domain) return null;

    const target = negated ? exclude : include;
    const seen = negated ? seenExclude : seenInclude;
    if (!seen.has(domain)) {
      seen.add(domain);
      target.push(domain);
    }
  }

  return { include, exclude };
}

// ─── LINE CLASSIFIER ─────
/**
 * Classifies a single filter list line into a rule type.
 * @param {string} line
 * @returns {'comment'|'network'|'exception'|'cosmetic'|'cosmetic-exception'|'scriptlet'|'extended-css'}
 */
function classifyLine(line) {
  if (!line || line.startsWith('!') || line.startsWith('[')) return 'comment';
  if (line.includes('##+js(')) return 'scriptlet';
  if (line.startsWith('@@')) return 'exception';
  if (line.includes('#@#')) return 'cosmetic-exception';
  if (line.includes('#?#')) return 'extended-css'; // Procedural — not supported
  if (line.includes('##')) return 'cosmetic';
  if (line.startsWith('#')) return 'comment';
  return 'network';
}

// ─── OPTIONS PARSER ─────
/**
 * Parses the options string from a network rule into structured modifiers.
 * @param {string} optionsStr
 * @returns {{
 *   resourceTypes: string[]|null,
 *   domainType: string|null,
 *   initiatorDomains: string[]|null,
 *   excludedInitiatorDomains: string[]|null,
 *   isImportant: boolean,
 *   hasSkipOption: boolean,
 *   malformed: boolean
 * }}
 */
function parseOptions(optionsStr) {
  const result = {
    resourceTypes: null,
    domainType: null,
    initiatorDomains: null,
    excludedInitiatorDomains: null,
    isImportant: false,
    hasSkipOption: false,
    malformed: false
  };

  if (!optionsStr) return result;

  let sawPartyConstraint = false;
  let sawDomainConstraint = false;

  for (const opt of optionsStr.split(',')) {
    const trimmed = opt.trim();
    if (!trimmed) {
      result.malformed = true;
      return result;
    }

    const equalsIdx = trimmed.indexOf('=');
    const rawName = equalsIdx === -1 ? trimmed : trimmed.slice(0, equalsIdx);
    const optionName = rawName.toLowerCase();
    if (!SUPPORTED_NETWORK_OPTIONS.has(optionName)) {
      result.hasSkipOption = true;
      return result;
    }

    if (optionName === 'important' && equalsIdx === -1) {
      result.isImportant = true;
      continue;
    }

    if (equalsIdx === -1 && (
      optionName === 'third-party' || optionName === '3p' ||
      optionName === 'first-party' || optionName === '1p' ||
      optionName === '~third-party' || optionName === '~3p' ||
      optionName === '~first-party' || optionName === '~1p'
    )) {
      const nextDomainType = (
        optionName === 'third-party' || optionName === '3p' ||
        optionName === '~first-party' || optionName === '~1p'
      ) ? 'thirdParty' : 'firstParty';
      if (sawPartyConstraint && result.domainType !== nextDomainType) {
        result.malformed = true;
        return result;
      }
      sawPartyConstraint = true;
      result.domainType = nextDomainType;
      continue;
    }

    if (optionName === 'domain' && equalsIdx !== -1) {
      if (sawDomainConstraint) {
        result.malformed = true;
        return result;
      }
      sawDomainConstraint = true;
      const parsedDomains = parseDomainList(trimmed.slice(equalsIdx + 1), '|');
      if (!parsedDomains) {
        result.malformed = true;
        return result;
      }
      const { include, exclude } = parsedDomains;
      if (include.length > 0) result.initiatorDomains = include;
      if (exclude.length > 0) result.excludedInitiatorDomains = exclude;
      continue;
    }

    // Negated resource types and supported option names with unexpected values
    // have no representation in the DNR rule built here.
    if (optionName.startsWith('~') || equalsIdx !== -1) {
      result.hasSkipOption = true;
      return result;
    }

    const mappedType = RESOURCE_TYPE_MAP[optionName];
    if (mappedType) {
      if (!result.resourceTypes) result.resourceTypes = [];
      if (!result.resourceTypes.includes(mappedType)) result.resourceTypes.push(mappedType);
      continue;
    }

    // Every supported branch must be handled explicitly above.
    result.hasSkipOption = true;
    return result;
  }

  return result;
}

function networkParseResult(rule, skipReason = null) {
  return { rule, skipReason };
}

function utf8ByteLength(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function escapeRegexChar(ch) {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}

function translatePatternTailToRegex(tail) {
  let out = '';
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i];
    if (ch === '*') {
      out += '.*';
    } else if (ch === '^') {
      out += '(?:[^A-Za-z0-9_.%-]|$)';
    } else if (ch === '|' && i === tail.length - 1) {
      out += '$';
    } else if (ch === '|') {
      return null;
    } else {
      out += escapeRegexChar(ch);
    }
  }
  return out;
}

function translateDomainAnchorWildcardPattern(pattern) {
  if (!pattern.startsWith('||')) return { matched: false };

  const body = pattern.slice(2);
  const boundary = body.search(/[/?#^]/);
  const hostPart = boundary === -1 ? body : body.slice(0, boundary);
  const tail = boundary === -1 ? '' : body.slice(boundary);
  if (!hostPart.includes('*')) return { matched: false };

  if (
    !/^[A-Za-z0-9][A-Za-z0-9.*-]*$/.test(hostPart) ||
    !hostPart.replace(/\*/g, '').includes('.') ||
    /[\s\x00-\x1f\x7f]/.test(tail)
  ) {
    return { matched: true, regexFilter: null };
  }

  let hostRegex = '';
  for (const ch of hostPart) {
    hostRegex += ch === '*' ? '[^/?#:]*' : escapeRegexChar(ch);
  }

  const tailRegex = translatePatternTailToRegex(tail);
  if (tailRegex === null) return { matched: true, regexFilter: null };

  const regexFilter = `^https?://(?:[^/?#:]+\\.)*${hostRegex}${tailRegex}`;
  if (utf8ByteLength(regexFilter) > MAX_DNR_FILTER_BYTES) {
    return { matched: true, regexFilter: null };
  }

  try {
    new RegExp(regexFilter);
  } catch {
    return { matched: true, regexFilter: null };
  }

  return { matched: true, regexFilter };
}

function isLikelyDnrUrlFilter(pattern) {
  if (
    typeof pattern !== 'string' ||
    pattern.length === 0 ||
    utf8ByteLength(pattern) > MAX_DNR_FILTER_BYTES ||
    /[\s\x00-\x1f\x7f]/.test(pattern)
  ) {
    return false;
  }

  if (pattern.startsWith('||')) {
    const body = pattern.slice(2);
    const boundary = body.search(/[/?#^]/);
    const hostPart = boundary === -1 ? body : body.slice(0, boundary);
    if (!hostPart || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(hostPart)) return false;
  }

  const bodyStart = pattern.startsWith('||') ? 2 : 0;
  for (let i = bodyStart; i < pattern.length; i++) {
    if (pattern[i] === '|' && i !== pattern.length - 1) return false;
  }

  return true;
}

function compileNetworkPattern(pattern) {
  const translated = translateDomainAnchorWildcardPattern(pattern);
  if (translated.matched) {
    return translated.regexFilter
      ? { condition: { regexFilter: translated.regexFilter } }
      : null;
  }

  if (!isLikelyDnrUrlFilter(pattern)) return null;
  return { condition: { urlFilter: pattern } };
}

// ─── NETWORK RULE PARSER ─────
/**
 * Parses a network or exception rule line into a partial DNR rule object (no id assigned).
 * @param {string} line
 * @param {boolean} [isException=false]
 * @returns {{ rule: Object|null, skipReason: string|null }}
 */
function parseNetworkRule(line, isException = false) {
  try {
    const stripped = isException ? line.slice(2) : line;

    if (!stripped) return networkParseResult(null);

    // Pure wildcards — useless rules
    if (stripped === '*' || stripped === '*$*') return networkParseResult(null);

    // Regex network rules are not supported by this parser.
    if (stripped.startsWith('/') && stripped.slice(1).lastIndexOf('/') > 0) return networkParseResult(null, 'regex');

    // Split pattern from options on first '$'
    const dollarIdx = stripped.indexOf('$');
    const pattern    = dollarIdx === -1 ? stripped : stripped.slice(0, dollarIdx);
    const optionsStr = dollarIdx === -1 ? ''        : stripped.slice(dollarIdx + 1);

    if (!pattern) return networkParseResult(null);
    if (dollarIdx !== -1 && !optionsStr.trim()) return networkParseResult(null);

    const opts = parseOptions(optionsStr);
    if (opts.malformed) return networkParseResult(null);
    if (opts.hasSkipOption) return networkParseResult(null, 'skipOption');

    const compiled = compileNetworkPattern(pattern);
    if (!compiled) return networkParseResult(null, 'unsupportedUrlFilter');

    const condition = { ...compiled.condition };
    if (opts.resourceTypes)              condition.resourceTypes              = opts.resourceTypes;
    if (opts.domainType)                 condition.domainType                 = opts.domainType;
    if (opts.initiatorDomains)           condition.initiatorDomains           = opts.initiatorDomains;
    if (opts.excludedInitiatorDomains)   condition.excludedInitiatorDomains   = opts.excludedInitiatorDomains;

    // Priority:
    //   1 = standard block
    //   2 = exception (allow)
    //   3 = $important block
    // Whitelist rules remain at 999999 in background DNR state.
    const priority = isException ? 2 : (opts.isImportant ? 3 : 1);

    return networkParseResult({
      priority,
      action: { type: isException ? 'allow' : 'block' },
      condition
    });
  } catch {
    return networkParseResult(null);
  }
}

// ─── COSMETIC RULE PARSER ─────
/**
 * Parses a cosmetic rule line.
 * @param {string} line
 * @param {boolean} [isException=false]
 * @returns {{ domains: string[]|null, excludedDomains: string[]|null, selector: string, isException: boolean }|null}
 */
function parseCosmeticRule(line, isException = false) {
  try {
    const sep = isException ? '#@#' : '##';
    const idx = line.indexOf(sep);
    if (idx === -1) return null;

    const domainPart = line.slice(0, idx).trim();
    const selector   = line.slice(idx + sep.length).trim();

    if (!selector) return null;

    // Extended/procedural CSS is not supported.
    if (selector.startsWith(':-abp-') || selector.includes(':xpath(') ||
        selector.includes(':-abp-has(') || selector.includes(':upward(') ||
        selector.includes(':nth-ancestor(') || selector.includes(':style(') ||
        selector.includes(':remove(') || selector.includes(':has-text(') ||
        selector.includes(':matches-css(') || selector.includes(':matches-path(') ||
        selector.includes(':min-text-length(') || selector.includes(':others(') ||
        selector.includes(':watch-attr(')) return null;

    const parsedDomains = domainPart ? parseDomainList(domainPart, ',') : { include: [], exclude: [] };
    if (!parsedDomains) return null;

    return {
      domains: parsedDomains.include.length > 0 ? parsedDomains.include : null,
      excludedDomains: parsedDomains.exclude.length > 0 ? parsedDomains.exclude : null,
      selector,
      isException
    };
  } catch {
    return null;
  }
}

// ─── SCRIPTLET RULE PARSER ─────
/**
 * Translates uBO network syntax into standard JS RegExp strings.
 * @param {string} pattern
 * @returns {string}
 */
function translateScriptletRegex(pattern) {
  if (!pattern) return pattern;
  if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) return pattern;

  const regexStr = pattern
    .replace(/[.+?${}()|[\]\\]/g, '\\$&') // Escape regex special chars
    .replace(/\\\*/g, '.*')               // Wildcards *
    .replace(/^\\\|\\\|/, '^(?:https?:\\/\\/)?(?:[a-z0-9-]+\\.)*') // || prefix
    .replace(/\\\^/g, '(?:[:/?]|$)') // ^ separator
    .replace(/^\\\|/, '^') // | exact start
    .replace(/\\\|$/, '$'); // | exact end

  return `/${regexStr}/`;
}

const SCRIPTLET_TRANSLATABLE_PATTERN_ARGS = new Set([
  'no-setTimeout-if',
  'nostif',
  'prevent-setTimeout',
  'no-setInterval-if',
  'nosiif',
  'prevent-fetch',
  'no-fetch-if',
  'prevent-xhr',
  'no-xhr-if',
  'no-eval-if'
]);

const SCRIPTLET_REGEX_ARG_INDEXES = new Map([
  ['no-setTimeout-if', [0]],
  ['nostif', [0]],
  ['prevent-setTimeout', [0]],
  ['no-setInterval-if', [0]],
  ['nosiif', [0]],
  ['prevent-fetch', [0]],
  ['no-fetch-if', [0]],
  ['prevent-xhr', [0]],
  ['no-xhr-if', [0]],
  ['remove-node-text', [1]],
  ['rmnt', [1]],
  ['prevent-addEventListener', [0, 1]],
  ['aeld', [0, 1]],
  ['no-addEventListener-if', [0, 1]],
  ['replace-node-text', [1]],
  ['rpnt', [1]],
  ['prevent-requestAnimationFrame', [0]],
  ['no-raf-if', [0]],
  ['norafif', [0]],
  ['abort-current-script', [1]],
  ['acs', [1]],
  ['abort-current-inline-script', [1]],
  ['acis', [1]],
  ['prevent-element-src-loading', [1]],
  ['m3u-prune', [0, 1]],
  ['cookie-remover', [0]],
  ['cookie-remover.js', [0]],
  ['remove-cookie', [0]],
  ['prevent-window-open', [0]],
  ['nowoif', [0]],
  ['no-window-open-if', [0]],
  ['no-eval-if', [0]]
]);

function isRegexLiteral(arg) {
  return typeof arg === 'string' && arg.startsWith('/') && arg.lastIndexOf('/') > 0;
}

function isSafeRegexLiteral(arg) {
  const lastSlash = arg.lastIndexOf('/');
  const pattern = arg.slice(1, lastSlash);
  const flags = arg.slice(lastSlash + 1);
  if (!/^[dgimsuvy]*$/.test(flags)) return false;
  try {
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}

function hasSafeScriptletRegexArgs(scriptletName, args) {
  const indexes = SCRIPTLET_REGEX_ARG_INDEXES.get(scriptletName);
  if (!indexes) return true;
  for (const index of indexes) {
    const arg = args[index];
    if (isRegexLiteral(arg) && !isSafeRegexLiteral(arg)) return false;
  }
  return true;
}

function splitScriptletArgs(inner) {
  const out = [];
  let current = '';
  let quote = null;
  let escape = false;
  let inRegex = false;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === '\\') {
      current += ch;
      escape = true;
      continue;
    }

    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (inRegex) {
      current += ch;
      if (ch === '/') inRegex = false;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === '/' && current.trim() === '') {
      inRegex = true;
      current += ch;
      continue;
    }

    if (ch === ',') {
      out.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  out.push(current.trim());
  return out;
}

function unquoteScriptletArg(arg) {
  if (arg.length < 2) return arg;
  const first = arg[0];
  const last = arg[arg.length - 1];
  if ((first !== '"' && first !== "'") || first !== last) return arg;
  return arg.slice(1, -1).replace(new RegExp(`\\\\${first}`, 'g'), first);
}

/**
 * Parses a scriptlet rule line. The scriptlet engine treats the result as data.
 * @param {string} line
 * @returns {{ domains: string[]|null, excludedDomains: string[]|null, scriptlet: string, args: string[], runAt: string }|null}
 */
export function parseScriptletRule(line) {
  try {
    const markerIdx = line.indexOf('##+js(');
    if (markerIdx === -1) return null;

    const domainPart   = line.slice(0, markerIdx).trim();
    const scriptletPart = line.slice(markerIdx + 6); // after '##+js('
    const closingParen = scriptletPart.lastIndexOf(')');
    if (closingParen === -1) return null;

    const inner = scriptletPart.slice(0, closingParen).trim();
    if (!inner) return null;

    const parts      = splitScriptletArgs(inner).map(unquoteScriptletArg);
    const scriptletName = parts[0];
    const args       = parts.slice(1);

    if (!scriptletName) return null;

    let runAt = 'document_start';
    if (args.length > 0) {
      const last = args[args.length - 1];
      if (last.includes('runAt=idle') || last.includes('run-at: document_idle') || last.includes('run-at=document_idle')) {
        runAt = 'document_idle';
        args.pop();
      } else if (last.includes('runAt=start') || last.includes('run-at: document_start') || last.includes('run-at=document_start')) {
        runAt = 'document_start';
        args.pop();
      } else if (last.includes('runAt=end') || last.includes('run-at: document_end') || last.includes('run-at=document_end')) {
        runAt = 'document_end';
        args.pop();
      }
    }

    if (SCRIPTLET_TRANSLATABLE_PATTERN_ARGS.has(scriptletName) && args.length > 0) {
      if (args[0].includes('||') || args[0].includes('^') || args[0].includes('*')) {
        args[0] = translateScriptletRegex(args[0]);
      }
    }
    if (!hasSafeScriptletRegexArgs(scriptletName, args)) return null;

    const parsedDomains = domainPart ? parseDomainList(domainPart, ',') : { include: [], exclude: [] };
    if (!parsedDomains) return null;

    return {
      domains: parsedDomains.include.length > 0 ? parsedDomains.include : null,
      excludedDomains: parsedDomains.exclude.length > 0 ? parsedDomains.exclude : null,
      scriptlet: scriptletName,
      args,
      runAt
    };
  } catch {
    return null;
  }
}

// ─── LIST PARSER ─────
/**
 * Parses a complete filter list text into categorized rule buckets.
 * @param {string} text
 * @param {Object} [budgetOverrides]
 * @returns {{ networkRules: Object[], cosmeticRules: Object[], scriptletRules: Object[], skipped: Object, stats: Object }}
 */
export function parseList(text, budgetOverrides = {}) {
  const budget = parseBudget(budgetOverrides);
  const networkRules  = [];
  const cosmeticRules = [];
  const scriptletRules = [];
  const stats = {
    translatedRegexFilter: 0
  };
  const skipped = {
    comment:      0,
    extendedCss:  0,
    skipOption:   0,
    regex:        0,
    unsupportedUrlFilter: 0,
    malformed:    0,
    overlong:     0,
    networkLimit: 0,
    cosmeticLimit: 0,
    scriptletLimit: 0
  };

  const addNetworkRule = (rule) => {
    if (networkRules.length < budget.maxNetworkRules) {
      networkRules.push(rule);
      if (rule?.condition?.regexFilter) stats.translatedRegexFilter++;
    } else {
      skipped.networkLimit++;
    }
  };

  let lineCount = 0;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\n' && i !== text.length - 1) continue;

    lineCount++;
    assertWithinBudget(lineCount <= budget.maxLines, `Subscription list has too many lines; limit is ${budget.maxLines}`);

    const lineEnd = text[i] === '\n' ? i : i + 1;
    const rawLine = text.slice(start, lineEnd);
    start = i + 1;
    if (rawLine.length > budget.maxLineLength) {
      skipped.overlong++;
      continue;
    }

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
        const { rule, skipReason } = parseNetworkRule(line, false);
        if (rule) addNetworkRule(rule);
        else if (skipReason && Object.prototype.hasOwnProperty.call(skipped, skipReason)) skipped[skipReason]++;
        else skipped.malformed++;
        break;
      }

      case 'exception': {
        const { rule, skipReason } = parseNetworkRule(line, true);
        if (rule) addNetworkRule(rule);
        else if (skipReason && Object.prototype.hasOwnProperty.call(skipped, skipReason)) skipped[skipReason]++;
        else skipped.malformed++;
        break;
      }

      case 'cosmetic': {
        const rule = parseCosmeticRule(line, false);
        if (rule) {
          if (cosmeticRules.length < budget.maxCosmeticRules) cosmeticRules.push(rule);
          else skipped.cosmeticLimit++;
        }
        else skipped.malformed++;
        break;
      }

      case 'cosmetic-exception': {
        const rule = parseCosmeticRule(line, true);
        if (rule) {
          if (cosmeticRules.length < budget.maxCosmeticRules) cosmeticRules.push(rule);
          else skipped.cosmeticLimit++;
        }
        else skipped.malformed++;
        break;
      }

      case 'scriptlet': {
        const rule = parseScriptletRule(line);
        if (rule) {
          if (scriptletRules.length < budget.maxScriptletRules) scriptletRules.push(rule);
          else skipped.scriptletLimit++;
        }
        else skipped.malformed++;
        break;
      }
    }
  }

  return { networkRules, cosmeticRules, scriptletRules, skipped, stats };
}
