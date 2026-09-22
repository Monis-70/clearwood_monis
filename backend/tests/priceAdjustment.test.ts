import { describe, expect, it } from 'vitest';

import { priceAdjustmentInputSchema } from '@shared/schemas/catalog';

/**
 * The CHECK constraint SQLite cannot express. Prompt 2 validates the shape only — resolution and
 * maths belong to the Prompt 6 PricingEngine.
 */

const base = {
  name: 'Leather upgrade',
  priority: 10,
};

describe('priceAdjustmentInputSchema', () => {
  it('accepts a FIXED_AMOUNT rule scoped to an attribute value', () => {
    const result = priceAdjustmentInputSchema.safeParse({
      ...base,
      scope: 'ATTRIBUTE_VALUE',
      adjustmentType: 'FIXED_AMOUNT',
      valuePaise: 450000,
      attributeValueId: 'clx0000000000000000000000',
      attributeId: 'clx1111111111111111111111',
    });

    expect(result.success).toBe(true);
  });

  it('rejects PERCENT without valueBp', () => {
    const result = priceAdjustmentInputSchema.safeParse({
      ...base,
      scope: 'CATEGORY',
      adjustmentType: 'PERCENT',
      categoryId: 'clx0000000000000000000000',
    });

    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.path).toStrictEqual(['valueBp']);
  });

  it('rejects MULTIPLIER without valueBp and FIXED_AMOUNT without valuePaise', () => {
    expect(
      priceAdjustmentInputSchema.safeParse({
        ...base,
        scope: 'GLOBAL',
        adjustmentType: 'MULTIPLIER',
      }).success,
    ).toBe(false);

    expect(
      priceAdjustmentInputSchema.safeParse({
        ...base,
        scope: 'GLOBAL',
        adjustmentType: 'PER_UNIT',
      }).success,
    ).toBe(false);
  });

  it('rejects a PRODUCT-scoped rule that also sets a categoryId', () => {
    const result = priceAdjustmentInputSchema.safeParse({
      ...base,
      scope: 'PRODUCT',
      adjustmentType: 'FIXED_AMOUNT',
      valuePaise: -200000,
      productId: 'clx0000000000000000000000',
      categoryId: 'clx1111111111111111111111',
    });

    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues.map((issue) => issue.path[0])).toContain(
      'categoryId',
    );
  });

  it('requires the scope to bring its own FK', () => {
    const result = priceAdjustmentInputSchema.safeParse({
      ...base,
      scope: 'VARIANT',
      adjustmentType: 'PERCENT',
      valueBp: -500,
    });

    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.path).toStrictEqual(['variantId']);
  });

  it('accepts GLOBAL with no FK at all', () => {
    const result = priceAdjustmentInputSchema.safeParse({
      ...base,
      scope: 'GLOBAL',
      adjustmentType: 'PERCENT',
      valueBp: 250,
    });

    expect(result.success).toBe(true);
  });

  it('rejects a window that ends before it starts', () => {
    const result = priceAdjustmentInputSchema.safeParse({
      ...base,
      scope: 'GLOBAL',
      adjustmentType: 'PERCENT',
      valueBp: -1000,
      startsAt: '2026-11-01T00:00:00.000Z',
      endsAt: '2026-10-01T00:00:00.000Z',
    });

    expect(result.success).toBe(false);
  });
});
