import type { AttributeInput, AttributeDataType } from '@shared/enums';

/** Pure data — no Prisma, no imports from the seed runner. */

export interface SeedAttributeValue {
  code: string;
  label: string;
  colorHex?: string;
  numericValue?: number;
}

export interface SeedAttribute {
  code: string;
  name: string;
  groupCode: string;
  inputType: AttributeInput;
  dataType?: AttributeDataType;
  unit?: string;
  isVariantDefining?: boolean;
  isFilterable?: boolean;
  isSearchable?: boolean;
  isComparable?: boolean;
  showInSwatch?: boolean;
  helpText?: string;
  values: SeedAttributeValue[];
}

export const ATTRIBUTE_GROUPS = [
  { code: 'APPEARANCE', name: 'Appearance' },
  { code: 'MATERIAL', name: 'Material' },
  { code: 'DIMENSIONS', name: 'Dimensions' },
  { code: 'COMFORT', name: 'Comfort' },
  { code: 'CONSTRUCTION', name: 'Construction' },
] as const;

const value = (label: string, extra: Partial<SeedAttributeValue> = {}): SeedAttributeValue => ({
  code: label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, ''),
  label,
  ...extra,
});

export const ATTRIBUTES: SeedAttribute[] = [
  {
    code: 'COLOUR',
    name: 'Colour',
    groupCode: 'APPEARANCE',
    inputType: 'SWATCH_COLOR',
    isVariantDefining: true,
    showInSwatch: true,
    isComparable: true,
    helpText: 'Upholstery or finish colour.',
    values: [
      value('Beige', { colorHex: '#D9CBB3' }),
      value('Ivory', { colorHex: '#F3EDE3' }),
      value('Charcoal', { colorHex: '#36383B' }),
      value('Grey', { colorHex: '#9AA0A6' }),
      value('Walnut Brown', { colorHex: '#6B4A33' }),
      value('Tan', { colorHex: '#B5743F' }),
      value('Rust', { colorHex: '#B4613A' }),
      value('Olive', { colorHex: '#7E8C77' }),
      value('Navy', { colorHex: '#2C3E55' }),
      value('Mustard', { colorHex: '#C9932F' }),
      value('Wine', { colorHex: '#7A2E3A' }),
      value('Off-White', { colorHex: '#FAF7F2' }),
    ],
  },
  {
    code: 'FABRIC',
    name: 'Fabric',
    groupCode: 'MATERIAL',
    inputType: 'SELECT',
    isVariantDefining: true,
    isComparable: true,
    values: [
      value('Cotton'),
      value('Linen'),
      value('Velvet'),
      value('Chenille'),
      value('Jacquard'),
      value('Suede'),
      value('Boucle'),
      value('Leatherette'),
      value('Genuine Leather'),
      value('Polyester Blend'),
      value('Outdoor Weave'),
    ],
  },
  {
    code: 'WOOD_TYPE',
    name: 'Wood type',
    groupCode: 'MATERIAL',
    inputType: 'SELECT',
    isComparable: true,
    isSearchable: true,
    values: [
      value('Sheesham'),
      value('Teak'),
      value('Mango Wood'),
      value('Rubber Wood'),
      value('Engineered Wood'),
      value('Acacia'),
    ],
  },
  {
    code: 'WOOD_FINISH',
    name: 'Wood finish',
    groupCode: 'APPEARANCE',
    inputType: 'SWATCH_IMAGE',
    isVariantDefining: true,
    showInSwatch: true,
    values: [
      value('Natural'),
      value('Honey'),
      value('Walnut'),
      value('Espresso'),
      value('Whitewash'),
      value('Matte Black'),
    ],
  },
  {
    code: 'SEATER',
    name: 'Seating capacity',
    groupCode: 'DIMENSIONS',
    inputType: 'SELECT',
    dataType: 'NUMBER',
    isVariantDefining: true,
    isComparable: true,
    values: [
      value('1 Seater', { numericValue: 1 }),
      value('2 Seater', { numericValue: 2 }),
      value('3 Seater', { numericValue: 3 }),
      value('4 Seater', { numericValue: 4 }),
      value('5 Seater', { numericValue: 5 }),
      value('6 Seater', { numericValue: 6 }),
      value('7 Seater', { numericValue: 7 }),
      value('8 Seater', { numericValue: 8 }),
      value('9 Seater', { numericValue: 9 }),
      value('3+1+1', { numericValue: 5 }),
      value('L-Shaped'),
      value('U-Shaped'),
    ],
  },
  {
    code: 'SIZE',
    name: 'Size',
    groupCode: 'DIMENSIONS',
    inputType: 'SELECT',
    unit: 'inch',
    isVariantDefining: true,
    values: [
      value('24 x 24'),
      value('36 x 18'),
      value('42 x 24'),
      value('48 x 24'),
      value('60 x 30'),
      value('72 x 36'),
      value('Custom'),
    ],
  },
  {
    code: 'MATTRESS_SIZE',
    name: 'Mattress size',
    groupCode: 'DIMENSIONS',
    inputType: 'SELECT',
    unit: 'inch',
    isVariantDefining: true,
    isComparable: true,
    values: [
      value('King 72 x 78'),
      value('Queen 60 x 78'),
      value('Double 48 x 75'),
      value('Single 36 x 75'),
      value('Custom'),
    ],
  },
  {
    code: 'LEG_TYPE',
    name: 'Leg type',
    groupCode: 'CONSTRUCTION',
    inputType: 'SELECT',
    values: [
      value('Wooden Tapered'),
      value('Wooden Block'),
      value('Metal Golden'),
      value('Metal Black'),
      value('Hidden'),
    ],
  },
  {
    code: 'CUSHION_FIRMNESS',
    name: 'Cushion firmness',
    groupCode: 'COMFORT',
    inputType: 'SELECT',
    isComparable: true,
    values: [value('Soft'), value('Medium'), value('Firm'), value('Extra Firm')],
  },
  {
    code: 'FILLING',
    name: 'Filling',
    groupCode: 'COMFORT',
    inputType: 'SELECT',
    isComparable: true,
    isSearchable: true,
    values: [
      value('HR Foam'),
      value('Memory Foam'),
      value('Duck Feather'),
      value('Fibre'),
      value('Coir'),
      value('Bonnell Spring'),
      value('Pocket Spring'),
    ],
  },
  {
    code: 'ARM_STYLE',
    name: 'Arm style',
    groupCode: 'CONSTRUCTION',
    inputType: 'SELECT',
    values: [
      value('Track Arm'),
      value('Rolled Arm'),
      value('Flared Arm'),
      value('Sloped Arm'),
      value('Armless'),
      value('Wooden Arm'),
    ],
  },
  {
    code: 'BACK_STYLE',
    name: 'Back style',
    groupCode: 'CONSTRUCTION',
    inputType: 'SELECT',
    values: [
      value('Tufted Back'),
      value('Channel Back'),
      value('Pillow Back'),
      value('Tight Back'),
      value('Cane Back'),
    ],
  },
  {
    code: 'ASSEMBLY_TYPE',
    name: 'Assembly',
    groupCode: 'CONSTRUCTION',
    inputType: 'SELECT',
    values: [
      value('Pre-assembled'),
      value('Knock-down'),
      value('Modular'),
      value('Carpenter Assembly'),
    ],
  },
  {
    code: 'WARRANTY',
    name: 'Warranty',
    groupCode: 'CONSTRUCTION',
    inputType: 'SELECT',
    dataType: 'NUMBER',
    isComparable: true,
    helpText: 'Manufacturer warranty in months.',
    values: [
      value('1 Year', { numericValue: 12 }),
      value('2 Years', { numericValue: 24 }),
      value('3 Years', { numericValue: 36 }),
      value('5 Years', { numericValue: 60 }),
      value('10 Years', { numericValue: 120 }),
    ],
  },
];
