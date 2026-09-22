import type { AuditLog, Prisma } from '@prisma/client';

import type { AuditLogQuery } from '@shared/schemas/auth';

import { prisma } from '../config/prisma';

import { orderBy, pageResult, skipTake, type PageResult } from './helpers';

const SORTABLE = ['createdAt', 'action', 'entity', 'severity'] as const;

export const auditLogRepository = {
  create(data: Prisma.AuditLogUncheckedCreateInput): Promise<AuditLog> {
    return prisma.auditLog.create({ data });
  },

  async list(query: AuditLogQuery): Promise<PageResult<AuditLog>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.actorType ? { actorType: query.actorType } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.entity ? { entity: query.entity } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.realm ? { realm: query.realm } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        ...skipTake(query),
        orderBy: orderBy(query.sort, query.order, SORTABLE, [{ createdAt: 'desc' }]),
      }),
      prisma.auditLog.count({ where }),
    ]);
    return pageResult(items, total, query);
  },

  countBy(where: Prisma.AuditLogWhereInput): Promise<number> {
    return prisma.auditLog.count({ where });
  },
};
