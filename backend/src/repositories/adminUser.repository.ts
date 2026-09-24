import type { AdminUser, Prisma } from '@prisma/client';

import type { AdminUserListQuery } from '@shared/schemas/auth';

import { prisma } from '../config/prisma';

import { notDeleted, orderBy, pageResult, skipTake, type PageResult } from './helpers';

const SORTABLE = ['name', 'email', 'status', 'lastLoginAt', 'createdAt', 'updatedAt'] as const;

const withRoles = {
  roles: { include: { role: true }, orderBy: [{ assignedAt: 'asc' as const }] },
} satisfies Prisma.AdminUserInclude;

export type AdminUserWithRoles = Prisma.AdminUserGetPayload<{ include: typeof withRoles }>;

export const adminUserRepository = {
  findById(id: string, tx: Prisma.TransactionClient = prisma): Promise<AdminUserWithRoles | null> {
    return tx.adminUser.findFirst({ where: { id, ...notDeleted }, include: withRoles });
  },

  findByEmail(email: string): Promise<AdminUserWithRoles | null> {
    return prisma.adminUser.findFirst({
      where: { email: email.toLowerCase(), ...notDeleted },
      include: withRoles,
    });
  },

  async list(query: AdminUserListQuery): Promise<PageResult<AdminUserWithRoles>> {
    const where: Prisma.AdminUserWhereInput = {
      ...notDeleted,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search } },
              { email: { contains: query.search.toLowerCase() } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.adminUser.findMany({
        where,
        ...skipTake(query),
        include: withRoles,
        orderBy: orderBy(query.sort, query.order, SORTABLE, [{ createdAt: 'desc' }]),
      }),
      prisma.adminUser.count({ where }),
    ]);
    return pageResult(items, total, query);
  },

  create(
    data: Prisma.AdminUserUncheckedCreateInput,
    tx: Prisma.TransactionClient = prisma,
  ): Promise<AdminUserWithRoles> {
    return tx.adminUser.create({ data, include: withRoles });
  },

  update(
    id: string,
    data: Prisma.AdminUserUncheckedUpdateInput,
    tx: Prisma.TransactionClient = prisma,
  ): Promise<AdminUserWithRoles> {
    return tx.adminUser.update({ where: { id }, data, include: withRoles });
  },

  softDelete(id: string, tx: Prisma.TransactionClient = prisma): Promise<AdminUser> {
    return tx.adminUser.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'DISABLED' },
    });
  },

  /** Invalidates every live access token for this user without waiting for expiry. */
  bumpPermissionVersion(id: string, tx: Prisma.TransactionClient = prisma): Promise<AdminUser> {
    return tx.adminUser.update({
      where: { id },
      data: { permissionVersion: { increment: 1 } },
    });
  },

  registerFailedLogin(id: string, lockedUntil: Date | null): Promise<AdminUser> {
    return prisma.adminUser.update({
      where: { id },
      data: { failedLoginCount: { increment: 1 }, lockedUntil },
    });
  },

  registerSuccessfulLogin(id: string, ip: string | null): Promise<AdminUser> {
    return prisma.adminUser.update({
      where: { id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: ip },
    });
  },

  count(): Promise<number> {
    return prisma.adminUser.count({ where: notDeleted });
  },
};
