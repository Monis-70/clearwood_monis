import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { prisma } from '../src/config/prisma';
import { pricingFacade } from '../src/modules/pricing/pricing.facade';
import { SEED_EPOCH, epochPlus } from '../prisma/seed/epoch';

const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * Prompt B2 Task 1 — seeded data must not move with the wall clock.
 *
 * A database that is a function of WHEN it was created cannot support a reproducible bug report, a
 * stable demo, or a recorded fixture. The guard script keeps it that way; these tests prove the
 * property actually holds rather than trusting the script.
 */

describe('the seed is time-anchored', () => {
  /** The guard must pass on the real tree, and must actually be looking at something. */
  it('passes the repository, having scanned every seed file', () => {
    const output = execFileSync('node', [path.join(repoRoot, 'scripts', 'check-seed-dates.mjs')], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(output).toContain('time-anchored');

    // G1: "OK" over zero files would be a guard that checks nothing.
    const scanned = Number(/OK - (\d+) seed files/.exec(output)?.[1] ?? 0);
    expect(scanned).toBeGreaterThan(40);
  });

  /** Proves the guard can fail, rather than passing because it matches nothing. */
  it('catches a wall-clock read, and leaves a Date built from a literal alone', () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'seed-guard-'));
    const offender = path.join(scratch, 'offender.mjs');

    try {
      writeFileSync(
        offender,
        [
          "import { readFileSync } from 'node:fs';",
          "const { findWallClockDates } = await import('file://' + process.argv[2]);",
          'const found = findWallClockDates([process.argv[3]]);',
          'console.log(JSON.stringify(found));',
          'void readFileSync;',
        ].join('\n'),
      );

      const sample = path.join(scratch, 'sample.ts');
      writeFileSync(
        sample,
        [
          'const fromLiteral = new Date("2026-01-01T00:00:00.000Z");',
          'const bad = new Date();',
          'const alsoBad = Date.now();',
          'export { fromLiteral, bad, alsoBad };',
        ].join('\n'),
      );

      const raw = execFileSync(
        'node',
        [offender, path.join(repoRoot, 'scripts', 'check-seed-dates.mjs').replace(/\\/g, '/'), sample],
        { cwd: repoRoot, encoding: 'utf8' },
      );

      const offences = JSON.parse(raw.trim()) as string[];

      expect(offences).toHaveLength(2);
      expect(offences.join('\n')).toContain('bare new Date()');
      expect(offences.join('\n')).toContain('Date.now()');
      // A Date built from a literal is legitimate and must not be flagged.
      expect(offences.some((entry) => entry.includes(':1'))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('anchors every seeded date to SEED_EPOCH, not to today', async () => {
    const [page, testimonial, admin] = await Promise.all([
      prisma.page.findFirst({ where: { slug: 'about-us' }, select: { publishedAt: true } }),
      prisma.testimonial.findFirst({ select: { capturedAt: true } }),
      prisma.adminUser.findFirst({
        where: { email: { contains: 'admin' } },
        select: { passwordChangedAt: true },
      }),
    ]);

    // G1: a null date would satisfy "not today" without proving anything.
    expect(page?.publishedAt).toBeTruthy();
    expect(testimonial?.capturedAt).toBeTruthy();

    expect(page!.publishedAt!.toISOString()).toBe(SEED_EPOCH.toISOString());
    expect(testimonial!.capturedAt!.toISOString()).toBe(SEED_EPOCH.toISOString());

    if (admin?.passwordChangedAt) {
      expect(admin.passwordChangedAt.toISOString()).toBe(SEED_EPOCH.toISOString());
    }
  });

  it('keeps the seeded homepage countdown live far beyond the anchor', async () => {
    const block = await prisma.pageBlock.findFirst({
      where: { type: 'COUNTDOWN_DEAL' },
      select: { configJson: true },
    });

    expect(block).toBeTruthy();

    const config = JSON.parse(block!.configJson) as { endsAt: string };
    const endsAt = new Date(config.endsAt);

    // Must outlive any plausible use of this database, not expire a week after seeding.
    expect(endsAt.getTime()).toBeGreaterThan(epochPlus(3_000).getTime());
  });
});

/**
 * The behavioural form: price the same request at instants 400 days apart and require an identical
 * answer. This is what "pricing does not depend on when you ask" actually means.
 */
describe('pricing does not move with the clock', () => {
  it('prices identically 400 days apart', async () => {
    const products = await prisma.product.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      select: { slug: true },
      orderBy: { slug: 'asc' },
      take: 6,
    });

    expect(products.length).toBe(6);

    const items = products.map((row) => ({ slug: row.slug, qty: 2 }));

    const early = await pricingFacade.quoteCart({ items, channel: 'WEB', now: epochPlus(0) });
    const late = await pricingFacade.quoteCart({ items, channel: 'WEB', now: epochPlus(400) });

    // G1: the breakdown must be non-trivial, or "identical" proves nothing.
    expect(early.grandTotalPaise).toBeGreaterThan(0);
    expect(early.lines).toHaveLength(6);
    expect(early.taxPaise).toBeGreaterThan(0);
    expect(early.lines.every((line) => line.components.length > 0)).toBe(true);

    expect(late.grandTotalPaise).toBe(early.grandTotalPaise);
    expect(late.subtotalPaise).toBe(early.subtotalPaise);
    expect(late.discountPaise).toBe(early.discountPaise);
    expect(late.taxPaise).toBe(early.taxPaise);
    expect(late.shippingPaise).toBe(early.shippingPaise);

    for (const [index, line] of late.lines.entries()) {
      expect(line.unitPricePaise).toBe(early.lines[index].unitPricePaise);
      expect(line.totalPaise).toBe(early.lines[index].totalPaise);
    }
  });

  it('applies the same adjustment components at both instants', async () => {
    const product = await prisma.product.findFirstOrThrow({
      where: { status: 'ACTIVE', deletedAt: null },
      select: { slug: true },
      orderBy: { slug: 'asc' },
    });

    const input = { items: [{ slug: product.slug, qty: 3 }], channel: 'WEB' as const };

    const early = await pricingFacade.quoteCart({ ...input, now: epochPlus(0) });
    const late = await pricingFacade.quoteCart({ ...input, now: epochPlus(400) });

    const codesOf = (breakdown: typeof early) =>
      breakdown.lines[0].components.map((component) => component.code).sort();

    // G1: at least one component, or the equality is between two empty arrays.
    expect(codesOf(early).length).toBeGreaterThan(0);
    expect(codesOf(late)).toEqual(codesOf(early));
  });
});
