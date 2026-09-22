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
 *   price:set:*    resolved pricing settings (Prompt 6)
 *   price:quote:*  public quotes keyed by contextHash (Prompt 6)
 *   price:ship:*   shipping zones and rates (Prompt 6)
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

/** Everything the storefront renders from the catalog: listings, facets, PDPs, autocomplete. */
async function dropStorefront(): Promise<void> {
  await drop(
    CATALOG_CACHE_PREFIXES.storefrontListing,
    CATALOG_CACHE_PREFIXES.storefrontFacets,
    CATALOG_CACHE_PREFIXES.storefrontPdp,
    CATALOG_CACHE_PREFIXES.storefrontSuggest,
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

export const catalogCacheService = {
  prefixes: CATALOG_CACHE_PREFIXES,

  /** Any structural change to the tree: create, move, reorder, rename, activate, delete. */
  async invalidateCategoryTree(): Promise<void> {
    await drop(
      CATALOG_CACHE_PREFIXES.categoryTree,
      CATALOG_CACHE_PREFIXES.category,
      CATALOG_CACHE_PREFIXES.navigation,
    );
    await dropStorefront();
    catalogEvents.emit('category.changed', { reason: 'tree' });
  },

  async invalidateCategory(): Promise<void> {
    await drop(
      CATALOG_CACHE_PREFIXES.category,
      CATALOG_CACHE_PREFIXES.categoryTree,
      CATALOG_CACHE_PREFIXES.categoryAttributes,
      CATALOG_CACHE_PREFIXES.navigation,
    );
    await dropStorefront();
    catalogEvents.emit('category.changed', { reason: 'detail' });
  },

  async invalidateAttributes(): Promise<void> {
    await drop(CATALOG_CACHE_PREFIXES.categoryAttributes, CATALOG_CACHE_PREFIXES.product);
    await dropStorefront();
    catalogEvents.emit('attribute.changed', { reason: 'attribute-write' });
  },

  async invalidateNavigation(): Promise<void> {
    await drop(CATALOG_CACHE_PREFIXES.navigation);
  },

  /**
   * Every product write. Pass the id whenever it is known: the search indexer can then refresh
   * exactly that document instead of rebuilding the whole product index.
   */
  async invalidateProduct(productId?: string, reason = 'product-write'): Promise<void> {
    await dropProductCaches();

    if (productId) catalogEvents.emit('product.changed', { productId, reason });
    else catalogEvents.emit('pricing.changed', { reason });
  },

  /** Called by every pricing write: adjustments, tiers, price lists, coupons, zones, settings. */
  async invalidatePricing(): Promise<void> {
    await drop(
      CATALOG_CACHE_PREFIXES.pricingSettings,
      CATALOG_CACHE_PREFIXES.pricingQuote,
      CATALOG_CACHE_PREFIXES.pricingShipping,
      CATALOG_CACHE_PREFIXES.addressPincode,
      CATALOG_CACHE_PREFIXES.product,
    );
    await dropStorefront();
    // A rule can touch any product, so the indexed price range has to be rebuilt, not patched.
    catalogEvents.emit('pricing.changed', { reason: 'pricing-write' });
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
