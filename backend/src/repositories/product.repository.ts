import type { Prisma } from '@prisma/client';

import type { AdminProductListQuery } from '@shared/schemas/catalogAdmin';
import type { ListQuery } from '@shared/schemas/common';

import { prisma } from '../config/prisma';

import { notDeleted, orderBy, pageResult, skipTake, type PageResult } from './helpers';

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
  categories: { orderBy: [{ position: 'asc' as const }] },
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

export interface ProductFilter {
  includeUnpublished?: boolean;
  categoryIds?: string[];
  status?: string;
}

function where(filter: ProductFilter = {}): Prisma.ProductWhereInput {
  return {
    ...notDeleted,
    ...(filter.includeUnpublished ? {} : { status: 'ACTIVE', visibility: { not: 'HIDDEN' } }),
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

  /** Feeds Category.productCountCache — grouped in one query rather than one count per category. */
  countByCategory(): Promise<{ categoryId: string; total: number }[]> {
    return prisma.productCategory
      .groupBy({
        by: ['categoryId'],
        _count: { _all: true },
        where: { product: { ...notDeleted, status: 'ACTIVE' } },
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

  async listForAdmin(query: AdminProductQuery): Promise<PageResult<ProductForAdmin>> {
    const stockFilter: Prisma.ProductWhereInput =
      query.stock === undefined || query.stock === 'ANY'
        ? {}
        : query.stock === 'OUT_OF_STOCK'
          ? { variants: { every: { stockQty: { lte: 0 } } } }
          : query.stock === 'LOW_STOCK'
            ? { variants: { some: { stockStatus: 'LOW_STOCK' } } }
            : { variants: { some: { stockQty: { gt: 0 } } } };

    const args = {
      where: {
        ...(query.includeDeleted ? {} : notDeleted),
        ...(query.status ? { status: query.status } : {}),
        ...(query.brandId ? { brandId: query.brandId } : {}),
        ...(query.taxClassId ? { taxClassId: query.taxClassId } : {}),
        ...(query.productType ? { productType: query.productType } : {}),
        ...(query.isFeatured === undefined ? {} : { isFeatured: query.isFeatured }),
        ...(query.isNewArrival === undefined ? {} : { isNewArrival: query.isNewArrival }),
        ...(query.categoryId ? { categories: { some: { categoryId: query.categoryId } } } : {}),
        ...(query.updatedSince ? { updatedAt: { gte: query.updatedSince } } : {}),
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
        ...(query.q
          ? {
              OR: [
                { name: { contains: query.q } },
                { sku: { contains: query.q } },
                { slug: { contains: query.q } },
                { searchKeywords: { contains: query.q } },
              ],
            }
          : {}),
        ...stockFilter,
      } satisfies Prisma.ProductWhereInput,
    };

    const [items, total] = await Promise.all([
      prisma.product.findMany({
        ...args,
        ...skipTake(query),
        include: adminInclude,
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

  softDelete(id: string): Promise<{ id: string }> {
    return prisma.product.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'ARCHIVED' },
      select: { id: true },
    });
  },

  restore(id: string): Promise<{ id: string }> {
    return prisma.product.update({
      where: { id },
      data: { deletedAt: null, status: 'DRAFT' },
      select: { id: true },
    });
  },

  hardDelete(id: string): Promise<{ id: string }> {
    return prisma.product.delete({ where: { id }, select: { id: true } });
  },
};
