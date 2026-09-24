import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, vi } from 'vitest';

import { defineConsistencySuite } from './helpers/consistencySuite';

/**
 * The same admin write -> public read suite with CACHE_DRIVER=redis against a REAL Redis, so a
 * stale grid could not hide behind the in-process driver. Runs only when CLEARWOOD_TEST_REDIS_URL
 * is set; localhost only; every key carries a per-run prefix that the suite removes.
 */

const redisUrl = process.env.CLEARWOOD_TEST_REDIS_URL;
const keyPrefix = `cwmc-${randomBytes(4).toString('hex')}:`;

if (redisUrl) {
  // Stubbed, not assigned: a worker process runs other test files afterwards.
  vi.stubEnv('CACHE_DRIVER', 'redis');
  vi.stubEnv('REDIS_URL', redisUrl);
  vi.stubEnv('REDIS_KEY_PREFIX', keyPrefix);
}

beforeAll(() => {
  if (!redisUrl) return;
  const host = new URL(redisUrl).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
    throw new Error(`Refusing to run Redis tests against ${host}: localhost only.`);
  }
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!redisUrl) return;
  // Every key of this run, including the invalidation epoch that delByPrefix deliberately keeps.
  const { createRedisClient, closeRedisClient } =
    await import('../src/drivers/cache/redis.connection');
  const client = createRedisClient(
    { REDIS_URL: redisUrl, REDIS_CONNECT_TIMEOUT_MS: 5_000, REDIS_COMMAND_TIMEOUT_MS: 5_000 },
    'cw-test-consistency-cleanup',
  );
  if (client.status !== 'ready') await new Promise((resolve) => client.once('ready', resolve));
  let cursor = '0';
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', `${keyPrefix}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) await client.unlink(...keys);
  } while (cursor !== '0');
  await closeRedisClient(client);
});

defineConsistencySuite('mutation -> read consistency on a real Redis', {
  enabled: Boolean(redisUrl),
});
