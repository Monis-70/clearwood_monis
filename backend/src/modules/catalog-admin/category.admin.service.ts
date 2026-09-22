import type { Category } from '@prisma/client';

import type { DeleteStrategy } from '@shared/enums';
import type {
  CategoryCreateInput,
  CategoryListQuery,
  CategoryMoveInput,
  CategoryUpdateInput,
  ReorderInput,
} from '@shared/schemas/catalogAdmin';
import type { AdminCategoryDto, CategoryDeleteImpactDto } from '@shared/types/catalogAdmin';

import { prisma } from '../../config/prisma';
import { categoryRepository } from '../../repositories/category.repository';
import type { PageResult } from '../../repositories/helpers';
import { updateVersioned } from '../../repositories/versioned';
import { categoryPathService } from '../../services/categoryPath.service';
import { AppError } from '../../utils/AppError';
import { ensureUniqueSlug, slugify } from '../../utils/slug';
import { mediaUsageService } from '../media/media-usage.service';

import { catalogCacheService } from './catalogCache.service';
import { slugRedirectService } from './slugRedirect.service';

/**
 * Admin category CRUD. Tree mechanics (path, depth, cycle guard) stay in categoryPathService —
 * this service owns the business rules around them.
 */

const MEDIA_FIELDS = [
  ['iconMediaId', 'CATEGORY_ICON'],
  ['bannerMediaId', 'CATEGORY_BANNER'],
  ['mobileBannerMediaId', 'CATEGORY_MOBILE_BANNER'],
] as const;

export async function toAdminDto(category: Category): Promise<AdminCategoryDto> {
  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    parentId: category.parentId,
    path: category.path,
    depth: category.depth,
    position: category.position,
    kind: category.kind,
    isActive: category.isActive,
    showInMenu: category.showInMenu,
    menuColumn: category.menuColumn,
    isFeatured: category.isFeatured,
    shortDescription: category.shortDescription,
    description: category.description,
    iconMediaId: category.iconMediaId,
    bannerMediaId: category.bannerMediaId,
    mobileBannerMediaId: category.mobileBannerMediaId,
    seoTitle: category.seoTitle,
    seoDescription: category.seoDescription,
    seoKeywords: category.seoKeywords,
    deleteStrategyNote: category.deleteStrategyNote,
    productCountCache: category.productCountCache,
    childCount: await categoryRepository.countChildren(category.id),
    version: category.version,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
    deletedAt: category.deletedAt?.toISOString() ?? null,
  };
}

function dtoSync(category: Category, childCount: number): AdminCategoryDto {
  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    parentId: category.parentId,
    path: category.path,
    depth: category.depth,
    position: category.position,
    kind: category.kind,
    isActive: category.isActive,
    showInMenu: category.showInMenu,
    menuColumn: category.menuColumn,
    isFeatured: category.isFeatured,
    shortDescription: category.shortDescription,
    description: category.description,
    iconMediaId: category.iconMediaId,
    bannerMediaId: category.bannerMediaId,
    mobileBannerMediaId: category.mobileBannerMediaId,
    seoTitle: category.seoTitle,
    seoDescription: category.seoDescription,
    seoKeywords: category.seoKeywords,
    deleteStrategyNote: category.deleteStrategyNote,
    productCountCache: category.productCountCache,
    childCount,
    version: category.version,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
    deletedAt: category.deletedAt?.toISOString() ?? null,
  };
}

async function loadOrThrow(id: string, includeDeleted = false): Promise<Category> {
  const category = await categoryRepository.findByIdForAdmin(id, includeDeleted);
  if (!category) throw AppError.notFound('Category not found', { id });
  return category;
}

async function syncMediaUsage(category: Category, previous?: Category): Promise<void> {
  for (const [field, usageType] of MEDIA_FIELDS) {
    const next = category[field];
    const before = previous?.[field] ?? null;
    if (next === before) continue;

    if (before) {
      await mediaUsageService.detach({
        mediaId: before,
        usageType,
        entityId: category.id,
        field,
      });
    }
    if (next) {
      await mediaUsageService.attach({ mediaId: next, usageType, entityId: category.id, field });
    }
  }
}

export const categoryAdminService = {
  toAdminDto,

  async list(query: CategoryListQuery): Promise<PageResult<AdminCategoryDto>> {
    const page = await categoryRepository.listForAdmin(query);
    const counts = await prisma.category.groupBy({
      by: ['parentId'],
      where: { deletedAt: null, parentId: { in: page.items.map((item) => item.id) } },
      _count: { _all: true },
    });
    const byParent = new Map(counts.map((row) => [row.parentId, row._count._all]));

    return {
      ...page,
      items: page.items.map((item) => dtoSync(item, byParent.get(item.id) ?? 0)),
    };
  },

  /** The whole tree, inactive rows included, assembled in one query. */
  async tree(includeDeleted = false): Promise<AdminCategoryDto[]> {
    const rows = await categoryRepository.findAllForAdminTree(includeDeleted);
    const childCounts = new Map<string, number>();
    for (const row of rows) {
      if (!row.parentId) continue;
      childCounts.set(row.parentId, (childCounts.get(row.parentId) ?? 0) + 1);
    }
    return rows.map((row) => dtoSync(row, childCounts.get(row.id) ?? 0));
  },

  async get(id: string): Promise<AdminCategoryDto> {
    return toAdminDto(await loadOrThrow(id, true));
  },

  async create(input: CategoryCreateInput): Promise<AdminCategoryDto> {
    const parent = input.parentId ? await loadOrThrow(input.parentId) : null;

    const base = input.slug ? slugify(input.slug) : slugify(input.name);
    const slug = await ensureUniqueSlug(categoryRepository, base);
    await slugRedirectService.assertSlugFree('CATEGORY', slug, null);

    const path = categoryPathService.buildPath(parent?.path ?? null, slug);
    const depth = categoryPathService.depthFor(parent?.depth ?? null);
    categoryPathService.assertDepthWithinCap(depth, slug);

    const created = await categoryRepository.create({
      name: input.name,
      slug,
      parentId: parent?.id ?? null,
      path,
      depth,
      position: input.position ?? (await categoryRepository.nextPosition(parent?.id ?? null)),
      kind: input.kind,
      isActive: input.isActive,
      showInMenu: input.showInMenu,
      menuColumn: input.menuColumn ?? null,
      isFeatured: input.isFeatured,
      shortDescription: input.shortDescription ?? null,
      description: input.description ?? null,
      iconMediaId: input.iconMediaId ?? null,
      bannerMediaId: input.bannerMediaId ?? null,
      mobileBannerMediaId: input.mobileBannerMediaId ?? null,
      deleteStrategyNote: input.deleteStrategyNote ?? null,
      seoTitle: input.seoTitle ?? null,
      seoDescription: input.seoDescription ?? null,
      seoKeywords: input.seoKeywords ?? null,
    });

    await syncMediaUsage(created);
    await catalogCacheService.invalidateCategoryTree();

    return toAdminDto(created);
  },

  async update(id: string, input: CategoryUpdateInput): Promise<AdminCategoryDto> {
    const existing = await loadOrThrow(id, true);
    const { version, slug: requestedSlug, parentId: _ignored, ...rest } = input;

    let slug = existing.slug;
    if (requestedSlug !== undefined || rest.name !== undefined) {
      const base = requestedSlug ? slugify(requestedSlug) : existing.slug;
      if (base !== existing.slug) {
        slug = await ensureUniqueSlug(categoryRepository, base, id);
        await slugRedirectService.assertSlugFree('CATEGORY', slug, id);
      }
    }

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) data[key] = value;
    }

    const slugChanged = slug !== existing.slug;
    if (slugChanged) {
      data.slug = slug;
      data.path = categoryPathService.buildPath(
        existing.path.split('/').slice(0, -1).join('/') || null,
        slug,
      );
    }

    await updateVersioned(prisma.category, 'Category', id, version, data);

    if (slugChanged) {
      await slugRedirectService.recordSlugChange('CATEGORY', id, existing.slug, slug);
      await categoryPathService.recomputeSubtree(id);
    }

    const updated = await loadOrThrow(id, true);
    await syncMediaUsage(updated, existing);
    await catalogCacheService.invalidateCategory();

    return toAdminDto(updated);
  },

  /** Re-parents a node and recomputes the whole subtree's path/depth in one transaction. */
  async move(id: string, input: CategoryMoveInput): Promise<AdminCategoryDto> {
    const existing = await loadOrThrow(id);

    if (input.parentId === id) {
      throw AppError.conflict('A category cannot be its own parent', { id });
    }

    const parent = input.parentId ? await loadOrThrow(input.parentId) : null;
    await categoryPathService.assertNoCycle(id, input.parentId);

    const newPath = categoryPathService.buildPath(parent?.path ?? null, existing.slug);
    const newDepth = categoryPathService.depthFor(parent?.depth ?? null);
    categoryPathService.assertDepthWithinCap(newDepth, existing.slug);

    const deepest = await prisma.category.findFirst({
      where: { path: { startsWith: `${existing.path}/` }, deletedAt: null },
      orderBy: { depth: 'desc' },
      select: { depth: true, slug: true },
    });

    if (deepest) {
      const shift = newDepth - existing.depth;
      categoryPathService.assertDepthWithinCap(deepest.depth + shift, deepest.slug);
    }

    const position =
      input.position ?? (await categoryRepository.nextPosition(input.parentId ?? null));

    await updateVersioned(prisma.category, 'Category', id, input.version, {
      parentId: input.parentId,
      position,
      path: newPath,
      depth: newDepth,
    });

    await categoryPathService.recomputeSubtree(id);
    await catalogCacheService.invalidateCategoryTree();

    return toAdminDto(await loadOrThrow(id));
  },

  async reorder(input: ReorderInput): Promise<number> {
    await prisma.$transaction(
      input.items.map((item) =>
        prisma.category.update({ where: { id: item.id }, data: { position: item.position } }),
      ),
    );
    await catalogCacheService.invalidateCategoryTree();
    return input.items.length;
  },

  async bulkSetActive(ids: string[], isActive: boolean): Promise<number> {
    const { count } = await categoryRepository.setActive(ids, isActive);
    await catalogCacheService.invalidateCategoryTree();
    return count;
  },

  /** What a delete would touch — the UI shows this before asking for confirmation. */
  async deleteImpact(id: string, strategy: DeleteStrategy): Promise<CategoryDeleteImpactDto> {
    const category = await loadOrThrow(id);

    const [directChildren, descendants, directProducts, descendantProducts] = await Promise.all([
      categoryRepository.countChildren(id),
      categoryRepository.countDescendants(category.path),
      categoryRepository.countProducts(id),
      categoryRepository.countProductsInSubtree(category.path),
    ]);

    let blockReason: string | null = null;

    if (strategy === 'BLOCK' && (directChildren > 0 || directProducts > 0)) {
      blockReason = 'The category still has children or products';
    }
    if (strategy === 'REASSIGN_CHILDREN' && directProducts > 0) {
      blockReason = 'The category still has products of its own';
    }
    if (category.kind === 'ALL' && category.parentId) {
      const siblingProducts = await categoryRepository.countProductsInSubtree(
        category.path.split('/').slice(0, -1).join('/'),
      );
      if (siblingProducts > directProducts) {
        blockReason = 'An "All" category cannot be removed while its parent still has products';
      }
    }

    return {
      categoryId: id,
      strategy,
      directChildren,
      descendants,
      directProducts,
      descendantProducts,
      blocked: blockReason !== null,
      blockReason,
    };
  },

  /**
   * BLOCK              refuse while anything depends on it (default)
   * SOFT               soft-delete just this node (only when it is already empty)
   * REASSIGN_CHILDREN  children move up to the parent, then this node is soft-deleted
   * CASCADE_SOFT       the whole subtree is soft-deleted in one transaction
   */
  async remove(id: string, strategy: DeleteStrategy): Promise<{ deleted: number }> {
    const category = await loadOrThrow(id);
    const impact = await this.deleteImpact(id, strategy);

    if (impact.blocked) {
      throw new AppError(
        409,
        'CATEGORY_IN_USE',
        impact.blockReason ?? 'Category is in use',
        impact,
      );
    }

    let ids = [id];

    if (strategy === 'CASCADE_SOFT') {
      const descendants = await categoryRepository.findDescendants(category.path);
      ids = [id, ...descendants.map((row) => row.id)];
    } else if (strategy === 'REASSIGN_CHILDREN') {
      await categoryRepository.reparentChildren(id, category.parentId);
    }

    await categoryRepository.softDelete(ids);

    if (strategy === 'REASSIGN_CHILDREN' && category.parentId) {
      await categoryPathService.recomputeSubtree(category.parentId);
    }

    await catalogCacheService.invalidateCategoryTree();
    return { deleted: ids.length };
  },

  async restore(id: string): Promise<AdminCategoryDto> {
    const category = await categoryRepository.findByIdForAdmin(id, true);
    if (!category) throw AppError.notFound('Category not found', { id });

    const restored = await categoryRepository.restore(id);
    await catalogCacheService.invalidateCategoryTree();
    return toAdminDto(restored);
  },
};
