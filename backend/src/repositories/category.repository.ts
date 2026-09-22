import type { Category, Prisma } from '@prisma/client';

import type { CategoryListQuery } from '@shared/schemas/catalogAdmin';
import type { ListQuery } from '@shared/schemas/common';

import { prisma } from '../config/prisma';

import { notDeleted, orderBy, pageResult, skipTake, type PageResult } from './helpers';

const SORTABLE = ['name', 'slug', 'position', 'depth', 'createdAt', 'updatedAt'] as const;

export type AdminCategoryQuery = CategoryListQuery;

export interface CategoryFilter {
  includeInactive?: boolean;
  maxDepth?: number;
  parentId?: string | null;
}

function where(filter: CategoryFilter = {}): Prisma.CategoryWhereInput {
  return {
    ...notDeleted,
    ...(filter.includeInactive ? {} : { isActive: true }),
    ...(filter.maxDepth === undefined ? {} : { depth: { lte: filter.maxDepth } }),
    ...(filter.parentId === undefined ? {} : { parentId: filter.parentId }),
  };
}

/** R1 — the only layer allowed to talk to Prisma. */
export const categoryRepository = {
  findById(id: string): Promise<Category | null> {
    return prisma.category.findFirst({ where: { id, ...notDeleted } });
  },

  findBySlug(slug: string, includeInactive = false): Promise<Category | null> {
    return prisma.category.findFirst({
      where: { slug, ...notDeleted, ...(includeInactive ? {} : { isActive: true }) },
    });
  },

  findManyBySlugs(slugs: string[]): Promise<Category[]> {
    return prisma.category.findMany({ where: { slug: { in: slugs }, ...notDeleted } });
  },

  /** Flat, ordered list used to assemble the tree in one query (no N+1). */
  findAllForTree(filter: CategoryFilter = {}): Promise<Category[]> {
    return prisma.category.findMany({
      where: where(filter),
      orderBy: [{ depth: 'asc' }, { position: 'asc' }, { name: 'asc' }],
    });
  },

  findChildren(parentId: string, includeInactive = false): Promise<Category[]> {
    return prisma.category.findMany({
      where: where({ parentId, includeInactive }),
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
  },

  /** Every descendant of a node, found through the materialised path. */
  findDescendants(path: string): Promise<Category[]> {
    return prisma.category.findMany({
      where: { path: { startsWith: `${path}/` }, ...notDeleted },
      orderBy: [{ depth: 'asc' }, { position: 'asc' }],
    });
  },

  async list(query: ListQuery, filter: CategoryFilter = {}): Promise<PageResult<Category>> {
    const args = { where: where(filter) };
    const [items, total] = await Promise.all([
      prisma.category.findMany({
        ...args,
        ...skipTake(query),
        orderBy: orderBy(query.sort, query.order, SORTABLE, [
          { depth: 'asc' },
          { position: 'asc' },
        ]),
      }),
      prisma.category.count(args),
    ]);
    return pageResult(items, total, query);
  },

  updatePathAndDepth(id: string, path: string, depth: number): Promise<Category> {
    return prisma.category.update({ where: { id }, data: { path, depth } });
  },

  updateProductCount(id: string, productCountCache: number): Promise<Category> {
    return prisma.category.update({ where: { id }, data: { productCountCache } });
  },

  async slugExists(slug: string, excludeId?: string): Promise<boolean> {
    const found = await prisma.category.findFirst({
      where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    return found !== null;
  },

  count(filter: CategoryFilter = {}): Promise<number> {
    return prisma.category.count({ where: where(filter) });
  },

  /* ------------------------------------------------------- admin (Prompt 5) */

  /** Admin reads see inactive and (optionally) soft-deleted rows. */
  findByIdForAdmin(id: string, includeDeleted = false): Promise<Category | null> {
    return prisma.category.findFirst({
      where: { id, ...(includeDeleted ? {} : notDeleted) },
    });
  },

  async listForAdmin(query: AdminCategoryQuery): Promise<PageResult<Category>> {
    const args = {
      where: {
        ...(query.includeDeleted ? {} : notDeleted),
        ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
        ...(query.parentId === undefined ? {} : { parentId: query.parentId }),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.depth === undefined ? {} : { depth: query.depth }),
        ...(query.q
          ? { OR: [{ name: { contains: query.q } }, { slug: { contains: query.q } }] }
          : {}),
      } satisfies Prisma.CategoryWhereInput,
    };

    const [items, total] = await Promise.all([
      prisma.category.findMany({
        ...args,
        ...skipTake(query),
        orderBy: orderBy(query.sort, query.order, SORTABLE, [
          { depth: 'asc' },
          { position: 'asc' },
        ]),
      }),
      prisma.category.count(args),
    ]);
    return pageResult(items, total, query);
  },

  /** Every node of the tree including inactive ones, for the admin manager. */
  findAllForAdminTree(includeDeleted = false): Promise<Category[]> {
    return prisma.category.findMany({
      where: includeDeleted ? {} : notDeleted,
      orderBy: [{ depth: 'asc' }, { position: 'asc' }, { name: 'asc' }],
    });
  },

  create(data: Prisma.CategoryUncheckedCreateInput): Promise<Category> {
    return prisma.category.create({ data });
  },

  countChildren(parentId: string): Promise<number> {
    return prisma.category.count({ where: { parentId, ...notDeleted } });
  },

  countDescendants(path: string): Promise<number> {
    return prisma.category.count({ where: { path: { startsWith: `${path}/` }, ...notDeleted } });
  },

  countProducts(categoryId: string): Promise<number> {
    return prisma.productCategory.count({
      where: { categoryId, product: { ...notDeleted } },
    });
  },

  countProductsInSubtree(path: string): Promise<number> {
    return prisma.productCategory.count({
      where: {
        product: { ...notDeleted },
        category: { OR: [{ path }, { path: { startsWith: `${path}/` } }] },
      },
    });
  },

  async nextPosition(parentId: string | null): Promise<number> {
    const last = await prisma.category.findFirst({
      where: { parentId, ...notDeleted },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    return (last?.position ?? -1) + 1;
  },

  setPosition(id: string, position: number): Promise<Category> {
    return prisma.category.update({ where: { id }, data: { position } });
  },

  softDelete(ids: string[]): Promise<{ count: number }> {
    return prisma.category.updateMany({
      where: { id: { in: ids } },
      data: { deletedAt: new Date(), isActive: false },
    });
  },

  restore(id: string): Promise<Category> {
    return prisma.category.update({ where: { id }, data: { deletedAt: null, isActive: true } });
  },

  hardDelete(id: string): Promise<Category> {
    return prisma.category.delete({ where: { id } });
  },

  setActive(ids: string[], isActive: boolean): Promise<{ count: number }> {
    return prisma.category.updateMany({ where: { id: { in: ids } }, data: { isActive } });
  },

  reparentChildren(fromParentId: string, toParentId: string | null): Promise<{ count: number }> {
    return prisma.category.updateMany({
      where: { parentId: fromParentId },
      data: { parentId: toParentId },
    });
  },
};
