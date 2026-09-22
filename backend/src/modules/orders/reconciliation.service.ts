import type { ReconciliationReportDto } from '@shared/types/order';

import { logger } from '../../config/logger';
import { env } from '../../config/env';
import { prisma } from '../../config/prisma';
import { payment as paymentDriver } from '../../container';
import { orderRepository, stockReservationRepository } from '../../repositories/order.repository';
import {
  paymentRepository,
  paymentTransferRepository,
  refundRepository,
  splitAllocationRepository,
} from '../../repositories/payment.repository';

import { checkoutService } from './checkout.service';
import { orderStateMachine } from './orderStateMachine';

/**
 * The safety net.
 *
 * Distributed payment flows fail in the middle: a customer pays and the browser dies before the
 * verify call, the webhook is delayed past our hold window, a transfer request times out after the
 * provider accepted it. Every one of those leaves local state disagreeing with the provider, and
 * the only honest fix is to go and ask.
 *
 * So for each order stuck in PENDING_PAYMENT past its expiry we FETCH THE PROVIDER'S TRUTH FIRST
 * and only then decide: confirm it if it was actually paid, or release everything if it was not.
 * Expiring a paid order because our webhook was slow would be the worst possible outcome.
 *
 * Runs on demand from `/admin/orders/reconcile` today; Prompt 17 schedules it.
 */

export const reconciliationService = {
  async run(
    options: { olderThanMinutes?: number; limit?: number } = {},
  ): Promise<ReconciliationReportDto> {
    const cutoff = new Date(Date.now() - (options.olderThanMinutes ?? 0) * 60_000);
    const stale = await orderRepository.findExpired(cutoff, options.limit ?? 100);

    const report: ReconciliationReportDto = {
      scanned: stale.length,
      confirmed: 0,
      released: 0,
      expired: 0,
      capturedWithoutTransfers: [],
      allocationMismatches: [],
      orphanReservations: 0,
    };

    for (const order of stale) {
      const paymentRow = (await paymentRepository.forOrder(order.id)).at(-1);

      if (paymentRow?.providerOrderId) {
        try {
          const providerOrder = await paymentDriver.fetchOrder(paymentRow.providerOrderId);

          if (providerOrder.status === 'paid') {
            // The money is there; our record was simply behind.
            const providerPaymentId = paymentRow.providerPaymentId;
            if (providerPaymentId) {
              await checkoutService.confirmPayment({
                orderId: order.id,
                paymentId: paymentRow.id,
                providerPaymentId,
                source: 'WEBHOOK',
              });
              report.confirmed += 1;
              continue;
            }
          }
        } catch (error) {
          // If the provider cannot be reached we leave the order alone rather than guess.
          logger.warn(
            { err: error, orderId: order.id },
            'could not reach the provider during reconciliation — order left untouched',
          );
          continue;
        }
      }

      await checkoutService.releaseHolds(order, 'RECONCILED_EXPIRED');
      await orderRepository.update(order.id, { paymentStatus: 'EXPIRED' });

      const reloaded = (await orderRepository.findById(order.id))!;
      await orderStateMachine.transition(reloaded, 'EXPIRED', {
        note: 'reconciliation: the provider has no payment for this order',
        actorType: 'SYSTEM',
      });

      report.expired += 1;
      report.released += 1;
    }

    /* Ledger anomalies that need a human even when no order was swept. */

    const capturedWithoutTransfers = await paymentRepository.capturedWithoutTransfers();
    report.capturedWithoutTransfers = capturedWithoutTransfers.map((row) => row.orderId);

    for (const row of capturedWithoutTransfers) {
      const allocations = await splitAllocationRepository.sumForOrder(row.orderId);
      const transfers = await paymentTransferRepository.sumForPayment(row.id);

      if ((allocations._sum.amountPaise ?? 0) !== (transfers._sum.amountPaise ?? 0)) {
        report.allocationMismatches.push(row.orderId);
      }
    }

    report.orphanReservations = await stockReservationRepository.countOrphans();

    // H4 - the only thing allowed to resolve an unverified refund.
    await this.verifyPendingRefunds();

    return report;
  },

  /**
   * H4 - asks the provider what actually happened to refunds we could not confirm.
   *
   * A PENDING_VERIFICATION refund is money in limbo: the call may have succeeded, may not have.
   * Nothing else in the system may touch it — not the API, not the admin UI, not a retry button —
   * because every one of those would be guessing. This asks, and converges to the truth.
   *
   * Stale execution locks are reclaimed here for the same reason: a worker that died holding a lock
   * leaves a refund that looks busy forever, and only something that can verify provider state is
   * entitled to decide the lock is dead.
   */
  async verifyPendingRefunds(): Promise<{ checked: number; resolved: number }> {
    const cutoff = new Date(Date.now() - env.REFUND_LOCK_TIMEOUT_MINUTES * 60_000);
    const candidates = await refundRepository.reclaimStaleLocks(cutoff);

    let resolved = 0;

    for (const refund of candidates) {
      const payment = await paymentRepository.findById(refund.paymentId);
      if (!payment?.providerPaymentId) continue;

      try {
        const providerRefunds = await paymentDriver.fetchRefundsForPayment(
          payment.providerPaymentId,
        );

        const reference = refund.clientReference ?? refund.refundNumber;
        const match =
          providerRefunds.find((entry) => entry.clientReference === reference) ??
          (refund.providerRefundId
            ? providerRefunds.find(
                (entry) => entry.providerRefundId === refund.providerRefundId,
              )
            : undefined);

        if (match) {
          // It did happen. Adopt it and let the normal post-refund bookkeeping run.
          await refundRepository.update(refund.id, {
            providerRefundId: match.providerRefundId,
            status: match.status === 'processed' ? 'PROCESSED' : 'PROCESSING',
            processedAt: match.status === 'processed' ? new Date() : null,
            executionLockedAt: null,
            errorDescription: null,
          });

          const order = await orderRepository.findById(refund.orderId);
          if (order && match.status === 'processed') {
            const { refundService } = await import('../payments/refund/refund.service');
            await refundService.applyToOrder(order, refund.id).catch((error: unknown) => {
              logger.error(
                { refundId: refund.id, err: error },
                'could not apply a verified refund to its order',
              );
            });
          }

          logger.info(
            { refundNumber: refund.refundNumber, providerRefundId: match.providerRefundId },
            'reconciliation verified a pending refund as PROCESSED',
          );
        } else {
          /**
           * H7 - the provider has no such refund, so nothing moved and the held capacity goes
           * back. This is the ONLY place a held reservation may be released, because it is the
           * only place that has asked the provider what actually happened.
           */
          const reversals = await prisma.transferReversal.findMany({
            where: { refundId: refund.id, status: { in: ['PENDING', 'PENDING_VERIFICATION'] } },
          });

          if (refund.capacityReserved) {
            const { refundReservation } = await import(
              '../payments/refund/refundReservation'
            );

            await refundReservation.releaseAll(
              refund.orderId,
              refund.amountPaise,
              reversals.map((row) => ({
                transferId: row.paymentTransferId,
                amountPaise: row.amountPaise,
              })),
            );
          }

          await refundRepository.update(refund.id, {
            status: 'FAILED',
            failedAt: new Date(),
            executionLockedAt: null,
            capacityReserved: false,
            errorDescription: 'Verified with the provider: no refund was created',
          });

          logger.info(
            { refundNumber: refund.refundNumber },
            'reconciliation verified a pending refund as never created — capacity released',
          );
        }

        resolved += 1;
      } catch (error) {
        // Still cannot reach the provider: leave it exactly as it is. Guessing is the one thing
        // that must not happen here.
        logger.warn(
          { refundNumber: refund.refundNumber, err: error },
          'could not verify a pending refund — left for the next sweep',
        );
      }
    }

    return { checked: candidates.length, resolved };
  },
};
