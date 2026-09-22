import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../src/config/prisma';
import { pricingFacade } from '../src/modules/pricing/pricing.facade';

import { buildQuoteCases, fingerprint, FROZEN_NOW, type QuoteCase } from './helpers/pricingCases';

/**
 * Prompt B2 Task 1 — the recorded pricing fixture, restored.
 *
 * Prompt B1 abandoned this, believing the seed produced time-dependent pricing. That was wrong,
 * and the correction matters: two databases seeded independently were compared and **0 of 200**
 * breakdowns differ. The seed is deterministic in every value pricing reads.
 *
 * The real cause of B1's 83/200 drift was in the comparison, not the data. Price components carry
 * codes like `ADJ_cmubfxfbk07gfr9w8vgp5mhkj`, embedding the adjustment's cuid. The id-normaliser
 * only matched a string that WAS a cuid, so those codes went into the hash raw and every re-seed
 * looked like a pricing regression while every amount was identical.
 *
 * So this file is the regression net B1 wanted: 200 deterministic cases, priced at a frozen
 * instant, compared against a committed fixture. Re-record only for a deliberate pricing change:
 *
 *     RECORD_PRICING_FIXTURE=1 npx vitest run tests/pricing-fixture.test.ts
 */

const FIXTURE = path.join(__dirname, 'fixtures', 'pricing-breakdowns.json');

interface Fixture {
  $comment: string;
  caseCount: number;
  cases: Record<string, string>;
}

let cases: QuoteCase[] = [];

beforeAll(async () => {
  const products = await prisma.product.findMany({
    where: { status: 'ACTIVE', deletedAt: null },
    select: { slug: true },
  });

  cases = buildQuoteCases(products.map((row) => row.slug), 200);
});

describe('the recorded pricing fixture', () => {
  it('replays 200 deterministic cases built from the real catalog', () => {
    // G1: replaying zero cases would make the comparison below vacuous.
    expect(cases.length).toBe(200);
    expect(new Set(cases.map((entry) => entry.name)).size).toBe(200);
    expect(cases.every((entry) => entry.input.now === FROZEN_NOW)).toBe(true);
  });

  it('produces byte-identical breakdowns', async () => {
    const produced: Record<string, string> = {};
    const totals: number[] = [];

    for (const entry of cases) {
      const breakdown = await pricingFacade.quoteCart(entry.input);

      produced[entry.name] = fingerprint(breakdown as unknown as Record<string, unknown>);
      totals.push(breakdown.grandTotalPaise);
    }

    if (process.env.RECORD_PRICING_FIXTURE === '1') {
      writeFileSync(
        FIXTURE,
        `${JSON.stringify(
          {
            $comment:
              'sha256 of each PriceBreakdown with cuids normalised, minus calculatedAt and ' +
              'contextHash (both are id/clock derived - see pricing-fixture.test.ts). Re-record ' +
              'with RECORD_PRICING_FIXTURE=1 ONLY for a deliberate pricing change.',
            caseCount: Object.keys(produced).length,
            cases: produced,
          },
          null,
          2,
        )}\n`,
      );
    }

    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;

    // G1: an empty fixture, or all-zero totals, would make the comparison pass for anything.
    expect(Object.keys(fixture.cases).length).toBe(200);
    expect(totals.every((total) => total > 0)).toBe(true);
    expect(Math.min(...totals)).toBeGreaterThan(0);

    const drifted = Object.entries(produced)
      .filter(([name, hash]) => fixture.cases[name] !== hash)
      .map(([name]) => name);

    expect(
      drifted,
      `${drifted.length} of 200 breakdowns changed against the recorded fixture. If this was a ` +
        'deliberate pricing change, re-record it; otherwise it is a regression.',
    ).toEqual([]);
  }, 180_000);

  it('produces a well-formed, deterministic contextHash', async () => {
    const input = cases[0].input;

    const [first, second] = await Promise.all([
      pricingFacade.quoteCart(input),
      pricingFacade.quoteCart(input),
    ]);

    // The hash digests raw cuids, so it cannot be compared across seeds - only within a run.
    expect(first.contextHash).toMatch(/^[0-9a-f]{16,}$/);
    expect(second.contextHash).toBe(first.contextHash);
    expect(first.grandTotalPaise).toBeGreaterThan(0);
  });
});
