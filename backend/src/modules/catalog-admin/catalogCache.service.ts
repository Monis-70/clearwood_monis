import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { cache } from '../../container';
import { catalogEvents } from '../../events/catalogEvents';

/**
 * The single place that knows every catalog cache key in the system.
 *
 * Prompts 2, 4 and 7 read through these prefixes; every admin write in Prompt 5 calls the matching
 * invalidator, which is why an edit shows up on the storefront without a restart. If you add a new
 * cached read, register its prefix here instead of inventing a private one.
 *
 *   cat:tree:*     category trees (CategoryService.getTree)
 *   cat:slug:*     single category detail (CategoryService.getBySlug)
 *   cat:attrs:*    resolved category attributes (CategoryAttributeService)
 *   nav:*          navigation menus (NavigationService)
 *   prod:*         product detail/list caches (Prompt 7)
 *   coll:*         collection caches (Prompt 7)
 *   price:set:*    resolved pricing settings (Prompt 6), default tax class and group (5B)
 *   price:quote:*  public quotes keyed by contextHash (Prompt 6)
 *   price:ship:*   shipping zone per pincode, rates per zone (Prompt 6; used since 5B)
 *   sf:set:*       storefront settings: page sizes, popularity weights (Prompt 7)
 *   sf:list:*      product listings keyed by their filter hash (Prompt 7)
 *   sf:facet:*     facet counts keyed by scope + filter hash (Prompt 7)
 *   sf:pdp:*       assembled product detail payloads (Prompt 7)
 *   sf:sugg:*      autocomplete results (Prompt 7)
 *   sf:view:*      per-session view dedupe windows (Prompt 7)
 *   addr:pin:*     pincode autofill + serviceability lookups (Prompt 8)
 *
 * Carts themselves are deliberately absent: a cart is per-shopper, mutable and money-bearing, so it
 * is always read live from the database and re-quoted by the pricing engine. Nothing about a cart
 * is ever cached.
 */
export const CATALOG_CACHE_PREFIXES = {
  categoryTree: 'cat:tree:',
  category: 'cat:slug:',
  categoryAttributes: 'cat:attrs:',
  navigation: 'nav:',
  product: 'prod:',
  collection: 'coll:',
  pricingSettings: 'price:set:',
  pricingQuote: 'price:quote:',
  pricingShipping: 'price:ship:',
  storefrontSettings: 'sf:set:',
  storefrontListing: 'sf:list:',
  storefrontFacets: 'sf:facet:',
  storefrontPdp: 'sf:pdp:',
  storefrontSuggest: 'sf:sugg:',
  storefrontView: 'sf:view:',
  addressPincode: 'addr:pin:',
  cmsPage: 'cms:page:',
  cmsBanner: 'cms:banner:',
  cmsFaq: 'cms:faq:',
  cmsHelp: 'cms:help:',
  cmsSettings: 'cms:set:',
  cmsSitemap: 'cms:sitemap:',
} as const;

/** Named separately so the pricing module does not have to know the catalog key names. */
export const PRICING_CACHE_PREFIXES = {
  settings: CATALOG_CACHE_PREFIXES.pricingSettings,
  quote: CATALOG_CACHE_PREFIXES.pricingQuote,
  shipping: CATALOG_CACHE_PREFIXES.pricingShipping,
} as const;

/** Prompt 8: the address book's only cacheable read. */
export const CART_CACHE_PREFIXES = {
  pincode: CATALOG_CACHE_PREFIXES.addressPincode,
} as const;

/** Likewise for the storefront module. */
export const STOREFRONT_CACHE_PREFIXES = {
  settings: CATALOG_CACHE_PREFIXES.storefrontSettings,
  listing: CATALOG_CACHE_PREFIXES.storefrontListing,
  facets: CATALOG_CACHE_PREFIXES.storefrontFacets,
  pdp: CATALOG_CACHE_PREFIXES.storefrontPdp,
  suggest: CATALOG_CACHE_PREFIXES.storefrontSuggest,
  view: CATALOG_CACHE_PREFIXES.storefrontView,
} as const;

export const CATALOG_CACHE_TTL = env.CATALOG_CACHE_TTL_SECONDS;

async function drop(...prefixes: string[]): Promise<void> {
  try {
    await Promise.all(prefixes.map((prefix) => cache.delByPrefix(prefix)));
  } catch (error) {
    // A cache miss is always safe; a failed invalidation must not fail the write.
    logger.warn({ err: error, prefixes }, 'catalog cache invalidation failed');
  }
}

/**
 * Everything the storefront renders from the catalog: listings, facets, PDPs, autocomplete, and
 * CMS pages, whose product, category and collection blocks are hydrated into the cached render.
 */
async function dropStorefront(): Promise<void> {
  await drop(
    CATALOG_CACHE_PREFIXES.storefrontListing,
    CATALOG_CACHE_PREFIXES.storefrontFacets,
    CATALOG_CACHE_PREFIXES.storefrontPdp,
    CATALOG_CACHE_PREFIXES.storefrontSuggest,
    CATALOG_CACHE_PREFIXES.cmsPage,
  );
}

async function dropProductCaches(): Promise<void> {
  await drop(
    CATALOG_CACHE_PREFIXES.product,
    CATALOG_CACHE_PREFIXES.categoryTree,
    CATALOG_CACHE_PREFIXES.collection,
    // A price rule, tax class or base price change must show on the very next quote.
    CATALOG_CACHE_PREFIXES.pricingQuote,
  );
  await dropStorefront();
}

/**
 * Where product images are rendered: the products' own pages (PDP keys start with the slug), and
 * every payload made of product cards. Facets, trees and prices carry no product image.
 */
function mediaBearingPrefixes(productSlugs: string[]): string[] {
  return [
    ...productSlugs.map((slug) => `${CATALOG_CACHE_PREFIXES.storefrontPdp}${slug}:`),
    CATALOG_CACHE_PREFIXES.storefrontListing,
    CATALOG_CACHE_PREFIXES.storefrontSuggest,
    CATALOG_CACHE_PREFIXES.cmsPage,
  ];
}

export const catalogCacheService = {
  prefixes: CATALOG_CACHE_PREFIXES,

  /**
   * Any structural change to the tree: create, move, reorder, rename, activate, delete.
   * `categoryIds` are the nodes whose subtree changed (their products' search text is rebuilt);
   * omitted means any node may have, [] that no product's text changed.
   */
  async invalidateCategoryTree(categoryIds?: string[]): Promise<void> {
    await drop(
      CATALOG_CACHE_PREFIXES.categoryTree,
      CATALOG_CACHE_PREFIXES.category,
      CATALOG_CACHE_PREFIXES.navigation,
      CATALOG_CACHE_PREFIXES.cmsPage,
    );
    await dropStorefront();
    catalogEvents.emit('category.changed', {
      reason: 'tree',
      ...(categoryIds ? { categoryIds } : {}),
    });
  },

  async invalidateCategory(categoryIds?: string[]): Promise<void> {
    await drop(
      CATALOG_CACHE_PREFIXES.category,
      CATALOG_CACHE_PREFIXES.categoryTree,
      CATALOG_CACHE_PREFIXES.categoryAttributes,
      CATALOG_CACHE_PREFIXES.navigation,
      CATALOG_CACHE_PREFIXES.cmsPage,
    );
    await dropStorefront();
    catalogEvents.emit('category.changed', {
      reason: 'detail',
      ...(categoryIds ? { categoryIds } : {}),
    });
  },

  /**
   * `attributeId`: that attribute's names or labels may have changed (its products are
   * re-indexed); 'structure': groups, ordering or category mapping, no product text; omitted:
   * anything may have changed.
   */
  async invalidateAttributes(affects?: string | 'structure'): Promise<void> {
    await drop(CATALOG_CACHE_PREFIXES.categoryAttributes, CATALOG_CACHE_PREFIXES.product);
    await dropStorefront();
    catalogEvents.emit('attribute.changed', {
      reason: 'attribute-write',
      ...(affects === 'structure'
        ? { textUnchanged: true }
        : affects
          ? { attributeId: affects }
          : {}),
    });
  },

  /** A product's position inside a category moved: curated grids and CMS product blocks. */
  async invalidateCategoryMerchandising(): Promise<void> {
    await drop(CATALOG_CACHE_PREFIXES.cmsPage);
    await dropStorefront();
  },

  async invalidateNavigation(): Promise<void> {
    await drop(CATALOG_CACHE_PREFIXES.navigation);
  },

  /** `productCountCache` moved: trees, category detail, landings and CMS category blocks. */
  async invalidateCategoryCounts(): Promise<void> {
    await drop(CATALOG_CACHE_PREFIXES.categoryTree, CATALOG_CACHE_PREFIXES.category);
    await dropStorefront();
  },

  /**
   * Every product write. Pass the id whenever it is known: the search indexer can then refresh
   * exactly that document. Without one (brand writes) only the caches go - nothing about a brand
   * moves a price, so it does not ask for the catalog to be re-priced.
   */
  async invalidateProduct(productId?: string, reason = 'product-write'): Promise<void> {
    await dropProductCaches();

    if (productId) catalogEvents.emit('product.changed', { productId, reason });
  },

  /**
   * Many products written at once outside their services (CSV import): the product caches drop
   * once, and exactly these products are re-priced and re-indexed in batches - not the catalog.
   */
  async invalidateProducts(productIds: string[], reason: string): Promise<void> {
    if (productIds.length === 0) return;
    await dropProductCaches();
    catalogEvents.emit('pricing.changed', { productIds, reason });
  },

  /**
   * Called by every pricing write: adjustments, tiers, price lists, coupons, zones, settings.
   *
   * `productIds` - the write can only move these products' catalog prices (they are re-priced
   * now); omitted - any product may have moved (one leased, coalesced re-price of the whole
   * index, listingReconciler); `affectsCatalogPrices: false` - checkout-only (coupons, discount
   * rules, shipping, settings, tax, group membership): caches only.
   */
  async invalidatePricing(
    scope: { productIds?: string[]; affectsCatalogPrices?: boolean } = {},
  ): Promise<void> {
    await drop(
      CATALOG_CACHE_PREFIXES.pricingSettings,
      CATALOG_CACHE_PREFIXES.pricingQuote,
      CATALOG_CACHE_PREFIXES.pricingShipping,
      CATALOG_CACHE_PREFIXES.addressPincode,
      CATALOG_CACHE_PREFIXES.product,
    );
    await dropStorefront();

    if (scope.affectsCatalogPrices === false) return;
    if (scope.productIds) {
      if (scope.productIds.length > 0) {
        catalogEvents.emit('pricing.changed', {
          productIds: scope.productIds,
          reason: 'pricing-write',
        });
      }
      return;
    }
    catalogEvents.emit('pricing.changed', { reason: 'pricing-write' });
  },

  /** A price window opened or closed: every cached payload that shows a price is suspect. */
  async invalidatePrices(): Promise<void> {
    await drop(
      CATALOG_CACHE_PREFIXES.pricingQuote,
      CATALOG_CACHE_PREFIXES.product,
      CATALOG_CACHE_PREFIXES.cmsPage,
    );
    await dropStorefront();
  },

  /**
   * The clock moved the catalog (listingReconciler): a scheduled product went live, a featured,
   * new-arrival or collection window ended, or category counts were recomputed. Caches only -
   * the reconciler has already re-indexed what needed it, so nothing is announced.
   */
  async invalidateSchedule(): Promise<void> {
    await drop(
      CATALOG_CACHE_PREFIXES.product,
      CATALOG_CACHE_PREFIXES.categoryTree,
      CATALOG_CACHE_PREFIXES.category,
      CATALOG_CACHE_PREFIXES.collection,
      CATALOG_CACHE_PREFIXES.navigation,
      CATALOG_CACHE_PREFIXES.cmsPage,
      CATALOG_CACHE_PREFIXES.cmsSitemap,
    );
    await dropStorefront();
  },

  async invalidateCollection(): Promise<void> {
    await drop(CATALOG_CACHE_PREFIXES.collection, CATALOG_CACHE_PREFIXES.navigation);
    await dropStorefront();
    catalogEvents.emit('collection.changed', { reason: 'collection-write' });
  },

  /** A product left the catalog: its document must disappear, not just go cold. */
  async invalidateProductRemoved(productId: string): Promise<void> {
    await dropProductCaches();
    catalogEvents.emit('product.removed', { productId });
  },

  /** Prompt 7: settings that change page size or the popularity formula. */
  async invalidateStorefrontSettings(): Promise<void> {
    await drop(CATALOG_CACHE_PREFIXES.storefrontSettings);
    await dropStorefront();
  },

  async invalidateStorefront(): Promise<void> {
    await dropStorefront();
  },

  /** A product's gallery changed: its own product pages and the payloads that show its image. */
  async invalidateProductMedia(productSlug: string): Promise<void> {
    await drop(...mediaBearingPrefixes([productSlug]));
  },

  /** An asset's bytes, alt text or visibility changed; `productSlugs` are the products showing it. */
  async invalidateMedia(productSlugs: string[]): Promise<void> {
    const productPayloads =
      productSlugs.length > 0
        ? mediaBearingPrefixes(productSlugs)
        : [CATALOG_CACHE_PREFIXES.cmsPage];
    // CMS pages and banners can show any asset directly.
    await drop(...productPayloads, CATALOG_CACHE_PREFIXES.cmsBanner);
  },

  /**
   * Prompt 10A. A page renders products, categories and collections, so a catalog change can make
   * a rendered page wrong — but not the reverse, which is why this is one-way.
   */
  async invalidateCmsPages(): Promise<void> {
    await drop(CATALOG_CACHE_PREFIXES.cmsPage, CATALOG_CACHE_PREFIXES.cmsSitemap);
    catalogEvents.emit('content.changed', { reason: 'page-write' });
  },

  async invalidateCmsBanners(): Promise<void> {
    await drop(CATALOG_CACHE_PREFIXES.cmsBanner, CATALOG_CACHE_PREFIXES.cmsPage);
  },

  async invalidateCmsFaqs(): Promise<void> {
    await drop(CATALOG_CACHE_PREFIXES.cmsFaq, CATALOG_CACHE_PREFIXES.cmsPage);
  },

  async invalidateCmsHelp(): Promise<void> {
    await drop(CATALOG_CACHE_PREFIXES.cmsHelp, CATALOG_CACHE_PREFIXES.cmsSitemap);
    catalogEvents.emit('content.changed', { reason: 'help-write' });
  },

  async invalidateCmsSettings(): Promise<void> {
    await drop(
      CATALOG_CACHE_PREFIXES.cmsSettings,
      CATALOG_CACHE_PREFIXES.cmsPage,
      CATALOG_CACHE_PREFIXES.cmsSitemap,
    );
  },

  async invalidateAll(): Promise<void> {
    await drop(...Object.values(CATALOG_CACHE_PREFIXES));
  },
};
