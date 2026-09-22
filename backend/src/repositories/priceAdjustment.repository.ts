import type { PriceAdjustment, Prisma } from '@prisma/client';

import type { PriceAdjustmentScope } from '@shared/enums';
import type { ListQuery } from '@shared/schemas/common';

import { prisma } from '../config/prisma';

import { notDeleted, orderBy, pageResult, skipTake, type PageResult } from './helpers';

const SORTABLE = ['name', 'priority', 'scope', 'createdAt', 'updatedAt'] as const;

export interface PriceAdjustmentFilter {
  includeInactive?: boolean;
  scopes?: PriceAdjustmentScope[];
  productIds?: string[];
  categoryIds?: string[];
  variantIds?: string[];
  attributeValueIds?: string[];
  /** Only rules whose window contains this instant. */
  activeAt?: Date;
}

function where(filter: PriceAdjustmentFilter = {}): Prisma.PriceAdjustmentWhereInput {
  const windowClause = filter.activeAt
    ? {
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: filter.activeAt } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: filter.activeAt } }] },
        ],
      }
    : {};

  const scopeTargets: Prisma.PriceAdjustmentWhereInput[] = [];
  if (filter.productIds) scopeTargets.push({ productId: { in: filter.productIds } });
  if (filter.categoryIds) scopeTargets.push({ categoryId: { in: filter.categoryIds } });
  if (filter.variantIds) scopeTargets.push({ variantId: { in: filter.variantIds } });
  if (filter.attributeValueIds) {
    scopeTargets.push({ attributeValueId: { in: filter.attributeValueIds } });
  }

  return {
    ...notDeleted,
    ...(filter.includeInactive ? {} : { isActive: true }),
    ...(filter.scopes ? { scope: { in: filter.scopes } } : {}),
    ...(scopeTargets.length > 0 ? { OR: [{ scope: 'GLOBAL' }, ...scopeTargets] } : {}),
    ...windowClause,
  };
}

/**
 * Prompt 2 ships storage and retrieval only — resolution, stacking and maths live in the Prompt 6
 * PricingEngine, which will consume `findApplicable()`.
 */
export const priceAdjustmentRepository = {
  findById(id: string): Promise<PriceAdjustment | null> {
    return prisma.priceAdjustment.findFirst({ where: { id, ...notDeleted } });
  },

  findApplicable(filter: PriceAdjustmentFilter): Promise<PriceAdjustment[]> {
    return prisma.priceAdjustment.findMany({
      where: where(filter),
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
  },

  async list(
    query: ListQuery,
    filter: PriceAdjustmentFilter = {},
  ): Promise<PageResult<PriceAdjustment>> {
    const args = { where: where(filter) };
    const [items, total] = await Promise.all([
      prisma.priceAdjustment.findMany({
        ...args,
        ...skipTake(query),
        orderBy: orderBy(query.sort, query.order, SORTABLE, [
          { priority: 'asc' },
          { createdAt: 'asc' },
        ]),
      }),
      prisma.priceAdjustment.count(args),
    ]);
    return pageResult(items, total, query);
  },

  count(filter: PriceAdjustmentFilter = {}): Promise<number> {
    return prisma.priceAdjustment.count({ where: where(filter) });
  },
};
