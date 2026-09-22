import type { Category } from '@prisma/client';

import type { CategoryKind } from '@shared/enums';
import type { CategoryTreeQuery } from '@shared/schemas/catalog';
import type { CategoryBreadcrumbDto, CategoryDetail, CategoryNode } from '@shared/types/catalog';

import { cache } from '../container';
import { categoryRepository } from '../repositories/category.repository';
import { productRepository } from '../repositories/product.repository';
import { AppError } from '../utils/AppError';

import { categoryAttributeService } from './categoryAttribute.service';
import { categoryPathService } from './categoryPath.service';

const TREE_CACHE_PREFIX = 'cat:tree:';
const TTL_SECONDS = 300;

function toNode(row: Category): CategoryNode {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    path: row.path,
    depth: row.depth,
    position: row.position,
    kind: row.kind as CategoryKind,
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
    else roots.push(node);
  }

  const sort = (list: CategoryNode[]): CategoryNode[] => {
    list.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    for (const node of list) sort(node.children);
    return list;
  };

  return sort(roots);
}

export const categoryService = {
  /** R9 — the storefront's whole category navigation comes from here, never from code. */
  async getTree(query: CategoryTreeQuery): Promise<CategoryNode[]> {
    const key = `${TREE_CACHE_PREFIX}${query.depth ?? 'all'}:${query.includeInactive}`;

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
   * Refreshes `Category.productCountCache`. The seed calls it; Prompt 5's admin writes will too.
   * A product counts towards every category it is linked to, including its "All X" parent.
   */
  async recomputeProductCounts(): Promise<number> {
    const [counts, categories] = await Promise.all([
      productRepository.countByCategory(),
      categoryRepository.findAllForTree({ includeInactive: true }),
    ]);

    const totals = new Map(counts.map((row) => [row.categoryId, row.total]));
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
