import type { CouponRedemption } from '@prisma/client';

import { prisma } from '../../config/prisma';
import { AppError } from '../../utils/AppError';

/**
 * Two-phase coupon redemption.
 *
 *   reserve  at checkout — takes a slot against `usageLimit` so two shoppers cannot both spend the
 *            last one; the slot is held, not spent.
 *   confirm  on payment success — turns the reservation into a permanent use.
 *   release  on payment failure, abandonment or cancellation — hands the slot back.
 *
 * `Coupon.usedCount` moves ONLY here, and only through a write whose WHERE clause carries the
 * limit, so a burst of parallel checkouts can never oversell a coupon. Prompt 9 calls
 * confirm/release from the order lifecycle.
 */

export interface ReserveInput {
  couponId: string;
  customerId?: string | null;
  orderId?: string | null;
  amountPaise: number;
}

export const couponRedemptionService = {
  /**
   * Takes a slot. Throws 409 COUPON_EXHAUSTED when the limit is already reached.
   *
   * The limit is enforced by the WHERE clause of the increment, compared against the row's OWN
   * current `usageLimit` rather than a value read a moment earlier, so there is no snapshot to go
   * stale. One statement means MySQL holds the row lock across both the test and the write:
   * concurrent callers serialise on the row and each either takes a slot or is told the coupon is
   * full. Nobody loses a race they then have to retry.
   *
   * It used to read, then `updateMany` on the value it had read, and retry when that matched
   * nothing. SQLite hid the cost by serialising writers; on MySQL twelve callers against a limit
   * of ten produced five successes and seven COUPON_CONFLICTs - two genuine refusals and five
   * callers that had simply run out of retries.
   *
   * The increment and the redemption row commit together. They used to be two statements with a
   * decrement in a catch block, which leaked a slot permanently if the process died between them.
   */
  async reserve(input: ReserveInput): Promise<CouponRedemption> {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.coupon.updateMany({
        where: {
          id: input.couponId,
          deletedAt: null,
          OR: [{ usageLimit: null }, { usedCount: { lt: prisma.coupon.fields.usageLimit } }],
        },
        data: { usedCount: { increment: 1 } },
      });

      if (count === 0) {
        // Only now is a read worth paying for: it separates "no such coupon" from "full".
        const coupon = await tx.coupon.findFirst({
          where: { id: input.couponId, deletedAt: null },
          select: { id: true, usageLimit: true },
        });

        if (!coupon) throw AppError.notFound('Coupon not found', { couponId: input.couponId });

        throw new AppError(409, 'COUPON_EXHAUSTED', 'This coupon has been fully claimed', {
          couponId: coupon.id,
          usageLimit: coupon.usageLimit,
        });
      }

      return tx.couponRedemption.create({
        data: {
          couponId: input.couponId,
          customerId: input.customerId ?? null,
          orderId: input.orderId ?? null,
          amountPaise: input.amountPaise,
          status: 'RESERVED',
        },
      });
    });
  },

  /** Idempotent: confirming an already-confirmed reservation changes nothing. */
  async confirm(redemptionId: string, orderId?: string): Promise<CouponRedemption> {
    const redemption = await prisma.couponRedemption.findUnique({ where: { id: redemptionId } });
    if (!redemption) throw AppError.notFound('Redemption not found', { redemptionId });

    if (redemption.status === 'CONFIRMED') return redemption;

    if (redemption.status === 'RELEASED') {
      throw new AppError(
        409,
        'REDEMPTION_RELEASED',
        'This reservation was already released and cannot be confirmed',
        { redemptionId },
      );
    }

    return prisma.couponRedemption.update({
      where: { id: redemptionId },
      data: {
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        ...(orderId ? { orderId } : {}),
      },
    });
  },

  /** Idempotent: releasing twice returns the slot exactly once. */
  async release(redemptionId: string): Promise<CouponRedemption> {
    const redemption = await prisma.couponRedemption.findUnique({ where: { id: redemptionId } });
    if (!redemption) throw AppError.notFound('Redemption not found', { redemptionId });

    if (redemption.status !== 'RESERVED') return redemption;

    const [, released] = await prisma.$transaction([
      prisma.coupon.updateMany({
        where: { id: redemption.couponId, usedCount: { gt: 0 } },
        data: { usedCount: { decrement: 1 } },
      }),
      prisma.couponRedemption.update({
        where: { id: redemptionId },
        data: { status: 'RELEASED', releasedAt: new Date() },
      }),
    ]);

    return released;
  },

  list(couponId: string) {
    return prisma.couponRedemption.findMany({
      where: { couponId },
      orderBy: { reservedAt: 'desc' },
      take: 200,
    });
  },

  async countFor(
    couponId: string,
  ): Promise<{ reserved: number; confirmed: number; released: number }> {
    const grouped = await prisma.couponRedemption.groupBy({
      by: ['status'],
      where: { couponId },
      _count: { _all: true },
    });

    const find = (status: string) => grouped.find((row) => row.status === status)?._count._all ?? 0;

    return {
      reserved: find('RESERVED'),
      confirmed: find('CONFIRMED'),
      released: find('RELEASED'),
    };
  },
};
