import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { allocateProportionally, splitPaise } from '@shared/money';
import type {
  PriceRequest,
  PricingAdjustment,
  PricingContext,
  PricingLineContext,
  PricingSettings,
} from '@shared/types/pricing';

import {
  PricingInvariantError,
  calculate,
  pricingEngine,
} from '../src/modules/pricing/pricing.engine';
import { evaluateConditionGroup } from '../src/modules/pricing/condition.evaluator';
import { sortAdjustments } from '../src/modules/pricing/adjustment.matcher';

/**
 * Prompt 6 — the pure engine. No database, no network: every input is a fixture, so these tests
 * pin the arithmetic itself rather than the plumbing around it.
 */

const NOW = '2026-06-15T10:00:00.000Z';

const SETTINGS: PricingSettings = {
  pricesIncludeTax: false,
  sellerStateCode: 'MH',
  defaultPlaceOfSupply: 'MH',
  shippingTaxable: false,
  shippingTaxRateBp: 1800,
  roundTotalToRupee: false,
  freeShippingThresholdPaise: 5_000_000,
  showSavingsBadge: true,
  minOrderValuePaise: 0,
};

function adjustment(overrides: Partial<PricingAdjustment> & { id: string }): PricingAdjustment {
  return {
    name: overrides.name ?? overrides.id,
    scope: 'GLOBAL',
    adjustmentType: 'FIXED_AMOUNT',
    basis: 'BASE',
    priority: 100,
    valuePaise: null,
    valueBp: null,
    categoryId: null,
    productId: null,
    variantId: null,
    attributeId: null,
    attributeValueId: null,
    customerGroupId: null,
    channel: 'ALL',
    minQty: null,
    maxQty: null,
    startsAt: null,
    endsAt: null,
    conditions: null,
    ...overrides,
  };
}

function line(overrides: Partial<PricingLineContext> = {}): PricingLineContext {
  return {
    lineId: 'L1',
    productId: 'prod-1',
    productName: 'Test Sofa',
    productSlug: 'test-sofa',
    variantId: 'var-1',
    variantSku: 'TEST-1',
    baseUnitPaise: 1_000_000,
    listPricePaise: null,
    categoryIds: ['cat-sofas', 'cat-fabric-sofas'],
    collectionIds: [],
    brandId: 'brand-1',
    optionValueIds: [],
    taxClass: { id: 'tax-18', code: 'GST_18', rateBp: 1800, hsnCode: '9401' },
    isMadeToOrder: false,
    leadTimeDays: null,
    weightGrams: 10_000,
    adjustments: [],
    tiers: [],
    priceListItems: [],
    ...overrides,
  };
}

function context(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    settings: SETTINGS,
    customerGroup: null,
    customerId: null,
    isFirstOrder: true,
    channel: 'WEB',
    buyerStateCode: 'MH',
    pincode: '400001',
    lines: [line()],
    coupon: null,
    autoCoupons: [],
    discountRules: [],
    shippingRates: [],
    shippingZoneCode: null,
    ...overrides,
  };
}

function request(qty = 1, overrides: Partial<PriceRequest> = {}): PriceRequest {
  return {
    lines: [{ lineId: 'L1', productId: 'prod-1', variantId: 'var-1', qty }],
    channel: 'WEB',
    now: NOW,
    ...overrides,
  };
}

describe('engine purity', () => {
  it('returns an identical breakdown, contextHash included, for identical inputs', () => {
    const ctx = context();
    const first = calculate(ctx, request()).breakdown;
    const second = calculate(ctx, request()).breakdown;

    expect(second).toStrictEqual(first);
    expect(second.contextHash).toBe(first.contextHash);
  });

  it('only changes date-windowed rules when `now` moves', () => {
    const dated = adjustment({
      id: 'adj-festive',
      name: 'Festive 10% off',
      adjustmentType: 'PERCENT',
      basis: 'BASE',
      valueBp: -1000,
      startsAt: '2026-10-01T00:00:00.000Z',
      endsAt: '2026-11-15T00:00:00.000Z',
    });

    const ctx = context({ lines: [line({ adjustments: [dated] })] });

    const before = calculate(ctx, request(1, { now: '2026-06-15T10:00:00.000Z' })).breakdown;
    const during = calculate(ctx, request(1, { now: '2026-10-20T10:00:00.000Z' })).breakdown;

    expect(before.lines[0]!.unitPricePaise).toBe(1_000_000);
    expect(during.lines[0]!.unitPricePaise).toBe(900_000);
  });

  it('imports no database client', async () => {
    // A single accidental Prisma import would make the engine unreplayable and untestable.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        path.join(__dirname, '..', 'src', 'modules', 'pricing', 'pricing.engine.ts'),
        'utf8',
      ),
    );

    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toMatch(/from '.*config\/prisma'/);
    expect(code).not.toMatch(/@prisma\/client/);
    expect(code).not.toMatch(/Date\.now\(\)/);
    expect(code).not.toMatch(/container'/);
  });
});

describe('adjustment types', () => {
  it('FIXED_AMOUNT adds a flat amount per unit', () => {
    const ctx = context({
      lines: [
        line({
          adjustments: [
            adjustment({ id: 'a', adjustmentType: 'FIXED_AMOUNT', valuePaise: 450_000 }),
          ],
        }),
      ],
    });

    const { breakdown } = calculate(ctx, request(2));
    expect(breakdown.lines[0]!.unitPricePaise).toBe(1_450_000);
    expect(breakdown.lines[0]!.subtotalPaise).toBe(2_900_000);
  });

  it('PER_UNIT charges the configured amount on every unit', () => {
    const ctx = context({
      lines: [
        line({
          adjustments: [adjustment({ id: 'a', adjustmentType: 'PER_UNIT', valuePaise: 30_000 })],
        }),
      ],
    });

    const { breakdown } = calculate(ctx, request(3));
    expect(breakdown.lines[0]!.unitPricePaise).toBe(1_030_000);
    expect(breakdown.lines[0]!.subtotalPaise).toBe(3_090_000);
  });

  it('PERCENT on BASE uses the step-3 price, not the running one', () => {
    const ctx = context({
      lines: [
        line({
          adjustments: [
            adjustment({
              id: 'a1',
              priority: 10,
              adjustmentType: 'FIXED_AMOUNT',
              valuePaise: 500_000,
            }),
            adjustment({
              id: 'a2',
              priority: 20,
              adjustmentType: 'PERCENT',
              basis: 'BASE',
              valueBp: 1000,
            }),
          ],
        }),
      ],
    });

    // 10,000 + 5,000 = 15,000, then 10% of the BASE 10,000 = +1,000 -> 16,000
    const { breakdown } = calculate(ctx, request());
    expect(breakdown.lines[0]!.unitPricePaise).toBe(1_600_000);
  });

  it('PERCENT on RUNNING_SUBTOTAL uses the price so far', () => {
    const ctx = context({
      lines: [
        line({
          adjustments: [
            adjustment({
              id: 'a1',
              priority: 10,
              adjustmentType: 'FIXED_AMOUNT',
              valuePaise: 500_000,
            }),
            adjustment({
              id: 'a2',
              priority: 20,
              adjustmentType: 'PERCENT',
              basis: 'RUNNING_SUBTOTAL',
              valueBp: 1000,
            }),
          ],
        }),
      ],
    });

    // 10,000 + 5,000 = 15,000, then 10% of 15,000 = +1,500 -> 16,500
    const { breakdown } = calculate(ctx, request());
    expect(breakdown.lines[0]!.unitPricePaise).toBe(1_650_000);
  });

  it('MULTIPLIER scales the running price', () => {
    const ctx = context({
      lines: [
        line({
          adjustments: [adjustment({ id: 'a', adjustmentType: 'MULTIPLIER', valueBp: 13_000 })],
        }),
      ],
    });

    const { breakdown } = calculate(ctx, request());
    expect(breakdown.lines[0]!.unitPricePaise).toBe(1_300_000);
  });
});

describe('ordering', () => {
  it('sorts by priority, then scope specificity, then id', () => {
    const sorted = sortAdjustments([
      adjustment({ id: 'z', scope: 'PRODUCT', priority: 50 }),
      adjustment({ id: 'a', scope: 'PRODUCT', priority: 50 }),
      adjustment({ id: 'b', scope: 'GLOBAL', priority: 50 }),
      adjustment({ id: 'c', scope: 'VARIANT', priority: 10 }),
    ]).map((row) => row.id);

    expect(sorted).toStrictEqual(['c', 'b', 'a', 'z']);
  });

  it('applies conflicting rules in that exact order', () => {
    const ctx = context({
      lines: [
        line({
          adjustments: [
            adjustment({
              id: 'second',
              scope: 'PRODUCT',
              productId: 'prod-1',
              priority: 20,
              adjustmentType: 'PERCENT',
              basis: 'RUNNING_SUBTOTAL',
              valueBp: 1000,
            }),
            adjustment({
              id: 'first',
              scope: 'GLOBAL',
              priority: 10,
              adjustmentType: 'FIXED_AMOUNT',
              valuePaise: 100_000,
            }),
          ],
        }),
      ],
    });

    // 10,000 + 1,000 = 11,000, then +10% = 12,100
    const { breakdown } = calculate(ctx, request());
    expect(breakdown.lines[0]!.unitPricePaise).toBe(1_210_000);
  });
});

describe('scope matching', () => {
  it('applies a category rule through the ancestor path', () => {
    const ctx = context({
      lines: [
        line({
          adjustments: [
            adjustment({
              id: 'sofas',
              scope: 'CATEGORY',
              categoryId: 'cat-sofas',
              adjustmentType: 'FIXED_AMOUNT',
              valuePaise: -100_000,
            }),
          ],
        }),
      ],
    });

    expect(calculate(ctx, request()).breakdown.lines[0]!.unitPricePaise).toBe(900_000);
  });

  it('ignores a rule on a sibling category', () => {
    const ctx = context({
      lines: [
        line({
          adjustments: [
            adjustment({
              id: 'beds',
              scope: 'CATEGORY',
              categoryId: 'cat-beds',
              adjustmentType: 'FIXED_AMOUNT',
              valuePaise: -100_000,
            }),
          ],
        }),
      ],
    });

    expect(calculate(ctx, request()).breakdown.lines[0]!.unitPricePaise).toBe(1_000_000);
  });

  it('applies an attribute rule only when that option is selected', () => {
    const leather = adjustment({
      id: 'leather',
      scope: 'ATTRIBUTE_VALUE',
      attributeValueId: 'val-genuine-leather',
      adjustmentType: 'FIXED_AMOUNT',
      valuePaise: 450_000,
    });

    const without = context({ lines: [line({ adjustments: [leather] })] });
    const withOption = context({
      lines: [line({ adjustments: [leather], optionValueIds: ['val-genuine-leather'] })],
    });

    expect(calculate(without, request()).breakdown.lines[0]!.unitPricePaise).toBe(1_000_000);
    expect(calculate(withOption, request()).breakdown.lines[0]!.unitPricePaise).toBe(1_450_000);
  });

  it('honours qty windows, channel and customer group', () => {
    const bulk = adjustment({
      id: 'bulk',
      minQty: 5,
      adjustmentType: 'FIXED_AMOUNT',
      valuePaise: -50_000,
    });
    const ctx = context({ lines: [line({ adjustments: [bulk] })] });

    expect(calculate(ctx, request(4)).breakdown.lines[0]!.unitPricePaise).toBe(1_000_000);
    expect(calculate(ctx, request(5)).breakdown.lines[0]!.unitPricePaise).toBe(950_000);
  });
});

describe('price lists and tiers', () => {
  it('a price list replaces the base price', () => {
    const ctx = context({
      lines: [
        line({
          priceListItems: [
            {
              id: 'pli-1',
              priceListId: 'pl-1',
              priceListCode: 'TRADE',
              priceListPriority: 100,
              productId: 'prod-1',
              variantId: null,
              minQty: 1,
              pricePaise: 800_000,
            },
          ],
        }),
      ],
    });

    expect(calculate(ctx, request()).breakdown.lines[0]!.unitPricePaise).toBe(800_000);
  });

  it('the higher-priority price list wins', () => {
    const ctx = context({
      lines: [
        line({
          priceListItems: [
            {
              id: 'a',
              priceListId: 'pl-1',
              priceListCode: 'LOW',
              priceListPriority: 10,
              productId: 'prod-1',
              variantId: null,
              minQty: 1,
              pricePaise: 900_000,
            },
            {
              id: 'b',
              priceListId: 'pl-2',
              priceListCode: 'HIGH',
              priceListPriority: 200,
              productId: 'prod-1',
              variantId: null,
              minQty: 1,
              pricePaise: 700_000,
            },
          ],
        }),
      ],
    });

    expect(calculate(ctx, request()).breakdown.lines[0]!.unitPricePaise).toBe(700_000);
  });

  it('a tier applies exactly at minQty and never stacks', () => {
    const ctx = context({
      lines: [
        line({
          tiers: [
            {
              id: 't2',
              productId: 'prod-1',
              variantId: null,
              customerGroupId: null,
              minQty: 2,
              pricePaise: null,
              discountBp: 500,
            },
            {
              id: 't5',
              productId: 'prod-1',
              variantId: null,
              customerGroupId: null,
              minQty: 5,
              pricePaise: null,
              discountBp: 1000,
            },
          ],
        }),
      ],
    });

    expect(calculate(ctx, request(1)).breakdown.lines[0]!.unitPricePaise).toBe(1_000_000);
    expect(calculate(ctx, request(2)).breakdown.lines[0]!.unitPricePaise).toBe(950_000);
    expect(calculate(ctx, request(4)).breakdown.lines[0]!.unitPricePaise).toBe(950_000);
    // Only the qty-5 tier applies — the two discounts never compound.
    expect(calculate(ctx, request(5)).breakdown.lines[0]!.unitPricePaise).toBe(900_000);
  });

  it('a tier with pricePaise replaces the base the adjustments then work from', () => {
    const ctx = context({
      lines: [
        line({
          tiers: [
            {
              id: 't5',
              productId: 'prod-1',
              variantId: null,
              customerGroupId: null,
              minQty: 5,
              pricePaise: 800_000,
              discountBp: null,
            },
          ],
          adjustments: [
            adjustment({ id: 'pct', adjustmentType: 'PERCENT', basis: 'BASE', valueBp: 1000 }),
          ],
        }),
      ],
    });

    // Tier replaces 10,000 with 8,000; BASE for the percentage is therefore 8,000 -> +800
    expect(calculate(ctx, request(5)).breakdown.lines[0]!.unitPricePaise).toBe(880_000);
  });

  it('the price list is resolved before the tier discount applies to it', () => {
    const ctx = context({
      lines: [
        line({
          priceListItems: [
            {
              id: 'pli',
              priceListId: 'pl',
              priceListCode: 'TRADE',
              priceListPriority: 100,
              productId: 'prod-1',
              variantId: null,
              minQty: 1,
              pricePaise: 800_000,
            },
          ],
          tiers: [
            {
              id: 't2',
              productId: 'prod-1',
              variantId: null,
              customerGroupId: null,
              minQty: 2,
              pricePaise: null,
              discountBp: 1000,
            },
          ],
        }),
      ],
    });

    // 8,000 from the list, then 10% off that = 7,200
    expect(calculate(ctx, request(2)).breakdown.lines[0]!.unitPricePaise).toBe(720_000);
  });

  it('ignores a tier belonging to another customer group', () => {
    const ctx = context({
      customerGroup: {
        id: 'grp-retail',
        code: 'RETAIL',
        name: 'Retail',
        priority: 10,
        discountBp: null,
      },
      lines: [
        line({
          tiers: [
            {
              id: 't',
              productId: 'prod-1',
              variantId: null,
              customerGroupId: 'grp-trade',
              minQty: 2,
              pricePaise: null,
              discountBp: 2000,
            },
          ],
        }),
      ],
    });

    expect(calculate(ctx, request(5)).breakdown.lines[0]!.unitPricePaise).toBe(1_000_000);
  });
});

describe('tax', () => {
  it('exclusive tax adds GST on top', () => {
    const { breakdown } = calculate(context(), request());

    expect(breakdown.lines[0]!.taxPaise).toBe(180_000);
    expect(breakdown.grandTotalPaise).toBe(1_180_000);
  });

  it('inclusive tax extracts GST from the same shown price', () => {
    const ctx = context({
      settings: { ...SETTINGS, pricesIncludeTax: true },
      lines: [line({ baseUnitPaise: 1_180_000 })],
    });

    const { breakdown } = calculate(ctx, request());

    // ₹11,800 inclusive of 18% contains ₹1,800 of tax and the same ₹11,800 total.
    expect(breakdown.lines[0]!.taxPaise).toBe(180_000);
    expect(breakdown.lines[0]!.taxablePaise).toBe(1_000_000);
    expect(breakdown.grandTotalPaise).toBe(1_180_000);
  });

  it('splits CGST and SGST in half intra-state, and their sum equals the IGST equivalent', () => {
    const intra = calculate(context(), request()).breakdown;
    const inter = calculate(context({ buyerStateCode: 'KA' }), request()).breakdown;

    expect(intra.taxSplit.cgstPaise).toBe(90_000);
    expect(intra.taxSplit.sgstPaise).toBe(90_000);
    expect(intra.taxSplit.igstPaise).toBe(0);

    expect(inter.taxSplit.igstPaise).toBe(180_000);
    expect(intra.taxSplit.cgstPaise + intra.taxSplit.sgstPaise).toBe(inter.taxSplit.igstPaise);
    expect(intra.grandTotalPaise).toBe(inter.grandTotalPaise);
  });

  it('falls back to the default place of supply and flags it', () => {
    const { breakdown } = calculate(context({ buyerStateCode: null }), request());

    expect(breakdown.placeOfSupply.isFallback).toBe(true);
    expect(breakdown.placeOfSupply.buyerStateCode).toBe('MH');
    expect(breakdown.placeOfSupply.isIntraState).toBe(true);
  });

  it('charges nothing for a zero-rated class and carries the HSN through', () => {
    const ctx = context({
      lines: [line({ taxClass: { id: 'tax-0', code: 'GST_0', rateBp: 0, hsnCode: '9403' } })],
    });

    const { breakdown } = calculate(ctx, request());
    expect(breakdown.taxPaise).toBe(0);
    expect(breakdown.lines[0]!.hsnCode).toBe('9403');
  });
});

describe('shipping', () => {
  const rate = {
    id: 'rate-1',
    zoneId: 'zone-1',
    zoneCode: 'METRO',
    method: 'STANDARD' as const,
    name: 'Standard delivery',
    conditionType: 'PRICE',
    minValue: null,
    maxValue: null,
    basePaise: 49_900,
    perUnitPaise: null,
    freeAbovePaise: 5_000_000,
    etaMinDays: 2,
    etaMaxDays: 5,
    priority: 10,
  };

  it('charges the matching rate and zeroes it above the free threshold', () => {
    const charged = calculate(context({ shippingRates: [rate] }), request()).breakdown;
    expect(charged.shippingPaise).toBe(49_900);

    const free = calculate(
      context({ shippingRates: [rate], lines: [line({ baseUnitPaise: 6_000_000 })] }),
      request(),
    ).breakdown;
    expect(free.shippingPaise).toBe(0);
  });

  it('picks the band whose condition matches the cart weight', () => {
    const light = {
      ...rate,
      id: 'light',
      conditionType: 'WEIGHT',
      minValue: 0,
      maxValue: 20_000,
      basePaise: 49_900,
      priority: 10,
    };
    const heavy = {
      ...rate,
      id: 'heavy',
      conditionType: 'WEIGHT',
      minValue: 20_001,
      maxValue: null,
      basePaise: 99_900,
      priority: 20,
    };

    const heavyCart = context({
      shippingRates: [light, heavy],
      lines: [line({ weightGrams: 68_000 })],
    });

    expect(calculate(heavyCart, request()).breakdown.shippingPaise).toBe(99_900);
  });

  it('a FREE_SHIPPING coupon zeroes the charge', () => {
    const ctx = context({
      shippingRates: [rate],
      coupon: {
        id: 'c1',
        code: 'FREESHIP',
        name: 'Free delivery',
        type: 'FREE_SHIPPING',
        valueBp: null,
        valuePaise: null,
        minSubtotalPaise: null,
        maxDiscountPaise: null,
        isStackable: true,
        isAutoApply: false,
        firstOrderOnly: false,
        appliesTo: null,
        termsText: null,
      },
    });

    const { breakdown } = calculate(ctx, request());
    expect(breakdown.shippingPaise).toBe(0);
    expect(breakdown.appliedCouponCode).toBe('FREESHIP');
  });
});

describe('coupons and allocation', () => {
  const percentCoupon = {
    id: 'c-welcome',
    code: 'WELCOME10',
    name: 'Welcome',
    type: 'PERCENT' as const,
    valueBp: 1000,
    valuePaise: null,
    minSubtotalPaise: null,
    maxDiscountPaise: 200_000,
    isStackable: false,
    isAutoApply: false,
    firstOrderOnly: true,
    appliesTo: null,
    termsText: null,
  };

  it('caps the discount at maxDiscountPaise', () => {
    const ctx = context({ coupon: percentCoupon, lines: [line({ baseUnitPaise: 5_000_000 })] });

    // 10% of ₹50,000 would be ₹5,000; the cap holds it to ₹2,000.
    const { breakdown } = calculate(ctx, request());
    expect(breakdown.discountPaise).toBe(200_000);
  });

  it('allocates a cart discount across unequal lines with zero loss', () => {
    const lines = [
      line({ lineId: 'L1', productId: 'p1', variantId: 'v1', baseUnitPaise: 333_333 }),
      line({ lineId: 'L2', productId: 'p2', variantId: 'v2', baseUnitPaise: 777_777 }),
      line({ lineId: 'L3', productId: 'p3', variantId: 'v3', baseUnitPaise: 111_111 }),
    ];

    const ctx = context({
      lines,
      coupon: { ...percentCoupon, type: 'FIXED', valuePaise: 100_000, maxDiscountPaise: null },
    });

    const { breakdown } = calculate(ctx, {
      lines: lines.map((row) => ({
        lineId: row.lineId,
        productId: row.productId,
        variantId: row.variantId,
        qty: 1,
      })),
      channel: 'WEB',
      now: NOW,
    });

    const allocated = breakdown.lines.reduce((total, row) => total + row.discountPaise, 0);
    expect(allocated).toBe(100_000);
    expect(breakdown.discountPaise).toBe(100_000);
  });

  it('allocateProportionally is deterministic and lossless', () => {
    const allocations = allocateProportionally(100_000, [333_333, 777_777, 111_111]);

    expect(allocations.reduce((sum, value) => sum + value, 0)).toBe(100_000);
    expect(allocateProportionally(100_000, [333_333, 777_777, 111_111])).toStrictEqual(allocations);
  });
});

describe('rounding and floors', () => {
  it('rounds the grand total to whole rupees when enabled', () => {
    const ctx = context({
      settings: { ...SETTINGS, roundTotalToRupee: true },
      lines: [line({ baseUnitPaise: 99_999 })],
    });

    const { breakdown } = calculate(ctx, request());

    expect(breakdown.grandTotalPaise % 100).toBe(0);
    expect(Math.abs(breakdown.roundingPaise)).toBeLessThan(100);
  });

  it('leaves the total alone when rounding is off', () => {
    const ctx = context({ lines: [line({ baseUnitPaise: 99_999 })] });
    expect(calculate(ctx, request()).breakdown.roundingPaise).toBe(0);
  });

  it('floors the unit price at zero instead of going negative', () => {
    const ctx = context({
      lines: [
        line({
          adjustments: [
            adjustment({ id: 'huge', adjustmentType: 'FIXED_AMOUNT', valuePaise: -5_000_000 }),
          ],
        }),
      ],
    });

    const { breakdown } = calculate(ctx, request());
    expect(breakdown.lines[0]!.unitPricePaise).toBe(0);
    expect(breakdown.grandTotalPaise).toBe(0);
  });
});

describe('the invariant', () => {
  it('holds across 500 randomised carts', () => {
    let seed = 12_345;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };

    for (let iteration = 0; iteration < 500; iteration += 1) {
      const qty = 1 + Math.floor(random() * 25);
      const inclusive = random() > 0.5;
      const intraState = random() > 0.5;

      const adjustments: PricingAdjustment[] = [];
      const count = Math.floor(random() * 4);

      for (let index = 0; index < count; index += 1) {
        const types = ['FIXED_AMOUNT', 'PERCENT', 'PER_UNIT', 'MULTIPLIER'];
        const type = types[Math.floor(random() * types.length)]!;

        adjustments.push(
          adjustment({
            id: `rand-${iteration}-${index}`,
            priority: Math.floor(random() * 100),
            adjustmentType: type,
            basis: random() > 0.5 ? 'BASE' : 'RUNNING_SUBTOTAL',
            valuePaise: Math.floor((random() - 0.4) * 200_000),
            valueBp:
              type === 'MULTIPLIER'
                ? 5_000 + Math.floor(random() * 10_000)
                : Math.floor((random() - 0.4) * 3_000),
          }),
        );
      }

      const ctx = context({
        settings: { ...SETTINGS, pricesIncludeTax: inclusive, roundTotalToRupee: random() > 0.5 },
        buyerStateCode: intraState ? 'MH' : 'KA',
        lines: [line({ baseUnitPaise: 50_000 + Math.floor(random() * 5_000_000), adjustments })],
        coupon:
          random() > 0.6
            ? {
                id: 'c',
                code: 'RANDOM',
                name: 'Random',
                type: 'PERCENT',
                valueBp: Math.floor(random() * 3_000),
                valuePaise: null,
                minSubtotalPaise: null,
                maxDiscountPaise: null,
                isStackable: true,
                isAutoApply: false,
                firstOrderOnly: false,
                appliesTo: null,
                termsText: null,
              }
            : null,
      });

      const { breakdown } = calculate(ctx, request(qty));

      const lineTotals = breakdown.lines.reduce((total, row) => total + row.totalPaise, 0);
      const cartTotal = breakdown.components.reduce((total, row) => total + row.amountPaise, 0);

      expect(lineTotals + cartTotal).toBe(breakdown.grandTotalPaise);

      for (const row of breakdown.lines) {
        const componentSum = row.components.reduce((total, part) => total + part.amountPaise, 0);
        expect(componentSum).toBe(row.totalPaise);
      }
    }
  });

  it('throws PRICING_INVARIANT_VIOLATION when a breakdown is tampered with', () => {
    const { breakdown } = calculate(context(), request());
    const tampered = { ...breakdown, grandTotalPaise: breakdown.grandTotalPaise + 1 };

    expect(() => pricingEngine.assertInvariant(tampered)).toThrow(PricingInvariantError);
  });
});

describe('the condition evaluator', () => {
  const facts = {
    qty: 3,
    unitPricePaise: 1_000_000,
    lineSubtotalPaise: 3_000_000,
    cartSubtotalPaise: 3_000_000,
    cartItemCount: 3,
    productId: 'prod-1',
    variantId: 'var-1',
    categoryId: ['cat-sofas'],
    collectionId: [],
    brandId: 'brand-1',
    attributeValueId: ['val-leather'],
    customerGroupCode: 'TRADE',
    channel: 'WEB',
    pincode: '400001',
    isFirstOrder: true,
    weekday: 1,
  };

  it('evaluates whitelisted operators', () => {
    expect(
      evaluateConditionGroup(
        { match: 'ALL', conditions: [{ field: 'qty', operator: 'GREATER_OR_EQUAL', value: 3 }] },
        facts,
      ).matched,
    ).toBe(true);

    expect(
      evaluateConditionGroup(
        {
          match: 'ALL',
          conditions: [{ field: 'categoryId', operator: 'IN', value: ['cat-beds'] }],
        },
        facts,
      ).matched,
    ).toBe(false);
  });

  it('refuses an unknown field or operator instead of evaluating it', () => {
    const unknownField = evaluateConditionGroup(
      { match: 'ALL', conditions: [{ field: 'process.env', operator: 'EQUALS', value: 'x' }] },
      facts,
    );
    const unknownOperator = evaluateConditionGroup(
      { match: 'ALL', conditions: [{ field: 'qty', operator: 'EVAL', value: '1;process.exit()' }] },
      facts,
    );

    expect(unknownField.matched).toBe(false);
    expect(unknownField.reason).toContain('unknown field');
    expect(unknownOperator.matched).toBe(false);
    expect(unknownOperator.reason).toContain('unknown operator');
  });
});

describe('the ₹6,000 split sanity check', () => {
  it('produces exactly 600000 paise and splits it without a remainder', () => {
    // Prompt 9's Razorpay Route transfers depend on this being exact.
    const ctx = context({
      settings: { ...SETTINGS, pricesIncludeTax: true },
      lines: [
        line({
          baseUnitPaise: 600_000,
          taxClass: { id: 't', code: 'GST_18', rateBp: 1800, hsnCode: null },
        }),
      ],
    });

    const { breakdown } = calculate(ctx, request());
    expect(breakdown.grandTotalPaise).toBe(600_000);

    const split = splitPaise(600_000, [
      { mode: 'FIXED', value: 500_000, account: 'primary' },
      { mode: 'REMAINDER', account: 'secondary' },
    ]);

    expect(split.map((row) => row.amountPaise)).toStrictEqual([500_000, 100_000]);
    expect(split.reduce((total, row) => total + row.amountPaise, 0)).toBe(600_000);
  });
});
