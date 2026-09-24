import type { Category } from '@prisma/client';

import { BROWSE_VISIBILITIES, isRuleCategoryKind, type CategoryKind } from '@shared/enums';
import type { CategoryTreeQuery } from '@shared/schemas/catalog';
import type { CategoryBreadcrumbDto, CategoryDetail, CategoryNode } from '@shared/types/catalog';

import { cache } from '../container';
import { loadMerchandising } from '../modules/storefront/merchandising';
import { categoryRepository } from '../repositories/category.repository';
import { listingRepository } from '../repositories/listing.repository';
import { productRepository } from '../repositories/product.repository';
import { AppError } from '../utils/AppError';

import { categoryAttributeService } from './categoryAttribute.service';
import { categoryPathService } from './categoryPath.service';

const TREE_CACHE_PREFIX = 'cat:tree:';
const TTL_SECONDS = 300;

/**
 * Ids the storefront may show: active, not deleted, and every ancestor the same. Deactivating a
 * parent hides its whole subtree without touching the children's own flags, so reactivating it
 * brings back exactly what was live before.
 */
export function liveCategoryIds(
  rows: Pick<Category, 'id' | 'parentId' | 'isActive'>[],
): Set<string> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const memo = new Map<string, boolean>();

  const isLive = (id: string, seen: Set<string>): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const row = byId.get(id);
    // A missing parent is a deleted one; a repeated id would be a cycle the tree guard forbids.
    const live =
      row !== undefined &&
      row.isActive &&
      !seen.has(id) &&
      (row.parentId === null || isLive(row.parentId, new Set([...seen, id])));
    memo.set(id, live);
    return live;
  };

  return new Set(rows.filter((row) => isLive(row.id, new Set())).map((row) => row.id));
}

function toNode(row: Category): CategoryNode {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    path: row.path,
    depth: row.depth,
    position: row.position,
    kind: row.kind as CategoryKind,
    leadFormKey: row.leadFormKey,
    parentId: row.parentId,
    isActive: row.isActive,
    showInMenu: row.showInMenu,
    menuColumn: row.menuColumn,
    isFeatured: row.isFeatured,
    shortDescription: row.shortDescription,
    iconMediaId: row.iconMediaId,
    productCountCache: row.productCountCache,
    children: [],
  };
}

function nest(rows: Category[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>();
  for (const row of rows) nodes.set(row.id, toNode(row));

  const roots: CategoryNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = row.parentId ? nodes.get(row.parentId) : undefined;
    if (parent) parent.children.push(node);
    // A child whose parent was filtered out is not a new root: it disappears with its parent.
    else if (row.parentId === null) roots.push(node);
  }

  const sort = (list: CategoryNode[]): CategoryNode[] => {
    list.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    for (const node of list) sort(node.children);
    return list;
  };

  return sort(roots);
}

export const categoryService = {
  /**
   * Every category the storefront may show (see liveCategoryIds). One small query, read fresh:
   * callers sit behind their own caches, which every category write drops.
   */
  async liveIds(): Promise<Set<string>> {
    return liveCategoryIds(await categoryRepository.findLiveness());
  },

  /** R9 — the storefront's whole category navigation comes from here, never from code. */
  async getTree(query: CategoryTreeQuery): Promise<CategoryNode[]> {
    const key = `${TREE_CACHE_PREFIX}${query.depth ?? 'all'}:${query.includeInactive}`;

    // Without inactive rows, nest() drops every node below an inactive or deleted one.
    return cache.wrap(key, TTL_SECONDS, async () => {
      const rows = await categoryRepository.findAllForTree({
        includeInactive: query.includeInactive,
        ...(query.depth === undefined ? {} : { maxDepth: query.depth - 1 }),
      });
      return nest(rows);
    });
  },

  async getBySlug(slug: string, includeInactive = false): Promise<CategoryDetail> {
    const category = await categoryRepository.findBySlug(slug, includeInactive);
    if (!category) throw AppError.notFound(`Category "${slug}" not found`, { slug });

    const lineageSlugs = categoryPathService.ancestorSlugs(category.path);
    const [lineage, children, attributes] = await Promise.all([
      categoryRepository.findManyBySlugs(lineageSlugs),
      categoryRepository.findChildren(category.id, includeInactive),
      categoryAttributeService.resolveForCategory(category.id),
    ]);

    // Under an inactive or deleted ancestor the category is not on the storefront at all.
    const byLineage = new Map(lineage.map((row) => [row.slug, row]));
    const hidden = lineageSlugs.some((lineageSlug) => {
      const row = byLineage.get(lineageSlug);
      return !row || !row.isActive;
    });
    if (!includeInactive && hidden) {
      throw AppError.notFound(`Category "${slug}" not found`, { slug });
    }

    const bySlug = new Map(lineage.map((row) => [row.slug, row]));
    const breadcrumbs: CategoryBreadcrumbDto[] = lineageSlugs.flatMap((lineageSlug) => {
      const row = bySlug.get(lineageSlug);
      return row ? [{ id: row.id, name: row.name, slug: row.slug, depth: row.depth }] : [];
    });

    return {
      ...toNode(category),
      children: children.map(toNode),
      description: category.description,
      bannerMediaId: category.bannerMediaId,
      mobileBannerMediaId: category.mobileBannerMediaId,
      seoTitle: category.seoTitle,
      seoDescription: category.seoDescription,
      seoKeywords: category.seoKeywords,
      breadcrumbs,
      attributes,
    };
  },

  /**
   * Refreshes `Category.productCountCache`: what each category's own listing can show. A product
   * counts towards every category it is linked to, including its "All X" parent; a rule category
   * (New Arrivals, Special Collection, Make Your Own) also counts the parent's products with its
   * fact, judged by the listing SQL itself. The seed and the listing reconciler call this.
   */
  async recomputeProductCounts(now = new Date()): Promise<number> {
    const [counts, categories, merchandising] = await Promise.all([
      productRepository.countByCategory(),
      categoryRepository.findAllForTree({ includeInactive: true }),
      loadMerchandising(now),
    ]);

    const totals = new Map(counts.map((row) => [row.categoryId, row.total]));
    const live = liveCategoryIds(categories);

    for (const category of categories) {
      if (!isRuleCategoryKind(category.kind) || !live.has(category.id)) continue;

      const parentPath = category.path.split('/').slice(0, -1).join('/');
      const parentCategoryIds = parentPath
        ? categories
            .filter(
              (row) =>
                live.has(row.id) &&
                (row.path === parentPath || row.path.startsWith(`${parentPath}/`)),
            )
            .map((row) => row.id)
        : null;

      const summary = await listingRepository.summary({
        now,
        newArrivalSince: merchandising.newArrivalSince,
        visibilities: BROWSE_VISIBILITIES,
        categoryIds: [category.id],
        categoryRule: { kind: category.kind, parentCategoryIds },
        collectionId: null,
        brandIds: [],
        attributeValues: [],
        inStockOnly: false,
        hideOutOfStock: false,
        onSale: false,
      });
      totals.set(category.id, summary.total);
    }

    let updated = 0;

    for (const category of categories) {
      const total = totals.get(category.id) ?? 0;
      if (total !== category.productCountCache) {
        await categoryRepository.updateProductCount(category.id, total);
        updated += 1;
      }
    }

    return updated;
  },
};
