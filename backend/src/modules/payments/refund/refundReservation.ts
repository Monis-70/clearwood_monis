import type { Prisma, PrismaClient } from '@prisma/client';

import { prisma } from '../../../config/prisma';
import { logger } from '../../../config/logger';
import { AppError } from '../../../utils/AppError';

/**
 * H7 - refund capacity is RESERVED, not checked.
 *
 * The pattern is deliberately the one `StockReservation` and `CouponRedemption` already use:
 * reserve, then confirm or release. Nothing new is invented here, because the problem is not new —
 * it is the same problem as two shoppers racing for the last sofa, with money instead of stock.
 *
 * WHY A CHECK IS NOT ENOUGH: a check answers "is there capacity right now", and by the time the
 * provider responds several seconds later the answer may have changed. A reservation answers
 * "capacity is mine", and holds it across the call. That is the whole difference between two
 * concurrent refunds both seeing room and two concurrent refunds where only one gets it.
 *
 * WHY UNKNOWN HOLDS: if we release a reservation for a refund that may have succeeded, the freed
 * capacity lets a second refund through — and if the first one did land, the customer is paid
 * twice. Holding costs nothing but a temporarily reduced ceiling; releasing costs real money. This
 * mirrors the stale-lock rule exactly: only reconciliation, having asked the provider, may decide.
 */

type Tx = Prisma.TransactionClient | PrismaClient;

export interface ReversalReservation {
  transferId: string;
  amountPaise: number;
}

export const refundReservation = {
  /**
   * Claims refund capacity on the order and reversal capacity on each transfer.
   *
   * All-or-nothing: if any transfer cannot take its share, the whole thing rolls back and no
   * provider call happens. A partially reserved refund would be worse than a rejected one.
   */
  async reserve(
    orderId: string,
    amountPaise: number,
    reversals: ReversalReservation[],
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await this.reserveOrder(orderId, amountPaise, tx);

      for (const reversal of reversals) {
        await this.reserveTransfer(reversal.transferId, reversal.amountPaise, tx);
      }
    });
  },

  async reserveOrder(orderId: string, amountPaise: number, tx: Tx = prisma): Promise<void> {
    /*
     * The capacity test lives in the WHERE clause, compared against the row's OWN columns.
     *
     * It used to read the row and then pin `refundedPaise` and `refundReservedPaise` to the values
     * it had just seen. That is a compare-and-set, and under concurrency it fails for callers who
     * had capacity - it only means "somebody moved first". Because the miss threw
     * REFUND_EXCEEDS_PAID, contention arrived dressed as a business refusal: five parallel refunds
     * of 40% each measured one success and four REFUSED with zero contention recorded, when two
     * should have fitted. One statement means MySQL evaluates the test under the row lock it is
     * about to take, so concurrent reservations queue and each gets a true answer.
     */
    const claimed = await tx.$executeRaw`
      UPDATE \`Order\`
      SET refundReservedPaise = refundReservedPaise + ${amountPaise}
      WHERE id = ${orderId}
        AND paidPaise >= refundedPaise + refundReservedPaise + ${amountPaise}
    `;

    if (claimed === 1) return;

    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { paidPaise: true, refundedPaise: true, refundReservedPaise: true },
    });

    if (!order) throw AppError.notFound('Order not found', { orderId });

    throw new AppError(
      409,
      'REFUND_EXCEEDS_PAID',
      'That refund would exceed what is still refundable on this order',
      {
        paidPaise: order.paidPaise,
        refundedPaise: order.refundedPaise,
        alreadyReservedPaise: order.refundReservedPaise,
        requestedPaise: amountPaise,
      },
    );
  },

  async reserveTransfer(transferId: string, amountPaise: number, tx: Tx = prisma): Promise<void> {
    // Same shape and same reason as reserveOrder: the test belongs in the WHERE, not in a snapshot.
    const claimed = await tx.$executeRaw`
      UPDATE \`PaymentTransfer\`
      SET reversalReservedPaise = reversalReservedPaise + ${amountPaise}
      WHERE id = ${transferId}
        AND amountPaise >= reversedPaise + reversalReservedPaise + ${amountPaise}
    `;

    if (claimed === 1) return;

    const transfer = await tx.paymentTransfer.findUnique({
      where: { id: transferId },
      select: { amountPaise: true, reversedPaise: true, reversalReservedPaise: true },
    });

    if (!transfer) throw AppError.notFound('Transfer not found', { transferId });

    throw new AppError(
      409,
      'REVERSAL_EXCEEDS_TRANSFER',
      'That reversal would exceed what the transfer still holds',
      {
        transferId,
        transferPaise: transfer.amountPaise,
        reversedPaise: transfer.reversedPaise,
        alreadyReservedPaise: transfer.reversalReservedPaise,
        requestedPaise: amountPaise,
      },
    );
  },

  /** Reservation becomes settled money. Predicated so it can never underflow the reservation. */
  async confirmOrder(orderId: string, amountPaise: number, tx: Tx = prisma): Promise<boolean> {
    const { count } = await tx.order.updateMany({
      where: { id: orderId, refundReservedPaise: { gte: amountPaise } },
      data: {
        refundReservedPaise: { decrement: amountPaise },
        refundedPaise: { increment: amountPaise },
        version: { increment: 1 },
      },
    });

    return count === 1;
  },

  async confirmTransfer(
    transferId: string,
    amountPaise: number,
    tx: Tx = prisma,
  ): Promise<boolean> {
    const { count } = await tx.paymentTransfer.updateMany({
      where: { id: transferId, reversalReservedPaise: { gte: amountPaise } },
      data: {
        reversalReservedPaise: { decrement: amountPaise },
        reversedPaise: { increment: amountPaise },
      },
    });

    return count === 1;
  },

  /**
   * Hands capacity back.
   *
   * Idempotent by predicate: releasing twice finds nothing left to release and changes nothing,
   * which is what lets a retry path call it without bookkeeping.
   */
  async releaseOrder(orderId: string, amountPaise: number, tx: Tx = prisma): Promise<boolean> {
    const { count } = await tx.order.updateMany({
      where: { id: orderId, refundReservedPaise: { gte: amountPaise } },
      data: { refundReservedPaise: { decrement: amountPaise } },
    });

    return count === 1;
  },

  async releaseTransfer(
    transferId: string,
    amountPaise: number,
    tx: Tx = prisma,
  ): Promise<boolean> {
    const { count } = await tx.paymentTransfer.updateMany({
      where: { id: transferId, reversalReservedPaise: { gte: amountPaise } },
      data: { reversalReservedPaise: { decrement: amountPaise } },
    });

    return count === 1;
  },

  /** Releases everything a refund reserved. Used on TERMINAL and RETRYABLE outcomes only. */
  async releaseAll(
    orderId: string,
    amountPaise: number,
    reversals: ReversalReservation[],
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await this.releaseOrder(orderId, amountPaise, tx);

      for (const reversal of reversals) {
        await this.releaseTransfer(reversal.transferId, reversal.amountPaise, tx);
      }
    });

    logger.debug({ orderId, amountPaise }, 'refund reservation released');
  },
};
