/**
 * The one list of error codes that mean "you lost a race", not "the answer is no".
 *
 * WHY THIS IS A REGISTER AND NOT A CONVENTION. `refundReservation` threw REFUND_EXCEEDS_PAID - a
 * business code - when what had actually happened was a lost compare-and-set. The concurrency
 * classifier filed four contention failures under "refused" and reported zero contention, and that
 * reading sent two separate investigations down the wrong path.
 *
 * The deeper rule, which is the reason this file exists: a read-then-CAS does not merely exhaust
 * its retries, it makes CONTENTION INDISTINGUISHABLE FROM REFUSAL. Once the predicate pins a value
 * the caller read a moment ago, a zero row count answers two different questions at once and no
 * classifier downstream can separate them. A predicate that references the row's OWN columns
 * dissolves the ambiguity: then a zero count genuinely means the rule refused.
 *
 * So: if a write can lose a race, it says so with a code from this list. If it cannot, it must not
 * borrow one. `tests/helpers/concurrency.ts` reads this list rather than keeping a second copy,
 * and `tests/predicated-writes.test.ts` holds the sweep of every site that inspects a row count.
 */

export const CONTENTION_CODES = [
  'CART_CONFLICT',
  'INVENTORY_CONFLICT',
  'STALE_RESOURCE',
  'SLUG_REDIRECT_CONFLICT',
  'COUPON_CONFLICT',
  'REFUND_ALREADY_EXECUTING',
] as const;

export type ContentionCode = (typeof CONTENTION_CODES)[number];

export function isContentionCode(code: string): boolean {
  return (CONTENTION_CODES as readonly string[]).includes(code);
}
