import { prisma } from '../config/prisma';

/**
 * R1 - catalog facts that change with the clock rather than with a write: scheduled publication,
 * featured windows, the new-arrival window and collection windows (listingReconciler). Every
 * span is half-open, (from, to], like the price windows in priceSchedule.repository, so a
 * boundary is seen by exactly one run.
 */
export const catalogScheduleRepository = {
  /** Scheduled products that went live during the span. */
  async productsPublishedBetween(from: Date, to: Date): Promise<string[]> {
    const rows = await prisma.product.findMany({
      where: { deletedAt: null, status: 'ACTIVE', publishedAt: { gt: from, lte: to } },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  /** Featured products whose `featuredUntil` passed during the span. */
  async productsFeatureEndedBetween(from: Date, to: Date): Promise<string[]> {
    const rows = await prisma.product.findMany({
      where: { deletedAt: null, isFeatured: true, featuredUntil: { gt: from, lte: to } },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  /** Products that aged out of the new-arrival window during the span (no flag holding them). */
  countArrivalsAgedOut(from: Date, to: Date, windowMs: number): Promise<number> {
    const since = new Date(from.getTime() - windowMs);
    const until = new Date(to.getTime() - windowMs);
    return prisma.product.count({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        isNewArrival: false,
        OR: [
          { publishedAt: { gt: since, lte: until } },
          { publishedAt: null, createdAt: { gt: since, lte: until } },
        ],
      },
    });
  },

  /** Collections whose startsAt or endsAt passed during the span. */
  countCollectionsCrossing(from: Date, to: Date): Promise<number> {
    return prisma.collection.count({
      where: {
        deletedAt: null,
        OR: [{ startsAt: { gt: from, lte: to } }, { endsAt: { gt: from, lte: to } }],
      },
    });
  },

  /**
   * Whether a row an automatic-collection rule or a category count reads was written since
   * `from`. Category links are rewritten as a whole (applyCategories), so a removed link still
   * leaves fresh rows behind.
   */
  async catalogWrittenSince(from: Date): Promise<boolean> {
    const [row] = await prisma.$queryRaw<{ written: bigint | number | boolean }[]>`
      SELECT (EXISTS (SELECT 1 FROM Product WHERE updatedAt > ${from})
        OR EXISTS (SELECT 1 FROM ProductVariant WHERE updatedAt > ${from})
        OR EXISTS (SELECT 1 FROM ProductCategory WHERE updatedAt > ${from})
        OR EXISTS (SELECT 1 FROM ProductAttributeValue WHERE updatedAt > ${from})
        OR EXISTS (SELECT 1 FROM Category WHERE updatedAt > ${from})) AS written`;
    return Number(row?.written ?? 0) > 0;
  },
};
