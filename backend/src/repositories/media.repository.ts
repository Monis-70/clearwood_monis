import type { Media, MediaVariant, Prisma } from '@prisma/client';

import type { MediaListQuery } from '@shared/schemas/media';

import { prisma } from '../config/prisma';

import { notDeleted, orderBy, pageResult, skipTake, type PageResult } from './helpers';

const SORTABLE = ['originalName', 'sizeBytes', 'usageCount', 'createdAt', 'updatedAt'] as const;

const withVariants = {
  variants: { orderBy: [{ width: 'asc' as const }] },
} satisfies Prisma.MediaInclude;

const withDetail = {
  variants: { orderBy: [{ width: 'asc' as const }] },
  usages: { orderBy: [{ createdAt: 'asc' as const }] },
  folderRef: { select: { id: true, path: true } },
} satisfies Prisma.MediaInclude;

export type MediaWithVariants = Prisma.MediaGetPayload<{ include: typeof withVariants }>;
export type MediaWithDetail = Prisma.MediaGetPayload<{ include: typeof withDetail }>;

export interface MediaFilter {
  kind?: string;
  folder?: string;
  ids?: string[];
}

function where(query: Partial<MediaListQuery> = {}): Prisma.MediaWhereInput {
  return {
    ...(query.includeDeleted ? {} : notDeleted),
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.folderId ? { folderId: query.folderId } : {}),
    ...(query.folderPath ? { folderRef: { path: { startsWith: query.folderPath } } } : {}),
    ...(query.tag ? { tagsJson: { contains: `"${query.tag}"` } } : {}),
    ...(query.unusedOnly ? { usageCount: 0 } : {}),
    ...(query.search
      ? {
          OR: [
            { originalName: { contains: query.search } },
            { altText: { contains: query.search } },
            { title: { contains: query.search } },
          ],
        }
      : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: query.from } : {}),
            ...(query.to ? { lte: query.to } : {}),
          },
        }
      : {}),
  };
}

export const mediaRepository = {
  findById(id: string, includeDeleted = false): Promise<MediaWithVariants | null> {
    return prisma.media.findFirst({
      where: { id, ...(includeDeleted ? {} : notDeleted) },
      include: withVariants,
    });
  },

  findDetail(id: string, includeDeleted = false): Promise<MediaWithDetail | null> {
    return prisma.media.findFirst({
      where: { id, ...(includeDeleted ? {} : notDeleted) },
      include: withDetail,
    });
  },

  findManyByIds(ids: string[]): Promise<MediaWithVariants[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return prisma.media.findMany({
      where: { id: { in: ids }, ...notDeleted },
      include: withVariants,
    });
  },

  findByPath(disk: string, path: string): Promise<Media | null> {
    return prisma.media.findFirst({ where: { disk, path } });
  },

  /** De-duplication: the same bytes are only ever stored once. */
  findByChecksum(checksum: string): Promise<MediaWithVariants | null> {
    return prisma.media.findFirst({
      where: { checksumSha256: checksum, ...notDeleted },
      include: withVariants,
    });
  },

  async list(query: MediaListQuery): Promise<PageResult<MediaWithVariants>> {
    const args = { where: where(query) };
    const [items, total] = await Promise.all([
      prisma.media.findMany({
        ...args,
        ...skipTake(query),
        include: withVariants,
        orderBy: orderBy(query.sort, query.order, SORTABLE, [{ createdAt: 'desc' }]),
      }),
      prisma.media.count(args),
    ]);
    return pageResult(items, total, query);
  },

  create(data: Prisma.MediaUncheckedCreateInput): Promise<MediaWithVariants> {
    return prisma.media.create({ data, include: withVariants });
  },

  update(id: string, data: Prisma.MediaUncheckedUpdateInput): Promise<MediaWithVariants> {
    return prisma.media.update({ where: { id }, data, include: withVariants });
  },

  softDelete(id: string): Promise<Media> {
    return prisma.media.update({ where: { id }, data: { deletedAt: new Date() } });
  },

  restore(id: string): Promise<Media> {
    return prisma.media.update({ where: { id }, data: { deletedAt: null } });
  },

  hardDelete(id: string): Promise<Media> {
    return prisma.media.delete({ where: { id } });
  },

  setUsageCount(id: string, usageCount: number): Promise<Media> {
    return prisma.media.update({ where: { id }, data: { usageCount } });
  },

  /* ------------------------------------------------------------ variants */

  async replaceVariants(
    mediaId: string,
    variants: Omit<Prisma.MediaVariantUncheckedCreateInput, 'mediaId'>[],
  ): Promise<void> {
    await prisma.mediaVariant.deleteMany({ where: { mediaId } });
    if (variants.length > 0) {
      await prisma.mediaVariant.createMany({
        data: variants.map((variant) => ({ ...variant, mediaId })),
      });
    }
  },

  findVariants(mediaId: string): Promise<MediaVariant[]> {
    return prisma.mediaVariant.findMany({ where: { mediaId }, orderBy: [{ width: 'asc' }] });
  },

  countVariants(): Promise<number> {
    return prisma.mediaVariant.count();
  },

  /* -------------------------------------------------------- housekeeping */

  allPaths(): Promise<{ id: string; path: string }[]> {
    return prisma.media.findMany({ select: { id: true, path: true } });
  },

  allVariantPaths(): Promise<{ id: string; path: string }[]> {
    return prisma.mediaVariant.findMany({ select: { id: true, path: true } });
  },

  count(filter: MediaFilter = {}): Promise<number> {
    return prisma.media.count({
      where: {
        ...notDeleted,
        ...(filter.kind ? { kind: filter.kind } : {}),
        ...(filter.folder ? { folder: filter.folder } : {}),
        ...(filter.ids ? { id: { in: filter.ids } } : {}),
      },
    });
  },
};
