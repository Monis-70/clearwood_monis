import { catalogCacheService } from '../modules/catalog-admin/catalogCache.service';
import { listingIndexService } from '../modules/storefront/listingIndex.service';
import { listingReconciler } from '../modules/storefront/listingReconciler.service';
import { searchIndexerService } from '../modules/storefront/searchIndexer.service';
import { productStatRepository } from '../repositories/searchAnalytics.repository';
import { storefrontRepository } from '../repositories/storefront.repository';
import { categoryCountsService } from '../services/categoryCounts.service';

import { catalogEvents } from './catalogEvents';

/** A name a product document shows changed: rebuild those documents (prices are reused). */
async function reindexProductText(productIds: string[] | 'ALL'): Promise<void> {
  const ids = productIds === 'ALL' ? await storefrontRepository.listIndexableIds() : productIds;
  if (ids.length > 0) await searchIndexerService.indexProducts(ids);
}

/**
 * Product writes that cannot move a category count: what a product relates to, its specs, its
 * variants, and the batch fields no count reads. Anything else (status, visibility, publication,
 * links, merchandising flags a rule category reads, deletion) recounts.
 */
const COUNT_NEUTRAL =
  /^(relations|attribute-values|variant-.*|bulk-(assign_collection|set_tax_class|set_brand))$/;

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

  catalogEvents.on('product.changed', async ({ productId, reason }) => {
    await searchIndexerService.indexProduct(productId);
    await catalogCacheService.invalidateStorefront();
    if (!COUNT_NEUTRAL.test(reason)) await categoryCountsService.recount();
  });

  catalogEvents.on('product.removed', async ({ productId }) => {
    await searchIndexerService.removeProduct(productId);
    await listingIndexService.remove(productId);
    await catalogCacheService.invalidateStorefront();
    await categoryCountsService.recount();
  });

  catalogEvents.on('inventory.changed', async ({ productId }) => {
    // Stock flips `inStock` in the index, which the availability facet and filter both read.
    await searchIndexerService.indexProduct(productId, { reprice: false });
    await catalogCacheService.invalidateStorefront();
  });

  catalogEvents.on('pricing.changed', async ({ productIds, reason }) => {
    if (!productIds || productIds.length === 0) {
      // Any product may have moved: one leased, coalesced re-price across every worker. It drops
      // the storefront caches itself once the new prices are in.
      await listingReconciler.requestRebuild();
      return;
    }

    await listingIndexService.refreshMany(productIds);
    await searchIndexerService.indexProducts(productIds);
    await catalogCacheService.invalidateStorefront();
    // An imported product row may also have been filed, moved or re-published.
    if (reason === 'import-product') await categoryCountsService.recount();
  });

  catalogEvents.on('category.changed', async ({ reason, categoryIds }) => {
    await searchIndexerService.indexCategories();
    await catalogCacheService.invalidateStorefront();
    // Product documents carry their categories' names and paths, and only live ones.
    await reindexProductText(
      categoryIds === undefined
        ? 'ALL'
        : await storefrontRepository.findProductIdsInCategorySubtrees(categoryIds),
    );
    // A move changes which products a CATEGORY rule reaches without writing any product row.
    if (reason === 'tree') await listingReconciler.requestRebuildIfRulesRead('categoryId');
    // Hiding, moving or deleting a node changes what a rule category's parent subtree holds.
    await categoryCountsService.recount();
  });

  catalogEvents.on('collection.changed', async () => {
    await searchIndexerService.indexCollections();
    await catalogCacheService.invalidateStorefront();
    await listingReconciler.requestRebuildIfRulesRead('collectionId');
  });

  /** A published page or help article must be findable, and a withdrawn one must stop being. */
  catalogEvents.on('content.changed', async () => {
    await searchIndexerService.indexPages();
    await searchIndexerService.indexHelpArticles();
    await searchIndexerService.pruneContent();
  });

  catalogEvents.on('brand.changed', async ({ brandId }) => {
    await searchIndexerService.indexBrands();
    await catalogCacheService.invalidateStorefront();
    await reindexProductText(
      brandId ? await storefrontRepository.findProductIdsByBrand(brandId) : 'ALL',
    );
  });

  catalogEvents.on('attribute.changed', async ({ attributeId, textUnchanged }) => {
    await catalogCacheService.invalidateStorefront();
    if (!textUnchanged) {
      await reindexProductText(
        attributeId ? await storefrontRepository.findProductIdsByAttribute(attributeId) : 'ALL',
      );
    }
    // Deleting a value drops it from every variant without writing a variant row.
    await listingReconciler.requestRebuildIfRulesRead('attributeValueId');
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
    await searchIndexerService.indexProduct(productId, { reprice: false });
  });
}
