import { Prisma } from '@prisma/client';

import { prisma } from '../config/prisma';

/** R1 - the catalog listing price index (`ProductListingIndex`) is read and written only here. */

export interface PriceRange {
  minPricePaise: number | null;
  maxPricePaise: number | null;
}

type Tx = Prisma.TransactionClient;

export interface PricingSubject {
  id: string;
  status: string;
  deletedAt: Date | null;
  variants: { id: string }[];
}

export const listingIndexRepository = {
  /** What pricing needs, read fresh (never from a transaction snapshot). */
  loadForPricing(productIds: string[]): Promise<PricingSubject[]> {
    if (productIds.length === 0) return Promise.resolve([]);
    return prisma.product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true,
        status: true,
        deletedAt: true,
        variants: {
          where: { deletedAt: null, isActive: true },
          select: { id: true },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
        },
      },
    });
  },

  /** Creates the lock rows that are missing; a concurrent creator makes each a no-op. */
  async ensureRows(productIds: string[]): Promise<void> {
    if (productIds.length === 0) return;
    const rows = productIds.map(
      (productId) =>
        Prisma.sql`(REPLACE(UUID(), '-', ''), ${productId}, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    );
    await prisma.$executeRaw`
      INSERT INTO ProductListingIndex (id, productId, computedAt, updatedAt)
      VALUES ${Prisma.join(rows)}
      ON DUPLICATE KEY UPDATE productId = productId`;
  },

  /**
   * Serialises refreshes of the same products. Prices are computed while the rows are held, so the
   * refresh that reads the newest data is always the last to write. Rows are taken in productId
   * order, so two overlapping batches queue behind each other instead of deadlocking.
   */
  withRowLocks<T>(productIds: string[], work: (tx: Tx) => Promise<T>): Promise<T> {
    const sorted = [...productIds].sort();
    return prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM ProductListingIndex
          WHERE productId IN (${Prisma.join(sorted)}) ORDER BY productId FOR UPDATE`;
        return work(tx);
      },
      { timeout: 60_000, maxWait: 20_000 },
    );
  },

  async writeMany(tx: Tx, ranges: Map<string, PriceRange>, computedAt: Date): Promise<void> {
    if (ranges.size === 0) return;
    const rows = [...ranges].map(
      ([productId, range]) =>
        Prisma.sql`(REPLACE(UUID(), '-', ''), ${productId}, ${range.minPricePaise}, ${range.maxPricePaise}, ${computedAt}, ${computedAt})`,
    );
    // Every row exists (ensureRows ran and the rows are locked), so this only ever updates.
    await tx.$executeRaw`
      INSERT INTO ProductListingIndex (id, productId, minPricePaise, maxPricePaise, computedAt, updatedAt)
      VALUES ${Prisma.join(rows)} AS fresh
      ON DUPLICATE KEY UPDATE minPricePaise = fresh.minPricePaise,
        maxPricePaise = fresh.maxPricePaise, computedAt = fresh.computedAt,
        updatedAt = fresh.updatedAt`;
  },

  /**
   * Rewrites the products' ProductListingAttribute rows from their specs and active variants.
   * A plain read then an insert, inside the caller's locked transaction: the read sees everything
   * committed before the locks were taken, and takes no locks on the catalog rows it reads.
   */
  async writeAttributes(tx: Tx, productIds: string[]): Promise<void> {
    if (productIds.length === 0) return;
    const ids = Prisma.join(productIds);
    const pairs = await tx.$queryRaw<
      { productId: string; attributeId: string; attributeValueId: string }[]
    >`
      SELECT pav.productId AS productId, pav.attributeId AS attributeId,
        pav.attributeValueId AS attributeValueId
      FROM ProductAttributeValue pav
      WHERE pav.productId IN (${ids}) AND pav.attributeValueId IS NOT NULL
      UNION
      SELECT v.productId, vav.attributeId, vav.attributeValueId
      FROM ProductVariant v JOIN VariantAttributeValue vav ON vav.variantId = v.id
      WHERE v.productId IN (${ids}) AND v.deletedAt IS NULL AND v.isActive = TRUE`;

    await tx.$executeRaw`DELETE FROM ProductListingAttribute WHERE productId IN (${ids})`;
    if (pairs.length === 0) return;

    const rows = pairs.map(
      (pair) =>
        Prisma.sql`(REPLACE(UUID(), '-', ''), ${pair.productId}, ${pair.attributeId}, ${pair.attributeValueId}, CURRENT_TIMESTAMP(3))`,
    );
    await tx.$executeRaw`
      INSERT INTO ProductListingAttribute (id, productId, attributeId, attributeValueId, updatedAt)
      VALUES ${Prisma.join(rows)}`;
  },

  async remove(productIds: string[], tx: Tx | typeof prisma = prisma): Promise<void> {
    if (productIds.length === 0) return;
    await tx.productListingAttribute.deleteMany({ where: { productId: { in: productIds } } });
    await tx.productListingIndex.deleteMany({ where: { productId: { in: productIds } } });
  },

  async findByProductIds(productIds: string[]): Promise<Map<string, PriceRange>> {
    if (productIds.length === 0) return new Map();

    const rows = await prisma.productListingIndex.findMany({
      where: { productId: { in: productIds } },
      select: { productId: true, minPricePaise: true, maxPricePaise: true },
    });
    return new Map(
      rows.map((row) => [
        row.productId,
        { minPricePaise: row.minPricePaise, maxPricePaise: row.maxPricePaise },
      ]),
    );
  },

  async listPriceableIds(afterId: string | null, take: number): Promise<string[]> {
    const rows = await prisma.product.findMany({
      where: { deletedAt: null, status: 'ACTIVE', ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: 'asc' },
      take,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  /**
   * Products whose row cannot be trusted, judged from MySQL alone: no row yet, or the product or
   * one of its variants was written after the row was computed. This is what repairs a write whose
   * event never arrived (a worker that died mid-listener, a write path that forgot to emit).
   */
  async findStale(take: number): Promise<string[]> {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT p.id AS id FROM Product p
      LEFT JOIN ProductListingIndex li ON li.productId = p.id
      WHERE p.deletedAt IS NULL AND p.status = 'ACTIVE'
        AND (li.id IS NULL OR p.updatedAt > li.computedAt
          OR EXISTS (SELECT 1 FROM ProductVariant v
            WHERE v.productId = p.id AND v.updatedAt > li.computedAt))
      ORDER BY p.id LIMIT ${take}`;
    return rows.map((row) => row.id);
  },

  async oldestComputedAt(): Promise<Date | null> {
    const row = await prisma.productListingIndex.aggregate({ _min: { computedAt: true } });
    return row._min.computedAt;
  },

  /** Rows whose product was deleted or left ACTIVE without an event reaching the index. */
  async pruneUnpriceable(): Promise<number> {
    await prisma.$executeRaw`
      DELETE la FROM ProductListingAttribute la JOIN Product p ON p.id = la.productId
      WHERE p.deletedAt IS NOT NULL OR p.status <> 'ACTIVE'`;
    return prisma.$executeRaw`
      DELETE li FROM ProductListingIndex li JOIN Product p ON p.id = li.productId
      WHERE p.deletedAt IS NOT NULL OR p.status <> 'ACTIVE'`;
  },
};
