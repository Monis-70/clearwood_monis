import type { Prisma } from '@prisma/client';

import type { StorefrontListQuery } from '@shared/schemas/storefront';

import { storefrontRepository, publishedWhere } from '../../repositories/storefront.repository';
import { AppError } from '../../utils/AppError';

/**
 * Turns a validated storefront query into a Prisma `where`, plus the scope it resolved.
 *
 * Shared by the listing and the facet services so a facet can never count a different population
 * than the grid it sits next to. Price is deliberately absent: it lives in the search index and is
 * applied by the caller (see productQuery.service).
 */

export interface ResolvedScope {
  categoryId: string | null;
  categoryIds: string[];
  categoryPath: string | null;
  collectionId: string | null;
  /** Curated order for a collection scope; empty otherwise. */
  collectionOrder: string[];
  brandIds: string[];
}

/** Which filter dimensions are in play, so facets can drop exactly one of them at a time. */
export type FilterDimension = 'brand' | 'price' | 'availability' | 'rating' | 'flags' | string;

export async function resolveScope(query: StorefrontListQuery): Promise<ResolvedScope> {
  const scope: ResolvedScope = {
    categoryId: null,
    categoryIds: [],
    categoryPath: null,
    collectionId: null,
    collectionOrder: [],
    brandIds: [...query.brandIds],
  };

  if (query.categorySlug) {
    const category = await storefrontRepository.findCategoryBySlug(query.categorySlug);
    if (!category) throw AppError.notFound(`Category "${query.categorySlug}" not found`);

    scope.categoryId = category.id;
    scope.categoryPath = category.path;
    scope.categoryIds = await storefrontRepository.findCategorySubtreeIds(category.path);
  }

  if (query.collectionSlug) {
    const collection = await storefrontRepository.findCollectionBySlug(query.collectionSlug);
    if (!collection) throw AppError.notFound(`Collection "${query.collectionSlug}" not found`);

    scope.collectionId = collection.id;
    scope.collectionOrder = await storefrontRepository.findCollectionProductIds(collection.id);
  }

  if (query.brandSlugs.length > 0) {
    const brands = await storefrontRepository.findBrandsBySlugs(query.brandSlugs);
    scope.brandIds = [...new Set([...scope.brandIds, ...brands.map((brand) => brand.id)])];
  }

  return scope;
}

/**
 * Multi-select inside one attribute is OR; across attributes it is AND — the behaviour every
 * shopper already expects from a faceted grid.
 */
function attributeClauses(valueIdsByAttribute: Map<string, string[]>): Prisma.ProductWhereInput[] {
  return [...valueIdsByAttribute.values()].map((valueIds) => ({
    OR: [
      { attributeValues: { some: { attributeValueId: { in: valueIds } } } },
      {
        variants: {
          some: {
            deletedAt: null,
            isActive: true,
            attributeValues: { some: { attributeValueId: { in: valueIds } } },
          },
        },
      },
    ],
  }));
}

export interface BuildWhereOptions {
  /** Skip this dimension's own filters — the facet-counting rule. */
  exclude?: FilterDimension;
  /** Attribute value ids grouped by their attribute, resolved by the caller. */
  valueIdsByAttribute: Map<string, string[]>;
  scope: ResolvedScope;
  candidateIds?: string[];
}

export function buildWhere(
  query: StorefrontListQuery,
  options: BuildWhereOptions,
): Prisma.ProductWhereInput {
  const { scope, exclude } = options;
  const and: Prisma.ProductWhereInput[] = [publishedWhere()];

  if (scope.categoryIds.length > 0) {
    and.push({ categories: { some: { categoryId: { in: scope.categoryIds } } } });
  }

  if (scope.collectionId) {
    and.push({ collections: { some: { collectionId: scope.collectionId } } });
  }

  if (exclude !== 'brand' && scope.brandIds.length > 0) {
    and.push({ brandId: { in: scope.brandIds } });
  }

  for (const [attributeId, valueIds] of options.valueIdsByAttribute) {
    if (exclude === attributeId) continue;
    and.push(...attributeClauses(new Map([[attributeId, valueIds]])));
  }

  if (exclude !== 'availability' && query.inStockOnly) {
    and.push({
      OR: [
        { isMadeToOrder: true },
        {
          variants: {
            some: {
              deletedAt: null,
              isActive: true,
              OR: [{ stockQty: { gt: 0 } }, { allowBackorder: true }],
            },
          },
        },
      ],
    });
  }

  if (exclude !== 'flags') {
    if (query.madeToOrder !== undefined) and.push({ isMadeToOrder: query.madeToOrder });
    if (query.customizable !== undefined) and.push({ allowCustomization: query.customizable });
    if (query.isNewArrival !== undefined) and.push({ isNewArrival: query.isNewArrival });
    if (query.isFeatured !== undefined) and.push({ isFeatured: query.isFeatured });
  }

  if (exclude !== 'rating' && query.ratingMin !== undefined) {
    // Ratings are basis points of a five-star scale: 10000 per star.
    and.push({ ratingAvgBp: { gte: query.ratingMin * 10_000 } });
  }

  if (query.leadTimeMax !== undefined) {
    and.push({
      OR: [{ leadTimeDays: null }, { leadTimeDays: { lte: query.leadTimeMax } }],
    });
  }

  if (options.candidateIds) {
    and.push({ id: { in: options.candidateIds } });
  }

  return { AND: and };
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
