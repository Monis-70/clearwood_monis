import { prismaEvents } from '../../src/config/prisma';

/**
 * Counts the SQL statements one operation issues.
 *
 * Exists for a single rule: hydrating a page must cost a FIXED number of queries regardless of how
 * many blocks it has. A renderer that loops blocks and fetches per block passes every functional
 * test and then costs forty queries on the most-requested URL on the site. Only a number catches
 * that, so the test asserts a number.
 *
 * Prisma has no `$off`, so exactly ONE listener is registered for the process and the collector is
 * swapped underneath it. Registering per call would leak a listener each time and, worse, would
 * make every count include the previous test's queries.
 *
 * The listener goes on `prismaEvents` rather than `prisma`: the exported client is extended, and
 * an extended client has no event emitter.
 */

let sink: string[] | null = null;
let registered = false;

function ensureListener(): void {
  if (registered) return;

  prismaEvents.$on('query' as never, ((event: { query: string }) => {
    if (!sink) return;

    const sql = event.query.trim();
    // Transaction brackets and connection probes are not work the operation caused.
    if (/^(BEGIN|COMMIT|ROLLBACK|PRAGMA|SELECT 1\b)/i.test(sql)) return;

    sink.push(sql);
  }) as never);

  registered = true;
}

export async function countQueries<T>(
  operation: () => Promise<T>,
): Promise<{ result: T; count: number; statements: string[] }> {
  ensureListener();

  const collected: string[] = [];
  sink = collected;

  try {
    const result = await operation();

    // Query events arrive asynchronously; let them land before the count is read.
    await new Promise((resolve) => setImmediate(resolve));

    return { result, count: collected.length, statements: [...collected] };
  } finally {
    sink = null;
  }
}
