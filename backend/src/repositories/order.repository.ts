import type { Prisma } from '@prisma/client';

import type { AdminOrderListQuery, MyOrderListQuery } from '@shared/schemas/order';

import { prisma } from '../config/prisma';

import { orderBy, pageResult, skipTake, type PageResult } from './helpers';

/** R1 — Prompt 9A's order side reaches Prisma only through this file. */

const withDetail = {
  items: { orderBy: { position: 'asc' as const } },
  addresses: true,
  history: { orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.OrderInclude;

export type OrderWithDetail = Prisma.OrderGetPayload<{ include: typeof withDetail }>;

const ADMIN_SORTABLE = ['createdAt', 'placedAt', 'grandTotalPaise', 'orderNumber'] as const;

export const orderRepository = {
  findById(id: string): Promise<OrderWithDetail | null> {
    return prisma.order.findUnique({ where: { id }, include: withDetail });
  },

  findByNumber(orderNumber: string): Promise<OrderWithDetail | null> {
    return prisma.order.findUnique({ where: { orderNumber }, include: withDetail });
  },

  findByCartId(cartId: string): Promise<OrderWithDetail | null> {
    return prisma.order.findFirst({
      where: { cartId, status: { notIn: ['CANCELLED', 'EXPIRED', 'PAYMENT_FAILED'] } },
      include: withDetail,
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * The whole order is written in ONE transaction with its items, addresses and opening history
   * row, so a half-created order cannot exist for another request to find.
   */
  create(
    data: Prisma.OrderCreateInput,
    tx: Prisma.TransactionClient = prisma,
  ): Promise<OrderWithDetail> {
    return tx.order.create({ data, include: withDetail }) as Promise<OrderWithDetail>;
  },

  update(
    id: string,
    data: Prisma.OrderUpdateInput,
    tx: Prisma.TransactionClient = prisma,
  ): Promise<OrderWithDetail> {
    return tx.order.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
      include: withDetail,
    }) as Promise<OrderWithDetail>;
  },

  /** Compare-and-set on status: the loser of a race sees zero rows and reloads. */
  async transitionStatus(
    id: string,
    fromStatus: string,
    data: Prisma.OrderUpdateManyMutationInput,
  ): Promise<boolean> {
    const { count } = await prisma.order.updateMany({
      where: { id, status: fromStatus },
      data: { ...data, version: { increment: 1 } },
    });
    return count === 1;
  },

  recordHistory(
    entry: Prisma.OrderStatusHistoryUncheckedCreateInput,
    tx: Prisma.TransactionClient = prisma,
  ): Promise<unknown> {
    return tx.orderStatusHistory.create({ data: entry });
  },

  history(orderId: string) {
    return prisma.orderStatusHistory.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
  },

  async listForCustomer(
    customerId: string,
    query: MyOrderListQuery,
  ): Promise<PageResult<OrderWithDetail>> {
    const where: Prisma.OrderWhereInput = {
      customerId,
      // A never-paid draft is not something a shopper should see in their order history.
      status: query.status ? query.status : { notIn: ['DRAFT'] },
    };

    const [items, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: withDetail,
        orderBy: [{ createdAt: 'desc' }],
        ...skipTake(query),
      }),
      prisma.order.count({ where }),
    ]);

    return pageResult(items, total, query);
  },

  async listForAdmin(query: AdminOrderListQuery): Promise<PageResult<OrderWithDetail>> {
    const where: Prisma.OrderWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.paymentStatus ? { paymentStatus: query.paymentStatus } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.couponCode ? { couponCode: query.couponCode } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
      ...(query.amountMin !== undefined || query.amountMax !== undefined
        ? {
            grandTotalPaise: {
              ...(query.amountMin !== undefined ? { gte: query.amountMin } : {}),
              ...(query.amountMax !== undefined ? { lte: query.amountMax } : {}),
            },
          }
        : {}),
      ...(query.hasFailedTransfer
        ? { payments: { some: { transfers: { some: { status: 'FAILED' } } } } }
        : {}),
      ...(query.q
        ? {
            OR: [
              { orderNumber: { contains: query.q } },
              { guestEmail: { contains: query.q } },
              { guestPhone: { contains: query.q } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: withDetail,
        orderBy: orderBy(query.sort, query.order, ADMIN_SORTABLE, [{ createdAt: 'desc' }]),
        ...skipTake(query),
      }),
      prisma.order.count({ where }),
    ]);

    return pageResult(items, total, query);
  },

  /** Orders whose payment hold has lapsed — the sweep's input (L5). */
  findExpired(now: Date, limit: number): Promise<OrderWithDetail[]> {
    return prisma.order.findMany({
      where: { status: 'PENDING_PAYMENT', expiresAt: { lt: now } },
      include: withDetail,
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
  },

  async countsByStatus(): Promise<{ status: string; count: number }[]> {
    const rows = await prisma.order.groupBy({ by: ['status'], _count: { _all: true } });
    return rows.map((row) => ({ status: row.status, count: row._count._all }));
  },

  /** Guest tracking: the order number must be paired with a contact that is already on the order. */
  findForTracking(orderNumber: string): Promise<OrderWithDetail | null> {
    return prisma.order.findUnique({ where: { orderNumber }, include: withDetail });
  },

  itemsFor(orderId: string) {
    return prisma.orderItem.findMany({ where: { orderId }, orderBy: { position: 'asc' } });
  },

  updateItem(id: string, data: Prisma.OrderItemUpdateInput) {
    return prisma.orderItem.update({ where: { id }, data });
  },

  /**
   * Everything an OrderItem snapshots at placement. Read once, frozen forever — a later rename or
   * rebrand of the product must not rewrite what the customer bought (L2).
   */
  async productSnapshotFacts(ids: string[]) {
    if (ids.length === 0) return [];

    return prisma.product.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        sku: true,
        name: true,
        weightGrams: true,
        isMadeToOrder: true,
        leadTimeDays: true,
        brand: { select: { name: true } },
        categories: {
          where: { isPrimary: true },
          take: 1,
          select: { category: { select: { path: true } } },
        },
      },
    });
  },
};

/* ------------------------------------------------------------- sequences */

export const orderSequenceRepository = {
  /**
   * Allocates the next number for a financial year.
   *
   * Compare-and-set in a loop, exactly like inventory: read, then update WHERE lastNumber is still
   * what we read. Two concurrent checkouts cannot be handed the same number — the loser retries and
   * gets the next one.
   *
   * The retry budget is deliberately generous with a jittered backoff: under a burst of parallel
   * checkouts the losers must keep trying, because failing to allocate a number means failing a
   * sale somebody was willing to pay for.
   */
  async next(key: string, attempts = 250): Promise<number> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const existing = await prisma.orderSequence.findUnique({ where: { key } });

      if (!existing) {
        try {
          const created = await prisma.orderSequence.create({ data: { key, lastNumber: 1 } });
          return created.lastNumber;
        } catch {
          // Somebody else created it first; fall through and take the update path.
          continue;
        }
      }

      const { count } = await prisma.orderSequence.updateMany({
        where: { key, lastNumber: existing.lastNumber },
        data: { lastNumber: existing.lastNumber + 1 },
      });

      if (count === 1) return existing.lastNumber + 1;

      // Jitter so a burst of losers does not re-collide in lockstep.
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 8)));
    }

    throw new Error(`could not allocate an order number for ${key} after ${attempts} attempts`);
  },

  peek(key: string) {
    return prisma.orderSequence.findUnique({ where: { key } });
  },
};

/* ------------------------------------------------------- stock reservations */

export const stockReservationRepository = {
  createMany(
    rows: Prisma.StockReservationUncheckedCreateInput[],
    tx: Prisma.TransactionClient = prisma,
  ) {
    return tx.stockReservation.createMany({ data: rows });
  },

  forOrder(orderId: string) {
    return prisma.stockReservation.findMany({ where: { orderId } });
  },

  active(orderId: string) {
    return prisma.stockReservation.findMany({ where: { orderId, status: 'RESERVED' } });
  },

  /** Compare-and-set on status, so releasing twice is a no-op rather than a double release. */
  async settle(
    id: string,
    to: 'CONSUMED' | 'RELEASED' | 'EXPIRED',
    extra: Prisma.StockReservationUpdateManyMutationInput = {},
  ): Promise<boolean> {
    const { count } = await prisma.stockReservation.updateMany({
      where: { id, status: 'RESERVED' },
      data: {
        status: to,
        ...(to === 'CONSUMED' ? { consumedAt: new Date() } : { releasedAt: new Date() }),
        ...extra,
      },
    });
    return count === 1;
  },

  countOrphans(): Promise<number> {
    return prisma.stockReservation.count({
      where: {
        status: 'RESERVED',
        order: { status: { in: ['CANCELLED', 'EXPIRED', 'PAYMENT_FAILED', 'REFUNDED'] } },
      },
    });
  },
};

/* --------------------------------------------------------- checkout sessions */

export const checkoutSessionRepository = {
  findById(id: string) {
    return prisma.checkoutSession.findUnique({ where: { id } });
  },

  findActiveForCart(cartId: string) {
    return prisma.checkoutSession.findFirst({
      where: { cartId, status: 'ACTIVE', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
  },

  create(data: Prisma.CheckoutSessionUncheckedCreateInput) {
    return prisma.checkoutSession.create({ data });
  },

  update(id: string, data: Prisma.CheckoutSessionUpdateInput) {
    return prisma.checkoutSession.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
    });
  },

  expireStale(now: Date) {
    return prisma.checkoutSession.updateMany({
      where: { status: 'ACTIVE', expiresAt: { lt: now } },
      data: { status: 'EXPIRED' },
    });
  },
};
