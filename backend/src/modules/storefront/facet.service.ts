import type { StorefrontListQuery } from '@shared/schemas/storefront';
import type { FacetDto, FacetValueDto, PriceBucketDto } from '@shared/types/storefront';

import { env } from '../../config/env';
import { cache } from '../../container';
import { attributeRepository } from '../../repositories/attribute.repository';
import { storefrontRepository } from '../../repositories/storefront.repository';
import { categoryAttributeService } from '../../services/categoryAttribute.service';
import { STOREFRONT_CACHE_PREFIXES } from '../catalog-admin/catalogCache.service';

import { buildWhere, type ResolvedScope } from './listing.filters';
import type { PriceIndexEntry } from './productQuery.service';

/**
 * Facet counting.
 *
 * THE RULE: a facet dimension is counted with its OWN selection removed, while every other filter
 * stays applied. That is why ticking "Beige" does not zero out "Charcoal" — the colour counts are
 * computed as if no colour were selected. Zero-count values come back `disabled`, never missing,
 * so the panel does not reflow under the pointer.
 */

const PRICE_BUCKETS = 10;

interface FacetableAttribute {
  id: string;
  code: string;
  name: string;
  inputType: string;
  values: {
    id: string;
    label: string;
    colorHex: string | null;
    swatchMediaId: string | null;
  }[];
}

interface FacetInput {
  query: StorefrontListQuery;
  scope: ResolvedScope;
  valueIdsByAttribute: Map<string, string[]>;
  /** The fully filtered id set from the listing — reused instead of re-queried. */
  candidateIds: string[];
  prices: Map<string, PriceIndexEntry>;
  searchIds?: string[] | undefined;
}

function hashOf(input: FacetInput): string {
  return Buffer.from(
    JSON.stringify([
      input.query.categorySlug ?? '',
      input.query.collectionSlug ?? '',
      input.query.q ?? '',
      [...input.valueIdsByAttribute].sort(),
      [...input.scope.brandIds].sort(),
      input.query.priceMin ?? null,
      input.query.priceMax ?? null,
      input.query.inStockOnly ?? null,
      input.query.madeToOrder ?? null,
      input.query.customizable ?? null,
      input.query.isNewArrival ?? null,
      input.query.isFeatured ?? null,
      input.query.onSale ?? null,
      input.query.ratingMin ?? null,
    ]),
  )
    .toString('base64url')
    .slice(0, 40);
}

function priceOf(id: string, prices: Map<string, PriceIndexEntry>, fallback: number): number {
  return prices.get(id)?.minPricePaise ?? fallback;
}

type AttributePair = Awaited<ReturnType<typeof storefrontRepository.findAttributePairs>>[number];

/** Counts one attribute's values out of an already-fetched pair set. */
function countPairs(pairs: AttributePair[], attributeId: string): Map<string, number> {
  const seen = new Set<string>();
  const counts = new Map<string, number>();

  for (const pair of pairs) {
    if (pair.attributeId !== attributeId) continue;

    // A value counts once per product, even when five variants carry it.
    const dedupe = `${pair.productId}:${pair.attributeValueId}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    counts.set(pair.attributeValueId, (counts.get(pair.attributeValueId) ?? 0) + 1);
  }

  return counts;
}

export const facetService = {
  /**
   * Runs ONE id query per dimension that actually has a selection. Unselected dimensions all share
   * the fully filtered set, which is already in hand — so a grid with no filters costs no extra
   * queries at all.
   */
  async build(input: FacetInput): Promise<FacetDto[]> {
    const key = `${STOREFRONT_CACHE_PREFIXES.facets}${hashOf(input)}`;
    const cached = await cache.get<FacetDto[]>(key);
    if (cached) return cached;

    const facets = await this.compute(input);
    await cache.set(key, facets, env.STOREFRONT_CACHE_TTL_SECONDS);
    return facets;
  },

  async compute(input: FacetInput): Promise<FacetDto[]> {
    const { query, scope, valueIdsByAttribute, candidateIds } = input;

    /* Only attributes that are filterable AND resolvable for this scope may become a facet. */
    const attributes = await this.facetableAttributes(scope);

    const facets: FacetDto[] = [];

    /*
     * Every attribute counts over the SAME pair rows unless it has a selection of its own, so the
     * pairs are fetched once per distinct candidate set rather than once per attribute. With
     * fourteen filterable attributes and no selection that is one query instead of fourteen, and
     * the count stops growing with the attribute set.
     */
    const pairsByIdSet = new Map<string, Promise<AttributePair[]>>();
    const pairsFor = (ids: string[]): Promise<AttributePair[]> => {
      const key = ids.join(',');
      const hit = pairsByIdSet.get(key);
      if (hit) return hit;

      const pending = storefrontRepository.findAttributePairs(ids);
      pairsByIdSet.set(key, pending);
      return pending;
    };

    for (const attribute of attributes) {
      const selected = valueIdsByAttribute.get(attribute.id) ?? [];
      const ids = selected.length ? await this.idsWithout(input, attribute.id) : candidateIds;

      const counts = countPairs(await pairsFor(ids), attribute.id);

      const values: FacetValueDto[] = attribute.values.map((value) => {
        const count = counts.get(value.id) ?? 0;
        return {
          value: value.id,
          label: value.label,
          count,
          disabled: count === 0,
          selected: selected.includes(value.id),
          colorHex: value.colorHex,
          swatchMediaId: value.swatchMediaId,
        };
      });

      if (values.every((value) => value.count === 0)) continue;

      facets.push({
        key: attribute.code,
        kind: 'ATTRIBUTE',
        label: attribute.name,
        attributeId: attribute.id,
        inputType: attribute.inputType,
        values,
      });
    }

    facets.push(await this.brandFacet(input));
    facets.push(await this.priceFacet(input));
    facets.push(await this.availabilityFacet(input));
    facets.push(await this.ratingFacet(input));
    facets.push(this.flagFacet(query, candidateIds.length));

    return facets;
  },

  async facetableAttributes(scope: ResolvedScope): Promise<FacetableAttribute[]> {
    if (!scope.categoryId) return attributeRepository.findFilterable();

    const resolved = await categoryAttributeService.resolveForCategory(scope.categoryId);

    return resolved
      .filter((entry) => entry.isFilterable && entry.isFilterableForCategory)
      .map((entry) => ({
        id: entry.id,
        code: entry.code,
        name: entry.name,
        inputType: entry.inputType,
        values: entry.values.map((value) => ({
          id: value.id,
          label: value.label,
          colorHex: value.colorHex,
          swatchMediaId: value.swatchMediaId,
        })),
      }));
  },

  /** The candidate set recomputed with exactly one dimension's filters removed. */
  async idsWithout(input: FacetInput, dimension: string): Promise<string[]> {
    const where = buildWhere(input.query, {
      scope: input.scope,
      valueIdsByAttribute: input.valueIdsByAttribute,
      exclude: dimension,
      ...(input.searchIds ? { candidateIds: input.searchIds } : {}),
    });

    const rows = await storefrontRepository.findIds(where, [{ id: 'asc' }]);
    return rows.map((row) => row.id);
  },

  async attributeCounts(productIds: string[], attributeId: string): Promise<Map<string, number>> {
    return countPairs(await storefrontRepository.findAttributePairs(productIds), attributeId);
  },

  async brandFacet(input: FacetInput): Promise<FacetDto> {
    const ids = input.scope.brandIds.length
      ? await this.idsWithout(input, 'brand')
      : input.candidateIds;

    const counts = await storefrontRepository.countByBrand(ids);
    const brands = await storefrontRepository.findBrandsByIds(counts.map((row) => row.brandId));
    const byId = new Map(brands.map((brand) => [brand.id, brand]));

    return {
      key: 'brand',
      kind: 'BRAND',
      label: 'Brand',
      attributeId: null,
      inputType: null,
      values: counts
        .map((row) => ({
          value: row.brandId,
          label: byId.get(row.brandId)?.name ?? row.brandId,
          count: row.count,
          disabled: row.count === 0,
          selected: input.scope.brandIds.includes(row.brandId),
          colorHex: null,
          swatchMediaId: null,
        }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    };
  },

  /** Ten equal-width buckets over the scope's indexed range; they sum to the result count. */
  async priceFacet(input: FacetInput): Promise<FacetDto> {
    const hasPriceFilter = input.query.priceMin !== undefined || input.query.priceMax !== undefined;
    const ids = hasPriceFilter ? await this.idsWithout(input, 'price') : input.candidateIds;

    const prices = ids
      .map((id) => priceOf(id, input.prices, Number.NaN))
      .filter((price) => Number.isFinite(price));

    if (prices.length === 0) {
      return {
        key: 'price',
        kind: 'PRICE',
        label: 'Price',
        attributeId: null,
        inputType: null,
        values: [],
        minPaise: 0,
        maxPaise: 0,
        buckets: [],
      };
    }

    const minPaise = Math.min(...prices);
    const maxPaise = Math.max(...prices);
    const span = Math.max(maxPaise - minPaise, 1);
    const step = Math.ceil(span / PRICE_BUCKETS);

    const buckets: PriceBucketDto[] = Array.from({ length: PRICE_BUCKETS }, (_, index) => ({
      fromPaise: minPaise + index * step,
      toPaise: index === PRICE_BUCKETS - 1 ? maxPaise : minPaise + (index + 1) * step - 1,
      count: 0,
    }));

    for (const price of prices) {
      const index = Math.min(Math.floor((price - minPaise) / step), PRICE_BUCKETS - 1);
      buckets[index]!.count += 1;
    }

    return {
      key: 'price',
      kind: 'PRICE',
      label: 'Price',
      attributeId: null,
      inputType: null,
      values: [],
      minPaise,
      maxPaise,
      buckets: buckets.filter((bucket) => bucket.count > 0 || buckets.length === 1),
    };
  },

  async availabilityFacet(input: FacetInput): Promise<FacetDto> {
    const ids =
      input.query.inStockOnly === undefined
        ? input.candidateIds
        : await this.idsWithout(input, 'availability');

    const stock = await storefrontRepository.findStockByProduct(ids);
    const inStock = new Set(stock.filter((row) => row.stockQty > 0).map((row) => row.productId));
    const flags = await storefrontRepository.findFlagsAndRatings(ids);
    const madeToOrder = new Set(flags.filter((row) => row.isMadeToOrder).map((row) => row.id));

    const available = ids.filter((id) => inStock.has(id) || madeToOrder.has(id)).length;

    return {
      key: 'availability',
      kind: 'AVAILABILITY',
      label: 'Availability',
      attributeId: null,
      inputType: null,
      values: [
        {
          value: 'IN_STOCK',
          label: 'In stock',
          count: available,
          disabled: available === 0,
          selected: input.query.inStockOnly === true,
          colorHex: null,
          swatchMediaId: null,
        },
        {
          value: 'OUT_OF_STOCK',
          label: 'Out of stock',
          count: ids.length - available,
          disabled: ids.length - available === 0,
          selected: input.query.inStockOnly === false,
          colorHex: null,
          swatchMediaId: null,
        },
      ],
    };
  },

  async ratingFacet(input: FacetInput): Promise<FacetDto> {
    const ids =
      input.query.ratingMin === undefined
        ? input.candidateIds
        : await this.idsWithout(input, 'rating');

    const rows = await storefrontRepository.findFlagsAndRatings(ids);

    const values: FacetValueDto[] = [4, 3, 2, 1].map((stars) => {
      const count = rows.filter((row) => row.ratingAvgBp >= stars * 10_000).length;
      return {
        value: String(stars),
        label: `${stars} stars & up`,
        count,
        disabled: count === 0,
        selected: input.query.ratingMin === stars,
        colorHex: null,
        swatchMediaId: null,
      };
    });

    return {
      key: 'rating',
      kind: 'RATING',
      label: 'Customer rating',
      attributeId: null,
      inputType: null,
      values,
    };
  },

  flagFacet(query: StorefrontListQuery, total: number): FacetDto {
    return {
      key: 'flags',
      kind: 'FLAG',
      label: 'Other',
      attributeId: null,
      inputType: null,
      values: [
        {
          value: 'madeToOrder',
          label: 'Made to order',
          count: total,
          disabled: false,
          selected: query.madeToOrder === true,
          colorHex: null,
          swatchMediaId: null,
        },
        {
          value: 'customizable',
          label: 'Customisable',
          count: total,
          disabled: false,
          selected: query.customizable === true,
          colorHex: null,
          swatchMediaId: null,
        },
        {
          value: 'onSale',
          label: 'On sale',
          count: total,
          disabled: false,
          selected: query.onSale === true,
          colorHex: null,
          swatchMediaId: null,
        },
      ],
    };
  },
};
