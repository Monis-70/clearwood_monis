import type { CacheDriver } from './cache.driver';

/**
 * TODO (post-launch, see docs/PROJECT_CONTEXT.md §2):
 * Redis is deliberately NOT implemented yet — this prompt must run offline with Node + npm only,
 * so no `ioredis` dependency and no Redis server are introduced.
 *
 * To enable later:
 *   1. `npm i ioredis --workspace backend`
 *   2. Implement the methods below with a single shared `Redis` client built from `env.REDIS_URL`
 *      (port 6380 is reserved). `delByPrefix` should use SCAN + UNLINK, never `KEYS`.
 *   3. Serialise values with JSON.stringify / JSON.parse and honour `ttlSeconds` via `SET ... EX`.
 *   4. Set `CACHE_DRIVER=redis` and `REDIS_URL=redis://localhost:6380` — no other code changes.
 *
 * `createCache()` already validates that REDIS_URL exists before this driver can be selected.
 */
export function createRedisCacheDriver(): CacheDriver {
  throw new Error(
    'CACHE_DRIVER=redis is not implemented yet. Keep CACHE_DRIVER=memory until the Redis driver ships (see backend/src/drivers/cache/redis.cache.ts).',
  );
}
