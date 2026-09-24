import {
  BROWSE_VISIBILITIES,
  SEARCH_VISIBILITIES,
  isRuleCategoryKind,
  type RuleCategoryKind,
} from '@shared/enums';
import type { StorefrontListQuery } from '@shared/schemas/storefront';

import type { ListingFilter } from '../../repositories/listing.repository';
import { storefrontRepository } from '../../repositories/storefront.repository';
import { categoryService } from '../../services/category.service';
import { AppError } from '../../utils/AppError';

/**
 * Turns a validated storefront query into the `ListingFilter` MySQL evaluates, plus the scope it
 * resolved. The grid and the facets use the same filter, so a facet can never count a different
 * population than the grid it sits next to.
 */

export interface ResolvedScope {
  categoryId: string | null;
  categoryIds: string[];
  categoryPath: string | null;
  categoryKind: string | null;
  /**
   * A NEW_ARRIVALS / SPECIAL_COLLECTION / MAKE_YOUR_OWN category also lists every product of its
   * parent's subtree (null: of the whole catalog) that has the matching fact.
   */
  categoryRule: { kind: RuleCategoryKind; parentCategoryIds: string[] | null } | null;
  collectionId: string | null;
  brandIds: string[];
}

/** Which filter dimensions are in play, so facets can drop exactly one of them at a time. */
export type FilterDimension = 'brand' | 'price' | 'availability' | 'rating' | 'flags' | string;

export async function resolveScope(query: StorefrontListQuery): Promise<ResolvedScope> {
  const scope: ResolvedScope = {
    categoryId: null,
    categoryIds: [],
    categoryPath: null,
    categoryKind: null,
    categoryRule: null,
    collectionId: null,
    brandIds: [...query.brandIds],
  };

  if (query.categorySlug) {
    const category = await storefrontRepository.findCategoryBySlug(query.categorySlug);
    const live = await categoryService.liveIds();
    if (!category || !live.has(category.id)) {
      throw AppError.notFound(`Category "${query.categorySlug}" not found`);
    }

    scope.categoryId = category.id;
    scope.categoryPath = category.path;
    scope.categoryKind = category.kind;
    scope.categoryIds = (await storefrontRepository.findCategorySubtreeIds(category.path)).filter(
      (id) => live.has(id),
    );

    if (isRuleCategoryKind(category.kind)) {
      const parentPath = category.path.split('/').slice(0, -1).join('/');
      scope.categoryRule = {
        kind: category.kind,
        parentCategoryIds: parentPath
          ? (await storefrontRepository.findCategorySubtreeIds(parentPath)).filter((id) =>
              live.has(id),
            )
          : null,
      };
    }
  }

  if (query.collectionSlug) {
    const collection = await storefrontRepository.findCollectionBySlug(query.collectionSlug);
    if (!collection) throw AppError.notFound(`Collection "${query.collectionSlug}" not found`);
    scope.collectionId = collection.id;
  }

  if (query.brandSlugs.length > 0) {
    const brands = await storefrontRepository.findBrandsBySlugs(query.brandSlugs);
    scope.brandIds = [...new Set([...scope.brandIds, ...brands.map((brand) => brand.id)])];
  }

  return scope;
}

export interface ListingFilterOptions {
  scope: ResolvedScope;
  valueIdsByAttribute: Map<string, string[]>;
  searchIds?: string[];
  hideOutOfStock: boolean;
  now: Date;
  /** Live since then = a new arrival (merchandising.ts); null = only the flag. */
  newArrivalSince: Date | null;
}

export function buildListingFilter(
  query: StorefrontListQuery,
  options: ListingFilterOptions,
): ListingFilter {
  const { scope } = options;

  return {
    now: options.now,
    newArrivalSince: options.newArrivalSince,
    // A query is a search: SEARCH_ONLY products answer it and CATALOG_ONLY ones do not.
    visibilities: query.q ? SEARCH_VISIBILITIES : BROWSE_VISIBILITIES,
    categoryIds: scope.categoryIds,
    ...(scope.categoryRule ? { categoryRule: scope.categoryRule } : {}),
    collectionId: scope.collectionId,
    brandIds: scope.brandIds,
    attributeValues: [...options.valueIdsByAttribute].map(([attributeId, valueIds]) => ({
      attributeId,
      valueIds,
    })),
    inStockOnly: query.inStockOnly === true,
    hideOutOfStock: options.hideOutOfStock,
    ...(query.madeToOrder !== undefined ? { madeToOrder: query.madeToOrder } : {}),
    ...(query.customizable !== undefined ? { customizable: query.customizable } : {}),
    ...(query.isNewArrival !== undefined ? { isNewArrival: query.isNewArrival } : {}),
    ...(query.isFeatured !== undefined ? { isFeatured: query.isFeatured } : {}),
    onSale: query.onSale === true,
    // Ratings are basis points of a five-star scale: 10000 per star.
    ...(query.ratingMin !== undefined ? { ratingMinBp: query.ratingMin * 10_000 } : {}),
    ...(query.leadTimeMax !== undefined ? { leadTimeMaxDays: query.leadTimeMax } : {}),
    ...(query.priceMin !== undefined ? { priceMinPaise: query.priceMin } : {}),
    ...(query.priceMax !== undefined ? { priceMaxPaise: query.priceMax } : {}),
    ...(options.searchIds ? { productIds: options.searchIds } : {}),
  };
}

/** The same filter with one dimension's own selection removed: the facet-counting rule. */
export function withoutDimension(filter: ListingFilter, dimension: FilterDimension): ListingFilter {
  switch (dimension) {
    case 'brand':
      return { ...filter, brandIds: [] };
    case 'price': {
      const { priceMinPaise: _min, priceMaxPaise: _max, ...rest } = filter;
      return rest;
    }
    case 'availability':
      return { ...filter, inStockOnly: false };
    case 'rating': {
      const { ratingMinBp: _rating, ...rest } = filter;
      return rest;
    }
    case 'flags': {
      const {
        madeToOrder: _madeToOrder,
        customizable: _customizable,
        isNewArrival: _isNewArrival,
        isFeatured: _isFeatured,
        ...rest
      } = filter;
      return { ...rest, onSale: false };
    }
    default:
      return {
        ...filter,
        attributeValues: filter.attributeValues.filter((entry) => entry.attributeId !== dimension),
      };
  }
}

/** Groups the flat `attributeValueIds` query parameter by the attribute each value belongs to. */
export async function groupValueIdsByAttribute(
  valueIds: string[],
  lookup: (ids: string[]) => Promise<{ id: string; attributeId: string }[]>,
): Promise<Map<string, string[]>> {
  const grouped = new Map<string, string[]>();
  if (valueIds.length === 0) return grouped;

  for (const row of await lookup(valueIds)) {
    grouped.set(row.attributeId, [...(grouped.get(row.attributeId) ?? []), row.id]);
  }
  return grouped;
}
