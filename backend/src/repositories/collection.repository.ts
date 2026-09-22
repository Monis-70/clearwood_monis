import type { Collection, Prisma } from '@prisma/client';

import type { ListQuery } from '@shared/schemas/common';

import { prisma } from '../config/prisma';

import { notDeleted, orderBy, pageResult, skipTake, type PageResult } from './helpers';

const SORTABLE = ['name', 'slug', 'position', 'createdAt', 'updatedAt'] as const;

export interface CollectionFilter {
  includeInactive?: boolean;
  type?: string;
}

function where(filter: CollectionFilter = {}): Prisma.CollectionWhereInput {
  return {
    ...notDeleted,
    ...(filter.includeInactive ? {} : { isActive: true }),
    ...(filter.type ? { type: filter.type } : {}),
  };
}

export const collectionRepository = {
  findBySlug(slug: string, includeInactive = false): Promise<Collection | null> {
    return prisma.collection.findFirst({
      where: { slug, ...notDeleted, ...(includeInactive ? {} : { isActive: true }) },
    });
  },

  findAll(filter: CollectionFilter = {}): Promise<Collection[]> {
    return prisma.collection.findMany({
      where: where(filter),
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
  },

  async list(query: ListQuery, filter: CollectionFilter = {}): Promise<PageResult<Collection>> {
    const args = { where: where(filter) };
    const [items, total] = await Promise.all([
      prisma.collection.findMany({
        ...args,
        ...skipTake(query),
        orderBy: orderBy(query.sort, query.order, SORTABLE, [{ position: 'asc' }, { name: 'asc' }]),
      }),
      prisma.collection.count(args),
    ]);
    return pageResult(items, total, query);
  },

  async slugExists(slug: string, excludeId?: string): Promise<boolean> {
    const found = await prisma.collection.findFirst({
      where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    return found !== null;
  },

  count(filter: CollectionFilter = {}): Promise<number> {
    return prisma.collection.count({ where: where(filter) });
  },
};
