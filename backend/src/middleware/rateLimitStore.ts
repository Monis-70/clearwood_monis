import {
  MemoryStore,
  type ClientRateLimitInfo,
  type Options,
  type Store,
} from 'express-rate-limit';
import type { Redis } from 'ioredis';

import { env } from '../config/env';
import { sharedRedis } from '../drivers/cache/redis.connection';
import { throttledWarn } from '../drivers/cache/throttledLog';

// One round trip, atomic: count the hit and make sure the counter can never outlive its window.
const INCREMENT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }
`;

// DECR on a missing key would create a counter with no expiry.
const DECREMENT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('DECR', KEYS[1])
end
return 0
`;

/**
 * Counts hits in Redis so every PM2 worker enforces one shared limit. If Redis fails, the limiter
 * keeps working on a per-process counter instead: limits loosen to "per worker" for the outage,
 * but they neither vanish (fail-open) nor reject every request (fail-closed).
 */
export class RedisRateLimitStore implements Store {
  readonly localKeys = false;
  readonly prefix: string;

  private windowMs = 60_000;
  private readonly fallback = new MemoryStore();

  constructor(
    private readonly redis: Redis,
    prefix: string,
  ) {
    this.prefix = prefix;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
    this.fallback.init(options);
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    try {
      const [totalHits, ttl] = (await this.redis.eval(
        INCREMENT,
        1,
        this.prefix + key,
        this.windowMs,
      )) as [number, number];
      return { totalHits, resetTime: new Date(Date.now() + ttl) };
    } catch (error) {
      this.degraded(error);
      return this.fallback.increment(key);
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      await this.redis.eval(DECREMENT, 1, this.prefix + key);
    } catch (error) {
      this.degraded(error);
      await this.fallback.decrement(key);
    }
  }

  async resetKey(key: string): Promise<void> {
    await this.fallback.resetKey(key);
    try {
      await this.redis.unlink(this.prefix + key);
    } catch (error) {
      this.degraded(error);
    }
  }

  private degraded(error: unknown): void {
    throttledWarn(
      'ratelimit.redis',
      { prefix: this.prefix, err: error instanceof Error ? error.message : String(error) },
      'rate limit counting per process until redis returns',
    );
  }
}

const used = new Map<string, number>();

/**
 * The store for one limiter: shared Redis counters when CACHE_DRIVER=redis, otherwise
 * express-rate-limit's in-process MemoryStore (`undefined`). A bucket used by two routes still
 * counts each route separately, exactly as the in-process store does.
 */
export function rateLimitStore(name: string): Store | undefined {
  if (env.CACHE_DRIVER !== 'redis' || !env.REDIS_URL) return undefined;

  const seen = (used.get(name) ?? 0) + 1;
  used.set(name, seen);
  const scope = seen === 1 ? name : `${name}#${seen}`;

  return new RedisRateLimitStore(
    sharedRedis({ ...env, REDIS_URL: env.REDIS_URL }),
    `${env.REDIS_KEY_PREFIX}rl:${scope}:`,
  );
}
