import { createHash } from 'node:crypto';

import type { PaginationInput } from '@shared/types/api';
import type {
  CollectionListQuery,
  ProductBatchInput,
  SearchQueryInput,
  StorefrontListQuery,
} from '@shared/schemas/storefront';
import type {
  CategoryLandingDto,
  CollectionDto,
  FacetDto,
  ProductCardDto,
  ProductListDto,
  SearchResponseDto,
} from '@shared/types/storefront';

import { env } from '../../config/env';
import { cache, search } from '../../container';
import { searchEntityRepository } from '../../repositories/searchAnalytics.repository';
import { storefrontRepository } from '../../repositories/storefront.repository';
import { categoryService } from '../../services/category.service';
import { AppError } from '../../utils/AppError';
import { STOREFRONT_CACHE_PREFIXES } from '../catalog-admin/catalogCache.service';

import { toProductCard } from './card.mapper';
import { facetService } from './facet.service';
import { loadMerchandising } from './merchandising';
import {
  productQueryService,
  type ListingIdentity,
  type ListingPage,
  type PreparedListing,
} from './productQuery.service';
import { searchAnalyticsService } from './searchAnalytics.service';

/**
 * The single entry point controllers use. It stitches the listing engine to the facet engine
 * without either of them knowing about HTTP.
 */

export interface ListingResponse {
  data: ProductListDto;
  pagination: PaginationInput;
}

/**
 * The landing passes every request filter it does not override through to the grid and the
 * facets, so each of them is part of the key - otherwise one shopper's filtered landing would be
 * served to everyone else.
 */
export function landingCacheKey(
  slug: string,
  audience: string | null,
  query: StorefrontListQuery,
): string {
  const {
    categorySlug: _categorySlug,
    page: _page,
    limit: _limit,
    sort: _sort,
    includeFacets: _includeFacets,
    ...filters
  } = query;
  const digest = createHash('sha256').update(JSON.stringify(filters)).digest('base64url');
  return `${STOREFRONT_CACHE_PREFIXES.listing}landing:${slug}:${audience ?? 'anon'}:${digest}`;
}

/**
 * A grid page: every validated parameter (future ones included) plus whose prices it shows - the
 * pricing audience, so shoppers priced identically share one entry and nobody receives another
 * group's prices. Facets are cached apart (facet.service), so `includeFacets` is left out.
 */
export function listingCacheKey(query: StorefrontListQuery, audience: string | null): string {
  const { includeFacets: _includeFacets, ...rest } = query;
  const normalised = {
    ...rest,
    brandIds: [...rest.brandIds].sort(),
    brandSlugs: [...rest.brandSlugs].sort(),
    attributeValueIds: [...rest.attributeValueIds].sort(),
  };
  const digest = createHash('sha256').update(JSON.stringify(normalised)).digest('base64url');
  return `${STOREFRONT_CACHE_PREFIXES.listing}grid:${audience ?? 'anon'}:${digest}`;
}

export interface ListOptions {
  /** The landing caches its whole payload, so its inner grid is not cached twice. */
  cache?: boolean;
}

export const storefrontFacade = {
  async listProducts(
    query: StorefrontListQuery,
    identity: ListingIdentity,
    options: ListOptions = {},
  ): Promise<ListingResponse> {
    let prepared: Promise<PreparedListing> | null = null;
    const prepare = () => (prepared ??= productQueryService.prepare(query));
    const build = async (): Promise<ListingPage> =>
      productQueryService.page(await prepare(), identity);

    // Search results follow the search index and synonyms, which invalidate nothing here.
    const page =
      options.cache === false || query.q
        ? await build()
        : await cache.wrap(
            listingCacheKey(
              query,
              (await productQueryService.pricingAudience(identity.customerId)).key,
            ),
            env.STOREFRONT_CACHE_TTL_SECONDS,
            build,
          );

    // A copy: concurrent callers of one cache fill share the producer's object.
    const data: ProductListDto = { ...page.listing, facets: [] };
    if (query.includeFacets) data.facets = await facetService.build(await prepare());

    return {
      data,
      pagination: { page: page.page, limit: page.limit, total: page.total },
    };
  },

  /** Facet definitions and price bounds for a scope, with no grid attached. */
  async filters(query: StorefrontListQuery, _identity: ListingIdentity): Promise<FacetDto[]> {
    const prepared = await productQueryService.prepare({
      ...query,
      page: 1,
      limit: 1,
      includeFacets: false,
    });
    return facetService.build(prepared);
  },

  async search(
    query: SearchQueryInput,
    identity: ListingIdentity,
    request: { ip?: string | undefined; sessionId?: string | undefined },
  ): Promise<SearchResponseDto> {
    const started = Date.now();

    if (query.q.trim().length < env.SEARCH_MIN_QUERY_LENGTH) {
      throw new AppError(
        422,
        'SEARCH_QUERY_TOO_SHORT',
        `Type at least ${env.SEARCH_MIN_QUERY_LENGTH} characters to search`,
        { min: env.SEARCH_MIN_QUERY_LENGTH },
      );
    }

    const products = await this.listProducts(query, identity);

    const other = await search.search({
      q: query.q,
      entityTypes: query.types.filter((type) => type !== 'PRODUCT'),
      limit: 10,
    });

    const idsFor = (type: string) =>
      other.hits.filter((hit) => hit.entityType === type).map((hit) => hit.entityId);

    const [categoryRows, collections, brands, liveCategories] = await Promise.all([
      searchEntityRepository.findCategoriesByIds(idsFor('CATEGORY')),
      searchEntityRepository.findCollectionsByIds(idsFor('COLLECTION')),
      searchEntityRepository.findBrandsByIds(idsFor('BRAND')),
      categoryService.liveIds(),
    ]);
    const categories = categoryRows.filter((row) => liveCategories.has(row.id));

    const queryLogId = await searchAnalyticsService.logQuery({
      rawQuery: query.q,
      resultCount: products.pagination.total,
      filters: {
        categorySlug: query.categorySlug ?? null,
        brandIds: query.brandIds,
        attributeValueIds: query.attributeValueIds,
      },
      customerId: identity.customerId,
      sessionId: query.sessionId ?? request.sessionId ?? null,
      ip: request.ip ?? null,
    });

    return {
      query: query.q,
      normalizedQuery: other.normalizedQuery,
      expandedTerms: other.expandedTerms,
      queryLogId,
      products: products.data,
      categories: [{ type: 'CATEGORY', total: categories.length, items: categories }],
      collections: [{ type: 'COLLECTION', total: collections.length, items: collections }],
      brands: [{ type: 'BRAND', total: brands.length, items: brands }],
      tookMs: Date.now() - started,
    };
  },

  async categoryLanding(
    slug: string,
    identity: ListingIdentity,
    query: StorefrontListQuery,
  ): Promise<CategoryLandingDto> {
    return cache.wrap(
      landingCacheKey(
        slug,
        (await productQueryService.pricingAudience(identity.customerId)).key,
        query,
      ),
      env.STOREFRONT_CACHE_TTL_SECONDS,
      () => this.buildLanding(slug, identity, query),
    );
  },

  async buildLanding(
    slug: string,
    identity: ListingIdentity,
    query: StorefrontListQuery,
  ): Promise<CategoryLandingDto> {
    const detail = await categoryService.getBySlug(slug);

    const scoped: StorefrontListQuery = {
      ...query,
      categorySlug: slug,
      page: 1,
      limit: 8,
      sort: 'POPULARITY',
      includeFacets: false,
    };

    const [featured, facetDefaults] = await Promise.all([
      this.listProducts(scoped, identity, { cache: false }),
      this.filters({ ...scoped, limit: 1 }, identity),
    ]);

    const children = detail.children.map((child) => ({
      id: child.id,
      slug: child.slug,
      name: child.name,
      kind: child.kind,
      leadFormKey: child.leadFormKey,
      productCount: child.productCountCache,
    }));

    const landing: CategoryLandingDto = {
      category: {
        id: detail.id,
        slug: detail.slug,
        name: detail.name,
        path: detail.path,
        depth: detail.depth,
        kind: detail.kind,
        leadFormKey: detail.leadFormKey,
        description: detail.description,
        shortDescription: detail.shortDescription,
        bannerMediaId: detail.bannerMediaId,
        mobileBannerMediaId: detail.mobileBannerMediaId,
      },
      breadcrumbs: detail.breadcrumbs.map((crumb) => ({
        slug: crumb.slug,
        name: crumb.name,
        path: `/${crumb.slug}`,
      })),
      children,
      facetDefaults,
      featured: featured.data.items,
      productCount: featured.pagination.total,
      seo: {
        title: detail.seoTitle ?? `${detail.name} | ClearWood Furnitures`,
        description: detail.seoDescription ?? detail.shortDescription ?? detail.name,
        keywords: detail.seoKeywords,
        canonicalPath: `/${detail.slug}`,
      },
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: detail.name,
          description: detail.seoDescription ?? detail.shortDescription ?? detail.name,
        },
      ],
    };

    return landing;
  },

  async collections(query: CollectionListQuery): Promise<CollectionDto[]> {
    const rows = await storefrontRepository.findActiveCollections();

    return rows
      .filter((row) => query.includeEmpty || row._count.products > 0)
      .map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        type: row.type,
        description: row.description,
        imageMediaId: row.imageMediaId,
        bannerMediaId: row.bannerMediaId,
        mobileBannerMediaId: row.mobileBannerMediaId,
        productCount: row._count.products,
        startsAt: row.startsAt?.toISOString() ?? null,
        endsAt: row.endsAt?.toISOString() ?? null,
        lastEvaluatedAt: row.lastEvaluatedAt?.toISOString() ?? null,
      }));
  },

  async collectionBySlug(
    slug: string,
    query: StorefrontListQuery,
    identity: ListingIdentity,
  ): Promise<{ collection: CollectionDto; products: ListingResponse }> {
    const collection = await storefrontRepository.findCollectionBySlug(slug);
    if (!collection) throw AppError.notFound(`Collection "${slug}" not found`, { slug });

    const products = await this.listProducts({ ...query, collectionSlug: slug }, identity);
    const productCount = await storefrontRepository.countCollectionProducts(collection.id);

    return {
      collection: {
        id: collection.id,
        slug: collection.slug,
        name: collection.name,
        type: collection.type,
        description: collection.description,
        imageMediaId: collection.imageMediaId,
        bannerMediaId: collection.bannerMediaId,
        mobileBannerMediaId: collection.mobileBannerMediaId,
        productCount,
        startsAt: collection.startsAt?.toISOString() ?? null,
        endsAt: collection.endsAt?.toISOString() ?? null,
        lastEvaluatedAt: collection.lastEvaluatedAt?.toISOString() ?? null,
      },
      products,
    };
  },

  /** Recently-viewed strips and the compare tray: many slugs, one round trip. */
  async batch(input: ProductBatchInput, identity: ListingIdentity): Promise<ProductCardDto[]> {
    const bySlug = input.slugs?.length
      ? await Promise.all(input.slugs.map((slug) => storefrontRepository.findCardBySlug(slug)))
      : [];

    const byId = input.ids?.length ? await storefrontRepository.findCards(input.ids) : [];

    const rows = [...bySlug.filter((row) => row !== null), ...byId];
    const unique = [...new Map(rows.map((row) => [row.id, row])).values()];

    const [prices, indexed, merchandising] = await Promise.all([
      productQueryService.resolveDisplayPrices(unique, identity),
      productQueryService.priceIndex(unique.map((row) => row.id)),
      loadMerchandising(),
    ]);

    return unique.map((row) =>
      toProductCard(
        row,
        {
          pricePaise: prices.get(row.id) ?? row.basePricePaise,
          indexed: indexed.get(row.id) ?? { minPricePaise: null, maxPricePaise: null },
        },
        merchandising,
      ),
    );
  },
};
