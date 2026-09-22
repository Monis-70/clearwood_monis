import { env } from '../../config/env';
import { orderSequenceRepository } from '../../repositories/order.repository';

/**
 * Order numbers: `CW/2026-27/000001`.
 *
 * The financial year is the Indian one (April to March), because that is the boundary every
 * accountant, GST return and auditor in the country works to — a calendar-year sequence would have
 * to be reconciled by hand every April.
 *
 * Allocation is a compare-and-set on `OrderSequence.lastNumber`, the same pattern inventory already
 * uses, so two concurrent checkouts can never be handed the same number. There is no lock and no
 * `SELECT ... FOR UPDATE`, which keeps it portable to MySQL unchanged.
 */

const PAD = 6;

/** April 2026 → "2026-27"; March 2026 → "2025-26". */
export function financialYearKey(date: Date): string {
  const year = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export const orderNumberService = {
  financialYearKey,

  async allocate(
    now = new Date(),
  ): Promise<{ orderNumber: string; sequence: number; key: string }> {
    const key = financialYearKey(now);
    const sequence = await orderSequenceRepository.next(key);

    return {
      key,
      sequence,
      orderNumber: `${env.ORDER_NUMBER_PREFIX}/${key}/${String(sequence).padStart(PAD, '0')}`,
    };
  },

  /** Used by the guest-tracking route so a malformed number never reaches the database. */
  looksValid(orderNumber: string): boolean {
    return new RegExp(`^${env.ORDER_NUMBER_PREFIX}/\\d{4}-\\d{2}/\\d{${PAD},}$`).test(orderNumber);
  },
};
