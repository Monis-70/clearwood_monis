import { describe, expect, it } from 'vitest';

import {
  calculateRefund,
  RefundCalculationError,
  remainingQty,
  type RefundOrderContext,
  type RefundableLine,
} from '../src/modules/payments/refund/refundCalculator';
import {
  planReversals,
  ReversalPlanError,
  type ReversibleTransfer,
} from '../src/modules/payments/refund/reversalPlanner';

/**
 * Both units under test are PURE, so every case here is a fixture rather than a database.
 *
 * The canonical case is the one from Prompt 9A: a ₹6,000 order split ₹5,000 to PRIMARY and ₹1,000
 * to PARTNER_A. It is asserted end to end — full refund and partial — because it is the case that
 * proves the split and the reversal agree with each other.
 */

/* --------------------------------------------------------------- fixtures */

function line(overrides: Partial<RefundableLine> = {}): RefundableLine {
  // One ₹2,000 unit at 18% GST inclusive: 200000 total = 169492 taxable + 30508 tax.
  return {
    orderItemId: 'item-1',
    sku: 'CW-SOFA-1',
    qty: 1,
    cancelledQty: 0,
    refundedQty: 0,
    refundedAmountPaise: 0,
    unitPricePaise: 200_000,
    lineSubtotalPaise: 200_000,
    lineDiscountPaise: 0,
    taxablePaise: 169_492,
    taxPaise: 30_508,
    cgstPaise: 15_254,
    sgstPaise: 15_254,
    igstPaise: 0,
    taxRateBp: 1_800,
    lineTotalPaise: 200_000,
    ...overrides,
  };
}

function order(overrides: Partial<RefundOrderContext> = {}): RefundOrderContext {
  const lines = overrides.lines ?? [line()];
  const total = lines.reduce((sum, entry) => sum + entry.lineTotalPaise, 0);

  return {
    orderId: 'order-1',
    grandTotalPaise: total,
    paidPaise: total,
    refundedPaise: 0,
    shippingPaise: 0,
    roundingPaise: 0,
    ...overrides,
    lines,
  };
}

/** The canonical ₹6,000 order: three ₹2,000 units on one line. */
function canonicalOrder(): RefundOrderContext {
  return order({
    lines: [
      line({
        qty: 3,
        lineSubtotalPaise: 600_000,
        taxablePaise: 508_475,
        taxPaise: 91_525,
        cgstPaise: 45_763,
        sgstPaise: 45_762,
        lineTotalPaise: 600_000,
      }),
    ],
  });
}

/** The canonical split: PRIMARY ₹5,000, PARTNER_A ₹1,000. */
function canonicalTransfers(): ReversibleTransfer[] {
  return [
    {
      transferId: 'trf-partner',
      providerTransferId: 'trf_mock_partner',
      accountId: 'acct-partner',
      accountKey: 'PARTNER_A',
      accountName: 'Partner A',
      providerAccountId: 'acc_partner',
      isPrimary: false,
      amountPaise: 100_000,
      reversedPaise: 0,
    },
    {
      transferId: 'trf-primary',
      providerTransferId: 'trf_mock_primary',
      accountId: 'acct-primary',
      accountKey: 'PRIMARY',
      accountName: 'ClearWood',
      providerAccountId: 'acc_primary',
      isPrimary: true,
      amountPaise: 500_000,
      reversedPaise: 0,
    },
  ];
}

/* ------------------------------------------------------- refund calculator */

describe('refundCalculator', () => {
  it('refunds a whole single-unit line at its frozen total', () => {
    const result = calculateRefund(order(), [{ orderItemId: 'item-1', qty: 1 }]);

    expect(result.totalPaise).toBe(200_000);
    expect(result.taxPaise).toBe(30_508);
    expect(result.goodsPaise).toBe(169_492);
    expect(result.isFullRefund).toBe(true);
  });

  it('splits a partial refund without losing a paise', () => {
    const result = calculateRefund(canonicalOrder(), [{ orderItemId: 'item-1', qty: 1 }]);

    // 600000 / 3 divides exactly; the point is that the parts re-sum to the whole.
    expect(result.lines[0]!.amountPaise).toBe(200_000);
    expect(result.totalPaise).toBe(200_000);
    expect(result.isFullRefund).toBe(false);
  });

  it('never loses a paise when a line does not divide evenly', () => {
    const awkward = order({
      lines: [line({ qty: 3, lineTotalPaise: 100_000, taxPaise: 15_254 })],
    });

    const parts = [1, 1, 1].map(
      (qty) => calculateRefund(awkward, [{ orderItemId: 'item-1', qty }]).totalPaise,
    );

    // Each unit is 33333.33 paise; three independent roundings would lose one.
    const whole = calculateRefund(awkward, [{ orderItemId: 'item-1', qty: 3 }]).totalPaise;
    expect(whole).toBe(100_000);
    expect(parts.every((part) => part === 33_333 || part === 33_334)).toBe(true);
  });

  it('refunding every unit returns exactly what was paid', () => {
    const result = calculateRefund(canonicalOrder(), [{ orderItemId: 'item-1', qty: 3 }]);

    expect(result.totalPaise).toBe(600_000);
    expect(result.isFullRefund).toBe(true);
    expect(result.maxRefundablePaise).toBe(600_000);
  });

  it('does not re-refund value an earlier refund already returned', () => {
    const partlyRefunded = order({
      lines: [
        line({
          qty: 3,
          refundedQty: 1,
          refundedAmountPaise: 200_000,
          lineTotalPaise: 600_000,
          taxPaise: 91_525,
        }),
      ],
      paidPaise: 600_000,
      refundedPaise: 200_000,
    });

    const result = calculateRefund(partlyRefunded, [{ orderItemId: 'item-1', qty: 2 }]);

    expect(result.totalPaise).toBe(400_000);
    expect(result.maxRefundablePaise).toBe(400_000);
  });

  it('refuses to refund more units than remain', () => {
    expect(() =>
      calculateRefund(canonicalOrder(), [{ orderItemId: 'item-1', qty: 4 }]),
    ).toThrow(RefundCalculationError);
  });

  it('refuses to refund more money than was taken', () => {
    const underpaid = order({ paidPaise: 50_000 });

    expect(() => calculateRefund(underpaid, [{ orderItemId: 'item-1', qty: 1 }])).toThrow(
      /only 50000 paise is still refundable/,
    );
  });

  it('refuses a line that is not on the order', () => {
    expect(() => calculateRefund(order(), [{ orderItemId: 'nope', qty: 1 }])).toThrow(
      /not on this order/,
    );
  });

  it('refuses the same line listed twice', () => {
    expect(() =>
      calculateRefund(order(), [
        { orderItemId: 'item-1', qty: 1 },
        { orderItemId: 'item-1', qty: 1 },
      ]),
    ).toThrow(/listed twice/);
  });

  it('returns shipping only when the whole order goes back', () => {
    const withShipping = order({
      lines: [line({ qty: 2, lineTotalPaise: 400_000 })],
      shippingPaise: 50_000,
      paidPaise: 450_000,
    });

    const partial = calculateRefund(withShipping, [{ orderItemId: 'item-1', qty: 1 }]);
    expect(partial.shippingPaise).toBe(0);

    const full = calculateRefund(withShipping, [{ orderItemId: 'item-1', qty: 2 }]);
    expect(full.shippingPaise).toBe(50_000);
    expect(full.totalPaise).toBe(450_000);
  });

  it('ignores units that were cancelled before dispatch', () => {
    const partlyCancelled = line({ qty: 3, cancelledQty: 1 });
    expect(remainingQty(partlyCancelled)).toBe(2);
  });
});

/* -------------------------------------------------------- reversal planner */

describe('reversalPlanner', () => {
  it('reverses the canonical split exactly: 500000 primary + 100000 partner', () => {
    const plan = planReversals(600_000, canonicalTransfers());

    const byKey = Object.fromEntries(
      plan.reversals.map((entry) => [entry.accountKey, entry.amountPaise]),
    );

    expect(byKey.PRIMARY).toBe(500_000);
    expect(byKey.PARTNER_A).toBe(100_000);
    expect(plan.totalReversedPaise).toBe(600_000);
    expect(plan.hasShortfall).toBe(false);
  });

  it('splits a partial refund proportionally across both accounts', () => {
    // ₹1,200 of a ₹6,000 order split 5000/1000 → 1000 primary, 200 partner.
    const plan = planReversals(120_000, canonicalTransfers());

    const byKey = Object.fromEntries(
      plan.reversals.map((entry) => [entry.accountKey, entry.amountPaise]),
    );

    expect(byKey.PRIMARY).toBe(100_000);
    expect(byKey.PARTNER_A).toBe(20_000);
    expect(plan.totalReversedPaise).toBe(120_000);
  });

  it('always sums to exactly the refund, however awkward the ratio', () => {
    const awkward: ReversibleTransfer[] = [
      { ...canonicalTransfers()[0]!, amountPaise: 33_333 },
      { ...canonicalTransfers()[1]!, amountPaise: 66_667 },
    ];

    for (const refund of [1, 7, 99, 12_345, 99_999, 100_000]) {
      const plan = planReversals(refund, awkward);
      expect(plan.totalReversedPaise).toBe(refund);
    }
  });

  it('PRIMARY_FIRST spares the partner until the platform is exhausted', () => {
    const plan = planReversals(120_000, canonicalTransfers(), 'PRIMARY_FIRST');

    const byKey = Object.fromEntries(
      plan.reversals.map((entry) => [entry.accountKey, entry.amountPaise]),
    );

    expect(byKey.PRIMARY).toBe(120_000);
    expect(byKey.PARTNER_A ?? 0).toBe(0);
    expect(plan.totalReversedPaise).toBe(120_000);
  });

  it('PRIMARY_FIRST reaches the partner once our own share runs out', () => {
    const plan = planReversals(550_000, canonicalTransfers(), 'PRIMARY_FIRST');

    const byKey = Object.fromEntries(
      plan.reversals.map((entry) => [entry.accountKey, entry.amountPaise]),
    );

    expect(byKey.PRIMARY).toBe(500_000);
    expect(byKey.PARTNER_A).toBe(50_000);
  });

  it('never reverses more than a transfer still holds', () => {
    const partlyReversed = canonicalTransfers().map((transfer) => ({
      ...transfer,
      reversedPaise: transfer.amountPaise - 10_000,
    }));

    const plan = planReversals(20_000, partlyReversed);

    expect(plan.totalReversedPaise).toBe(20_000);
    for (const entry of plan.reversals) {
      expect(entry.amountPaise).toBeLessThanOrEqual(entry.availablePaise);
    }
  });

  it('reports a shortfall rather than over-reversing', () => {
    const plan = planReversals(700_000, canonicalTransfers());

    expect(plan.totalReversedPaise).toBe(600_000);
    expect(plan.hasShortfall).toBe(true);
    expect(plan.shortfallPaise).toBe(100_000);
    expect(plan.primaryAbsorbedPaise).toBe(100_000);
  });

  it('falls back to the platform when there was no split at all', () => {
    const plan = planReversals(200_000, []);

    expect(plan.reversals).toHaveLength(0);
    expect(plan.primaryAbsorbedPaise).toBe(200_000);
    expect(plan.hasShortfall).toBe(false);
  });

  it('treats a fully reversed transfer as nothing left to take', () => {
    const exhausted = canonicalTransfers().map((transfer) => ({
      ...transfer,
      reversedPaise: transfer.amountPaise,
    }));

    const plan = planReversals(100_000, exhausted);
    expect(plan.reversals).toHaveLength(0);
    expect(plan.primaryAbsorbedPaise).toBe(100_000);
  });

  it('refuses a zero or fractional refund', () => {
    expect(() => planReversals(0, canonicalTransfers())).toThrow(ReversalPlanError);
    expect(() => planReversals(-5, canonicalTransfers())).toThrow(ReversalPlanError);
    expect(() => planReversals(10.5, canonicalTransfers())).toThrow(ReversalPlanError);
  });
});
