import type { Brand, Category, Collection, Prisma } from '@prisma/client';

import { prisma } from '../config/prisma';

import { notDeleted } from './helpers';

/**
 * R1 — every storefront read reaches Prisma through here. The services above build filters and
 * shape DTOs; none of them import the client.
 */

/** Only a published, publicly reachable product is ever indexed or listed. */
export function publishedWhere(now = new Date()): Prisma.ProductWhereInput {
  return {
    ...notDeleted,
    status: 'ACTIVE',
    visibility: { in: ['PUBLIC', 'SEARCH_ONLY'] },
    OR: [{ publishedAt: null }, { publishedAt: { lte: now } }],
  };
}

const indexInclude = {
  brand: { select: { id: true, name: true, slug: true } },
  categories: {
    include: { category: { select: { id: true, name: true, slug: true, path: true } } },
    orderBy: [{ position: 'asc' as const }],
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

const cardInclude = {
  brand: { select: { id: true, name: true, slug: true } },
  categories: {
    include: { category: { select: { id: true, name: true, slug: true, path: true } } },
    orderBy: [{ position: 'asc' as const }],
  },
  variants: {
    where: { ...notDeleted, isActive: true },
    orderBy: [{ position: 'asc' as const }],
    include: { attributeValues: { include: { attributeValue: true, attribute: true } } },
  },
  media: {
    where: { role: 'PRIMARY' },
    take: 1,
    include: { media: { include: { variants: true } } },
    orderBy: [{ position: 'asc' as const }],
  },
  stat: true,
} satisfies Prisma.ProductInclude;

export type ProductForIndex = Prisma.ProductGetPayload<{ include: typeof indexInclude }>;
export type ProductCardRow = Prisma.ProductGetPayload<{ include: typeof cardInclude }>;

export const storefrontRepository = {
  /* ------------------------------------------------------------- indexing */

  findIndexable(afterId: string | null, take: number): Promise<ProductForIndex[]> {
    return prisma.product.findMany({
      where: publishedWhere(),
      include: indexInclude,
      orderBy: { id: 'asc' },
      take,
      ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}),
    });
  },

  findIndexableById(id: string): Promise<ProductForIndex | null> {
    return prisma.product.findFirst({ where: { id, ...publishedWhere() }, include: indexInclude });
  },

  countIndexable(): Promise<number> {
    return prisma.product.count({ where: publishedWhere() });
  },

  async listIndexableIds(): Promise<string[]> {
    const rows = await prisma.product.findMany({
      where: publishedWhere(),
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  findIndexableCategories(): Promise<Category[]> {
    return prisma.category.findMany({ where: { ...notDeleted, isActive: true } });
  },

  findIndexableCollections(): Promise<(Collection & { _count: { products: number } })[]> {
    return prisma.collection.findMany({
      where: { ...notDeleted, isActive: true },
      include: { _count: { select: { products: true } } },
    });
  },

  findIndexableBrands(): Promise<Brand[]> {
    return prisma.brand.findMany({ where: { ...notDeleted, isActive: true } });
  },

  /* -------------------------------------------------------------- listing */

  findIds(where: Prisma.ProductWhereInput, orderBy: Prisma.ProductOrderByWithRelationInput[]) {
    return prisma.product.findMany({ where, orderBy, select: { id: true } });
  },

  /**
   * Every sort key in one query. Ordering then happens in memory with a stable `id` tiebreak,
   * which is what guarantees a page boundary never duplicates or drops a row.
   */
  findCandidates(where: Prisma.ProductWhereInput) {
    return prisma.product.findMany({
      where,
      orderBy: { id: 'asc' },
      select: {
        id: true,
        name: true,
        position: true,
        publishedAt: true,
        createdAt: true,
        soldCount: true,
        ratingAvgBp: true,
        ratingCount: true,
        basePricePaise: true,
        compareAtPricePaise: true,
        isMadeToOrder: true,
        stat: { select: { popularityScore: true } },
        categories: { select: { categoryId: true, position: true } },
      },
    });
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

  findCards(ids: string[]): Promise<ProductCardRow[]> {
    return prisma.product.findMany({ where: { id: { in: ids } }, include: cardInclude });
  },

  findCardBySlug(slug: string): Promise<ProductCardRow | null> {
    return prisma.product.findFirst({
      where: { slug, ...publishedWhere() },
      include: cardInclude,
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
    return prisma.collection.findFirst({ where: { slug, ...notDeleted, isActive: true } });
  },

  async findCollectionProductIds(collectionId: string): Promise<string[]> {
    const rows = await prisma.collectionProduct.findMany({
      where: { collectionId },
      orderBy: [{ position: 'asc' }],
      select: { productId: true },
    });
    return rows.map((row) => row.productId);
  },

  findBrandsByIds(ids: string[]): Promise<Brand[]> {
    return prisma.brand.findMany({ where: { id: { in: ids }, ...notDeleted } });
  },

  findBrandsBySlugs(slugs: string[]): Promise<Brand[]> {
    return prisma.brand.findMany({ where: { slug: { in: slugs }, ...notDeleted } });
  },

  /* --------------------------------------------------------------- facets */

  /**
   * Every (productId, attributeValueId) pair inside a candidate set, from both the product's own
   * specs and its variants. Deduped by the caller, which is what turns variant hits into product
   * counts.
   */
  async findAttributePairs(
    productIds: string[],
  ): Promise<{ productId: string; attributeId: string; attributeValueId: string }[]> {
    if (productIds.length === 0) return [];

    const [specs, variantValues] = await Promise.all([
      prisma.productAttributeValue.findMany({
        where: { productId: { in: productIds }, attributeValueId: { not: null } },
        select: { productId: true, attributeId: true, attributeValueId: true },
      }),
      prisma.variantAttributeValue.findMany({
        where: { variant: { productId: { in: productIds }, ...notDeleted } },
        select: {
          attributeId: true,
          attributeValueId: true,
          variant: { select: { productId: true } },
        },
      }),
    ]);

    return [
      ...specs.map((row) => ({
        productId: row.productId,
        attributeId: row.attributeId,
        attributeValueId: row.attributeValueId as string,
      })),
      ...variantValues.map((row) => ({
        productId: row.variant.productId,
        attributeId: row.attributeId,
        attributeValueId: row.attributeValueId,
      })),
    ];
  },

  async countByBrand(productIds: string[]): Promise<{ brandId: string; count: number }[]> {
    if (productIds.length === 0) return [];

    const rows = await prisma.product.groupBy({
      by: ['brandId'],
      where: { id: { in: productIds }, brandId: { not: null } },
      _count: { _all: true },
    });

    return rows
      .filter((row): row is typeof row & { brandId: string } => row.brandId !== null)
      .map((row) => ({ brandId: row.brandId, count: row._count._all }));
  },

  findFlagsAndRatings(productIds: string[]) {
    return prisma.product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true,
        brandId: true,
        ratingAvgBp: true,
        isMadeToOrder: true,
        allowCustomization: true,
        compareAtPricePaise: true,
        basePricePaise: true,
      },
    });
  },

  /* ----------------------------------------------------------------- misc */

  async findStockByProduct(
    productIds: string[],
  ): Promise<{ productId: string; stockQty: number; stockStatus: string }[]> {
    if (productIds.length === 0) return [];

    const rows = await prisma.productVariant.findMany({
      where: { productId: { in: productIds }, ...notDeleted, isActive: true },
      select: { productId: true, stockQty: true, reservedQty: true, stockStatus: true },
    });

    const byProduct = new Map<string, { stockQty: number; stockStatus: string }>();
    for (const row of rows) {
      const current = byProduct.get(row.productId) ?? { stockQty: 0, stockStatus: 'OUT_OF_STOCK' };
      const available = Math.max(row.stockQty - row.reservedQty, 0);
      byProduct.set(row.productId, {
        stockQty: current.stockQty + available,
        stockStatus: available > 0 ? row.stockStatus : current.stockStatus,
      });
    }

    return [...byProduct].map(([productId, value]) => ({ productId, ...value }));
  },

  findRelations(productId: string, type?: string) {
    return prisma.productRelation.findMany({
      where: { productId, ...(type ? { type } : {}) },
      orderBy: [{ position: 'asc' }],
      select: { relatedProductId: true, type: true, position: true },
    });
  },

  findCollectionsForProduct(productId: string) {
    return prisma.collectionProduct.findMany({
      where: { productId, collection: { ...notDeleted, isActive: true } },
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
      where: { ...notDeleted, isActive: true },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { products: true } } },
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
