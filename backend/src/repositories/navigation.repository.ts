import type { NavigationMenu, Prisma } from '@prisma/client';

import type { NavigationMenuKey } from '@shared/enums';

import { prisma } from '../config/prisma';

const itemInclude = {
  category: { select: { slug: true, isActive: true } },
  collection: { select: { slug: true, isActive: true } },
} satisfies Prisma.NavigationItemInclude;

export type NavigationItemRow = Prisma.NavigationItemGetPayload<{ include: typeof itemInclude }>;

export const navigationRepository = {
  findMenu(key: NavigationMenuKey): Promise<NavigationMenu | null> {
    return prisma.navigationMenu.findFirst({ where: { key, isActive: true } });
  },

  /** Flat, ordered rows — the service nests them, so a menu costs exactly two queries. */
  findItems(menuId: string, includeInactive = false): Promise<NavigationItemRow[]> {
    return prisma.navigationItem.findMany({
      where: { menuId, ...(includeInactive ? {} : { isActive: true }) },
      include: itemInclude,
      orderBy: [{ position: 'asc' }, { label: 'asc' }],
    });
  },

  countItems(menuId: string): Promise<number> {
    return prisma.navigationItem.count({ where: { menuId } });
  },
};
