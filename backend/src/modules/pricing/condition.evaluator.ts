import type { RuleCondition, RuleConditionGroup } from '@shared/types/pricing';
import { isConditionField, isConditionOperator } from '@shared/enums';

/**
 * The price-rule condition evaluator.
 *
 * There is no `eval`, no `Function`, no expression parser and no dynamic property access by
 * arbitrary key. A condition may only name a field from the whitelist and an operator from the
 * whitelist; anything else evaluates to `false` and is reported as a reason. A rule stored by a
 * compromised admin account therefore cannot execute code — the worst it can do is not match.
 */

/** Every fact a condition is allowed to read. Populated by the engine, never by the caller. */
export interface ConditionFacts {
  qty: number;
  unitPricePaise: number;
  lineSubtotalPaise: number;
  cartSubtotalPaise: number;
  cartItemCount: number;
  productId: string;
  variantId: string | null;
  categoryId: string[];
  collectionId: string[];
  brandId: string | null;
  attributeValueId: string[];
  customerGroupCode: string | null;
  channel: string;
  pincode: string | null;
  isFirstOrder: boolean;
  /** 0 = Sunday, matching Date#getUTCDay. */
  weekday: number;
}

export interface EvaluationResult {
  matched: boolean;
  reason?: string;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function compare(actual: unknown, operator: string, expected: unknown): boolean {
  // Multi-valued facts (a product's categories) match if ANY of them satisfies the comparison.
  if (Array.isArray(actual)) {
    switch (operator) {
      case 'EQUALS':
      case 'IN':
        return actual.some((item) => asArray(expected).includes(item));
      case 'NOT_EQUALS':
      case 'NOT_IN':
        return !actual.some((item) => asArray(expected).includes(item));
      case 'CONTAINS':
        return actual.some((item) => typeof item === 'string' && item.includes(String(expected)));
      default:
        return false;
    }
  }

  switch (operator) {
    case 'EQUALS':
      return actual === expected;
    case 'NOT_EQUALS':
      return actual !== expected;
    case 'GREATER_THAN':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'GREATER_OR_EQUAL':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'LESS_THAN':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'LESS_OR_EQUAL':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'IN':
      return asArray(expected).includes(actual);
    case 'NOT_IN':
      return !asArray(expected).includes(actual);
    case 'CONTAINS':
      return typeof actual === 'string' && actual.includes(String(expected));
    default:
      return false;
  }
}

export function evaluateCondition(
  condition: RuleCondition,
  facts: ConditionFacts,
): EvaluationResult {
  if (!isConditionField(condition.field)) {
    return { matched: false, reason: `unknown field "${condition.field}"` };
  }
  if (!isConditionOperator(condition.operator)) {
    return { matched: false, reason: `unknown operator "${condition.operator}"` };
  }

  const actual = (facts as unknown as Record<string, unknown>)[condition.field];
  const matched = compare(actual, condition.operator, condition.value);

  return matched
    ? { matched: true }
    : {
        matched: false,
        reason: `${condition.field} ${condition.operator} ${JSON.stringify(condition.value)} is false`,
      };
}

/** A rule with no conditions always matches — that is what makes an unconditional rule possible. */
export function evaluateConditionGroup(
  group: RuleConditionGroup | null | undefined,
  facts: ConditionFacts,
): EvaluationResult {
  if (!group || group.conditions.length === 0) return { matched: true };

  const results = group.conditions.map((condition) => evaluateCondition(condition, facts));

  if (group.match === 'ANY') {
    const hit = results.some((result) => result.matched);
    return hit
      ? { matched: true }
      : { matched: false, reason: results.map((result) => result.reason).join(' and ') };
  }

  const failure = results.find((result) => !result.matched);
  return failure ? { matched: false, reason: failure.reason } : { matched: true };
}
