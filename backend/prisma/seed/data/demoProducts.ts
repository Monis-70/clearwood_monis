import type {
  PriceAdjustmentBasis,
  PriceAdjustmentScope,
  PriceAdjustmentType,
  ProductType,
} from '@shared/enums';

import { EXTRA_DEMO_PRODUCTS } from './demoProductsExtra';

/**
 * Pure data for the SEED_DEMO catalog. Prices are integer paise (₹18,999 => 1899900).
 * Variants are listed explicitly so every combination has a stable SKU across re-seeds.
 */

export interface SeedProductSpec {
  attribute: string;
  value: string;
}

export interface SeedProductVariant {
  suffix: string;
  attributes: Record<string, string>;
  /** `null` (or omitted) means "inherit the product base price" — resolved in Prompt 6. */
  pricePaise?: number | null;
  stockQty?: number;
  isDefault?: boolean;
  leadTimeDays?: number;
}

export interface SeedProduct {
  sku: string;
  slug: string;
  name: string;
  subtitle: string;
  shortDescription: string;
  description: string;
  productType: ProductType;
  basePricePaise: number;
  compareAtPricePaise?: number;
  taxClassCode: string;
  /** Slugs; the first one is the primary category. */
  categories: string[];
  specs: SeedProductSpec[];
  variantAttributes: string[];
  variants: SeedProductVariant[];
  warrantyMonths?: number;
  leadTimeDays?: number;
  isMadeToOrder?: boolean;
  allowCustomization?: boolean;
  assemblyRequired?: boolean;
  manufacturingNote?: string;
  careInstructions?: string;
  isFeatured?: boolean;
  isNewArrival?: boolean;
  isSpecialCollection?: boolean;
  isBestSeller?: boolean;
  soldCount?: number;
  ratingAvgBp?: number;
  ratingCount?: number;
  lengthMm?: number;
  widthMm?: number;
  heightMm?: number;
  seatHeightMm?: number;
  weightGrams?: number;
}

export interface SeedPriceAdjustment {
  name: string;
  scope: PriceAdjustmentScope;
  adjustmentType: PriceAdjustmentType;
  basis?: PriceAdjustmentBasis;
  priority: number;
  valuePaise?: number;
  valueBp?: number;
  categorySlug?: string;
  productSlug?: string;
  variantSku?: string;
  attributeCode?: string;
  attributeValueCode?: string;
  startsAt?: string;
  endsAt?: string;
  note?: string;
}

const IN_HOUSE = 'Built start-to-finish in our own workshop — frame, upholstery and finish.';

/** The hand-written showcase pieces. The rest of the shelf lives in `demoProductsExtra.ts`. */
const CORE_DEMO_PRODUCTS: SeedProduct[] = [
  {
    sku: 'CW-SOF-KABIR',
    slug: 'kabir-3-seater-fabric-sofa',
    name: 'Kabir 3-Seater Fabric Sofa',
    subtitle: 'Kiln-dried sheesham frame, hand-tufted seat',
    shortDescription: 'A low, generous three-seater with a solid sheesham frame and HR foam seat.',
    description:
      'The Kabir is our everyday three-seater: a kiln-dried sheesham frame, webbed suspension and ' +
      'a 32-density HR foam seat that keeps its shape. Every frame is jointed, sanded and ' +
      'upholstered by the same team, so no two pieces pass through an outside vendor.',
    productType: 'VARIABLE',
    basePricePaise: 4599900,
    compareAtPricePaise: 5499900,
    taxClassCode: 'GST_18',
    categories: ['fabric-sofas', 'all-sofas', '3-seater-sofas', 'new-arrivals'],
    specs: [
      { attribute: 'WOOD_TYPE', value: 'sheesham' },
      { attribute: 'FILLING', value: 'hr_foam' },
      { attribute: 'WARRANTY', value: '3_years' },
      { attribute: 'ASSEMBLY_TYPE', value: 'pre_assembled' },
    ],
    variantAttributes: ['COLOUR', 'FABRIC'],
    variants: [
      {
        suffix: 'BEI-COT',
        attributes: { COLOUR: 'beige', FABRIC: 'cotton' },
        isDefault: true,
        stockQty: 6,
      },
      {
        suffix: 'BEI-VEL',
        attributes: { COLOUR: 'beige', FABRIC: 'velvet' },
        pricePaise: 4899900,
        stockQty: 3,
      },
      { suffix: 'OLI-COT', attributes: { COLOUR: 'olive', FABRIC: 'cotton' }, stockQty: 4 },
      {
        suffix: 'OLI-BOU',
        attributes: { COLOUR: 'olive', FABRIC: 'boucle' },
        pricePaise: 4999900,
        stockQty: 2,
      },
      { suffix: 'CHA-CHE', attributes: { COLOUR: 'charcoal', FABRIC: 'chenille' }, stockQty: 5 },
      {
        suffix: 'RUS-VEL',
        attributes: { COLOUR: 'rust', FABRIC: 'velvet' },
        pricePaise: 4899900,
        stockQty: 1,
      },
    ],
    warrantyMonths: 36,
    manufacturingNote: IN_HOUSE,
    careInstructions: 'Vacuum weekly. Blot spills; do not soak. Professional cleaning once a year.',
    isFeatured: true,
    isNewArrival: true,
    isBestSeller: true,
    soldCount: 214,
    ratingAvgBp: 46000,
    ratingCount: 87,
    lengthMm: 2130,
    widthMm: 890,
    heightMm: 830,
    seatHeightMm: 430,
    weightGrams: 68000,
  },
  {
    sku: 'CW-SOF-MALABAR',
    slug: 'malabar-l-shaped-sofa',
    name: 'Malabar L-Shaped Sofa',
    subtitle: 'Right-hand chaise, reversible back cushions',
    shortDescription: 'A deep L-shape for long evenings, with a reversible chaise.',
    description:
      'The Malabar seats five comfortably and still leaves a walkway. The chaise side can be ' +
      'ordered left or right at no extra cost because we cut every frame to order.',
    productType: 'VARIABLE',
    basePricePaise: 8999900,
    taxClassCode: 'GST_18',
    categories: ['l-shaped-sofas', 'all-sofas', 'contemporary-sofas'],
    specs: [
      { attribute: 'WOOD_TYPE', value: 'teak' },
      { attribute: 'FILLING', value: 'hr_foam' },
      { attribute: 'ARM_STYLE', value: 'track_arm' },
      { attribute: 'WARRANTY', value: '5_years' },
    ],
    variantAttributes: ['COLOUR'],
    variants: [
      { suffix: 'GRY', attributes: { COLOUR: 'grey' }, isDefault: true, stockQty: 3 },
      { suffix: 'NAV', attributes: { COLOUR: 'navy' }, stockQty: 2 },
      { suffix: 'IVO', attributes: { COLOUR: 'ivory' }, pricePaise: 9299900, stockQty: 1 },
    ],
    warrantyMonths: 60,
    manufacturingNote: IN_HOUSE,
    isFeatured: true,
    soldCount: 96,
    ratingAvgBp: 44000,
    ratingCount: 41,
    lengthMm: 2740,
    widthMm: 1680,
    heightMm: 850,
    seatHeightMm: 440,
  },
  {
    sku: 'CW-SOF-CHESTER',
    slug: 'teakwood-chesterfield-leather-sofa',
    name: 'Teakwood Chesterfield Leather Sofa',
    subtitle: 'Full-grain hide, hand-buttoned back',
    shortDescription: 'A classic chesterfield in full-grain leather over a teak frame.',
    description:
      'Every button on the Malabar chesterfield is set by hand. The hide is full-grain and ' +
      'develops a patina rather than cracking. Frame in seasoned teak, built to outlive the sofa.',
    productType: 'VARIABLE',
    basePricePaise: 12499900,
    compareAtPricePaise: 13999900,
    taxClassCode: 'GST_18',
    categories: ['leather-sofas', 'all-sofas', 'special-collection-sofas'],
    specs: [
      { attribute: 'WOOD_TYPE', value: 'teak' },
      { attribute: 'BACK_STYLE', value: 'tufted_back' },
      { attribute: 'WARRANTY', value: '10_years' },
    ],
    variantAttributes: ['COLOUR', 'FABRIC'],
    variants: [
      {
        suffix: 'TAN-GEN',
        attributes: { COLOUR: 'tan', FABRIC: 'genuine_leather' },
        isDefault: true,
        stockQty: 2,
      },
      { suffix: 'WIN-GEN', attributes: { COLOUR: 'wine', FABRIC: 'genuine_leather' }, stockQty: 1 },
      {
        suffix: 'CHA-LEA',
        attributes: { COLOUR: 'charcoal', FABRIC: 'leatherette' },
        pricePaise: 10999900,
        stockQty: 4,
      },
      {
        suffix: 'WAL-LEA',
        attributes: { COLOUR: 'walnut_brown', FABRIC: 'leatherette' },
        pricePaise: 10999900,
        stockQty: 3,
      },
    ],
    warrantyMonths: 120,
    manufacturingNote: IN_HOUSE,
    careInstructions: 'Condition the leather every six months. Keep out of direct sunlight.',
    isSpecialCollection: true,
    soldCount: 38,
    ratingAvgBp: 48000,
    ratingCount: 22,
    lengthMm: 2130,
    widthMm: 940,
    heightMm: 790,
  },
  {
    sku: 'CW-CHR-ARJUN',
    slug: 'arjun-wingback-lounge-chair',
    name: 'Arjun Wingback Lounge Chair',
    subtitle: 'High back, tapered walnut legs',
    shortDescription: 'A reading chair with a high wing back and a firm seat.',
    description:
      'Built on a solid mango wood frame with tapered legs turned in-house. The wings are shaped ' +
      'on a jig so every chair matches the last.',
    productType: 'VARIABLE',
    basePricePaise: 2199900,
    taxClassCode: 'GST_18',
    categories: ['wingback-chairs', 'all-chairs', 'lounge-chairs'],
    specs: [
      { attribute: 'WOOD_TYPE', value: 'mango_wood' },
      { attribute: 'LEG_TYPE', value: 'wooden_tapered' },
      { attribute: 'FILLING', value: 'hr_foam' },
      { attribute: 'WARRANTY', value: '2_years' },
    ],
    variantAttributes: ['COLOUR'],
    variants: [
      { suffix: 'MUS', attributes: { COLOUR: 'mustard' }, isDefault: true, stockQty: 8 },
      { suffix: 'OLI', attributes: { COLOUR: 'olive' }, stockQty: 6 },
      { suffix: 'NAV', attributes: { COLOUR: 'navy' }, stockQty: 5 },
      { suffix: 'OFF', attributes: { COLOUR: 'off_white' }, stockQty: 4 },
    ],
    warrantyMonths: 24,
    manufacturingNote: IN_HOUSE,
    isBestSeller: true,
    soldCount: 310,
    ratingAvgBp: 45000,
    ratingCount: 129,
    lengthMm: 820,
    widthMm: 860,
    heightMm: 1120,
    seatHeightMm: 450,
  },
  {
    sku: 'CW-CHR-NILGIRI',
    slug: 'nilgiri-rocking-chair',
    name: 'Nilgiri Rocking Chair',
    subtitle: 'Steam-bent runners, cane back',
    shortDescription: 'A caned rocking chair with steam-bent runners.',
    description:
      'The runners are steam-bent in our workshop and balanced by hand so the chair returns to ' +
      'rest rather than tipping. Cane is hand-woven.',
    productType: 'VARIABLE',
    basePricePaise: 1899900,
    taxClassCode: 'GST_12',
    categories: ['rocking-chairs', 'all-chairs'],
    specs: [
      { attribute: 'WOOD_TYPE', value: 'teak' },
      { attribute: 'BACK_STYLE', value: 'cane_back' },
      { attribute: 'ASSEMBLY_TYPE', value: 'pre_assembled' },
    ],
    variantAttributes: ['WOOD_FINISH'],
    variants: [
      { suffix: 'NAT', attributes: { WOOD_FINISH: 'natural' }, isDefault: true, stockQty: 5 },
      { suffix: 'HON', attributes: { WOOD_FINISH: 'honey' }, stockQty: 4 },
      { suffix: 'ESP', attributes: { WOOD_FINISH: 'espresso' }, stockQty: 3 },
    ],
    warrantyMonths: 24,
    manufacturingNote: IN_HOUSE,
    soldCount: 74,
    ratingAvgBp: 43000,
    ratingCount: 30,
    lengthMm: 1080,
    widthMm: 620,
    heightMm: 1040,
  },
  {
    sku: 'CW-SEA-MAHSEER',
    slug: 'mahseer-counter-stool',
    name: 'Mahseer Counter Stool',
    subtitle: 'Upholstered seat, black metal frame',
    shortDescription: 'A counter-height stool with a padded seat and a powder-coated frame.',
    description:
      'Welded and powder-coated in-house, then upholstered on the same floor. Floor glides are ' +
      'replaceable rather than moulded in.',
    productType: 'VARIABLE',
    basePricePaise: 749900,
    taxClassCode: 'GST_18',
    categories: ['stools', 'all-seating'],
    specs: [
      { attribute: 'LEG_TYPE', value: 'metal_black' },
      { attribute: 'FILLING', value: 'hr_foam' },
      { attribute: 'ASSEMBLY_TYPE', value: 'knock_down' },
    ],
    variantAttributes: ['COLOUR'],
    variants: [
      { suffix: 'CHA', attributes: { COLOUR: 'charcoal' }, isDefault: true, stockQty: 22 },
      { suffix: 'TAN', attributes: { COLOUR: 'tan' }, stockQty: 18 },
      { suffix: 'IVO', attributes: { COLOUR: 'ivory' }, stockQty: 12 },
    ],
    warrantyMonths: 12,
    assemblyRequired: true,
    manufacturingNote: IN_HOUSE,
    soldCount: 402,
    ratingAvgBp: 42000,
    ratingCount: 156,
    lengthMm: 420,
    widthMm: 420,
    heightMm: 960,
    seatHeightMm: 660,
  },
  {
    sku: 'CW-SEA-KONARK',
    slug: 'konark-storage-bench',
    name: 'Konark Storage Bench',
    subtitle: 'Soft-close lid, cedar-lined box',
    shortDescription: 'An entryway bench with a cedar-lined storage box under the seat.',
    description:
      'Dovetailed box, soft-close hardware and a cedar lining that keeps linen fresh. Finished in ' +
      'our own spray booth.',
    productType: 'VARIABLE',
    basePricePaise: 1299900,
    taxClassCode: 'GST_12',
    categories: ['benches', 'all-seating', 'new-arrivals'],
    specs: [
      { attribute: 'WOOD_TYPE', value: 'acacia' },
      { attribute: 'WARRANTY', value: '3_years' },
    ],
    variantAttributes: ['WOOD_FINISH'],
    variants: [
      { suffix: 'WAL', attributes: { WOOD_FINISH: 'walnut' }, isDefault: true, stockQty: 7 },
      { suffix: 'WHI', attributes: { WOOD_FINISH: 'whitewash' }, stockQty: 5 },
      {
        suffix: 'MAT',
        attributes: { WOOD_FINISH: 'matte_black' },
        pricePaise: 1399900,
        stockQty: 3,
      },
    ],
    warrantyMonths: 36,
    manufacturingNote: IN_HOUSE,
    isNewArrival: true,
    soldCount: 58,
    ratingAvgBp: 44000,
    ratingCount: 19,
    lengthMm: 1200,
    widthMm: 400,
    heightMm: 460,
  },
  {
    sku: 'CW-TAB-BANYAN',
    slug: 'banyan-live-edge-coffee-table',
    name: 'Banyan Live-Edge Coffee Table',
    subtitle: 'Single slab top, hairpin or block legs',
    shortDescription: 'A live-edge slab top on your choice of legs.',
    description:
      'Each top is a single slab, so the grain is never repeated. We stabilise, plane and finish ' +
      'every slab ourselves — no outsourced blanks.',
    productType: 'VARIABLE',
    basePricePaise: 3499900,
    compareAtPricePaise: 3999900,
    taxClassCode: 'GST_18',
    categories: ['coffee-tables', 'all-tables', 'new-arrivals'],
    specs: [
      { attribute: 'WOOD_TYPE', value: 'acacia' },
      { attribute: 'ASSEMBLY_TYPE', value: 'knock_down' },
      { attribute: 'WARRANTY', value: '5_years' },
    ],
    variantAttributes: ['WOOD_FINISH', 'SIZE'],
    variants: [
      {
        suffix: 'NAT-48',
        attributes: { WOOD_FINISH: 'natural', SIZE: '48_x_24' },
        isDefault: true,
        stockQty: 4,
      },
      {
        suffix: 'NAT-60',
        attributes: { WOOD_FINISH: 'natural', SIZE: '60_x_30' },
        pricePaise: 3999900,
        stockQty: 2,
      },
      { suffix: 'HON-48', attributes: { WOOD_FINISH: 'honey', SIZE: '48_x_24' }, stockQty: 3 },
      {
        suffix: 'HON-60',
        attributes: { WOOD_FINISH: 'honey', SIZE: '60_x_30' },
        pricePaise: 3999900,
        stockQty: 1,
      },
    ],
    warrantyMonths: 60,
    assemblyRequired: true,
    manufacturingNote: IN_HOUSE,
    isFeatured: true,
    isNewArrival: true,
    soldCount: 64,
    ratingAvgBp: 47000,
    ratingCount: 26,
    lengthMm: 1220,
    widthMm: 610,
    heightMm: 450,
  },
  {
    sku: 'CW-TAB-ASHOKA',
    slug: 'ashoka-nesting-table-set',
    name: 'Ashoka Nesting Table Set',
    subtitle: 'Set of three, brass-tipped legs',
    shortDescription: 'Three nesting tables that tuck away to a single footprint.',
    description: 'Turned legs with brass tips, lacquered to resist ring marks.',
    productType: 'VARIABLE',
    basePricePaise: 1799900,
    taxClassCode: 'GST_12',
    categories: ['nesting-tables', 'all-tables'],
    specs: [
      { attribute: 'WOOD_TYPE', value: 'sheesham' },
      { attribute: 'LEG_TYPE', value: 'metal_golden' },
    ],
    variantAttributes: ['WOOD_FINISH'],
    variants: [
      { suffix: 'HON', attributes: { WOOD_FINISH: 'honey' }, isDefault: true, stockQty: 9 },
      { suffix: 'WAL', attributes: { WOOD_FINISH: 'walnut' }, stockQty: 6 },
      { suffix: 'ESP', attributes: { WOOD_FINISH: 'espresso' }, stockQty: 4 },
    ],
    warrantyMonths: 24,
    manufacturingNote: IN_HOUSE,
    soldCount: 141,
    ratingAvgBp: 43000,
    ratingCount: 52,
    lengthMm: 500,
    widthMm: 400,
    heightMm: 560,
  },
  {
    sku: 'CW-DIN-SAHYADRI',
    slug: 'sahyadri-6-seater-dining-set',
    name: 'Sahyadri 6-Seater Dining Set',
    subtitle: 'Solid top, six upholstered chairs',
    shortDescription: 'A six-seater dining set with a solid top and caned chair backs.',
    description:
      'The table top is a glued-up solid panel, not veneer over board. Chairs are mortise-and-' +
      'tenon jointed and caned by hand.',
    productType: 'VARIABLE',
    basePricePaise: 8999900,
    compareAtPricePaise: 9999900,
    taxClassCode: 'GST_18',
    categories: ['6-seater-dining-sets', 'all-dining-sets'],
    specs: [
      { attribute: 'WOOD_TYPE', value: 'sheesham' },
      { attribute: 'SEATER', value: '6_seater' },
      { attribute: 'WARRANTY', value: '5_years' },
    ],
    variantAttributes: ['WOOD_FINISH'],
    variants: [
      { suffix: 'HON', attributes: { WOOD_FINISH: 'honey' }, isDefault: true, stockQty: 3 },
      { suffix: 'WAL', attributes: { WOOD_FINISH: 'walnut' }, stockQty: 2 },
      { suffix: 'NAT', attributes: { WOOD_FINISH: 'natural' }, stockQty: 2 },
    ],
    warrantyMonths: 60,
    assemblyRequired: true,
    manufacturingNote: IN_HOUSE,
    isBestSeller: true,
    soldCount: 87,
    ratingAvgBp: 46000,
    ratingCount: 44,
    lengthMm: 1830,
    widthMm: 910,
    heightMm: 760,
  },
  {
    sku: 'CW-REC-KAVERI',
    slug: 'kaveri-3-seater-recliner',
    name: 'Kaveri 3-Seater Recliner',
    subtitle: 'Manual recline, independent footrests',
    shortDescription: 'Three independent recline positions with a lumbar-supported back.',
    description:
      'Italian recline mechanism fitted to a frame we build ourselves, so the seat height and ' +
      'depth suit Indian rooms rather than a generic import.',
    productType: 'VARIABLE',
    basePricePaise: 10999900,
    taxClassCode: 'GST_18',
    categories: ['triple-seater-recliners', 'all-recliners'],
    specs: [
      { attribute: 'FILLING', value: 'hr_foam' },
      { attribute: 'SEATER', value: '3_seater' },
      { attribute: 'WARRANTY', value: '3_years' },
    ],
    variantAttributes: ['COLOUR'],
    variants: [
      { suffix: 'CHA', attributes: { COLOUR: 'charcoal' }, isDefault: true, stockQty: 2 },
      { suffix: 'TAN', attributes: { COLOUR: 'tan' }, stockQty: 2 },
      { suffix: 'GRY', attributes: { COLOUR: 'grey' }, stockQty: 1 },
    ],
    warrantyMonths: 36,
    manufacturingNote: IN_HOUSE,
    soldCount: 51,
    ratingAvgBp: 45000,
    ratingCount: 23,
    lengthMm: 2130,
    widthMm: 980,
    heightMm: 1020,
    seatHeightMm: 460,
  },
  {
    sku: 'CW-MAT-ORTHOZEN',
    slug: 'ortho-zen-pocket-spring-mattress',
    name: 'Ortho-Zen Pocket Spring Mattress',
    subtitle: 'Zoned pocket springs, memory foam top',
    shortDescription: 'A zoned pocket-spring mattress with a memory foam comfort layer.',
    description:
      'Seven-zone pocket springs under a 40mm memory foam layer, quilted in a breathable knit ' +
      'cover. Assembled and quilted in our own unit.',
    productType: 'VARIABLE',
    basePricePaise: 2999900,
    compareAtPricePaise: 3599900,
    taxClassCode: 'GST_12',
    categories: ['ortho-zen-mattresses', 'all-mattresses', 'king-mattresses'],
    specs: [
      { attribute: 'FILLING', value: 'pocket_spring' },
      { attribute: 'CUSHION_FIRMNESS', value: 'firm' },
      { attribute: 'WARRANTY', value: '10_years' },
    ],
    variantAttributes: ['MATTRESS_SIZE'],
    variants: [
      {
        suffix: 'KIN',
        attributes: { MATTRESS_SIZE: 'king_72_x_78' },
        pricePaise: 3499900,
        isDefault: true,
        stockQty: 6,
      },
      { suffix: 'QUE', attributes: { MATTRESS_SIZE: 'queen_60_x_78' }, stockQty: 8 },
      {
        suffix: 'DOU',
        attributes: { MATTRESS_SIZE: 'double_48_x_75' },
        pricePaise: 2599900,
        stockQty: 7,
      },
      {
        suffix: 'SIN',
        attributes: { MATTRESS_SIZE: 'single_36_x_75' },
        pricePaise: 1999900,
        stockQty: 10,
      },
    ],
    warrantyMonths: 120,
    manufacturingNote: IN_HOUSE,
    careInstructions: 'Rotate head-to-toe every three months. Do not fold.',
    isBestSeller: true,
    soldCount: 268,
    ratingAvgBp: 44000,
    ratingCount: 112,
  },
  {
    sku: 'CW-OUT-COORG',
    slug: 'coorg-outdoor-lounger',
    name: 'Coorg Outdoor Lounger',
    subtitle: 'Marine-grade weave, quick-dry foam',
    shortDescription: 'A poolside lounger in marine-grade weave with quick-dry cushions.',
    description:
      'UV-stabilised weave over a powder-coated aluminium frame, with quick-dry reticulated foam ' +
      'cushions that shed water instead of holding it.',
    productType: 'VARIABLE',
    basePricePaise: 2499900,
    taxClassCode: 'GST_18',
    categories: ['outdoor-loungers', 'all-outdoor-sets'],
    specs: [
      { attribute: 'FABRIC', value: 'outdoor_weave' },
      { attribute: 'ASSEMBLY_TYPE', value: 'pre_assembled' },
      { attribute: 'WARRANTY', value: '2_years' },
    ],
    variantAttributes: ['COLOUR'],
    variants: [
      { suffix: 'GRY', attributes: { COLOUR: 'grey' }, isDefault: true, stockQty: 6 },
      { suffix: 'BEI', attributes: { COLOUR: 'beige' }, stockQty: 4 },
      { suffix: 'OLI', attributes: { COLOUR: 'olive' }, stockQty: 3 },
    ],
    warrantyMonths: 24,
    manufacturingNote: IN_HOUSE,
    soldCount: 44,
    ratingAvgBp: 41000,
    ratingCount: 17,
    lengthMm: 1980,
    widthMm: 700,
    heightMm: 360,
  },
  {
    sku: 'CW-SOF-MYO-MOD',
    slug: 'make-your-own-modular-sofa',
    name: 'Make Your Own Modular Sofa',
    subtitle: 'Your size, your fabric, your seat feel',
    shortDescription:
      'Choose the length, arm style, fabric and cushion feel — we build it to order.',
    description:
      'Nothing about this sofa is pre-decided. Pick the module count, arm profile, leg and fabric; ' +
      'the workshop cuts the frame to those numbers. Because we manufacture in-house with zero ' +
      'outsourcing, a bespoke build costs no more than a standard one.',
    productType: 'MADE_TO_ORDER',
    basePricePaise: 5999900,
    taxClassCode: 'GST_18',
    categories: ['make-your-own-sofas', 'all-sofas'],
    specs: [
      { attribute: 'WOOD_TYPE', value: 'sheesham' },
      { attribute: 'FILLING', value: 'hr_foam' },
      { attribute: 'ASSEMBLY_TYPE', value: 'modular' },
      { attribute: 'WARRANTY', value: '5_years' },
    ],
    variantAttributes: ['SEATER'],
    variants: [
      {
        suffix: '2S',
        attributes: { SEATER: '2_seater' },
        pricePaise: 4999900,
        stockQty: 0,
        leadTimeDays: 28,
      },
      {
        suffix: '3S',
        attributes: { SEATER: '3_seater' },
        isDefault: true,
        stockQty: 0,
        leadTimeDays: 28,
      },
      {
        suffix: 'LSH',
        attributes: { SEATER: 'l_shaped' },
        pricePaise: 8499900,
        stockQty: 0,
        leadTimeDays: 35,
      },
    ],
    warrantyMonths: 60,
    leadTimeDays: 28,
    isMadeToOrder: true,
    allowCustomization: true,
    manufacturingNote: IN_HOUSE,
    isFeatured: true,
    isSpecialCollection: true,
    soldCount: 29,
    ratingAvgBp: 48000,
    ratingCount: 12,
  },
];

/** The full demo shelf: the showcase pieces first, then the breadth the facets need. */
export const DEMO_PRODUCTS: SeedProduct[] = [...CORE_DEMO_PRODUCTS, ...EXTRA_DEMO_PRODUCTS];

/**
 * Stored and validated in this prompt; RESOLVED by the Prompt 6 PricingEngine.
 * Negative values are discounts.
 */
export const DEMO_PRICE_ADJUSTMENTS: SeedPriceAdjustment[] = [
  {
    name: 'Genuine leather upgrade',
    scope: 'ATTRIBUTE_VALUE',
    adjustmentType: 'FIXED_AMOUNT',
    basis: 'BASE',
    priority: 10,
    valuePaise: 450000,
    attributeCode: 'FABRIC',
    attributeValueCode: 'genuine_leather',
    note: 'Full-grain hide costs more per metre than any woven fabric.',
  },
  {
    name: '3-seater size multiplier',
    scope: 'ATTRIBUTE_VALUE',
    adjustmentType: 'MULTIPLIER',
    basis: 'BASE',
    priority: 20,
    valueBp: 13000,
    attributeCode: 'SEATER',
    attributeValueCode: '3_seater',
    note: '1.3x the base frame price.',
  },
  {
    name: 'Festive season — 10% off sofas',
    scope: 'CATEGORY',
    adjustmentType: 'PERCENT',
    basis: 'RUNNING_SUBTOTAL',
    priority: 50,
    valueBp: -1000,
    categorySlug: 'sofas',
    startsAt: '2026-10-01T00:00:00.000Z',
    endsAt: '2026-11-15T23:59:59.000Z',
  },
  {
    name: 'Kabir launch discount',
    scope: 'PRODUCT',
    adjustmentType: 'FIXED_AMOUNT',
    basis: 'RUNNING_SUBTOTAL',
    priority: 60,
    valuePaise: -200000,
    productSlug: 'kabir-3-seater-fabric-sofa',
  },
  {
    name: 'King mattress clearance',
    scope: 'VARIANT',
    adjustmentType: 'PERCENT',
    basis: 'RUNNING_SUBTOTAL',
    priority: 55,
    valueBp: -500,
    variantSku: 'CW-MAT-ORTHOZEN-KIN',
  },
  // The three below complete the matrix: every adjustmentType x basis combination is now seeded,
  // so the Prompt 6 engine tests always have live data to work against.
  {
    name: 'Protective crating (per unit)',
    scope: 'CATEGORY',
    adjustmentType: 'PER_UNIT',
    basis: 'BASE',
    priority: 15,
    valuePaise: 30000,
    categorySlug: 'mattresses',
    note: 'Corner guards and a moisture wrap on every mattress we ship.',
  },
  {
    name: 'Walnut finish premium',
    scope: 'ATTRIBUTE_VALUE',
    adjustmentType: 'PERCENT',
    basis: 'BASE',
    priority: 12,
    valueBp: 500,
    attributeCode: 'WOOD_FINISH',
    attributeValueCode: 'walnut',
    note: '5% of the base price — walnut stain and the extra sanding pass it needs.',
  },
  {
    name: '2-seater size factor',
    scope: 'ATTRIBUTE_VALUE',
    adjustmentType: 'MULTIPLIER',
    basis: 'RUNNING_SUBTOTAL',
    priority: 22,
    valueBp: 8000,
    attributeCode: 'SEATER',
    attributeValueCode: '2_seater',
    note: '0.8x the running price — less frame, less fabric, less foam.',
  },
];
