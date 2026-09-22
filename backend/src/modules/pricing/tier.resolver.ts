import type { PricingLineContext, PricingPriceListItem, PricingTier } from '@shared/types/pricing';
import { applyBasisPoints } from '@shared/money';

/**
 * Steps 2 and 3 of the calculation order.
 *
 * Precedence is fixed and deliberately narrow — no extra rules may be invented here:
 *   - PriceList selection happens FIRST and, when it matches, REPLACES the base unit price.
 *   - TierPrice resolution happens SECOND, against whatever base step 2 left behind.
 *   - Within the customer group, the highest applicable `minQty <= qty` wins.
 *   - Exactly one tier row applies. Tiers never stack.
 *   - A tier with `pricePaise` REPLACES the current base; a tier with `discountBp` takes that
 *     percentage OFF the current base and the result becomes the new unit price.
 */

export interface PriceListOutcome {
  item: PricingPriceListItem;
  pricePaise: number;
}

export interface TierOutcome {
  tier: PricingTier;
  /** The unit price after the tier has been applied. */
  pricePaise: number;
  /** Signed delta from the price the tier was applied to. */
  deltaPaise: number;
}

/**
 * The winning price-list item: highest list priority, then the most specific target
 * (variant beats product), then the highest qualifying minQty.
 */
export function resolvePriceList(line: PricingLineContext, qty: number): PriceListOutcome | null {
  const candidates = line.priceListItems.filter((item) => {
    if (item.minQty > qty) return false;
    if (item.variantId) return item.variantId === line.variantId;
    if (item.productId) return item.productId === line.productId;
    return false;
  });

  if (candidates.length === 0) return null;

  const winner = [...candidates].sort((a, b) => {
    if (a.priceListPriority !== b.priceListPriority) {
      return b.priceListPriority - a.priceListPriority;
    }
    const specificityA = a.variantId ? 1 : 0;
    const specificityB = b.variantId ? 1 : 0;
    if (specificityA !== specificityB) return specificityB - specificityA;
    if (a.minQty !== b.minQty) return b.minQty - a.minQty;
    return a.id < b.id ? -1 : 1;
  })[0]!;

  return { item: winner, pricePaise: winner.pricePaise };
}

/**
 * The winning tier for this quantity and customer group, applied to `basePaise`.
 * Returns null when no tier qualifies.
 */
export function resolveTier(
  line: PricingLineContext,
  qty: number,
  customerGroupId: string | null,
  basePaise: number,
): TierOutcome | null {
  const candidates = line.tiers.filter((tier) => {
    if (tier.minQty > qty) return false;

    // A tier belonging to another group never applies; a group-less tier applies to everyone.
    if (tier.customerGroupId && tier.customerGroupId !== customerGroupId) return false;

    if (tier.variantId) return tier.variantId === line.variantId;
    if (tier.productId) return tier.productId === line.productId;
    return false;
  });

  if (candidates.length === 0) return null;

  const winner = [...candidates].sort((a, b) => {
    if (a.minQty !== b.minQty) return b.minQty - a.minQty;

    // A tier aimed at this customer group beats the generic one at the same quantity break.
    const targetedA = a.customerGroupId ? 1 : 0;
    const targetedB = b.customerGroupId ? 1 : 0;
    if (targetedA !== targetedB) return targetedB - targetedA;

    const specificityA = a.variantId ? 1 : 0;
    const specificityB = b.variantId ? 1 : 0;
    if (specificityA !== specificityB) return specificityB - specificityA;

    return a.id < b.id ? -1 : 1;
  })[0]!;

  const pricePaise =
    winner.pricePaise !== null
      ? winner.pricePaise
      : Math.max(0, basePaise - applyBasisPoints(basePaise, winner.discountBp ?? 0));

  return { tier: winner, pricePaise, deltaPaise: pricePaise - basePaise };
}
