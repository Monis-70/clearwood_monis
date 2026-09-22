import type { RefundRequestInput } from '@shared/schemas/fulfilment';

import { logger } from '../../../config/logger';
import { prisma } from '../../../config/prisma';
import { payment as paymentDriver } from '../../../container';
import { classifyProviderError, redactedJson } from '../../../drivers/payment';
import { orderRepository, type OrderWithDetail } from '../../../repositories/order.repository';
import {
  paymentRepository,
  paymentTransferRepository,
  refundRepository,
  transferReversalRepository,
} from '../../../repositories/payment.repository';
import { AppError } from '../../../utils/AppError';
import { inventoryService } from '../../catalog-admin/inventory.service';
import { orderStateMachine } from '../../orders/orderStateMachine';

import {
  calculateRefund,
  RefundCalculationError,
  type RefundComputation,
  type RefundOrderContext,
} from './refundCalculator';
import {
  planReversals,
  type ReversalPlan,
  type ReversalPolicy,
  type ReversibleTransfer,
} from './reversalPlanner';
import { refundReservation, type ReversalReservation } from './refundReservation';

/**
 * Refund execution: request → approve → execute.
 *
 * Prompt 9A could only RECORD a refund. This is the half that actually moves money, which means it
 * is the most dangerous file in the project. Five rules hold it together:
 *
 *  1. **The amount is never supplied.** It is derived from the frozen order lines by
 *     `refundCalculator` at request time and frozen on the Refund row. A caller chooses quantities;
 *     nobody, including an admin, can type an amount.
 *  2. **Never partially applied.** The provider call is the commit point. Everything before it is
 *     preparation, everything after is bookkeeping, and a provider failure leaves the refund FAILED
 *     with no stock moved, no transfer reversed and no order status changed.
 *  3. **Idempotent.** Execution is a compare-and-set from APPROVED to PROCESSING, so two admins
 *     clicking at once produce one provider call. A refund that already has a `providerRefundId`
 *     returns it rather than issuing a second.
 *  4. **Restock goes through inventory.service and nowhere else.** It is also OPT-IN: a returned
 *     sofa with a scratch is not stock, and putting it back would sell a damaged item to somebody.
 *  5. **Reversals are planned before they are executed**, by the pure planner, and asserted to sum
 *     to the refund. A partner's share comes back from the partner.
 */

interface Actor {
  actorType: 'ADMIN' | 'CUSTOMER' | 'SYSTEM';
  actorId?: string | null;
  actorName?: string | null;
}

/** Thrown inside the reversal transaction so a rejected guard rolls the increment back. */
class TransferGuardRejection extends Error {}

export interface RefundPreview {
  computation: RefundComputation;
  reversalPlan: ReversalPlan;
  canExecute: boolean;
  blockedReason: string | null;
}

function toRefundContext(order: OrderWithDetail): RefundOrderContext {
  return {
    orderId: order.id,
    grandTotalPaise: order.grandTotalPaise,
    paidPaise: order.paidPaise,
    refundedPaise: order.refundedPaise,
    refundReservedPaise: order.refundReservedPaise,
    shippingPaise: order.shippingPaise,
    roundingPaise: order.roundingPaise,
    lines: order.items.map((item) => ({
      orderItemId: item.id,
      sku: item.sku,
      qty: item.qty,
      cancelledQty: item.cancelledQty,
      refundedQty: item.refundedQty,
      refundedAmountPaise: item.refundedAmountPaise,
      unitPricePaise: item.unitPricePaise,
      lineSubtotalPaise: item.lineSubtotalPaise,
      lineDiscountPaise: item.lineDiscountPaise,
      taxablePaise: item.taxablePaise,
      taxPaise: item.taxPaise,
      cgstPaise: item.cgstPaise,
      sgstPaise: item.sgstPaise,
      igstPaise: item.igstPaise,
      taxRateBp: item.taxRateBp,
      lineTotalPaise: item.lineTotalPaise,
    })),
  };
}

/** The transfers that actually completed, in the shape the pure planner wants. */
async function reversibleTransfers(orderId: string): Promise<ReversibleTransfer[]> {
  const transfers = await paymentTransferRepository.forOrder(orderId);

  return transfers
    .filter((transfer) => transfer.status === 'PROCESSED')
    .map((transfer) => ({
      transferId: transfer.id,
      providerTransferId: transfer.providerTransferId,
      accountId: transfer.splitAccountId,
      accountKey: transfer.account.key,
      accountName: transfer.account.name,
      providerAccountId: transfer.account.providerAccountId,
      isPrimary: transfer.account.isPrimary,
      amountPaise: transfer.amountPaise,
      reversedPaise: transfer.reversedPaise,
    }));
}

export const refundService = {
  /**
   * What this refund would do, without doing any of it.
   *
   * Drives the admin's live preview. An admin about to return ₹6,000 of somebody's money should be
   * able to see the line maths AND which account each rupee comes out of before they commit.
   */
  async preview(orderNumber: string, input: RefundRequestInput): Promise<RefundPreview> {
    const order = await orderRepository.findByNumber(orderNumber);
    if (!order) throw AppError.notFound('Order not found');

    const computation = calculateRefund(toRefundContext(order), input.lines, {
      ...(input.includeShipping === undefined ? {} : { includeShipping: input.includeShipping }),
    });

    const transfers = await reversibleTransfers(order.id);
    const reversalPlan = planReversals(
      computation.totalPaise,
      transfers,
      input.reversalPolicy as ReversalPolicy,
    );

    const blockedReason = await this.blockedReason(order);

    return { computation, reversalPlan, canExecute: blockedReason === null, blockedReason };
  },

  /** Why this order cannot be refunded right now, or null. */
  async blockedReason(order: OrderWithDetail): Promise<string | null> {
    if (order.paidPaise <= 0) return 'Nothing has been paid on this order yet';
    if (order.paidPaise - order.refundedPaise <= 0) return 'This order is already fully refunded';

    // H7 - a refund whose outcome is unknown still holds its capacity, so the ceiling is lower
    // than "paid minus refunded" until reconciliation resolves it.
    if (order.paidPaise - order.refundedPaise - order.refundReservedPaise <= 0) {
      return 'A refund on this order is awaiting verification with the provider; its amount is held until that is resolved';
    }

    const captured = await paymentRepository.capturedFor(order.id);
    if (!captured) return 'This order has no captured payment to refund against';

    return null;
  },

  /**
   * Records a refund and freezes its amount. Money does NOT move here.
   *
   * Splitting request from execution is what makes approval meaningful: the figures an approver
   * sees are the figures that will be paid, because they were computed once and stored.
   */
  async request(orderNumber: string, input: RefundRequestInput, actor: Actor) {
    const order = await orderRepository.findByNumber(orderNumber);
    if (!order) throw AppError.notFound('Order not found');

    const blocked = await this.blockedReason(order);
    if (blocked) throw new AppError(422, 'REFUND_NOT_POSSIBLE', blocked);

    const captured = await paymentRepository.capturedFor(order.id);
    if (!captured) throw new AppError(422, 'REFUND_NOT_POSSIBLE', 'No captured payment');

    let computation: RefundComputation;
    try {
      computation = calculateRefund(toRefundContext(order), input.lines, {
        ...(input.includeShipping === undefined ? {} : { includeShipping: input.includeShipping }),
      });
    } catch (error) {
      if (error instanceof RefundCalculationError) {
        throw new AppError(422, error.code, error.message, error.details);
      }
      throw error;
    }

    const sequence = (await refundRepository.countForOrder(order.id)) + 1;
    const refundNumber = `${order.orderNumber}/R${String(sequence).padStart(2, '0')}`;

    const refund = await prisma.refund.create({
      data: {
        orderId: order.id,
        paymentId: captured.id,
        refundNumber,
        // Frozen here. Execution reads this and never recomputes.
        amountPaise: computation.totalPaise,
        status: 'REQUESTED',
        reason: input.reason,
        reasonNote: input.note ?? null,
        isFullRefund: computation.isFullRefund,
        requestedByType: actor.actorType,
        requestedById: actor.actorId ?? null,
        restockRequested: input.restock,
        clientReference: refundNumber,
        items: {
          create: computation.lines.map((line) => ({
            orderItemId: line.orderItemId,
            qty: line.qty,
            amountPaise: line.amountPaise,
            taxPaise: line.taxPaise,
          })),
        },
      },
      include: { items: true },
    });

    logger.info(
      { refundNumber, orderNumber, amountPaise: computation.totalPaise },
      'refund requested',
    );

    return refund;
  },

  async approve(refundId: string, actor: Actor) {
    const refund = await refundRepository.findById(refundId);
    if (!refund) throw AppError.notFound('Refund not found');

    if (refund.status === 'APPROVED') return refund;

    // H4 - no route may walk an unverified refund back into an executable state.
    if (refund.status === 'PENDING_VERIFICATION') {
      throw new AppError(
        403,
        'REFUND_AWAITING_VERIFICATION',
        'This refund is awaiting verification with the provider and cannot be acted on',
        { refundNumber: refund.refundNumber },
      );
    }

    if (refund.status !== 'REQUESTED') {
      throw new AppError(
        409,
        'REFUND_NOT_APPROVABLE',
        `A refund in ${refund.status} cannot be approved`,
      );
    }

    return refundRepository.update(refundId, {
      status: 'APPROVED',
      approvedById: actor.actorId ?? null,
      approvedAt: new Date(),
    });
  },

  /**
   * Sends the refund to the provider and applies everything that follows from it succeeding.
   *
   * THE COMMIT POINT is the `createRefund` call. Before it, nothing has changed. After it, the money
   * is gone and the bookkeeping must complete — so the post-call work is deliberately ordered so
   * that a crash leaves recoverable state rather than a silent discrepancy.
   */
  async execute(
    refundId: string,
    options: { speed?: 'NORMAL' | 'OPTIMUM'; reverseTransfers?: boolean } = {},
    actor: Actor = { actorType: 'SYSTEM' },
  ) {
    const refund = await refundRepository.findById(refundId);
    if (!refund) throw AppError.notFound('Refund not found');

    // Already done. Returning it is the correct idempotent answer, not a second refund.
    if (refund.providerRefundId && refund.status === 'PROCESSED') return refund;

    // H4 - we do not know whether this one moved money. Nobody may touch it but reconciliation.
    if (refund.status === 'PENDING_VERIFICATION') {
      throw new AppError(
        403,
        'REFUND_AWAITING_VERIFICATION',
        'This refund is awaiting verification with the provider and cannot be acted on',
        { refundNumber: refund.refundNumber },
      );
    }

    if (refund.status !== 'APPROVED' && refund.status !== 'FAILED') {
      throw new AppError(
        409,
        'REFUND_NOT_EXECUTABLE',
        `A refund in ${refund.status} cannot be executed`,
      );
    }

    /**
     * H1 - mutual exclusion AT THE DATABASE.
     *
     * Prompt 17 runs PM2 with several workers, so an in-process guard protects nothing: two
     * workers would each hold their own. Only a conditional UPDATE can decide a winner, and the
     * null-lock predicate is what makes it a claim rather than a race.
     */
    const claimed = await refundRepository.claimForExecution(refundId, refund.status);

    if (!claimed) {
      const current = await refundRepository.findById(refundId);

      // Somebody else finished it while we waited. That is success, not a conflict.
      if (current?.status === 'PROCESSED') return current;

      throw new AppError(
        409,
        'REFUND_ALREADY_EXECUTING',
        'This refund is already being executed',
        { status: current?.status ?? 'UNKNOWN' },
      );
    }

    const order = await orderRepository.findById(refund.orderId);
    const payment = await paymentRepository.findById(refund.paymentId);

    if (!order || !payment?.providerPaymentId) {
      await refundRepository.update(refundId, { status: 'FAILED', executionLockedAt: null });
      throw new AppError(422, 'REFUND_NOT_POSSIBLE', 'The original payment cannot be located');
    }

    /**
     * H5 - ONE decision about who reverses.
     *
     * Razorpay can reverse linked-account transfers as part of the refund. Doing that AND issuing
     * our own would take the partner's money back twice, so the capability decides, once, here.
     */
    const providerReverses = paymentDriver.capabilities().reversesTransfersWithRefund;
    const wantsReversal = options.reverseTransfers !== false;

    // Planned BEFORE the provider call so a plan that cannot balance stops us from refunding at all.
    const transfers = await reversibleTransfers(order.id);
    const plan =
      wantsReversal && !providerReverses && transfers.length > 0
        ? planReversals(refund.amountPaise, transfers, 'PROPORTIONAL')
        : null;

    /**
     * H3 - persist the intent and COMMIT it before touching the provider.
     *
     * If the process dies immediately after the provider call, this is the only evidence that the
     * call was ever made. Writing it afterwards would be writing it too late.
     */
    const clientReference = refund.clientReference ?? refund.refundNumber;

    await refundRepository.update(refundId, {
      clientReference,
      reversalStrategy: providerReverses ? 'PROVIDER' : 'EXPLICIT',
    });

    if (plan) await this.recordIntendedReversals(refundId, plan);

    /**
     * H7 - CLAIM the capacity before the provider is touched.
     *
     * A check would answer "is there room now"; by the time the provider replies, seconds later,
     * another worker may have taken it. A reservation holds the room across the call, so two
     * concurrent refunds cannot both see the same money as available.
     *
     * If this throws, no provider call happens at all — which is the point.
     */
    const reservations: ReversalReservation[] = (plan?.reversals ?? [])
      .filter((entry) => entry.amountPaise > 0)
      .map((entry) => ({ transferId: entry.transferId, amountPaise: entry.amountPaise }));

    const alreadyReserved = refund.capacityReserved;

    if (!alreadyReserved) {
      try {
        await refundReservation.reserve(order.id, refund.amountPaise, reservations);
        await refundRepository.update(refundId, { capacityReserved: true });
      } catch (error) {
        // Nothing was claimed and nothing was sent. Hand the lock back so it can be retried.
        await refundRepository.update(refundId, {
          status: 'APPROVED',
          executionLockedAt: null,
        });
        throw error;
      }
    }

    /**
     * H3 - before creating anything, ask whether the provider already has it.
     *
     * This is what makes a retry after an ambiguous timeout safe: the refund we may or may not have
     * created carries a deterministic reference, so we can look for it instead of guessing.
     */
    const adopted = await this.adoptExistingRefund(
      payment.providerPaymentId,
      clientReference,
    );

    let provider = adopted;

    if (!provider) {
      try {
        provider = await paymentDriver.createRefund(payment.providerPaymentId, {
          amountPaise: refund.amountPaise,
          speed: options.speed ?? 'NORMAL',
          notes: { refundNumber: refund.refundNumber, orderNumber: order.orderNumber },
          clientReference,
          idempotencyKey: clientReference,
          // Exactly one side reverses. See H5 above.
          reverseAllTransfers: providerReverses && wantsReversal,
        });
      } catch (error) {
        return this.handleProviderFailure(
          refundId,
          refund.refundNumber,
          error,
          { orderId: order.id, amountPaise: refund.amountPaise, reservations },
        );
      }
    }

    // --- past the commit point: the money has moved ---

    await refundRepository.update(refundId, {
      providerRefundId: provider.providerRefundId,
      status: provider.status === 'processed' ? 'PROCESSED' : 'PROCESSING',
      speed: provider.speed,
      processedAt: provider.status === 'processed' ? new Date() : null,
      executionLockedAt: null,
      rawResponseJson: redactedJson(provider.raw),
    });

    // H5 - exactly one of these runs.
    if (providerReverses) {
      await this.recordProviderReversals(refundId, provider.reversals);
    } else if (plan) {
      await this.executeReversals(refundId, plan);
    }

    await this.applyToOrder(order, refundId);

    if (refund.restockRequested) await this.restock(refundId, actor);

    logger.info(
      {
        refundNumber: refund.refundNumber,
        amountPaise: refund.amountPaise,
        providerRefundId: provider.providerRefundId,
        reversalStrategy: providerReverses ? 'PROVIDER' : 'EXPLICIT',
        adopted: adopted !== null,
      },
      'refund executed',
    );

    return refundRepository.findById(refundId);
  },

  /**
   * H3 - looks for a refund the provider already holds under our deterministic reference.
   *
   * Returns it when found, so a retry adopts the original instead of creating a second one. A
   * provider that cannot search is simply not asked; those drivers must rely on their idempotency
   * key instead.
   */
  async adoptExistingRefund(providerPaymentId: string, clientReference: string) {
    if (!paymentDriver.capabilities().supportsClientReference) return null;

    try {
      const existing = await paymentDriver.fetchRefundsForPayment(providerPaymentId);
      const match = existing.find((refund) => refund.clientReference === clientReference);

      if (match) {
        logger.warn(
          { clientReference, providerRefundId: match.providerRefundId },
          'adopted an existing provider refund instead of creating a second one',
        );
      }

      return match ?? null;
    } catch (error) {
      // Not being able to look is not a reason to create a duplicate.
      logger.warn({ clientReference, err: error }, 'could not search for an existing refund');
      return null;
    }
  },

  /**
   * H4 - decides what a provider failure MEANS.
   *
   * The only genuinely dangerous outcome is UNKNOWN, and it is the one most systems mislabel:
   * a timeout looks like a failure but may have moved the money. It becomes PENDING_VERIFICATION,
   * which no user action can touch — only reconciliation, once it has asked the provider.
   */
  async handleProviderFailure(
    refundId: string,
    refundNumber: string,
    error: unknown,
    held: { orderId: string; amountPaise: number; reservations: ReversalReservation[] },
  ): Promise<never> {
    const outcome = classifyProviderError(error);
    const message = error instanceof Error ? error.message : 'unknown provider error';

    if (outcome === 'UNKNOWN') {
      /**
       * H7 - HOLD the reservation.
       *
       * Releasing would hand the capacity to the next refund, and if this one did land the
       * customer is paid twice. Holding only lowers the ceiling until reconciliation asks the
       * provider what actually happened. Same rule as the stale lock: only something that can
       * verify is allowed to decide.
       */
      await refundRepository.update(refundId, {
        status: 'PENDING_VERIFICATION',
        executionLockedAt: null,
        errorDescription: `Unverified: ${message}`.slice(0, 500),
      });

      logger.error(
        { refundNumber, err: error },
        'refund outcome UNKNOWN — capacity held, nothing applied, awaiting verification',
      );

      throw new AppError(
        502,
        'REFUND_PENDING_VERIFICATION',
        'The provider did not confirm this refund. It is held for verification and must not be retried.',
        { refundNumber },
      );
    }

    // TERMINAL and RETRYABLE both mean nothing moved, so the capacity goes straight back.
    await refundReservation.releaseAll(held.orderId, held.amountPaise, held.reservations);

    await refundRepository.update(refundId, {
      status: 'FAILED',
      failedAt: new Date(),
      executionLockedAt: null,
      capacityReserved: false,
      errorDescription: message.slice(0, 500),
    });

    logger.error(
      { refundNumber, outcome, err: error },
      'refund failed at the provider — nothing applied',
    );

    throw new AppError(
      502,
      'REFUND_PROVIDER_FAILED',
      outcome === 'RETRYABLE'
        ? 'The provider could not be reached. Nothing was charged; try again.'
        : 'The provider rejected this refund.',
      { refundNumber, outcome },
    );
  },

  /** H3 - the pre-call intent record, so a lost response still leaves evidence of what we meant. */
  async recordIntendedReversals(refundId: string, plan: ReversalPlan): Promise<void> {
    const existing = await prisma.transferReversal.count({ where: { refundId } });
    if (existing > 0) return;

    for (const reversal of plan.reversals) {
      if (!reversal.providerTransferId) continue;

      await transferReversalRepository.create({
        paymentTransferId: reversal.transferId,
        refundId,
        amountPaise: reversal.amountPaise,
        status: 'PENDING',
      });
    }
  },

  /** H5 - the provider reversed the transfers itself; we record what it did and reverse nothing. */
  async recordProviderReversals(
    refundId: string,
    reversals: { providerReversalId: string; providerTransferId: string; amountPaise: number }[],
  ): Promise<void> {
    for (const reversal of reversals) {
      const transfer = await prisma.paymentTransfer.findUnique({
        where: { providerTransferId: reversal.providerTransferId },
      });
      if (!transfer) continue;

      const existing = await prisma.transferReversal.findFirst({
        where: { refundId, paymentTransferId: transfer.id },
      });

      await prisma.$transaction([
        existing
          ? prisma.transferReversal.update({
              where: { id: existing.id },
              data: {
                providerReversalId: reversal.providerReversalId,
                amountPaise: reversal.amountPaise,
                status: 'PROCESSED',
                processedAt: new Date(),
              },
            })
          : prisma.transferReversal.create({
              data: {
                paymentTransferId: transfer.id,
                refundId,
                providerReversalId: reversal.providerReversalId,
                amountPaise: reversal.amountPaise,
                status: 'PROCESSED',
                processedAt: new Date(),
              },
            }),
        // H2 - predicated, so a reversal can never take more than the transfer holds.
        prisma.paymentTransfer.updateMany({
          where: {
            id: transfer.id,
            reversedPaise: { lte: transfer.amountPaise - reversal.amountPaise },
          },
          data: { reversedPaise: { increment: reversal.amountPaise } },
        }),
      ]);
    }
  },

  /**
   * Reverses each planned transfer.
   *
   * One partner failing must not roll back a refund the customer has already been given, so each
   * reversal is recorded independently and a failure is left for the reconciliation sweep.
   * An unreversed transfer is a debt we can chase; an un-refunded customer is a complaint.
   */
  async executeReversals(refundId: string, plan: ReversalPlan): Promise<void> {
    for (const reversal of plan.reversals) {
      if (!reversal.providerTransferId) continue;

      /**
       * The plan was made before the provider call, and a concurrent refund may have reversed some
       * of the same transfer since. So the amount is re-derived against CURRENT state rather than
       * trusted from the plan: a stale plan must not try to take money that is no longer there.
       */
      const current = await prisma.paymentTransfer.findUnique({
        where: { id: reversal.transferId },
      });
      if (!current) continue;

      const available = Math.max(current.amountPaise - current.reversedPaise, 0);
      const amountPaise = Math.min(reversal.amountPaise, available);

      // The transfer is already fully reversed by an earlier refund; this one has nothing to take.
      // The shortfall falls on the platform, which the planner already accounts for.
      if (amountPaise <= 0) {
        await prisma.transferReversal.updateMany({
          where: { refundId, paymentTransferId: reversal.transferId, status: 'PENDING' },
          data: {
            status: 'CANCELLED',
            errorDescription: 'Nothing left to reverse on this transfer',
          },
        });
        continue;
      }

      // The intent row already exists from `recordIntendedReversals`; reuse it so a retry does not
      // stack a second PENDING row against the same transfer.
      const row =
        (await prisma.transferReversal.findFirst({
          where: { refundId, paymentTransferId: reversal.transferId, status: 'PENDING' },
        })) ??
        (await transferReversalRepository.create({
          paymentTransferId: reversal.transferId,
          refundId,
          amountPaise,
          status: 'PENDING',
        }));

      try {
        const result = await paymentDriver.reverseTransfer(
          reversal.providerTransferId,
          amountPaise,
        );

        /**
         * Both writes or neither.
         *
         * H2's predicate is authoritative, and the row update can still fail (a provider that
         * returns a duplicate reversal id, say). Doing them separately once left a transfer
         * incremented with no PROCESSED row to account for it - the ledger caught it, which is
         * the entire point of having the ledger.
         */
        await prisma.$transaction(async (tx) => {
          // H7 - the reservation made before the provider call becomes settled money here.
          const confirmed = await refundReservation.confirmTransfer(
            reversal.transferId,
            amountPaise,
            tx,
          );

          if (!confirmed) {
            const applied = await tx.paymentTransfer.updateMany({
              where: {
                id: reversal.transferId,
                reversedPaise: { lte: current.amountPaise - amountPaise },
              },
              data: { reversedPaise: { increment: amountPaise } },
            });

            if (applied.count !== 1) {
              throw new TransferGuardRejection('the transfer changed underneath us');
            }
          }

          await tx.transferReversal.update({
            where: { id: row.id },
            data: {
              providerReversalId: result.providerReversalId,
              amountPaise,
              status: 'PROCESSED',
              processedAt: new Date(),
              rawResponseJson: redactedJson(result.raw),
            },
          });
        });
      } catch (error) {
        const outcome = classifyProviderError(error);
        const message = error instanceof Error ? error.message : 'unknown error';

        // H4 - the same three-way classification. An unconfirmed reversal must not be retried
        // blindly, so it is parked for reconciliation rather than marked failed.
        await prisma.transferReversal.update({
          where: { id: row.id },
          data: {
            status: outcome === 'UNKNOWN' ? 'PENDING_VERIFICATION' : 'FAILED',
            errorDescription: message.slice(0, 500),
          },
        });

        logger.error(
          { refundId, transferId: reversal.transferId, outcome, err: error },
          'transfer reversal failed — refund stands, reversal left for reconciliation',
        );
      }
    }
  },

  /**
   * Rolls the refund up onto the order and its lines, then moves the order status.
   *
   * H2 - THE OVER-REFUND GUARD IS THE WRITE ITSELF.
   *
   * A read-then-write check is only as good as the gap between the two statements, and with PM2
   * running several workers that gap is where a double refund lives. So the increment carries its
   * own predicate: the row updates only while the new total still fits inside what was paid. Losing
   * that predicate is a conflict, not a silent overwrite.
   */
  async applyToOrder(order: OrderWithDetail, refundId: string): Promise<void> {
    const refund = await refundRepository.findById(refundId);
    if (!refund) return;

    // Already settled by an earlier pass; confirming twice would double the order's refund total.
    if (refund.capacityConfirmed) return;

    /**
     * H7 - the reservation becomes settled money.
     *
     * The capacity was claimed before the provider call, so this only moves it from reserved to
     * refunded. A refund adopted by reconciliation may never have reserved, so the plain predicate
     * remains as the fallback.
     */
    const confirmed = refund.capacityReserved
      ? await refundReservation.confirmOrder(order.id, refund.amountPaise)
      : false;

    const guarded = confirmed
      ? { count: 1 }
      : await prisma.order.updateMany({
          where: {
            id: order.id,
            // Only if this refund still fits within what the customer actually paid.
            refundedPaise: { lte: order.paidPaise - refund.amountPaise },
          },
          data: { refundedPaise: { increment: refund.amountPaise }, version: { increment: 1 } },
        });

    if (guarded.count !== 1) {
      const current = await orderRepository.findById(order.id);

      logger.error(
        {
          orderId: order.id,
          refundNumber: refund.refundNumber,
          attempted: refund.amountPaise,
          alreadyRefunded: current?.refundedPaise,
          paid: current?.paidPaise,
        },
        'refund would exceed what was paid — order not updated',
      );

      throw new AppError(
        409,
        'REFUND_EXCEEDS_PAID',
        'This refund would take back more than was paid for the order',
        {
          paidPaise: current?.paidPaise ?? order.paidPaise,
          refundedPaise: current?.refundedPaise ?? order.refundedPaise,
          attemptedPaise: refund.amountPaise,
        },
      );
    }

    for (const item of refund.items) {
      const line = order.items.find((candidate) => candidate.id === item.orderItemId);
      if (!line) continue;

      // Same predicate shape per line: a line can never be refunded beyond its own total.
      const applied = await prisma.orderItem.updateMany({
        where: {
          id: item.orderItemId,
          refundedQty: { lte: line.qty - item.qty },
          refundedAmountPaise: { lte: line.lineTotalPaise - item.amountPaise },
        },
        data: {
          refundedQty: { increment: item.qty },
          refundedAmountPaise: { increment: item.amountPaise },
        },
      });

      if (applied.count !== 1) {
        logger.error(
          { orderItemId: item.orderItemId, refundNumber: refund.refundNumber },
          'refund line would exceed the order line — line not updated',
        );
      }
    }

    await refundRepository.update(refundId, { capacityConfirmed: true });

    const fresh = await orderRepository.findById(order.id);
    if (!fresh) return;

    const fullyRefunded = fresh.refundedPaise >= fresh.paidPaise;
    const target = fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED';

    if (!orderStateMachine.canTransition(fresh.status as never, target as never)) return;

    await orderStateMachine.transition(fresh, target as never, {
      note: `${refund.refundNumber} — ${refund.amountPaise} paise refunded`,
      actorType: 'SYSTEM',
      isCustomerVisible: true,
      data: { paymentStatus: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
    });
  },

  /**
   * Puts refunded units back on sale.
   *
   * OPT-IN, and `inventory.service` is the only thing that writes stock — so a restock is a normal
   * ledgered adjustment with a reason, not a quiet `stockQty` bump nobody can audit later.
   */
  async restock(refundId: string, actor: Actor): Promise<void> {
    const refund = await refundRepository.findById(refundId);
    if (!refund || refund.restockedAt) return;

    const order = await orderRepository.findById(refund.orderId);
    if (!order) return;

    const variantByItem = new Map(order.items.map((item) => [item.id, item.variantId]));

    for (const item of refund.items) {
      const variantId = variantByItem.get(item.orderItemId);
      // A made-to-order piece has no variant stock to return.
      if (!variantId) continue;

      try {
        await inventoryService.adjust(
          variantId,
          {
            delta: item.qty,
            reason: 'RETURN',
            note: `Restocked by refund ${refund.refundNumber}`,
            refType: 'Refund',
            refId: refund.id,
          },
          { actorType: actor.actorType, actorId: actor.actorId ?? null },
        );
      } catch (error) {
        // A restock failure must not unwind a completed refund.
        logger.error(
          { refundId, variantId, err: error },
          'restock failed — refund stands, stock left for manual correction',
        );
      }
    }

    await refundRepository.update(refundId, { restockedAt: new Date() });
  },

  /**
   * Applies a provider refund webhook.
   *
   * The webhook is the authority on whether a refund actually settled: `createRefund` can return
   * `pending`, and only the provider knows when that becomes `processed`.
   */
  async applyProviderStatus(
    providerRefundId: string,
    status: string,
    raw: Record<string, unknown>,
  ): Promise<void> {
    const refund = await refundRepository.findByProviderRefundId(providerRefundId);
    if (!refund) return;

    const mapped =
      status === 'processed' ? 'PROCESSED' : status === 'failed' ? 'FAILED' : 'PROCESSING';

    if (refund.status === mapped) return;

    await refundRepository.update(refund.id, {
      status: mapped,
      ...(mapped === 'PROCESSED' ? { processedAt: new Date() } : {}),
      ...(mapped === 'FAILED' ? { failedAt: new Date() } : {}),
      rawResponseJson: redactedJson(raw),
    });

    logger.info({ refundNumber: refund.refundNumber, status: mapped }, 'refund status from webhook');
  },
};
