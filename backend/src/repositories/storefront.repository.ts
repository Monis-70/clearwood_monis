import type { Brand, Category, Collection, Prisma } from '@prisma/client';

import { CARD_RENDITION_LABELS } from '@shared/constants';
import { BROWSE_VISIBILITIES, REACHABLE_VISIBILITIES, SEARCH_VISIBILITIES } from '@shared/enums';

import { prisma } from '../config/prisma';

import { notDeleted } from './helpers';

/**
 * R1 — every storefront read reaches Prisma through here. The services above build filters and
 * shape DTOs; none of them import the client.
 */

function live(visibilities: readonly string[], now: Date): Prisma.ProductWhereInput {
  return {
    ...notDeleted,
    status: 'ACTIVE',
    visibility: { in: [...visibilities] },
    OR: [{ publishedAt: null }, { publishedAt: { lte: now } }],
  };
}

/** Live and not HIDDEN: may be opened by slug or shown where it is linked explicitly. */
export function reachableWhere(now = new Date()): Prisma.ProductWhereInput {
  return live(REACHABLE_VISIBILITIES, now);
}

/** Live and PUBLIC or CATALOG_ONLY: may appear in category, collection and curated listings. */
export function browsableWhere(now = new Date()): Prisma.ProductWhereInput {
  return live(BROWSE_VISIBILITIES, now);
}

/** Live and PUBLIC or SEARCH_ONLY: may be indexed for search and returned for a query. */
export function searchableWhere(now = new Date()): Prisma.ProductWhereInput {
  return live(SEARCH_VISIBILITIES, now);
}

/** reachableWhere for a row already in memory (the cart and slug resolution judge loaded rows). */
export function isReachable(
  product: { deletedAt: Date | null; status: string; visibility: string; publishedAt: Date | null },
  now = new Date(),
): boolean {
  return (
    product.deletedAt === null &&
    product.status === 'ACTIVE' &&
    (REACHABLE_VISIBILITIES as readonly string[]).includes(product.visibility) &&
    (product.publishedAt === null || product.publishedAt.getTime() <= now.getTime())
  );
}

/** A collection is public while active, not deleted and inside its [startsAt, endsAt) window. */
export function liveCollectionWhere(now = new Date()): Prisma.CollectionWhereInput {
  return {
    ...notDeleted,
    isActive: true,
    AND: [
      { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
      { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
    ],
  };
}

export function isCollectionLive(
  collection: {
    deletedAt: Date | null;
    isActive: boolean;
    startsAt: Date | null;
    endsAt: Date | null;
  },
  now = new Date(),
): boolean {
  return (
    collection.deletedAt === null &&
    collection.isActive &&
    (collection.startsAt === null || collection.startsAt.getTime() <= now.getTime()) &&
    (collection.endsAt === null || collection.endsAt.getTime() > now.getTime())
  );
}

const indexInclude = {
  brand: { select: { id: true, name: true, slug: true } },
  // Only categories a shopper can open; the primary first, whatever its merchandising position.
  categories: {
    where: { category: { deletedAt: null, isActive: true } },
    include: { category: { select: { id: true, name: true, slug: true, path: true } } },
    orderBy: [{ isPrimary: 'desc' as const }, { position: 'asc' as const }],
  },
  attributeValues: {
    include: {
      attribute: { select: { id: true, code: true, name: true, isSearchable: true } },
      attributeValue: { select: { id: true, code: true, label: true } },
    },
  },
  variants: {
    where: notDeleted,
    orderBy: [{ position: 'asc' as const }],
    include: {
      attributeValues: {
        include: {
          attribute: { select: { id: true, code: true, name: true, inputType: true } },
          attributeValue: {
            select: {
              id: true,
              code: true,
              label: true,
              description: true,
              colorHex: true,
              swatchMediaId: true,
              position: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.ProductInclude;

/** Exactly what a product card renders and prices from; descriptions, SEO and specs stay in MySQL. */
const cardInclude = {
  id: true,
  slug: true,
  sku: true,
  name: true,
  subtitle: true,
  shortDescription: true,
  brandId: true,
  basePricePaise: true,
  compareAtPricePaise: true,
  priceNote: true,
  isMadeToOrder: true,
  leadTimeDays: true,
  allowCustomization: true,
  manufacturedInHouse: true,
  ratingAvgBp: true,
  ratingCount: true,
  soldCount: true,
  isNewArrival: true,
  isFeatured: true,
  featuredUntil: true,
  isBestSeller: true,
  isSpecialCollection: true,
  badgeText: true,
  badgeColor: true,
  publishedAt: true,
  createdAt: true,
  brand: { select: { id: true, name: true, slug: true } },
  categories: {
    where: { category: { deletedAt: null, isActive: true } },
    select: {
      categoryId: true,
      category: { select: { id: true, name: true, slug: true, path: true } },
    },
    orderBy: [{ isPrimary: 'desc' as const }, { position: 'asc' as const }],
  },
  variants: {
    where: { ...notDeleted, isActive: true },
    orderBy: [{ position: 'asc' as const }],
    select: {
      id: true,
      isDefault: true,
      stockQty: true,
      reservedQty: true,
      allowBackorder: true,
      stockStatus: true,
      attributeValues: {
        select: {
          attributeValueId: true,
          attribute: { select: { showInSwatch: true } },
          attributeValue: { select: { label: true, colorHex: true, swatchMediaId: true } },
        },
      },
    },
  },
  media: {
    where: { role: 'PRIMARY' },
    take: 1,
    select: {
      mediaId: true,
      altText: true,
      media: {
        select: {
          path: true,
          altText: true,
          width: true,
          height: true,
          blurhash: true,
          lqipDataUri: true,
          dominantColorHex: true,
          focalPointX: true,
          focalPointY: true,
          variants: {
            where: { label: { in: [...CARD_RENDITION_LABELS] } },
            select: { label: true, format: true, path: true, width: true, height: true },
          },
        },
      },
    },
    orderBy: [{ position: 'asc' as const }],
  },
} satisfies Prisma.ProductSelect;

export type ProductForIndex = Prisma.ProductGetPayload<{ include: typeof indexInclude }>;
export type ProductCardRow = Prisma.ProductGetPayload<{ select: typeof cardInclude }>;

export const storefrontRepository = {
  /* ------------------------------------------------------------- indexing */

  findIndexable(afterId: string | null, take: number): Promise<ProductForIndex[]> {
    return prisma.product.findMany({
      where: searchableWhere(),
      include: indexInclude,
      orderBy: { id: 'asc' },
      take,
      ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}),
    });
  },

  findIndexableById(id: string): Promise<ProductForIndex | null> {
    return prisma.product.findFirst({ where: { id, ...searchableWhere() }, include: indexInclude });
  },

  findIndexableByIds(ids: string[]): Promise<ProductForIndex[]> {
    return prisma.product.findMany({
      where: { id: { in: ids }, ...searchableWhere() },
      include: indexInclude,
    });
  },

  /** The PDP and option matrix: the same shape as a search document, for any reachable product. */
  findDetailById(id: string): Promise<ProductForIndex | null> {
    return prisma.product.findFirst({ where: { id, ...reachableWhere() }, include: indexInclude });
  },

  countIndexable(): Promise<number> {
    return prisma.product.count({ where: searchableWhere() });
  },

  async listIndexableIds(): Promise<string[]> {
    const rows = await prisma.product.findMany({
      where: searchableWhere(),
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  /** Products linked anywhere in these categories' subtrees, deleted nodes included. */
  async findProductIdsInCategorySubtrees(categoryIds: string[]): Promise<string[]> {
    if (categoryIds.length === 0) return [];
    const roots = await prisma.category.findMany({
      where: { id: { in: categoryIds } },
      select: { path: true },
    });
    if (roots.length === 0) return [];

    const rows = await prisma.productCategory.findMany({
      where: {
        category: {
          OR: roots.flatMap((root) => [
            { path: root.path },
            { path: { startsWith: `${root.path}/` } },
          ]),
        },
      },
      select: { productId: true },
      distinct: ['productId'],
    });
    return rows.map((row) => row.productId);
  },

  async findProductIdsByBrand(brandId: string): Promise<string[]> {
    const rows = await prisma.product.findMany({
      where: { brandId, ...notDeleted },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  /** Products describing themselves with this attribute, as a spec or as a variant option. */
  async findProductIdsByAttribute(attributeId: string): Promise<string[]> {
    const [specs, options] = await Promise.all([
      prisma.productAttributeValue.findMany({
        where: { attributeId },
        select: { productId: true },
        distinct: ['productId'],
      }),
      prisma.productVariant.findMany({
        where: { attributeValues: { some: { attributeId } } },
        select: { productId: true },
        distinct: ['productId'],
      }),
    ]);
    return [...new Set([...specs, ...options].map((row) => row.productId))];
  },

  findIndexableCategories(): Promise<Category[]> {
    return prisma.category.findMany({ where: { ...notDeleted, isActive: true } });
  },

  findIndexableCollections(): Promise<(Collection & { _count: { products: number } })[]> {
    return prisma.collection.findMany({
      where: liveCollectionWhere(),
      include: { _count: { select: { products: { where: { product: browsableWhere() } } } } },
    });
  },

  findIndexableBrands(): Promise<Brand[]> {
    return prisma.brand.findMany({ where: { ...notDeleted, isActive: true } });
  },

  /* -------------------------------------------------------------- listing */

  findIds(where: Prisma.ProductWhereInput, orderBy: Prisma.ProductOrderByWithRelationInput[]) {
    return prisma.product.findMany({ where, orderBy, select: { id: true } });
  },

  findAttributeValueOwners(valueIds: string[]): Promise<{ id: string; attributeId: string }[]> {
    return prisma.attributeValue.findMany({
      where: { id: { in: valueIds } },
      select: { id: true, attributeId: true },
    });
  },

  findAttributeValuesByIds(valueIds: string[]) {
    return prisma.attributeValue.findMany({
      where: { id: { in: valueIds } },
      include: { attribute: true },
    });
  },

  /** Cards for a public surface: products that stopped being reachable are simply absent. */
  findCards(ids: string[]): Promise<ProductCardRow[]> {
    return prisma.product.findMany({
      where: { id: { in: ids }, ...reachableWhere() },
      select: cardInclude,
    });
  },

  /** Admin reports only: every product, whatever its state. */
  findCardsAnyState(ids: string[]): Promise<ProductCardRow[]> {
    return prisma.product.findMany({ where: { id: { in: ids } }, select: cardInclude });
  },

  findCardBySlug(slug: string): Promise<ProductCardRow | null> {
    return prisma.product.findFirst({
      where: { slug, ...reachableWhere() },
      select: cardInclude,
    });
  },

  /** Category descendants come from the materialised path, so one prefix query covers the subtree. */
  async findCategorySubtreeIds(path: string): Promise<string[]> {
    const rows = await prisma.category.findMany({
      where: {
        ...notDeleted,
        isActive: true,
        OR: [{ path }, { path: { startsWith: `${path}/` } }],
      },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  findCategoryBySlug(slug: string): Promise<Category | null> {
    return prisma.category.findFirst({ where: { slug, ...notDeleted, isActive: true } });
  },

  findCategoriesBySlugs(slugs: string[]): Promise<Category[]> {
    return prisma.category.findMany({ where: { slug: { in: slugs }, ...notDeleted } });
  },

  findCollectionBySlug(slug: string): Promise<Collection | null> {
    return prisma.collection.findFirst({ where: { slug, ...liveCollectionWhere() } });
  },

  /** What the collection's own listing can show, so the two numbers always agree. */
  countCollectionProducts(collectionId: string): Promise<number> {
    return prisma.collectionProduct.count({
      where: { collectionId, product: browsableWhere() },
    });
  },

  findBrandsByIds(ids: string[]): Promise<Brand[]> {
    return prisma.brand.findMany({ where: { id: { in: ids }, ...notDeleted } });
  },

  findBrandsBySlugs(slugs: string[]): Promise<Brand[]> {
    return prisma.brand.findMany({ where: { slug: { in: slugs }, ...notDeleted } });
  },

  /* ----------------------------------------------------------------- misc */

  findRelations(productId: string, type?: string) {
    return prisma.productRelation.findMany({
      where: { productId, ...(type ? { type } : {}) },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { relatedProductId: true, type: true, position: true },
    });
  },

  findCollectionsForProduct(productId: string) {
    return prisma.collectionProduct.findMany({
      where: { productId, collection: liveCollectionWhere() },
      include: { collection: { select: { id: true, slug: true, name: true } } },
      orderBy: [{ position: 'asc' }],
    });
  },

  findAttributeGroups() {
    return prisma.attributeGroup.findMany({ orderBy: [{ position: 'asc' }] });
  },

  /* --------------------------------------------- automatic collections */

  countMatching(where: Prisma.ProductWhereInput): Promise<number> {
    return prisma.product.count({ where });
  },

  findMatchingSample(where: Prisma.ProductWhereInput, take: number) {
    return prisma.product.findMany({
      where,
      take,
      orderBy: [{ soldCount: 'desc' }, { id: 'asc' }],
      select: { id: true, sku: true, name: true },
    });
  },

  async findMatchingIds(where: Prisma.ProductWhereInput, take?: number): Promise<string[]> {
    const rows = await prisma.product.findMany({
      where,
      orderBy: [{ soldCount: 'desc' }, { position: 'asc' }, { id: 'asc' }],
      ...(take ? { take } : {}),
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  findCollectionById(id: string): Promise<Collection | null> {
    return prisma.collection.findFirst({ where: { id, deletedAt: null } });
  },

  findAutomaticCollectionIds(): Promise<{ id: string }[]> {
    return prisma.collection.findMany({
      where: { type: 'AUTOMATIC', deletedAt: null, rulesJson: { not: null } },
      select: { id: true },
    });
  },

  findActiveCollections(): Promise<(Collection & { _count: { products: number } })[]> {
    return prisma.collection.findMany({
      where: liveCollectionWhere(),
      orderBy: [{ position: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      include: { _count: { select: { products: { where: { product: browsableWhere() } } } } },
    });
  },

  /**
   * Swaps a collection's membership in one transaction. A product that is still matched keeps the
   * position an admin gave it, which is what makes manual overrides survive re-evaluation.
   */
  async syncCollectionMembers(
    collectionId: string,
    matchedIds: string[],
    evaluatedAt: Date,
  ): Promise<{ added: number; removed: number; kept: number }> {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.collectionProduct.findMany({
        where: { collectionId },
        select: { productId: true },
      });

      const existingIds = new Set(existing.map((row) => row.productId));
      const matched = new Set(matchedIds);
      const removedIds = existing
        .filter((row) => !matched.has(row.productId))
        .map((row) => row.productId);

      if (removedIds.length > 0) {
        await tx.collectionProduct.deleteMany({
          where: { collectionId, productId: { in: removedIds } },
        });
      }

      let added = 0;
      for (const [index, productId] of matchedIds.entries()) {
        if (existingIds.has(productId)) continue;
        await tx.collectionProduct.create({ data: { collectionId, productId, position: index } });
        added += 1;
      }

      await tx.collection.update({
        where: { id: collectionId },
        data: { lastEvaluatedAt: evaluatedAt, evaluatedCount: matchedIds.length },
      });

      return { added, removed: removedIds.length, kept: existingIds.size - removedIds.length };
    });
  },

  findProductSpecs(productId: string) {
    return prisma.productAttributeValue.findMany({
      where: { productId },
      orderBy: [{ position: 'asc' }],
      include: {
        attribute: { include: { group: true } },
        attributeValue: true,
      },
    });
  },
};
