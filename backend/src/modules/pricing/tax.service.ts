import type { PricingSettings, PricingTaxClass, TaxSplit } from '@shared/types/pricing';
import { applyBasisPoints, splitGst, taxFromInclusive } from '@shared/money';

import { prisma } from '../../config/prisma';
import { notDeleted } from '../../repositories/helpers';

/**
 * GST resolution.
 *
 * The maths itself is pure and lives in shared/money (`applyBasisPoints`, `taxFromInclusive`,
 * `splitGst`) so the engine can use it without any I/O; this service is the database side —
 * looking up tax classes and deciding the place of supply.
 *
 * Place of supply: seller state vs the customer's shipping state. Same state means CGST + SGST at
 * half the rate each; different means IGST at the full rate. An unknown state falls back to the
 * configured default and the breakdown flags it.
 */

export interface PlaceOfSupplyDecision {
  sellerStateCode: string;
  buyerStateCode: string;
  isIntraState: boolean;
  isFallback: boolean;
}

export const taxService = {
  async findTaxClass(id: string | null): Promise<PricingTaxClass | null> {
    if (!id) return null;
    const row = await prisma.taxClass.findFirst({ where: { id, ...notDeleted } });
    return row ? toDto(row) : null;
  },

  async findByCode(code: string): Promise<PricingTaxClass | null> {
    const row = await prisma.taxClass.findFirst({ where: { code, ...notDeleted } });
    return row ? toDto(row) : null;
  },

  /** Products without a tax class fall back to the default one, then to a zero-rated stand-in. */
  async defaultTaxClass(): Promise<PricingTaxClass> {
    const row =
      (await prisma.taxClass.findFirst({ where: { isDefault: true, ...notDeleted } })) ??
      (await prisma.taxClass.findFirst({ where: { isActive: true, ...notDeleted } }));

    return row ? toDto(row) : { id: 'none', code: 'GST_0', rateBp: 0, hsnCode: null };
  },

  async allTaxClasses(): Promise<PricingTaxClass[]> {
    const rows = await prisma.taxClass.findMany({ where: notDeleted, orderBy: { rateBp: 'asc' } });
    return rows.map(toDto);
  },

  placeOfSupply(settings: PricingSettings, buyerStateCode: string | null): PlaceOfSupplyDecision {
    const seller = settings.sellerStateCode.toUpperCase();
    const buyer = (buyerStateCode ?? settings.defaultPlaceOfSupply).toUpperCase();

    return {
      sellerStateCode: seller,
      buyerStateCode: buyer,
      isIntraState: seller === buyer,
      isFallback: buyerStateCode === null,
    };
  },

  /** Tax on one amount, honouring the inclusive/exclusive setting. */
  computeTax(
    amountPaise: number,
    rateBp: number,
    pricesIncludeTax: boolean,
  ): { taxPaise: number; taxablePaise: number } {
    if (pricesIncludeTax) {
      const taxPaise = taxFromInclusive(amountPaise, rateBp);
      return { taxPaise, taxablePaise: amountPaise - taxPaise };
    }
    return { taxPaise: applyBasisPoints(amountPaise, rateBp), taxablePaise: amountPaise };
  },

  split(taxPaise: number, isIntraState: boolean): TaxSplit {
    return splitGst(taxPaise, isIntraState);
  },
};

function toDto(row: {
  id: string;
  code: string;
  rateBp: number;
  hsnCode: string | null;
}): PricingTaxClass {
  return { id: row.id, code: row.code, rateBp: row.rateBp, hsnCode: row.hsnCode };
}
