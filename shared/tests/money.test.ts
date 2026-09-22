import { describe, expect, it } from 'vitest';

import {
  MoneyError,
  bpToPercent,
  formatINR,
  percentToBp,
  resolveVariantBasePricePaise,
  splitPaise,
  sumAllocations,
  toPaise,
  toRupees,
  type SplitRule,
} from '../src/money';

describe('toPaise / toRupees', () => {
  it('converts rupees to integer paise', () => {
    expect(toPaise(6000)).toBe(600000);
    expect(toPaise(1999.99)).toBe(199999);
    expect(toPaise(0)).toBe(0);
  });

  it('rounds half away from zero instead of drifting on binary floats', () => {
    expect(toPaise(1.005)).toBe(101);
    expect(toPaise(0.615)).toBe(62);
    expect(toPaise(-12.345)).toBe(-1235);
  });

  it('round-trips through rupees', () => {
    expect(toRupees(600000)).toBe(6000);
    expect(toRupees(199999)).toBe(1999.99);
  });

  it('rejects non-integer paise', () => {
    expect(() => toRupees(10.5)).toThrow(MoneyError);
  });
});

describe('formatINR', () => {
  it('formats with the Indian grouping and hides .00 by default', () => {
    expect(formatINR(12345600)).toBe('₹1,23,456');
    expect(formatINR(199999)).toBe('₹1,999.99');
  });

  it('can drop the symbol', () => {
    expect(formatINR(600000, { withSymbol: false })).toBe('6,000');
  });
});

describe('splitPaise', () => {
  it('splits FIXED + REMAINDER with no loss (6000 => 5000 + 1000)', () => {
    const rules: SplitRule[] = [
      { mode: 'FIXED', value: 500000, account: 'acc_primary', label: 'Account A' },
      { mode: 'REMAINDER', account: 'acc_secondary', label: 'Account B' },
    ];
    const allocations = splitPaise(600000, rules);

    expect(allocations.map((a) => a.amountPaise)).toEqual([500000, 100000]);
    expect(sumAllocations(allocations)).toBe(600000);
    expect(allocations[0].account).toBe('acc_primary');
    expect(allocations[1].label).toBe('Account B');
  });

  it('splits evenly divisible percentages', () => {
    const allocations = splitPaise(100, [
      { mode: 'PERCENT', value: 50 },
      { mode: 'PERCENT', value: 50 },
    ]);
    expect(allocations.map((a) => a.amountPaise)).toEqual([50, 50]);
  });

  it('distributes the dust with the largest-remainder method', () => {
    const allocations = splitPaise(101, [
      { mode: 'PERCENT', value: 50 },
      { mode: 'PERCENT', value: 50 },
    ]);
    expect(allocations.map((a) => a.amountPaise)).toEqual([51, 50]);
    expect(sumAllocations(allocations)).toBe(101);
  });

  it('never loses a paise on repeating decimals', () => {
    const allocations = splitPaise(1000, [
      { mode: 'PERCENT', value: 33.333 },
      { mode: 'PERCENT', value: 33.333 },
      { mode: 'PERCENT', value: 33.334 },
    ]);
    expect(sumAllocations(allocations)).toBe(1000);
  });

  it('keeps the invariant for a large, awkward amount', () => {
    const total = 987_654_321;
    const allocations = splitPaise(total, [
      { mode: 'FIXED', value: 12_345 },
      { mode: 'PERCENT', value: 17.5 },
      { mode: 'PERCENT', value: 2.25 },
      { mode: 'REMAINDER' },
    ]);
    expect(sumAllocations(allocations)).toBe(total);
    expect(allocations.every((a) => Number.isSafeInteger(a.amountPaise))).toBe(true);
    expect(allocations.every((a) => a.amountPaise >= 0)).toBe(true);
  });

  it('gives the remainder rule everything left over, including percentage dust', () => {
    const allocations = splitPaise(1001, [
      { mode: 'PERCENT', value: 33.333 },
      { mode: 'REMAINDER' },
    ]);
    expect(sumAllocations(allocations)).toBe(1001);
    expect(allocations[0].amountPaise).toBe(333);
    expect(allocations[1].amountPaise).toBe(668);
  });

  it('handles a zero total', () => {
    expect(splitPaise(0, [{ mode: 'PERCENT', value: 100 }])).toEqual([
      { mode: 'PERCENT', amountPaise: 0 },
    ]);
    expect(splitPaise(0, [])).toEqual([]);
  });

  it('rejects over-allocation', () => {
    expect(() => splitPaise(600000, [{ mode: 'FIXED', value: 700000 }])).toThrow(MoneyError);
  });

  it('rejects under-allocation with no REMAINDER rule', () => {
    expect(() => splitPaise(600000, [{ mode: 'FIXED', value: 500000 }])).toThrow(MoneyError);
  });

  it('rejects more than one REMAINDER rule', () => {
    expect(() => splitPaise(100, [{ mode: 'REMAINDER' }, { mode: 'REMAINDER' }])).toThrow(
      MoneyError,
    );
  });

  it('rejects a negative total and out-of-range percentages', () => {
    expect(() => splitPaise(-1, [{ mode: 'REMAINDER' }])).toThrow(MoneyError);
    expect(() => splitPaise(100, [{ mode: 'PERCENT', value: 120 }])).toThrow(MoneyError);
  });
});

describe('resolveVariantBasePricePaise', () => {
  it('falls back to the product base price when the variant has none', () => {
    expect(resolveVariantBasePricePaise(null, 4599900)).toBe(4599900);
    expect(resolveVariantBasePricePaise(undefined, 4599900)).toBe(4599900);
  });

  it('uses the variant price when it is set, including zero', () => {
    expect(resolveVariantBasePricePaise(4899900, 4599900)).toBe(4899900);
    expect(resolveVariantBasePricePaise(0, 4599900)).toBe(0);
  });

  it('refuses a non-integer price', () => {
    expect(() => resolveVariantBasePricePaise(1234.5, 4599900)).toThrow(MoneyError);
  });
});

describe('basis points', () => {
  it('converts both ways without drift (18% = 1800bp)', () => {
    expect(percentToBp(18)).toBe(1800);
    expect(bpToPercent(1800)).toBe(18);
    expect(percentToBp(2.5)).toBe(250);
    expect(bpToPercent(percentToBp(33.33))).toBeCloseTo(33.33, 5);
  });
});
