/**
 * THE seed time anchor.
 *
 * Every date a seed writes is derived from here, never from the wall clock. Seeded data that moves
 * with `Date.now()` makes the database a function of WHEN it was created: a demo cart is idle for
 * a different number of hours every day, a countdown deal expires a week after whoever ran the
 * seed, and a bug report from Tuesday cannot be reproduced on Thursday.
 *
 * `scripts/check-seed-dates.mjs` fails the build if `Date.now()` or a bare `new Date()` appears
 * under `prisma/seed/`, so this cannot quietly come back.
 *
 * NOTE ON PRICING. Prompt B1 believed seeded pricing windows were wall-clock relative and that
 * this was why its recorded fixture drifted. That was investigated properly in B2 and is not the
 * case: coupon and adjustment windows were already fixed ISO strings, and two independently seeded
 * databases produce identical breakdowns for all 200 fixture cases. The drift was a bug in the
 * comparison. The anchoring below is still correct — it fixes demo carts, order expiry, the
 * homepage countdown and published-at stamps — but it is not a pricing fix.
 */

const DEFAULT_EPOCH = '2026-01-01T00:00:00.000Z';

function readEpoch(): Date {
  const raw = process.env.SEED_EPOCH ?? DEFAULT_EPOCH;
  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`SEED_EPOCH is not a valid ISO date: ${raw}`);
  }

  return parsed;
}

export const SEED_EPOCH = readEpoch();

const DAY_MS = 24 * 60 * 60 * 1000;

/** `epochPlus(-3)` is three days before the anchor. */
export function epochPlus(days: number, hours = 0): Date {
  return new Date(SEED_EPOCH.getTime() + days * DAY_MS + hours * 60 * 60 * 1000);
}

export function epochMinus(days: number, hours = 0): Date {
  return epochPlus(-days, -hours);
}

/**
 * A window wide enough that seeded "currently active" rows stay active for the life of the
 * project, rather than for a week after whoever ran the seed.
 */
export const ALWAYS_ACTIVE_FROM = epochPlus(-365);
export const ALWAYS_ACTIVE_UNTIL = epochPlus(3_650);

/** Explicitly in the past, and explicitly in the future, for rows that must be one or the other. */
export const LONG_EXPIRED_FROM = epochPlus(-400);
export const LONG_EXPIRED_UNTIL = epochPlus(-370);
export const NOT_YET_STARTED_FROM = epochPlus(3_000);
export const NOT_YET_STARTED_UNTIL = epochPlus(3_400);
