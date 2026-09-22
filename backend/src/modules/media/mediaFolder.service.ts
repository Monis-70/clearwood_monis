import { MAX_MEDIA_DEPTH, SYSTEM_MEDIA_FOLDERS } from '@shared/constants';
import type { MediaFolderCreateInput, MediaFolderUpdateInput } from '@shared/schemas/media';
import type { MediaFolderDto } from '@shared/types/media';

import { mediaFolderRepository } from '../../repositories/mediaFolder.repository';
import { AppError } from '../../utils/AppError';
import {
  assertDepthWithinCap,
  assertNoCycle,
  buildPath,
  depthFor,
  recomputeSubtree,
  type MaterializedPathOptions,
  type PathNode,
} from '../../utils/materializedPath';
import { ensureUniqueSlug, slugify } from '../../utils/slug';

/** Media folders use the same materialised-path algorithm as the category tree (utils/). */

const OPTIONS: MaterializedPathOptions = {
  maxDepth: MAX_MEDIA_DEPTH,
  entity: 'Media folder',
  cycleCode: 'MEDIA_FOLDER_CYCLE',
};

async function loadNode(id: string): Promise<PathNode | null> {
  const row = await mediaFolderRepository.findById(id);
  return row
    ? { id: row.id, slug: row.slug, parentId: row.parentId, path: row.path, depth: row.depth }
    : null;
}

function toDto(
  row: Awaited<ReturnType<typeof mediaFolderRepository.findAll>>[number],
  mediaCount?: number,
): MediaFolderDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    path: row.path,
    depth: row.depth,
    position: row.position,
    parentId: row.parentId,
    isSystem: row.isSystem,
    ...(mediaCount === undefined ? {} : { mediaCount }),
  };
}

export const mediaFolderService = {
  systemFolders: SYSTEM_MEDIA_FOLDERS,

  async tree(): Promise<MediaFolderDto[]> {
    const [rows, counts] = await Promise.all([
      mediaFolderRepository.findAll(),
      mediaFolderRepository.mediaCounts(),
    ]);

    const nodes = new Map<string, MediaFolderDto>();
    for (const row of rows)
      nodes.set(row.id, { ...toDto(row, counts.get(row.id) ?? 0), children: [] });

    const roots: MediaFolderDto[] = [];
    for (const row of rows) {
      const node = nodes.get(row.id)!;
      const parent = row.parentId ? nodes.get(row.parentId) : undefined;
      if (parent) parent.children!.push(node);
      else roots.push(node);
    }

    return roots;
  },

  async get(id: string): Promise<MediaFolderDto> {
    const row = await mediaFolderRepository.findById(id);
    if (!row) throw AppError.notFound('Media folder not found', { id });
    return toDto(row, await mediaFolderRepository.countMedia(id));
  },

  /** Used by uploads: "products/sofas" is created on demand rather than failing. */
  async resolveByPath(path: string): Promise<MediaFolderDto> {
    const cleaned = path.replace(/^\/+|\/+$/g, '');
    const existing = await mediaFolderRepository.findByPath(cleaned);
    if (existing) return toDto(existing);

    let parentId: string | null = null;
    let parentPath: string | null = null;
    let current = null as Awaited<ReturnType<typeof mediaFolderRepository.findByPath>>;

    for (const segment of cleaned.split('/').filter(Boolean)) {
      const segmentPath = buildPath(parentPath, segment);
      current = await mediaFolderRepository.findByPath(segmentPath);

      if (!current) {
        const depth = depthFor(parentPath === null ? null : segmentPath.split('/').length - 2);
        assertDepthWithinCap(depth, segment, OPTIONS);

        current = await mediaFolderRepository.create({
          name: segment,
          slug: await ensureUniqueSlug(mediaFolderRepository, segment),
          parentId,
          path: segmentPath,
          depth,
        });
      }

      parentId = current.id;
      parentPath = segmentPath;
    }

    if (!current) throw AppError.validation('A folder path is required', { path });
    return toDto(current);
  },

  async create(input: MediaFolderCreateInput): Promise<MediaFolderDto> {
    const parent = input.parentId ? await mediaFolderRepository.findById(input.parentId) : null;
    if (input.parentId && !parent) {
      throw AppError.notFound('Parent folder not found', { parentId: input.parentId });
    }

    const slug = await ensureUniqueSlug(mediaFolderRepository, input.slug ?? slugify(input.name));
    const path = buildPath(parent?.path ?? null, slug);
    const depth = depthFor(parent?.depth ?? null);
    assertDepthWithinCap(depth, slug, OPTIONS);

    const row = await mediaFolderRepository.create({
      name: input.name,
      slug,
      parentId: parent?.id ?? null,
      path,
      depth,
      position: input.position ?? 100,
    });

    return toDto(row, 0);
  },

  async update(id: string, input: MediaFolderUpdateInput): Promise<MediaFolderDto> {
    const row = await mediaFolderRepository.findById(id);
    if (!row) throw AppError.notFound('Media folder not found', { id });

    if (row.isSystem && (input.name !== undefined || input.parentId !== undefined)) {
      throw AppError.forbidden('A system folder cannot be renamed or moved', { slug: row.slug });
    }

    if (input.parentId !== undefined) {
      await assertNoCycle(id, input.parentId ?? null, loadNode, OPTIONS);
    }

    await mediaFolderRepository.update(id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.parentId === undefined ? {} : { parentId: input.parentId ?? null }),
      ...(input.position === undefined ? {} : { position: input.position }),
    });

    if (input.parentId !== undefined) await this.recomputeSubtree(id);

    return this.get(id);
  },

  async remove(id: string): Promise<void> {
    const row = await mediaFolderRepository.findById(id);
    if (!row) throw AppError.notFound('Media folder not found', { id });
    if (row.isSystem)
      throw AppError.forbidden('A system folder cannot be deleted', { slug: row.slug });

    const children = await mediaFolderRepository.findChildren(id);
    if (children.length > 0) {
      throw AppError.conflict('Empty the folder before deleting it', { children: children.length });
    }

    const mediaCount = await mediaFolderRepository.countMedia(id);
    if (mediaCount > 0) {
      throw AppError.conflict('Move the assets out of this folder before deleting it', {
        mediaCount,
      });
    }

    await mediaFolderRepository.softDelete(id);
  },

  recomputeSubtree(id: string): Promise<number> {
    return recomputeSubtree(
      id,
      {
        load: loadNode,
        async children(parentId) {
          const rows = await mediaFolderRepository.findChildren(parentId);
          return rows.map((child) => ({
            id: child.id,
            slug: child.slug,
            parentId: child.parentId,
            path: child.path,
            depth: child.depth,
          }));
        },
        save: (nodeId, path, depth) =>
          mediaFolderRepository.updatePathAndDepth(nodeId, path, depth),
      },
      OPTIONS,
    );
  },
};
