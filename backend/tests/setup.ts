import { readFileSync } from 'node:fs';

import { afterAll, beforeAll } from 'vitest';

import { TEST_DB_PREFIX, connect, parseUrl, urlFor } from './helpers/mysqlTemplate';

/**
 * Gives THIS test file its own database, replayed from the cached template.
 *
 * Order matters and is the whole trick: `DATABASE_URL` is set before anything imports
 * `src/config/prisma`, because the Prisma client reads the URL when the module is first evaluated.
 * That is why every `src/` import in this file is dynamic and why none appears at the top.
 *
 * A database per file buys the same two things the SQLite copy bought: files do not share a
 * writer, so `fileParallelism` stays on; and no test can leak state into the next file, which
 * removes a class of order-dependent flakiness that is miserable to debug.
 *
 * `connection_limit=15` is deliberate. Prisma's default is `cpus * 2 + 1`, which on a 16-core
 * machine is 33 per file; eight files in flight would ask for 264 against `max_connections=200`
 * and the suite would fail on connection exhaustion rather than on a bug. 15 is the other bound:
 * the widest concurrency test fires twelve operations at once, and a pool smaller than that turns
 * a correctness test into a queueing test - twelve callers against a pool of five produced exactly
 * five successes and looked like a broken guarantee.
 *
 * The arithmetic: 8 workers x 15 pooled + 8 admin connections = 128 of 200. Prisma opens lazily,
 * so only a file that actually needs the width pays for it.
 */

const TEST_POOL_SIZE = 15;

const dump = process.env.CLEARWOOD_TEST_DUMP;
const adminUrl = process.env.CLEARWOOD_TEST_ADMIN_URL;
const run = process.env.CLEARWOOD_TEST_RUN;

let ownDatabase: string | null = null;

if (dump && adminUrl && run) {
  const base = parseUrl(adminUrl);

  // The worker id keeps two files running in parallel from choosing the same name; the run id
  // lets global teardown find every database this run created.
  const tag = `${run}_${process.env.VITEST_WORKER_ID ?? '0'}_${Math.random().toString(36).slice(2, 8)}`;
  ownDatabase = `${TEST_DB_PREFIX}r${tag}`;

  process.env.DATABASE_URL = urlFor(base, ownDatabase, TEST_POOL_SIZE);

  beforeAll(async () => {
    const admin = await connect(base);

    try {
      await admin.query(`DROP DATABASE IF EXISTS \`${ownDatabase}\``);
      await admin.query(
        `CREATE DATABASE \`${ownDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
      );
      await admin.changeUser({ database: ownDatabase! });
      await admin.query(readFileSync(dump, 'utf8'));
    } finally {
      await admin.end();
    }
  }, 180_000);
}

afterAll(async () => {
  const { closeDrivers } = await import('../src/container');
  const { disconnectPrisma } = await import('../src/config/prisma');
  const { catalogEvents } = await import('../src/events/catalogEvents');
  const { listingReconciler } = await import('../src/modules/storefront/listingReconciler.service');

  /*
   * Drain background work first, as server.ts shutdown does. With a reindex or rebuild still in
   * flight, DROP DATABASE sat in "Waiting for table metadata lock" past the 60 s hook timeout.
   */
  await catalogEvents.settled();
  await listingReconciler.idle();

  // Without this the connection pool and the cache keep the worker alive after the suite ends.
  await closeDrivers();
  await disconnectPrisma();

  if (!ownDatabase || !adminUrl) return;

  try {
    const admin = await connect(parseUrl(adminUrl));
    await admin.query(`DROP DATABASE IF EXISTS \`${ownDatabase}\``);
    await admin.end();
  } catch {
    // Global teardown sweeps the whole run by prefix; one stuck drop is not a failure.
  }
}, 60_000);
