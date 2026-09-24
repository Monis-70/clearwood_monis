import { env } from '../../config/env';
import { logger } from '../../config/logger';
import {
  listingIndexRepository,
  type PriceRange,
  type PricingSubject,
} from '../../repositories/listingIndex.repository';
import { pricingFacade } from '../pricing/pricing.facade';

export type { PriceRange } from '../../repositories/listingIndex.repository';

/**
 * Maintains `ProductListingIndex`, the price the storefront filters and sorts on.
 *
 * PRICING BASIS (PROJECT_CONTEXT §44) - per product, the min and max `unitPricePaise` over its
 * active, non-deleted variants (the base price when it has none), each quoted by the pricing
 * facade as ONE unit bought on its own: channel WEB, no customer (so the DEFAULT customer group
 * and isFirstOrder=true), no coupon, no pincode, at the moment of the refresh. That is steps 1-7 of
 * the engine (base, price list, tier at qty 1, adjustments, group discount); line discount rules,
 * coupons, shipping and tax are not part of it. No pricing arithmetic lives here, so the index
 * agrees with `/pricing/quote` by construction. What a shopper SEES is quoted live for their own
 * context on every request; this number only decides membership in a price filter and order.
 *
 * Written by the catalog events (product, variant, pricing, import and bulk writes) and repaired
 * by listingReconciler.service, which re-prices what a price window, a lost event or a missed emit
 * left behind. A product with no row still lists, at its base price.
 */

/** Products per refresh transaction; their variants are priced from one context per chunk. */
const REFRESH_BATCH = 20;

/*
 * One refresh at a time per process: each holds a transaction connection while its quotes use
 * others, so a burst of events must queue here rather than take the whole pool.
 */
let queue: Promise<unknown> = Promise.resolve();
function serially<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

function isPriceable(product: { status: string; deletedAt: Date | null } | undefined): boolean {
  return product !== undefined && product.deletedAt === null && product.status === 'ACTIVE';
}

interface Target {
  productId: string;
  variantId: string | null;
}

/** One quote per line, one pricing context per chunk of lines (the facade's per-quote cap). */
async function quoteTargets(targets: Target[]): Promise<(number | null)[]> {
  const quote = (chunk: Target[]) =>
    pricingFacade.quoteEach({
      items: chunk.map((target) => ({ ...target, qty: 1 })),
      channel: 'WEB',
      customerId: null,
      customerGroupId: null,
    });

  const prices: (number | null)[] = [];
  for (let index = 0; index < targets.length; index += env.PRICING_MAX_QUOTE_ITEMS) {
    const chunk = targets.slice(index, index + env.PRICING_MAX_QUOTE_ITEMS);
    try {
      prices.push(...(await quote(chunk)).map((line) => line.unitPricePaise));
    } catch {
      // One unpriceable line must not blank its neighbours: price the chunk one line at a time.
      for (const target of chunk) {
        try {
          prices.push((await quote([target]))[0]?.unitPricePaise ?? null);
        } catch (error) {
          logger.warn({ err: error, ...target }, 'listing index skipped a variant');
          prices.push(null);
        }
      }
    }
  }
  return prices;
}

export const listingIndexService = {
  /** The index row of every product: min and max over its variants' default-audience prices. */
  async priceRanges(products: PricingSubject[]): Promise<Map<string, PriceRange>> {
    const targets = products.flatMap((product): Target[] =>
      product.variants.length > 0
        ? product.variants.map((variant) => ({ productId: product.id, variantId: variant.id }))
        : [{ productId: product.id, variantId: null }],
    );
    const prices = await quoteTargets(targets);

    const byProduct = new Map<string, number[]>(products.map((product) => [product.id, []]));
    targets.forEach((target, index) => {
      const price = prices[index];
      if (price !== null && price !== undefined) byProduct.get(target.productId)!.push(price);
    });

    return new Map(
      [...byProduct].map(([productId, resolved]) => [
        productId,
        resolved.length === 0
          ? { minPricePaise: null, maxPricePaise: null }
          : { minPricePaise: Math.min(...resolved), maxPricePaise: Math.max(...resolved) },
      ]),
    );
  },

  /** Recomputes one product's row, or removes it when the product can no longer be listed. */
  async refresh(productId: string): Promise<PriceRange | null> {
    return (await this.refreshMany([productId])).get(productId) ?? null;
  },

  /** Recomputes up to REFRESH_BATCH rows per transaction; unlistable products lose theirs. */
  refreshMany(productIds: string[]): Promise<Map<string, PriceRange | null>> {
    return serially(async () => {
      const result = new Map<string, PriceRange | null>();
      const unique = [...new Set(productIds)];
      for (let index = 0; index < unique.length; index += REFRESH_BATCH) {
        for (const [id, range] of await this.refreshBatch(
          unique.slice(index, index + REFRESH_BATCH),
        )) {
          result.set(id, range);
        }
      }
      return result;
    });
  },

  /** Not queued: callers that must bypass the per-process queue (tests of the row lock). */
  async refreshBatch(productIds: string[]): Promise<Map<string, PriceRange | null>> {
    const result = new Map<string, PriceRange | null>(productIds.map((id) => [id, null]));

    const before = new Map(
      (await listingIndexRepository.loadForPricing(productIds)).map((row) => [row.id, row]),
    );
    const candidates = productIds.filter((id) => isPriceable(before.get(id)));
    await listingIndexRepository.remove(productIds.filter((id) => !candidates.includes(id)));
    if (candidates.length === 0) return result;

    await listingIndexRepository.ensureRows(candidates);

    return listingIndexRepository.withRowLocks(candidates, async (tx) => {
      // Re-read under the locks: whatever committed before they were taken is priced here.
      const current = await listingIndexRepository.loadForPricing(candidates);
      const live = current.filter((row) => isPriceable(row));
      const liveIds = new Set(live.map((row) => row.id));
      await listingIndexRepository.remove(
        candidates.filter((id) => !liveIds.has(id)),
        tx,
      );

      const computedAt = new Date();
      const ranges = await this.priceRanges(live);
      await listingIndexRepository.writeMany(tx, ranges, computedAt);
      await listingIndexRepository.writeAttributes(tx, [...liveIds]);

      for (const [id, range] of ranges) result.set(id, range);
      return result;
    });
  },

  async remove(productId: string): Promise<void> {
    await listingIndexRepository.remove([productId]);
  },

  read(productIds: string[]): Promise<Map<string, PriceRange>> {
    return listingIndexRepository.findByProductIds(productIds);
  },

  /** Every ACTIVE product, in id order, then drops rows nothing can list any more. */
  async rebuildAll(
    onBatch?: () => Promise<void>,
  ): Promise<{ processed: number; failed: number; removed: number }> {
    let processed = 0;
    let failed = 0;
    let afterId: string | null = null;

    for (;;) {
      const ids: string[] = await listingIndexRepository.listPriceableIds(afterId, 200);
      if (ids.length === 0) break;

      for (let index = 0; index < ids.length; index += REFRESH_BATCH) {
        const batch = ids.slice(index, index + REFRESH_BATCH);
        try {
          await this.refreshMany(batch);
        } catch (error) {
          failed += batch.length;
          logger.warn({ err: error, productIds: batch }, 'listing index refresh failed');
        }
        processed += batch.length;
      }
      afterId = ids[ids.length - 1]!;
      if (onBatch) await onBatch();
    }

    const removed = await listingIndexRepository.pruneUnpriceable();
    return { processed, failed, removed };
  },
};
