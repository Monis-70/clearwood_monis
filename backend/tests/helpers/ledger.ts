import { expect } from 'vitest';

import type { LedgerCheckDto } from '@shared/types/order';

/**
 * G1 — a ledger assertion that cannot pass vacuously.
 *
 * `expect(failures).toEqual([])` is true when nothing was checked at all, so every call here also
 * asserts that checks actually ran and that the expected ones are among them. An empty set equals
 * an empty set; that is not evidence of anything.
 */
export function expectLedgerOk(
  report: LedgerCheckDto,
  options: { minChecks?: number; mustInclude?: string[] } = {},
): void {
  const failing = report.checks
    .filter((check) => !check.ok)
    .map((check) => `${check.name}: expected ${check.expected}, actual ${check.actual}`);

  expect(failing, `${report.orderNumber} failed ledger checks`).toEqual([]);

  // The part that stops the assertion above being vacuous.
  expect(
    report.checks.length,
    `${report.orderNumber} ran no ledger checks at all`,
  ).toBeGreaterThanOrEqual(options.minChecks ?? 1);

  for (const name of options.mustInclude ?? []) {
    expect(
      report.checks.some((check) => check.name === name || check.name.startsWith(name)),
      `${report.orderNumber} never ran the check "${name}"`,
    ).toBe(true);
  }
}

/** The same, for a batch. Asserts the batch itself is non-empty. */
export function expectAllLedgersOk(reports: LedgerCheckDto[], minReports = 1): void {
  expect(reports.length, 'no orders were verified').toBeGreaterThanOrEqual(minReports);

  for (const report of reports) expectLedgerOk(report);
}
