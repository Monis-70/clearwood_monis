import type { Redis } from 'ioredis';

import { decode, encode } from './cache.codec';
import type { CacheDriver } from './cache.driver';
import { effectiveTtl } from './cache.driver';
import { throttledWarn } from './throttledLog';

export interface RedisCacheOptions {
  /** Prepended to every key (`REDIS_KEY_PREFIX`), so a sweep never touches another app's keys. */
  keyPrefix: string;
  maxValueBytes: number;
  /** The connection's owner decides how it ends. */
  onClose: () => Promise<void>;
}

const SCAN_COUNT = 500;
const REPLAY_INTERVAL_MS = 1_000;

// Writes only if no invalidation happened since the epoch was read (atomically, in one step).
const SET_IF_EPOCH = `
if (redis.call('GET', KEYS[1]) or '0') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1
`;

/** SCAN MATCH reads * ? [ ] \ as glob syntax; a prefix must only ever match itself. */
function escapeGlob(value: string): string {
  return value.replace(/[*?[\]\\]/g, '\\$&');
}

function commonPrefix(values: string[]): string {
  let prefix = values[0] ?? '';
  for (const value of values) {
    while (!value.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

/**
 * The shared cache for every worker. Invalidation deletes keys in Redis itself, so an edit handled
 * by one worker is visible to all of them without any messaging between processes.
 *
 * Every invalidation also bumps a shared epoch BEFORE deleting, and `wrap` stores a value only if
 * the epoch it read before building is still current. A worker that read the database just before
 * another worker's write can therefore never put that stale value back after the invalidation.
 */
export class RedisCacheDriver implements CacheDriver {
  readonly name = 'redis' as const;

  private readonly inflight = new Map<string, Promise<unknown>>();
  /** Invalidations Redis never confirmed. Reads under them miss until a replay succeeds. */
  private readonly unconfirmed = new Set<string>();
  private batch: { prefixes: Set<string>; done: Promise<void> } | null = null;
  private replaying: Promise<void> | null = null;
  private lastReplayAt = 0;
  private readonly epochKey: string;

  constructor(
    private readonly redis: Redis,
    private readonly options: RedisCacheOptions,
  ) {
    // `!` sorts outside every namespace, so no prefix sweep can match it.
    this.epochKey = `${options.keyPrefix}!epoch`;
    redis.on('ready', () => void this.replay(true));
  }

  async get<T>(key: string): Promise<T | null> {
    if (this.isUnconfirmed(key)) {
      void this.replay();
      return null;
    }

    let text: string | null;
    try {
      text = await this.redis.get(this.options.keyPrefix + key);
    } catch (error) {
      this.warn('get', error);
      return null;
    }
    if (text === null) return null;

    const value = decode<T>(text);
    if (value === undefined) {
      throttledWarn('cache.redis.malformed', { key }, 'unreadable cache entry dropped');
      await this.del(key);
      return null;
    }
    return value;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const ttl = effectiveTtl(ttlSeconds);
    if (ttl === null || this.isUnconfirmed(key)) return;

    const encoded = encode(value, this.options.maxValueBytes);
    if (!encoded.ok) {
      throttledWarn('cache.redis.skip', { key, reason: encoded.reason }, 'value not cached');
      return;
    }

    try {
      await this.redis.set(this.options.keyPrefix + key, encoded.text, 'EX', ttl);
    } catch (error) {
      this.warn('set', error);
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.redis
        .multi()
        .incr(this.epochKey)
        .unlink(this.options.keyPrefix + key)
        .exec();
    } catch (error) {
      this.unconfirmed.add(key);
      this.warn('del', error);
    }
  }

  /** Prefixes requested in the same tick share one SCAN, however many namespaces an edit drops. */
  delByPrefix(prefix: string): Promise<void> {
    if (!this.batch) {
      const prefixes = new Set<string>();
      const done = new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
        this.batch = null;
        return this.sweep([...prefixes]);
      });
      this.batch = { prefixes, done };
    }
    this.batch.prefixes.add(prefix);
    return this.batch.done;
  }

  async wrap<T>(key: string, ttlSeconds: number, producer: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const promise = this.readEpoch().then(async (epoch) => {
      const value = await producer();
      if (epoch !== null) await this.setIfEpoch(key, value, ttlSeconds, epoch);
      return value;
    });

    const tracked = promise.finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, tracked);
    return tracked;
  }

  async ping(): Promise<boolean> {
    if (this.redis.status !== 'ready') return false;
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.inflight.clear();
    await this.options.onClose();
  }

  /** Invalidations still waiting for Redis; exposed for tests and diagnostics. */
  get unconfirmedPrefixes(): string[] {
    return [...this.unconfirmed];
  }

  private isUnconfirmed(key: string): boolean {
    for (const prefix of this.unconfirmed) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  /** `null` when Redis cannot say: the caller then serves the value without caching it. */
  private async readEpoch(): Promise<string | null> {
    try {
      return (await this.redis.get(this.epochKey)) ?? '0';
    } catch (error) {
      this.warn('get', error);
      return null;
    }
  }

  private async setIfEpoch<T>(
    key: string,
    value: T,
    ttlSeconds: number,
    epoch: string,
  ): Promise<void> {
    const ttl = effectiveTtl(ttlSeconds);
    if (ttl === null || this.isUnconfirmed(key)) return;

    const encoded = encode(value, this.options.maxValueBytes);
    if (!encoded.ok) {
      throttledWarn('cache.redis.skip', { key, reason: encoded.reason }, 'value not cached');
      return;
    }

    try {
      await this.redis.eval(
        SET_IF_EPOCH,
        2,
        this.epochKey,
        this.options.keyPrefix + key,
        epoch,
        encoded.text,
        ttl,
      );
    } catch (error) {
      this.warn('set', error);
    }
  }

  private async sweep(prefixes: string[]): Promise<void> {
    try {
      // Epoch first: a value built before this point must not be written after the delete.
      await this.redis.incr(this.epochKey);
      await this.unlinkMatching(prefixes);
      for (const prefix of prefixes) this.unconfirmed.delete(prefix);
    } catch (error) {
      for (const prefix of prefixes) this.unconfirmed.add(prefix);
      this.warn('invalidate', error, { prefixes });
    }
  }

  private async unlinkMatching(prefixes: string[]): Promise<void> {
    const full = prefixes.map((prefix) => this.options.keyPrefix + prefix);
    const pattern = `${escapeGlob(commonPrefix(full))}*`;
    let cursor = '0';

    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
      cursor = next;
      const doomed = keys.filter(
        (key) => key !== this.epochKey && full.some((prefix) => key.startsWith(prefix)),
      );
      if (doomed.length > 0) await this.redis.unlink(...doomed);
    } while (cursor !== '0');
  }

  private replay(force = false): Promise<void> {
    if (this.unconfirmed.size === 0) return Promise.resolve();
    if (this.replaying) return this.replaying;

    const now = Date.now();
    if (!force && now - this.lastReplayAt < REPLAY_INTERVAL_MS) return Promise.resolve();
    this.lastReplayAt = now;

    this.replaying = this.sweep([...this.unconfirmed]).finally(() => {
      this.replaying = null;
    });
    return this.replaying;
  }

  private warn(operation: string, error: unknown, context: Record<string, unknown> = {}): void {
    throttledWarn(
      `cache.redis.${operation}`,
      { ...context, err: error instanceof Error ? error.message : String(error) },
      `cache ${operation} failed - serving from MySQL`,
    );
  }
}
