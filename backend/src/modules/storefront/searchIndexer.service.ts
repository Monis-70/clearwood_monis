import { createHash } from 'node:crypto';

import type { SearchEntityType } from '@shared/enums';

import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { search } from '../../container';
import type { SearchDocumentInput } from '../../drivers/search';
import { DEFAULT_LOCALE } from '../../drivers/search';
import { searchDocumentRepository } from '../../repositories/searchDocument.repository';
import { cmsSearchRepository } from '../../repositories/cms.repository';
import {
  storefrontRepository,
  type ProductForIndex,
} from '../../repositories/storefront.repository';
import { toPlainText } from '../cms/htmlSanitizer';
import { pricingFacade } from '../pricing/pricing.facade';

/**
 * Builds the denormalised SearchDocument for every indexable entity.
 *
 * PRICE RULE — the indexed `minPricePaise`/`maxPricePaise` are produced by calling the Prompt 6
 * pricing facade once per variant for the DEFAULT customer group (no customer, no coupon, no
 * pincode). There is deliberately no pricing arithmetic in this file: the index must agree with
 * `/pricing/quote` by construction, not by a second implementation that drifts.
 */

const PRICE_CONCURRENCY = 4;

function hash(payload: Omit<SearchDocumentInput, 'checksum'>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

/**
 * The readable words inside a block config, for the page index.
 *
 * Deliberately shallow and forgiving: it pulls the string values a human would read and ignores
 * everything else. A block type this build does not recognise contributes whatever text it has
 * rather than breaking the index.
 */
function blockText(configJson: string): string {
  let config: unknown;
  try {
    config = JSON.parse(configJson);
  } catch {
    return '';
  }

  const READABLE = new Set([
    'html',
    'headline',
    'subheadline',
    'title',
    'subtitle',
    'body',
    'label',
    'caption',
    'quote',
  ]);

  const words: string[] = [];

  const walk = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, depth + 1);
      return;
    }

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string' && READABLE.has(key)) {
        words.push(key === 'html' ? toPlainText(value, 4_000) : value);
      } else {
        walk(value, depth + 1);
      }
    }
  };

  walk(config, 0);

  return words.join(' ');
}

function collapse(...parts: (string | null | undefined)[]): string {
  return parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ancestors included: a product in "Fabric Sofas" must be findable by searching "sofas". */
function categoryText(product: ProductForIndex): string {
  const parts = new Set<string>();

  for (const link of product.categories) {
    parts.add(link.category.name);
    for (const slug of link.category.path.split('/')) {
      if (slug) parts.add(slug.replace(/-/g, ' '));
    }
  }
  return collapse(...parts);
}

function attributeText(product: ProductForIndex): string {
  const parts = new Set<string>();

  for (const row of product.attributeValues) {
    parts.add(row.attribute.name);
    if (row.attributeValue) parts.add(row.attributeValue.label);
    if (row.valueText) parts.add(row.valueText);
  }
  for (const variant of product.variants) {
    for (const row of variant.attributeValues) parts.add(row.attributeValue.label);
  }
  return collapse(...parts);
}

function stockRollup(product: ProductForIndex): boolean {
  if (product.isMadeToOrder) return true;

  return product.variants.some(
    (variant) =>
      variant.isActive &&
      (variant.allowBackorder || Math.max(variant.stockQty - variant.reservedQty, 0) > 0),
  );
}

async function inChunks<T, R>(
  items: T[],
  size: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];

  for (let index = 0; index < items.length; index += size) {
    const slice = items.slice(index, index + size);
    results.push(...(await Promise.all(slice.map(run))));
  }
  return results;
}

export interface ReindexOutcome {
  total: number;
  processed: number;
  written: number;
  failed: number;
  errors: string[];
}

export const searchIndexerService = {
  /**
   * The DEFAULT customer group's price range, straight from the pricing engine.
   *
   * One quote per sellable variant at qty 1. Variants share a cached pricing context, so this is
   * cheap; correctness matters more than shaving a query here, because this number is what the
   * price filter and the price sort run against.
   */
  async priceRange(
    product: ProductForIndex,
  ): Promise<{ minPricePaise: number | null; maxPricePaise: number | null }> {
    const variants = product.variants.filter((variant) => variant.isActive);
    const targets = variants.length > 0 ? variants.map((variant) => variant.id) : [null];

    const prices = await inChunks(targets, PRICE_CONCURRENCY, async (variantId) => {
      try {
        const breakdown = await pricingFacade.quoteProduct({
          items: [{ productId: product.id, variantId, qty: 1 }],
          channel: 'WEB',
          customerId: null,
          customerGroupId: null,
        });
        return breakdown.lines[0]?.unitPricePaise ?? null;
      } catch (error) {
        logger.warn(
          { err: error, productId: product.id, variantId },
          'price index skipped a variant',
        );
        return null;
      }
    });

    const resolved = prices.filter((price): price is number => price !== null);
    if (resolved.length === 0) return { minPricePaise: null, maxPricePaise: null };

    return {
      minPricePaise: Math.min(...resolved),
      maxPricePaise: Math.max(...resolved),
    };
  },

  async buildProductDocument(product: ProductForIndex): Promise<SearchDocumentInput> {
    const { minPricePaise, maxPricePaise } = await this.priceRange(product);

    const payload: Omit<SearchDocumentInput, 'checksum'> = {
      entityType: 'PRODUCT',
      entityId: product.id,
      title: product.name,
      subtitle: product.subtitle,
      bodyText: collapse(product.shortDescription, product.description),
      keywordsText: collapse(
        product.searchKeywords,
        product.seoKeywords,
        ...product.variants.map((variant) => variant.sku),
      ),
      brandText: product.brand?.name ?? null,
      categoryText: categoryText(product),
      attributeText: attributeText(product),
      sku: product.sku,
      slug: product.slug,
      locale: DEFAULT_LOCALE,
      minPricePaise,
      maxPricePaise,
      inStock: stockRollup(product),
      isActive: true,
      popularityScore: product.soldCount,
      boostScore: (product.isFeatured ? 10 : 0) + (product.isBestSeller ? 5 : 0),
    };

    return { ...payload, checksum: hash(payload) };
  },

  async indexProduct(productId: string): Promise<boolean> {
    const product = await storefrontRepository.findIndexableById(productId);

    // Unpublished, archived or soft-deleted: the document must disappear, not go stale.
    if (!product) {
      await search.remove('PRODUCT', productId);
      return true;
    }

    return search.indexOne(await this.buildProductDocument(product));
  },

  async removeProduct(productId: string): Promise<void> {
    await search.remove('PRODUCT', productId);
  },

  async indexCategories(): Promise<number> {
    const categories = await storefrontRepository.findIndexableCategories();

    const documents = categories.map((category) => {
      const payload: Omit<SearchDocumentInput, 'checksum'> = {
        entityType: 'CATEGORY',
        entityId: category.id,
        title: category.name,
        subtitle: category.shortDescription,
        bodyText: collapse(category.description),
        keywordsText: collapse(category.seoKeywords, category.path.replace(/[-/]/g, ' ')),
        brandText: null,
        categoryText: category.path.replace(/[-/]/g, ' '),
        attributeText: '',
        sku: null,
        slug: category.slug,
        locale: DEFAULT_LOCALE,
        minPricePaise: null,
        maxPricePaise: null,
        inStock: true,
        isActive: category.isActive,
        popularityScore: category.productCountCache,
        boostScore: category.isFeatured ? 5 : 0,
      };
      return { ...payload, checksum: hash(payload) };
    });

    return search.indexMany(documents);
  },

  async indexCollections(): Promise<number> {
    const collections = await storefrontRepository.findIndexableCollections();

    const documents = collections.map((collection) => {
      const payload: Omit<SearchDocumentInput, 'checksum'> = {
        entityType: 'COLLECTION',
        entityId: collection.id,
        title: collection.name,
        subtitle: null,
        bodyText: collapse(collection.description),
        keywordsText: collection.slug.replace(/-/g, ' '),
        brandText: null,
        categoryText: '',
        attributeText: '',
        sku: null,
        slug: collection.slug,
        locale: DEFAULT_LOCALE,
        minPricePaise: null,
        maxPricePaise: null,
        inStock: true,
        isActive: collection.isActive,
        popularityScore: collection._count.products,
        boostScore: 0,
      };
      return { ...payload, checksum: hash(payload) };
    });

    return search.indexMany(documents);
  },

  async indexBrands(): Promise<number> {
    const brands = await storefrontRepository.findIndexableBrands();

    const documents = brands.map((brand) => {
      const payload: Omit<SearchDocumentInput, 'checksum'> = {
        entityType: 'BRAND',
        entityId: brand.id,
        title: brand.name,
        subtitle: null,
        bodyText: collapse(brand.description),
        keywordsText: brand.slug.replace(/-/g, ' '),
        brandText: brand.name,
        categoryText: '',
        attributeText: '',
        sku: null,
        slug: brand.slug,
        locale: DEFAULT_LOCALE,
        minPricePaise: null,
        maxPricePaise: null,
        inStock: true,
        isActive: brand.isActive,
        popularityScore: 0,
        boostScore: 0,
      };
      return { ...payload, checksum: hash(payload) };
    });

    return search.indexMany(documents);
  },

  /** Chunked and resumable: a failure mid-run leaves every earlier chunk correctly indexed. */
  /**
   * Published CMS pages and help articles (Prompt B1 Task 4).
   *
   * Site search returning the shipping policy or "what to check on arrival" is expected behaviour:
   * customers search for answers as often as for products, and until now the only way to find a
   * policy was to know the URL. The body is indexed from the SANITISED html, flattened to text,
   * because that is the copy that actually reaches a reader.
   */
  async indexPages(): Promise<number> {
    const pages = await cmsSearchRepository.indexablePages(new Date());

    const documents = pages.map((page) => {
      const payload: Omit<SearchDocumentInput, 'checksum'> = {
        entityType: 'PAGE',
        entityId: page.id,
        title: page.seoTitle ?? page.title,
        subtitle: null,
        bodyText: collapse(
          page.excerpt,
          page.seoDescription,
          ...page.blocks.map((block) => blockText(block.configJson)),
        ).slice(0, 8_000),
        keywordsText: collapse(page.seoKeywords, page.slug.replace(/-/g, ' ')),
        brandText: null,
        categoryText: '',
        attributeText: '',
        sku: null,
        slug: page.slug,
        locale: DEFAULT_LOCALE,
        minPricePaise: null,
        maxPricePaise: null,
        inStock: true,
        // A noIndex page is excluded from search for the same reason it is kept out of the sitemap.
        isActive: !page.noIndex,
        popularityScore: page.viewCount,
        boostScore: page.type === 'HOME' ? 100 : 0,
      };
      return { ...payload, checksum: hash(payload) };
    });

    return search.indexMany(documents);
  },

  async indexHelpArticles(): Promise<number> {
    const articles = await cmsSearchRepository.indexableHelpArticles();

    const documents = articles.map((article) => {
      const payload: Omit<SearchDocumentInput, 'checksum'> = {
        entityType: 'HELP_ARTICLE',
        entityId: article.id,
        title: article.seoTitle ?? article.title,
        subtitle: article.category?.name ?? null,
        bodyText: toPlainText(article.bodyHtml, 8_000),
        keywordsText: collapse(article.slug.replace(/-/g, ' '), article.category?.name),
        brandText: null,
        categoryText: collapse(article.category?.name),
        attributeText: '',
        sku: null,
        slug: article.slug,
        locale: DEFAULT_LOCALE,
        minPricePaise: null,
        maxPricePaise: null,
        inStock: true,
        isActive: true,
        popularityScore: article.viewCount,
        boostScore: 0,
      };
      return { ...payload, checksum: hash(payload) };
    });

    return search.indexMany(documents);
  },

  /** Drops indexed content that is no longer published. */
  async pruneContent(): Promise<number> {
    const now = new Date();

    const [indexedPages, livePages, indexedArticles, liveArticles] = await Promise.all([
      searchDocumentRepository.listEntityIds('PAGE'),
      cmsSearchRepository.indexablePages(now).then((rows) => rows.map((row) => row.id)),
      searchDocumentRepository.listEntityIds('HELP_ARTICLE'),
      cmsSearchRepository.indexableHelpArticles().then((rows) => rows.map((row) => row.id)),
    ]);

    const livePageIds = new Set(livePages);
    const liveArticleIds = new Set(liveArticles);

    const stale = [
      ...indexedPages.filter((id) => !livePageIds.has(id)).map((id) => ({ type: 'PAGE' as const, id })),
      ...indexedArticles
        .filter((id) => !liveArticleIds.has(id))
        .map((id) => ({ type: 'HELP_ARTICLE' as const, id })),
    ];

    for (const entry of stale) await search.remove(entry.type, entry.id);

    return stale.length;
  },

  async reindexAll(
    entityType?: SearchEntityType,
    onProgress?: (processed: number, total: number) => Promise<void>,
  ): Promise<ReindexOutcome> {
    const outcome: ReindexOutcome = {
      total: 0,
      processed: 0,
      written: 0,
      failed: 0,
      errors: [],
    };

    if (!entityType || entityType === 'CATEGORY') outcome.written += await this.indexCategories();
    if (!entityType || entityType === 'COLLECTION')
      outcome.written += await this.indexCollections();
    if (!entityType || entityType === 'BRAND') outcome.written += await this.indexBrands();
    if (!entityType || entityType === 'PAGE') outcome.written += await this.indexPages();
    if (!entityType || entityType === 'HELP_ARTICLE')
      outcome.written += await this.indexHelpArticles();

    if (!entityType || entityType === 'PAGE' || entityType === 'HELP_ARTICLE') {
      await this.pruneContent();
    }

    if (entityType && entityType !== 'PRODUCT') return outcome;

    outcome.total = await storefrontRepository.countIndexable();

    let afterId: string | null = null;
    for (;;) {
      const batch: ProductForIndex[] = await storefrontRepository.findIndexable(
        afterId,
        env.SEARCH_INDEX_BATCH,
      );
      if (batch.length === 0) break;

      const documents: SearchDocumentInput[] = [];
      for (const product of batch) {
        try {
          documents.push(await this.buildProductDocument(product));
        } catch (error) {
          outcome.failed += 1;
          outcome.errors.push(
            `${product.sku}: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        }
      }

      outcome.written += await search.indexMany(documents);
      outcome.processed += batch.length;
      afterId = batch[batch.length - 1]!.id;

      if (onProgress) await onProgress(outcome.processed, outcome.total);
    }

    /* Anything indexed but no longer publishable has to go. */
    await this.pruneProducts();
    return outcome;
  },

  /** Drops documents whose product is gone, archived, hidden or unpublished. */
  async pruneProducts(): Promise<number> {
    const [indexedIds, liveIds] = await Promise.all([
      searchDocumentRepository.listEntityIds('PRODUCT'),
      storefrontRepository.listIndexableIds(),
    ]);

    const live = new Set(liveIds);
    const stale = indexedIds.filter((id) => !live.has(id));

    return searchDocumentRepository.removeMany('PRODUCT', stale);
  },
};
