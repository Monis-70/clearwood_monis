import type { Prisma, ProductVariant } from '@prisma/client';

import type { InventoryReason, StockStatus } from '@shared/enums';
import type { InventoryHistoryQuery, LowStockQuery } from '@shared/schemas/catalogAdmin';
import type {
  InventoryLedgerEntryDto,
  InventorySnapshotDto,
  LowStockItemDto,
} from '@shared/types/catalogAdmin';

import { prisma } from '../../config/prisma';
import { catalogEvents } from '../../events/catalogEvents';
import { pageResult, skipTake, type PageResult } from '../../repositories/helpers';
import { AppError } from '../../utils/AppError';

import { isVariantAvailable } from './availability';

/**
 * Stock movement. `ProductVariant.stockQty` may ONLY change here.
 *
 * Concurrency: the write is a compare-and-set — the current balance is part of the WHERE clause,
 * so two simultaneous adjustments can never lose an update. A losing writer retries with the fresh
 * balance (bounded), and gives up with 409 INVENTORY_CONFLICT rather than guessing. Callers that
 * know the balance they are working from can pass `expectedBalance` to make the check explicit.
 *
 * Invariants (enforced here, not by convention):
 *  - stockQty >= 0 unless the variant allows backorders;
 *  - 0 <= reservedQty <= stockQty unless the variant allows backorders;
 *  - release() can never release more than the active reservation, and repeating it is a no-op;
 *  - every movement writes exactly one ledger row whose balanceAfter is the new stockQty.
 */


export interface AdjustInput {
  delta?: number;
  absolute?: number;
  reason?: InventoryReason;
  note?: string | null;
  refType?: string | null;
  refId?: string | null;
  expectedBalance?: number;
}

export interface Actor {
  actorType: string;
  actorId: string | null;
}

export function stockStatusFor(variant: {
  stockQty: number;
  lowStockThreshold: number;
  allowBackorder: boolean;
  isMadeToOrder?: boolean;
}): StockStatus {
  if (variant.isMadeToOrder) return 'MADE_TO_ORDER';
  if (variant.stockQty <= 0) return variant.allowBackorder ? 'PREORDER' : 'OUT_OF_STOCK';
  if (variant.stockQty <= variant.lowStockThreshold) return 'LOW_STOCK';
  return 'IN_STOCK';
}

export function toSnapshot(variant: ProductVariant): InventorySnapshotDto {
  return {
    variantId: variant.id,
    sku: variant.sku,
    stockQty: variant.stockQty,
    reservedQty: variant.reservedQty,
    availableQty: Math.max(0, variant.stockQty - variant.reservedQty),
    stockStatus: variant.stockStatus,
    lowStockThreshold: variant.lowStockThreshold,
    allowBackorder: variant.allowBackorder,
  };
}

function toLedgerDto(row: {
  id: string;
  variantId: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  refType: string | null;
  refId: string | null;
  note: string | null;
  actorType: string;
  actorId: string | null;
  createdAt: Date;
}): InventoryLedgerEntryDto {
  return {
    id: row.id,
    variantId: row.variantId,
    delta: row.delta,
    balanceAfter: row.balanceAfter,
    reason: row.reason as InventoryReason,
    refType: row.refType,
    refId: row.refId,
    note: row.note,
    actorType: row.actorType,
    actorId: row.actorId,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadVariant(id: string, client: Prisma.TransactionClient | typeof prisma = prisma) {
  const variant = await client.productVariant.findFirst({
    where: { id, deletedAt: null },
    include: { product: { select: { isMadeToOrder: true } } },
  });
  if (!variant) throw AppError.notFound('Variant not found', { variantId: id });
  return variant;
}

/** Did moving `reservedQty` make the variant orderable or unorderable? */
function flips(current: Awaited<ReturnType<typeof loadVariant>>, nextReservedQty: number): boolean {
  return (
    isVariantAvailable(current, current.product) !==
    isVariantAvailable({ ...current, reservedQty: nextReservedQty }, current.product)
  );
}

/*
 * A reservation changes nothing a shopper sees unless it takes the last unit or gives it back, so
 * only that flip is announced: announcing every hold would empty the storefront caches on every
 * checkout. After commit, as for adjust().
 */
function announceFlip(flipped: boolean, productId: string, variantId: string): void {
  if (flipped) catalogEvents.emit('inventory.changed', { productId, variantId });
}

export const inventoryService = {
  stockStatusFor,
  toSnapshot,

  async snapshot(variantId: string): Promise<InventorySnapshotDto> {
    return toSnapshot(await loadVariant(variantId));
  },

  /**
   * Applies a delta (or moves to an absolute figure) and records it. Returns the new snapshot
   * together with the ledger row that was written.
   */
  async adjust(
    variantId: string,
    input: AdjustInput,
    actor: Actor = { actorType: 'SYSTEM', actorId: null },
  ): Promise<{ snapshot: InventorySnapshotDto; entry: InventoryLedgerEntryDto }> {
    if (input.delta === undefined && input.absolute === undefined) {
      throw AppError.validation('Provide either delta or absolute', { field: 'delta' });
    }
    if (input.delta !== undefined && input.absolute !== undefined) {
      throw AppError.validation('Provide delta or absolute, not both', { field: 'delta' });
    }

    /*
     * One transaction, opened by an explicit row lock.
     *
     * Every check below reads a value it then writes, so the read and the write have to be inside
     * the same lock or two callers can both pass the floor check and both write. It used to read
     * outside a transaction and compare-and-set, retrying MAX_CAS_ATTEMPTS times; on MySQL ten
     * concurrent adjustments exhausted those five attempts and surfaced INVENTORY_CONFLICT to a
     * caller who had done nothing wrong. SELECT ... FOR UPDATE holds the row to commit, so callers
     * queue instead of racing and no retry is needed.
     *
     * The balance and its ledger row commit together, which is what makes `balanceAfter` a true
     * running total rather than a guess.
     */
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM ProductVariant WHERE id = ${variantId} FOR UPDATE`;

      const current = await loadVariant(variantId, tx);

      if (input.expectedBalance !== undefined && input.expectedBalance !== current.stockQty) {
        throw new AppError(
          409,
          'INVENTORY_CONFLICT',
          'Stock changed since you loaded it — reload and try again',
          {
            variantId,
            expectedBalance: input.expectedBalance,
            currentBalance: current.stockQty,
          },
        );
      }

      const delta =
        input.absolute === undefined ? (input.delta ?? 0) : input.absolute - current.stockQty;
      const nextBalance = current.stockQty + delta;

      // The floor. Inside the lock, so a passing check cannot be invalidated by a sibling.
      if (nextBalance < 0 && !current.allowBackorder) {
        throw new AppError(
          409,
          'INSUFFICIENT_STOCK',
          `Only ${current.stockQty} in stock; backorders are disabled for this variant`,
          { variantId, stockQty: current.stockQty, requested: delta },
        );
      }
      if (nextBalance < current.reservedQty && !current.allowBackorder) {
        throw new AppError(
          409,
          'STOCK_BELOW_RESERVED',
          `${current.reservedQty} units are reserved; stock cannot drop below that`,
          { variantId, reservedQty: current.reservedQty, attemptedBalance: nextBalance },
        );
      }

      const stockStatus = stockStatusFor({
        stockQty: nextBalance,
        lowStockThreshold: current.lowStockThreshold,
        allowBackorder: current.allowBackorder,
        isMadeToOrder: current.product.isMadeToOrder,
      });

      const variant = await tx.productVariant.update({
        where: { id: variantId },
        data: { stockQty: nextBalance, stockStatus },
      });

      const entry = await tx.inventoryLedger.create({
        data: {
          variantId,
          delta,
          balanceAfter: nextBalance,
          reason: input.reason ?? 'MANUAL_ADJUSTMENT',
          refType: input.refType ?? null,
          refId: input.refId ?? null,
          note: input.note ?? null,
          actorType: actor.actorType,
          actorId: actor.actorId,
        },
      });

      return { snapshot: toSnapshot(variant), entry: toLedgerDto(entry), productId: current.productId };
    });

    // Stock flips `inStock` in the search index, which the availability facet reads.
    catalogEvents.emit('inventory.changed', { productId: result.productId, variantId });

    return { snapshot: result.snapshot, entry: result.entry };
  },

  setAbsolute(
    variantId: string,
    absolute: number,
    input: Omit<AdjustInput, 'delta' | 'absolute'> = {},
    actor?: Actor,
  ): Promise<{ snapshot: InventorySnapshotDto; entry: InventoryLedgerEntryDto }> {
    return this.adjust(variantId, { ...input, absolute }, actor);
  },

  /**
   * Holds stock for an order (Prompt 9 calls this).
   *
   * Same shape as `adjust`: the availability test and the write happen under one row lock, so two
   * checkouts cannot both pass the check and both reserve the same unit. It used to read outside a
   * transaction and compare-and-set, which made a lost race look like INVENTORY_CONFLICT to a
   * caller who had stock available.
   */
  async reserve(
    variantId: string,
    qty: number,
    ref?: { type: string; id: string },
  ): Promise<number> {
    if (qty <= 0) throw AppError.validation('Reservation quantity must be positive', { qty });

    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM ProductVariant WHERE id = ${variantId} FOR UPDATE`;

      const current = await loadVariant(variantId, tx);
      const nextReserved = current.reservedQty + qty;

      if (nextReserved > current.stockQty && !current.allowBackorder) {
        throw new AppError(
          409,
          'INSUFFICIENT_STOCK',
          `Only ${Math.max(0, current.stockQty - current.reservedQty)} units are available`,
          {
            variantId,
            stockQty: current.stockQty,
            reservedQty: current.reservedQty,
            requested: qty,
          },
        );
      }

      await tx.productVariant.update({
        where: { id: variantId },
        data: { reservedQty: nextReserved },
      });

      void ref;
      return {
        nextReserved,
        productId: current.productId,
        flipped: flips(current, nextReserved),
      };
    });

    announceFlip(outcome.flipped, outcome.productId, variantId);
    return outcome.nextReserved;
  },

  /**
   * Gives stock back. Idempotent: it releases at most the active reservation, so a duplicate
   * release (a retried webhook, a double-cancelled order) is a harmless no-op returning 0.
   */
  async release(
    variantId: string,
    qty: number,
    ref?: { type: string; id: string },
  ): Promise<number> {
    if (qty <= 0) throw AppError.validation('Release quantity must be positive', { qty });

    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM ProductVariant WHERE id = ${variantId} FOR UPDATE`;

      const current = await loadVariant(variantId, tx);
      const releasable = Math.min(qty, current.reservedQty);
      if (releasable === 0) return { releasable, productId: current.productId, flipped: false };

      await tx.productVariant.update({
        where: { id: variantId },
        data: { reservedQty: current.reservedQty - releasable },
      });

      void ref;
      return {
        releasable,
        productId: current.productId,
        flipped: flips(current, current.reservedQty - releasable),
      };
    });

    announceFlip(outcome.flipped, outcome.productId, variantId);
    return outcome.releasable;
  },

  async bulkAdjust(
    items: { variantId: string; delta?: number; absolute?: number; note?: string | null }[],
    reason: InventoryReason,
    actor: Actor,
  ): Promise<
    { variantId: string; ok: boolean; code: string | null; balanceAfter: number | null }[]
  > {
    const results = [];

    for (const item of items) {
      try {
        const { snapshot } = await this.adjust(
          item.variantId,
          {
            ...(item.delta === undefined ? {} : { delta: item.delta }),
            ...(item.absolute === undefined ? {} : { absolute: item.absolute }),
            reason,
            note: item.note ?? null,
          },
          actor,
        );
        results.push({
          variantId: item.variantId,
          ok: true,
          code: null,
          balanceAfter: snapshot.stockQty,
        });
      } catch (error) {
        results.push({
          variantId: item.variantId,
          ok: false,
          code: error instanceof AppError ? error.code : 'UNEXPECTED_ERROR',
          balanceAfter: null,
        });
      }
    }

    return results;
  },

  async history(
    variantId: string,
    query: InventoryHistoryQuery,
  ): Promise<PageResult<InventoryLedgerEntryDto>> {
    const args = {
      where: { variantId, ...(query.reason ? { reason: query.reason } : {}) },
    };

    const [items, total] = await Promise.all([
      prisma.inventoryLedger.findMany({
        ...args,
        ...skipTake(query),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      prisma.inventoryLedger.count(args),
    ]);

    return pageResult(items.map(toLedgerDto), total, query);
  },

  async lowStock(query: LowStockQuery): Promise<PageResult<LowStockItemDto>> {
    const where: Prisma.ProductVariantWhereInput = {
      deletedAt: null,
      isActive: true,
      ...(query.includeBackorder ? {} : { allowBackorder: false }),
      // A made-to-order product is built per order, so its stock count is no risk (stockStatusFor).
      product: { isMadeToOrder: false },
      stockQty: { lte: query.threshold ?? prisma.productVariant.fields.lowStockThreshold },
    };

    const [rows, total] = await Promise.all([
      prisma.productVariant.findMany({
        where,
        include: { product: { select: { id: true, name: true } } },
        orderBy: [{ stockQty: 'asc' }, { id: 'asc' }],
        ...skipTake(query),
      }),
      prisma.productVariant.count({ where }),
    ]);

    const items = rows.map(({ product, ...variant }) => ({
      ...toSnapshot(variant),
      productId: product.id,
      productName: product.name,
      variantName: variant.name,
    }));
    return pageResult(items, total, query);
  },
};
