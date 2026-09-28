import { createHash } from 'node:crypto';

import type { Collection } from '@prisma/client';

import { PUBLIC_IMAGE_RENDITIONS } from '@shared/constants';
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
import {
  publicImageService,
  type ImageRequest,
  type PublicImages,
} from '../media/publicImage.service';

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

type CollectionRow = Pick<
  Collection,
  | 'id'
  | 'slug'
  | 'name'
  | 'type'
  | 'description'
  | 'imageMediaId'
  | 'bannerMediaId'
  | 'mobileBannerMediaId'
  | 'startsAt'
  | 'endsAt'
  | 'lastEvaluatedAt'
>;

/** Every collection's image and banners, for one statement (PROJECT_CONTEXT §51). */
function collectionImageRequests(rows: CollectionRow[]): ImageRequest[] {
  return [
    { ids: rows.map((row) => row.imageMediaId), labels: PUBLIC_IMAGE_RENDITIONS.collectionImage },
    {
      ids: rows.flatMap((row) => [row.bannerMediaId, row.mobileBannerMediaId]),
      labels: PUBLIC_IMAGE_RENDITIONS.collectionBanner,
    },
  ];
}

function toCollectionDto(
  row: CollectionRow,
  productCount: number,
  images: PublicImages,
): CollectionDto {
  const { collectionImage, collectionBanner } = PUBLIC_IMAGE_RENDITIONS;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type,
    description: row.description,
    imageMediaId: row.imageMediaId,
    bannerMediaId: row.bannerMediaId,
    mobileBannerMediaId: row.mobileBannerMediaId,
    image: images.get(row.imageMediaId, collectionImage),
    banner: images.get(row.bannerMediaId, collectionBanner),
    mobileBanner: images.get(row.mobileBannerMediaId, collectionBanner),
    productCount,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    lastEvaluatedAt: row.lastEvaluatedAt?.toISOString() ?? null,
  };
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
    // The landing resolves its own renditions (banner and tile sets), in one statement.
    const detail = await categoryService.getBySlug(slug, { resolveMedia: false });

    const scoped: StorefrontListQuery = {
      ...query,
      categorySlug: slug,
      page: 1,
      limit: 8,
      sort: 'POPULARITY',
      includeFacets: false,
    };

    const { banner, categoryTile } = PUBLIC_IMAGE_RENDITIONS;
    // Images first: a cold swatch map is read in their statement, and the cards and facets join it.
    const [images, featured, facetDefaults] = await Promise.all([
      publicImageService.loadWithSwatches([
        { ids: [detail.bannerMediaId, detail.mobileBannerMediaId], labels: banner },
        { ids: detail.children.map((child) => child.iconMediaId), labels: categoryTile },
      ]),
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
      iconMediaId: child.iconMediaId,
      iconMedia: images.get(child.iconMediaId, categoryTile),
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
        bannerMedia: images.get(detail.bannerMediaId, banner),
        mobileBannerMedia: images.get(detail.mobileBannerMediaId, banner),
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
    const shown = rows.filter((row) => query.includeEmpty || row._count.products > 0);
    const images = await publicImageService.load(collectionImageRequests(shown));

    return shown.map((row) => toCollectionDto(row, row._count.products, images));
  },

  async collectionBySlug(
    slug: string,
    query: StorefrontListQuery,
    identity: ListingIdentity,
  ): Promise<{ collection: CollectionDto; products: ListingResponse }> {
    const collection = await storefrontRepository.findCollectionBySlug(slug);
    if (!collection) throw AppError.notFound(`Collection "${slug}" not found`, { slug });

    // Images first, as on a landing: a cold swatch map is read in their statement.
    const [images, products, productCount] = await Promise.all([
      publicImageService.loadWithSwatches(collectionImageRequests([collection])),
      this.listProducts({ ...query, collectionSlug: slug }, identity),
      storefrontRepository.countCollectionProducts(collection.id),
    ]);

    return { collection: toCollectionDto(collection, productCount, images), products };
  },

  /** Recently-viewed strips and the compare tray: many slugs, one round trip. */
  async batch(input: ProductBatchInput, identity: ListingIdentity): Promise<ProductCardDto[]> {
    const bySlug = input.slugs?.length
      ? await Promise.all(input.slugs.map((slug) => storefrontRepository.findCardBySlug(slug)))
      : [];

    const byId = input.ids?.length ? await storefrontRepository.findCards(input.ids) : [];

    const rows = [...bySlug.filter((row) => row !== null), ...byId];
    const unique = [...new Map(rows.map((row) => [row.id, row])).values()];

    const [prices, indexed, merchandising, swatchImages] = await Promise.all([
      productQueryService.resolveDisplayPrices(unique, identity),
      productQueryService.priceIndex(unique.map((row) => row.id)),
      loadMerchandising(),
      publicImageService.swatchesForCards(unique),
    ]);

    return unique.map((row) =>
      toProductCard(
        row,
        {
          pricePaise: prices.get(row.id) ?? row.basePricePaise,
          indexed: indexed.get(row.id) ?? { minPricePaise: null, maxPricePaise: null },
        },
        merchandising,
        swatchImages,
      ),
    );
  },
};
