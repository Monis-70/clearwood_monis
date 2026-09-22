import type { CategoryKind } from '@shared/enums';

/**
 * The complete site map from docs/PROJECT_CONTEXT.md §8, in menu order.
 * Pure data — no Prisma imports.
 */

export interface SeedCategory {
  name: string;
  slug: string;
  /** Derived from the name when omitted. */
  kind?: CategoryKind;
  showInMenu?: boolean;
  isFeatured?: boolean;
  menuColumn?: number;
  shortDescription?: string;
  /** Attribute codes attached at this node; descendants inherit them. */
  attributes?: string[];
  children?: SeedCategory[];
}

/** "All X" > "Special Collection*" > "Make your own*" > "New Arrivals" > interior > standard. */
export function deriveCategoryKind(name: string, parentSlug: string | null): CategoryKind {
  const normalised = name.trim().toLowerCase();

  if (normalised === 'all' || normalised.startsWith('all ')) return 'ALL';
  if (normalised.startsWith('special collection')) return 'SPECIAL_COLLECTION';
  if (normalised.startsWith('make your own')) return 'MAKE_YOUR_OWN';
  if (normalised === 'new arrivals') return 'NEW_ARRIVALS';
  if (parentSlug === 'complete-interior-solutions') return 'INTERIOR_SOLUTION';
  return 'STANDARD';
}

/** R8/R9 — even SEO copy is generated from data, never typed into a component. */
export function categorySeo(
  name: string,
  parentName: string | null,
): { seoTitle: string; seoDescription: string; seoKeywords: string } {
  const scope = parentName ? `${name} ${parentName}`.replace(/\s+/g, ' ').trim() : name;
  return {
    seoTitle: `${name} — Buy ${scope} Online | ClearWood Furnitures`,
    seoDescription:
      `Shop ${scope.toLowerCase()} made in-house by ClearWood Furnitures. ` +
      '100% in-house manufacturing, zero outsourcing, every piece manufactured individually. ' +
      'Made-to-order sizes and finishes available.',
    seoKeywords: [scope, `buy ${scope.toLowerCase()}`, 'custom furniture india', 'clearwood']
      .join(', ')
      .toLowerCase(),
  };
}

export const CATEGORY_TREE: SeedCategory[] = [
  {
    name: 'Sofas',
    slug: 'sofas',
    isFeatured: true,
    shortDescription: 'Hand-built sofa frames, individually upholstered in our own workshop.',
    attributes: ['COLOUR', 'FABRIC', 'SEATER', 'LEG_TYPE', 'FILLING', 'ARM_STYLE'],
    children: [
      { name: 'All Sofas', slug: 'all-sofas' },
      { name: 'Fabric', slug: 'fabric-sofas' },
      { name: 'Wooden Frame', slug: 'wooden-frame-sofas' },
      { name: 'U-Shaped', slug: 'u-shaped-sofas' },
      { name: 'Curved', slug: 'curved-sofas' },
      { name: 'Contemporary', slug: 'contemporary-sofas' },
      { name: 'Minimalist', slug: 'minimalist-sofas' },
      { name: '3-Seater', slug: '3-seater-sofas' },
      { name: '2-Seater', slug: '2-seater-sofas' },
      { name: 'Single-Seater', slug: 'single-seater-sofas' },
      { name: '3+1+1 Sofa Sets', slug: '3-1-1-sofa-sets' },
      { name: 'Sofa-cum-Beds', slug: 'sofa-cum-beds' },
      { name: 'L-Shaped', slug: 'l-shaped-sofas' },
      { name: 'Leather', slug: 'leather-sofas', attributes: ['FABRIC'] },
      { name: 'Chaise Loungers', slug: 'chaise-loungers' },
      { name: 'Outdoor Sofas', slug: 'outdoor-sofas' },
      { name: 'Diwans', slug: 'diwans' },
      { name: 'Office Sofas', slug: 'office-sofas' },
      { name: 'Swing Sofas', slug: 'swing-sofas' },
      { name: 'Special Collection', slug: 'special-collection-sofas' },
      { name: 'Make your own Sofas', slug: 'make-your-own-sofas' },
    ],
  },
  {
    name: 'Chairs',
    slug: 'chairs',
    isFeatured: true,
    shortDescription: 'Lounge, office and accent chairs built one at a time.',
    attributes: ['COLOUR', 'FABRIC', 'LEG_TYPE', 'BACK_STYLE', 'ASSEMBLY_TYPE'],
    children: [
      { name: 'All Chairs', slug: 'all-chairs' },
      { name: 'Lounge', slug: 'lounge-chairs' },
      { name: 'Armchairs', slug: 'armchairs' },
      { name: 'Wingback', slug: 'wingback-chairs' },
      { name: 'Swing', slug: 'swing-chairs' },
      { name: 'Rocking', slug: 'rocking-chairs' },
      { name: 'Office', slug: 'office-chairs' },
      { name: 'Study', slug: 'study-chairs' },
      { name: 'Gaming', slug: 'gaming-chairs' },
      { name: 'Executive & Director', slug: 'executive-director-chairs' },
      { name: 'Cafeteria & Visitor', slug: 'cafeteria-visitor-chairs' },
      { name: 'Special Collection Chairs', slug: 'special-collection-chairs' },
      { name: 'Make your own Chairs', slug: 'make-your-own-chairs' },
    ],
  },
  {
    name: 'Seating',
    slug: 'seating',
    shortDescription: 'Stools, benches and ottomans that finish a room.',
    attributes: ['COLOUR', 'FABRIC', 'FILLING', 'WOOD_TYPE'],
    children: [
      { name: 'All Seating', slug: 'all-seating' },
      { name: 'Stools', slug: 'stools' },
      { name: 'Benches', slug: 'benches' },
      { name: 'Loveseats', slug: 'loveseats' },
      { name: 'Ottomans & Pouffes', slug: 'ottomans-pouffes' },
      { name: 'Special Collection', slug: 'special-collection-seating' },
      { name: 'Make your own', slug: 'make-your-own-seating' },
    ],
  },
  {
    name: 'Sofa Chairs',
    slug: 'sofa-chairs',
    attributes: ['COLOUR', 'FABRIC', 'SEATER', 'ARM_STYLE'],
    children: [
      { name: 'All', slug: 'all-sofa-chairs' },
      { name: 'Single-Seater', slug: 'single-seater-sofa-chairs' },
      { name: 'Dual-Seater', slug: 'dual-seater-sofa-chairs' },
      { name: 'Special Collection', slug: 'special-collection-sofa-chairs' },
      { name: 'Make your own', slug: 'make-your-own-sofa-chairs' },
    ],
  },
  {
    name: 'Tables',
    slug: 'tables',
    isFeatured: true,
    shortDescription: 'Solid-wood tops finished by hand in six finishes.',
    attributes: ['WOOD_TYPE', 'WOOD_FINISH', 'SIZE', 'LEG_TYPE'],
    children: [
      { name: 'All Tables', slug: 'all-tables' },
      { name: 'Coffee Tables', slug: 'coffee-tables' },
      { name: 'Coffee Table Sets', slug: 'coffee-table-sets' },
      { name: 'Side Tables', slug: 'side-tables' },
      { name: 'Nesting Tables', slug: 'nesting-tables' },
      { name: 'Sofa Side Tables', slug: 'sofa-side-tables' },
      { name: 'Special Collection', slug: 'special-collection-tables' },
      { name: 'Make your own', slug: 'make-your-own-tables' },
    ],
  },
  {
    name: 'Recliners',
    slug: 'recliners',
    attributes: ['COLOUR', 'FABRIC', 'SEATER', 'WARRANTY'],
    children: [
      { name: 'All', slug: 'all-recliners' },
      { name: 'Single-Seater', slug: 'single-seater-recliners' },
      { name: 'Dual-Seater', slug: 'dual-seater-recliners' },
      { name: 'Triple-Seater', slug: 'triple-seater-recliners' },
      { name: 'Special Collection', slug: 'special-collection-recliners' },
    ],
  },
  {
    name: 'Dining',
    slug: 'dining',
    isFeatured: true,
    attributes: ['WOOD_TYPE', 'WOOD_FINISH', 'SEATER', 'SIZE'],
    children: [
      { name: 'All Dining Sets', slug: 'all-dining-sets' },
      { name: '9-Seater Dining Sets', slug: '9-seater-dining-sets' },
      { name: '8-Seater Dining Sets', slug: '8-seater-dining-sets' },
      { name: '7-Seater Dining Sets', slug: '7-seater-dining-sets' },
      { name: '6-Seater Dining Sets', slug: '6-seater-dining-sets' },
      { name: '5-Seater Dining Sets', slug: '5-seater-dining-sets' },
      { name: '4-Seater Dining Sets', slug: '4-seater-dining-sets' },
      { name: '3-Seater Dining Sets', slug: '3-seater-dining-sets' },
      { name: '2-Seater Dining Sets', slug: '2-seater-dining-sets' },
      { name: '1-Seater Dining Sets', slug: '1-seater-dining-sets' },
      { name: 'Special Collection', slug: 'special-collection-dining' },
      { name: 'Make your own', slug: 'make-your-own-dining' },
    ],
  },
  {
    name: 'Balcony Furniture',
    slug: 'balcony-furniture',
    attributes: ['COLOUR', 'WOOD_TYPE', 'WOOD_FINISH', 'SIZE'],
    children: [
      { name: 'Balcony Sets', slug: 'balcony-sets' },
      { name: 'Balcony Chairs', slug: 'balcony-chairs' },
      { name: 'Balcony Tables', slug: 'balcony-tables' },
      { name: 'Swings', slug: 'balcony-swings' },
      { name: 'Special Collection', slug: 'special-collection-balcony' },
      { name: 'Make your own', slug: 'make-your-own-balcony' },
    ],
  },
  {
    name: 'Outdoor Furniture',
    slug: 'outdoor-furniture',
    attributes: ['COLOUR', 'FABRIC', 'WOOD_TYPE', 'SIZE'],
    children: [
      { name: 'All Outdoor Sets', slug: 'all-outdoor-sets' },
      { name: 'Table & Chair Sets', slug: 'outdoor-table-chair-sets' },
      { name: 'Sofa Sets', slug: 'outdoor-sofa-sets' },
      { name: 'Loungers', slug: 'outdoor-loungers' },
      { name: 'Special Collection', slug: 'special-collection-outdoor' },
      { name: 'Make your own', slug: 'make-your-own-outdoor' },
    ],
  },
  {
    name: 'Mattresses',
    slug: 'mattresses',
    attributes: ['MATTRESS_SIZE', 'FILLING', 'CUSHION_FIRMNESS', 'WARRANTY'],
    children: [
      { name: 'All', slug: 'all-mattresses' },
      { name: 'King', slug: 'king-mattresses', attributes: ['MATTRESS_SIZE'] },
      { name: 'Queen', slug: 'queen-mattresses' },
      { name: 'Double Bed', slug: 'double-bed-mattresses' },
      { name: 'Ortho-Zen', slug: 'ortho-zen-mattresses' },
      { name: 'Foam', slug: 'foam-mattresses' },
      { name: 'Special Collection', slug: 'special-collection-mattresses' },
      { name: 'Make your own', slug: 'make-your-own-mattresses' },
    ],
  },
  {
    name: 'Complete Interior Solutions',
    slug: 'complete-interior-solutions',
    shortDescription: 'Whole-room packages designed and manufactured end to end.',
    attributes: ['COLOUR', 'WOOD_TYPE', 'WOOD_FINISH'],
    children: [
      { name: 'Living Room', slug: 'interior-living-room' },
      { name: 'Bedroom', slug: 'interior-bedroom' },
      { name: 'Kitchen', slug: 'interior-kitchen' },
      { name: 'Hall', slug: 'interior-hall' },
      { name: 'Lobby', slug: 'interior-lobby' },
      { name: 'Office', slug: 'interior-office' },
      { name: 'Special Collection', slug: 'special-collection-interiors' },
      { name: 'Make your own', slug: 'make-your-own-interiors' },
    ],
  },
  {
    name: 'New Arrivals',
    slug: 'new-arrivals',
    isFeatured: true,
    shortDescription: 'The pieces that left the workshop most recently.',
  },
];

/** Category attribute rows that override an inherited flag (demonstrates the override path). */
export const CATEGORY_ATTRIBUTE_OVERRIDES: Record<string, { code: string; isRequired: boolean }[]> =
  {
    'leather-sofas': [{ code: 'FABRIC', isRequired: true }],
    'king-mattresses': [{ code: 'MATTRESS_SIZE', isRequired: true }],
  };
