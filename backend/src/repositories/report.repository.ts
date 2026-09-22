import { prisma } from '../config/prisma';

/**
 * R1 — the reports module reaches Prisma only through this file.
 *
 * Reports READ; nothing here writes. Every query is bounded by a date range supplied by the
 * caller and validated at the boundary, because an unbounded aggregate over the order table is a
 * denial of service you write yourself.
 */

export interface ReportRange {
  from: Date;
  to: Date;
}

/** Orders that count as revenue: money was actually captured. Drafts and failures are not sales. */
const SOLD = { paymentStatus: { in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } };

export const reportRepository = {
  salesOrders({ from, to }: ReportRange) {
    return prisma.order.findMany({
      where: { ...SOLD, placedAt: { gte: from, lte: to } },
      select: {
        orderNumber: true,
        placedAt: true,
        status: true,
        paymentStatus: true,
        channel: true,
        placeOfSupply: true,
        subtotalPaise: true,
        discountPaise: true,
        shippingPaise: true,
        taxPaise: true,
        cgstPaise: true,
        sgstPaise: true,
        igstPaise: true,
        roundingPaise: true,
        grandTotalPaise: true,
        paidPaise: true,
        refundedPaise: true,
      },
      orderBy: { placedAt: 'asc' },
    });
  },

  /** Per-line tax, for the HSN summary and for reconciling the order-level tax columns. */
  soldItems({ from, to }: ReportRange) {
    return prisma.orderItem.findMany({
      where: { order: { ...SOLD, placedAt: { gte: from, lte: to } } },
      select: {
        sku: true,
        productName: true,
        hsnCode: true,
        qty: true,
        taxRateBp: true,
        taxablePaise: true,
        taxPaise: true,
        cgstPaise: true,
        sgstPaise: true,
        igstPaise: true,
        lineTotalPaise: true,
        order: { select: { orderNumber: true, placedAt: true } },
      },
      orderBy: { id: 'asc' },
    });
  },

  transfers({ from, to }: ReportRange) {
    return prisma.paymentTransfer.findMany({
      where: { createdAt: { gte: from, lte: to } },
      select: {
        id: true,
        amountPaise: true,
        reversedPaise: true,
        reversalReservedPaise: true,
        status: true,
        settlementStatus: true,
        createdAt: true,
        account: { select: { key: true, name: true } },
        payment: { select: { order: { select: { orderNumber: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
  },

  /** The reversal rows themselves, so a payout figure can be reconciled without trusting a counter. */
  reversals({ from, to }: ReportRange) {
    return prisma.transferReversal.findMany({
      where: { createdAt: { gte: from, lte: to }, status: 'PROCESSED' },
      select: { amountPaise: true, paymentTransferId: true },
    });
  },

  refunds({ from, to }: ReportRange) {
    return prisma.refund.findMany({
      where: { createdAt: { gte: from, lte: to } },
      select: {
        refundNumber: true,
        amountPaise: true,
        status: true,
        reason: true,
        speed: true,
        isFullRefund: true,
        createdAt: true,
        processedAt: true,
        order: { select: { orderNumber: true, grandTotalPaise: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  },

  inventoryMovements({ from, to }: ReportRange) {
    return prisma.inventoryLedger.findMany({
      where: { createdAt: { gte: from, lte: to } },
      select: {
        createdAt: true,
        delta: true,
        balanceAfter: true,
        reason: true,
        refType: true,
        refId: true,
        actorType: true,
        variant: {
          select: { sku: true, product: { select: { name: true } } },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  },
};
