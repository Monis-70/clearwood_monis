import { logger } from '../config/logger';
import { catalogCacheService } from '../modules/catalog-admin/catalogCache.service';
import { searchIndexerService } from '../modules/storefront/searchIndexer.service';
import { productStatRepository } from '../repositories/searchAnalytics.repository';

import { catalogEvents } from './catalogEvents';

/**
 * Wires the catalog event bus to its two listeners: cache invalidation and incremental reindexing.
 *
 * Registering them together, once, is what stops the two from drifting — an admin write emits one
 * event and both the storefront cache and the search index react to it.
 */

let registered = false;

export function registerCatalogSubscribers(): void {
  if (registered) return;
  registered = true;

  catalogEvents.on('product.changed', async ({ productId }) => {
    await searchIndexerService.indexProduct(productId);
    await catalogCacheService.invalidateStorefront();
  });

  catalogEvents.on('product.removed', async ({ productId }) => {
    await searchIndexerService.removeProduct(productId);
    await catalogCacheService.invalidateStorefront();
  });

  catalogEvents.on('inventory.changed', async ({ productId }) => {
    // Stock flips `inStock` in the index, which the availability facet and filter both read.
    await searchIndexerService.indexProduct(productId);
    await catalogCacheService.invalidateStorefront();
  });

  catalogEvents.on('pricing.changed', async ({ productIds }) => {
    if (!productIds || productIds.length === 0) {
      // A global rule moved: the whole price index is suspect, so rebuild it in the background.
      void searchIndexerService
        .reindexAll('PRODUCT')
        .catch((error: unknown) => logger.warn({ err: error }, 'price reindex failed'));
      return;
    }

    for (const productId of productIds) await searchIndexerService.indexProduct(productId);
  });

  catalogEvents.on('category.changed', async () => {
    await searchIndexerService.indexCategories();
    await catalogCacheService.invalidateStorefront();
  });

  catalogEvents.on('collection.changed', async () => {
    await searchIndexerService.indexCollections();
    await catalogCacheService.invalidateStorefront();
  });

  /** A published page or help article must be findable, and a withdrawn one must stop being. */
  catalogEvents.on('content.changed', async () => {
    await searchIndexerService.indexPages();
    await searchIndexerService.indexHelpArticles();
    await searchIndexerService.pruneContent();
  });

  catalogEvents.on('brand.changed', async () => {
    await searchIndexerService.indexBrands();
    await catalogCacheService.invalidateStorefront();
  });

  catalogEvents.on('attribute.changed', async () => {
    await catalogCacheService.invalidateStorefront();
  });

  /* Prompt 8 — the ProductStat counters Prompt 7 deliberately left at zero. */

  catalogEvents.on('cart.item.added', async ({ productId }) => {
    await productStatRepository.incrementCartAdd(productId);
  });

  catalogEvents.on('wishlist.item.added', async ({ productId }) => {
    await productStatRepository.incrementWishlist(productId, 1);
  });

  catalogEvents.on('wishlist.item.removed', async ({ productId }) => {
    await productStatRepository.incrementWishlist(productId, -1);
  });

  /* Prompt 9A — a confirmed order is the only thing that moves purchaseCount and soldCount. */

  catalogEvents.on('order.confirmed', async ({ productId, qty }) => {
    await productStatRepository.incrementPurchase(productId, qty);
    await searchIndexerService.indexProduct(productId);
  });
}
