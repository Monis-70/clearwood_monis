import { Redis } from 'ioredis';

import type { Env } from '../../config/env';
import { logger } from '../../config/logger';

import { throttledWarn } from './throttledLog';

export type RedisSettings = Pick<Env, 'REDIS_CONNECT_TIMEOUT_MS' | 'REDIS_COMMAND_TIMEOUT_MS'> & {
  REDIS_URL: string;
};

/** The host, port and database only: a Redis URL carries the password, so it is never logged. */
export function describeRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port || '6379'}${parsed.pathname}`;
  } catch {
    return 'redis (unparseable url)';
  }
}

/**
 * A client that never makes a request wait for Redis: commands fail at once while it is
 * disconnected (no offline queue, no per-command retry) and callers fall back to MySQL. It keeps
 * reconnecting in the background, backing off to one attempt every two seconds.
 */
export function createRedisClient(settings: RedisSettings, connectionName: string): Redis {
  const target = describeRedisUrl(settings.REDIS_URL);
  let downSince: number | null = null;

  const client = new Redis(settings.REDIS_URL, {
    connectionName,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: settings.REDIS_CONNECT_TIMEOUT_MS,
    commandTimeout: settings.REDIS_COMMAND_TIMEOUT_MS,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });

  client.on('error', (error: NodeJS.ErrnoException) => {
    downSince ??= Date.now();
    throttledWarn(
      `redis.error:${connectionName}`,
      { target, reason: error.message, code: error.code },
      'redis unavailable - falling back to MySQL and per-process rate limits',
    );
  });

  client.on('ready', () => {
    logger.info(
      { target, connectionName, unavailableMs: downSince === null ? 0 : Date.now() - downSince },
      'redis ready',
    );
    downSince = null;
  });

  return client;
}

/** Closes politely, and gives up after a second rather than holding a shutdown open. */
export async function closeRedisClient(client: Redis): Promise<void> {
  if (client.status === 'end') return;
  await Promise.race([
    client.quit().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 1_000).unref()),
  ]);
  client.disconnect();
}

let shared: Redis | null = null;

/** One connection per process, shared by the cache and the rate-limit stores. */
export function sharedRedis(settings: RedisSettings): Redis {
  shared ??= createRedisClient(settings, `clearwood-api:${process.pid}`);
  return shared;
}

export async function closeSharedRedis(): Promise<void> {
  if (!shared) return;
  const client = shared;
  shared = null;
  await closeRedisClient(client);
}
