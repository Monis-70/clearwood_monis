import { describe, expect, it } from 'vitest';

import { navigationItemUpdateSchema } from '@shared/schemas/cms';

import { prisma } from '../src/config/prisma';

/**
 * The seed writes rows the admin API must be able to save back unchanged: an item whose stored
 * menuColumn or position fails the API's own schema cannot be edited without the UI silently
 * rewriting it. Siblings also need distinct positions, or drag-and-drop order is undefined.
 */

describe('seeded navigation obeys the admin API limits', () => {
  it('stores only menuColumn and position values the item schema accepts', async () => {
    const items = await prisma.navigationItem.findMany({
      select: { label: true, menuColumn: true, position: true },
    });
    expect(items.length).toBeGreaterThan(100);

    const rejected = items.filter(
      (item) =>
        !navigationItemUpdateSchema.safeParse({
          menuColumn: item.menuColumn,
          position: item.position,
        }).success,
    );

    expect(rejected).toEqual([]);
  });

  it('gives siblings distinct positions', async () => {
    const ties = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM (
        SELECT menuId, parentId, position FROM NavigationItem
        GROUP BY menuId, parentId, position HAVING COUNT(*) > 1
      ) AS t`;
    const categoryTies = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM (
        SELECT parentId, position FROM Category WHERE deletedAt IS NULL
        GROUP BY parentId, position HAVING COUNT(*) > 1
      ) AS t`;

    expect(Number(ties[0]?.n)).toBe(0);
    expect(Number(categoryTies[0]?.n)).toBe(0);
  });

  it('spreads every mega-menu group over the allowed columns, in catalogue order', async () => {
    const furnitures = await prisma.navigationItem.findFirstOrThrow({
      where: { menu: { key: 'MAIN' }, parentId: null, url: '/' },
    });
    const groups = await prisma.navigationItem.findMany({
      where: { parentId: furnitures.id, type: 'CATEGORY' },
      orderBy: { position: 'asc' },
      select: { menuColumn: true },
    });
    expect(groups.length).toBeGreaterThan(10);

    const columns = groups.map((group) => group.menuColumn ?? 0);
    expect(Math.min(...columns)).toBe(1);
    expect(Math.max(...columns)).toBe(10);
    expect(columns).toEqual([...columns].sort((a, b) => a - b));
  });
});
