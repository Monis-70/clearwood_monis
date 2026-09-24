import type { NavigationMenuKey } from '@shared/enums';

import {
  LEAD_FORM_ITEMS,
  MEGA_MENU_ROOT_SLUGS,
  SERVICE_MENU_ROOT_SLUGS,
  STATIC_MENUS,
  type SeedNavigationItem,
} from './data/navigation';
import { log, prisma } from './context';

/**
 * R9 — the entire mega-menu is data. The MAIN menu's category groups are expanded from the
 * categories as they are now, so the menu can never drift from the catalog.
 *
 * CREATE-ONLY: an item that already exists (matched on what it points at) keeps the label,
 * position, target and state an admin gave it.
 *
 * Items are hard-deleted by the admin API, so a missing item cannot be told apart from a removed
 * one. The seed therefore only adds an item together with the thing it belongs to: every item of a
 * menu the seed creates in this run, and the entry of a category or collection created in this
 * run. A re-run on an existing install adds nothing an admin took out.
 */

interface ResolvedItem extends SeedNavigationItem {
  menuColumn?: number;
  children?: ResolvedItem[];
}

/** What the earlier steps created in this run. */
export interface CreatedThisRun {
  categories: ReadonlySet<string>;
  collections: ReadonlySet<string>;
}

async function ensureMenu(
  key: NavigationMenuKey,
  name: string,
): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.navigationMenu.findUnique({ where: { key }, select: { id: true } });
  if (existing) return { id: existing.id, created: false };

  const menu = await prisma.navigationMenu.create({ data: { key, name }, select: { id: true } });
  return { id: menu.id, created: true };
}

async function ensureItems(
  menu: { id: string; created: boolean },
  parentId: string | null,
  items: ResolvedItem[],
  categoryIdBySlug: Map<string, string>,
  collectionIdBySlug: Map<string, string>,
  createdThisRun: CreatedThisRun,
): Promise<number> {
  const menuId = menu.id;
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
    // renaming a category must not make the seed create a second menu entry. A category or
    // collection has one entry per menu wherever an admin moved it, so those match menu-wide.
    const where =
      categoryId !== null
        ? { menuId, categoryId }
        : collectionId !== null
          ? { menuId, collectionId }
          : {
              menuId,
              parentId,
              ...(item.leadFormKey
                ? { leadFormKey: item.leadFormKey }
                : item.url
                  ? { url: item.url }
                  : { label: item.label }),
            };

    const existing = await prisma.navigationItem.findFirst({ where, select: { id: true } });

    const ownerIsNew =
      menu.created ||
      (item.categorySlug !== undefined && createdThisRun.categories.has(item.categorySlug)) ||
      (item.collectionSlug !== undefined && createdThisRun.collections.has(item.collectionSlug));

    // Missing and not new: the admin removed it (or its group), so it and its subtree stay out.
    if (!existing && !ownerIsNew) continue;

    const row =
      existing ??
      (await prisma.navigationItem.create({
        data: { menuId, parentId, label: item.label, ...target },
        select: { id: true },
      }));

    count += 1;

    if (item.children?.length) {
      count += await ensureItems(
        menu,
        row.id,
        item.children,
        categoryIdBySlug,
        collectionIdBySlug,
        createdThisRun,
      );
    }
  }

  return count;
}

export async function seedNavigation(createdThisRun: CreatedThisRun): Promise<void> {
  const categories = await prisma.category.findMany({
    where: { deletedAt: null },
    select: { id: true, slug: true, name: true, parentId: true, position: true },
    orderBy: [{ position: 'asc' }],
  });
  const collections = await prisma.collection.findMany({ select: { id: true, slug: true } });

  const categoryIdBySlug = new Map(categories.map((row) => [row.slug, row.id]));
  const collectionIdBySlug = new Map(collections.map((row) => [row.slug, row.id]));
  const bySlug = new Map(categories.map((row) => [row.slug, row]));

  const groupFor = (slug: string, menuColumn?: number): ResolvedItem[] => {
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
        ...(menuColumn === undefined ? {} : { menuColumn }),
        children,
      },
    ];
  };

  const megaMenuGroups = MEGA_MENU_ROOT_SLUGS.flatMap((slug, groupIndex) =>
    groupFor(slug, groupIndex + 1),
  );

  const mainItems: ResolvedItem[] = [
    {
      label: 'Furnitures',
      type: 'URL',
      url: '/',
      children: [{ label: 'All Products', type: 'URL', url: '/products' }, ...megaMenuGroups],
    },
    { label: 'New Arrivals', type: 'CATEGORY', categorySlug: 'new-arrivals', isHighlighted: true },
    ...SERVICE_MENU_ROOT_SLUGS.flatMap((slug) => groupFor(slug)),
    ...LEAD_FORM_ITEMS,
  ];

  const mainMenu = await ensureMenu('MAIN', 'Main navigation');
  let itemCount = await ensureItems(
    mainMenu,
    null,
    mainItems,
    categoryIdBySlug,
    collectionIdBySlug,
    createdThisRun,
  );

  for (const menu of STATIC_MENUS) {
    const row = await ensureMenu(menu.key, menu.name);
    itemCount += await ensureItems(
      row,
      null,
      menu.items,
      categoryIdBySlug,
      collectionIdBySlug,
      createdThisRun,
    );
  }

  log('navigation', `${STATIC_MENUS.length + 1} menus and ${itemCount} items ensured`);
}
