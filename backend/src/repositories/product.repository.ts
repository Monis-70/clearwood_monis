import type { Prisma } from '@prisma/client';

import type { AdminProductListQuery } from '@shared/schemas/catalogAdmin';
import type { ListQuery } from '@shared/schemas/common';

import { prisma } from '../config/prisma';

import { notDeleted, orderBy, pageResult, skipTake, type PageResult } from './helpers';
import { browsableWhere, reachableWhere } from './storefront.repository';

export type AdminProductQuery = AdminProductListQuery;

const SORTABLE = [
  'name',
  'sku',
  'slug',
  'basePricePaise',
  'position',
  'publishedAt',
  'soldCount',
  'ratingAvgBp',
  'createdAt',
  'updatedAt',
] as const;

const detailInclude = {
  brand: true,
  taxClass: true,
  categories: { include: { category: true }, orderBy: [{ position: 'asc' as const }] },
  attributeValues: {
    include: { attribute: true, attributeValue: true },
    orderBy: [{ position: 'asc' as const }],
  },
  variants: {
    where: notDeleted,
    orderBy: [{ position: 'asc' as const }],
    include: { attributeValues: { include: { attribute: true, attributeValue: true } } },
  },
  media: {
    include: { media: true },
    orderBy: [{ position: 'asc' as const }],
  },
} satisfies Prisma.ProductInclude;

const summaryInclude = {
  media: {
    where: { role: 'PRIMARY' },
    take: 1,
    include: { media: true },
    orderBy: [{ position: 'asc' as const }],
  },
} satisfies Prisma.ProductInclude;

/** The admin editor needs everything in one payload, including inactive variants and relations. */
const adminInclude = {
  brand: true,
  taxClass: true,
  categories: { orderBy: [{ isPrimary: 'desc' as const }, { position: 'asc' as const }] },
  attributeValues: { orderBy: [{ position: 'asc' as const }] },
  variants: {
    where: notDeleted,
    orderBy: [{ position: 'asc' as const }],
    include: { attributeValues: true },
  },
  media: { include: { media: true }, orderBy: [{ position: 'asc' as const }] },
  relations: { include: { relatedProduct: { select: { id: true, name: true, sku: true } } } },
} satisfies Prisma.ProductInclude;

export type ProductWithDetail = Prisma.ProductGetPayload<{ include: typeof detailInclude }>;
export type ProductWithSummary = Prisma.ProductGetPayload<{ include: typeof summaryInclude }>;
export type ProductForAdmin = Prisma.ProductGetPayload<{ include: typeof adminInclude }>;

/** One admin table row: scalars, stock per variant, the primary link and one thumbnail. */
const adminRowSelect = {
  id: true,
  sku: true,
  slug: true,
  deletedSlug: true,
  name: true,
  status: true,
  productType: true,
  visibility: true,
  brandId: true,
  taxClassId: true,
  basePricePaise: true,
  completenessScore: true,
  publishedAt: true,
  lastPublishedAt: true,
  isFeatured: true,
  isNewArrival: true,
  allowCustomization: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  variants: { where: notDeleted, select: { stockQty: true } },
  categories: { where: { isPrimary: true }, select: { categoryId: true } },
  media: {
    where: { role: 'PRIMARY' },
    take: 1,
    select: {
      media: {
        select: {
          path: true,
          variants: { where: { label: 'THUMB' }, select: { path: true, format: true } },
        },
      },
    },
  },
  _count: { select: { media: true } },
} satisfies Prisma.ProductSelect;

export type ProductAdminRow = Prisma.ProductGetPayload<{ select: typeof adminRowSelect }>;

/** The storefront availability rule (catalog-admin/availability.ts) as a Prisma filter. */
const sellableVariant: Prisma.ProductVariantWhereInput = {
  ...notDeleted,
  isActive: true,
  OR: [{ allowBackorder: true }, { stockQty: { gt: prisma.productVariant.fields.reservedQty } }],
};

function publicationWhere(
  state: AdminProductQuery['publication'],
  now: Date,
): Prisma.ProductWhereInput {
  switch (state) {
    case 'DRAFT':
      return { status: 'DRAFT', deletedAt: null };
    case 'ARCHIVED':
      return { OR: [{ status: 'ARCHIVED' }, { deletedAt: { not: null } }] };
    case 'SCHEDULED':
      return { status: 'ACTIVE', deletedAt: null, publishedAt: { gt: now } };
    case 'LIVE':
      return {
        status: 'ACTIVE',
        deletedAt: null,
        OR: [{ publishedAt: null }, { publishedAt: { lte: now } }],
      };
    default:
      return {};
  }
}

export interface ProductFilter {
  includeUnpublished?: boolean;
  categoryIds?: string[];
  status?: string;
}

function where(filter: ProductFilter = {}): Prisma.ProductWhereInput {
  return {
    ...notDeleted,
    // The storefront reachability rule (shared/enums REACHABLE_VISIBILITIES), not a local variant.
    ...(filter.includeUnpublished ? {} : reachableWhere()),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.categoryIds
      ? { categories: { some: { categoryId: { in: filter.categoryIds } } } }
      : {}),
  };
}

export const productRepository = {
  findBySlug(slug: string, includeUnpublished = false): Promise<ProductWithDetail | null> {
    return prisma.product.findFirst({
      where: { slug, ...where({ includeUnpublished }) },
      include: detailInclude,
    });
  },

  findById(id: string, includeUnpublished = false): Promise<ProductWithDetail | null> {
    return prisma.product.findFirst({
      where: { id, ...where({ includeUnpublished }) },
      include: detailInclude,
    });
  },

  async list(
    query: ListQuery,
    filter: ProductFilter = {},
  ): Promise<PageResult<ProductWithSummary>> {
    const args = { where: where(filter) };
    const [items, total] = await Promise.all([
      prisma.product.findMany({
        ...args,
        ...skipTake(query),
        include: summaryInclude,
        orderBy: orderBy(query.sort, query.order, SORTABLE, [{ position: 'asc' }, { name: 'asc' }]),
      }),
      prisma.product.count(args),
    ]);
    return pageResult(items, total, query);
  },

  /** Feeds Category.productCountCache: what a category's own listing can show, in one query. */
  countByCategory(): Promise<{ categoryId: string; total: number }[]> {
    return prisma.productCategory
      .groupBy({
        by: ['categoryId'],
        _count: { _all: true },
        where: { product: browsableWhere() },
      })
      .then((rows) => rows.map((row) => ({ categoryId: row.categoryId, total: row._count._all })));
  },

  async slugExists(slug: string, excludeId?: string): Promise<boolean> {
    const found = await prisma.product.findFirst({
      where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    return found !== null;
  },

  count(filter: ProductFilter = {}): Promise<number> {
    return prisma.product.count({ where: where(filter) });
  },

  /* ------------------------------------------------------- admin (Prompt 5) */

  findForAdmin(id: string, includeDeleted = true): Promise<ProductForAdmin | null> {
    return prisma.product.findFirst({
      where: { id, ...(includeDeleted ? {} : notDeleted) },
      include: adminInclude,
    });
  },

  findForAdminBySku(sku: string): Promise<ProductForAdmin | null> {
    return prisma.product.findFirst({ where: { sku }, include: adminInclude });
  },

  async skuExists(sku: string, excludeId?: string): Promise<boolean> {
    const found = await prisma.product.findFirst({
      where: { sku, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    return found !== null;
  },

  async listForAdmin(query: AdminProductQuery): Promise<PageResult<ProductAdminRow>> {
    const stockFilter: Prisma.ProductWhereInput =
      query.stock === undefined || query.stock === 'ANY'
        ? {}
        : query.stock === 'OUT_OF_STOCK'
          ? { isMadeToOrder: false, variants: { none: sellableVariant } }
          : query.stock === 'LOW_STOCK'
            ? { variants: { some: { ...notDeleted, isActive: true, stockStatus: 'LOW_STOCK' } } }
            : { OR: [{ isMadeToOrder: true }, { variants: { some: sellableVariant } }] };

    const and: Prisma.ProductWhereInput[] = [stockFilter];
    if (query.publication) and.push(publicationWhere(query.publication, new Date()));
    if (query.q) {
      and.push({
        OR: [
          { name: { contains: query.q } },
          { sku: { contains: query.q } },
          { slug: { contains: query.q } },
          { searchKeywords: { contains: query.q } },
          // A variant SKU finds its product too.
          { variants: { some: { sku: { contains: query.q }, ...notDeleted } } },
        ],
      });
    }

    const args = {
      where: {
        ...(query.includeDeleted || query.publication === 'ARCHIVED' ? {} : notDeleted),
        ...(query.status ? { status: query.status } : {}),
        ...(query.visibility ? { visibility: query.visibility } : {}),
        ...(query.brandId ? { brandId: query.brandId } : {}),
        ...(query.taxClassId ? { taxClassId: query.taxClassId } : {}),
        ...(query.productType ? { productType: query.productType } : {}),
        ...(query.isFeatured === undefined ? {} : { isFeatured: query.isFeatured }),
        ...(query.isNewArrival === undefined ? {} : { isNewArrival: query.isNewArrival }),
        ...(query.isSpecialCollection === undefined
          ? {}
          : { isSpecialCollection: query.isSpecialCollection }),
        ...(query.customizable === undefined ? {} : { allowCustomization: query.customizable }),
        ...(query.madeToOrder === undefined ? {} : { isMadeToOrder: query.madeToOrder }),
        ...(query.categoryId ? { categories: { some: { categoryId: query.categoryId } } } : {}),
        ...(query.collectionId
          ? { collections: { some: { collectionId: query.collectionId } } }
          : {}),
        ...(query.updatedSince ? { updatedAt: { gte: query.updatedSince } } : {}),
        ...(query.createdFrom || query.createdTo
          ? {
              createdAt: {
                ...(query.createdFrom ? { gte: query.createdFrom } : {}),
                ...(query.createdTo ? { lte: query.createdTo } : {}),
              },
            }
          : {}),
        ...(query.priceMin === undefined && query.priceMax === undefined
          ? {}
          : {
              basePricePaise: {
                ...(query.priceMin === undefined ? {} : { gte: query.priceMin }),
                ...(query.priceMax === undefined ? {} : { lte: query.priceMax }),
              },
            }),
        ...(query.completenessMin === undefined && query.completenessMax === undefined
          ? {}
          : {
              completenessScore: {
                ...(query.completenessMin === undefined ? {} : { gte: query.completenessMin }),
                ...(query.completenessMax === undefined ? {} : { lte: query.completenessMax }),
              },
            }),
        ...(query.hasMedia === undefined
          ? {}
          : query.hasMedia
            ? { media: { some: {} } }
            : { media: { none: {} } }),
        AND: and,
      } satisfies Prisma.ProductWhereInput,
    };

    const [items, total] = await Promise.all([
      prisma.product.findMany({
        ...args,
        ...skipTake(query),
        select: adminRowSelect,
        orderBy: orderBy(query.sort, query.order, SORTABLE, [
          { updatedAt: 'desc' },
          { name: 'asc' },
        ]),
      }),
      prisma.product.count(args),
    ]);

    return pageResult(items, total, query);
  },

  create(data: Prisma.ProductUncheckedCreateInput): Promise<{ id: string }> {
    return prisma.product.create({ data, select: { id: true } });
  },

  /**
   * Runs `work` in a transaction holding the product row lock, so writes that keep a per-product
   * invariant (default variant, primary image, primary category, option combinations) queue up
   * behind each other instead of racing. The unique indexes stay the final guarantee.
   */
  withProductLock<T>(
    productId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM Product WHERE id = ${productId} FOR UPDATE`;
      return work(tx);
    });
  },

  /** The slug is released (kept in `deletedSlug`) so a new product may use it. */
  softDelete(id: string, slug: string): Promise<{ id: string }> {
    return prisma.product.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'ARCHIVED', slug: `deleted-${id}`, deletedSlug: slug },
      select: { id: true },
    });
  },

  restore(id: string, slug: string): Promise<{ id: string }> {
    return prisma.product.update({
      where: { id },
      data: { deletedAt: null, status: 'DRAFT', slug, deletedSlug: null },
      select: { id: true },
    });
  },

  hardDelete(id: string): Promise<{ id: string }> {
    return prisma.product.delete({ where: { id }, select: { id: true } });
  },
};
