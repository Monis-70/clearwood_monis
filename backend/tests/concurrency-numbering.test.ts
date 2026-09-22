import { describe, expect, it } from 'vitest';

import { prisma } from '../src/config/prisma';
import { documentSequenceRepository } from '../src/repositories/document.repository';
import { orderSequenceRepository } from '../src/repositories/order.repository';

import { expectNoInfrastructureFailures, runConcurrently } from './helpers/concurrency';

/**
 * The guarantees that were green only because nothing ran them concurrently.
 *
 * SQLite took one writer at a time, so a sequential test and a concurrent one produced the same
 * answer and nobody noticed the difference. The register in PROJECT_CONTEXT §34 listed four
 * guarantees with no concurrent test at all; these are those tests.
 *
 * Numbering is the serious one. A GST invoice number that repeats or skips is a statutory defect,
 * not a bug report, and it is exactly the kind of thing that only breaks under load in production.
 */

const CONCURRENCY = 10;

function assertGapless(numbers: number[], label: string): void {
  // G1: one allocation, or ten identical ones, would satisfy "no gaps" trivially.
  expect(numbers.length, `${label}: nothing was allocated`).toBe(CONCURRENCY);
  expect(new Set(numbers).size, `${label}: allocated ${numbers.join(',')}`).toBe(CONCURRENCY);
  expect(Math.min(...numbers), `${label}: numbers must be positive`).toBeGreaterThan(0);

  const sorted = [...numbers].sort((a, b) => a - b);
  for (let index = 1; index < sorted.length; index += 1) {
    expect(
      sorted[index]! - sorted[index - 1]!,
      `${label}: a hole between ${sorted[index - 1]} and ${sorted[index]} — GST numbering may ` +
        'not skip',
    ).toBe(1);
  }
}

describe('gapless numbering under concurrency', () => {
  it('allocates document numbers without a repeat or a hole', async () => {
    const key = `INV-TEST-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

    const result = await runConcurrently(CONCURRENCY, () =>
      documentSequenceRepository.next(key, 'CW/INV'),
    );

    expectNoInfrastructureFailures(result);
    console.log(`[concurrency] document numbering: ${JSON.stringify(result.outcomes)}`);

    expect(result.ok, `rejected: ${result.reasons.join('; ')}`).toBe(CONCURRENCY);
    assertGapless(result.values, 'document numbering');

    const sequence = await prisma.documentSequence.findUniqueOrThrow({ where: { key } });
    expect(sequence.lastNumber).toBe(Math.max(...result.values));
    expect(sequence.prefix, 'the format must not change').toBe('CW/INV');
  }, 120_000);

  it('allocates order numbers without a repeat or a hole', async () => {
    const key = `ORD-TEST-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

    const result = await runConcurrently(CONCURRENCY, () => orderSequenceRepository.next(key));

    expectNoInfrastructureFailures(result);
    console.log(`[concurrency] order numbering: ${JSON.stringify(result.outcomes)}`);

    expect(result.ok, `rejected: ${result.reasons.join('; ')}`).toBe(CONCURRENCY);
    assertGapless(result.values, 'order numbering');

    const sequence = await prisma.orderSequence.findUniqueOrThrow({ where: { key } });
    expect(sequence.lastNumber).toBe(Math.max(...result.values));
  }, 120_000);
});
