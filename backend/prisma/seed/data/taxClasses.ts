/** Pure data. GST rates are basis points: 18% = 1800. HSN 9401 = seating, 9403 = other furniture. */

export interface SeedTaxClass {
  code: string;
  name: string;
  rateBp: number;
  hsnCode: string;
  isDefault: boolean;
}

export const TAX_CLASSES: SeedTaxClass[] = [
  { code: 'GST_18', name: 'GST 18%', rateBp: 1800, hsnCode: '9401', isDefault: true },
  { code: 'GST_12', name: 'GST 12%', rateBp: 1200, hsnCode: '9403', isDefault: false },
  { code: 'GST_5', name: 'GST 5%', rateBp: 500, hsnCode: '9403', isDefault: false },
  { code: 'GST_0', name: 'GST 0% (exempt)', rateBp: 0, hsnCode: '9401', isDefault: false },
];
