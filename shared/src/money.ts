import { CURRENCY, CURRENCY_LOCALE, CURRENCY_SYMBOL } from './constants';
import type { SplitMode } from './enums';

/**
 * D5 — money is ALWAYS an integer number of paise. Nothing in this file returns a float amount of
 * money; `toRupees` exists only for the UI edge.
 */

export const PAISE_PER_RUPEE = 100;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function isPaise(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function assertPaise(value: unknown, label = 'amount'): asserts value is number {
  if (!isPaise(value)) {
    throw new MoneyError(
      `${label} must be a safe integer number of paise, received ${String(value)}`,
    );
  }
}

/** Rupees (possibly fractional, e.g. from an admin form) -> integer paise. */
export function toPaise(rupees: number): number {
  if (typeof rupees !== 'number' || !Number.isFinite(rupees)) {
    throw new MoneyError(`cannot convert ${String(rupees)} to paise`);
  }
  // Round half away from zero, avoiding the classic 1.005 binary-float dip.
  const scaled = rupees * PAISE_PER_RUPEE;
  const rounded = Math.round(Math.abs(scaled) + Number.EPSILON * Math.abs(scaled));
  return Math.sign(scaled) * rounded || 0;
}

/** Integer paise -> rupees. UI edge only — never store or compute with the result. */
export function toRupees(paise: number): number {
  assertPaise(paise, 'paise');
  return paise / PAISE_PER_RUPEE;
}

export interface FormatInrOptions {
  /** `auto` (default) hides `.00`, `always` forces 2 decimals, `never` truncates to whole rupees. */
  decimals?: 'auto' | 'always' | 'never';
  withSymbol?: boolean;
}

/** Formats integer paise for display, e.g. 12345600 -> "₹1,23,456". */
export function formatINR(paise: number, options: FormatInrOptions = {}): string {
  assertPaise(paise, 'paise');
  const { decimals = 'auto', withSymbol = true } = options;
  const showDecimals =
    decimals === 'always' || (decimals === 'auto' && paise % PAISE_PER_RUPEE !== 0);
  const fractionDigits = showDecimals ? 2 : 0;

  const formatted = new Intl.NumberFormat(CURRENCY_LOCALE, {
    style: withSymbol ? 'currency' : 'decimal',
    currency: CURRENCY,
    currencyDisplay: 'symbol',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(toRupees(paise));

  // Some ICU builds emit "₹" with a NBSP; normalise so snapshots/tests are stable.
  return formatted.replace(/\u00A0/g, withSymbol ? '' : ' ').replace('INR', CURRENCY_SYMBOL);
}

/* ---------------------------------------------------------------- splitting */

export interface SplitRule {
  mode: SplitMode;
  /** FIXED: integer paise. PERCENT: 0–100 (decimals allowed). REMAINDER: ignored. */
  value?: number;
  /** Free-form identifier carried through to the allocation (e.g. a Razorpay linked account id). */
  account?: string;
  label?: string;
}

export interface SplitAllocation {
  mode: SplitMode;
  account?: string;
  label?: string;
  amountPaise: number;
}

const MICRO = 1_000_000n; // percent precision: 6 decimal places
const PERCENT_DENOMINATOR = 100n * MICRO;

/**
 * Splits an integer paise amount across FIXED / PERCENT / REMAINDER rules with **zero rounding
 * loss** — `sum(result) === totalPaise` always holds.
 *
 * - FIXED rules take their exact paise amount.
 * - PERCENT rules take `floor(total * pct)`; the dust is handed to the REMAINDER rule when one
 *   exists, otherwise distributed by the largest-remainder method (ties go to the earlier rule).
 * - At most one REMAINDER rule is allowed; it absorbs everything left over.
 *
 * @example splitPaise(600000, [{ mode: 'FIXED', value: 500000 }, { mode: 'REMAINDER' }])
 *          // -> 500000 + 100000
 */
export function splitPaise(totalPaise: number, rules: readonly SplitRule[]): SplitAllocation[] {
  assertPaise(totalPaise, 'totalPaise');
  if (totalPaise < 0) throw new MoneyError('totalPaise must not be negative');
  if (rules.length === 0) {
    if (totalPaise === 0) return [];
    throw new MoneyError('at least one split rule is required');
  }

  const remainderIndexes = rules
    .map((rule, index) => (rule.mode === 'REMAINDER' ? index : -1))
    .filter((index) => index >= 0);
  if (remainderIndexes.length > 1) {
    throw new MoneyError('at most one REMAINDER rule is allowed');
  }

  const total = BigInt(totalPaise);
  const amounts = new Array<bigint>(rules.length).fill(0n);
  const percentDust: { index: number; remainder: bigint }[] = [];
  let allocated = 0n;

  rules.forEach((rule, index) => {
    switch (rule.mode) {
      case 'FIXED': {
        const value = rule.value ?? 0;
        assertPaise(value, 'FIXED rule value');
        if (value < 0) throw new MoneyError('FIXED rule value must not be negative');
        amounts[index] = BigInt(value);
        allocated += amounts[index];
        break;
      }
      case 'PERCENT': {
        const value = rule.value ?? 0;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
          throw new MoneyError('PERCENT rule value must be between 0 and 100');
        }
        const micro = BigInt(Math.round(value * Number(MICRO)));
        const numerator = total * micro;
        amounts[index] = numerator / PERCENT_DENOMINATOR;
        percentDust.push({ index, remainder: numerator % PERCENT_DENOMINATOR });
        allocated += amounts[index];
        break;
      }
      case 'REMAINDER':
        break;
    }
  });

  if (allocated > total) {
    throw new MoneyError(
      `split rules allocate ${allocated} paise which exceeds the total of ${total} paise`,
    );
  }

  let leftover = total - allocated;

  if (remainderIndexes.length === 1) {
    amounts[remainderIndexes[0]] = leftover;
    leftover = 0n;
  } else if (leftover > 0n) {
    if (percentDust.length === 0) {
      throw new MoneyError(
        `split rules only allocate ${allocated} of ${total} paise and no REMAINDER rule was provided`,
      );
    }
    // Largest-remainder method: hand out one paise at a time, biggest fractional part first.
    const order = [...percentDust].sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
    for (let i = 0; leftover > 0n; i = (i + 1) % order.length) {
      amounts[order[i].index] += 1n;
      leftover -= 1n;
    }
  }

  return rules.map((rule, index) => {
    const allocation: SplitAllocation = { mode: rule.mode, amountPaise: Number(amounts[index]) };
    if (rule.account !== undefined) allocation.account = rule.account;
    if (rule.label !== undefined) allocation.label = rule.label;
    return allocation;
  });
}

/** Convenience wrapper: total of an allocation set (used by tests and the payment driver). */
export function sumAllocations(allocations: readonly SplitAllocation[]): number {
  return allocations.reduce((sum, allocation) => sum + allocation.amountPaise, 0);
}

/**
 * A variant with `pricePaise = null` inherits the product's base price. This resolves only that
 * fallback — price adjustments are applied by the Prompt 6 pricing engine, never here.
 */
export function resolveVariantBasePricePaise(
  variantPricePaise: number | null | undefined,
  productBasePricePaise: number,
): number {
  assertPaise(productBasePricePaise, 'productBasePricePaise');
  if (variantPricePaise === null || variantPricePaise === undefined) return productBasePricePaise;
  assertPaise(variantPricePaise, 'variantPricePaise');
  return variantPricePaise;
}

/** Basis points are the only representation for rates: 18% = 1800 (D5's rule applied to rates). */
export function bpToPercent(basisPoints: number): number {
  assertPaise(basisPoints, 'basisPoints');
  return basisPoints / 100;
}

export function percentToBp(percent: number): number {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    throw new MoneyError(`cannot convert ${String(percent)} to basis points`);
  }
  return Math.round(percent * 100);
}

/* ------------------------------------------------------------ pricing (P6) */

/**
 * The single rounding rule for the pricing engine: half-up to the nearest paise, away from zero,
 * so a -0.5 discount and a +0.5 charge round by the same magnitude.
 */
export function roundHalfUp(value: number): number {
  if (!Number.isFinite(value)) throw new MoneyError(`cannot round ${String(value)}`);
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** `amount x bp / 10000`, rounded half-up to whole paise. Used for every percentage in pricing. */
export function applyBasisPoints(amountPaise: number, basisPoints: number): number {
  assertPaise(amountPaise, 'amountPaise');
  if (!Number.isInteger(basisPoints)) {
    throw new MoneyError('basisPoints must be an integer');
  }
  return roundHalfUp((amountPaise * basisPoints) / 10_000);
}

/**
 * Spreads `totalPaise` across `weights` proportionally with **zero loss** — the result always sums
 * to exactly `totalPaise`. Dust goes to the largest fractional remainder, ties to the earlier
 * index, so the allocation is deterministic and replayable.
 *
 * This is what stops a ₹1,000 cart discount from leaking a paise when it is pushed back onto three
 * lines of unequal value.
 */
export function allocateProportionally(totalPaise: number, weights: readonly number[]): number[] {
  assertPaise(totalPaise, 'totalPaise');
  if (weights.length === 0) return [];

  const sign = totalPaise < 0 ? -1 : 1;
  const total = BigInt(Math.abs(totalPaise));
  const weightSum = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);

  if (weightSum <= 0) {
    // Nothing to weight by: give it all to the first bucket rather than losing it.
    return weights.map((_, index) => (index === 0 ? totalPaise : 0));
  }

  const sumBig = BigInt(weightSum);
  const amounts: bigint[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let allocated = 0n;

  weights.forEach((weight, index) => {
    const numerator = total * BigInt(Math.max(0, weight));
    const share = numerator / sumBig;
    amounts.push(share);
    remainders.push({ index, remainder: numerator % sumBig });
    allocated += share;
  });

  let leftover = total - allocated;
  const order = [...remainders].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );

  for (let i = 0; leftover > 0n; i = (i + 1) % order.length) {
    amounts[order[i].index] += 1n;
    leftover -= 1n;
  }

  return amounts.map((amount) => sign * Number(amount));
}

/** Rounds a grand total to whole rupees, returning the signed adjustment needed to get there. */
export function rupeeRoundingAdjustment(totalPaise: number): number {
  assertPaise(totalPaise, 'totalPaise');
  const remainder = totalPaise % PAISE_PER_RUPEE;
  if (remainder === 0) return 0;
  return remainder >= PAISE_PER_RUPEE / 2 ? PAISE_PER_RUPEE - remainder : -remainder;
}

/** Savings as basis points of the list price, for the "20% off" badge. 0 when there is no saving. */
export function savingsPercentBp(listPricePaise: number, sellingPricePaise: number): number {
  assertPaise(listPricePaise, 'listPricePaise');
  assertPaise(sellingPricePaise, 'sellingPricePaise');
  if (listPricePaise <= 0 || sellingPricePaise >= listPricePaise) return 0;
  return roundHalfUp(((listPricePaise - sellingPricePaise) * 10_000) / listPricePaise);
}

/**
 * Splits a tax amount into CGST/SGST (intra-state) or IGST (inter-state).
 * The halves always sum back to the original, so no paise is created or lost.
 */
export function splitGst(
  taxPaise: number,
  isIntraState: boolean,
): { cgstPaise: number; sgstPaise: number; igstPaise: number } {
  assertPaise(taxPaise, 'taxPaise');
  if (!isIntraState) return { cgstPaise: 0, sgstPaise: 0, igstPaise: taxPaise };

  const cgst = Math.trunc(taxPaise / 2);
  return { cgstPaise: cgst, sgstPaise: taxPaise - cgst, igstPaise: 0 };
}

/** Tax contained in a price that already includes it: `gross x rate / (10000 + rate)`. */
export function taxFromInclusive(grossPaise: number, rateBp: number): number {
  assertPaise(grossPaise, 'grossPaise');
  if (rateBp <= 0) return 0;
  return roundHalfUp((grossPaise * rateBp) / (10_000 + rateBp));
}
