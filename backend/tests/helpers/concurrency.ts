import { isContentionCode } from '../../src/utils/conflictCodes';
import { AppError } from '../../src/utils/AppError';

/**
 * Runs N operations at once and says WHY each one did not succeed.
 *
 * Under SQLite these tests proved something simple, because SQLite takes one writer and the
 * operations could not genuinely interleave. On MySQL they can, and three very different things
 * now look identical to `Promise.allSettled`:
 *
 *   REFUSED    the guarantee working - the limit was reached, the capacity was exhausted. This is
 *              the only bucket that may be counted as "the rule held".
 *   CONTENDED  a compare-and-set or optimistic-lock miss the application surfaced instead of
 *              retrying. The operation reached the guarantee and lost a race with a sibling. A
 *              real defect: the caller did nothing wrong.
 *   INFRA      a pool timeout, a connect failure, a deadlock. The operation never reached the
 *              guarantee at all, so it is not a result of anything.
 *
 * Counting all three as "rejected" and attributing the difference to the guarantee is how a
 * twelve-way coupon test against a pool of five reports exactly five successes and looks like a
 * correctness finding. Classification is by error CODE, never by message text, because a message
 * is not an interface.
 */

export type Outcome = 'OK' | 'REFUSED' | 'CONTENDED' | 'INFRA';

export interface ConcurrentResult<T> {
  outcomes: Outcome[];
  values: T[];
  ok: number;
  refused: number;
  contended: number;
  infra: number;
  /** Every distinct error identity seen, for the report. */
  reasons: string[];
}

/** Codes the driver raises when the statement never became a result. */
const INFRA_DRIVER_CODES = new Set([
  'ER_CON_COUNT_ERROR',
  'ER_TOO_MANY_USER_CONNECTIONS',
  'ER_USER_LIMIT_REACHED',
  'PROTOCOL_CONNECTION_LOST',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
]);

/** Prisma's own codes for "the database was not reachable or the pool gave up". */
const INFRA_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']);

/** MySQL numbers that mean a lock could not be taken, not that a rule refused. */
const INFRA_ERRNO = new Set([
  1040, // ER_CON_COUNT_ERROR
  1203, // ER_TOO_MANY_USER_CONNECTIONS
  1205, // ER_LOCK_WAIT_TIMEOUT
  1213, // ER_LOCK_DEADLOCK
]);

/** Application codes that mean "you lost a race", as distinct from "the answer is no". */
/** Read from src/utils/conflictCodes.ts so the test and the services cannot drift apart. */
const CONTENTION_APP_CODES = { has: isContentionCode };

function identify(error: unknown): { outcome: Outcome; reason: string } {
  const candidate = error as {
    code?: string;
    errno?: number;
    statusCode?: number;
    name?: string;
    message?: string;
  };

  const code = typeof candidate?.code === 'string' ? candidate.code : undefined;
  const errno = typeof candidate?.errno === 'number' ? candidate.errno : undefined;

  if (errno !== undefined && INFRA_ERRNO.has(errno)) {
    return { outcome: 'INFRA', reason: `mysql errno ${errno}` };
  }
  if (code && (INFRA_DRIVER_CODES.has(code) || INFRA_PRISMA_CODES.has(code))) {
    return { outcome: 'INFRA', reason: code };
  }

  if (error instanceof AppError) {
    if (CONTENTION_APP_CODES.has(error.code)) {
      return { outcome: 'CONTENDED', reason: `AppError ${error.code}` };
    }

    // A 4xx from the domain is the guarantee answering; a 5xx is not an answer.
    if (error.statusCode >= 400 && error.statusCode < 500) {
      return { outcome: 'REFUSED', reason: `AppError ${error.code}` };
    }

    return { outcome: 'INFRA', reason: `AppError ${error.code} (${error.statusCode})` };
  }

  // Prisma's unique-constraint violation IS a guarantee: a constraint refused the write.
  if (code === 'P2002') return { outcome: 'REFUSED', reason: 'P2002 unique constraint' };
  if (code === 'P2025') return { outcome: 'REFUSED', reason: 'P2025 predicate matched nothing' };

  return {
    outcome: 'INFRA',
    reason: `UNCLASSIFIED ${candidate?.name ?? 'Error'}${code ? ` code=${code}` : ''}: ${String(candidate?.message).slice(0, 120)}`,
  };
}

export async function runConcurrently<T>(
  count: number,
  operation: (index: number) => Promise<T>,
): Promise<ConcurrentResult<T>> {
  const settled = await Promise.allSettled(
    Array.from({ length: count }, (_unused, index) => operation(index)),
  );

  const outcomes: Outcome[] = [];
  const values: T[] = [];
  const reasons = new Set<string>();

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      outcomes.push('OK');
      values.push(result.value);
      continue;
    }

    const { outcome, reason } = identify(result.reason);
    outcomes.push(outcome);
    reasons.add(reason);
  }

  const tally = (outcome: Outcome): number => outcomes.filter((item) => item === outcome).length;

  return {
    outcomes,
    values,
    ok: tally('OK'),
    refused: tally('REFUSED'),
    contended: tally('CONTENDED'),
    infra: tally('INFRA'),
    reasons: [...reasons].sort(),
  };
}

/**
 * The assertion every concurrency test should make before it judges its guarantee.
 *
 * An unclassified rejection, a pool timeout or a deadlock means the harness did not measure the
 * thing it claims to measure, so it fails loudly here rather than being folded into a count.
 */
export function expectNoInfrastructureFailures(result: ConcurrentResult<unknown>): void {
  if (result.infra === 0) return;

  throw new Error(
    `${result.infra} of ${result.outcomes.length} operations never reached the guarantee: ` +
      `${result.reasons.join('; ')}. Raise the pool for this test or lower the concurrency - ` +
      'an infrastructure failure must never be counted as a business refusal.',
  );
}
