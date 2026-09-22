import type { Prisma } from '@prisma/client';

import type { NotificationLogQuery } from '@shared/schemas/fulfilment';

import { prisma } from '../config/prisma';

import { pageResult, skipTake } from './helpers';

/** R1 — documents, numbering and notification logs reach Prisma only through this file. */

export const documentRepository = {
  findById(id: string) {
    return prisma.orderDocument.findUnique({ where: { id } });
  },

  findByNumber(documentNumber: string) {
    return prisma.orderDocument.findUnique({ where: { documentNumber } });
  },

  /**
   * A tax invoice is issued once and never regenerated — if the figures change, a credit note is
   * issued instead. So the existence check is the important half of this repository.
   */
  findForOrder(orderId: string, type: string) {
    return prisma.orderDocument.findFirst({
      where: { orderId, type },
      orderBy: { issuedAt: 'desc' },
    });
  },

  findForShipment(shipmentId: string, type: string) {
    return prisma.orderDocument.findFirst({
      where: { shipmentId, type },
      orderBy: { issuedAt: 'desc' },
    });
  },

  listForOrder(orderId: string, type?: string) {
    return prisma.orderDocument.findMany({
      where: { orderId, ...(type ? { type } : {}) },
      orderBy: { issuedAt: 'desc' },
    });
  },

  create(data: Prisma.OrderDocumentUncheckedCreateInput, tx: Prisma.TransactionClient = prisma) {
    return tx.orderDocument.create({ data });
  },
};

/* ------------------------------------------------------------- numbering */

export const documentSequenceRepository = {
  /**
   * Gapless per-series numbering, by compare-and-set — the same technique as OrderSequence.
   *
   * GST document numbers must not have holes and must not repeat, so this reads, then updates
   * WHERE `lastNumber` is still what was read. The loser of a race retries and takes the next one.
   */
  async next(key: string, prefix: string, attempts = 250): Promise<number> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const existing = await prisma.documentSequence.findUnique({ where: { key } });

      if (!existing) {
        try {
          const created = await prisma.documentSequence.create({
            data: { key, prefix, lastNumber: 1 },
          });
          return created.lastNumber;
        } catch {
          // Somebody created it first; fall through to the update path.
          continue;
        }
      }

      const next = existing.lastNumber + 1;
      const { count } = await prisma.documentSequence.updateMany({
        where: { key, lastNumber: existing.lastNumber },
        data: { lastNumber: next },
      });

      if (count === 1) return next;

      // Jittered backoff so a burst of concurrent invoices does not livelock.
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
    }

    throw new Error(`Could not allocate a document number for ${key}`);
  },
};

/* --------------------------------------------------------- notifications */

export const notificationRepository = {
  findTemplate(event: string, channel: string) {
    return prisma.notificationTemplate.findUnique({
      where: { event_channel: { event, channel } },
    });
  },

  listTemplates() {
    return prisma.notificationTemplate.findMany({ orderBy: [{ event: 'asc' }, { channel: 'asc' }] });
  },

  upsertTemplate(
    event: string,
    channel: string,
    data: { subject?: string | null; body: string; isActive: boolean },
  ) {
    return prisma.notificationTemplate.upsert({
      where: { event_channel: { event, channel } },
      create: { event, channel, ...data },
      update: { ...data, version: { increment: 1 } },
    });
  },

  log(data: Prisma.NotificationLogUncheckedCreateInput) {
    return prisma.notificationLog.create({ data });
  },

  markSent(id: string) {
    return prisma.notificationLog.update({
      where: { id },
      data: { status: 'SENT', sentAt: new Date() },
    });
  },

  markFailed(id: string, error: string) {
    return prisma.notificationLog.update({
      where: { id },
      data: { status: 'FAILED', error: error.slice(0, 500) },
    });
  },

  async listLogs(query: NotificationLogQuery) {
    const where: Prisma.NotificationLogWhereInput = {
      ...(query.event ? { event: query.event } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.notificationLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...skipTake(query),
      }),
      prisma.notificationLog.count({ where }),
    ]);

    return pageResult(items, total, query);
  },
};

/* ------------------------------------------------------------ order notes */

export const orderNoteRepository = {
  listFor(orderId: string, customerVisibleOnly = false) {
    return prisma.orderNote.findMany({
      where: { orderId, ...(customerVisibleOnly ? { isCustomerVisible: true } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  },

  create(data: Prisma.OrderNoteUncheckedCreateInput) {
    return prisma.orderNote.create({ data });
  },
};
