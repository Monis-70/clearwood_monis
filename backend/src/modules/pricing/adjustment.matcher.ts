import type { PricingAdjustment, PricingLineContext } from '@shared/types/pricing';

import { evaluateConditionGroup, type ConditionFacts } from './condition.evaluator';

/**
 * Which PriceAdjustment rows apply to a line, and in what order.
 *
 * Ordering is fully deterministic — priority, then scope specificity, then id — because two
 * identical requests must always produce byte-identical breakdowns (Prompt 9 replays them).
 */

/** GLOBAL is the least specific; CUSTOMIZATION the most. Ties are broken by id. */
const SCOPE_RANK: Record<string, number> = {
  GLOBAL: 0,
  CATEGORY: 1,
  PRODUCT: 2,
  VARIANT: 3,
  ATTRIBUTE_VALUE: 4,
  CUSTOMIZATION: 5,
};

export interface MatchInput {
  line: PricingLineContext;
  qty: number;
  now: Date;
  channel: string;
  customerGroupId: string | null;
  facts: ConditionFacts;
}

export interface MatchOutcome {
  adjustment: PricingAdjustment;
  matched: boolean;
  reason?: string;
}

function withinWindow(adjustment: PricingAdjustment, now: Date): boolean {
  const startsAt = adjustment.startsAt ? Date.parse(adjustment.startsAt) : null;
  const endsAt = adjustment.endsAt ? Date.parse(adjustment.endsAt) : null;
  const at = now.getTime();

  if (startsAt !== null && at < startsAt) return false;
  if (endsAt !== null && at > endsAt) return false;
  return true;
}

/** Explains the match as well as deciding it, so the admin simulator can show "why not". */
export function evaluateAdjustment(adjustment: PricingAdjustment, input: MatchInput): MatchOutcome {
  const { line, qty, now, channel, customerGroupId } = input;

  if (!withinWindow(adjustment, now)) {
    return { adjustment, matched: false, reason: 'outside its date window' };
  }
  if (adjustment.minQty !== null && qty < adjustment.minQty) {
    return { adjustment, matched: false, reason: `needs qty >= ${adjustment.minQty}` };
  }
  if (adjustment.maxQty !== null && qty > adjustment.maxQty) {
    return { adjustment, matched: false, reason: `needs qty <= ${adjustment.maxQty}` };
  }
  if (adjustment.channel !== 'ALL' && adjustment.channel !== channel) {
    return { adjustment, matched: false, reason: `applies to the ${adjustment.channel} channel` };
  }
  if (adjustment.customerGroupId && adjustment.customerGroupId !== customerGroupId) {
    return { adjustment, matched: false, reason: 'applies to a different customer group' };
  }

  switch (adjustment.scope) {
    case 'GLOBAL':
      break;

    case 'CATEGORY':
      // categoryIds already carries every ancestor, so a rule on "Sofas" reaches "Fabric Sofas".
      if (!adjustment.categoryId || !line.categoryIds.includes(adjustment.categoryId)) {
        return { adjustment, matched: false, reason: 'the product is not in that category' };
      }
      break;

    case 'PRODUCT':
      if (adjustment.productId !== line.productId) {
        return { adjustment, matched: false, reason: 'targets a different product' };
      }
      break;

    case 'VARIANT':
      if (!line.variantId || adjustment.variantId !== line.variantId) {
        return { adjustment, matched: false, reason: 'targets a different variant' };
      }
      break;

    case 'ATTRIBUTE_VALUE':
      if (
        !adjustment.attributeValueId ||
        !line.optionValueIds.includes(adjustment.attributeValueId)
      ) {
        return { adjustment, matched: false, reason: 'that option is not selected on this line' };
      }
      break;

    case 'CUSTOMIZATION':
      // Prompt 11 supplies configurator components directly; nothing matches here yet.
      return {
        adjustment,
        matched: false,
        reason: 'customisation rules are applied by the configurator',
      };

    default:
      return { adjustment, matched: false, reason: `unknown scope "${adjustment.scope}"` };
  }

  const conditions = evaluateConditionGroup(adjustment.conditions, input.facts);
  if (!conditions.matched) {
    return { adjustment, matched: false, reason: conditions.reason ?? 'conditions not met' };
  }

  return { adjustment, matched: true };
}

export function sortAdjustments(adjustments: PricingAdjustment[]): PricingAdjustment[] {
  return [...adjustments].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;

    const rankA = SCOPE_RANK[a.scope] ?? 99;
    const rankB = SCOPE_RANK[b.scope] ?? 99;
    if (rankA !== rankB) return rankA - rankB;

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Every candidate in application order, each flagged with whether it matched and why not. */
export function matchAdjustments(input: MatchInput): MatchOutcome[] {
  return sortAdjustments(input.line.adjustments).map((adjustment) =>
    evaluateAdjustment(adjustment, input),
  );
}

export { SCOPE_RANK };
