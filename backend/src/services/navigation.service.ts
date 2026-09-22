import type { NavigationItemType, NavigationMenuKey } from '@shared/enums';
import type { NavigationMenuDto, NavigationNode } from '@shared/types/catalog';

import { cache } from '../container';
import {
  navigationRepository,
  type NavigationItemRow,
} from '../repositories/navigation.repository';
import { AppError } from '../utils/AppError';

const NAV_CACHE_PREFIX = 'nav:';
const TTL_SECONDS = 300;

/** Destinations are derived, never stored twice — a renamed category slug cannot desync the menu. */
function resolveUrl(row: NavigationItemRow): string | null {
  switch (row.type as NavigationItemType) {
    case 'CATEGORY':
      return row.category ? `/c/${row.category.slug}` : null;
    case 'COLLECTION':
      return row.collection ? `/collections/${row.collection.slug}` : null;
    case 'LEAD_FORM':
      return null;
    case 'URL':
    case 'PAGE':
    default:
      return row.url;
  }
}

function toNode(row: NavigationItemRow): NavigationNode {
  return {
    id: row.id,
    label: row.label,
    type: row.type as NavigationItemType,
    position: row.position,
    isHighlighted: row.isHighlighted,
    badgeText: row.badgeText,
    badgeColor: row.badgeColor,
    url: resolveUrl(row),
    categorySlug: row.category?.slug ?? null,
    collectionSlug: row.collection?.slug ?? null,
    leadFormKey: row.leadFormKey,
    iconMediaId: row.iconMediaId,
    menuColumn: row.menuColumn,
    openInNewTab: row.openInNewTab,
    children: [],
  };
}

function nest(rows: NavigationItemRow[]): NavigationNode[] {
  const nodes = new Map<string, NavigationNode>();
  for (const row of rows) nodes.set(row.id, toNode(row));

  const roots: NavigationNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = row.parentId ? nodes.get(row.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sort = (list: NavigationNode[]): NavigationNode[] => {
    list.sort((a, b) => a.position - b.position || a.label.localeCompare(b.label));
    for (const node of list) sort(node.children);
    return list;
  };

  return sort(roots);
}

export const navigationService = {
  /** R9 — the mega-menu, footer and top bar are data. Nothing in React may hardcode an entry. */
  async getMenu(key: NavigationMenuKey): Promise<NavigationMenuDto> {
    return cache.wrap(`${NAV_CACHE_PREFIX}${key}`, TTL_SECONDS, async () => {
      const menu = await navigationRepository.findMenu(key);
      if (!menu) throw AppError.notFound(`Navigation menu "${key}" not found`, { key });

      const rows = await navigationRepository.findItems(menu.id);
      return { key: menu.key as NavigationMenuKey, name: menu.name, items: nest(rows) };
    });
  },
};
