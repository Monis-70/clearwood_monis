import type { NavigationMenuKey } from '@shared/enums';

import {
  LEAD_FORM_ITEMS,
  MEGA_MENU_ROOT_SLUGS,
  STATIC_MENUS,
  type SeedNavigationItem,
} from './data/navigation';
import { log, prisma } from './context';

/**
 * R9 — the entire mega-menu is data. The MAIN menu's category groups are expanded from the
 * categories that were just seeded, so the menu can never drift from the catalog.
 * Items are matched on (menu, parent, label): labels are stable, positions and targets are synced.
 */

interface ResolvedItem extends SeedNavigationItem {
  menuColumn?: number;
  children?: ResolvedItem[];
}

async function ensureMenu(key: NavigationMenuKey, name: string): Promise<string> {
  const menu = await prisma.navigationMenu.upsert({
    where: { key },
    update: { isActive: true },
    create: { key, name },
  });
  return menu.id;
}

async function upsertItems(
  menuId: string,
  parentId: string | null,
  items: ResolvedItem[],
  categoryIdBySlug: Map<string, string>,
  collectionIdBySlug: Map<string, string>,
): Promise<number> {
  let count = 0;

  for (const [index, item] of items.entries()) {
    const categoryId = item.categorySlug ? (categoryIdBySlug.get(item.categorySlug) ?? null) : null;
    const collectionId = item.collectionSlug
      ? (collectionIdBySlug.get(item.collectionSlug) ?? null)
      : null;

    const target = {
      type: item.type,
      position: index + 1,
      url: item.url ?? null,
      categoryId,
      collectionId,
      leadFormKey: item.leadFormKey ?? null,
      isHighlighted: item.isHighlighted ?? false,
      badgeText: item.badgeText ?? null,
      badgeColor: item.badgeColor ?? null,
      openInNewTab: item.openInNewTab ?? false,
      menuColumn: item.menuColumn ?? null,
      isActive: true,
    };

    // Match on what the item POINTS AT, not on its label: labels are editorial and an admin
    // renaming a category must not make the seed create a second menu entry.
    const identity =
      categoryId !== null
        ? { categoryId }
        : collectionId !== null
          ? { collectionId }
          : item.leadFormKey
            ? { leadFormKey: item.leadFormKey }
            : item.url
              ? { url: item.url }
              : { label: item.label };

    const existing = await prisma.navigationItem.findFirst({
      where: { menuId, parentId, ...identity },
      select: { id: true },
    });

    const row = existing
      ? await prisma.navigationItem.update({ where: { id: existing.id }, data: target })
      : await prisma.navigationItem.create({
          data: { menuId, parentId, label: item.label, ...target },
        });

    count += 1;

    if (item.children?.length) {
      count += await upsertItems(
        menuId,
        row.id,
        item.children,
        categoryIdBySlug,
        collectionIdBySlug,
      );
    }
  }

  return count;
}

export async function seedNavigation(): Promise<void> {
  const categories = await prisma.category.findMany({
    where: { deletedAt: null },
    select: { id: true, slug: true, name: true, parentId: true, position: true },
    orderBy: [{ position: 'asc' }],
  });
  const collections = await prisma.collection.findMany({ select: { id: true, slug: true } });

  const categoryIdBySlug = new Map(categories.map((row) => [row.slug, row.id]));
  const collectionIdBySlug = new Map(collections.map((row) => [row.slug, row.id]));
  const bySlug = new Map(categories.map((row) => [row.slug, row]));

  const megaMenuGroups: ResolvedItem[] = MEGA_MENU_ROOT_SLUGS.flatMap((slug, groupIndex) => {
    const root = bySlug.get(slug);
    if (!root) return [];

    const children = categories
      .filter((row) => row.parentId === root.id)
      .sort((a, b) => a.position - b.position)
      .map<ResolvedItem>((row) => ({
        label: row.name,
        type: 'CATEGORY',
        categorySlug: row.slug,
      }));

    return [
      {
        label: root.name,
        type: 'CATEGORY' as const,
        categorySlug: root.slug,
        menuColumn: groupIndex + 1,
        children,
      },
    ];
  });

  const mainItems: ResolvedItem[] = [
    {
      label: 'Furnitures',
      type: 'URL',
      url: '/',
      children: [{ label: 'All Products', type: 'URL', url: '/products' }, ...megaMenuGroups],
    },
    { label: 'New Arrivals', type: 'CATEGORY', categorySlug: 'new-arrivals', isHighlighted: true },
    ...LEAD_FORM_ITEMS,
  ];

  const mainMenuId = await ensureMenu('MAIN', 'Main navigation');
  let itemCount = await upsertItems(
    mainMenuId,
    null,
    mainItems,
    categoryIdBySlug,
    collectionIdBySlug,
  );

  for (const menu of STATIC_MENUS) {
    const menuId = await ensureMenu(menu.key, menu.name);
    itemCount += await upsertItems(menuId, null, menu.items, categoryIdBySlug, collectionIdBySlug);
  }

  log('navigation', `${STATIC_MENUS.length + 1} menus and ${itemCount} items upserted`);
}
