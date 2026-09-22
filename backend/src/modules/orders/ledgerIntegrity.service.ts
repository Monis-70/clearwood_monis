import type { LedgerCheckDto } from '@shared/types/order';

import { env } from '../../config/env';
import { prisma } from '../../config/prisma';
import { orderRepository, stockReservationRepository } from '../../repositories/order.repository';
import {
  paymentRepository,
  paymentTransferRepository,
  refundRepository,
  splitAllocationRepository,
} from '../../repositories/payment.repository';
import { AppError } from '../../utils/AppError';
import { isDispatched } from '../fulfilment/shipmentStateMachine';

/**
 * L4 — money movement is double-entry and replayable, so it must BALANCE.
 *
 * Every check below is a statement that should be true of any healthy order. If one fails, the
 * report says precisely which number disagreed with which, because "the ledger is broken" is not
 * something anyone can act on at 2am.
 *
 * This is deliberately a read-only verifier. It never repairs anything — a discrepancy is a
 * question for a human, and silently "fixing" money is how discrepancies become undetectable.
 */

interface Check {
  name: string;
  ok: boolean;
  expected: number;
  actual: number;
  message: string;
}

function check(name: string, expected: number, actual: number, message: string): Check {
  return { name, ok: expected === actual, expected, actual, message };
}

export const ledgerIntegrityService = {
  async verifyOrder(orderId: string): Promise<LedgerCheckDto> {
    const order = await orderRepository.findById(orderId);
    if (!order) throw AppError.notFound('Order not found', { orderId });

    const [payments, transfers, allocations, refundSum, reservations] = await Promise.all([
      paymentRepository.forOrder(order.id),
      paymentTransferRepository.forOrder(order.id),
      splitAllocationRepository.forOrder(order.id),
      refundRepository.sumProcessed(order.id),
      stockReservationRepository.forOrder(order.id),
    ]);

    const checks: Check[] = [];

    /* 1. The order's own arithmetic: lines plus cart-level components equal the grand total. */
    const lineTotal = order.items.reduce((sum, item) => sum + item.lineTotalPaise, 0);
    const cartLevel = order.shippingPaise + order.roundingPaise;
    checks.push(
      check(
        'lines_sum_to_grand_total',
        order.grandTotalPaise,
        lineTotal + cartLevel,
        'sum(OrderItem.lineTotalPaise) + shipping + rounding must equal Order.grandTotalPaise',
      ),
    );

    /* 2. The frozen breakdown still says what the columns say (L2 has not been violated). */
    const frozen = JSON.parse(order.breakdownJson) as { grandTotalPaise?: number };
    checks.push(
      check(
        'frozen_breakdown_matches_columns',
        order.grandTotalPaise,
        frozen.grandTotalPaise ?? -1,
        'breakdownJson.grandTotalPaise must equal Order.grandTotalPaise',
      ),
    );

    /* 3. What the order says it took equals what was actually captured.

       NOTE: refunds do NOT reduce `paidPaise`. They accumulate in `refundedPaise`, so the net is
       `paidPaise - refundedPaise`. This check originally subtracted refunds and passed only
       because Prompt 9A could never process one; executing refunds exposed it. */
    const captured = payments.reduce((sum, row) => sum + row.capturedPaise, 0);
    const refunded = refundSum._sum.amountPaise ?? 0;
    checks.push(
      check(
        'paid_equals_captured',
        order.paidPaise,
        captured,
        'sum(Payment.capturedPaise) must equal Order.paidPaise',
      ),
    );

    /* 3b. And nothing may be refunded that was never taken. */
    checks.push(
      check(
        'refunded_within_paid',
        Math.min(refunded, order.paidPaise),
        refunded,
        'Order.refundedPaise must never exceed Order.paidPaise',
      ),
    );

    /* 4. At most one captured payment. Two would mean the customer paid twice. */
    const capturedCount = payments.filter((row) => row.status === 'CAPTURED').length;
    checks.push(
      check(
        'at_most_one_captured_payment',
        Math.min(capturedCount, 1),
        capturedCount,
        'an order may have at most one CAPTURED payment',
      ),
    );

    /* 5. Transfers equal the transferable amount of the captured payment. */
    const capturedPayment = payments.find((row) => row.status === 'CAPTURED');
    const transferred = transfers
      .filter((row) => row.status !== 'FAILED')
      .reduce((sum, row) => sum + row.amountPaise, 0);

    if (capturedPayment && capturedPayment.isTransferable && transfers.length > 0) {
      checks.push(
        check(
          'transfers_equal_transferable',
          capturedPayment.capturedPaise,
          transferred +
            transfers.filter((r) => r.status === 'FAILED').reduce((s, r) => s + r.amountPaise, 0),
          'sum(PaymentTransfer.amountPaise) must equal the captured amount',
        ),
      );
    }

    /* 6. Allocations and transfers tell the same story. */
    if (transfers.length > 0) {
      const allocated = allocations
        .filter((row) => row.amountPaise > 0)
        .reduce((sum, row) => sum + row.amountPaise, 0);
      const transferRows = transfers.reduce((sum, row) => sum + row.amountPaise, 0);

      checks.push(
        check(
          'allocations_match_transfers',
          allocated,
          transferRows,
          'sum(SplitAllocation) must equal sum(PaymentTransfer) for the payable allocations',
        ),
      );
    }

    /* 7. A finished order holds nothing (L5). */
    const terminal = ['CANCELLED', 'EXPIRED', 'PAYMENT_FAILED', 'REFUNDED'].includes(order.status);
    if (terminal) {
      const stillHeld = reservations.filter((row) => row.status === 'RESERVED').length;
      checks.push(
        check(
          'no_orphan_reservations',
          0,
          stillHeld,
          'a terminal order must not be holding any stock',
        ),
      );
    }

    /* ---- H6: every new money path introduced by refund execution ---- */

    /* 8. The refunds that actually processed are exactly what the order claims to have returned. */
    checks.push(
      check(
        'processed_refunds_equal_order_refunded',
        order.refundedPaise,
        refunded,
        'sum(Refund.amountPaise where PROCESSED) must equal Order.refundedPaise',
      ),
    );

    /* 9. Each transfer's reversed total is what its PROCESSED reversals add up to, and no more
          than the transfer itself ever held. */
    for (const transfer of transfers) {
      const processed = await prisma.transferReversal.aggregate({
        where: { paymentTransferId: transfer.id, status: 'PROCESSED' },
        _sum: { amountPaise: true },
      });
      const reversedSum = processed._sum.amountPaise ?? 0;

      checks.push(
        check(
          `reversals_match_transfer_${transfer.id.slice(-6)}`,
          transfer.reversedPaise,
          reversedSum,
          'sum(TransferReversal PROCESSED) must equal PaymentTransfer.reversedPaise',
        ),
      );

      checks.push(
        check(
          `reversal_within_transfer_${transfer.id.slice(-6)}`,
          Math.min(transfer.reversedPaise, transfer.amountPaise),
          transfer.reversedPaise,
          'PaymentTransfer.reversedPaise must never exceed its amountPaise',
        ),
      );
    }

    /* 10. A refund never reverses more than its own value.
           NOT equality: when several refunds hit the same order, an earlier one can exhaust the
           transfers and leave a later one with nothing to reverse. That shortfall is the platform's
           to absorb and is legitimate — reversing MORE than the refund never is. */
    const orderRefunds = await prisma.refund.findMany({
      where: { orderId: order.id, status: 'PROCESSED' },
      include: { reversals: { where: { status: 'PROCESSED' } } },
    });

    const hasTransfers = transfers.some((row) => row.status === 'PROCESSED');

    for (const refund of orderRefunds) {
      const reversedForRefund = refund.reversals.reduce((sum, row) => sum + row.amountPaise, 0);

      checks.push(
        check(
          `refund_reversals_within_amount_${refund.refundNumber}`,
          Math.min(reversedForRefund, refund.amountPaise),
          reversedForRefund,
          'a refund must never reverse more than its own amount',
        ),
      );

      // With no transferable money there is nothing to reverse, so there must be nothing.
      if (!hasTransfers) {
        checks.push(
          check(
            `refund_no_reversals_${refund.refundNumber}`,
            0,
            reversedForRefund,
            'a refund with no transfers must not have reversals',
          ),
        );
      }
    }

    /* 10b. Across the whole order, reversals never exceed what was transferred out. */
    const transferredOut = transfers
      .filter((row) => row.status === 'PROCESSED')
      .reduce((sum, row) => sum + row.amountPaise, 0);
    const reversedTotal = transfers.reduce((sum, row) => sum + row.reversedPaise, 0);

    checks.push(
      check(
        'reversed_within_transferred',
        Math.min(reversedTotal, transferredOut),
        reversedTotal,
        'total reversed must never exceed total transferred',
      ),
    );

    /* 11. Nothing is stuck. A refund held for verification, or locked past the timeout, must be
           visible in the needs-attention queue rather than sitting silently. */
    const stuckCutoff = new Date(Date.now() - env.REFUND_LOCK_TIMEOUT_MINUTES * 60_000);    const stuck = await prisma.refund.count({
      where: {
        orderId: order.id,
        OR: [
          { status: 'PENDING_VERIFICATION', updatedAt: { lt: stuckCutoff } },
          { status: 'PROCESSING', executionLockedAt: { lt: stuckCutoff } },
        ],
      },
    });

    checks.push(
      check(
        'no_silently_stuck_refunds',
        0,
        stuck,
        'a refund left PROCESSING or PENDING_VERIFICATION past the lock timeout needs an operator',
      ),
    );

    /* ---- H7: reserved capacity is part of the ceiling, not outside it ---- */

    /* 12. Settled plus reserved never exceeds what was paid. This is the invariant the whole
           reservation mechanism exists to keep, so it is asserted unconditionally. */
    checks.push(
      check(
        'refunded_plus_reserved_within_paid',
        Math.min(order.refundedPaise + order.refundReservedPaise, order.paidPaise),
        order.refundedPaise + order.refundReservedPaise,
        'Order.refundedPaise + refundReservedPaise must never exceed paidPaise',
      ),
    );

    /* 13. The same, per transfer. */
    for (const transfer of transfers) {
      checks.push(
        check(
          `reversed_plus_reserved_within_transfer_${transfer.id.slice(-6)}`,
          Math.min(
            transfer.reversedPaise + transfer.reversalReservedPaise,
            transfer.amountPaise,
          ),
          transfer.reversedPaise + transfer.reversalReservedPaise,
          'PaymentTransfer.reversedPaise + reversalReservedPaise must never exceed amountPaise',
        ),
      );
    }

    /* 14. Reserved capacity belongs to a refund that is actually in flight. A reservation with no
           owner is capacity nobody will ever release. */
    if (order.refundReservedPaise > 0) {
      const inFlight = await prisma.refund.count({
        where: {
          orderId: order.id,
          status: { in: ['PROCESSING', 'PENDING_VERIFICATION'] },
          capacityReserved: true,
        },
      });

      checks.push(
        check(
          'reservation_is_not_orphaned',
          1,
          inFlight > 0 ? 1 : 0,
          'reserved refund capacity must belong to a refund in PROCESSING or PENDING_VERIFICATION',
        ),
      );
    }

    /* ---- Slice A: fulfilment. Goods rather than money, but the same discipline ---- */

    const shipments = await prisma.shipment.findMany({
      where: { orderId: order.id },
      include: { items: true },
    });

    const liveShipments = shipments.filter((shipment) => shipment.status !== 'CANCELLED');

    /* 15. A shipment may never carry an item belonging to another order. That would put one
           customer's goods on another customer's parcel. */
    const orderItemIds = new Set(order.items.map((item) => item.id));
    const foreign = shipments
      .flatMap((shipment) => shipment.items)
      .filter((item) => !orderItemIds.has(item.orderItemId)).length;

    checks.push(
      check(
        'no_foreign_shipment_items',
        0,
        foreign,
        'every ShipmentItem must reference an OrderItem on this order',
      ),
    );

    for (const item of order.items) {
      const shippable = Math.max(item.qty - item.cancelledQty, 0);

      /* 16. Never ship more than was ordered. */
      const shipped = liveShipments
        .flatMap((shipment) => shipment.items)
        .filter((line) => line.orderItemId === item.id)
        .reduce((sum, line) => sum + line.qty, 0);

      checks.push(
        check(
          `shipped_within_ordered_${item.sku}`,
          Math.min(shipped, shippable),
          shipped,
          'sum(ShipmentItem.qty) must never exceed ordered minus cancelled',
        ),
      );

      /* 17. fulfilledQty is exactly the DISPATCHED sum — not the drafted sum, and not a counter
             that drifts. */
      const dispatched = liveShipments
        .filter((shipment) => shipment.direction === 'FORWARD' && isDispatched(shipment.status))
        .flatMap((shipment) => shipment.items)
        .filter((line) => line.orderItemId === item.id)
        .reduce((sum, line) => sum + line.qty, 0);

      checks.push(
        check(
          `fulfilled_matches_dispatched_${item.sku}`,
          Math.min(dispatched, shippable),
          item.fulfilledQty,
          'OrderItem.fulfilledQty must equal the dispatched shipment quantity',
        ),
      );
    }

    /* 18. Nothing can come back that never went out. */
    const returns = await prisma.returnRequest.findMany({
      where: { orderId: order.id, status: { notIn: ['REJECTED', 'CANCELLED'] } },
      include: { items: true },
    });

    const deliveredByItem = new Map<string, number>();
    for (const shipment of liveShipments) {
      if (shipment.direction !== 'FORWARD' || shipment.status !== 'DELIVERED') continue;

      for (const line of shipment.items) {
        deliveredByItem.set(
          line.orderItemId,
          (deliveredByItem.get(line.orderItemId) ?? 0) + line.qty,
        );
      }
    }

    for (const item of order.items) {
      const returned = returns
        .flatMap((request) => request.items)
        .filter((line) => line.orderItemId === item.id)
        .reduce((sum, line) => sum + line.qtyRequested, 0);

      if (returned === 0) continue;

      const delivered = deliveredByItem.get(item.id) ?? 0;

      // Staff may accept a return on goods our records never marked delivered (a manual handover),
      // so this only binds once a delivery IS recorded.
      if (delivered === 0) continue;

      checks.push(
        check(
          `returned_within_delivered_${item.sku}`,
          Math.min(returned, delivered),
          returned,
          'returned quantity must never exceed delivered quantity',
        ),
      );
    }

    /* ---- Slice B: documents. A tax invoice is a legal statement of the order ---- */

    const documents = await prisma.orderDocument.findMany({
      where: { orderId: order.id },
      orderBy: { issuedAt: 'asc' },
    });

    const invoices = documents.filter((document) => document.type === 'TAX_INVOICE');

    /* 19. The invoice states the order's own total, exactly. A document that disagrees with the
           frozen snapshot is a GST exposure, not a display bug. */
    const invoice = invoices[0];

    if (invoice) {
      checks.push(
        check(
          'invoice_total_matches_order',
          order.grandTotalPaise,
          invoice.totalPaise,
          'the tax invoice total must equal Order.grandTotalPaise',
        ),
      );

      checks.push(
        check(
          'invoice_tax_matches_order',
          order.cgstPaise + order.sgstPaise + order.igstPaise,
          invoice.taxPaise,
          'the tax invoice tax must equal the order tax',
        ),
      );

      /* 20. One invoice per order. Two would be two demands for the same money. */
      checks.push(
        check(
          'one_invoice_per_order',
          1,
          invoices.length,
          'an order may have exactly one tax invoice',
        ),
      );
    }

    /* 21. Each credit note equals the refund it reverses. */
    for (const note of documents.filter((document) => document.type === 'CREDIT_NOTE')) {
      if (!note.refundId) continue;

      const noteRefund = await prisma.refund.findUnique({ where: { id: note.refundId } });
      if (!noteRefund) continue;

      checks.push(
        check(
          `credit_note_matches_refund_${noteRefund.refundNumber}`,
          noteRefund.amountPaise,
          note.totalPaise,
          'a credit note must equal the refund it reverses',
        ),
      );
    }

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      ok: checks.every((entry) => entry.ok),
      checks,
    };
  },

  /** Sweeps a window of orders. Used by the tests and by the admin reconciliation report. */
  async verifyAll(options: { from?: Date; to?: Date; limit?: number } = {}): Promise<{
    checked: number;
    failed: LedgerCheckDto[];
  }> {
    const orders = await prisma.order.findMany({
      where: {
        ...(options.from || options.to
          ? {
              createdAt: {
                ...(options.from ? { gte: options.from } : {}),
                ...(options.to ? { lte: options.to } : {}),
              },
            }
          : {}),
      },
      select: { id: true },
      take: options.limit ?? 200,
      orderBy: { createdAt: 'desc' },
    });

    const failed: LedgerCheckDto[] = [];
    for (const order of orders) {
      const report = await this.verifyOrder(order.id);
      if (!report.ok) failed.push(report);
    }

    return { checked: orders.length, failed };
  },
};
