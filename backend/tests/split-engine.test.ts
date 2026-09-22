import { describe, expect, it } from 'vitest';

import { splitPaise } from '@shared/money';

import {
  computeSplit,
  orderRules,
  ruleMatchesLine,
  SplitInvariantError,
  type SplitAccountInput,
  type SplitOrderContext,
  type SplitOrderLine,
  type SplitRuleInput,
} from '../src/modules/payments/split/split.engine';

/**
 * Prompt 9A — the split calculator, tested as the pure function it is.
 *
 * No database, no provider, no clock. Every case here is a fixture, which is what makes the
 * canonical ₹6,000 → PRIMARY ₹5,000 + PARTNER_A ₹1,000 claim something we can actually hold the
 * code to rather than something we hope is true.
 */

const PRIMARY: SplitAccountInput = {
  id: 'acc-primary',
  key: 'PRIMARY',
  name: 'ClearWood',
  providerAccountId: 'acc_primary',
  isPrimary: true,
  isActive: true,
};

const PARTNER: SplitAccountInput = {
  id: 'acc-partner',
  key: 'PARTNER_A',
  name: 'Partner A',
  providerAccountId: 'acc_partner',
  isPrimary: false,
  isActive: true,
};

const THIRD: SplitAccountInput = {
  id: 'acc-third',
  key: 'PARTNER_B',
  name: 'Partner B',
  providerAccountId: 'acc_third',
  isPrimary: false,
  isActive: true,
};

const ACCOUNTS = [PRIMARY, PARTNER, THIRD];

function rule(
  overrides: Partial<SplitRuleInput> & Pick<SplitRuleInput, 'code' | 'mode'>,
): SplitRuleInput {
  return {
    id: overrides.code,
    scope: 'GLOBAL',
    scopeEntityId: null,
    basis: 'ORDER_TOTAL',
    valuePaise: null,
    valueBp: null,
    recipientKey: 'PARTNER_A',
    priority: 50,
    minOrderPaise: null,
    maxTransferPaise: null,
    onHold: false,
    onHoldUntil: null,
    ...overrides,
  };
}

function line(overrides: Partial<SplitOrderLine> = {}): SplitOrderLine {
  return {
    orderItemId: 'item-1',
    productId: 'prod-1',
    categoryIds: [],
    collectionIds: [],
    brandId: null,
    lineSubtotalPaise: 100_000,
    lineTotalPaise: 118_000,
    ...overrides,
  };
}

function order(overrides: Partial<SplitOrderContext> = {}): SplitOrderContext {
  return {
    orderId: 'order-1',
    subtotalPaise: 508_475,
    grandTotalPaise: 600_000,
    lines: [line()],
    ...overrides,
  };
}

const FIXED_1000 = rule({
  code: 'partner-fixed-1000',
  mode: 'FIXED',
  valuePaise: 100_000,
  recipientKey: 'PARTNER_A',
  priority: 10,
});

const REMAINDER_PRIMARY = rule({
  code: 'primary-remainder',
  mode: 'REMAINDER',
  recipientKey: 'PRIMARY',
  priority: 100,
});

describe('the canonical case', () => {
  it('splits ₹6,000 into PRIMARY ₹5,000 and PARTNER_A ₹1,000, exactly', () => {
    const result = computeSplit(order(), 600_000, [FIXED_1000, REMAINDER_PRIMARY], ACCOUNTS);

    const byAccount = Object.fromEntries(
      result.allocations.map((entry) => [entry.accountKey, entry.amountPaise]),
    );

    expect(byAccount.PARTNER_A).toBe(100_000);
    expect(byAccount.PRIMARY).toBe(500_000);
    expect(result.allocatedPaise).toBe(600_000);
  });

  it('agrees with the money helper the rest of the system already trusts', () => {
    // The same claim, from the other direction: splitPaise is what produces the final numbers.
    expect(splitPaise(600_000, [{ mode: 'FIXED', value: 500_000 }, { mode: 'REMAINDER' }])).toEqual(
      [
        { mode: 'FIXED', amountPaise: 500_000 },
        { mode: 'REMAINDER', amountPaise: 100_000 },
      ],
    );
  });
});

describe('modes', () => {
  it('takes a percentage of the basis and gives the rest to the remainder', () => {
    const percent = rule({
      code: 'partner-15pc',
      mode: 'PERCENT',
      valueBp: 1_500,
      recipientKey: 'PARTNER_A',
      priority: 10,
    });

    const result = computeSplit(order(), 600_000, [percent, REMAINDER_PRIMARY], ACCOUNTS);
    const byAccount = Object.fromEntries(
      result.allocations.map((entry) => [entry.accountKey, entry.amountPaise]),
    );

    expect(byAccount.PARTNER_A).toBe(90_000);
    expect(byAccount.PRIMARY).toBe(510_000);
    expect(result.allocatedPaise).toBe(600_000);
  });

  it('loses not one paise splitting an odd amount three ways', () => {
    const a = rule({
      code: 'a-3333',
      mode: 'PERCENT',
      valueBp: 3_333,
      recipientKey: 'PARTNER_A',
      priority: 10,
    });
    const b = rule({
      code: 'b-3333',
      mode: 'PERCENT',
      valueBp: 3_333,
      recipientKey: 'PARTNER_B',
      priority: 20,
    });

    const result = computeSplit(
      order({ grandTotalPaise: 100_001 }),
      100_001,
      [a, b, REMAINDER_PRIMARY],
      ACCOUNTS,
    );

    expect(result.allocatedPaise).toBe(100_001);
    expect(result.allocations.reduce((sum, entry) => sum + entry.amountPaise, 0)).toBe(100_001);
    // floor(100001 * 0.3333) twice, and the residue to the remainder.
    expect(result.allocations.map((entry) => entry.amountPaise)).toEqual([33_330, 33_330, 33_341]);
  });

  it('clamps two fixed rules that together exceed the order, and still balances', () => {
    const big = rule({
      code: 'big-fixed',
      mode: 'FIXED',
      valuePaise: 400_000,
      recipientKey: 'PARTNER_A',
      priority: 10,
    });
    const bigger = rule({
      code: 'bigger-fixed',
      mode: 'FIXED',
      valuePaise: 400_000,
      recipientKey: 'PARTNER_B',
      priority: 20,
    });

    const result = computeSplit(order(), 500_000, [big, bigger, REMAINDER_PRIMARY], ACCOUNTS);
    const byAccount = Object.fromEntries(
      result.allocations.map((entry) => [entry.accountKey, entry.amountPaise]),
    );

    expect(byAccount.PARTNER_A).toBe(400_000);
    // Only 100000 was left when the second rule ran, and it never goes negative.
    expect(byAccount.PARTNER_B).toBe(100_000);
    expect(byAccount.PRIMARY).toBe(0);
    expect(result.allocatedPaise).toBe(500_000);
  });

  it('respects maxTransferPaise and says so in the note', () => {
    const capped = rule({
      code: 'capped',
      mode: 'PERCENT',
      valueBp: 5_000,
      recipientKey: 'PARTNER_A',
      priority: 10,
      maxTransferPaise: 50_000,
    });

    const result = computeSplit(order(), 600_000, [capped, REMAINDER_PRIMARY], ACCOUNTS);
    const partner = result.allocations.find((entry) => entry.accountKey === 'PARTNER_A')!;

    expect(partner.amountPaise).toBe(50_000);
    expect(partner.note).toContain('maxTransferPaise');
  });
});

describe('scoping', () => {
  const sofaLine = line({
    orderItemId: 'sofa',
    productId: 'p-sofa',
    categoryIds: ['cat-sofas', 'cat-fabric'],
  });
  const tableLine = line({
    orderItemId: 'table',
    productId: 'p-table',
    categoryIds: ['cat-tables'],
    lineTotalPaise: 50_000,
  });

  it('matches a category rule through the ancestor path', () => {
    const categoryRule = rule({
      code: 'sofas-only',
      mode: 'PERCENT',
      valueBp: 1_000,
      scope: 'CATEGORY',
      // A rule on the PARENT category still matches a line filed under the child.
      scopeEntityId: 'cat-sofas',
      basis: 'LINE_TOTAL',
      recipientKey: 'PARTNER_A',
      priority: 10,
    });

    expect(ruleMatchesLine(categoryRule, sofaLine)).toBe(true);
    expect(ruleMatchesLine(categoryRule, tableLine)).toBe(false);

    const result = computeSplit(
      order({ lines: [sofaLine, tableLine], grandTotalPaise: 168_000 }),
      168_000,
      [categoryRule, REMAINDER_PRIMARY],
      ACCOUNTS,
    );

    const partner = result.allocations.find((entry) => entry.accountKey === 'PARTNER_A')!;
    // 10% of the SOFA line only (118000), not of the whole order.
    expect(partner.basisAmountPaise).toBe(118_000);
    expect(partner.amountPaise).toBe(11_800);
    expect(result.allocatedPaise).toBe(168_000);
  });

  it('skips a scoped rule entirely when no line matches', () => {
    const brandRule = rule({
      code: 'brand-only',
      mode: 'FIXED',
      valuePaise: 10_000,
      scope: 'BRAND',
      scopeEntityId: 'brand-x',
      recipientKey: 'PARTNER_A',
      priority: 10,
    });

    const result = computeSplit(order(), 600_000, [brandRule, REMAINDER_PRIMARY], ACCOUNTS);

    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]!.accountKey).toBe('PRIMARY');
    expect(result.allocations[0]!.amountPaise).toBe(600_000);
  });

  it('orders by priority, then specificity, then id', () => {
    const globalRule = rule({ code: 'g', mode: 'FIXED', scope: 'GLOBAL', priority: 10 });
    const productRule = rule({ code: 'p', mode: 'FIXED', scope: 'PRODUCT', priority: 10 });
    const brandRule = rule({ code: 'b', mode: 'FIXED', scope: 'BRAND', priority: 10 });

    expect(orderRules([productRule, globalRule, brandRule]).map((entry) => entry.code)).toEqual([
      'g',
      'b',
      'p',
    ]);
  });

  it('ignores a rule below its minimum order value', () => {
    const minimum = rule({
      code: 'big-orders-only',
      mode: 'FIXED',
      valuePaise: 50_000,
      minOrderPaise: 1_000_000,
      recipientKey: 'PARTNER_A',
      priority: 10,
    });

    const result = computeSplit(order(), 600_000, [minimum, REMAINDER_PRIMARY], ACCOUNTS);
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]!.amountPaise).toBe(600_000);
  });
});

describe('guards', () => {
  it('refuses two REMAINDER rules — the residue can have only one owner', () => {
    const second = rule({ code: 'second-remainder', mode: 'REMAINDER', recipientKey: 'PARTNER_A' });

    expect(() => computeSplit(order(), 600_000, [REMAINDER_PRIMARY, second], ACCOUNTS)).toThrow(
      SplitInvariantError,
    );
  });

  it('falls back to the primary account when there is no REMAINDER rule', () => {
    const result = computeSplit(order(), 600_000, [FIXED_1000], ACCOUNTS);
    const remainder = result.allocations.find((entry) => entry.isRemainder)!;

    expect(remainder.accountKey).toBe('PRIMARY');
    expect(remainder.amountPaise).toBe(500_000);
    expect(remainder.note).toContain('primary account');
  });

  it('throws when there is nowhere at all for the residue to go', () => {
    const noPrimary = [{ ...PRIMARY, isPrimary: false }, PARTNER];

    expect(() => computeSplit(order(), 600_000, [FIXED_1000], noPrimary)).toThrow(
      SplitInvariantError,
    );
  });

  it('ignores a rule pointing at an inactive account', () => {
    const inactive = [{ ...PARTNER, isActive: false }, PRIMARY];
    const result = computeSplit(order(), 600_000, [FIXED_1000, REMAINDER_PRIMARY], inactive);

    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]!.accountKey).toBe('PRIMARY');
    expect(result.allocatedPaise).toBe(600_000);
  });

  it('keeps a zero allocation on the record rather than dropping it silently', () => {
    const tiny = rule({
      code: 'tiny',
      mode: 'PERCENT',
      valueBp: 1,
      recipientKey: 'PARTNER_A',
      priority: 10,
    });

    const result = computeSplit(
      order({ grandTotalPaise: 100 }),
      100,
      [tiny, REMAINDER_PRIMARY],
      ACCOUNTS,
    );
    const partner = result.allocations.find((entry) => entry.accountKey === 'PARTNER_A')!;

    expect(partner.amountPaise).toBe(0);
    expect(partner.note).toBeTruthy();
    expect(result.allocatedPaise).toBe(100);
  });

  it('rejects a negative transferable amount', () => {
    expect(() => computeSplit(order(), -1, [REMAINDER_PRIMARY], ACCOUNTS)).toThrow(
      SplitInvariantError,
    );
  });

  it('allocates nothing at all when the transferable amount is zero', () => {
    const result = computeSplit(order(), 0, [FIXED_1000, REMAINDER_PRIMARY], ACCOUNTS);
    expect(result.allocatedPaise).toBe(0);
    expect(result.allocations.every((entry) => entry.amountPaise === 0)).toBe(true);
  });
});
