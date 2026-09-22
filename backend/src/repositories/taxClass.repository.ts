import type { Prisma, TaxClass } from '@prisma/client';

import type { ListQuery } from '@shared/schemas/common';

import { prisma } from '../config/prisma';

import { notDeleted, orderBy, pageResult, skipTake, type PageResult } from './helpers';

const SORTABLE = ['code', 'name', 'rateBp', 'createdAt', 'updatedAt'] as const;

export interface TaxClassFilter {
  includeInactive?: boolean;
}

function where(filter: TaxClassFilter = {}): Prisma.TaxClassWhereInput {
  return { ...notDeleted, ...(filter.includeInactive ? {} : { isActive: true }) };
}

export const taxClassRepository = {
  findByCode(code: string): Promise<TaxClass | null> {
    return prisma.taxClass.findFirst({ where: { code, ...notDeleted } });
  },

  findDefault(): Promise<TaxClass | null> {
    return prisma.taxClass.findFirst({ where: { isDefault: true, ...where() } });
  },

  findAll(filter: TaxClassFilter = {}): Promise<TaxClass[]> {
    return prisma.taxClass.findMany({ where: where(filter), orderBy: [{ rateBp: 'asc' }] });
  },

  async list(query: ListQuery, filter: TaxClassFilter = {}): Promise<PageResult<TaxClass>> {
    const args = { where: where(filter) };
    const [items, total] = await Promise.all([
      prisma.taxClass.findMany({
        ...args,
        ...skipTake(query),
        orderBy: orderBy(query.sort, query.order, SORTABLE, [{ rateBp: 'asc' }]),
      }),
      prisma.taxClass.count(args),
    ]);
    return pageResult(items, total, query);
  },

  count(filter: TaxClassFilter = {}): Promise<number> {
    return prisma.taxClass.count({ where: where(filter) });
  },
};
