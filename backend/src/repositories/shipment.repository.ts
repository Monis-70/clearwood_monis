import type { Prisma } from '@prisma/client';

import type {
  AdminShipmentListQuery,
  NdrListQuery,
} from '@shared/schemas/fulfilment';

import { prisma } from '../config/prisma';

import { orderBy, pageResult, skipTake, type PageResult } from './helpers';

/** R1 — the shipment side of Prompt 9B reaches Prisma only through this file. */

const withDetail = {
  items: true,
  events: { orderBy: { occurredAt: 'asc' as const } },
  ndrs: { orderBy: { raisedAt: 'desc' as const } },
} satisfies Prisma.ShipmentInclude;

export type ShipmentWithDetail = Prisma.ShipmentGetPayload<{ include: typeof withDetail }>;

const SHIPMENT_SORTABLE = ['createdAt', 'shippedAt', 'deliveredAt', 'shipmentNumber'] as const;

export const shipmentRepository = {
  findById(id: string): Promise<ShipmentWithDetail | null> {
    return prisma.shipment.findUnique({ where: { id }, include: withDetail });
  },

  findByNumber(shipmentNumber: string): Promise<ShipmentWithDetail | null> {
    return prisma.shipment.findUnique({ where: { shipmentNumber }, include: withDetail });
  },

  findByAwb(awbNumber: string): Promise<ShipmentWithDetail | null> {
    return prisma.shipment.findFirst({ where: { awbNumber }, include: withDetail });
  },

  /**
   * How an inbound webhook finds its shipment.
   *
   * Providers are inconsistent about which identifier they echo, so all three are tried in
   * descending order of reliability. A webhook that matches nothing is still persisted as an event
   * — it is evidence, not noise — but it cannot be allowed to touch the wrong shipment.
   */
  findByProviderRef(
    providerCode: string,
    ref: { providerShipmentId?: string | null; awbNumber?: string | null; referenceNumber?: string | null },
  ): Promise<ShipmentWithDetail | null> {
    const clauses: Prisma.ShipmentWhereInput[] = [];

    if (ref.providerShipmentId) clauses.push({ providerCode, providerShipmentId: ref.providerShipmentId });
    if (ref.awbNumber) clauses.push({ awbNumber: ref.awbNumber });
    if (ref.referenceNumber) clauses.push({ shipmentNumber: ref.referenceNumber });

    if (clauses.length === 0) return Promise.resolve(null);

    return prisma.shipment.findFirst({ where: { OR: clauses }, include: withDetail });
  },

  listForOrder(orderId: string): Promise<ShipmentWithDetail[]> {
    return prisma.shipment.findMany({
      where: { orderId },
      include: withDetail,
      orderBy: { createdAt: 'asc' },
    });
  },

  create(
    data: Prisma.ShipmentCreateInput,
    tx: Prisma.TransactionClient = prisma,
  ): Promise<ShipmentWithDetail> {
    return tx.shipment.create({ data, include: withDetail }) as Promise<ShipmentWithDetail>;
  },

  update(
    id: string,
    data: Prisma.ShipmentUpdateInput,
    tx: Prisma.TransactionClient = prisma,
  ): Promise<ShipmentWithDetail> {
    return tx.shipment.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
      include: withDetail,
    }) as Promise<ShipmentWithDetail>;
  },

  /** Compare-and-set on status: the loser of a race sees zero rows and reloads. */
  async transitionStatus(
    id: string,
    fromStatus: string,
    data: Prisma.ShipmentUpdateManyMutationInput,
  ): Promise<boolean> {
    const { count } = await prisma.shipment.updateMany({
      where: { id, status: fromStatus },
      data: { ...data, version: { increment: 1 } },
    });
    return count === 1;
  },

  /**
   * How much of each order line is already committed to a shipment.
   *
   * This is the entire defence against over-shipping: cancelled shipments are excluded, so their
   * quantities return to the pool, and everything else counts against the ordered quantity.
   */
  async shippedQtyByOrderItem(orderId: string): Promise<Map<string, number>> {
    const rows = await prisma.shipmentItem.groupBy({
      by: ['orderItemId'],
      where: { shipment: { orderId, status: { not: 'CANCELLED' } } },
      _sum: { qty: true },
    });

    return new Map(rows.map((row) => [row.orderItemId, row._sum.qty ?? 0]));
  },

  async listForAdmin(query: AdminShipmentListQuery): Promise<PageResult<ShipmentWithDetail>> {
    const where: Prisma.ShipmentWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.providerCode ? { providerCode: query.providerCode } : {}),
      ...(query.courier ? { providerCourierName: { contains: query.courier } } : {}),
      ...(query.awb ? { awbNumber: { contains: query.awb } } : {}),
      ...(query.orderNumber ? { order: { orderNumber: { contains: query.orderNumber } } } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
      ...(query.q
        ? {
            OR: [
              { shipmentNumber: { contains: query.q } },
              { awbNumber: { contains: query.q } },
              { order: { orderNumber: { contains: query.q } } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.shipment.findMany({
        where,
        include: withDetail,
        orderBy: orderBy(query.sort, query.order, SHIPMENT_SORTABLE, [{ createdAt: 'desc' }]),
        ...skipTake(query),
      }),
      prisma.shipment.count({ where }),
    ]);

    return pageResult(items, total, query);
  },

  /** In-flight shipments the poller should refresh, oldest sync first. */
  findStale(before: Date, limit: number): Promise<ShipmentWithDetail[]> {
    return prisma.shipment.findMany({
      where: {
        status: { in: ['AWB_ASSIGNED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'UNDELIVERED', 'RTO_INITIATED'] },
        OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: before } }],
      },
      include: withDetail,
      orderBy: { lastSyncedAt: 'asc' },
      take: limit,
    });
  },

  async countsByStatus(): Promise<{ status: string; count: number }[]> {
    const rows = await prisma.shipment.groupBy({ by: ['status'], _count: { _all: true } });
    return rows.map((row) => ({ status: row.status, count: row._count._all }));
  },
};

/* ---------------------------------------------------------------- events */

export const shipmentEventRepository = {
  /**
   * Appends a timeline entry, unless this exact provider scan is already on it.
   *
   * The unique `[shipmentId, dedupeKey]` is what makes a replayed webhook harmless: the insert
   * loses the race, we swallow P2002, and the timeline stays correct. Events without a dedupe key
   * are ours (admin actions, system transitions) and always append.
   */
  async append(
    data: Prisma.ShipmentEventUncheckedCreateInput,
    tx: Prisma.TransactionClient = prisma,
  ): Promise<{ created: boolean }> {
    try {
      await tx.shipmentEvent.create({ data });
      return { created: true };
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return { created: false };
      throw error;
    }
  },

  listFor(shipmentId: string, customerVisibleOnly = false) {
    return prisma.shipmentEvent.findMany({
      where: { shipmentId, ...(customerVisibleOnly ? { isCustomerVisible: true } : {}) },
      orderBy: { occurredAt: 'asc' },
    });
  },
};

/* ------------------------------------------------------------------- NDR */

export const ndrRepository = {
  findById(id: string) {
    return prisma.ndrRecord.findUnique({ where: { id }, include: { shipment: true } });
  },

  /** Idempotent on `[shipmentId, providerNdrId]`, so a re-polled NDR updates rather than doubles. */
  async upsertFromProvider(
    shipmentId: string,
    providerNdrId: string,
    data: Omit<Prisma.NdrRecordUncheckedCreateInput, 'shipmentId' | 'providerNdrId'>,
  ) {
    return prisma.ndrRecord.upsert({
      where: { shipmentId_providerNdrId: { shipmentId, providerNdrId } },
      create: { ...data, shipmentId, providerNdrId },
      update: { attemptCount: data.attemptCount ?? 1, reason: data.reason },
    });
  },

  create(data: Prisma.NdrRecordUncheckedCreateInput, tx: Prisma.TransactionClient = prisma) {
    return tx.ndrRecord.create({ data });
  },

  update(id: string, data: Prisma.NdrRecordUpdateInput) {
    return prisma.ndrRecord.update({ where: { id }, data });
  },

  openFor(shipmentId: string) {
    return prisma.ndrRecord.findFirst({
      where: { shipmentId, status: { in: ['OPEN', 'ACTION_REQUESTED'] } },
      orderBy: { raisedAt: 'desc' },
    });
  },

  async list(query: NdrListQuery) {
    const where: Prisma.NdrRecordWhereInput = query.status ? { status: query.status } : {};

    const [items, total] = await Promise.all([
      prisma.ndrRecord.findMany({
        where,
        include: { shipment: { select: { shipmentNumber: true, awbNumber: true, orderId: true } } },
        orderBy: { raisedAt: 'desc' },
        ...skipTake(query),
      }),
      prisma.ndrRecord.count({ where }),
    ]);

    return pageResult(items, total, query);
  },
};

/* -------------------------------------------------------------- providers */

const withConfigs = { configs: true } satisfies Prisma.ShippingProviderInclude;
export type ProviderWithConfigs = Prisma.ShippingProviderGetPayload<{
  include: typeof withConfigs;
}>;

export const shippingProviderRepository = {
  findByCode(code: string): Promise<ProviderWithConfigs | null> {
    return prisma.shippingProvider.findUnique({ where: { code }, include: withConfigs });
  },

  findById(id: string): Promise<ProviderWithConfigs | null> {
    return prisma.shippingProvider.findUnique({ where: { id }, include: withConfigs });
  },

  list(): Promise<ProviderWithConfigs[]> {
    return prisma.shippingProvider.findMany({ include: withConfigs, orderBy: { code: 'asc' } });
  },

  listActive(): Promise<ProviderWithConfigs[]> {
    return prisma.shippingProvider.findMany({
      where: { isActive: true },
      include: withConfigs,
      orderBy: { code: 'asc' },
    });
  },

  findDefault(): Promise<ProviderWithConfigs | null> {
    return prisma.shippingProvider.findFirst({
      where: { isActive: true, isDefault: true },
      include: withConfigs,
    });
  },

  create(data: Prisma.ShippingProviderCreateInput): Promise<ProviderWithConfigs> {
    return prisma.shippingProvider.create({
      data,
      include: withConfigs,
    }) as Promise<ProviderWithConfigs>;
  },

  update(id: string, data: Prisma.ShippingProviderUpdateInput): Promise<ProviderWithConfigs> {
    return prisma.shippingProvider.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
      include: withConfigs,
    }) as Promise<ProviderWithConfigs>;
  },

  /** Exactly one default, enforced by demoting the others in the same transaction. */
  async setDefault(id: string): Promise<void> {
    await prisma.$transaction([
      prisma.shippingProvider.updateMany({ where: { id: { not: id } }, data: { isDefault: false } }),
      prisma.shippingProvider.update({ where: { id }, data: { isDefault: true } }),
    ]);
  },

  /** Secrets are written key by key so one can be rotated without resubmitting the rest. */
  async putConfig(providerId: string, key: string, value: string, isSecret: boolean) {
    return prisma.shippingProviderConfig.upsert({
      where: { providerId_key: { providerId, key } },
      create: { providerId, key, value, isSecret },
      update: { value, isSecret },
    });
  },

  deleteConfig(providerId: string, key: string) {
    return prisma.shippingProviderConfig.deleteMany({ where: { providerId, key } });
  },

  recordHealth(id: string, healthy: boolean, error: string | null) {
    return prisma.shippingProvider.update({
      where: { id },
      data: healthy
        ? { lastHealthyAt: new Date(), lastError: null }
        : { lastErrorAt: new Date(), lastError: error },
    });
  },
};

/* -------------------------------------------------------- pickup locations */

export const pickupLocationRepository = {
  findById(id: string) {
    return prisma.pickupLocation.findUnique({ where: { id } });
  },

  findByCode(code: string) {
    return prisma.pickupLocation.findUnique({ where: { code } });
  },

  findDefault() {
    return prisma.pickupLocation.findFirst({ where: { isActive: true, isDefault: true } });
  },

  list(activeOnly = false) {
    return prisma.pickupLocation.findMany({
      where: activeOnly ? { isActive: true } : {},
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  },

  create(data: Prisma.PickupLocationUncheckedCreateInput) {
    return prisma.pickupLocation.create({ data });
  },

  update(id: string, data: Prisma.PickupLocationUpdateInput) {
    return prisma.pickupLocation.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
    });
  },

  async setDefault(id: string): Promise<void> {
    await prisma.$transaction([
      prisma.pickupLocation.updateMany({ where: { id: { not: id } }, data: { isDefault: false } }),
      prisma.pickupLocation.update({ where: { id }, data: { isDefault: true } }),
    ]);
  },
};

/* ----------------------------------------------------- provider operations */

export const providerOperationRepository = {
  findByKey(idempotencyKey: string) {
    return prisma.providerOperation.findUnique({ where: { idempotencyKey } });
  },

  /**
   * Claims an operation key.
   *
   * Returns null when the key already exists — which is the signal that this exact provider call
   * has already been attempted and must be reconciled rather than repeated. Creating a second
   * shipment at the courier is not an error we can refund our way out of.
   */
  async claim(data: Prisma.ProviderOperationUncheckedCreateInput) {
    try {
      return await prisma.providerOperation.create({ data });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return null;
      throw error;
    }
  },

  finish(
    id: string,
    status: string,
    detail: { failureKind?: string | null; errorMessage?: string | null; responseJson?: string | null } = {},
  ) {
    return prisma.providerOperation.update({
      where: { id },
      data: {
        status,
        finishedAt: new Date(),
        failureKind: detail.failureKind ?? null,
        errorMessage: detail.errorMessage ?? null,
        responseJson: detail.responseJson ?? null,
      },
    });
  },

  bumpAttempt(id: string) {
    return prisma.providerOperation.update({
      where: { id },
      data: { attempt: { increment: 1 }, status: 'RETRYING' },
    });
  },

  listFor(entityType: string, entityId: string) {
    return prisma.providerOperation.findMany({
      where: { entityType, entityId },
      orderBy: { startedAt: 'desc' },
    });
  },

  /** Operations that started and never finished — the reconciliation sweep's input. */
  findUnfinished(before: Date, limit: number) {
    return prisma.providerOperation.findMany({
      where: { status: { in: ['PENDING', 'RETRYING'] }, startedAt: { lt: before } },
      orderBy: { startedAt: 'asc' },
      take: limit,
    });
  },
};
