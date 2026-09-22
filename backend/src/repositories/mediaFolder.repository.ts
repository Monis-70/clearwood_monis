import type { MediaFolder, Prisma } from '@prisma/client';

import { prisma } from '../config/prisma';

import { notDeleted } from './helpers';

export const mediaFolderRepository = {
  findById(id: string): Promise<MediaFolder | null> {
    return prisma.mediaFolder.findFirst({ where: { id, ...notDeleted } });
  },

  findBySlug(slug: string): Promise<MediaFolder | null> {
    return prisma.mediaFolder.findFirst({ where: { slug, ...notDeleted } });
  },

  findByPath(path: string): Promise<MediaFolder | null> {
    return prisma.mediaFolder.findFirst({ where: { path, ...notDeleted } });
  },

  findAll(): Promise<MediaFolder[]> {
    return prisma.mediaFolder.findMany({
      where: notDeleted,
      orderBy: [{ depth: 'asc' }, { position: 'asc' }, { name: 'asc' }],
    });
  },

  findChildren(parentId: string): Promise<MediaFolder[]> {
    return prisma.mediaFolder.findMany({
      where: { parentId, ...notDeleted },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
  },

  create(data: Prisma.MediaFolderUncheckedCreateInput): Promise<MediaFolder> {
    return prisma.mediaFolder.create({ data });
  },

  update(id: string, data: Prisma.MediaFolderUncheckedUpdateInput): Promise<MediaFolder> {
    return prisma.mediaFolder.update({ where: { id }, data });
  },

  updatePathAndDepth(id: string, path: string, depth: number): Promise<MediaFolder> {
    return prisma.mediaFolder.update({ where: { id }, data: { path, depth } });
  },

  softDelete(id: string): Promise<MediaFolder> {
    return prisma.mediaFolder.update({ where: { id }, data: { deletedAt: new Date() } });
  },

  async slugExists(slug: string, excludeId?: string): Promise<boolean> {
    const found = await prisma.mediaFolder.findFirst({
      where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    return found !== null;
  },

  countMedia(folderId: string): Promise<number> {
    return prisma.media.count({ where: { folderId, ...notDeleted } });
  },

  /** One grouped query rather than a count per folder. */
  async mediaCounts(): Promise<Map<string, number>> {
    const rows = await prisma.media.groupBy({
      by: ['folderId'],
      _count: { _all: true },
      where: { ...notDeleted, folderId: { not: null } },
    });
    return new Map(rows.map((row) => [row.folderId!, row._count._all]));
  },

  count(): Promise<number> {
    return prisma.mediaFolder.count({ where: notDeleted });
  },
};
