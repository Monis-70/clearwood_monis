import type { Prisma } from '@prisma/client';

import type { ListQuery } from '@shared/schemas/common';

import { prisma } from '../config/prisma';

import { notDeleted, orderBy, pageResult, skipTake, type PageResult } from './helpers';

const SORTABLE = ['code', 'name', 'position', 'createdAt', 'updatedAt'] as const;

const withValues = {
  group: true,
  values: {
    where: { ...notDeleted, isActive: true },
    orderBy: [{ position: 'asc' as const }, { label: 'asc' as const }],
  },
} satisfies Prisma.AttributeInclude;

export type AttributeWithValues = Prisma.AttributeGetPayload<{ include: typeof withValues }>;

export interface AttributeFilter {
  includeInactive?: boolean;
  filterableOnly?: boolean;
  ids?: string[];
  codes?: string[];
}

function where(filter: AttributeFilter = {}): Prisma.AttributeWhereInput {
  return {
    ...notDeleted,
    ...(filter.includeInactive ? {} : { isActive: true }),
    ...(filter.filterableOnly ? { isFilterable: true } : {}),
    ...(filter.ids ? { id: { in: filter.ids } } : {}),
    ...(filter.codes ? { code: { in: filter.codes } } : {}),
  };
}

export const attributeRepository = {
  findById(id: string): Promise<AttributeWithValues | null> {
    return prisma.attribute.findFirst({ where: { id, ...notDeleted }, include: withValues });
  },

  findByCode(code: string): Promise<AttributeWithValues | null> {
    return prisma.attribute.findFirst({ where: { code, ...notDeleted }, include: withValues });
  },

  findManyByIds(ids: string[]): Promise<AttributeWithValues[]> {
    return prisma.attribute.findMany({
      where: where({ ids }),
      include: withValues,
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
  },

  /** Every filterable attribute — the facet set when a listing is not scoped to a category. */
  findFilterable(): Promise<AttributeWithValues[]> {
    return prisma.attribute.findMany({
      where: where({ filterableOnly: true }),
      include: withValues,
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
  },

  async list(
    query: ListQuery,
    filter: AttributeFilter = {},
  ): Promise<PageResult<AttributeWithValues>> {
    const args = { where: where(filter) };
    const [items, total] = await Promise.all([
      prisma.attribute.findMany({
        ...args,
        ...skipTake(query),
        include: withValues,
        orderBy: orderBy(query.sort, query.order, SORTABLE, [{ position: 'asc' }, { name: 'asc' }]),
      }),
      prisma.attribute.count(args),
    ]);
    return pageResult(items, total, query);
  },

  /** CategoryAttribute rows for a set of categories, deepest first is resolved by the service. */
  findCategoryLinks(categoryIds: string[]): Promise<
    Prisma.CategoryAttributeGetPayload<{
      include: { category: { select: { id: true; slug: true; depth: true } } };
    }>[]
  > {
    return prisma.categoryAttribute.findMany({
      where: { categoryId: { in: categoryIds } },
      include: { category: { select: { id: true, slug: true, depth: true } } },
      orderBy: [{ position: 'asc' }],
    });
  },

  count(filter: AttributeFilter = {}): Promise<number> {
    return prisma.attribute.count({ where: where(filter) });
  },
};
