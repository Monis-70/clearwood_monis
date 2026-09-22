import type { Env } from '../../config/env';
import { logger } from '../../config/logger';

import type { CacheDriver } from './cache.driver';
import { MemoryCacheDriver } from './memory.cache';
import { createRedisCacheDriver } from './redis.cache';

export type { CacheDriver };
export { DEFAULT_TTL_SECONDS } from './cache.driver';
export { MemoryCacheDriver } from './memory.cache';

export function createCache(env: Env): CacheDriver {
  switch (env.CACHE_DRIVER) {
    case 'redis':
      return createRedisCacheDriver();
    case 'memory':
    default:
      logger.debug({ driver: 'memory', maxItems: env.CACHE_MAX_ITEMS }, 'cache driver ready');
      return new MemoryCacheDriver(env.CACHE_MAX_ITEMS);
  }
}
