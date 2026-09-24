import type { PricingChannel, ShippingMethod } from '@shared/enums';
import type {
  CouponValidationResult,
  LineBreakdown,
  PriceBreakdown,
  PriceRequest,
  PricingSimulation,
} from '@shared/types/pricing';

import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { cache } from '../../container';
import { AppError } from '../../utils/AppError';
import { PRICING_CACHE_PREFIXES } from '../catalog-admin/catalogCache.service';

import { discountService } from './discount.service';
import { PricingInvariantError, pricingEngine } from './pricing.engine';
import { pricingContextLoader, type LoadContextInput } from './pricingContext.loader';

/**
 * The thin service controllers talk to. It loads a context, runs the one engine and hands back a
 * PriceBreakdown — there is no other way to obtain a price in this codebase.
 */

export interface QuoteInput {
  items: {
    productId?: string;
    slug?: string;
    variantId?: string | null;
    optionValueIds?: string[];
    qty: number;
  }[];
  couponCode?: string;
  pincode?: string;
  channel?: PricingChannel;
  shippingMethod?: ShippingMethod;
  customerId?: string | null;
  customerGroupId?: string | null;
  now?: Date;
  /** See LoadContextInput.reachableOnly: set by the public quote endpoints. */
  reachableOnly?: boolean;
}

function toLoadInput(input: QuoteInput, now: Date): LoadContextInput {
  return {
    lines: input.items.map((item, index) => ({
      lineId: `L${index + 1}`,
      ...(item.productId ? { productId: item.productId } : {}),
      ...(item.slug ? { slug: item.slug } : {}),
      variantId: item.variantId ?? null,
      optionValueIds: item.optionValueIds ?? [],
      qty: item.qty,
    })),
    customerId: input.customerId ?? null,
    customerGroupId: input.customerGroupId ?? null,
    couponCode: input.couponCode ?? null,
    pincode: input.pincode ?? null,
    channel: input.channel ?? 'WEB',
    now,
    ...(input.reachableOnly ? { reachableOnly: true } : {}),
  };
}

function toRequest(input: QuoteInput, now: Date): PriceRequest {
  return {
    lines: input.items.map((item, index) => ({
      lineId: `L${index + 1}`,
      productId: item.productId ?? '',
      variantId: item.variantId ?? null,
      optionValueIds: item.optionValueIds ?? [],
      qty: item.qty,
    })),
    ...(input.couponCode ? { couponCode: input.couponCode } : {}),
    ...(input.pincode ? { pincode: input.pincode } : {}),
    channel: input.channel ?? 'WEB',
    ...(input.shippingMethod ? { shippingMethod: input.shippingMethod } : {}),
    now: now.toISOString(),
  };
}

function wrapInvariant<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof PricingInvariantError) {
      logger.error({ err: error, details: error.details }, 'pricing invariant violated');
      throw new AppError(
        500,
        error.code,
        'The price could not be calculated safely',
        error.details,
      );
    }
    throw error;
  }
}

export const pricingFacade = {
  /** One product, one quantity — the PDP call. */
  async quoteProduct(input: QuoteInput): Promise<PriceBreakdown> {
    return this.quoteCart(input);
  },

  async quoteCart(input: QuoteInput): Promise<PriceBreakdown> {
    const now = input.now ?? new Date();
    const context = await pricingContextLoader.load(toLoadInput(input, now));
    const request = toRequest(input, now);

    // The engine needs the resolved product ids, which only the context knows.
    request.lines = request.lines.map((line, index) => ({
      ...line,
      productId: context.lines[index]?.productId ?? line.productId,
    }));

    const { breakdown } = wrapInvariant(() =>
      pricingEngine.calculate(context, request, { engineVersion: env.PRICING_ENGINE_VERSION }),
    );

    return breakdown;
  },

  /**
   * Catalog pricing: every item priced as if it were bought on its own, from ONE context load.
   *
   * A grid, an option matrix or the listing index must not let one card's price depend on which
   * other cards share the request - through `quoteCart` every line would see `cartItemCount` equal
   * to the page size. The context is loaded once for all items (its per-line parts are filtered per
   * line already), then the pure engine runs once per line, so each result equals `quoteProduct`
   * for that item alone.
   */
  async quoteEach(input: QuoteInput): Promise<LineBreakdown[]> {
    if (input.items.length === 0) return [];

    const now = input.now ?? new Date();
    const context = await pricingContextLoader.load(toLoadInput(input, now));
    const request = toRequest(input, now);

    return context.lines.map((line, index) => {
      const requestLine = { ...request.lines[index]!, productId: line.productId };
      const { breakdown } = wrapInvariant(() =>
        pricingEngine.calculate(
          { ...context, lines: [line] },
          { ...request, lines: [requestLine] },
          { engineVersion: env.PRICING_ENGINE_VERSION },
        ),
      );
      return breakdown.lines[0]!;
    });
  },

  /** Cached by contextHash so a listing page asking for the same price repeatedly is cheap. */
  async quoteCached(input: QuoteInput): Promise<PriceBreakdown> {
    const breakdown = await this.quoteCart(input);
    const key = `${PRICING_CACHE_PREFIXES.quote}${breakdown.contextHash}`;

    const cached = await cache.get<PriceBreakdown>(key);
    if (cached) return cached;

    await cache.set(key, breakdown, env.PRICING_CACHE_TTL_SECONDS);
    return breakdown;
  },

  /** The admin simulator: the same calculation plus the full rule trace. */
  async simulate(input: QuoteInput & { includeTrace?: boolean }): Promise<PricingSimulation> {
    const now = input.now ?? new Date();
    const context = await pricingContextLoader.load({ ...toLoadInput(input, now), explain: true });
    const request = toRequest(input, now);

    request.lines = request.lines.map((line, index) => ({
      ...line,
      productId: context.lines[index]?.productId ?? line.productId,
    }));

    const { breakdown, trace } = wrapInvariant(() =>
      pricingEngine.calculate(context, request, {
        engineVersion: env.PRICING_ENGINE_VERSION,
        collectTrace: input.includeTrace ?? true,
      }),
    );

    return { breakdown, trace };
  },

  /**
   * Coupon eligibility against a real cart. Returns the discount it would give, or the specific
   * reason it cannot be used.
   */
  async validateCoupon(code: string, input: QuoteInput): Promise<CouponValidationResult> {
    const now = input.now ?? new Date();
    const coupon = await discountService.findCouponByCode(code);

    if (!coupon) {
      return {
        valid: false,
        code: code.toUpperCase(),
        rejectionCode: 'COUPON_NOT_FOUND',
        message: 'That coupon code does not exist',
      };
    }

    // Price the cart without the coupon first: eligibility depends on the discounted subtotal.
    const context = await pricingContextLoader.load({
      ...toLoadInput(input, now),
      couponCode: null,
    });
    const request = toRequest({ ...input, couponCode: undefined }, now);
    request.lines = request.lines.map((line, index) => ({
      ...line,
      productId: context.lines[index]?.productId ?? line.productId,
    }));

    const { breakdown } = wrapInvariant(() =>
      pricingEngine.calculate(context, request, { engineVersion: env.PRICING_ENGINE_VERSION }),
    );

    const pricingCoupon = discountService.toPricingCoupon(coupon);
    const eligibleLines = context.lines.filter((line) =>
      discountService.appliesToLine(pricingCoupon, line),
    );
    const eligibleIds = new Set(eligibleLines.map((line) => line.lineId));
    const eligibleSubtotalPaise = breakdown.lines
      .filter((line) => eligibleIds.has(line.lineId))
      .reduce((total, line) => total + line.subtotalPaise - line.discountPaise, 0);

    const netSubtotal = breakdown.lines.reduce(
      (total, line) => total + line.subtotalPaise - line.discountPaise,
      0,
    );

    return discountService.validate({
      coupon,
      customerId: context.customerId,
      customerGroupId: context.customerGroup?.id ?? null,
      isFirstOrder: context.isFirstOrder,
      eligibleSubtotalPaise,
      cartSubtotalPaise: netSubtotal,
      hasEligibleItems: eligibleLines.length > 0,
      hasNonStackableAutoDiscount: breakdown.lines.some((line) =>
        line.components.some((component) => component.kind === 'DISCOUNT'),
      ),
      now,
    });
  },
};
