import type { Prisma } from '@prisma/client';

import { prisma } from '../config/prisma';

import { pageResult, skipTake, type PageResult } from './helpers';

/** R1 — pages, blocks and revisions reach Prisma only through this file. */

const withBlocks = {
  blocks: { orderBy: { position: 'asc' as const } },
} satisfies Prisma.PageInclude;

export type PageWithBlocks = Prisma.PageGetPayload<{ include: typeof withBlocks }>;

export interface PageListQuery {
  page: number;
  limit: number;
  order: 'asc' | 'desc';
  sort?: string;
  status?: string;
  type?: string;
  q?: string;
}

export const pageRepository = {
  findById(id: string): Promise<PageWithBlocks | null> {
    return prisma.page.findFirst({ where: { id, deletedAt: null }, include: withBlocks });
  },

  findBySlug(slug: string): Promise<PageWithBlocks | null> {
    return prisma.page.findFirst({ where: { slug, deletedAt: null }, include: withBlocks });
  },

  findHome(): Promise<PageWithBlocks | null> {
    return prisma.page.findFirst({
      where: { type: 'HOME', status: 'PUBLISHED', deletedAt: null },
      include: withBlocks,
      orderBy: { publishedAt: 'desc' },
    });
  },

  async list(query: PageListQuery): Promise<PageResult<PageWithBlocks>> {
    const where: Prisma.PageWhereInput = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.q
        ? { OR: [{ title: { contains: query.q } }, { slug: { contains: query.q } }] }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.page.findMany({
        where,
        include: withBlocks,
        orderBy: { updatedAt: 'desc' },
        ...skipTake(query),
      }),
      prisma.page.count({ where }),
    ]);

    return pageResult(items, total, query);
  },

  create(data: Prisma.PageUncheckedCreateInput): Promise<PageWithBlocks> {
    return prisma.page.create({ data, include: withBlocks });
  },

  update(id: string, data: Prisma.PageUncheckedUpdateInput): Promise<PageWithBlocks> {
    return prisma.page.update({ where: { id }, data, include: withBlocks });
  },

  softDelete(id: string): Promise<unknown> {
    return prisma.page.update({ where: { id }, data: { deletedAt: new Date() } });
  },

  slugExists(slug: string, exceptId: string | null): Promise<{ id: string } | null> {
    return prisma.page.findFirst({
      where: { slug, deletedAt: null, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { id: true },
    });
  },

  /** Published, in-window pages only — the set the sitemap and the public reader may see. */
  listPublished(now: Date, skip: number, take: number) {
    return prisma.page.findMany({
      where: {
        status: 'PUBLISHED',
        deletedAt: null,
        publishedAt: { lte: now },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { slug: true, updatedAt: true, noIndex: true, type: true },
      orderBy: { slug: 'asc' },
      skip,
      take,
    });
  },

  countPublished(now: Date): Promise<number> {
    return prisma.page.count({
      where: {
        status: 'PUBLISHED',
        deletedAt: null,
        noIndex: false,
        publishedAt: { lte: now },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
  },

  incrementView(id: string): Promise<unknown> {
    return prisma.page.update({ where: { id }, data: { viewCount: { increment: 1 } } });
  },
};

export const pageBlockRepository = {
  findById(id: string) {
    return prisma.pageBlock.findUnique({ where: { id } });
  },

  create(data: Prisma.PageBlockUncheckedCreateInput) {
    return prisma.pageBlock.create({ data });
  },

  update(id: string, data: Prisma.PageBlockUncheckedUpdateInput) {
    return prisma.pageBlock.update({ where: { id }, data });
  },

  remove(id: string) {
    return prisma.pageBlock.delete({ where: { id } });
  },

  listForPage(pageId: string) {
    return prisma.pageBlock.findMany({ where: { pageId }, orderBy: { position: 'asc' } });
  },

  nextPosition(pageId: string): Promise<number> {
    return prisma.pageBlock
      .aggregate({ where: { pageId }, _max: { position: true } })
      .then((result) => (result._max.position ?? -1) + 1);
  },

  countForPage(pageId: string): Promise<number> {
    return prisma.pageBlock.count({ where: { pageId } });
  },

  /** Reorder is one transaction: a half-applied order is a visibly broken page. */
  reorder(pageId: string, order: { id: string; position: number }[]) {
    return prisma.$transaction(
      order.map((entry) =>
        prisma.pageBlock.updateMany({
          where: { id: entry.id, pageId },
          data: { position: entry.position },
        }),
      ),
    );
  },

  replaceAll(pageId: string, blocks: Prisma.PageBlockUncheckedCreateInput[]) {
    return prisma.$transaction([
      prisma.pageBlock.deleteMany({ where: { pageId } }),
      prisma.pageBlock.createMany({ data: blocks }),
    ]);
  },
};

export const pageRevisionRepository = {
  listForPage(pageId: string) {
    return prisma.pageRevision.findMany({
      where: { pageId },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        editedById: true,
        editedByName: true,
        note: true,
        createdAt: true,
      },
    });
  },

  find(pageId: string, version: number) {
    return prisma.pageRevision.findUnique({ where: { pageId_version: { pageId, version } } });
  },

  create(data: Prisma.PageRevisionUncheckedCreateInput) {
    return prisma.pageRevision.create({ data });
  },

  nextVersion(pageId: string): Promise<number> {
    return prisma.pageRevision
      .aggregate({ where: { pageId }, _max: { version: true } })
      .then((result) => (result._max.version ?? 0) + 1);
  },

  /** Keeps the newest `keep` revisions; history is capped, not unbounded. */
  async prune(pageId: string, keep: number): Promise<number> {
    const survivors = await prisma.pageRevision.findMany({
      where: { pageId },
      orderBy: { version: 'desc' },
      take: keep,
      select: { id: true },
    });

    const { count } = await prisma.pageRevision.deleteMany({
      where: { pageId, id: { notIn: survivors.map((row) => row.id) } },
    });

    return count;
  },
};
