import { createHash } from 'node:crypto';

import type { StorefrontListQuery } from '@shared/schemas/storefront';
import type { FacetDto, FacetValueDto, PriceBucketDto } from '@shared/types/storefront';

import { env } from '../../config/env';
import { cache } from '../../container';
import { attributeRepository } from '../../repositories/attribute.repository';
import {
  listingRepository,
  type FacetScan,
  type ListingFilter,
} from '../../repositories/listing.repository';
import { categoryAttributeService } from '../../services/categoryAttribute.service';
import { STOREFRONT_CACHE_PREFIXES } from '../catalog-admin/catalogCache.service';

import { withoutDimension, type ResolvedScope } from './listing.filters';

/**
 * Facet counting, as SQL aggregates over the same `ListingFilter` the grid used.
 *
 * THE RULE: a facet dimension is counted with its OWN selection removed, while every other filter
 * stays applied. That is why ticking "Beige" does not zero out "Charcoal" — the colour counts are
 * computed as if no colour were selected. Zero-count values come back `disabled`, never missing,
 * so the panel does not reflow under the pointer.
 *
 * Dimensions without a selection share two statements - one for attribute values, one scan for
 * brands, price buckets and the availability/rating/flag counters. Each dimension WITH a
 * selection costs one more statement over its own filter.
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

export interface FacetInput {
  query: StorefrontListQuery;
  scope: ResolvedScope;
  valueIdsByAttribute: Map<string, string[]>;
  filter: ListingFilter;
}

/**
 * Every filter the counts depend on, hashed in full: a missing or truncated input would hand one
 * filter set's counts to another.
 */
export function facetCacheKey(
  input: Pick<FacetInput, 'query' | 'scope' | 'valueIdsByAttribute'>,
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        input.query.categorySlug ?? '',
        input.query.collectionSlug ?? '',
        input.query.q ?? '',
        [...input.valueIdsByAttribute].map(([id, values]) => [id, [...values].sort()]).sort(),
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
        input.query.leadTimeMax ?? null,
      ]),
    )
    .digest('base64url');

  return `${STOREFRONT_CACHE_PREFIXES.facets}${digest}`;
}

function option(value: string, label: string, count: number, selected: boolean): FacetValueDto {
  return {
    value,
    label,
    count,
    disabled: count === 0,
    selected,
    colorHex: null,
    swatchMediaId: null,
  };
}

export const facetService = {
  async build(input: FacetInput): Promise<FacetDto[]> {
    return cache.wrap(facetCacheKey(input), env.STOREFRONT_CACHE_TTL_SECONDS, () =>
      this.compute(input),
    );
  },

  async compute(input: FacetInput): Promise<FacetDto[]> {
    const { query, scope, valueIdsByAttribute, filter } = input;

    /* Only attributes that are filterable AND resolvable for this scope may become a facet. */
    const attributes = await this.facetableAttributes(scope);
    const unselected = attributes.filter((attribute) => !valueIdsByAttribute.has(attribute.id));
    const selected = attributes.filter((attribute) => valueIdsByAttribute.has(attribute.id));

    const hasPriceFilter = query.priceMin !== undefined || query.priceMax !== undefined;
    const hasFlagFilter =
      query.madeToOrder !== undefined ||
      query.customizable !== undefined ||
      query.isNewArrival !== undefined ||
      query.isFeatured !== undefined ||
      query.onSale === true;

    // One scan per distinct filter: '' is the shared one, a dimension name drops that dimension.
    const scans = new Map<string, Promise<FacetScan>>();
    const scan = (dimension: string, active: boolean): Promise<FacetScan> => {
      const key = active ? dimension : '';
      let pending = scans.get(key);
      if (!pending) {
        pending = listingRepository.facetScan(
          key ? withoutDimension(filter, key) : filter,
          PRICE_BUCKETS,
        );
        scans.set(key, pending);
      }
      return pending;
    };

    const [unselectedCounts, selectedCounts, brandScan, priceScan, availability, rating, flags] =
      await Promise.all([
        listingRepository.attributeValueCounts(
          filter,
          unselected.map((attribute) => attribute.id),
        ),
        Promise.all(
          selected.map((attribute) =>
            listingRepository.attributeValueCounts(withoutDimension(filter, attribute.id), [
              attribute.id,
            ]),
          ),
        ),
        scan('brand', scope.brandIds.length > 0),
        scan('price', hasPriceFilter),
        scan('availability', query.inStockOnly === true).then((result) => result.dims),
        scan('rating', query.ratingMin !== undefined).then((result) => result.dims),
        scan('flags', hasFlagFilter).then((result) => result.dims),
      ]);
    const brands = brandScan.brands;
    const price = priceScan.histogram;

    const counts = new Map<string, number>();
    for (const row of [...unselectedCounts, ...selectedCounts.flat()]) {
      counts.set(`${row.attributeId}:${row.attributeValueId}`, row.count);
    }

    const facets: FacetDto[] = [];

    for (const attribute of attributes) {
      const chosen = valueIdsByAttribute.get(attribute.id) ?? [];

      const values: FacetValueDto[] = attribute.values.map((value) => {
        const count = counts.get(`${attribute.id}:${value.id}`) ?? 0;
        return {
          value: value.id,
          label: value.label,
          count,
          disabled: count === 0,
          selected: chosen.includes(value.id),
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

    facets.push({
      key: 'brand',
      kind: 'BRAND',
      label: 'Brand',
      attributeId: null,
      inputType: null,
      values: brands
        .map((row) =>
          option(
            row.brandId,
            row.name ?? row.brandId,
            row.count,
            scope.brandIds.includes(row.brandId),
          ),
        )
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    });

    facets.push(this.priceFacet(price));

    facets.push({
      key: 'availability',
      kind: 'AVAILABILITY',
      label: 'Availability',
      attributeId: null,
      inputType: null,
      values: [
        option('IN_STOCK', 'In stock', availability.inStock, query.inStockOnly === true),
        option(
          'OUT_OF_STOCK',
          'Out of stock',
          availability.total - availability.inStock,
          query.inStockOnly === false,
        ),
      ],
    });

    facets.push({
      key: 'rating',
      kind: 'RATING',
      label: 'Customer rating',
      attributeId: null,
      inputType: null,
      values: ([4, 3, 2, 1] as const).map((stars) =>
        option(
          String(stars),
          `${stars} stars & up`,
          rating.ratingAtLeast[stars],
          query.ratingMin === stars,
        ),
      ),
    });

    facets.push({
      key: 'flags',
      kind: 'FLAG',
      label: 'Other',
      attributeId: null,
      inputType: null,
      values: [
        option('madeToOrder', 'Made to order', flags.madeToOrder, query.madeToOrder === true),
        option('customizable', 'Customisable', flags.customizable, query.customizable === true),
        option('onSale', 'On sale', flags.onSale, query.onSale === true),
      ],
    });

    return facets;
  },

  /** Ten equal-width buckets over the set's indexed range; they sum to the result count. */
  priceFacet(histogram: FacetScan['histogram']): FacetDto {
    const base = {
      key: 'price',
      kind: 'PRICE' as const,
      label: 'Price',
      attributeId: null,
      inputType: null,
      values: [],
    };
    if (histogram.counts.size === 0) return { ...base, minPaise: 0, maxPaise: 0, buckets: [] };

    const { minPaise, maxPaise, step } = histogram;
    const buckets: PriceBucketDto[] = Array.from({ length: PRICE_BUCKETS }, (_, index) => ({
      fromPaise: minPaise + index * step,
      toPaise: index === PRICE_BUCKETS - 1 ? maxPaise : minPaise + (index + 1) * step - 1,
      count: histogram.counts.get(index) ?? 0,
    }));

    return { ...base, minPaise, maxPaise, buckets: buckets.filter((bucket) => bucket.count > 0) };
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
};
