import type { LoginAttempt, Prisma } from '@prisma/client';

import type { AuthRealm } from '@shared/enums';

import { prisma } from '../config/prisma';

export const loginAttemptRepository = {
  record(data: Prisma.LoginAttemptUncheckedCreateInput): Promise<LoginAttempt> {
    return prisma.loginAttempt.create({ data });
  },

  countRecentFailures(realm: AuthRealm, identifier: string, since: Date): Promise<number> {
    return prisma.loginAttempt.count({
      where: { realm, identifier, success: false, createdAt: { gte: since } },
    });
  },

  listFor(realm: AuthRealm, identifier: string, take = 20): Promise<LoginAttempt[]> {
    return prisma.loginAttempt.findMany({
      where: { realm, identifier },
      orderBy: [{ createdAt: 'desc' }],
      take,
    });
  },

  count(): Promise<number> {
    return prisma.loginAttempt.count();
  },
};
