import type { Prisma, SearchIndexJob, SearchQueryLog } from '@prisma/client';

import { prisma } from '../config/prisma';

import { liveCollectionWhere } from './storefront.repository';

/** R1 — Prisma access for the Prompt 7 analytics, popularity and reindex jobs. */

export const searchAnalyticsRepository = {
  logQuery(data: {
    rawQuery: string;
    normalizedQuery: string;
    resultCount: number;
    hasResults: boolean;
    filtersJson: string | null;
    customerId: string | null;
    sessionId: string | null;
    ip: string | null;
  }): Promise<SearchQueryLog> {
    return prisma.searchQueryLog.create({ data });
  },

  async recordClick(
    id: string,
    click: { entityType: string; entityId: string; position: number },
  ): Promise<number> {
    const result = await prisma.searchQueryLog.updateMany({
      where: { id },
      data: {
        clickedEntityType: click.entityType,
        clickedEntityId: click.entityId,
        clickPosition: click.position,
      },
    });
    return result.count;
  },

  /** Falls back to the most recent log for the same normalised query when no id was supplied. */
  findLatestForQuery(normalizedQuery: string): Promise<SearchQueryLog | null> {
    return prisma.searchQueryLog.findFirst({
      where: { normalizedQuery },
      orderBy: { createdAt: 'desc' },
    });
  },

  topQueries(since: Date, limit: number) {
    return prisma.searchQueryLog.groupBy({
      by: ['normalizedQuery'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _avg: { resultCount: true },
      orderBy: { _count: { normalizedQuery: 'desc' } },
      take: limit,
    });
  },

  zeroResultQueries(since: Date, limit: number) {
    return prisma.searchQueryLog.groupBy({
      by: ['normalizedQuery'],
      where: { createdAt: { gte: since }, hasResults: false },
      _count: { _all: true },
      _max: { createdAt: true },
      orderBy: { _count: { normalizedQuery: 'desc' } },
      take: limit,
    });
  },

  async clickCountsFor(queries: string[], since: Date): Promise<Map<string, number>> {
    if (queries.length === 0) return new Map();

    const rows = await prisma.searchQueryLog.groupBy({
      by: ['normalizedQuery'],
      where: {
        createdAt: { gte: since },
        normalizedQuery: { in: queries },
        clickedEntityId: { not: null },
      },
      _count: { _all: true },
    });

    return new Map(rows.map((row) => [row.normalizedQuery, row._count._all]));
  },

  async totals(since: Date): Promise<{ searches: number; clicks: number; zeroResults: number }> {
    const [searches, clicks, zeroResults] = await Promise.all([
      prisma.searchQueryLog.count({ where: { createdAt: { gte: since } } }),
      prisma.searchQueryLog.count({
        where: { createdAt: { gte: since }, clickedEntityId: { not: null } },
      }),
      prisma.searchQueryLog.count({ where: { createdAt: { gte: since }, hasResults: false } }),
    ]);
    return { searches, clicks, zeroResults };
  },

  findForTrend(since: Date) {
    return prisma.searchQueryLog.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true, hasResults: true },
      orderBy: { createdAt: 'asc' },
    });
  },

  /** Popular past queries that are safe to suggest. */
  async popularQueries(since: Date, prefix: string, minCount: number, limit: number) {
    const rows = await prisma.searchQueryLog.groupBy({
      by: ['normalizedQuery'],
      where: {
        createdAt: { gte: since },
        hasResults: true,
        normalizedQuery: { startsWith: prefix },
      },
      _count: { _all: true },
      orderBy: { _count: { normalizedQuery: 'desc' } },
      take: limit * 2,
    });

    return rows
      .filter((row) => row._count._all >= minCount)
      .slice(0, limit)
      .map((row) => ({ query: row.normalizedQuery, count: row._count._all }));
  },
};

export const productStatRepository = {
  findByProductId(productId: string) {
    return prisma.productStat.findUnique({ where: { productId } });
  },

  async recordView(productId: string, at: Date): Promise<void> {
    await prisma.productStat.upsert({
      where: { productId },
      create: { productId, viewCount: 1, viewCount7d: 1, lastViewedAt: at },
      update: {
        viewCount: { increment: 1 },
        viewCount7d: { increment: 1 },
        lastViewedAt: at,
      },
    });
  },

  findAll() {
    return prisma.productStat.findMany();
  },

  async setScore(productId: string, popularityScore: number, recomputedAt: Date): Promise<void> {
    await prisma.productStat.upsert({
      where: { productId },
      create: { productId, popularityScore, recomputedAt },
      update: { popularityScore, recomputedAt },
    });
  },

  /** Prompt 8 feeds these; Prompt 7 created the columns and left them at zero. */
  async incrementCartAdd(productId: string): Promise<void> {
    await prisma.productStat.upsert({
      where: { productId },
      create: { productId, cartAddCount: 1 },
      update: { cartAddCount: { increment: 1 } },
    });
  },

  async incrementWishlist(productId: string, delta: number): Promise<void> {
    await prisma.productStat.upsert({
      where: { productId },
      create: { productId, wishlistCount: Math.max(delta, 0) },
      update: { wishlistCount: { increment: delta } },
    });
  },

  /** Prompt 9A — bumped once per confirmed order line, alongside Product.soldCount. */
  async incrementPurchase(productId: string, qty: number): Promise<void> {
    await prisma.productStat.upsert({
      where: { productId },
      create: { productId, purchaseCount: qty },
      update: { purchaseCount: { increment: qty } },
    });

    await prisma.product.updateMany({
      where: { id: productId },
      data: { soldCount: { increment: qty } },
    });
  },

  async resetWindow(cutoff: Date): Promise<number> {
    const result = await prisma.productStat.updateMany({
      where: { OR: [{ lastViewedAt: null }, { lastViewedAt: { lt: cutoff } }] },
      data: { viewCount7d: 0 },
    });
    return result.count;
  },
};

export const searchIndexJobRepository = {
  create(data: Prisma.SearchIndexJobCreateInput): Promise<SearchIndexJob> {
    return prisma.searchIndexJob.create({ data });
  },

  findById(id: string): Promise<SearchIndexJob | null> {
    return prisma.searchIndexJob.findUnique({ where: { id } });
  },

  update(id: string, data: Prisma.SearchIndexJobUpdateInput): Promise<SearchIndexJob> {
    return prisma.searchIndexJob.update({ where: { id }, data });
  },

  listRecent(take: number): Promise<SearchIndexJob[]> {
    return prisma.searchIndexJob.findMany({ orderBy: { createdAt: 'desc' }, take });
  },
};

export const slugRedirectRepository = {
  find(entityType: string, fromSlug: string) {
    return prisma.slugRedirect.findUnique({
      where: { entityType_fromSlug: { entityType, fromSlug } },
    });
  },

  findAnyBySlug(fromSlug: string) {
    return prisma.slugRedirect.findFirst({ where: { fromSlug } });
  },

  /** Fire-and-forget: a redirect must answer even if the counter write loses a race. */
  async touch(id: string): Promise<void> {
    await prisma.slugRedirect.update({
      where: { id },
      data: { hitCount: { increment: 1 }, lastHitAt: new Date() },
    });
  },
};

export const resolveRepository = {
  findProductBySlug(slug: string) {
    return prisma.product.findFirst({
      where: { slug, deletedAt: null },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        visibility: true,
        deletedAt: true,
        publishedAt: true,
      },
    });
  },

  findCategoryBySlug(slug: string) {
    return prisma.category.findFirst({
      where: { slug, deletedAt: null, isActive: true },
      select: { id: true, slug: true, name: true },
    });
  },

  findCollectionBySlug(slug: string) {
    return prisma.collection.findFirst({
      where: { slug, ...liveCollectionWhere() },
      select: { id: true, slug: true, name: true },
    });
  },
};

export const searchEntityRepository = {
  /** The index may lag a deactivation by one event; the result never does. */
  findCategoriesByIds(ids: string[]) {
    return prisma.category.findMany({
      where: { id: { in: ids }, deletedAt: null, isActive: true },
      select: { id: true, slug: true, name: true, path: true },
    });
  },

  findCollectionsByIds(ids: string[]) {
    return prisma.collection.findMany({
      where: { id: { in: ids }, ...liveCollectionWhere() },
      select: { id: true, slug: true, name: true },
    });
  },

  findBrandsByIds(ids: string[]) {
    return prisma.brand.findMany({
      where: { id: { in: ids }, deletedAt: null, isActive: true },
      select: { id: true, slug: true, name: true },
    });
  },
};
