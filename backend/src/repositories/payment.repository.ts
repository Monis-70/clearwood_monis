import type { Prisma } from '@prisma/client';

import type { SplitRuleListQuery, WebhookListQuery } from '@shared/schemas/order';

import { prisma } from '../config/prisma';

import { orderBy, pageResult, skipTake, type PageResult } from './helpers';

/** R1 — the payment ledger reaches Prisma only through this file. */

export const paymentRepository = {
  findById(id: string) {
    return prisma.payment.findUnique({ where: { id }, include: { transfers: true } });
  },

  findByProviderPaymentId(provider: string, providerPaymentId: string) {
    return prisma.payment.findUnique({
      where: { provider_providerPaymentId: { provider, providerPaymentId } },
      include: { transfers: true },
    });
  },

  findByProviderOrderId(providerOrderId: string) {
    return prisma.payment.findFirst({
      where: { providerOrderId },
      include: { transfers: true },
      orderBy: { attemptNumber: 'desc' },
    });
  },

  forOrder(orderId: string) {
    return prisma.payment.findMany({
      where: { orderId },
      include: { transfers: true },
      orderBy: { attemptNumber: 'asc' },
    });
  },

  /** The single CAPTURED payment for an order, if there is one. */
  capturedFor(orderId: string) {
    return prisma.payment.findFirst({
      where: { orderId, status: 'CAPTURED' },
      include: { transfers: true },
    });
  },

  countAttempts(orderId: string) {
    return prisma.payment.count({ where: { orderId } });
  },

  create(data: Prisma.PaymentUncheckedCreateInput, tx: Prisma.TransactionClient = prisma) {
    return tx.payment.create({ data });
  },

  update(id: string, data: Prisma.PaymentUpdateInput) {
    return prisma.payment.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
      include: { transfers: true },
    });
  },

  /**
   * Compare-and-set into CAPTURED. This is what makes "at most one CAPTURED payment per order"
   * hold under a webhook and a verify call arriving at the same moment: the second one matches
   * zero rows and is told the work is already done.
   */
  async markCaptured(id: string, data: Prisma.PaymentUpdateManyMutationInput): Promise<boolean> {
    const { count } = await prisma.payment.updateMany({
      where: { id, status: { in: ['PENDING', 'AUTHORIZED'] } },
      data: { ...data, status: 'CAPTURED', capturedAt: new Date(), version: { increment: 1 } },
    });
    return count === 1;
  },

  capturedWithoutTransfers() {
    return prisma.payment.findMany({
      where: { status: 'CAPTURED', isTransferable: true, transfers: { none: {} } },
      select: { id: true, orderId: true, capturedPaise: true },
    });
  },
};

export const paymentTransferRepository = {
  create(data: Prisma.PaymentTransferUncheckedCreateInput) {
    return prisma.paymentTransfer.create({ data });
  },

  update(id: string, data: Prisma.PaymentTransferUpdateInput) {
    return prisma.paymentTransfer.update({ where: { id }, data });
  },

  findByProviderTransferId(providerTransferId: string) {
    return prisma.paymentTransfer.findUnique({ where: { providerTransferId } });
  },

  forPayment(paymentId: string) {
    return prisma.paymentTransfer.findMany({
      where: { paymentId },
      include: { account: true },
      orderBy: { createdAt: 'asc' },
    });
  },

  forOrder(orderId: string) {
    return prisma.paymentTransfer.findMany({
      where: { payment: { orderId } },
      include: { account: true },
      orderBy: { createdAt: 'asc' },
    });
  },

  failedForOrder(orderId: string) {
    return prisma.paymentTransfer.count({
      where: { payment: { orderId }, status: 'FAILED' },
    });
  },

  sumForPayment(paymentId: string) {
    return prisma.paymentTransfer.aggregate({
      where: { paymentId, status: { not: 'FAILED' } },
      _sum: { amountPaise: true },
    });
  },
};

export const splitAccountRepository = {
  list(activeOnly = false) {
    return prisma.splitAccount.findMany({
      where: activeOnly ? { isActive: true } : {},
      orderBy: [{ isPrimary: 'desc' }, { key: 'asc' }],
    });
  },

  findByKey(key: string) {
    return prisma.splitAccount.findUnique({ where: { key } });
  },

  findById(id: string) {
    return prisma.splitAccount.findUnique({ where: { id } });
  },

  create(data: Prisma.SplitAccountUncheckedCreateInput) {
    return prisma.splitAccount.create({ data });
  },

  update(id: string, data: Prisma.SplitAccountUpdateInput) {
    return prisma.splitAccount.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
    });
  },

  /** Only one account may be primary; demoting the others is part of the same write. */
  async setPrimary(id: string): Promise<void> {
    await prisma.$transaction([
      prisma.splitAccount.updateMany({
        where: { isPrimary: true, id: { not: id } },
        data: { isPrimary: false },
      }),
      prisma.splitAccount.update({ where: { id }, data: { isPrimary: true } }),
    ]);
  },

  countActive() {
    return prisma.splitAccount.count({ where: { isActive: true } });
  },
};

export const splitRuleRepository = {
  findById(id: string) {
    return prisma.splitRule.findUnique({ where: { id } });
  },

  findByCode(code: string) {
    return prisma.splitRule.findUnique({ where: { code } });
  },

  /** Everything currently in force, in evaluation order. The engine does the final ordering. */
  activeAt(now: Date) {
    return prisma.splitRule.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        ],
      },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
  },

  async list(query: SplitRuleListQuery): Promise<PageResult<Prisma.SplitRuleGetPayload<object>>> {
    const where: Prisma.SplitRuleWhereInput = {
      ...(query.scope ? { scope: query.scope } : {}),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
    };

    const [items, total] = await Promise.all([
      prisma.splitRule.findMany({
        where,
        orderBy: orderBy(query.sort, query.order, ['priority', 'code', 'createdAt'] as const, [
          { priority: 'asc' },
        ]),
        ...skipTake(query),
      }),
      prisma.splitRule.count({ where }),
    ]);

    return pageResult(items, total, query);
  },

  create(data: Prisma.SplitRuleUncheckedCreateInput) {
    return prisma.splitRule.create({ data });
  },

  update(id: string, data: Prisma.SplitRuleUpdateInput) {
    return prisma.splitRule.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
    });
  },

  remove(id: string) {
    return prisma.splitRule.delete({ where: { id } });
  },

  /** At most one active REMAINDER rule may exist per scope chain. */
  countActiveRemainders(excludeId?: string) {
    return prisma.splitRule.count({
      where: {
        mode: 'REMAINDER',
        isActive: true,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
  },
};

export const splitAllocationRepository = {
  createMany(
    rows: Prisma.SplitAllocationUncheckedCreateInput[],
    tx: Prisma.TransactionClient = prisma,
  ) {
    return tx.splitAllocation.createMany({ data: rows });
  },

  forOrder(orderId: string) {
    return prisma.splitAllocation.findMany({
      where: { orderId },
      include: { account: true, rule: true },
      orderBy: { sequence: 'asc' },
    });
  },

  attachPayment(orderId: string, paymentId: string) {
    return prisma.splitAllocation.updateMany({
      where: { orderId, paymentId: null },
      data: { paymentId },
    });
  },

  sumForOrder(orderId: string) {
    return prisma.splitAllocation.aggregate({
      where: { orderId },
      _sum: { amountPaise: true },
    });
  },

  deleteForOrder(orderId: string, tx: Prisma.TransactionClient = prisma) {
    return tx.splitAllocation.deleteMany({ where: { orderId } });
  },
};

export const refundRepository = {
  create(data: Prisma.RefundUncheckedCreateInput) {
    return prisma.refund.create({ data });
  },
  update(id: string, data: Prisma.RefundUpdateInput) {
    return prisma.refund.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
    });
  },

  findById(id: string) {
    return prisma.refund.findUnique({ where: { id }, include: { items: true } });
  },

  /** Compare-and-set on status: two admins executing the same refund produce one provider call. */
  async transitionStatus(
    id: string,
    fromStatus: string,
    data: Prisma.RefundUpdateManyMutationInput,
  ): Promise<boolean> {
    const { count } = await prisma.refund.updateMany({
      where: { id, status: fromStatus },
      data: { ...data, version: { increment: 1 } },
    });
    return count === 1;
  },

  /**
   * H1 - the execution claim.
   *
   * A single conditional UPDATE decides the winner across every PM2 worker. The `executionLockedAt:
   * null` predicate is what makes it a claim: a refund already being executed has a lock, so the
   * second caller's WHERE matches nothing and it is told so.
   */
  async claimForExecution(id: string, fromStatus: string): Promise<boolean> {
    const { count } = await prisma.refund.updateMany({
      where: { id, status: fromStatus, executionLockedAt: null },
      data: {
        status: 'PROCESSING',
        executionLockedAt: new Date(),
        executionAttempt: { increment: 1 },
        version: { increment: 1 },
      },
    });
    return count === 1;
  },

  /**
   * Refunds that only reconciliation may resolve.
   *
   * Two populations: anything held for verification (we do not know whether it moved money), and
   * anything left PROCESSING by a worker that died holding the lock. A user action must never
   * touch either, which is why this lives here and not behind a route.
   */
  async reclaimStaleLocks(olderThan: Date) {
    return prisma.refund.findMany({
      where: {
        OR: [
          { status: 'PENDING_VERIFICATION' },
          { status: 'PROCESSING', executionLockedAt: { lt: olderThan } },
        ],
      },
      orderBy: { updatedAt: 'asc' },
    });
  },

  /** H6 - refunds an operator has to look at, because no automated path can resolve them. */
  needsAttention(olderThan: Date) {
    return prisma.refund.findMany({
      where: {
        OR: [
          { status: 'PENDING_VERIFICATION' },
          { status: 'PROCESSING', executionLockedAt: { lt: olderThan } },
          { status: 'FAILED' },
        ],
      },
      include: { order: { select: { orderNumber: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
  },

  findByProviderRefundId(providerRefundId: string) {
    return prisma.refund.findUnique({ where: { providerRefundId } });
  },

  forOrder(orderId: string) {
    return prisma.refund.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
  },

  countForOrder(orderId: string) {
    return prisma.refund.count({ where: { orderId } });
  },

  sumProcessed(orderId: string) {
    return prisma.refund.aggregate({
      where: { orderId, status: 'PROCESSED' },
      _sum: { amountPaise: true },
    });
  },
};

export const webhookEventRepository = {
  findByProviderEventId(provider: string, providerEventId: string) {
    return prisma.webhookEvent.findUnique({
      where: { provider_providerEventId: { provider, providerEventId } },
    });
  },

  findById(id: string) {
    return prisma.webhookEvent.findUnique({ where: { id } });
  },

  create(data: Prisma.WebhookEventUncheckedCreateInput) {
    return prisma.webhookEvent.create({ data });
  },

  update(id: string, data: Prisma.WebhookEventUpdateInput) {
    return prisma.webhookEvent.update({ where: { id }, data });
  },

  /**
   * Takes the processing lock. Only the caller that flips RECEIVED/FAILED -> PROCESSING gets to
   * act; concurrent deliveries of the same event see zero rows and stop.
   */
  async claim(id: string): Promise<boolean> {
    const { count } = await prisma.webhookEvent.updateMany({
      where: { id, status: { in: ['RECEIVED', 'FAILED'] }, processingLockedAt: null },
      data: { status: 'PROCESSING', processingLockedAt: new Date(), attempts: { increment: 1 } },
    });
    return count === 1;
  },

  release(id: string, status: string, errorMessage?: string | null) {
    return prisma.webhookEvent.update({
      where: { id },
      data: {
        status,
        processingLockedAt: null,
        processedAt: status === 'PROCESSED' ? new Date() : null,
        errorMessage: errorMessage ?? null,
      },
    });
  },

  async list(query: WebhookListQuery) {
    const where: Prisma.WebhookEventWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.eventType ? { eventType: query.eventType } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.webhookEvent.findMany({
        where,
        orderBy: [{ receivedAt: 'desc' }],
        ...skipTake(query),
      }),
      prisma.webhookEvent.count({ where }),
    ]);

    return pageResult(items, total, query);
  },
};

export const settlementRepository = {
  upsert(data: Prisma.SettlementUncheckedCreateInput) {
    return prisma.settlement.upsert({
      where: { providerSettlementId: data.providerSettlementId },
      update: { status: data.status, settledAt: data.settledAt, utr: data.utr },
      create: data,
    });
  },

  addEntry(data: Prisma.SettlementEntryUncheckedCreateInput) {
    return prisma.settlementEntry.create({ data });
  },
};

export const transferReversalRepository = {
  create(data: Prisma.TransferReversalUncheckedCreateInput) {
    return prisma.transferReversal.create({ data });
  },

  forTransfer(paymentTransferId: string) {
    return prisma.transferReversal.findMany({ where: { paymentTransferId } });
  },
};

/**
 * Everything the split matcher needs to decide which rules touch which lines.
 *
 * Categories are returned WITH THEIR ANCESTORS, resolved from the materialised path, so a rule
 * scoped to "Sofas" also matches a line that only lists "Fabric Sofas".
 */
export interface ProductSplitFacts {
  productId: string;
  brandId: string | null;
  categoryIds: string[];
  collectionIds: string[];
}

export const splitFactsRepository = {
  async forProducts(productIds: string[]): Promise<ProductSplitFacts[]> {
    if (productIds.length === 0) return [];

    const [products, categoryLinks, collectionLinks] = await Promise.all([
      prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, brandId: true },
      }),
      prisma.productCategory.findMany({
        where: { productId: { in: productIds } },
        select: { productId: true, category: { select: { id: true, path: true } } },
      }),
      prisma.collectionProduct.findMany({
        where: { productId: { in: productIds } },
        select: { productId: true, collectionId: true },
      }),
    ]);

    const ancestorSlugs = new Set<string>();
    for (const link of categoryLinks) {
      for (const slug of link.category.path.split('/')) if (slug) ancestorSlugs.add(slug);
    }

    const ancestors = await prisma.category.findMany({
      where: { slug: { in: [...ancestorSlugs] } },
      select: { id: true, slug: true },
    });
    const idBySlug = new Map(ancestors.map((row) => [row.slug, row.id]));

    return products.map((product) => {
      const categoryIds = new Set<string>();

      for (const link of categoryLinks.filter((entry) => entry.productId === product.id)) {
        categoryIds.add(link.category.id);
        for (const slug of link.category.path.split('/')) {
          const id = idBySlug.get(slug);
          if (id) categoryIds.add(id);
        }
      }

      return {
        productId: product.id,
        brandId: product.brandId,
        categoryIds: [...categoryIds],
        collectionIds: collectionLinks
          .filter((entry) => entry.productId === product.id)
          .map((entry) => entry.collectionId),
      };
    });
  },
};
