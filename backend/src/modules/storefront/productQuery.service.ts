import { createHash } from 'node:crypto';

import type { ProductSort } from '@shared/enums';
import type { StorefrontListQuery } from '@shared/schemas/storefront';
import type {
  AppliedFilterDto,
  PricingBasis,
  ProductListDto,
  SortOptionDto,
} from '@shared/types/storefront';

import { env } from '../../config/env';
import { search } from '../../container';
import {
  listingRepository,
  type ListingFilter,
  type ListingOrder,
} from '../../repositories/listing.repository';
import {
  storefrontRepository,
  type ProductCardRow,
} from '../../repositories/storefront.repository';
import { AppError } from '../../utils/AppError';
import { pricingContextLoader } from '../pricing/pricingContext.loader';
import { pricingFacade } from '../pricing/pricing.facade';

import { toProductCard } from './card.mapper';
import { listingIndexService } from './listingIndex.service';
import {
  buildListingFilter,
  groupValueIdsByAttribute,
  resolveScope,
  type ResolvedScope,
} from './listing.filters';
import { merchandisingAt, type MerchandisingContext } from './merchandising';
import { settingsService } from './storefrontSettings.service';

/**
 * The listing engine.
 *
 * MySQL filters, sorts, counts and paginates (listing.repository); Node shapes one page of cards.
 *
 * PRICE POLICY - filtering and sorting run against the catalog listing index, the DEFAULT customer
 * group's price resolved by the Prompt 6 engine (listingIndex.service). The price each card
 * DISPLAYS is resolved for the caller's own group in a single batched quote. The response says
 * which basis was used so the two can never be confused.
 */

export interface ListingIdentity {
  customerId: string | null;
}

export interface PriceIndexEntry {
  minPricePaise: number | null;
  maxPricePaise: number | null;
}

const SORT_LABELS: Record<ProductSort, string> = {
  RELEVANCE: 'Most relevant',
  PRICE_ASC: 'Price: low to high',
  PRICE_DESC: 'Price: high to low',
  NEWEST: 'Newest first',
  POPULARITY: 'Most popular',
  BEST_SELLING: 'Best selling',
  RATING: 'Top rated',
  NAME_ASC: 'Name: A to Z',
  CURATED: 'Recommended',
};

function encodeCursor(offset: number, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ o: offset, f: fingerprint })).toString('base64url');
}

function decodeCursor(cursor: string): { offset: number; fingerprint: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      o?: unknown;
      f?: unknown;
    };
    if (typeof parsed.o !== 'number' || typeof parsed.f !== 'string') throw new Error('shape');
    return { offset: parsed.o, fingerprint: parsed.f };
  } catch {
    throw AppError.validation('That cursor is not valid', { field: 'cursor' });
  }
}

/** Identifies the filter set a cursor belongs to, so changing a filter cannot skip rows. */
function fingerprint(query: StorefrontListQuery, sort: ProductSort): string {
  return createHash('sha1')
    .update(
      JSON.stringify([
        query.q ?? '',
        query.categorySlug ?? '',
        query.collectionSlug ?? '',
        [...query.brandIds].sort(),
        [...query.brandSlugs].sort(),
        [...query.attributeValueIds].sort(),
        query.priceMin ?? null,
        query.priceMax ?? null,
        query.inStockOnly ?? null,
        query.madeToOrder ?? null,
        query.customizable ?? null,
        query.isNewArrival ?? null,
        query.isFeatured ?? null,
        query.onSale ?? null,
        query.ratingMin ?? null,
        query.leadTimeMax ?? null,
        sort,
      ]),
    )
    .digest('base64url')
    .slice(0, 16);
}

function defaultSort(query: StorefrontListQuery, scope: ResolvedScope): ProductSort {
  if (query.sort) return query.sort;
  if (query.q) return 'RELEVANCE';
  if (query.collectionSlug) return 'CURATED';
  if (scope.categoryRule?.kind === 'NEW_ARRIVALS') return 'NEWEST';
  return 'POPULARITY';
}

/** Everything a page and its facets need, resolved once per request before any SQL runs. */
export interface PreparedListing {
  query: StorefrontListQuery;
  sort: ProductSort;
  limit: number;
  offset: number;
  fingerprint: string;
  scope: ResolvedScope;
  valueIdsByAttribute: Map<string, string[]>;
  filter: ListingFilter;
  order: ListingOrder;
  relevance: Map<string, number>;
  /** The moment and settings every card of this page is judged by. */
  merchandising: MerchandisingContext;
  /** A search query that matched nothing: no SQL needs to run. */
  noMatches: boolean;
}

export interface ListingPage {
  listing: ProductListDto;
  page: number;
  limit: number;
  total: number;
}

/**
 * Whose prices a catalog response shows. `key` is shared by every shopper priced identically - an
 * anonymous visitor and a signed-in customer of the default group who has not ordered yet get the
 * same unit prices, so they may share one cached grid; any other group, or a returning customer
 * (rules may be conditioned on `isFirstOrder`), gets its own.
 */
export interface PricingAudience {
  key: string;
  basis: PricingBasis;
}

const ANONYMOUS: PricingAudience = { key: 'anon', basis: 'DEFAULT_GROUP' };

export const productQueryService = {
  async pricingAudience(customerId: string | null): Promise<PricingAudience> {
    if (!customerId) return ANONYMOUS;

    const { group, isFirstOrder } = await pricingContextLoader.catalogAudience(customerId);
    const isDefault = !group || group.isDefault === true;
    if (isDefault && isFirstOrder) return ANONYMOUS;

    return {
      key: `g${group?.id ?? '-'}:${isFirstOrder ? 'first' : 'returning'}`,
      basis: isDefault ? 'DEFAULT_GROUP' : `CUSTOMER_GROUP:${group!.code}`,
    };
  },

  async pricingBasis(customerId: string | null): Promise<PricingBasis> {
    return (await this.pricingAudience(customerId)).basis;
  },

  /**
   * The display price of every card: its default variant, one unit, for the caller - each priced
   * as if bought on its own (`quoteEach`), from one pricing context per chunk of cards.
   */
  async resolveDisplayPrices(
    rows: ProductCardRow[],
    identity: ListingIdentity,
  ): Promise<Map<string, number>> {
    const resolved = new Map<string, number>();
    if (rows.length === 0) return resolved;

    const items = rows.map((row) => ({
      productId: row.id,
      variantId: row.variants.find((variant) => variant.isDefault)?.id ?? null,
      qty: 1,
    }));

    const chunkSize = env.PRICING_MAX_QUOTE_ITEMS;

    for (let index = 0; index < items.length; index += chunkSize) {
      const chunk = items.slice(index, index + chunkSize);
      const lines = await pricingFacade.quoteEach({
        items: chunk,
        channel: 'WEB',
        customerId: identity.customerId,
      });

      lines.forEach((line, position) => {
        const row = chunk[position];
        if (row) resolved.set(row.productId, line.unitPricePaise);
      });
    }

    return resolved;
  },

  /** Resolves scope, search hits, filter, order and offset: the inputs of a page and its facets. */
  async prepare(query: StorefrontListQuery): Promise<PreparedListing> {
    const settings = await settingsService.read();
    const limit = Math.min(query.limit, settings.maxPageSize);
    const merchandising = merchandisingAt(settings);

    const scope = await resolveScope(query);
    const sort = defaultSort(query, scope);

    if (sort === 'RELEVANCE' && !query.q) {
      throw AppError.validation('RELEVANCE sorting needs a search query', { field: 'sort' });
    }

    const valueIdsByAttribute = await groupValueIdsByAttribute(
      query.attributeValueIds,
      storefrontRepository.findAttributeValueOwners,
    );

    /* A search query narrows the id set to its (bounded) hit list before any SQL filter runs. */
    const relevance = new Map<string, number>();
    let searchIds: string[] | undefined;

    if (query.q) {
      const result = await search.search({
        q: query.q,
        entityTypes: ['PRODUCT'],
        limit: env.SEARCH_MAX_RESULTS,
      });
      searchIds = result.hits.map((hit) => hit.entityId);
      for (const hit of result.hits) relevance.set(hit.entityId, hit.score);
    }

    const noMatches = searchIds !== undefined && searchIds.length === 0;
    const mark = fingerprint(query, sort);

    let offset = (query.page - 1) * limit;
    if (query.cursor && !noMatches) {
      const decoded = decodeCursor(query.cursor);
      if (decoded.fingerprint !== mark) {
        throw AppError.validation('That cursor belongs to a different filter set', {
          field: 'cursor',
        });
      }
      offset = decoded.offset;
    }

    // Highest score first; equal scores in id order, exactly as before the sort moved to SQL.
    const rankedIds = [...relevance]
      .sort(([a, scoreA], [b, scoreB]) => scoreB - scoreA || a.localeCompare(b))
      .map(([id]) => id);

    return {
      query,
      sort,
      limit,
      offset,
      fingerprint: mark,
      scope,
      valueIdsByAttribute,
      filter: buildListingFilter(query, {
        scope,
        valueIdsByAttribute,
        ...(searchIds ? { searchIds } : {}),
        hideOutOfStock: !settings.showOutOfStock,
        now: merchandising.now,
        newArrivalSince: merchandising.newArrivalSince,
      }),
      order: {
        sort,
        collectionId: scope.collectionId,
        categoryId: scope.categoryId,
        rankedIds,
      },
      relevance,
      merchandising,
      noMatches,
    };
  },

  /** One page: ids, total and price bounds from MySQL, then cards and live prices for that page. */
  async page(prepared: PreparedListing, identity: ListingIdentity): Promise<ListingPage> {
    const { query, sort, limit, offset, scope, relevance } = prepared;
    if (prepared.noMatches) return this.empty(query, sort, limit, scope);

    const { rows, summary } = await listingRepository.page(
      prepared.filter,
      prepared.order,
      offset,
      limit,
    );

    const cards = await storefrontRepository.findCards(rows.map((row) => row.id));
    const byId = new Map(cards.map((row) => [row.id, row]));
    const ordered = rows
      .map((row) => byId.get(row.id))
      .filter((row): row is ProductCardRow => row !== undefined);
    const indexed = new Map(rows.map((row) => [row.id, row]));

    const [displayPrices, basis] = await Promise.all([
      this.resolveDisplayPrices(ordered, identity),
      this.pricingBasis(identity.customerId),
    ]);

    const items = ordered.map((row) =>
      toProductCard(
        row,
        {
          pricePaise: displayPrices.get(row.id) ?? row.basePricePaise,
          indexed: {
            minPricePaise: indexed.get(row.id)?.minPricePaise ?? null,
            maxPricePaise: indexed.get(row.id)?.maxPricePaise ?? null,
          },
          ...(relevance.has(row.id) ? { relevanceScore: relevance.get(row.id)! } : {}),
        },
        prepared.merchandising,
      ),
    );

    const nextOffset = offset + limit;

    return {
      listing: {
        items,
        facets: [],
        appliedFilters: describeFilters(query, scope),
        availableSorts: sortOptions(Boolean(query.q)),
        sort,
        pricingBasis: basis,
        priceBounds:
          summary.total > 0
            ? { minPaise: summary.minPricePaise, maxPaise: summary.maxPricePaise }
            : { minPaise: 0, maxPaise: 0 },
        nextCursor:
          nextOffset < summary.total ? encodeCursor(nextOffset, prepared.fingerprint) : null,
        query: query.q ?? null,
        totalCount: summary.total,
      },
      page: query.page,
      limit,
      total: summary.total,
    };
  },

  async list(query: StorefrontListQuery, identity: ListingIdentity): Promise<ListingPage> {
    return this.page(await this.prepare(query), identity);
  },

  /** The listing index's default-group range for cards shown outside a listing page. */
  async priceIndex(productIds: string[]): Promise<Map<string, PriceIndexEntry>> {
    return listingIndexService.read(productIds);
  },

  async empty(
    query: StorefrontListQuery,
    sort: ProductSort,
    limit: number,
    scope: ResolvedScope,
  ): Promise<ListingPage> {
    return {
      listing: {
        items: [],
        facets: [],
        appliedFilters: describeFilters(query, scope),
        availableSorts: sortOptions(Boolean(query.q)),
        sort,
        pricingBasis: await this.pricingBasis(null),
        priceBounds: { minPaise: 0, maxPaise: 0 },
        nextCursor: null,
        query: query.q ?? null,
        totalCount: 0,
      },
      page: query.page,
      limit,
      total: 0,
    };
  },
};

function sortOptions(hasQuery: boolean): SortOptionDto[] {
  return (Object.keys(SORT_LABELS) as ProductSort[]).map((value) => ({
    value,
    label: SORT_LABELS[value],
    available: value === 'RELEVANCE' ? hasQuery : true,
  }));
}

function describeFilters(query: StorefrontListQuery, scope: ResolvedScope): AppliedFilterDto[] {
  const applied: AppliedFilterDto[] = [];

  if (query.categorySlug) {
    applied.push({ key: 'categorySlug', values: [query.categorySlug], label: 'Category' });
  }
  if (query.collectionSlug) {
    applied.push({ key: 'collectionSlug', values: [query.collectionSlug], label: 'Collection' });
  }
  if (scope.brandIds.length > 0) {
    applied.push({ key: 'brandIds', values: scope.brandIds, label: 'Brand' });
  }
  if (query.attributeValueIds.length > 0) {
    applied.push({
      key: 'attributeValueIds',
      values: query.attributeValueIds,
      label: 'Options',
    });
  }
  if (query.priceMin !== undefined || query.priceMax !== undefined) {
    applied.push({
      key: 'price',
      values: [String(query.priceMin ?? ''), String(query.priceMax ?? '')],
      label: 'Price',
    });
  }
  for (const [key, label] of [
    ['inStockOnly', 'In stock'],
    ['madeToOrder', 'Made to order'],
    ['customizable', 'Customisable'],
    ['isNewArrival', 'New arrivals'],
    ['isFeatured', 'Featured'],
    ['onSale', 'On sale'],
  ] as const) {
    const value = query[key];
    if (value !== undefined) applied.push({ key, values: [String(value)], label });
  }
  if (query.ratingMin !== undefined) {
    applied.push({ key: 'ratingMin', values: [String(query.ratingMin)], label: 'Rating' });
  }
  if (query.leadTimeMax !== undefined) {
    applied.push({ key: 'leadTimeMax', values: [String(query.leadTimeMax)], label: 'Lead time' });
  }

  return applied;
}
