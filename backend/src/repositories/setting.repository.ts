import type { AppSetting } from '@prisma/client';

import { prisma } from '../config/prisma';

/** R1 — the only layer allowed to talk to Prisma. */
export const settingRepository = {
  findPublic(group?: string): Promise<AppSetting[]> {
    return prisma.appSetting.findMany({
      where: { isPublic: true, ...(group ? { group } : {}) },
      orderBy: { key: 'asc' },
    });
  },

  findByKey(key: string): Promise<AppSetting | null> {
    return prisma.appSetting.findUnique({ where: { key } });
  },

  findByGroup(group: string): Promise<AppSetting[]> {
    return prisma.appSetting.findMany({ where: { group }, orderBy: { key: 'asc' } });
  },

  count(): Promise<number> {
    return prisma.appSetting.count();
  },
};
