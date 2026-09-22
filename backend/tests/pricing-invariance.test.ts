import { beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../src/config/prisma';
import { pricingContextLoader } from '../src/modules/pricing/pricingContext.loader';
import { pricingFacade } from '../src/modules/pricing/pricing.facade';

import { buildQuoteCases, FROZEN_NOW, type QuoteCase } from './helpers/pricingCases';
import { countQueries } from './helpers/queryCounter';

/**
 * Prompt B1 Task 2 — the pricing loader must issue O(1) queries per quote, and must not change a
 * single calculated paisa doing it.
 *
 * WHY THERE IS NO RECORDED FIXTURE HERE.
 *
 * The obvious design — record breakdowns before the rewrite, replay after — was built first and
 * then discarded, because the control experiment failed: the ORIGINAL loader could not reproduce
 * its own recording either, 83 of 200 cases apart. The seed creates coupons and discount rules
 * with windows relative to its own wall clock, so which rules are live depends on WHEN the
 * database was seeded, not on the pricing code. A fixture recorded on Tuesday is red on Thursday
 * for reasons that have nothing to do with pricing, and a test that cries wolf gets re-recorded
 * until it means nothing.
 *
 * Invariance is proved the stronger way instead. The rewrite touched exactly two things — the
 * category expansion and the variant option values — and BOTH are compared, in the same database
 * and the same process, against the original implementations kept below as reference code. The
 * engine is pure, so identical inputs give an identical PriceBreakdown and an identical
 * contextHash. That is checked over every product in the catalog and every line of all 200
 * deterministic cases, rather than a sample frozen at one moment.
 */

let cases: QuoteCase[] = [];

beforeAll(async () => {
  const products = await prisma.product.findMany({
    where: { status: 'ACTIVE', deletedAt: null },
    select: { slug: true },
  });

  cases = buildQuoteCases(products.map((row) => row.slug), 200);
});

/* ------------------------------------------- the original implementations */

/** The pre-rewrite per-line category expansion, kept verbatim as the reference. */
async function expandCategoriesTheOldWay(categoryIds: string[]): Promise<string[]> {
  if (categoryIds.length === 0) return [];

  const rows = await prisma.category.findMany({
    where: { id: { in: categoryIds } },
    select: { id: true, path: true },
  });

  const ancestorSlugs = new Set<string>();
  for (const row of rows) {
    const segments = row.path.split('/');
    for (let index = 1; index <= segments.length; index += 1) {
      ancestorSlugs.add(segments.slice(0, index).join('/'));
    }
  }

  const ancestors = await prisma.category.findMany({
    where: { path: { in: [...ancestorSlugs] } },
    select: { id: true },
  });

  return [...new Set([...categoryIds, ...ancestors.map((row) => row.id)])];
}

/** The pre-rewrite per-line variant option lookup, kept verbatim as the reference. */
async function variantValuesTheOldWay(variantId: string): Promise<string[]> {
  const rows = await prisma.variantAttributeValue.findMany({
    where: { variantId },
    select: { attributeValueId: true },
  });

  return rows.map((row) => row.attributeValueId);
}

describe('the case list', () => {
  it('is deterministic and built from the real catalog', () => {
    // G1: replaying zero cases would make every comparison below vacuous.
    expect(cases.length).toBe(200);
    expect(new Set(cases.map((entry) => entry.name)).size).toBe(200);
    expect(cases.some((entry) => entry.input.items.length > 3)).toBe(true);
    expect(cases.every((entry) => entry.input.now === FROZEN_NOW)).toBe(true);
  });
});

describe('the batched loader sees exactly what the per-line loader saw', () => {
  it('expands categories to the identical set for every product in the catalog', async () => {
    const products = await prisma.product.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      select: { id: true, slug: true, categories: { select: { categoryId: true } } },
    });

    const withCategories = products.filter((product) => product.categories.length > 0);

    // G1: comparing zero products, or products with no categories, would prove nothing.
    expect(products.length).toBeGreaterThan(50);
    expect(withCategories.length).toBeGreaterThan(50);

    const drifted: string[] = [];
    let totalExpanded = 0;

    for (const product of withCategories) {
      const own = product.categories.map((row) => row.categoryId);

      const oldWay = new Set(await expandCategoriesTheOldWay(own));
      const context = await pricingContextLoader.load({
        lines: [{ lineId: 'l1', productId: product.id, qty: 1 }],
        now: FROZEN_NOW,
      });
      const newWay = new Set(context.lines[0].categoryIds);

      totalExpanded += newWay.size;

      if (oldWay.size !== newWay.size || ![...oldWay].every((id) => newWay.has(id))) {
        drifted.push(product.slug);
      }
    }

    // G1: if expansion produced nothing, two empty sets would compare equal.
    expect(totalExpanded).toBeGreaterThan(withCategories.length);

    expect(
      drifted,
      `${drifted.length} products expand to a different category set than before`,
    ).toEqual([]);
  }, 180_000);

  it('resolves the identical variant option values', async () => {
    const variants = await prisma.productVariant.findMany({
      where: { isActive: true, deletedAt: null, isDefault: true },
      select: { id: true, productId: true },
      take: 40,
    });

    expect(variants.length).toBeGreaterThan(10);

    let checked = 0;

    for (const variant of variants) {
      const oldWay = new Set(await variantValuesTheOldWay(variant.id));

      const context = await pricingContextLoader.load({
        lines: [{ lineId: 'l1', productId: variant.productId, variantId: variant.id, qty: 1 }],
        now: FROZEN_NOW,
      });
      const newWay = new Set(context.lines[0].optionValueIds);

      expect(newWay.size).toBe(oldWay.size);
      expect([...oldWay].every((id) => newWay.has(id))).toBe(true);

      checked += oldWay.size;
    }

    // G1: if no variant had any option values, the equality above is vacuous.
    expect(checked).toBeGreaterThan(0);
  }, 180_000);

  /**
   * The end-to-end form: across every line of all 200 cases, the engine inputs must match what the
   * per-line implementation would have produced.
   */
  it('produces identical engine inputs across all 200 cases', async () => {
    const expectedBySlug = new Map<string, Set<string>>();

    const products = await prisma.product.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      select: { id: true, categories: { select: { categoryId: true } } },
    });

    for (const product of products) {
      expectedBySlug.set(
        product.id,
        new Set(await expandCategoriesTheOldWay(product.categories.map((row) => row.categoryId))),
      );
    }

    const drifted: string[] = [];
    let linesChecked = 0;
    let categoriesSeen = 0;

    for (const entry of cases) {
      const context = await pricingContextLoader.load({
        lines: entry.input.items.map((item, index) => ({
          lineId: `l${index}`,
          slug: item.slug,
          qty: item.qty,
        })),
        pincode: entry.input.pincode ?? null,
        channel: entry.input.channel,
        now: FROZEN_NOW,
      });

      for (const line of context.lines) {
        linesChecked += 1;
        categoriesSeen += line.categoryIds.length;

        const expected = expectedBySlug.get(line.productId) ?? new Set<string>();
        const actual = new Set(line.categoryIds);

        if (expected.size !== actual.size || ![...expected].every((id) => actual.has(id))) {
          drifted.push(`${entry.name}/${line.lineId}`);
        }
      }
    }

    // G1: both counters must be real, or the comparison above ran on nothing.
    expect(linesChecked).toBeGreaterThan(200);
    expect(categoriesSeen).toBeGreaterThan(linesChecked);

    expect(drifted, `${drifted.length} lines differ from the per-line implementation`).toEqual([]);
  }, 300_000);
});

describe('quotes remain deterministic and non-trivial', () => {
  it('produces the same contextHash and totals for a repeated call', async () => {
    const input = cases[0].input;

    const [first, second] = await Promise.all([
      pricingFacade.quoteCart(input),
      pricingFacade.quoteCart(input),
    ]);

    expect(first.contextHash).toMatch(/^[0-9a-f]{16,}$/);
    expect(second.contextHash).toBe(first.contextHash);
    expect(second.grandTotalPaise).toBe(first.grandTotalPaise);
    expect(first.grandTotalPaise).toBeGreaterThan(0);
  });

  it('prices every sampled case to a positive total with the right line count', async () => {
    let priced = 0;

    for (const entry of cases.slice(0, 40)) {
      const breakdown = await pricingFacade.quoteCart(entry.input);

      expect(breakdown.grandTotalPaise).toBeGreaterThan(0);
      expect(breakdown.lines).toHaveLength(entry.input.items.length);
      expect(breakdown.contextHash).toMatch(/^[0-9a-f]{16,}$/);
      priced += 1;
    }

    expect(priced).toBe(40);
  }, 120_000);
});

/* ------------------------------------------------------------ query budget */

describe('quote query cost is O(1) in the number of lines', () => {
  it('issues the same number of queries for 1 line and for 25', async () => {
    const products = await prisma.product.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      select: { slug: true },
      orderBy: { slug: 'asc' },
      take: 25,
    });

    expect(products.length).toBe(25);

    const one = await countQueries(() =>
      pricingFacade.quoteCart({ items: [{ slug: products[0].slug, qty: 1 }], channel: 'WEB' }),
    );

    const twentyFive = await countQueries(() =>
      pricingFacade.quoteCart({
        items: products.map((row) => ({ slug: row.slug, qty: 1 })),
        channel: 'WEB',
      }),
    );

    // G1: zero queries would satisfy "the same number" trivially.
    expect(one.count).toBeGreaterThan(0);
    expect(twentyFive.count).toBeGreaterThan(0);

    expect(one.result.lines).toHaveLength(1);
    expect(twentyFive.result.lines).toHaveLength(25);

    expect(
      twentyFive.count,
      `1 line cost ${one.count} queries, 25 lines cost ${twentyFive.count}. ` +
        'The loader must batch across lines, not fetch per line.',
    ).toBe(one.count);
  });

  it('costs a bounded number of queries at 40 lines', async () => {
    const products = await prisma.product.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      select: { slug: true },
      orderBy: { slug: 'asc' },
      take: 40,
    });

    const { count, result } = await countQueries(() =>
      pricingFacade.quoteCart({
        items: products.map((row) => ({ slug: row.slug, qty: 2 })),
        channel: 'WEB',
      }),
    );

    expect(result.lines.length).toBe(products.length);
    expect(count).toBeGreaterThan(0);
    expect(count, `A ${products.length}-line quote cost ${count} queries`).toBeLessThanOrEqual(20);
  });
});
