import { createHash } from 'node:crypto';

import type { Prisma, SplitRule as SplitRuleRow } from '@prisma/client';
import type { SplitBasis, SplitMode, SplitScope } from '@shared/enums';
import type { SplitAllocationDto, SplitPreviewDto } from '@shared/types/order';

import { env, splitEnabled, splitOnHoldByDefault } from '../../../config/env';
import { logger } from '../../../config/logger';
import { payment as paymentDriver } from '../../../container';
import type { OrderWithDetail } from '../../../repositories/order.repository';
import {
  paymentTransferRepository,
  splitAccountRepository,
  splitAllocationRepository,
  splitFactsRepository,
  splitRuleRepository,
} from '../../../repositories/payment.repository';
import { AppError } from '../../../utils/AppError';

import {
  computeSplit,
  SplitInvariantError,
  type ComputedAllocation,
  type SplitAccountInput,
  type SplitOrderContext,
  type SplitOrderLine,
  type SplitRuleInput,
} from './split.engine';

/**
 * The split, persisted.
 *
 * ORDER OF OPERATIONS MATTERS: allocations are computed and WRITTEN BEFORE the provider is called.
 * If the transfer API then fails, the intent is still on record and an admin can retry it — which
 * is the difference between "we owe the partner ₹1,000 and here is the row proving it" and a
 * silent loss.
 *
 * A transfer failure never rolls back a capture. The customer's money arrived; unwinding it because
 * a payout leg failed would be strictly worse for everyone. The transfer is marked FAILED, the
 * order stays CONFIRMED, and `/admin/orders/:id/retry-transfers` fixes it.
 */

function toRuleInput(row: SplitRuleRow): SplitRuleInput {
  return {
    id: row.id,
    code: row.code,
    scope: row.scope as SplitScope,
    scopeEntityId: row.scopeEntityId,
    basis: row.basis as SplitBasis,
    mode: row.mode as SplitMode,
    valuePaise: row.valuePaise,
    valueBp: row.valueBp,
    recipientKey: row.recipientKey,
    priority: row.priority,
    minOrderPaise: row.minOrderPaise,
    maxTransferPaise: row.maxTransferPaise,
    onHold: row.onHold || splitOnHoldByDefault,
    onHoldUntil: row.onHoldUntil,
  };
}

export const splitService = {
  async accounts(): Promise<SplitAccountInput[]> {
    const rows = await splitAccountRepository.list();
    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      providerAccountId: row.providerAccountId,
      isPrimary: row.isPrimary,
      isActive: row.isActive,
    }));
  },

  async rules(now = new Date()): Promise<SplitRuleInput[]> {
    return (await splitRuleRepository.activeAt(now)).map(toRuleInput);
  },

  /** Turns a persisted order into the pure engine's fixture shape. */
  async contextFor(order: OrderWithDetail): Promise<SplitOrderContext> {
    const facts = await splitFactsRepository.forProducts(order.items.map((item) => item.productId));
    const factsByProduct = new Map(facts.map((entry) => [entry.productId, entry]));

    const lines: SplitOrderLine[] = order.items.map((item) => {
      const fact = factsByProduct.get(item.productId);
      return {
        orderItemId: item.id,
        productId: item.productId,
        categoryIds: fact?.categoryIds ?? [],
        collectionIds: fact?.collectionIds ?? [],
        brandId: fact?.brandId ?? null,
        lineSubtotalPaise: item.lineSubtotalPaise,
        lineTotalPaise: item.lineTotalPaise,
      };
    });

    return {
      orderId: order.id,
      subtotalPaise: order.subtotalPaise,
      grandTotalPaise: order.grandTotalPaise,
      lines,
    };
  },

  /** Read-only: what WOULD be allocated. Used by the admin simulator and by the tests. */
  async preview(order: OrderWithDetail, transferablePaise?: number): Promise<SplitPreviewDto> {
    const [rules, accounts] = await Promise.all([this.rules(), this.accounts()]);
    const context = await this.contextFor(order);
    const amount = transferablePaise ?? order.grandTotalPaise;

    const computed = computeSplit(context, amount, rules, accounts);
    return this.toPreviewDto(computed);
  },

  /** The admin simulator: an arbitrary amount against a synthetic single-line order. */
  async simulate(amountPaise: number, sample?: OrderWithDetail): Promise<SplitPreviewDto> {
    const [rules, accounts] = await Promise.all([this.rules(), this.accounts()]);

    const context: SplitOrderContext = sample
      ? { ...(await this.contextFor(sample)), grandTotalPaise: amountPaise }
      : {
          orderId: 'simulated',
          subtotalPaise: amountPaise,
          grandTotalPaise: amountPaise,
          lines: [],
        };

    return this.toPreviewDto(computeSplit(context, amountPaise, rules, accounts));
  },

  toPreviewDto(computed: ReturnType<typeof computeSplit>): SplitPreviewDto {
    return {
      transferablePaise: computed.transferablePaise,
      allocatedPaise: computed.allocatedPaise,
      rulesApplied: computed.rulesApplied,
      allocations: computed.allocations.map((allocation) => this.toAllocationDto(allocation)),
    };
  },

  toAllocationDto(allocation: ComputedAllocation, id?: string): SplitAllocationDto {
    return {
      ...(id ? { id } : {}),
      splitAccountKey: allocation.accountKey,
      splitAccountName: allocation.accountName,
      providerAccountId: allocation.providerAccountId,
      splitRuleCode: allocation.ruleCode,
      orderItemId: allocation.orderItemId,
      amountPaise: allocation.amountPaise,
      basisAmountPaise: allocation.basisAmountPaise,
      mode: allocation.mode,
      sequence: allocation.sequence,
      isRemainder: allocation.isRemainder,
      note: allocation.note,
    };
  },

  /**
   * Computes the split and persists it INSIDE the order transaction, so an order can never exist
   * without its payout intent recorded alongside it.
   */
  async persistForOrder(
    order: OrderWithDetail,
    transferablePaise: number,
    tx: Prisma.TransactionClient,
  ): Promise<ComputedAllocation[]> {
    if (!splitEnabled) return [];

    const [rules, accounts] = await Promise.all([this.rules(), this.accounts()]);
    if (accounts.length === 0) return [];

    const context = await this.contextFor(order);
    const computed = computeSplit(context, transferablePaise, rules, accounts);

    const computedAtHash = createHash('sha256')
      .update(
        JSON.stringify({
          orderId: order.id,
          transferablePaise,
          allocations: computed.allocations.map((entry) => [entry.accountKey, entry.amountPaise]),
        }),
      )
      .digest('hex')
      .slice(0, 32);

    const rows: Prisma.SplitAllocationUncheckedCreateInput[] = computed.allocations.map(
      (allocation) => ({
        orderId: order.id,
        splitAccountId: allocation.accountId,
        splitRuleId: allocation.ruleId,
        orderItemId: allocation.orderItemId,
        amountPaise: allocation.amountPaise,
        basisAmountPaise: allocation.basisAmountPaise,
        mode: allocation.mode,
        sequence: allocation.sequence,
        isRemainder: allocation.isRemainder,
        note: allocation.note,
        computedAtHash,
      }),
    );

    // Zero-value rows ARE persisted: the audit trail should show a rule that matched but paid out
    // nothing, and only the transfer step drops them (providers reject zero-amount transfers).
    await splitAllocationRepository.createMany(rows, tx);

    return computed.allocations;
  },

  /**
   * Creates the provider transfers for a captured payment.
   *
   * Partial failure is expected and survivable: each transfer is recorded with whatever the
   * provider said about it, and a failure is logged loudly rather than thrown, so one bad payout
   * leg cannot unwind a good capture.
   */
  async createTransfers(
    orderId: string,
    paymentId: string,
    providerPaymentId: string,
  ): Promise<{ created: number; failed: number }> {
    if (!splitEnabled) return { created: 0, failed: 0 };
    if (!paymentDriver.capabilities().supportsSplit) return { created: 0, failed: 0 };

    await splitAllocationRepository.attachPayment(orderId, paymentId);
    const allocations = await splitAllocationRepository.forOrder(orderId);

    const payable = allocations.filter((allocation) => allocation.amountPaise > 0);
    if (payable.length === 0) return { created: 0, failed: 0 };

    const existing = await paymentTransferRepository.forPayment(paymentId);
    if (existing.length > 0) {
      // Already transferred — a replayed webhook must not pay a partner twice.
      return { created: 0, failed: existing.filter((row) => row.status === 'FAILED').length };
    }

    let results;
    try {
      results = await paymentDriver.createTransfers(
        providerPaymentId,
        payable.map((allocation) => ({
          account: allocation.account.providerAccountId,
          amountPaise: allocation.amountPaise,
          currency: 'INR',
          notes: { orderId, allocationId: allocation.id },
          onHold: splitOnHoldByDefault,
        })),
      );
    } catch (error) {
      logger.error({ err: error, orderId, paymentId }, 'split transfers could not be created');

      // Record the intent as failed so the admin sees it and retry-transfers has something to fix.
      for (const allocation of payable) {
        await paymentTransferRepository.create({
          paymentId,
          splitAllocationId: allocation.id,
          splitAccountId: allocation.splitAccountId,
          providerRecipientId: allocation.account.providerAccountId,
          amountPaise: allocation.amountPaise,
          status: 'FAILED',
          failedAt: new Date(),
          errorCode: 'TRANSFER_REQUEST_FAILED',
          errorDescription: error instanceof Error ? error.message : 'unknown error',
        });
      }
      return { created: 0, failed: payable.length };
    }

    let created = 0;
    let failed = 0;

    for (const [index, allocation] of payable.entries()) {
      const result = results[index];
      if (!result) continue;

      const isFailed = result.status === 'failed';
      if (isFailed) failed += 1;
      else created += 1;

      await paymentTransferRepository.create({
        paymentId,
        splitAllocationId: allocation.id,
        splitAccountId: allocation.splitAccountId,
        providerTransferId: result.providerTransferId,
        providerRecipientId: result.providerRecipientId || allocation.account.providerAccountId,
        amountPaise: result.amountPaise,
        feePaise: result.feePaise,
        taxPaise: result.taxPaise,
        status: isFailed ? 'FAILED' : 'PROCESSED',
        onHold: result.onHold,
        settlementStatus: result.settlementStatus,
        processedAt: isFailed ? null : new Date(),
        failedAt: isFailed ? new Date() : null,
        errorCode: result.errorCode,
        errorDescription: result.errorDescription,
      });
    }

    if (failed > 0) {
      logger.error(
        { orderId, paymentId, failed, created },
        'some split transfers failed — the capture stands and needs an admin retry',
      );
    }

    return { created, failed };
  },

  /** Retries only the FAILED legs. Successful transfers are never touched. */
  async retryTransfers(orderId: string): Promise<{ retried: number; succeeded: number }> {
    const transfers = await paymentTransferRepository.forOrder(orderId);
    const failed = transfers.filter((transfer) => transfer.status === 'FAILED');
    if (failed.length === 0) return { retried: 0, succeeded: 0 };

    const payment = await import('../../../repositories/payment.repository').then((module) =>
      module.paymentRepository.capturedFor(orderId),
    );

    if (!payment?.providerPaymentId) {
      throw new AppError(422, 'NO_CAPTURED_PAYMENT', 'There is nothing captured to transfer from');
    }

    let succeeded = 0;

    for (const transfer of failed) {
      try {
        const [result] = await paymentDriver.createTransfers(payment.providerPaymentId, [
          {
            account: transfer.providerRecipientId,
            amountPaise: transfer.amountPaise,
            currency: 'INR',
            notes: { orderId, retryOf: transfer.id },
          },
        ]);

        if (!result || result.status === 'failed') continue;

        await paymentTransferRepository.update(transfer.id, {
          providerTransferId: result.providerTransferId,
          status: 'PROCESSED',
          processedAt: new Date(),
          settlementStatus: result.settlementStatus,
          errorCode: null,
          errorDescription: null,
        });
        succeeded += 1;
      } catch (error) {
        logger.warn({ err: error, transferId: transfer.id }, 'split transfer retry failed again');
      }
    }

    return { retried: failed.length, succeeded };
  },

  /** Guard used by the admin write paths so two REMAINDER rules can never both be active. */
  async assertSingleRemainder(mode: string, isActive: boolean, excludeId?: string): Promise<void> {
    if (mode !== 'REMAINDER' || !isActive) return;

    const existing = await splitRuleRepository.countActiveRemainders(excludeId);
    if (existing > 0) {
      throw new AppError(
        409,
        'DUPLICATE_REMAINDER_RULE',
        'Only one active REMAINDER rule is allowed — the residue can have exactly one owner',
      );
    }
  },

  isInvariantError(error: unknown): error is SplitInvariantError {
    return error instanceof SplitInvariantError;
  },

  get enabled(): boolean {
    return splitEnabled && env.SPLIT_ENABLED === 'true';
  },
};
