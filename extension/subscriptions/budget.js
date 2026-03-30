/**
 * Chroma Ad-Blocker — Subscription Rule Budget Allocator
 * Enforces the DNR dynamic rule cap for subscription rules.
 * ID range 100000–8999999 is reserved for subscription rules.
 */

'use strict';

export const SUBSCRIPTION_ID_START = 100000;
export const SUBSCRIPTION_ID_END   = 8999999;

// Target cap: 25,000 — leaves ~5,000 buffer below DNR 30,000 dynamic limit
// after accounting for default dynamic rules (1001–1006) and whitelist (9,000,000+)
export const SUBSCRIPTION_RULE_CAP = 25000;

/**
 * Scores a parsed network rule for budget prioritization.
 * Higher score = higher priority = kept first when trimming.
 * @param {Object} rule - Parsed rule object (no id)
 * @returns {number}
 */
function scoreRule(rule) {
  // Exception (allow) rules are always kept — they prevent site breakage
  if (rule.action && rule.action.type === 'allow') return 10000;

  let score = 1; // Base score for any valid rule

  if (rule.priority === 3)                                              score += 100; // $important
  if (rule.condition.initiatorDomains || rule.condition.excludedInitiatorDomains) score += 20;  // domain= specificity
  if (rule.condition.resourceTypes && rule.condition.resourceTypes.length > 0)    score += 10;  // resource type
  if (rule.condition.domainType)                                        score += 5;  // third-party / first-party

  return score;
}

/**
 * Allocates an array of parsed network rules within the budget cap.
 * Sorts by score descending, returns the top N rules.
 * @param {Object[]} rules - Parsed network rule objects (no IDs)
 * @param {number} [cap=SUBSCRIPTION_RULE_CAP]
 * @returns {{ allocated: Object[], trimCount: number }}
 */
export function allocate(rules, cap = SUBSCRIPTION_RULE_CAP) {
  if (rules.length <= cap) {
    return { allocated: rules, trimCount: 0 };
  }

  const scored = rules.map(rule => ({ rule, score: scoreRule(rule) }));
  scored.sort((a, b) => b.score - a.score);

  return {
    allocated: scored.slice(0, cap).map(s => s.rule),
    trimCount: rules.length - cap
  };
}
