import { PrismaClient } from '@prisma/client';

import { queryInsights } from '../perf/queryInsights';

import { isDevelopment, isProduction } from './env';
import { logger } from './logger';

/**
 * R1 — the only place a PrismaClient is constructed. Repositories import this singleton.
 * A global cache keeps `tsx watch` from opening a new connection pool on every reload.
 */

const globalForPrisma = globalThis as unknown as {
  __clearwoodPrisma?: PrismaClient;
  __clearwoodPrismaBase?: PrismaClient;
};

function createPrismaClient(): { client: PrismaClient; base: PrismaClient } {
  const base = new PrismaClient({
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });

  // Free unless a request opened a counting scope, so the flag is checked by the middleware only.
  if (!isProduction) {
    base.$on('query', (event) => queryInsights.record(event.query, event.duration));
  }

  if (isDevelopment) {
    base.$on('query', (event) => {
      logger.debug({ query: event.query, params: event.params, durationMs: event.duration }, 'sql');
    });
  }
  base.$on('warn', (event) => logger.warn({ prisma: event.message }, 'prisma warning'));
  base.$on('error', (event) => logger.error({ prisma: event.message }, 'prisma error'));

  /*
   * The extension exists only so a statement can be attributed to the request that caused it: it
   * is the one Prisma hook that keeps async context, which `$on` does not. It adds no query of its
   * own and does nothing at all outside a counted request. The cast keeps every call site's types
   * exactly as they were — what an extended client loses is `$on`, which is why the base is
   * exported separately below.
   */
  const client = base.$extends({
    query: {
      $allOperations: ({ args, query }) => queryInsights.aroundOperation(() => query(args)),
    },
  }) as unknown as PrismaClient;

  return { client, base };
}

const created =
  globalForPrisma.__clearwoodPrisma && globalForPrisma.__clearwoodPrismaBase
    ? { client: globalForPrisma.__clearwoodPrisma, base: globalForPrisma.__clearwoodPrismaBase }
    : createPrismaClient();

export const prisma: PrismaClient = created.client;

/** The unextended client, for anything that needs `$on` — an extended client has no emitter. */
export const prismaEvents: PrismaClient = created.base;

if (!isProduction) {
  globalForPrisma.__clearwoodPrisma = created.client;
  globalForPrisma.__clearwoodPrismaBase = created.base;
}

/** Cheap liveness probe used by GET /ready. Parameterised, provider-agnostic. */
export async function pingDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
