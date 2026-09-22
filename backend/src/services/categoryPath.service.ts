import { MAX_CATEGORY_DEPTH } from '@shared/schemas/catalog';

import { categoryRepository } from '../repositories/category.repository';
import {
  ancestorSlugs,
  assertDepthWithinCap,
  assertNoCycle,
  buildPath,
  depthFor,
  recomputeSubtree,
  type MaterializedPathOptions,
  type PathNode,
} from '../utils/materializedPath';

/**
 * `Category.path` is a materialised slug path ("sofas/fabric-sofas"). It is what makes breadcrumbs,
 * descendant lookups and attribute inheritance single queries — so it is only ever written here.
 * The tree algorithm itself lives in utils/materializedPath.ts and is shared with media folders.
 */

const OPTIONS: MaterializedPathOptions = {
  maxDepth: MAX_CATEGORY_DEPTH,
  entity: 'Category',
  cycleCode: 'CATEGORY_CYCLE',
};

async function loadNode(id: string): Promise<PathNode | null> {
  const row = await categoryRepository.findById(id);
  return row
    ? { id: row.id, slug: row.slug, parentId: row.parentId, path: row.path, depth: row.depth }
    : null;
}

export const categoryPathService = {
  maxDepth: MAX_CATEGORY_DEPTH,
  buildPath,
  depthFor,
  ancestorSlugs,

  assertDepthWithinCap(depth: number, slug: string): void {
    assertDepthWithinCap(depth, slug, OPTIONS);
  },

  /** A category may not become a descendant of itself. */
  assertNoCycle(categoryId: string, parentId: string | null): Promise<void> {
    return assertNoCycle(categoryId, parentId, loadNode, OPTIONS);
  },

  /**
   * Rewrites `path`/`depth` for a category and every descendant. Called after a move or a rename
   * by Prompt 5's admin CRUD; returns how many rows changed.
   */
  recomputeSubtree(categoryId: string): Promise<number> {
    return recomputeSubtree(
      categoryId,
      {
        load: loadNode,
        async children(parentId) {
          const rows = await categoryRepository.findChildren(parentId, true);
          return rows.map((row) => ({
            id: row.id,
            slug: row.slug,
            parentId: row.parentId,
            path: row.path,
            depth: row.depth,
          }));
        },
        save: (id, path, depth) => categoryRepository.updatePathAndDepth(id, path, depth),
      },
      OPTIONS,
    );
  },
};
