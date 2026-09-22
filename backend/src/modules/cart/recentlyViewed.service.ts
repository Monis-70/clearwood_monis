import type { RecentlyViewedDto } from '@shared/types/cart';

import { env } from '../../config/env';
import { recentlyViewedRepository } from '../../repositories/cart.repository';
import { storefrontRepository } from '../../repositories/storefront.repository';
import { toProductCard } from '../storefront/card.mapper';
import { productQueryService } from '../storefront/productQuery.service';

import type { CartOwner } from './cartIdentity';

/**
 * Recently viewed. Deduped per owner with a bumped `viewCount`, capped at `RECENTLY_VIEWED_MAX`,
 * and hydrated through Prompt 7's card mapper so a strip here renders identically to a grid.
 */

export const recentlyViewedService = {
  async record(owner: CartOwner, productId: string, variantId: string | null): Promise<void> {
    if (!owner.customerId && !owner.sessionId) return;

    await recentlyViewedRepository.record(owner, productId, variantId);
    await recentlyViewedRepository.trim(owner, env.RECENTLY_VIEWED_MAX);
  },

  async list(owner: CartOwner, limit?: number): Promise<RecentlyViewedDto[]> {
    if (!owner.customerId && !owner.sessionId) return [];

    const rows = await recentlyViewedRepository.findForOwner(
      owner,
      Math.min(limit ?? env.RECENTLY_VIEWED_MAX, env.RECENTLY_VIEWED_MAX),
    );
    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.productId);
    const cards = await storefrontRepository.findCards(ids);

    const [prices, indexed] = await Promise.all([
      productQueryService.resolveDisplayPrices(cards, { customerId: owner.customerId }),
      productQueryService.priceIndex(ids),
    ]);

    const byId = new Map(
      cards.map((card) => [
        card.id,
        toProductCard(card, {
          pricePaise: prices.get(card.id) ?? card.basePricePaise,
          indexed: indexed.get(card.id) ?? { minPricePaise: null, maxPricePaise: null },
        }),
      ]),
    );

    return rows.map((row) => ({
      productId: row.productId,
      variantId: row.variantId,
      viewedAt: row.viewedAt.toISOString(),
      viewCount: row.viewCount,
      product: byId.get(row.productId) ?? null,
    }));
  },

  async clear(owner: CartOwner): Promise<number> {
    if (!owner.customerId && !owner.sessionId) return 0;
    return recentlyViewedRepository.clear(owner);
  },
};
