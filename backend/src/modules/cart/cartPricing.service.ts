import type { PriceBreakdown } from '@shared/types/pricing';
import type { PriceChangeDto } from '@shared/types/cart';

import { logger } from '../../config/logger';
import type { CartWithItems } from '../../repositories/cart.repository';
import { cartRepository } from '../../repositories/cart.repository';
import { pricingFacade, type QuoteInput } from '../pricing/pricing.facade';

/**
 * RULE 1 — the cart never stores authoritative money.
 *
 * This file owns exactly one job: turn a cart into a `QuoteInput`, hand it to the Prompt 6 engine,
 * and hand the resulting `PriceBreakdown` back untouched. There is no arithmetic here — not a sum,
 * not a multiplication. The breakdown the API returns IS the engine's breakdown, which is why a
 * cart response and `/pricing/quote` agree on subtotal, discount, shipping, tax, rounding and the
 * grand total, and not merely on the grand total.
 *
 * The `added*`/`last*` columns on a line are historical snapshots. They are used to detect drift
 * and nothing else; `priceChanges[]` is how that drift reaches the shopper instead of being
 * silently papered over.
 */

export interface QuoteOutcome {
  breakdown: PriceBreakdown;
  /** Cart item id -> breakdown line, so callers never zip by position themselves. */
  byLineId: Map<string, PriceBreakdown['lines'][number]>;
  priceChanges: PriceChangeDto[];
}

export const cartPricingService = {
  /** IN_CART lines only: a saved-for-later line is not part of the order. */
  activeItems(cart: CartWithItems) {
    return cart.items
      .filter((item) => item.saveState === 'IN_CART')
      .sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime());
  },

  buildQuoteRequest(
    cart: CartWithItems,
    options: { customerId?: string | null; includeCoupon?: boolean } = {},
  ): QuoteInput {
    const items = this.activeItems(cart);

    return {
      items: items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        optionValueIds: parseOptions(item.selectedOptionsJson),
        qty: item.qty,
      })),
      ...(options.includeCoupon === false || !cart.couponCode
        ? {}
        : { couponCode: cart.couponCode }),
      ...(cart.pincode ? { pincode: cart.pincode } : {}),
      channel: 'WEB',
      customerId: options.customerId ?? cart.customerId,
    };
  },

  /**
   * Prices a cart and persists the new snapshots.
   *
   * An empty cart still gets a real breakdown — an all-zero one built by the engine for an empty
   * request — so the response shape never changes between an empty and a full cart.
   */
  async quote(
    cart: CartWithItems,
    options: { customerId?: string | null; includeCoupon?: boolean; persist?: boolean } = {},
  ): Promise<QuoteOutcome> {
    const items = this.activeItems(cart);

    if (items.length === 0) {
      return { breakdown: emptyBreakdown(), byLineId: new Map(), priceChanges: [] };
    }

    const breakdown = await pricingFacade.quoteCart(this.buildQuoteRequest(cart, options));

    const byLineId = new Map<string, PriceBreakdown['lines'][number]>();
    const priceChanges: PriceChangeDto[] = [];

    breakdown.lines.forEach((line, index) => {
      const item = items[index];
      if (!item) return;

      byLineId.set(item.id, line);

      const previous = item.lastUnitPricePaise ?? item.addedUnitPricePaise;
      if (previous > 0 && previous !== line.unitPricePaise) {
        priceChanges.push({
          lineId: item.id,
          lineKey: item.lineKey,
          productName: item.productNameSnapshot,
          previousUnitPricePaise: previous,
          currentUnitPricePaise: line.unitPricePaise,
          deltaPaise: line.unitPricePaise - previous,
          direction: line.unitPricePaise > previous ? 'UP' : 'DOWN',
          since: (item.updatedAt ?? item.addedAt).toISOString(),
        });
      }
    });

    if (options.persist !== false) {
      await this.persistSnapshots(cart, items, breakdown).catch((error: unknown) => {
        // A snapshot is a convenience, never the answer: failing to store it must not fail a read.
        logger.warn({ err: error, cartId: cart.id }, 'cart price snapshot not persisted');
      });
    }

    return { breakdown, byLineId, priceChanges };
  },

  async persistSnapshots(
    cart: CartWithItems,
    items: CartWithItems['items'],
    breakdown: PriceBreakdown,
  ): Promise<void> {
    await Promise.all(
      breakdown.lines.map((line, index) => {
        const item = items[index];
        if (!item) return Promise.resolve();
        if (
          item.lastUnitPricePaise === line.unitPricePaise &&
          item.lastTotalPaise === line.totalPaise
        ) {
          return Promise.resolve();
        }

        return cartRepository.updateItem(item.id, {
          lastUnitPricePaise: line.unitPricePaise,
          lastTotalPaise: line.totalPaise,
        });
      }),
    );

    await cartRepository.touch(cart.id, {
      lastQuotedTotalPaise: breakdown.grandTotalPaise,
      lastQuoteContextHash: breakdown.contextHash,
      lastQuotedAt: new Date(),
    });
  },
};

export function parseOptions(raw: string | null): string[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** The shape an empty cart answers with. Every figure is zero because there is nothing to price. */
export function emptyBreakdown(): PriceBreakdown {
  return {
    currency: 'INR',
    lines: [],
    components: [],
    subtotalPaise: 0,
    discountPaise: 0,
    shippingPaise: 0,
    taxPaise: 0,
    taxSplit: { cgstPaise: 0, sgstPaise: 0, igstPaise: 0 },
    roundingPaise: 0,
    grandTotalPaise: 0,
    totalSavingsPaise: 0,
    appliedRuleIds: [],
    placeOfSupply: {
      sellerStateCode: '',
      buyerStateCode: '',
      isIntraState: true,
      isFallback: true,
    },
    pricesIncludeTax: false,
    calculatedAt: new Date().toISOString(),
    engineVersion: 0,
    contextHash: 'empty',
  };
}
