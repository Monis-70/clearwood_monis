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
import { searchDocumentRepository } from '../../repositories/searchDocument.repository';
import {
  storefrontRepository,
  type ProductCardRow,
} from '../../repositories/storefront.repository';
import { AppError } from '../../utils/AppError';
import { pricingContextLoader } from '../pricing/pricingContext.loader';
import { pricingFacade } from '../pricing/pricing.facade';

import { toProductCard } from './card.mapper';
import {
  buildWhere,
  groupValueIdsByAttribute,
  resolveScope,
  type ResolvedScope,
} from './listing.filters';
import { settingsService } from './storefrontSettings.service';

/**
 * The listing engine.
 *
 * PRICE POLICY — filtering and sorting always run against `SearchDocument.minPricePaise`, which is
 * the DEFAULT customer group's price resolved by the Prompt 6 engine. The price each card DISPLAYS
 * is resolved for the caller's own group in a single batched quote. The response says which basis
 * was used so the two can never be confused.
 */

export interface ListingIdentity {
  customerId: string | null;
}

export interface PriceIndexEntry {
  minPricePaise: number | null;
  maxPricePaise: number | null;
}

interface Candidate {
  id: string;
  name: string;
  position: number;
  publishedAt: Date | null;
  createdAt: Date;
  soldCount: number;
  ratingAvgBp: number;
  ratingCount: number;
  basePricePaise: number;
  compareAtPricePaise: number | null;
  isMadeToOrder: boolean;
  stat: { popularityScore: number } | null;
  categories: { categoryId: string; position: number }[];
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

function defaultSort(query: StorefrontListQuery): ProductSort {
  if (query.sort) return query.sort;
  if (query.q) return 'RELEVANCE';
  if (query.collectionSlug) return 'CURATED';
  return 'POPULARITY';
}

function compare(
  sort: ProductSort,
  prices: Map<string, PriceIndexEntry>,
  relevance: Map<string, number>,
  scope: ResolvedScope,
  curatedOrder: Map<string, number>,
) {
  const priceOf = (id: string): number => prices.get(id)?.minPricePaise ?? Number.MAX_SAFE_INTEGER;

  return (a: Candidate, b: Candidate): number => {
    switch (sort) {
      case 'RELEVANCE':
        return (relevance.get(b.id) ?? 0) - (relevance.get(a.id) ?? 0) || a.id.localeCompare(b.id);
      case 'PRICE_ASC':
        return priceOf(a.id) - priceOf(b.id) || a.id.localeCompare(b.id);
      case 'PRICE_DESC':
        return priceOf(b.id) - priceOf(a.id) || a.id.localeCompare(b.id);
      case 'NEWEST':
        return (
          (b.publishedAt?.getTime() ?? b.createdAt.getTime()) -
            (a.publishedAt?.getTime() ?? a.createdAt.getTime()) || a.id.localeCompare(b.id)
        );
      case 'BEST_SELLING':
        return b.soldCount - a.soldCount || a.id.localeCompare(b.id);
      case 'RATING':
        return (
          b.ratingAvgBp - a.ratingAvgBp || b.ratingCount - a.ratingCount || a.id.localeCompare(b.id)
        );
      case 'NAME_ASC':
        return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
      case 'CURATED': {
        const rank = (candidate: Candidate): number => {
          const curated = curatedOrder.get(candidate.id);
          if (curated !== undefined) return curated;
          if (scope.categoryId) {
            const link = candidate.categories.find(
              (entry) => entry.categoryId === scope.categoryId,
            );
            if (link) return link.position;
          }
          return candidate.position;
        };
        return rank(a) - rank(b) || a.id.localeCompare(b.id);
      }
      case 'POPULARITY':
      default:
        return (
          (b.stat?.popularityScore ?? b.soldCount) - (a.stat?.popularityScore ?? a.soldCount) ||
          a.id.localeCompare(b.id)
        );
    }
  };
}

export interface ListingOutcome {
  listing: ProductListDto;
  page: number;
  limit: number;
  total: number;
  /** The fully filtered id set, reused by the facet service so it never re-queries. */
  candidateIds: string[];
  scope: ResolvedScope;
  valueIdsByAttribute: Map<string, string[]>;
  prices: Map<string, PriceIndexEntry>;
}

export const productQueryService = {
  async pricingBasis(customerId: string | null): Promise<PricingBasis> {
    if (!customerId) return 'DEFAULT_GROUP';

    const group = await pricingContextLoader.resolveCustomerGroup(customerId, null);
    return group && group.discountBp ? `CUSTOMER_GROUP:${group.code}` : 'DEFAULT_GROUP';
  },

  /**
   * Resolves the display price for a page of cards in ONE quote. The Prompt 6 engine already
   * accepts a multi-line cart, so a 24-card grid costs a single pricing context, not 24.
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
      const breakdown = await pricingFacade.quoteCart({
        items: chunk,
        channel: 'WEB',
        customerId: identity.customerId,
      });

      breakdown.lines.forEach((line, position) => {
        const row = chunk[position];
        if (row) resolved.set(row.productId, line.unitPricePaise);
      });
    }

    return resolved;
  },

  async list(query: StorefrontListQuery, identity: ListingIdentity): Promise<ListingOutcome> {
    const settings = await settingsService.read();
    const limit = Math.min(query.limit, settings.maxPageSize);
    const sort = defaultSort(query);

    if (sort === 'RELEVANCE' && !query.q) {
      throw AppError.validation('RELEVANCE sorting needs a search query', { field: 'sort' });
    }

    const scope = await resolveScope(query);
    const valueIdsByAttribute = await groupValueIdsByAttribute(
      query.attributeValueIds,
      storefrontRepository.findAttributeValueOwners,
    );

    /* A search query narrows the id set before any SQL filter runs. */
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

      if (searchIds.length === 0) {
        return this.empty(query, sort, limit, scope, valueIdsByAttribute);
      }
    }

    const where = buildWhere(query, {
      scope,
      valueIdsByAttribute,
      ...(searchIds ? { candidateIds: searchIds } : {}),
    });

    const candidates = (await storefrontRepository.findCandidates(where)) as Candidate[];
    const prices = await this.priceIndex(candidates.map((candidate) => candidate.id));

    const filtered = candidates.filter((candidate) => {
      const entry = prices.get(candidate.id);
      const price = entry?.minPricePaise ?? candidate.basePricePaise;

      if (query.priceMin !== undefined && price < query.priceMin) return false;
      if (query.priceMax !== undefined && price > query.priceMax) return false;

      if (query.onSale) {
        const hasCompareAt =
          candidate.compareAtPricePaise !== null &&
          candidate.compareAtPricePaise > candidate.basePricePaise;
        const discounted = price < candidate.basePricePaise;
        if (!hasCompareAt && !discounted) return false;
      }

      if (!settings.showOutOfStock && !query.inStockOnly) return true;
      return true;
    });

    const curatedOrder = new Map(scope.collectionOrder.map((id, index) => [id, index]));
    filtered.sort(compare(sort, prices, relevance, scope, curatedOrder));

    const orderedIds = filtered.map((candidate) => candidate.id);
    const mark = fingerprint(query, sort);

    let offset = (query.page - 1) * limit;
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor);
      if (decoded.fingerprint !== mark) {
        throw AppError.validation('That cursor belongs to a different filter set', {
          field: 'cursor',
        });
      }
      offset = decoded.offset;
    }

    const pageIds = orderedIds.slice(offset, offset + limit);
    const rows = await storefrontRepository.findCards(pageIds);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = pageIds
      .map((id) => byId.get(id))
      .filter((row): row is ProductCardRow => row !== undefined);

    const [displayPrices, basis, priceBounds] = await Promise.all([
      this.resolveDisplayPrices(ordered, identity),
      this.pricingBasis(identity.customerId),
      searchDocumentRepository.priceExtent(orderedIds),
    ]);

    const items = ordered.map((row) =>
      toProductCard(row, {
        pricePaise: displayPrices.get(row.id) ?? row.basePricePaise,
        indexed: prices.get(row.id) ?? { minPricePaise: null, maxPricePaise: null },
        ...(relevance.has(row.id) ? { relevanceScore: relevance.get(row.id)! } : {}),
      }),
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
        priceBounds,
        nextCursor: nextOffset < orderedIds.length ? encodeCursor(nextOffset, mark) : null,
        query: query.q ?? null,
        totalCount: orderedIds.length,
      },
      page: query.page,
      limit,
      total: orderedIds.length,
      candidateIds: orderedIds,
      scope,
      valueIdsByAttribute,
      prices,
    };
  },

  async priceIndex(productIds: string[]): Promise<Map<string, PriceIndexEntry>> {
    const rows = await searchDocumentRepository.findPriceBounds(productIds);
    return new Map(
      rows.map((row) => [
        row.entityId,
        { minPricePaise: row.minPricePaise, maxPricePaise: row.maxPricePaise },
      ]),
    );
  },

  async empty(
    query: StorefrontListQuery,
    sort: ProductSort,
    limit: number,
    scope: ResolvedScope,
    valueIdsByAttribute: Map<string, string[]>,
  ): Promise<ListingOutcome> {
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
      candidateIds: [],
      scope,
      valueIdsByAttribute,
      prices: new Map(),
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
