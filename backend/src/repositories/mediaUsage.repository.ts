import type { MediaUsage } from '@prisma/client';

import type { MediaUsageType } from '@shared/enums';

import { prisma } from '../config/prisma';

export const mediaUsageRepository = {
  findForMedia(mediaId: string): Promise<MediaUsage[]> {
    return prisma.mediaUsage.findMany({ where: { mediaId }, orderBy: [{ createdAt: 'asc' }] });
  },

  findForEntity(usageType: MediaUsageType, entityId: string): Promise<MediaUsage[]> {
    return prisma.mediaUsage.findMany({ where: { usageType, entityId } });
  },

  /** `field` is nullable, and SQL treats NULLs in a unique index as distinct — hence find-then-create. */
  async attach(input: {
    mediaId: string;
    usageType: MediaUsageType;
    entityId: string;
    field?: string | null;
  }): Promise<MediaUsage> {
    const field = input.field ?? null;

    const existing = await prisma.mediaUsage.findFirst({
      where: {
        mediaId: input.mediaId,
        usageType: input.usageType,
        entityId: input.entityId,
        field,
      },
    });
    if (existing) return existing;

    return prisma.mediaUsage.create({
      data: {
        mediaId: input.mediaId,
        usageType: input.usageType,
        entityId: input.entityId,
        field,
      },
    });
  },

  async detach(input: {
    mediaId: string;
    usageType: MediaUsageType;
    entityId: string;
    field?: string | null;
  }): Promise<number> {
    const result = await prisma.mediaUsage.deleteMany({
      where: {
        mediaId: input.mediaId,
        usageType: input.usageType,
        entityId: input.entityId,
        ...(input.field === undefined ? {} : { field: input.field }),
      },
    });
    return result.count;
  },

  async detachAllForMedia(mediaId: string): Promise<number> {
    const result = await prisma.mediaUsage.deleteMany({ where: { mediaId } });
    return result.count;
  },

  async detachAllForEntity(usageType: MediaUsageType, entityId: string): Promise<number> {
    const result = await prisma.mediaUsage.deleteMany({ where: { usageType, entityId } });
    return result.count;
  },

  countForMedia(mediaId: string): Promise<number> {
    return prisma.mediaUsage.count({ where: { mediaId } });
  },

  /** Grouped recount used by MediaUsageService.recount(). */
  async countsByMedia(): Promise<Map<string, number>> {
    const rows = await prisma.mediaUsage.groupBy({ by: ['mediaId'], _count: { _all: true } });
    return new Map(rows.map((row) => [row.mediaId, row._count._all]));
  },

  count(): Promise<number> {
    return prisma.mediaUsage.count();
  },
};
