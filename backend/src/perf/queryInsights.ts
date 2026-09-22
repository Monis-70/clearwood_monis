import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request query accounting for development.
 *
 * The budgets in queryBudgets.ts are enforced by a test, which only ever sees the paths someone
 * remembered to add. This is the other half: while working on any route at all, the count and the
 * database time for the request that just ran are on the response and in the log, so an N+1 that
 * nobody wrote a budget for is visible the moment it appears rather than at review.
 *
 * The slowest statement is tracked as well, because a count and a total cannot distinguish thirty
 * trivial queries from one missing index.
 *
 * HOW ATTRIBUTION WORKS, AND WHY IT IS NOT SIMPLER. Prisma reports statements through an event
 * emitter, and that emitter does not preserve async context — inside a `$on('query')` handler the
 * request's storage is already gone, which is why the obvious implementation counts zero. A client
 * extension DOES keep context, so every operation brackets itself here on the way in and out, and
 * the emitter credits its statements to whichever operation is innermost. One Prisma call can emit
 * several statements, so the number reported is SQL statements — the same unit the budgets in
 * queryBudgets.ts are written in.
 */

export interface QueryStats {
  count: number;
  totalMs: number;
  slowestMs: number;
  slowestQuery: string | null;
}

const storage = new AsyncLocalStorage<QueryStats>();

/** Operations currently awaiting the database, innermost last. */
const inFlight: QueryStats[] = [];

export const queryInsights = {
  run<T>(fn: (stats: QueryStats) => T): T {
    const stats: QueryStats = { count: 0, totalMs: 0, slowestMs: 0, slowestQuery: null };
    return storage.run(stats, () => fn(stats));
  },

  /** Brackets one Prisma operation, from inside the caller's async context. */
  async aroundOperation<T>(operation: () => Promise<T>): Promise<T> {
    const stats = storage.getStore();
    if (!stats) return operation();

    inFlight.push(stats);
    try {
      return await operation();
    } finally {
      const index = inFlight.lastIndexOf(stats);
      if (index !== -1) inFlight.splice(index, 1);
    }
  },

  /** Called from the Prisma query event; a no-op when no counted operation is open. */
  record(query: string, durationMs: number): void {
    const stats = inFlight[inFlight.length - 1];
    if (!stats) return;

    stats.count += 1;
    stats.totalMs += durationMs;

    if (durationMs > stats.slowestMs) {
      stats.slowestMs = durationMs;
      stats.slowestQuery = query;
    }
  },
};
