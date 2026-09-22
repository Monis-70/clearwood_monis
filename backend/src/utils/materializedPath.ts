import { AppError } from './AppError';

/**
 * The materialised-path algorithm shared by the category tree (Prompt 2) and the media folder tree
 * (Prompt 4). One implementation, two consumers — see `categoryPath.service` and
 * `mediaFolder.service` for the persistence around it.
 */

export interface PathNode {
  id: string;
  slug: string;
  parentId: string | null;
  path: string;
  depth: number;
}

export interface MaterializedPathOptions {
  maxDepth: number;
  /** Used in the error messages so each tree reads naturally. */
  entity: string;
  cycleCode: string;
}

export function buildPath(parentPath: string | null, slug: string): string {
  return parentPath ? `${parentPath}/${slug}` : slug;
}

export function depthFor(parentDepth: number | null): number {
  return parentDepth === null ? 0 : parentDepth + 1;
}

/** Slugs from root to leaf: "sofas/fabric-sofas" -> ["sofas", "fabric-sofas"]. */
export function ancestorSlugs(path: string): string[] {
  return path.split('/').filter(Boolean);
}

export function assertDepthWithinCap(
  depth: number,
  slug: string,
  options: MaterializedPathOptions,
): void {
  if (depth > options.maxDepth) {
    throw AppError.validation(
      `${options.entity} "${slug}" would sit at depth ${depth}; the cap is ${options.maxDepth}`,
      { slug, depth, maxDepth: options.maxDepth },
    );
  }
}

/** A node may not become a descendant of itself. */
export async function assertNoCycle(
  nodeId: string,
  parentId: string | null,
  loadNode: (id: string) => Promise<PathNode | null>,
  options: MaterializedPathOptions,
): Promise<void> {
  if (!parentId) return;

  if (parentId === nodeId) {
    throw new AppError(
      409,
      options.cycleCode,
      `A ${options.entity.toLowerCase()} cannot be its own parent`,
      {
        nodeId,
      },
    );
  }

  const seen = new Set<string>([nodeId]);
  let cursor = await loadNode(parentId);

  while (cursor) {
    if (seen.has(cursor.id)) {
      throw new AppError(
        409,
        options.cycleCode,
        `The chosen parent is a descendant of this ${options.entity.toLowerCase()}`,
        { nodeId, parentId },
      );
    }
    seen.add(cursor.id);
    cursor = cursor.parentId ? await loadNode(cursor.parentId) : null;
  }
}

export interface SubtreeAdapter {
  load(id: string): Promise<PathNode | null>;
  children(parentId: string): Promise<PathNode[]>;
  save(id: string, path: string, depth: number): Promise<unknown>;
}

/** Rewrites `path`/`depth` for a node and every descendant; returns how many rows changed. */
export async function recomputeSubtree(
  nodeId: string,
  adapter: SubtreeAdapter,
  options: MaterializedPathOptions,
): Promise<number> {
  const root = await adapter.load(nodeId);
  if (!root) throw AppError.notFound(`${options.entity} not found`, { nodeId });

  const parent = root.parentId ? await adapter.load(root.parentId) : null;
  if (root.parentId && !parent) {
    throw AppError.notFound(`Parent ${options.entity.toLowerCase()} not found`, {
      parentId: root.parentId,
    });
  }

  await assertNoCycle(root.id, root.parentId, adapter.load, options);

  const rootPath = buildPath(parent?.path ?? null, root.slug);
  const rootDepth = depthFor(parent?.depth ?? null);
  assertDepthWithinCap(rootDepth, root.slug, options);

  let updated = 0;
  if (rootPath !== root.path || rootDepth !== root.depth) {
    await adapter.save(root.id, rootPath, rootDepth);
    updated += 1;
  }

  const queue: { id: string; path: string; depth: number }[] = [
    { id: root.id, path: rootPath, depth: rootDepth },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;

    for (const child of await adapter.children(current.id)) {
      const path = buildPath(current.path, child.slug);
      const depth = current.depth + 1;
      assertDepthWithinCap(depth, child.slug, options);

      if (path !== child.path || depth !== child.depth) {
        await adapter.save(child.id, path, depth);
        updated += 1;
      }
      queue.push({ id: child.id, path, depth });
    }
  }

  return updated;
}
