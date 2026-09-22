import type { Prisma } from '@prisma/client';

import type { AdminReturnListQuery } from '@shared/schemas/fulfilment';

import { prisma } from '../config/prisma';

import { orderBy, pageResult, skipTake, type PageResult } from './helpers';

/** R1 — the returns side of Prompt 9B reaches Prisma only through this file. */

const withDetail = {
  items: true,
  shipments: true,
} satisfies Prisma.ReturnRequestInclude;

export type ReturnWithDetail = Prisma.ReturnRequestGetPayload<{ include: typeof withDetail }>;

const RETURN_SORTABLE = ['createdAt', 'returnNumber', 'requestedAmountPaise'] as const;

export const returnRepository = {
  findById(id: string): Promise<ReturnWithDetail | null> {
    return prisma.returnRequest.findUnique({ where: { id }, include: withDetail });
  },

  findByNumber(returnNumber: string): Promise<ReturnWithDetail | null> {
    return prisma.returnRequest.findUnique({ where: { returnNumber }, include: withDetail });
  },

  listForOrder(orderId: string): Promise<ReturnWithDetail[]> {
    return prisma.returnRequest.findMany({
      where: { orderId },
      include: withDetail,
      orderBy: { createdAt: 'desc' },
    });
  },

  listForCustomer(customerId: string, query: { page: number; limit: number }) {
    return prisma.returnRequest.findMany({
      where: { customerId },
      include: withDetail,
      orderBy: { createdAt: 'desc' },
      ...skipTake(query),
    });
  },

  create(
    data: Prisma.ReturnRequestCreateInput,
    tx: Prisma.TransactionClient = prisma,
  ): Promise<ReturnWithDetail> {
    return tx.returnRequest.create({ data, include: withDetail }) as Promise<ReturnWithDetail>;
  },

  update(
    id: string,
    data: Prisma.ReturnRequestUpdateInput,
    tx: Prisma.TransactionClient = prisma,
  ): Promise<ReturnWithDetail> {
    return tx.returnRequest.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
      include: withDetail,
    }) as Promise<ReturnWithDetail>;
  },

  /** Compare-and-set on status, so two admins cannot both approve the same return. */
  async transitionStatus(
    id: string,
    fromStatus: string,
    data: Prisma.ReturnRequestUpdateManyMutationInput,
  ): Promise<boolean> {
    const { count } = await prisma.returnRequest.updateMany({
      where: { id, status: fromStatus },
      data: { ...data, version: { increment: 1 } },
    });
    return count === 1;
  },

  updateItem(
    id: string,
    data: Prisma.ReturnItemUpdateInput,
    tx: Prisma.TransactionClient = prisma,
  ) {
    return tx.returnItem.update({ where: { id }, data });
  },

  /**
   * How much of each order line is already spoken for by a return.
   *
   * Rejected and cancelled requests are excluded so their quantities go back into the pool;
   * everything else counts, which is what stops a customer returning the same sofa twice.
   */
  async returnedQtyByOrderItem(orderId: string): Promise<Map<string, number>> {
    const rows = await prisma.returnItem.groupBy({
      by: ['orderItemId'],
      where: {
        returnRequest: { orderId, status: { notIn: ['REJECTED', 'CANCELLED'] } },
      },
      _sum: { qtyRequested: true },
    });

    return new Map(rows.map((row) => [row.orderItemId, row._sum.qtyRequested ?? 0]));
  },

  async listForAdmin(query: AdminReturnListQuery): Promise<PageResult<ReturnWithDetail>> {
    const where: Prisma.ReturnRequestWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.reason ? { reason: query.reason } : {}),
      ...(query.orderNumber ? { order: { orderNumber: { contains: query.orderNumber } } } : {}),
      ...(query.q
        ? {
            OR: [
              { returnNumber: { contains: query.q } },
              { order: { orderNumber: { contains: query.q } } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.returnRequest.findMany({
        where,
        include: withDetail,
        orderBy: orderBy(query.sort, query.order, RETURN_SORTABLE, [{ createdAt: 'desc' }]),
        ...skipTake(query),
      }),
      prisma.returnRequest.count({ where }),
    ]);

    return pageResult(items, total, query);
  },

  async countsByStatus(): Promise<{ status: string; count: number }[]> {
    const rows = await prisma.returnRequest.groupBy({ by: ['status'], _count: { _all: true } });
    return rows.map((row) => ({ status: row.status, count: row._count._all }));
  },
};
