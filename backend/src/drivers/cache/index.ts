import type { Env } from '../../config/env';
import { logger } from '../../config/logger';

import type { CacheDriver } from './cache.driver';
import { MemoryCacheDriver } from './memory.cache';
import { RedisCacheDriver } from './redis.cache';
import { closeSharedRedis, sharedRedis } from './redis.connection';

export type { CacheDriver };
export { DEFAULT_TTL_SECONDS } from './cache.driver';
export { MemoryCacheDriver } from './memory.cache';

export function createCache(env: Env): CacheDriver {
  switch (env.CACHE_DRIVER) {
    case 'redis':
      // REDIS_URL is guaranteed by the env schema whenever CACHE_DRIVER=redis.
      return new RedisCacheDriver(sharedRedis({ ...env, REDIS_URL: env.REDIS_URL! }), {
        keyPrefix: env.REDIS_KEY_PREFIX,
        maxValueBytes: env.CACHE_MAX_VALUE_BYTES,
        onClose: closeSharedRedis,
      });
    case 'memory':
    default:
      if (env.NODE_ENV === 'production') {
        logger.warn(
          'CACHE_DRIVER=memory in production: every PM2 worker keeps its own cache and rate-limit ' +
            'counters, so an edit reaches other workers only by TTL. Use CACHE_DRIVER=redis.',
        );
      }
      logger.debug({ driver: 'memory', maxItems: env.CACHE_MAX_ITEMS }, 'cache driver ready');
      return new MemoryCacheDriver(env.CACHE_MAX_ITEMS, env.CACHE_MAX_VALUE_BYTES);
  }
}
