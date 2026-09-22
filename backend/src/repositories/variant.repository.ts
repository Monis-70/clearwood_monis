import type { Prisma } from '@prisma/client';

import type { ListQuery } from '@shared/schemas/common';

import { prisma } from '../config/prisma';

import { notDeleted, orderBy, pageResult, skipTake, type PageResult } from './helpers';

const SORTABLE = ['sku', 'position', 'pricePaise', 'stockQty', 'createdAt', 'updatedAt'] as const;

const withAttributes = {
  attributeValues: { include: { attribute: true, attributeValue: true } },
} satisfies Prisma.ProductVariantInclude;

export type VariantWithAttributes = Prisma.ProductVariantGetPayload<{
  include: typeof withAttributes;
}>;

export interface VariantFilter {
  productId?: string;
  includeInactive?: boolean;
}

function where(filter: VariantFilter = {}): Prisma.ProductVariantWhereInput {
  return {
    ...notDeleted,
    ...(filter.includeInactive ? {} : { isActive: true }),
    ...(filter.productId ? { productId: filter.productId } : {}),
  };
}

export const variantRepository = {
  findById(id: string): Promise<VariantWithAttributes | null> {
    return prisma.productVariant.findFirst({
      where: { id, ...notDeleted },
      include: withAttributes,
    });
  },

  findBySku(sku: string): Promise<VariantWithAttributes | null> {
    return prisma.productVariant.findFirst({
      where: { sku, ...notDeleted },
      include: withAttributes,
    });
  },

  findForProduct(productId: string, includeInactive = false): Promise<VariantWithAttributes[]> {
    return prisma.productVariant.findMany({
      where: where({ productId, includeInactive }),
      include: withAttributes,
      orderBy: [{ position: 'asc' }, { sku: 'asc' }],
    });
  },

  async list(
    query: ListQuery,
    filter: VariantFilter = {},
  ): Promise<PageResult<VariantWithAttributes>> {
    const args = { where: where(filter) };
    const [items, total] = await Promise.all([
      prisma.productVariant.findMany({
        ...args,
        ...skipTake(query),
        include: withAttributes,
        orderBy: orderBy(query.sort, query.order, SORTABLE, [{ position: 'asc' }, { sku: 'asc' }]),
      }),
      prisma.productVariant.count(args),
    ]);
    return pageResult(items, total, query);
  },

  count(filter: VariantFilter = {}): Promise<number> {
    return prisma.productVariant.count({ where: where(filter) });
  },
};
