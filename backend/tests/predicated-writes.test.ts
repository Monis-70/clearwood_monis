import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CONTENTION_CODES } from '../src/utils/conflictCodes';

/**
 * Keeps the contention register honest.
 *
 * The register in `src/utils/conflictCodes.ts` is only worth having if the codes in it are the
 * codes the services actually throw, and if the sweep of predicated writes behind it was real. A
 * list that drifts from the code is worse than no list, because it looks authoritative.
 *
 * The per-site review lives in PROJECT_CONTEXT §37. What is mechanised here is the part a reviewer
 * cannot hold in their head: that every registered code exists, that the classifier reads the
 * register rather than a copy, and that the number of predicated writes has not quietly changed.
 */

const srcDir = path.resolve(__dirname, '..', 'src');

function collect(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...collect(full));
    else if (full.endsWith('.ts')) files.push(full);
  }

  return files;
}

const sources = collect(srcDir).map((file) => ({
  path: path.relative(srcDir, file),
  text: readFileSync(file, 'utf8'),
}));

/** A write whose effect depends on a WHERE clause the caller then inspects. */
const predicatedWrites = sources.flatMap((file) => {
  const hits: string[] = [];

  file.text.split(/\r?\n/).forEach((line, index) => {
    if (/\.updateMany\(|\$executeRaw|updateVersioned\(/.test(line)) {
      hits.push(`${file.path}:${index + 1}`);
    }
  });

  return hits;
});

describe('the contention register', () => {
  it('is non-empty and every code in it is thrown somewhere', () => {
    // G1: an empty register would make the assertions below prove nothing.
    expect(CONTENTION_CODES.length).toBeGreaterThan(3);

    const missing = CONTENTION_CODES.filter(
      (code) => !sources.some((file) => file.text.includes(`'${code}'`)),
    );

    expect(
      missing,
      'These codes are registered as meaning contention but nothing throws them. Either the ' +
        'service that used them is gone, or the register is stale.',
    ).toEqual([]);
  });

  it('is the only copy — the classifier must not keep its own list', () => {
    const helper = readFileSync(path.resolve(__dirname, 'helpers', 'concurrency.ts'), 'utf8');

    expect(helper).toContain('conflictCodes');
    expect(
      /const CONTENTION_APP_CODES = new Set\(\[[\s\S]*?'[A-Z_]+'/.test(helper),
      'the classifier has grown a second copy of the register',
    ).toBe(false);
  });

  it('swept a realistic number of predicated writes', () => {
    // G1: the review in PROJECT_CONTEXT §37 is meaningless if there was nothing to review.
    expect(predicatedWrites.length).toBeGreaterThan(20);
    expect(
      predicatedWrites.some((site) => site.includes('refundReservation')),
      'the site that started all this is no longer a predicated write',
    ).toBe(true);
  });

  it('leaves no read-then-CAS that reports contention as a business refusal', () => {
    /*
     * The shape that caused the defect: a WHERE clause pinning a MUTABLE column to a value the
     * caller read a moment earlier. `refundedPaise: order.refundedPaise` cannot be told apart from
     * a refusal when it matches nothing. `id: existing.id` is not that - an identity is not a
     * snapshot - so primary keys are excluded.
     */
    const IDENTITY = /^(id|key|variantId|orderId|transferId|couponId)$/;

    /*
     * The two sequence allocators pin deliberately and RETRY on a miss rather than throwing a
     * business code, so a lost race is never reported as a refusal. They are measured concurrently
     * by tests/concurrency-numbering.test.ts.
     */
    const EXEMPT = new Set(['repositories\\document.repository.ts', 'repositories\\order.repository.ts']);

    const offenders: string[] = [];

    for (const file of sources) {
      if (EXEMPT.has(file.path) || EXEMPT.has(file.path.replace(/\\/g, '/'))) continue;

      const flat = file.text.replace(/\r?\n/g, ' ');
      // Only a WRITE whose row count the caller inspects; a `count()` filter is not a predicate.
      const pattern =
        /updateMany\(\s*\{\s*where:\s*\{[^}]*?\b(\w+):\s*(?:current|existing|order|transfer|coupon|variant|refund)\.\1\b/g;

      for (const match of flat.matchAll(pattern)) {
        if (IDENTITY.test(match[1]!)) continue;
        offenders.push(`${file.path}: ${match[0].slice(0, 90)}`);
      }
    }

    expect(
      offenders,
      'A predicate pinned to a value the caller already read cannot tell a lost race from a ' +
        "refusal. Compare against the row's own columns instead — see PROJECT_CONTEXT §37.",
    ).toEqual([]);
  });
});
