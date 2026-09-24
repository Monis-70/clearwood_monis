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
  /** The enquiry form a SERVICE category opens instead of a product grid. */
  leadFormKey?: string;
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
  // "Fabric Sofas" under "Sofas" is already scoped; "Special Collection" under it is not.
  const scoped = parentName !== null && !name.toLowerCase().includes(parentName.toLowerCase());
  const scope = scoped ? `${name} ${parentName}`.replace(/\s+/g, ' ').trim() : name;
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

/** A contract-work service line: requested through the shared contract-work enquiry form. */
function service(name: string, slug: string): SeedCategory {
  return { name, slug, kind: 'SERVICE', leadFormKey: 'contract-work' };
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
      { name: 'Fabric Sofas', slug: 'fabric-sofas' },
      { name: 'Wooden Frame Sofas', slug: 'wooden-frame-sofas' },
      { name: 'U-Shaped Sofas', slug: 'u-shaped-sofas' },
      { name: 'Curved Sofas', slug: 'curved-sofas' },
      { name: 'Contemporary Sofas', slug: 'contemporary-sofas' },
      { name: 'Minimalist Sofas', slug: 'minimalist-sofas' },
      { name: '3-Seater Sofas', slug: '3-seater-sofas' },
      { name: '2-Seater Sofas', slug: '2-seater-sofas' },
      { name: 'Single-Seater Sofas', slug: 'single-seater-sofas' },
      { name: '3+1+1 Sofa Sets', slug: '3-1-1-sofa-sets' },
      { name: 'Sofa-cum-Beds', slug: 'sofa-cum-beds' },
      { name: 'L-Shaped Sofas', slug: 'l-shaped-sofas' },
      { name: 'Leather Sofas', slug: 'leather-sofas', attributes: ['FABRIC'] },
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
      { name: 'Lounge Chairs', slug: 'lounge-chairs' },
      { name: 'Armchairs', slug: 'armchairs' },
      { name: 'Wingback Chairs', slug: 'wingback-chairs' },
      { name: 'Swing Chairs', slug: 'swing-chairs' },
      { name: 'Rocking Chairs', slug: 'rocking-chairs' },
      { name: 'Office Chairs', slug: 'office-chairs' },
      { name: 'Study Chairs', slug: 'study-chairs' },
      { name: 'Gaming Chairs', slug: 'gaming-chairs' },
      { name: 'Executive & Director Chairs', slug: 'executive-director-chairs' },
      { name: 'Cafeteria & Visitor Chairs', slug: 'cafeteria-visitor-chairs' },
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
      { name: 'Special Collection Seatings', slug: 'special-collection-seating' },
      { name: 'Make your own Seatings', slug: 'make-your-own-seating' },
    ],
  },
  {
    name: 'Sofa Chairs',
    slug: 'sofa-chairs',
    attributes: ['COLOUR', 'FABRIC', 'SEATER', 'ARM_STYLE'],
    children: [
      { name: 'All Sofa Chairs', slug: 'all-sofa-chairs' },
      { name: 'Single-Seater Sofa Chairs', slug: 'single-seater-sofa-chairs' },
      { name: 'Dual-Seater Sofa Chairs', slug: 'dual-seater-sofa-chairs' },
      { name: 'Special Collection Sofa Chairs', slug: 'special-collection-sofa-chairs' },
      { name: 'Make your own Sofa Chairs', slug: 'make-your-own-sofa-chairs' },
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
      { name: 'Special Collection Tables', slug: 'special-collection-tables' },
      { name: 'Make your own Tables', slug: 'make-your-own-tables' },
    ],
  },
  {
    name: 'Recliners',
    slug: 'recliners',
    attributes: ['COLOUR', 'FABRIC', 'SEATER', 'WARRANTY'],
    children: [
      { name: 'All Recliners', slug: 'all-recliners' },
      { name: 'Single-Seater Recliners', slug: 'single-seater-recliners' },
      { name: 'Dual-Seater Recliners', slug: 'dual-seater-recliners' },
      { name: 'Triple-Seater Recliners', slug: 'triple-seater-recliners' },
      { name: 'Special Collection Recliners', slug: 'special-collection-recliners' },
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
      { name: 'Special Collection Dining Sets', slug: 'special-collection-dining' },
      { name: 'Make your own Dining Sets', slug: 'make-your-own-dining' },
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
      { name: 'Special Collection Balcony Furniture', slug: 'special-collection-balcony' },
      { name: 'Make your own Balcony Furniture', slug: 'make-your-own-balcony' },
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
      { name: 'Special Collection Outdoor Furniture', slug: 'special-collection-outdoor' },
      { name: 'Make your own Outdoor Furniture', slug: 'make-your-own-outdoor' },
    ],
  },
  {
    name: 'Mattresses',
    slug: 'mattresses',
    attributes: ['MATTRESS_SIZE', 'FILLING', 'CUSHION_FIRMNESS', 'WARRANTY'],
    children: [
      { name: 'All Mattresses', slug: 'all-mattresses' },
      { name: 'King Size Mattresses', slug: 'king-mattresses', attributes: ['MATTRESS_SIZE'] },
      { name: 'Queen Size Mattresses', slug: 'queen-mattresses' },
      { name: 'Double Bed Mattresses', slug: 'double-bed-mattresses' },
      { name: 'Ortho-Zen Mattresses', slug: 'ortho-zen-mattresses' },
      { name: 'Foam Mattresses', slug: 'foam-mattresses' },
      { name: 'Special Collection Mattresses', slug: 'special-collection-mattresses' },
      { name: 'Make your own Mattresses', slug: 'make-your-own-mattresses' },
    ],
  },
  {
    name: 'Bedroom Headboard',
    slug: 'bedroom-headboard',
    shortDescription: 'Upholstered and solid-wood headboards, framed and padded in-house.',
    attributes: ['COLOUR', 'FABRIC', 'WOOD_TYPE', 'MATTRESS_SIZE'],
    children: [
      { name: 'All Bedroom Headboard', slug: 'all-bedroom-headboard' },
      { name: 'Bedroom Headboard', slug: 'bedroom-headboards' },
      { name: 'Bedroom Legboard', slug: 'bedroom-legboards' },
      { name: 'Headboard Cushion', slug: 'headboard-cushions' },
      { name: 'Special Collection Bedroom HeadBoard', slug: 'special-collection-headboards' },
      { name: 'Make your own Bedroom Headboard', slug: 'make-your-own-headboards' },
    ],
  },
  {
    name: 'Furniture Pillows',
    slug: 'furniture-pillows',
    shortDescription: 'Cushions and pillows cut, filled and stitched to match our furniture.',
    attributes: ['COLOUR', 'FABRIC', 'FILLING', 'PILLOW_SHAPE', 'PACK_SIZE'],
    children: [
      { name: 'All Pillows', slug: 'all-pillows' },
      { name: 'Set of 6 Pillows', slug: 'set-of-6-pillows' },
      { name: 'Set of 5 Pillows', slug: 'set-of-5-pillows' },
      { name: 'Set of 4 Pillows', slug: 'set-of-4-pillows' },
      { name: 'Set of 3 Pillows', slug: 'set-of-3-pillows' },
      { name: 'Set of 2 Pillows', slug: 'set-of-2-pillows' },
      { name: 'Cylinder Pillows', slug: 'cylinder-pillows' },
      { name: 'Spherical Pillows', slug: 'spherical-pillows' },
      { name: 'Body Pillows', slug: 'body-pillows' },
      { name: 'Big Floor Pillows', slug: 'big-floor-pillows' },
      { name: 'Rectangular Pillows', slug: 'rectangular-pillows' },
      { name: 'Square Pillows', slug: 'square-pillows' },
      { name: 'Triangle Pillows', slug: 'triangle-pillows' },
      { name: 'Knot Ball Pillows', slug: 'knot-ball-pillows' },
      { name: 'Leather Pillows', slug: 'leather-pillows' },
      { name: 'Chair/Floor Pillows', slug: 'chair-floor-pillows' },
      { name: 'Special Collection Pillows', slug: 'special-collection-pillows' },
      { name: 'Make your own Pillows', slug: 'make-your-own-pillows' },
    ],
  },
  {
    name: 'Furniture Accessories',
    slug: 'furniture-accessories',
    shortDescription: 'Legs, fittings and foam from the same workshop that builds our furniture.',
    attributes: ['COMPATIBLE_WITH', 'MATERIAL', 'SIZE', 'COLOUR'],
    children: [
      { name: 'All Accessories', slug: 'all-accessories' },
      { name: 'Sofa Legs', slug: 'sofa-legs' },
      { name: 'Sofa Diamonds', slug: 'sofa-diamonds' },
      { name: 'Screws / Nails', slug: 'screws-nails' },
      { name: 'Table Legs', slug: 'table-legs' },
      { name: 'Chair Legs', slug: 'chair-legs' },
      { name: 'Swing Cable / Rope', slug: 'swing-cables-ropes' },
      { name: 'Hooks', slug: 'furniture-hooks' },
      { name: 'Sofa Sponge Cushion', slug: 'sofa-sponge-cushions' },
      { name: 'Foam', slug: 'accessory-foam' },
      // The accessories' curated line: a special collection by kind, whatever its name.
      { name: 'Exclusive Accessories', slug: 'exclusive-accessories', kind: 'SPECIAL_COLLECTION' },
      { name: 'Make your own Accessories', slug: 'make-your-own-accessories' },
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
      { name: 'Special Collection Interior', slug: 'special-collection-interiors' },
      { name: 'Make your own Interior', slug: 'make-your-own-interiors' },
    ],
  },
  {
    // A service line, not a shelf: discovered here, requested through the contract-work form.
    name: 'Contract Based Work',
    slug: 'contract-based-work',
    kind: 'SERVICE',
    leadFormKey: 'contract-work',
    shortDescription: 'Furniture designed and built to order for homes, hotels, offices and banks.',
    children: [
      service('Custom Furnitures', 'custom-furniture'),
      service('Custom Hotel Furnitures', 'custom-hotel-furniture'),
      service('Custom Cafe Furniture', 'custom-cafe-furniture'),
      service('Custom Restaurant Furniture', 'custom-restaurant-furniture'),
      service('Custom Lobby Furniture', 'custom-lobby-furniture'),
      service('Custom Office Furniture', 'custom-office-furniture'),
      service('Custom Home Furniture', 'custom-home-furniture'),
      service('Customized Interior Designer Furniture', 'interior-designer-furniture'),
      service('Customized Bank Furnitures', 'custom-bank-furniture'),
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
