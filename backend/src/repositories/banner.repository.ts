import type { Prisma } from '@prisma/client';

import { prisma } from '../config/prisma';

import { pageResult, skipTake, type PageResult } from './helpers';

/** R1 — banners, the announcement bar and the view rollup reach Prisma only through this file. */

export interface BannerListQueryish {
  page: number;
  limit: number;
  order: 'asc' | 'desc';
  sort?: string;
  placement?: string;
  isActive?: boolean;
}

export const bannerRepository = {
  findById(id: string) {
    return prisma.banner.findFirst({ where: { id, deletedAt: null } });
  },

  async list(query: BannerListQueryish): Promise<PageResult<Prisma.BannerGetPayload<object>>> {
    const where: Prisma.BannerWhereInput = {
      deletedAt: null,
      ...(query.placement ? { placement: query.placement } : {}),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
    };

    const [items, total] = await Promise.all([
      prisma.banner.findMany({
        where,
        orderBy: [{ placement: 'asc' }, { position: 'asc' }],
        ...skipTake(query),
      }),
      prisma.banner.count({ where }),
    ]);

    return pageResult(items, total, query);
  },

  /** Active, in-window banners for several placements in ONE query. */
  liveForPlacements(placements: string[], now: Date) {
    return prisma.banner.findMany({
      where: {
        placement: { in: placements },
        isActive: true,
        deletedAt: null,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        ],
      },
      orderBy: [{ placement: 'asc' }, { position: 'asc' }],
    });
  },

  create(data: Prisma.BannerUncheckedCreateInput) {
    return prisma.banner.create({ data });
  },

  softDelete(id: string) {
    return prisma.banner.update({ where: { id }, data: { deletedAt: new Date() } });
  },

  reorder(order: { id: string; position: number }[]) {
    return prisma.$transaction(
      order.map((entry) =>
        prisma.banner.updateMany({ where: { id: entry.id }, data: { position: entry.position } }),
      ),
    );
  },

  bumpImpression(id: string) {
    return prisma.banner.updateMany({
      where: { id, deletedAt: null },
      data: { impressionCount: { increment: 1 } },
    });
  },

  bumpClick(id: string) {
    return prisma.banner.updateMany({
      where: { id, deletedAt: null },
      data: { clickCount: { increment: 1 } },
    });
  },
};

export const announcementRepository = {
  findById(id: string) {
    return prisma.announcementBar.findFirst({ where: { id, deletedAt: null } });
  },

  list() {
    return prisma.announcementBar.findMany({
      where: { deletedAt: null },
      orderBy: { position: 'asc' },
    });
  },

  live(now: Date) {
    return prisma.announcementBar.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        ],
      },
      orderBy: { position: 'asc' },
    });
  },

  create(data: Prisma.AnnouncementBarUncheckedCreateInput) {
    return prisma.announcementBar.create({ data });
  },

  softDelete(id: string) {
    return prisma.announcementBar.update({ where: { id }, data: { deletedAt: new Date() } });
  },
};

function dayKey(at = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export const contentViewRepository = {
  /** Upsert on (entityType, entityId, dayKey) — a day's counter is one row, not one per hit. */
  bump(entityType: string, entityId: string, at = new Date()) {
    const key = dayKey(at);

    return prisma.contentView.upsert({
      where: { entityType_entityId_dayKey: { entityType, entityId, dayKey: key } },
      create: { entityType, entityId, dayKey: key, viewCount: 1 },
      update: { viewCount: { increment: 1 } },
    });
  },

  listFor(entityTypes: string[], entityId: string) {
    return prisma.contentView.findMany({
      where: { entityType: { in: entityTypes }, entityId },
      orderBy: { dayKey: 'desc' },
      take: 60,
    });
  },
};
