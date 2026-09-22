import type { NavigationItemType, NavigationMenuKey } from '@shared/enums';

/**
 * Pure data. The MAIN menu's category groups are expanded from CATEGORY_TREE at seed time, so the
 * mega-menu can never drift from the catalog.
 */

export interface SeedNavigationItem {
  label: string;
  type: NavigationItemType;
  url?: string;
  categorySlug?: string;
  collectionSlug?: string;
  leadFormKey?: string;
  isHighlighted?: boolean;
  badgeText?: string;
  badgeColor?: string;
  openInNewTab?: boolean;
  children?: SeedNavigationItem[];
}

export interface SeedNavigationMenu {
  key: NavigationMenuKey;
  name: string;
  items: SeedNavigationItem[];
}

/** Top-level category slugs whose sub-trees become mega-menu columns under "Furnitures". */
export const MEGA_MENU_ROOT_SLUGS = [
  'sofas',
  'chairs',
  'seating',
  'sofa-chairs',
  'tables',
  'recliners',
  'dining',
  'balcony-furniture',
  'outdoor-furniture',
  'mattresses',
  'complete-interior-solutions',
] as const;

export const LEAD_FORM_ITEMS: SeedNavigationItem[] = [
  { label: 'Home Interiors', type: 'LEAD_FORM', leadFormKey: 'home-interiors' },
  { label: 'Bulk Order', type: 'LEAD_FORM', leadFormKey: 'bulk-order' },
  { label: 'Become a Partner', type: 'LEAD_FORM', leadFormKey: 'become-a-partner' },
];

export const STATIC_MENUS: SeedNavigationMenu[] = [
  {
    key: 'FOOTER_PRIMARY',
    name: 'Footer — Customer care',
    items: [
      { label: 'Help Center', type: 'PAGE', url: '/help' },
      { label: 'FAQ', type: 'PAGE', url: '/faq' },
      { label: 'Track Order', type: 'PAGE', url: '/track-order' },
      { label: 'Contact Us', type: 'PAGE', url: '/contact' },
      { label: 'About Us', type: 'PAGE', url: '/about' },
    ],
  },
  {
    key: 'FOOTER_SECONDARY',
    name: 'Footer — Policies',
    items: [
      { label: 'Shipping & Delivery', type: 'PAGE', url: '/shipping' },
      { label: 'Returns & Cancellation', type: 'PAGE', url: '/returns' },
      { label: 'Warranty', type: 'PAGE', url: '/warranty' },
      { label: 'Privacy Policy', type: 'PAGE', url: '/privacy' },
      { label: 'Terms of Service', type: 'PAGE', url: '/terms' },
    ],
  },
  {
    key: 'TOP_BAR',
    name: 'Top bar',
    items: [
      {
        label: '100% in-house manufacturing. Zero outsourcing.',
        type: 'URL',
        url: '/about',
        isHighlighted: true,
      },
      { label: 'Talk to us', type: 'URL', url: '/contact', badgeText: 'Mon–Sat 10–7' },
    ],
  },
];
